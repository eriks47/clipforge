import { z } from "zod"

export const CATEGORIES = [
  "funny",
  "insight",
  "controversial",
  "story",
  "emotional",
  "performance",
  "other",
] as const
export const CategorySchema = z.enum(CATEGORIES)
export type Category = z.infer<typeof CategorySchema>

export const CandidateStatusSchema = z.enum(["new", "approved", "rejected"])
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>

export const CandidateSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  start: z.number(),
  end: z.number(),
  heuristicScore: z.number(),
  llmRating: z.number().nullable().optional(),
  /** LLM per-aspect scores 0-10 (hook, self_contained, payoff, emotion, novelty) */
  llmScores: z.record(z.string(), z.number()).nullable().optional(),
  /** signals that proposed the window (spike, heatmap, chat, dense, sliding, llm) */
  seeds: z.array(z.string()).nullable().optional(),
  /** 0..1 when the LLM nominated the moment while reading the whole transcript */
  nominated: z.number().nullable().optional(),
  finalRating: z.number(),
  breakdown: z.record(z.string(), z.number()),
  reason: z.string(),
  category: CategorySchema,
  suggestedHook: z.string(),
  suggestedTitle: z.string(),
  status: CandidateStatusSchema,
  source: z.enum(["auto", "manual"]).default("auto"),
  batch: z.number().default(0),
  rank: z.number().default(0),
  clipId: z.string().nullable().optional(),
  createdAt: z.string(),
})
export type Candidate = z.infer<typeof CandidateSchema>

export const ScoreWeightsSchema = z.object({
  energyPeak: z.number().default(1.0),
  energyVariance: z.number().default(0.5),
  heatmap: z.number().default(1.5),
  chat: z.number().default(1.5),
  speechDensity: z.number().default(0.8),
  deadAir: z.number().default(0.8),
  hook: z.number().default(1.2),
  cleanEnding: z.number().default(0.6),
  reactions: z.number().default(0.9),
  climax: z.number().default(1.2),
  laughter: z.number().default(1.3),
  crowd: z.number().default(1.1),
  excitement: z.number().default(1.0),
  pitch: z.number().default(0.5),
  dance: z.number().default(1.0),
  silencePenalty: z.number().default(1.0),
  lowConfidencePenalty: z.number().default(0.6),
})
export type ScoreWeights = z.infer<typeof ScoreWeightsSchema>

export const CandidateSettingsSchema = z.object({
  minSec: z.number().default(15),
  maxSec: z.number().default(60),
  targetSec: z.number().default(35),
  leadInSec: z.number().default(0.3),
  tailSec: z.number().default(0.4),
  iouThreshold: z.number().default(0.3),
  topN: z.number().default(10),
  slidingStepSec: z.number().default(10),
  weights: ScoreWeightsSchema.prefault({}),
  llmBlend: z.number().min(0).max(1).default(0.6),
  llmTopK: z.number().default(30),
  /**
   * Power-mean exponent for highlight signals: 1 = plain average (a big laugh is diluted by quiet
   * signals), higher = the strongest signal dominates. 3 keeps some benefit from agreeing signals.
   */
  peakEmphasis: z.number().min(1).max(8).default(3),
})
export type CandidateSettings = z.infer<typeof CandidateSettingsSchema>

export const AnalysisSettingsSchema = z.object({
  silenceNoiseDb: z.number().default(-35),
  silenceMinSec: z.number().default(0.6),
  sceneThreshold: z.number().default(0.3),
  spikeWindowSec: z.number().default(15),
  spikeMinRatio: z.number().default(1.6),
})
export type AnalysisSettings = z.infer<typeof AnalysisSettingsSchema>

/** Global app settings (stored in settings table) */
export const LLM_PROVIDERS = ["none", "claude", "codex"] as const
export const LlmProviderSchema = z.enum(LLM_PROVIDERS)
export type LlmProvider = z.infer<typeof LlmProviderSchema>

/** Which local CLI agent to use; switchable at runtime. `provider: null` = use LLM_PROVIDER from .env. */
export const LlmSettingsSchema = z.object({
  provider: LlmProviderSchema.nullable().default(null),
  /** empty = the CLI's default model */
  claudeModel: z.string().default(""),
  codexModel: z.string().default(""),
})
export type LlmSettings = z.infer<typeof LlmSettingsSchema>

export const AppSettingsSchema = z.object({
  llm: LlmSettingsSchema.prefault({}),
  candidates: CandidateSettingsSchema.prefault({}),
  analysis: AnalysisSettingsSchema.prefault({}),
  exportDir: z.string().default(""),
  defaultPresetId: z.string().nullable().default(null),
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

/** Per-aspect LLM scores (0-10 each), stored for learning ranking weights from approve/reject. */
/** Hook - Progress - Climax: the structure every clip is judged on, plus standalone and emotion. */
export const LLM_SUBSCORES = ["hook", "progress", "climax", "self_contained", "emotion"] as const
const subScore = z.number().min(0).max(10).catch(5)
export const LlmSubScoresSchema = z.object({
  hook: subScore,
  progress: subScore,
  climax: subScore,
  self_contained: subScore,
  emotion: subScore,
})
export type LlmSubScores = z.infer<typeof LlmSubScoresSchema>

/** LLM ranking response item (validated) */
export const LlmRankItemSchema = z.object({
  id: z.string(),
  rating: z.number().min(0).max(100),
  scores: LlmSubScoresSchema.nullable().optional(),
  reason: z.string(),
  /** hooks are written in a separate pass for the final clips; kept optional for older answers */
  suggested_hook: z.string().optional(),
  suggested_title: z.string(),
  /** piece id (first word index) the clip should start on; null = keep the current start */
  start_piece: z.number().int().nullable().optional(),
  /** piece id the clip should end with; null = keep the current end */
  end_piece: z.number().int().nullable().optional(),
  category: CategorySchema.catch("other"),
})
export type LlmRankItem = z.infer<typeof LlmRankItemSchema>
export const LlmRankResponseSchema = z.object({ candidates: z.array(LlmRankItemSchema) })

/** A moment the LLM nominated while reading the whole transcript (piece ids = first word index). */
export const LlmMomentSchema = z.object({
  /** the hook: the clip's first piece */
  start_piece: z.number().int(),
  /** the piece where the climax lands (punchline, reveal, reaction) */
  climax_piece: z.number().int().nullable().catch(null),
  end_piece: z.number().int(),
  rating: z.number().min(0).max(100).catch(50),
  why: z.string().catch(""),
})
export type LlmMoment = z.infer<typeof LlmMomentSchema>
export const LlmMomentsResponseSchema = z.object({ moments: z.array(LlmMomentSchema) })

/** Stored nominations for a project (output of the "nominate" job). */
export interface Nomination {
  start: number
  end: number
  /** 0..1 */
  strength: number
  why: string
  /** when the climax lands (start of the climax piece), if the LLM named one */
  climax?: number
}
export interface Nominations {
  model: string | null
  moments: Nomination[]
}
