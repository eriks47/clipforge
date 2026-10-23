import type { CutsConfig } from "../schemas/edit"
import type { TimeRange, Word } from "../schemas/media"
import type { EdlSegment } from "../schemas/render"
import { lastIndexAtOrBefore, mergeRanges, normalizeToken } from "./util"

export type CutKind = "gap" | "filler" | "deleted"

export interface Cut {
  /** stable id, used to restore an automatic cut */
  id: string
  kind: CutKind
  /** source time */
  start: number
  end: number
  label: string
  /** false when the user restored it */
  active: boolean
}

/** Words that are only fillers when set off by punctuation ("like,") */
const AMBIGUOUS_FILLERS = new Set(["like", "basically", "so", "well", "right", "actually"])

/** Indices of words overlapping a source range (sorted). */
export function wordIndicesInRange(words: readonly Word[], range: TimeRange): number[] {
  const out: number[] = []
  // words are sorted by start; binary search the first candidate
  let i = Math.max(
    0,
    lastIndexAtOrBefore(words, range.start, (w) => w.start)
  )
  while (i > 0 && words[i - 1].end > range.start) i--
  for (; i < words.length; i++) {
    const w = words[i]
    if (w.start >= range.end) break
    const mid = (w.start + w.end) / 2
    if (mid >= range.start && mid <= range.end) out.push(i)
  }
  return out
}

function hasCommaAround(words: readonly Word[], idx: number, len: number): boolean {
  const last = words[idx + len - 1]?.text ?? ""
  const prev = words[idx - 1]?.text ?? ""
  return /[,…-]\s*$/.test(last) || /[,…-]\s*$/.test(prev)
}

/** Find filler occurrences. Returns [firstIdx, lastIdx] pairs (inclusive) of global word indices. */
export function findFillers(
  words: readonly Word[],
  indices: readonly number[],
  fillers: readonly string[],
  minProb: number
): [number, number][] {
  const phrases = fillers
    .map((f) => normalizeToken(f).split(/\s+/).filter(Boolean))
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length)
  const hits: [number, number][] = []
  const norm = indices.map((i) => normalizeToken(words[i].text))
  for (let k = 0; k < indices.length; k++) {
    for (const phrase of phrases) {
      if (k + phrase.length > indices.length) continue
      let match = true
      for (let j = 0; j < phrase.length; j++) {
        if (norm[k + j] !== phrase[j] || indices[k + j] !== indices[k] + j) {
          match = false
          break
        }
      }
      if (!match) continue
      const first = indices[k]
      const last = indices[k + phrase.length - 1]
      let conf = 1
      for (let i = first; i <= last; i++) conf = Math.min(conf, words[i].prob)
      if (conf < minProb) continue
      if (
        phrase.length === 1 &&
        AMBIGUOUS_FILLERS.has(phrase[0]) &&
        !hasCommaAround(words, first, 1)
      )
        continue
      hits.push([first, last])
      k += phrase.length - 1
      break
    }
  }
  return hits
}

/**
 * Removal span for words [first..last]: the words themselves plus the silence around them,
 * leaving `pad` seconds next to the neighbouring words.
 */
function wordSpanCut(
  words: readonly Word[],
  first: number,
  last: number,
  pad: number,
  range: TimeRange
): TimeRange {
  const a = words[first]
  const b = words[last]
  const prev = words[first - 1]
  const next = words[last + 1]
  let start = a.start
  let end = b.end
  if (prev && prev.end >= range.start)
    start = Math.min(a.start, Math.max(prev.end + pad, a.start - 1))
  if (next && next.start <= range.end) end = Math.max(b.end, Math.min(next.start - pad, b.end + 1))
  return { start: Math.max(start, range.start), end: Math.min(end, range.end) }
}

/** Compute all cuts (automatic + manual) for a clip range. */
export function computeCuts(words: readonly Word[], range: TimeRange, cfg: CutsConfig): Cut[] {
  const cuts: Cut[] = []
  const idx = wordIndicesInRange(words, range)
  const pad = cfg.deadAir.padMs / 1000
  const minGap = cfg.deadAir.minGapMs / 1000
  const restored = new Set(cfg.restoredCuts)
  const deleted = new Set(cfg.deletedWords)

  if (cfg.deadAir.enabled && idx.length > 0) {
    const pushGap = (id: string, start: number, end: number) => {
      if (end - start > 0.02)
        cuts.push({
          id,
          kind: "gap",
          start,
          end,
          label: `${((end - start) * 1000).toFixed(0)} ms pause`,
          active: !restored.has(id),
        })
    }
    const first = words[idx[0]]
    if (first.start - range.start > minGap) pushGap("gap:lead", range.start, first.start - pad)
    for (let k = 0; k < idx.length - 1; k++) {
      const a = words[idx[k]]
      const b = words[idx[k + 1]]
      if (b.start - a.end > minGap) pushGap(`gap:${idx[k]}`, a.end + pad, b.start - pad)
    }
    const last = words[idx[idx.length - 1]]
    if (range.end - last.end > minGap + pad) pushGap("gap:tail", last.end + pad, range.end)
  }

  if (cfg.fillers.enabled && idx.length > 0) {
    for (const [first, last] of findFillers(words, idx, cfg.fillers.words, cfg.fillers.minProb)) {
      if (deleted.has(first)) continue
      const span = wordSpanCut(words, first, last, pad, range)
      const id = `filler:${first}`
      const label = words
        .slice(first, last + 1)
        .map((w) => w.text.trim())
        .join(" ")
      cuts.push({ id, kind: "filler", ...span, label, active: !restored.has(id) })
    }
  }

  for (const i of idx) {
    if (!deleted.has(i)) continue
    const span = wordSpanCut(words, i, i, pad, range)
    cuts.push({
      id: `word:${i}`,
      kind: "deleted",
      ...span,
      label: words[i].text.trim(),
      active: true,
    })
  }

  return cuts.sort((a, b) => a.start - b.start)
}

/** Minimum kept segment duration; shorter slivers between cuts are dropped. */
export const MIN_SEGMENT_SEC = 0.08

/** Build the edit decision list: kept source segments with their output timing. */
export function buildEdl(range: TimeRange, cuts: readonly Cut[], speed: number): EdlSegment[] {
  const removed = mergeRanges(
    cuts
      .filter((c) => c.active)
      .map((c) => ({ start: Math.max(c.start, range.start), end: Math.min(c.end, range.end) }))
  )
  const kept: TimeRange[] = []
  let cursor = range.start
  for (const r of removed) {
    if (r.start > cursor) kept.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (range.end > cursor) kept.push({ start: cursor, end: range.end })

  const s = speed > 0 ? speed : 1
  const segments: EdlSegment[] = []
  let out = 0
  for (const k of kept) {
    const len = k.end - k.start
    if (len < MIN_SEGMENT_SEC) continue
    const outLen = len / s
    segments.push({ srcStart: k.start, srcEnd: k.end, outStart: out, outEnd: out + outLen })
    out += outLen
  }
  if (segments.length === 0 && range.end > range.start) {
    // Everything was cut: fall back to the raw range so the clip is never empty.
    segments.push({
      srcStart: range.start,
      srcEnd: range.end,
      outStart: 0,
      outEnd: (range.end - range.start) / s,
    })
  }
  return segments
}

export function edlDuration(edl: readonly EdlSegment[]): number {
  return edl.length ? edl[edl.length - 1].outEnd : 0
}

export type MapMode = "strict" | "next" | "prev"

/**
 * Map a source time to output time.
 * - strict: null when t falls inside a removed region
 * - next: removed times snap to the start of the following kept segment
 * - prev: removed times snap to the end of the preceding kept segment
 */
export function srcToOut(
  edl: readonly EdlSegment[],
  t: number,
  mode: MapMode = "strict"
): number | null {
  if (edl.length === 0) return null
  const i = lastIndexAtOrBefore(edl, t, (s) => s.srcStart)
  const speed =
    edl[0].srcEnd - edl[0].srcStart > 0
      ? (edl[0].srcEnd - edl[0].srcStart) / (edl[0].outEnd - edl[0].outStart)
      : 1
  if (i >= 0) {
    const seg = edl[i]
    if (t <= seg.srcEnd) return seg.outStart + (t - seg.srcStart) / speed
  }
  if (mode === "strict") return null
  if (mode === "next") {
    const nxt = edl[i + 1]
    return nxt ? nxt.outStart : i >= 0 ? edl[i].outEnd : edl[0].outStart
  }
  return i >= 0 ? edl[i].outEnd : edl[0].outStart
}

/** Map an output time to source time (clamped to the EDL). */
export function outToSrc(edl: readonly EdlSegment[], t: number): number {
  if (edl.length === 0) return t
  const i = Math.max(
    0,
    lastIndexAtOrBefore(edl, t, (s) => s.outStart)
  )
  const seg = edl[i]
  const speed = (seg.srcEnd - seg.srcStart) / Math.max(seg.outEnd - seg.outStart, 1e-9)
  const local = Math.min(Math.max(t - seg.outStart, 0), seg.outEnd - seg.outStart)
  return seg.srcStart + local * speed
}

/** Index of the EDL segment active at output time t. */
export function segmentIndexAt(edl: readonly EdlSegment[], t: number): number {
  return Math.max(
    0,
    lastIndexAtOrBefore(edl, t, (s) => s.outStart)
  )
}

/**
 * Map a source interval onto the output timeline. Returns null if it was cut entirely.
 * Partially cut intervals are clamped to the kept parts.
 */
export function mapInterval(
  edl: readonly EdlSegment[],
  start: number,
  end: number
): { start: number; end: number } | null {
  let outStart: number | null = null
  let outEnd: number | null = null
  for (const seg of edl) {
    if (seg.srcEnd <= start) continue
    if (seg.srcStart >= end) break
    const a = Math.max(start, seg.srcStart)
    const b = Math.min(end, seg.srcEnd)
    if (b <= a) continue
    const sp = (seg.srcEnd - seg.srcStart) / Math.max(seg.outEnd - seg.outStart, 1e-9)
    if (outStart === null) outStart = seg.outStart + (a - seg.srcStart) / sp
    outEnd = seg.outStart + (b - seg.srcStart) / sp
  }
  if (outStart === null || outEnd === null) return null
  return { start: outStart, end: outEnd }
}
