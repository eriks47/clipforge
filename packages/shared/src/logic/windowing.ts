import type { CandidateSettings, Nomination } from "../schemas/candidate"
import type { AudioAnalysis, ChatAnalysis, Heatmap, TimeRange, Transcript } from "../schemas/media"
import { rankChatPeaks } from "./chat"
import { trackPeaks, type MomentKind, type MomentTracks } from "./moments"
import { sentenceUnits, type SentenceUnit } from "./speech"
import { clamp, iou, lastIndexAtOrBefore } from "./util"

export type SeedKind =
  | "spike"
  | "heatmap"
  | "chat"
  | "dense"
  | "sliding"
  | "llm"
  | "laugh"
  | "crowd"
  | "excite"
  | "dance"

export interface Seed {
  t: number
  kind: SeedKind
  strength: number
}

export interface RawWindow extends TimeRange {
  seeds: SeedKind[]
  /** inclusive global word indices, -1 when there is no transcript */
  firstWord: number
  lastWord: number
  /** 0..1 strength when the LLM nominated this moment from the full transcript */
  nominated?: number
}

export interface WindowInput {
  transcript: Transcript | null
  analysis: AudioAnalysis | null
  heatmap: Heatmap | null
  chat?: ChatAnalysis | null
  /** moments the LLM picked while reading the whole transcript */
  nominations?: readonly Nomination[] | null
  /** salience tracks from the audio/visual models: their peaks seed windows too */
  moments?: MomentTracks | null
  duration: number
  settings: Pick<
    CandidateSettings,
    "minSec" | "maxSec" | "targetSec" | "leadInSec" | "tailSec" | "slidingStepSec"
  >
}

export function collectSeeds(input: WindowInput, units: readonly SentenceUnit[]): Seed[] {
  const seeds: Seed[] = []
  const spikes = [...(input.analysis?.spikes ?? [])]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 60)
  for (const s of spikes) seeds.push({ t: s.t, kind: "spike", strength: s.strength })

  const pts = input.heatmap?.points ?? []
  const peaks = pts
    .filter(
      (p, i) =>
        p.value >= 0.45 &&
        p.value >= (pts[i - 1]?.value ?? 0) &&
        p.value >= (pts[i + 1]?.value ?? 0)
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, 20)
  for (const p of peaks)
    seeds.push({ t: (p.start + p.end) / 2, kind: "heatmap", strength: p.value })

  const chatPeaks = (input.chat ? rankChatPeaks(input.chat) : []).slice(0, 30)
  for (const p of chatPeaks) seeds.push({ t: p.t, kind: "chat", strength: p.strength })

  if (input.transcript && units.length) {
    // Dense-speech units: words per second, longer units only
    const dense = units
      .filter((u) => u.end - u.start >= 3)
      .map((u) => ({ u, wps: (u.last - u.first + 1) / (u.end - u.start) }))
      .sort((a, b) => b.wps - a.wps)
      .slice(0, Math.max(10, Math.round(units.length * 0.05)))
    for (const d of dense)
      seeds.push({ t: (d.u.start + d.u.end) / 2, kind: "dense", strength: clamp(d.wps / 4, 0, 1) })
  }

  // non-verbal moments the loudness curve and transcript can miss
  const mt = input.moments
  if (mt) {
    const kinds: [MomentKind, SeedKind][] = [
      ["laughter", "laugh"],
      ["crowd", "crowd"],
      ["excitement", "excite"],
      ["dance", "dance"],
    ]
    for (const [kind, seed] of kinds)
      for (const p of trackPeaks(mt, kind, { min: 0.5, gapSec: 10, limit: 30 }))
        seeds.push({ t: p.t, kind: seed, strength: p.strength })
  }

  const step = Math.max(2, input.settings.slidingStepSec)
  for (let t = 0; t < input.duration; t += step) seeds.push({ t, kind: "sliding", strength: 0 })
  return seeds
}

function unitIndexAt(units: readonly SentenceUnit[], t: number): number {
  const i = lastIndexAtOrBefore(units, t, (u) => u.start)
  if (i < 0) return 0
  // if t is after the end of unit i, use the next one
  if (t > units[i].end && i + 1 < units.length) return i + 1
  return i
}

/** Grow a window from unit `s` until it is at least `len` long (bounded by maxSec). */
function growFrom(
  units: readonly SentenceUnit[],
  s: number,
  len: number,
  minSec: number,
  maxSec: number
): number | null {
  let e = s
  while (e + 1 < units.length && units[e].end - units[s].start < len) {
    if (units[e + 1].end - units[s].start > maxSec) break
    e++
  }
  const dur = units[e].end - units[s].start
  if (dur < minSec || dur > maxSec) return null
  return e
}

/**
 * Widen a unit span so it starts at the beginning of a sentence and ends at the end of one,
 * when the clip-length limit allows (units split mid-sentence for length are clauses).
 */
export function toSentenceEdges(
  units: readonly SentenceUnit[],
  s: number,
  e: number,
  maxSec: number
): [number, number] {
  let a = s
  let b = e
  while (!units[a].startsSentence && a > 0 && units[b].end - units[a - 1].start <= maxSec) a--
  while (
    !units[b].endsSentence &&
    b + 1 < units.length &&
    units[b + 1].end - units[a].start <= maxSec
  )
    b++
  return [a, b]
}

/**
 * Build candidate windows snapped to sentence boundaries, seeded around spikes, heatmap and chat peaks,
 * dense speech and a sliding window across the whole video.
 */
export function generateWindows(input: WindowInput): RawWindow[] {
  const { settings, duration } = input
  const { minSec, maxSec, targetSec, leadInSec, tailSec } = settings
  const units = input.transcript ? sentenceUnits(input.transcript) : []
  const seeds = collectSeeds(input, units)
  const out = new Map<string, RawWindow>()

  if (units.length === 0) {
    // No transcript: plain time windows.
    for (const seed of seeds) {
      const start = clamp(
        seed.t - (seed.kind === "sliding" ? 0 : targetSec * 0.4),
        0,
        Math.max(0, duration - minSec)
      )
      const end = Math.min(duration, start + targetSec)
      if (end - start < minSec) continue
      const key = `${start.toFixed(1)}-${end.toFixed(1)}`
      const existing = out.get(key)
      if (existing) {
        if (!existing.seeds.includes(seed.kind)) existing.seeds.push(seed.kind)
      } else out.set(key, { start, end, seeds: [seed.kind], firstWord: -1, lastWord: -1 })
    }
    return [...out.values()]
  }

  const lengths = [
    ...new Set(
      [targetSec, (minSec + targetSec) / 2, (targetSec + maxSec) / 2].map((l) => Math.round(l))
    ),
  ]
  for (const seed of seeds) {
    // Hook - Progress - Climax: put the detected moment late in the window (it's the climax)
    const anchors = seed.kind === "sliding" ? [0] : [0.55, 0.8]
    const lens = seed.kind === "sliding" ? [targetSec] : lengths
    for (const anchor of anchors) {
      for (const len of lens) {
        const s0 = unitIndexAt(units, seed.t - len * anchor)
        const e0 = growFrom(units, s0, len, minSec, maxSec)
        if (e0 === null) continue
        const [s, e] = toSentenceEdges(units, s0, e0, maxSec)
        addSpan(s, e, seed.kind)
      }
    }
  }

  // Dancing / performances often have little or no speech: also offer plain time windows there
  // (sentence-snapped windows can't cover a long stretch without words).
  for (const seed of seeds) {
    if (seed.kind !== "dance") continue
    for (const len of lengths) {
      const start = clamp(seed.t - len * 0.6, 0, Math.max(0, duration - minSec))
      const end = Math.min(duration, start + len)
      if (end - start < minSec) continue
      // skip when it would cut through speech: words right at either edge
      const cutsWord = units.some(
        (u) => (u.start < start && u.end > start + 0.3) || (u.start < end - 0.3 && u.end > end)
      )
      if (cutsWord) continue
      const key = `t${start.toFixed(1)}-${end.toFixed(1)}`
      if (!out.has(key)) out.set(key, { start, end, seeds: ["dance"], firstWord: -1, lastWord: -1 })
    }
  }

  // LLM nominations: keep the moment the model chose, snapped to sentence edges
  for (const n of input.nominations ?? []) {
    const s0 = unitIndexAt(units, n.start + 0.05)
    let e0 = lastIndexAtOrBefore(units, n.end - 0.05, (u) => u.start)
    if (e0 < s0) e0 = s0
    // too long for a clip: keep the opening (the model's start) and grow to the target length
    if (units[e0].end - units[s0].start > maxSec) {
      const g = growFrom(units, s0, targetSec, minSec, maxSec)
      if (g === null) continue
      e0 = g
    }
    const [s, e] = toSentenceEdges(units, s0, e0, maxSec)
    if (units[e].end - units[s].start < minSec * 0.8) continue
    const w = addSpan(s, e, "llm")
    w.nominated = Math.max(w.nominated ?? 0, n.strength)
  }
  return [...out.values()]

  function addSpan(s: number, e: number, kind: SeedKind): RawWindow {
    const prevEnd = s > 0 ? units[s - 1].end : 0
    const nextStart = e + 1 < units.length ? units[e + 1].start : duration
    const start = Math.max(0, Math.max(prevEnd + 0.02, units[s].start - leadInSec))
    const end = Math.min(duration, Math.min(nextStart - 0.02, units[e].end + tailSec))
    const key = `${s}-${e}`
    const existing = out.get(key)
    if (existing) {
      if (!existing.seeds.includes(kind)) existing.seeds.push(kind)
      return existing
    }
    const w: RawWindow = {
      start,
      end,
      seeds: [kind],
      firstWord: units[s].first,
      lastWord: units[e].last,
    }
    out.set(key, w)
    return w
  }
}

/**
 * Hook - Progress - Climax: a clip ends on its climax plus at most a short reaction. Given unit
 * indices of a moment (start = hook, climax, end), pull the end back to the last unit that ends
 * within `maxTailSec` after the climax unit, unless that would make the clip shorter than minSec.
 */
export function endAfterClimax(
  units: readonly { start: number; end: number }[],
  startIdx: number,
  climaxIdx: number,
  endIdx: number,
  opts: { maxTailSec?: number; minSec?: number } = {}
): number {
  const maxTail = opts.maxTailSec ?? 5
  if (climaxIdx < startIdx || climaxIdx > endIdx) return endIdx
  let e = climaxIdx
  while (e + 1 <= endIdx && units[e + 1].end - units[climaxIdx].end <= maxTail) e++
  if (units[e].end - units[startIdx].start < (opts.minSec ?? 0)) return endIdx
  return e
}

/**
 * Greedy de-duplication: keep highest-scoring windows whose IoU with every kept window
 * (and every excluded range) is below the threshold.
 */
export function selectTop<T extends TimeRange & { score: number }>(
  items: readonly T[],
  n: number,
  iouThreshold: number,
  exclude: readonly TimeRange[] = []
): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score)
  const kept: T[] = []
  for (const it of sorted) {
    if (kept.length >= n) break
    if (exclude.some((x) => iou(x, it) >= iouThreshold)) continue
    if (kept.some((k) => iou(k, it) >= iouThreshold)) continue
    kept.push(it)
  }
  return kept
}
