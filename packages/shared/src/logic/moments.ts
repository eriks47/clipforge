import type { AudioSignals, TimeRange, VisualSignals } from "../schemas/media"
import { rollingMedian } from "./spikes"
import { clamp, percentile } from "./util"

/**
 * Per-video salience tracks (0..1 per hop) built from the audio/visual model outputs.
 * Everything is normalized against the video's own distribution (and the speaker's own
 * baseline for voice features), so a calm podcast and a loud stream both use the full range.
 */
export interface MomentTracks {
  hopSec: number
  /** laughter / giggling */
  laughter: number[]
  /** cheering, applause, shouting, screaming, gasps */
  crowd: number[]
  /** vocal intensity: arousal, vocal effort and pitch above the speaker's baseline (speech only) */
  excitement: number[]
  /** unusual pitch: high or jumping pitch relative to the speaker (speech only) */
  pitch: number[]
  /** dancing / singing / performance (X-CLIP dance score gated by music and motion, or singing) */
  dance: number[]
  /** raw music presence 0..1 (used to excuse music-heavy windows from the music-only penalty) */
  music: number[]
  /** raw voiced pitch in semitones above 55 Hz, 0 = unvoiced (for per-window pitch range) */
  pitchSemis: number[]
}

export const MOMENT_KINDS = ["laughter", "crowd", "excitement", "pitch", "dance"] as const
export type MomentKind = (typeof MOMENT_KINDS)[number]

/**
 * Map a probability-like track to 0..1 against its own distribution: the median maps to 0 and the
 * top 0.5% to 1. `floor` is the smallest spread that counts, so a video with no laughter at all
 * doesn't stretch noise into fake peaks.
 */
export function relativeSalience(xs: readonly number[], floor: number): number[] {
  if (xs.length === 0) return []
  const base = percentile(xs, 0.5)
  const top = percentile(xs, 0.995)
  const span = Math.max(top - base, floor)
  return xs.map((x) => clamp((x - base) / span, 0, 1))
}

/** Centered moving average over `win` samples. */
export function smooth(xs: readonly number[], win: number): number[] {
  const n = xs.length
  const half = Math.max(0, Math.floor(win / 2))
  if (half === 0 || n === 0) return [...xs]
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + xs[i]
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(n, i + half + 1)
    out[i] = (pre[b] - pre[a]) / (b - a)
  }
  return out
}

/** Resample a track from its hop to `hop` (nearest sample), length `n`. */
function resample(xs: readonly number[] | undefined, fromHop: number, hop: number, n: number) {
  const out = new Array<number>(n).fill(0)
  if (!xs || xs.length === 0) return out
  for (let i = 0; i < n; i++) {
    const j = Math.min(xs.length - 1, Math.floor(((i + 0.5) * hop) / fromHop))
    out[i] = xs[j]
  }
  return out
}

/**
 * Elevation of a voice feature over the speaker's own level: half global (vs. the video's voiced
 * distribution) and half local (vs. the rolling 2-minute median), for voiced hops only.
 */
function voiceElevation(
  xs: readonly number[],
  voicedMask: readonly boolean[],
  hop: number,
  globalFloor: number,
  localScale: number
): number[] {
  const n = xs.length
  const voicedVals = xs.filter((_, i) => voicedMask[i])
  if (voicedVals.length < 20) return new Array<number>(n).fill(0)
  const med = percentile(voicedVals, 0.5)
  const span = Math.max(percentile(voicedVals, 0.99) - med, globalFloor)
  // hold the last voiced value through unvoiced gaps so the rolling baseline follows the speaker
  const held = new Array<number>(n)
  let last = med
  for (let i = 0; i < n; i++) {
    if (voicedMask[i]) last = xs[i]
    held[i] = last
  }
  const base = rollingMedian(held, Math.max(3, Math.round(120 / hop)))
  return xs.map((x, i) => {
    if (!voicedMask[i]) return 0
    const g = clamp((x - med) / span, 0, 1)
    const l = clamp((x - base[i]) / localScale, 0, 1)
    return 0.5 * g + 0.5 * l
  })
}

/** Build per-video salience tracks at `hop` seconds (normally the audio analysis hop). */
export function buildMomentTracks(
  signals: AudioSignals | null | undefined,
  visual: VisualSignals | null | undefined,
  duration: number,
  hop = 0.5
): MomentTracks | null {
  if (!signals && !visual) return null
  const n = Math.max(1, Math.ceil(duration / hop))
  const zeros = () => new Array<number>(n).fill(0)
  const t = signals?.tracks ?? {}
  const sh = signals?.hopSec ?? hop
  const get = (k: keyof typeof t) => (signals && t[k] ? resample(t[k], sh, hop, n) : null)

  const laughterRaw = get("laughter")
  const laughter = laughterRaw ? relativeSalience(laughterRaw, 0.06) : zeros()

  const crowdParts = [
    [get("crowd"), 0.08, 1],
    [get("shout"), 0.05, 1],
    [get("gasp"), 0.1, 0.7],
  ] as const
  const crowd = zeros()
  for (const [raw, floor, w] of crowdParts) {
    if (!raw) continue
    const s = relativeSalience(raw, floor)
    for (let i = 0; i < n; i++) crowd[i] = Math.max(crowd[i], w * s[i])
  }

  const music = get("music") ?? zeros()
  const singingRaw = get("singing")
  const danceMusic = get("danceMusic")
  const speech = get("speech")
  const voiced = get("voiced")
  const pitchSemis = get("pitch") ?? zeros()
  const pitchHi = get("pitchHi")

  // voice features only count where someone is talking (not singing / music)
  let excitement = zeros()
  let pitch = zeros()
  if (signals && voiced) {
    const speechGate = voiced.map((v, i) => {
      const sp = speech ? clamp((speech[i] - 0.2) / 0.4, 0, 1) : 1
      const sing = singingRaw ? 1 - clamp((singingRaw[i] - 0.2) / 0.4, 0, 1) : 1
      return clamp(v / 0.3, 0, 1) * sp * sing
    })
    const mask = speechGate.map((g) => g > 0.3)
    const parts: { v: number[]; w: number }[] = []
    const arousal = get("arousal")
    if (arousal) parts.push({ v: voiceElevation(arousal, mask, hop, 0.12, 0.2), w: 0.5 })
    const effort = get("effort")
    if (effort) parts.push({ v: voiceElevation(effort, mask, hop, 4, 6), w: 0.25 })
    const pitchElev = voiceElevation(pitchHi ?? pitchSemis, mask, hop, 4, 5)
    parts.push({ v: pitchElev, w: 0.25 })
    const wsum = parts.reduce((s, p) => s + p.w, 0)
    excitement = smooth(
      speechGate.map((g, i) => (g * parts.reduce((s, p) => s + p.w * p.v[i], 0)) / wsum),
      5
    )
    pitch = smooth(
      pitchElev.map((v, i) => v * speechGate[i]),
      3
    )
  }

  let dance = zeros()
  const musicGate = music.map((m, i) => Math.max(m, danceMusic?.[i] ?? 0, singingRaw?.[i] ?? 0))
  if (visual?.dance) {
    const vh = visual.hopSec
    const xclip = resample(visual.dance, vh, hop, n)
    const motion = relativeSalience(resample(visual.motion, vh, hop, n), 0.03)
    dance = xclip.map((p, i) => {
      const s = clamp((p - 0.4) / 0.35, 0, 1)
      const mg = signals ? 0.3 + 0.7 * clamp(musicGate[i] / 0.5, 0, 1) : 0.7
      return s * mg * (0.5 + 0.5 * motion[i])
    })
    dance = smooth(dance, 5)
  }
  if (singingRaw) {
    const sing = relativeSalience(singingRaw, 0.15)
    for (let i = 0; i < n; i++) dance[i] = Math.max(dance[i], 0.8 * sing[i])
  }
  return { hopSec: hop, laughter, crowd, excitement, pitch, dance, music, pitchSemis }
}

export function trackSlice(tr: MomentTracks, xs: readonly number[], range: TimeRange): number[] {
  const i0 = Math.max(0, Math.floor(range.start / tr.hopSec))
  const i1 = Math.min(xs.length, Math.ceil(range.end / tr.hopSec))
  return xs.slice(i0, Math.max(i0, i1))
}

/**
 * Peak-weighted summary of a salience slice: mostly the strongest moment, partly how long the
 * top quarter is sustained. One big laugh in a 60 s window counts; it isn't averaged away.
 */
export function peakValue(slice: readonly number[]): number {
  if (slice.length === 0) return 0
  const sorted = [...slice].sort((a, b) => b - a)
  const q = Math.max(1, Math.ceil(sorted.length / 4))
  let top = 0
  for (let i = 0; i < q; i++) top += sorted[i]
  return clamp(0.7 * sorted[0] + 0.3 * (top / q), 0, 1)
}

/** Window pitch range (p90 - p10 of voiced semitones) mapped to 0..1 (6 st = 0, 14 st = 1). */
export function pitchRange(tr: MomentTracks, range: TimeRange): number {
  const v = trackSlice(tr, tr.pitchSemis, range).filter((x) => x > 0)
  if (v.length < 8) return 0
  return clamp((percentile(v, 0.9) - percentile(v, 0.1) - 6) / 8, 0, 1)
}

export interface MomentPeak {
  t: number
  kind: MomentKind
  strength: number
}

/** Local maxima of a track above `min`, strongest first, at least `gapSec` apart. */
export function trackPeaks(
  tr: MomentTracks,
  kind: MomentKind,
  opts: { min?: number; gapSec?: number; limit?: number } = {}
): MomentPeak[] {
  const xs = tr[kind]
  const min = opts.min ?? 0.5
  const gap = opts.gapSec ?? 10
  const raw: MomentPeak[] = []
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]
    if (v < min) continue
    if (i > 0 && xs[i - 1] > v) continue
    if (i + 1 < xs.length && xs[i + 1] > v) continue
    raw.push({ t: (i + 0.5) * tr.hopSec, kind, strength: v })
  }
  raw.sort((a, b) => b.strength - a.strength)
  const kept: MomentPeak[] = []
  for (const p of raw) {
    if (kept.length >= (opts.limit ?? 30)) break
    if (kept.every((k) => Math.abs(k.t - p.t) >= gap)) kept.push(p)
  }
  return kept
}

const TAG_TEXT: Record<MomentKind, string> = {
  laughter: "laughter",
  crowd: "cheering/shouting",
  excitement: "excited voice",
  pitch: "voice pitch jumps",
  dance: "dancing/singing",
}

export interface MomentTag extends TimeRange {
  kind: MomentKind
  /** peak salience 0..1 */
  strength: number
  text: string
}

/**
 * Non-verbal events inside a range (for the LLM prompts): runs of each track above `min`, merged
 * across short dips, as "[laughter strong]"-style tags with times.
 */
export function momentTags(tr: MomentTracks, range: TimeRange, min = 0.55): MomentTag[] {
  const out: MomentTag[] = []
  const i0 = Math.max(0, Math.floor(range.start / tr.hopSec))
  for (const kind of MOMENT_KINDS) {
    if (kind === "pitch") continue // folded into "excited voice" for the LLM
    const xs = trackSlice(tr, tr[kind], range)
    let cur: MomentTag | null = null
    for (let k = 0; k < xs.length; k++) {
      const t = (i0 + k) * tr.hopSec
      if (xs[k] >= min) {
        if (cur && t - cur.end <= 2) {
          cur.end = t + tr.hopSec
          cur.strength = Math.max(cur.strength, xs[k])
        } else {
          cur = { start: t, end: t + tr.hopSec, kind, strength: xs[k], text: "" }
          out.push(cur)
        }
      }
    }
  }
  for (const tag of out) {
    const level = tag.strength >= 0.85 ? "strong " : ""
    tag.text = `${level}${TAG_TEXT[tag.kind]}`
  }
  return out.sort((a, b) => a.start - b.start)
}
