import { z } from "zod"

export const ProbeInfoSchema = z.object({
  duration: z.number(),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  videoCodec: z.string(),
  audioCodec: z.string().nullable(),
  audioStreams: z.number(),
  sizeBytes: z.number(),
  formatName: z.string(),
  rotation: z.number().default(0),
})
export type ProbeInfo = z.infer<typeof ProbeInfoSchema>

export const WordSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  prob: z.number(),
})
export type Word = z.infer<typeof WordSchema>

export const SegmentSchema = z.object({
  id: z.number(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  /** inclusive index into words[] */
  wordIdxStart: z.number(),
  /** inclusive index into words[] */
  wordIdxEnd: z.number(),
})
export type Segment = z.infer<typeof SegmentSchema>

export const TranscriptSchema = z.object({
  language: z.string(),
  model: z.string().optional(),
  device: z.string().optional(),
  words: z.array(WordSchema),
  segments: z.array(SegmentSchema),
})
export type Transcript = z.infer<typeof TranscriptSchema>

export const TimeRangeSchema = z.object({ start: z.number(), end: z.number() })
export type TimeRange = z.infer<typeof TimeRangeSchema>

export const SpikeSchema = z.object({ t: z.number(), strength: z.number() })
export type Spike = z.infer<typeof SpikeSchema>

export const AudioAnalysisSchema = z.object({
  hopSec: z.number(),
  /** short-term LUFS per hop */
  loudness: z.array(z.number()),
  /** 0..1 normalized energy per hop */
  energyNorm: z.array(z.number()),
  spikes: z.array(SpikeSchema),
  silences: z.array(TimeRangeSchema),
})
export type AudioAnalysis = z.infer<typeof AudioAnalysisSchema>

/**
 * Audio models over the whole track (workers/py/signals.py), every track sampled per hopSec.
 * AudioSet groups are probabilities 0..1; arousal/dominance/valence ~0..1; pitch/pitchHi are
 * semitones above 55 Hz (0 = unvoiced); voiced is the voiced-frame fraction; effort is dB of
 * 1-5 kHz over 100-1000 Hz energy in voiced frames (0 = unvoiced).
 */
export const AUDIO_SIGNAL_TRACKS = [
  "laughter",
  "crowd",
  "shout",
  "gasp",
  "cry",
  "singing",
  "music",
  "danceMusic",
  "speech",
  "arousal",
  "dominance",
  "valence",
  "pitch",
  "pitchHi",
  "voiced",
  "effort",
] as const
export type AudioSignalTrack = (typeof AUDIO_SIGNAL_TRACKS)[number]
export const AudioSignalsSchema = z.object({
  version: z.number(),
  hopSec: z.number(),
  duration: z.number(),
  models: z.record(z.string(), z.string()),
  tracks: z.partialRecord(z.enum(AUDIO_SIGNAL_TRACKS), z.array(z.number())),
})
export type AudioSignals = z.infer<typeof AudioSignalsSchema>

/** Video signals (workers/py/visual.py), per hopSec: frame-difference motion and X-CLIP dance score. */
export const VisualSignalsSchema = z.object({
  version: z.number(),
  hopSec: z.number(),
  duration: z.number(),
  /** mean absolute frame difference 0..1 (hard cuts zeroed) */
  motion: z.array(z.number()),
  /** 1 where a hard cut happened */
  cut: z.array(z.number()),
  /** P(dancing / dance performance) 0..1, null when X-CLIP was unavailable */
  dance: z.array(z.number()).nullable(),
  model: z.string().nullable(),
})
export type VisualSignals = z.infer<typeof VisualSignalsSchema>

export const SceneCutsSchema = z.object({
  threshold: z.number(),
  cuts: z.array(z.number()),
})
export type SceneCuts = z.infer<typeof SceneCutsSchema>

export const HeatmapSchema = z.object({
  /** points sorted by start; value normalized 0..1 */
  points: z.array(z.object({ start: z.number(), end: z.number(), value: z.number() })),
})
export type Heatmap = z.infer<typeof HeatmapSchema>

/** Raw chat replay: [offset seconds from VOD start, user login, message text] */
export const ChatMessagesSchema = z.object({
  source: z.literal("twitch"),
  videoId: z.string(),
  messages: z.array(z.tuple([z.number(), z.string(), z.string()])),
})
export type ChatMessages = z.infer<typeof ChatMessagesSchema>

export const ChatAnalysisSchema = z.object({
  source: z.literal("twitch"),
  videoId: z.string(),
  hopSec: z.number(),
  /** chat reacts this long after the moment; activity/reactions/peaks are shifted back by it */
  lagSec: z.number(),
  totalMessages: z.number(),
  /** raw messages per bin (not shifted) */
  count: z.array(z.number()),
  /** 0..1 chat activity relative to the stream's own baseline (lag-shifted) */
  activity: z.array(z.number()),
  /** laughter / hype messages per bin (lag-shifted) */
  reactions: z.array(z.number()),
  /** moments chat blew up (lag-shifted source time) */
  peaks: z.array(z.object({ t: z.number(), strength: z.number() })),
})
export type ChatAnalysis = z.infer<typeof ChatAnalysisSchema>

export const FaceBoxSchema = z.object({
  /** normalized 0..1, top-left origin */
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  score: z.number(),
})
export type FaceBox = z.infer<typeof FaceBoxSchema>

export const FaceSamplesSchema = z.object({
  detector: z.string(),
  start: z.number(),
  end: z.number(),
  samples: z.array(z.object({ t: z.number(), faces: z.array(FaceBoxSchema) })),
})
export type FaceSamples = z.infer<typeof FaceSamplesSchema>
