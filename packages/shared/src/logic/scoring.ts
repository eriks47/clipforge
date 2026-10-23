import type { Category, ScoreWeights } from "../schemas/candidate"
import type { AudioAnalysis, ChatAnalysis, Heatmap, TimeRange, Transcript } from "../schemas/media"
import { chatValue } from "./chat"
import { wordIndicesInRange } from "./edl"
import { peakValue, pitchRange, smooth, trackSlice, type MomentTracks } from "./moments"
import { isStrongOpener, sentenceText, speechStats, type SpeechStats } from "./speech"
import { clamp, coverage, lastIndexAtOrBefore, mean, percentile, smoothstep, std } from "./util"

export interface ScoringContext {
  transcript: Transcript | null
  analysis: AudioAnalysis | null
  heatmap: Heatmap | null
  /** Twitch chat replay activity (VOD imports only) */
  chat?: ChatAnalysis | null
  /** per-video salience tracks from the audio/visual models (null = models not run) */
  moments?: MomentTracks | null
  /** per-video feature distributions (see buildCalibration) */
  calibration?: Calibration | null
  weights: ScoreWeights
}

/** Positive features in 0..1; null = not available (excluded from the weighted sum) */
export interface WindowFeatures {
  energyPeak: number | null
  energyVariance: number | null
  heatmap: number | null
  chat: number | null
  speechDensity: number | null
  deadAir: number | null
  hook: number | null
  cleanEnding: number | null
  /** Hook - Progress - Climax: the window's biggest moment lands near its end */
  climax: number | null
  reactions: number | null
  laughter: number | null
  crowd: number | null
  excitement: number | null
  pitch: number | null
  dance: number | null
  /** penalties in 0..1 (higher = worse) */
  silencePenalty: number | null
  lowConfidencePenalty: number | null
}

/**
 * "Something happens" signals. They are combined with a power mean (see heuristicScore), so one
 * strong signal (a huge laugh, a chat explosion) isn't averaged away by the others being quiet.
 */
export const HIGHLIGHT_FEATURES = [
  "energyPeak",
  "energyVariance",
  "heatmap",
  "chat",
  "reactions",
  "laughter",
  "crowd",
  "excitement",
  "pitch",
  "dance",
] as const
export type HighlightFeature = (typeof HIGHLIGHT_FEATURES)[number]
/** Structure / quality signals, combined with a plain weighted mean. */
const QUALITY = ["speechDensity", "deadAir", "hook", "cleanEnding", "climax"] as const
const POSITIVE = [...HIGHLIGHT_FEATURES, ...QUALITY] as const
const PENALTIES = ["silencePenalty", "lowConfidencePenalty"] as const
/** How much a fully-weighted penalty of 1.0 subtracts (fraction of the 0..1 score) */
const PENALTY_SCALE = 0.4

export const FEATURE_LABELS: Record<keyof WindowFeatures, string> = {
  energyPeak: "Energy peak",
  energyVariance: "Dynamics",
  heatmap: "Most replayed",
  chat: "Chat activity",
  speechDensity: "Speech density",
  deadAir: "No dead air",
  hook: "Hook (first 3s)",
  cleanEnding: "Clean ending",
  climax: "Climax near the end",
  reactions: "Reactions",
  laughter: "Laughter",
  crowd: "Cheering / shouting",
  excitement: "Vocal intensity",
  pitch: "Unusual pitch",
  dance: "Dance / performance",
  silencePenalty: "Silence / music",
  lowConfidencePenalty: "Low confidence",
}

function energySlice(a: AudioAnalysis, start: number, end: number): number[] {
  const i0 = Math.max(0, Math.floor(start / a.hopSec))
  const i1 = Math.min(a.energyNorm.length, Math.ceil(end / a.hopSec))
  return a.energyNorm.slice(i0, Math.max(i0, i1))
}

function heatmapValue(h: Heatmap, r: TimeRange): number | null {
  const pts = h.points.filter((p) => p.end > r.start && p.start < r.end)
  if (pts.length === 0) return null
  const vals = pts.map((p) => p.value)
  return 0.5 * mean(vals) + 0.5 * Math.max(...vals)
}

export function computeFeatures(
  range: TimeRange,
  ctx: ScoringContext
): { features: WindowFeatures; stats: SpeechStats | null } {
  const dur = Math.max(range.end - range.start, 1e-6)
  const f: WindowFeatures = {
    energyPeak: null,
    energyVariance: null,
    heatmap: null,
    chat: null,
    speechDensity: null,
    deadAir: null,
    hook: null,
    cleanEnding: null,
    climax: null,
    reactions: null,
    laughter: null,
    crowd: null,
    excitement: null,
    pitch: null,
    dance: null,
    silencePenalty: null,
    lowConfidencePenalty: null,
  }
  const stats = ctx.transcript ? speechStats(ctx.transcript.words, range) : null
  const a = ctx.analysis
  const slice = a ? energySlice(a, range.start, range.end) : []
  const sliceMean = mean(slice)
  const spikesIn = a ? a.spikes.filter((s) => s.t >= range.start && s.t <= range.end) : []

  if (a && slice.length) {
    f.energyPeak = clamp(percentile(slice, 0.95), 0, 1)
    f.energyVariance = clamp(std(slice) / 0.2, 0, 1)
  }
  if (ctx.heatmap) f.heatmap = heatmapValue(ctx.heatmap, range)
  if (ctx.chat) f.chat = chatValue(ctx.chat, range)

  if (stats) {
    f.speechDensity = clamp((stats.wordsPerSec - 1.2) / 2.0, 0, 1)
    f.deadAir = 1 - stats.deadAirRatio
    f.lowConfidencePenalty = stats.lowConfidenceRatio
    const perMin = 60 / dur
    const reactionCount =
      stats.laughter * 2 +
      stats.exclamations +
      stats.profanity +
      stats.questions * 0.5 +
      spikesIn.length * 0.5
    f.reactions = clamp((reactionCount * perMin) / 8, 0, 1)
  } else if (a) {
    f.reactions = clamp((spikesIn.length * 60) / dur / 4, 0, 1)
  }

  const mt = ctx.moments
  if (mt) {
    f.laughter = peakValue(trackSlice(mt, mt.laughter, range))
    f.crowd = peakValue(trackSlice(mt, mt.crowd, range))
    f.excitement = peakValue(trackSlice(mt, mt.excitement, range))
    f.pitch = clamp(
      0.65 * peakValue(trackSlice(mt, mt.pitch, range)) + 0.35 * pitchRange(mt, range),
      0,
      1
    )
    f.dance = peakValue(trackSlice(mt, mt.dance, range))
    // a performance doesn't need talk: don't mark it down for sparse speech
    if (f.speechDensity !== null) f.speechDensity = Math.max(f.speechDensity, f.dance)
    if (f.deadAir !== null) f.deadAir = Math.max(f.deadAir, f.dance)
  }

  // Hook: energy of the first 3 s + whether the opening sentence is a question / strong claim
  {
    let hookEnergy: number | null = null
    if (a && slice.length) {
      const first = energySlice(a, range.start, range.start + 3)
      hookEnergy = clamp(0.5 + (mean(first) - sliceMean) * 2.5, 0, 1)
      if (spikesIn.some((s) => s.t <= range.start + 3)) hookEnergy = clamp(hookEnergy + 0.25, 0, 1)
    }
    let opener: number | null = null
    if (ctx.transcript) {
      const idx = wordIndicesInRange(ctx.transcript.words, {
        start: range.start,
        end: Math.min(range.end, range.start + 4),
      })
      if (idx.length)
        opener = isStrongOpener(sentenceText(ctx.transcript.words, idx[0], idx[idx.length - 1]))
          ? 1
          : 0.3
      else opener = 0
    }
    // something already happening in the first 3 s (laughing, shouting, dancing, excited voice)
    const opening = { start: range.start, end: Math.min(range.end, range.start + 3) }
    const moment = mt
      ? Math.max(
          ...[mt.excitement, mt.laughter, mt.crowd, mt.dance].map((xs) =>
            peakValue(trackSlice(mt, xs, opening))
          )
        )
      : null
    const parts = [hookEnergy, opener, moment].filter((v): v is number => v !== null)
    f.hook = parts.length ? mean(parts) : null
  }

  // Clean ending: terminal punctuation + energy bump at the end
  {
    let ending: number | null = null
    if (ctx.transcript) {
      const idx = wordIndicesInRange(ctx.transcript.words, range)
      const last = idx.length ? ctx.transcript.words[idx[idx.length - 1]].text.trim() : ""
      ending = /[.!?…]["')\]]*$/.test(last) ? 0.6 : 0.2
    }
    if (a && slice.length) {
      const tail = energySlice(a, range.end - 3, range.end)
      const bump = clamp((mean(tail) - sliceMean) * 4 + 0.5, 0, 1) * 0.4
      ending = (ending ?? 0.3) + bump
    }
    // payoff: the laugh / cheer lands in the last third
    if (mt) {
      const tail = { start: range.end - Math.max(3, dur * 0.35), end: range.end }
      const payoff = Math.max(
        peakValue(trackSlice(mt, mt.laughter, tail)),
        peakValue(trackSlice(mt, mt.crowd, tail))
      )
      ending = (ending ?? 0.3) + 0.3 * payoff
    }
    f.cleanEnding = ending === null ? null : clamp(ending, 0, 1)
  }

  f.climax = climaxScore(range, ctx)

  // Silence / music-only penalty
  if (a) {
    const silenceCov = coverage(range, a.silences)
    let musicOnly = 0
    if (stats && sliceMean > 0.35 && stats.wordsPerSec < 0.6)
      musicOnly = 1 - stats.wordsPerSec / 0.6
    // music with dancing, singing, laughter or cheering is a moment, not filler
    if (mt) musicOnly *= 1 - Math.max(f.dance ?? 0, f.laughter ?? 0, f.crowd ?? 0)
    f.silencePenalty = Math.max(silenceCov, musicOnly)
  }
  return { features: f, stats }
}

/**
 * Per-video distributions of the highlight features, from plain windows across the whole video.
 * Lets the score ask "how unusual is this for this video?" instead of using fixed constants that
 * mean different things on a quiet podcast and a loud stream.
 */
export interface Calibration {
  sorted: Partial<Record<HighlightFeature, number[]>>
}

export function buildCalibration(
  ctx: ScoringContext,
  duration: number,
  windowSec: number,
  stepSec = 10
): Calibration {
  const vals: Partial<Record<HighlightFeature, number[]>> = {}
  const len = Math.min(windowSec, Math.max(duration, 1))
  for (let t = 0; t + len <= duration + 1e-6; t += stepSec) {
    const { features } = computeFeatures({ start: t, end: t + len }, { ...ctx, calibration: null })
    for (const k of HIGHLIGHT_FEATURES) {
      const v = features[k]
      if (v === null) continue
      ;(vals[k] ??= []).push(v)
    }
  }
  const sorted: Calibration["sorted"] = {}
  for (const k of HIGHLIGHT_FEATURES) {
    const v = vals[k]
    if (v && v.length >= 10) sorted[k] = v.sort((a, b) => a - b)
  }
  return { sorted }
}

/** Blend the raw value with its rank in this video (fraction of plain windows strictly below it). */
export function calibrateFeatures(features: WindowFeatures, cal: Calibration | null | undefined) {
  if (!cal) return features
  const out = { ...features }
  for (const k of HIGHLIGHT_FEATURES) {
    const v = features[k]
    const sorted = cal.sorted[k]
    if (v === null || !sorted) continue
    // count of values < v (strict), so features that are usually 0 stay 0 when absent
    const below = lastIndexAtOrBefore(sorted, v - 1e-9, (x) => x) + 1
    out[k] = 0.5 * v + 0.5 * (below / sorted.length)
  }
  return out
}

/**
 * With peak emphasis on, a highlight signal that is absent keeps only this share of its weight:
 * no laughter in a dance clip isn't evidence against it, it just isn't evidence for it.
 */
const ABSENT_WEIGHT = 0.3

/**
 * Score 0..100. Highlight features are combined with a weighted power mean (exponent
 * `peakEmphasis`): with p > 1 one strong signal outweighs several weak ones instead of being
 * averaged out by them, and absent signals weigh less (ABSENT_WEIGHT). Quality features use a
 * weighted mean; p = 1 is exactly the plain weighted mean of everything. Penalties subtract.
 */
/**
 * "How much is happening" per hop inside a range: loudness, energy spikes, laughter, cheering,
 * excited voice, dancing and chat activity, whichever is strongest. Null without any signal.
 */
export function interestCurve(range: TimeRange, ctx: ScoringContext): number[] | null {
  const a = ctx.analysis
  const mt = ctx.moments
  const hop = a?.hopSec ?? mt?.hopSec
  if (!hop || (!a && !mt)) return null
  const i0 = Math.max(0, Math.floor(range.start / hop))
  const i1 = Math.ceil(range.end / hop)
  const n = Math.max(0, i1 - i0)
  if (n === 0) return null
  const v = new Array<number>(n).fill(0)
  const put = (i: number, x: number) => {
    const k = i - i0
    if (k >= 0 && k < n && x > v[k]) v[k] = x
  }
  if (a) {
    for (let i = i0; i < Math.min(i1, a.energyNorm.length); i++) put(i, 0.6 * a.energyNorm[i])
    for (const s of a.spikes)
      if (s.t >= range.start && s.t <= range.end) put(Math.floor(s.t / hop), 0.5 + 0.5 * s.strength)
  }
  if (mt)
    for (const xs of [mt.laughter, mt.crowd, mt.excitement, mt.dance])
      for (let i = i0; i < Math.min(i1, xs.length); i++) put(i, xs[i])
  const chat = ctx.chat
  if (chat)
    for (let i = i0; i < i1; i++) {
      const c = chat.activity[Math.floor((i * hop) / chat.hopSec)]
      if (c !== undefined) put(i, 0.8 * c)
    }
  return smooth(v, 3)
}

/**
 * Hook - Progress - Climax: high when the window's strongest moment stands out and lands in its
 * last part, with little left over after it. A peak in the first half (payoff first, then
 * filler) or a long tail after the peak scores low.
 */
export function climaxScore(range: TimeRange, ctx: ScoringContext): number | null {
  const curve = interestCurve(range, ctx)
  if (!curve || curve.length < 4) return null
  const hop = (range.end - range.start) / curve.length
  let best = 0
  // ties go to the later hop: a sustained peak counts where it ends
  for (let i = 1; i < curve.length; i++) if (curve[i] >= curve[best]) best = i
  const tPeak = range.start + (best + 0.5) * hop
  const dur = Math.max(range.end - range.start, 1e-6)
  const location = smoothstep(((tPeak - range.start) / dur - 0.35) / 0.4)
  const tail = range.end - tPeak
  const tailFactor = tail <= 6 ? 1 : clamp(1 - (tail - 6) / 20, 0.3, 1)
  const prominence = clamp((curve[best] - percentile(curve, 0.5)) / 0.35, 0, 1)
  return clamp(location * tailFactor * (0.35 + 0.65 * prominence), 0, 1)
}

export function heuristicScore(
  features: WindowFeatures,
  weights: ScoreWeights,
  peakEmphasis = 1
): { score: number; breakdown: Record<string, number> } {
  const p = Math.max(1, peakEmphasis)
  let hl = 0
  let hw = 0
  let hwEff = 0
  let q = 0
  let qw = 0
  const breakdown: Record<string, number> = {}
  for (const k of HIGHLIGHT_FEATURES) {
    const v = features[k]
    if (v === null) continue
    const x = clamp(v, 0, 1)
    const w = weights[k]
    // p = 1: plain mean; otherwise the weight shrinks while the signal is absent
    const we = p > 1 ? w * (ABSENT_WEIGHT + (1 - ABSENT_WEIGHT) * x) : w
    hl += we * Math.pow(x, p)
    hwEff += we
    hw += w
    breakdown[k] = Math.round(v * 100)
  }
  for (const k of QUALITY) {
    const v = features[k]
    if (v === null) continue
    q += weights[k] * v
    qw += weights[k]
    breakdown[k] = Math.round(v * 100)
  }
  let pen = 0
  for (const k of PENALTIES) {
    const v = features[k]
    if (v === null) continue
    const pv = weights[k] * v * PENALTY_SCALE
    pen += pv
    breakdown[k] = -Math.round(pv * 100)
  }
  const highlight = hwEff > 0 ? Math.pow(hl / hwEff, 1 / p) : 0
  const base = hw + qw > 0 ? (hw * highlight + q) / (hw + qw) : 0
  return { score: Math.round(clamp(base - pen, 0, 1) * 1000) / 10, breakdown }
}

const REASON_PHRASES: Record<string, string> = {
  energyPeak: "big energy peak",
  energyVariance: "dynamic delivery",
  heatmap: "most-replayed section",
  chat: "chat went off",
  speechDensity: "dense, fast talk",
  deadAir: "no dead air",
  hook: "strong opening",
  cleanEnding: "lands on a clean ending",
  climax: "builds to a payoff at the end",
  reactions: "verbal reactions",
  laughter: "people laughing",
  crowd: "cheering / shouting",
  excitement: "intense, excited delivery",
  pitch: "voice cracks / pitch jumps",
  dance: "dancing / performance",
}

/** One-line reason built from the strongest weighted contributions. */
export function heuristicReason(features: WindowFeatures, weights: ScoreWeights): string {
  const ranked = POSITIVE.filter((k) => features[k] !== null)
    // prefer naming what happened over structure (no dead air, clean ending)
    .map((k) => ({
      k,
      v: (features[k] ?? 0) * weights[k] * ((QUALITY as readonly string[]).includes(k) ? 0.7 : 1),
    }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .filter((x) => x.v > 0.2)
  if (ranked.length === 0) return "Steady segment with no standout signals"
  const text = ranked.map((r) => REASON_PHRASES[r.k]).join(", ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const STORY_RE = /\b(one day|i remember|so then|back when|this one time|story|happened)\b/i

export function heuristicCategory(
  stats: SpeechStats | null,
  text: string,
  features?: Pick<WindowFeatures, "laughter" | "dance" | "crowd" | "excitement">
): Category {
  if ((features?.laughter ?? 0) >= 0.6) return "funny"
  if ((features?.dance ?? 0) >= 0.6) return "performance"
  if (!stats) return "other"
  if (stats.laughter >= 1) return "funny"
  if (stats.profanity >= 2) return "controversial"
  if (STORY_RE.test(text)) return "story"
  if (stats.questions >= 2 || stats.numbers >= 2) return "insight"
  if (
    stats.exclamations >= 3 ||
    (features?.excitement ?? 0) >= 0.7 ||
    (features?.crowd ?? 0) >= 0.7
  )
    return "emotional"
  return "other"
}

/** Strongest sentence in the window, trimmed to <= maxWords, as on-screen hook text. */
export function heuristicHook(sentences: readonly string[], maxWords = 8): string {
  const pick = sentences.find((s) => isStrongOpener(s)) ?? sentences[0] ?? ""
  const words = pick.replace(/["“”]/g, "").split(/\s+/).filter(Boolean)
  let hook = words.slice(0, maxWords).join(" ")
  if (words.length > maxWords) hook = hook.replace(/[,.;:!]+$/, "") + "…"
  return hook
}

export function heuristicTitle(sentences: readonly string[], maxChars = 70): string {
  const s = (sentences.find((x) => isStrongOpener(x)) ?? sentences[0] ?? "Untitled clip").trim()
  if (s.length <= maxChars) return s
  const cut = s.slice(0, maxChars - 1)
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)) + "…"
}
