import type { CandidateSettings, Category, Nomination } from "../schemas/candidate"
import type {
  AudioAnalysis,
  AudioSignals,
  ChatAnalysis,
  Heatmap,
  TimeRange,
  Transcript,
  VisualSignals,
} from "../schemas/media"
import { buildMomentTracks } from "./moments"
import {
  buildCalibration,
  calibrateFeatures,
  heuristicCategory,
  heuristicHook,
  heuristicReason,
  heuristicScore,
  heuristicTitle,
  computeFeatures,
  type ScoringContext,
} from "./scoring"
import { sentenceUnits, sentenceText } from "./speech"
import { generateWindows, selectTop, type SeedKind } from "./windowing"

export interface ScoredWindow extends TimeRange {
  score: number
  breakdown: Record<string, number>
  reason: string
  category: Category
  suggestedHook: string
  suggestedTitle: string
  seeds: SeedKind[]
  /** 0..1 when the LLM nominated this moment from the full transcript */
  nominated?: number
  text: string
}

export interface CandidateInput {
  transcript: Transcript | null
  analysis: AudioAnalysis | null
  heatmap: Heatmap | null
  chat?: ChatAnalysis | null
  /** audio model outputs (laughter, cheering, arousal, pitch...), null when not run */
  signals?: AudioSignals | null
  /** video model outputs (motion, dancing), null when not run */
  visual?: VisualSignals | null
  nominations?: readonly Nomination[] | null
  duration: number
  settings: CandidateSettings
  /** ranges already shown (for "find more") */
  exclude?: TimeRange[]
  /** how many to return; defaults to settings.topN */
  count?: number
}

/** Text of the transcript inside a range, plus its sentences. */
export function rangeText(
  transcript: Transcript | null,
  range: TimeRange
): { text: string; sentences: string[] } {
  if (!transcript) return { text: "", sentences: [] }
  const units = sentenceUnits(transcript).filter((u) => u.end > range.start && u.start < range.end)
  const sentences = units.map((u) => sentenceText(transcript.words, u.first, u.last))
  return { text: sentences.join(" "), sentences }
}

/**
 * Everything scoring needs, built once per run: salience tracks from the audio/visual models and
 * the per-video feature distributions used to calibrate highlight features.
 */
export function buildScoringContext(
  input: Omit<CandidateInput, "exclude" | "count" | "nominations">
): ScoringContext {
  const hop = input.analysis?.hopSec ?? 0.5
  const ctx: ScoringContext = {
    transcript: input.transcript,
    analysis: input.analysis,
    heatmap: input.heatmap,
    chat: input.chat ?? null,
    moments: buildMomentTracks(input.signals, input.visual, input.duration, hop),
    weights: input.settings.weights,
  }
  ctx.calibration = buildCalibration(ctx, input.duration, input.settings.targetSec)
  return ctx
}

export function scoreWindow(range: TimeRange, ctx: ScoringContext, peakEmphasis: number) {
  const { features: raw, stats } = computeFeatures(range, ctx)
  const features = calibrateFeatures(raw, ctx.calibration)
  const { score, breakdown } = heuristicScore(features, ctx.weights, peakEmphasis)
  return { score, breakdown, features, raw, stats }
}

export function scoreRange(
  range: TimeRange,
  input: Omit<CandidateInput, "exclude" | "count" | "nominations">,
  ctx: ScoringContext = buildScoringContext(input)
) {
  const { score, breakdown, features, raw, stats } = scoreWindow(
    range,
    ctx,
    input.settings.peakEmphasis
  )
  const { text, sentences } = rangeText(input.transcript, range)
  return {
    score,
    breakdown,
    reason: heuristicReason(features, input.settings.weights),
    // categories look at the raw (uncalibrated) strength of the moment
    category: heuristicCategory(stats, text, raw),
    suggestedHook: heuristicHook(sentences),
    suggestedTitle: heuristicTitle(sentences),
    text,
  }
}

/** Generate, score and de-duplicate candidate windows. Pure; safe to run in a worker. */
export function generateCandidates(input: CandidateInput, poolSize?: number): ScoredWindow[] {
  const ctx = buildScoringContext(input)
  const windows = generateWindows({
    transcript: input.transcript,
    analysis: input.analysis,
    heatmap: input.heatmap,
    chat: input.chat ?? null,
    nominations: input.nominations ?? null,
    moments: ctx.moments,
    duration: input.duration,
    settings: input.settings,
  })
  // Cheap pre-score (no text) to pick a pool, then full scoring for the pool only.
  const scored = windows.map((w) => {
    const { score } = scoreWindow(w, ctx, input.settings.peakEmphasis)
    // Small bonus for windows close to the target length and seeded by multiple signals.
    const lenBonus =
      1 -
      Math.min(1, Math.abs(w.end - w.start - input.settings.targetSec) / input.settings.targetSec) *
        0.05
    const seedBonus = 1 + Math.min(w.seeds.filter((s) => s !== "sliding").length, 3) * 0.01
    return { ...w, score: score * lenBonus * seedBonus }
  })
  const n = poolSize ?? input.count ?? input.settings.topN
  const exclude = input.exclude ?? []
  // Up to half the pool is reserved for LLM-nominated moments (strongest first): the heuristic
  // is mostly loudness, so calm-but-great moments would otherwise never reach the ranker.
  const nominated = scored
    .filter((w) => w.nominated !== undefined)
    .map((w) => ({ ...w, score: w.nominated ?? 0 }))
  const reserved = selectTop(nominated, Math.floor(n / 2), input.settings.iouThreshold, exclude)
  const reservedKeys = new Set(reserved.map((w) => `${w.start}-${w.end}`))
  const rest = selectTop(
    scored.filter((w) => !reservedKeys.has(`${w.start}-${w.end}`)),
    n - reserved.length,
    input.settings.iouThreshold,
    [...exclude, ...reserved]
  )
  const top = [
    ...reserved.map((r) => scored.find((w) => w.start === r.start && w.end === r.end) ?? r),
    ...rest,
  ]
  return top.map((w) => {
    const full = scoreRange(w, input, ctx)
    return {
      start: w.start,
      end: w.end,
      seeds: w.seeds,
      nominated: w.nominated,
      ...full,
      score: Math.round(w.score * 10) / 10,
    }
  })
}
