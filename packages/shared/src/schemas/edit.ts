import { z } from "zod"

export const DEFAULT_FILLERS = [
  "um",
  "uh",
  "erm",
  "hmm",
  "mhm",
  "like",
  "you know",
  "i mean",
  "basically",
  "sort of",
  "kind of",
]

export const FONTS = [
  "Montserrat",
  "Inter",
  "Bebas Neue",
  "Anton",
  "Poppins",
  "TikTok Sans",
] as const
export const FontSchema = z.enum(FONTS)
export type FontName = z.infer<typeof FontSchema>

/** Weights bundled per font (all are loaded) and the weight used when none is chosen. */
export const FONT_WEIGHTS: Record<FontName, { weights: readonly number[]; default: number }> = {
  Montserrat: { weights: [400, 500, 600, 700, 800, 900], default: 900 },
  Inter: { weights: [400, 500, 600, 700, 800, 900], default: 800 },
  "Bebas Neue": { weights: [400], default: 400 },
  Anton: { weights: [400], default: 400 },
  Poppins: { weights: [400, 500, 600, 700, 800, 900], default: 800 },
  "TikTok Sans": { weights: [300, 400, 500, 600, 700, 800, 900], default: 800 },
}

/** The weight to render a font at: the requested one if the font has it, else the nearest bundled one. */
export function resolveFontWeight(font: FontName, requested: number): number {
  const { weights, default: def } = FONT_WEIGHTS[font]
  if (!requested) return def
  return weights.reduce((best, w) =>
    Math.abs(w - requested) < Math.abs(best - requested) ? w : best
  )
}

export const CAPTION_PRESETS = ["bold", "highlight", "boxed", "minimal"] as const
export const CaptionPresetSchema = z.enum(CAPTION_PRESETS)
export type CaptionPreset = z.infer<typeof CaptionPresetSchema>

export const FRAMING_MODES = ["face-track", "center", "manual", "split", "blur-fill"] as const
export const FramingModeSchema = z.enum(FRAMING_MODES)
export type FramingMode = z.infer<typeof FramingModeSchema>

export const CutsConfigSchema = z.object({
  deadAir: z
    .object({
      enabled: z.boolean().default(true),
      minGapMs: z.number().default(350),
      padMs: z.number().default(80),
    })
    .prefault({}),
  fillers: z
    .object({
      enabled: z.boolean().default(true),
      words: z.array(z.string()).default(DEFAULT_FILLERS),
      /** only cut fillers whose transcription probability is >= this */
      minProb: z.number().default(0.5),
    })
    .prefault({}),
  /** global transcript word indices struck out by the user */
  deletedWords: z.array(z.number()).default([]),
  /** ids of automatic cuts the user restored */
  restoredCuts: z.array(z.string()).default([]),
  crossfadeMs: z.number().default(30),
})
export type CutsConfig = z.infer<typeof CutsConfigSchema>

export const ManualFramingKeyframeSchema = z.object({
  /** source time, seconds */
  t: z.number(),
  /** normalized focus center 0..1 of source width/height */
  x: z.number(),
  y: z.number().default(0.5),
})
export type ManualFramingKeyframe = z.infer<typeof ManualFramingKeyframeSchema>

export const FramingConfigSchema = z.object({
  mode: FramingModeSchema.default("face-track"),
  /** 0 = no smoothing, 1 = very smooth */
  smoothing: z.number().min(0).max(1).default(0.6),
  sampleEveryFrames: z.number().int().min(1).default(5),
  holdDropoutSec: z.number().default(1.2),
  switchEaseSec: z.number().default(0.35),
  /** a speaker must dominate this long before we switch to them */
  switchMinSec: z.number().default(1.5),
  manualKeyframes: z.array(ManualFramingKeyframeSchema).default([]),
  blurAmount: z.number().default(40),
  /** blur-fill: scale of the sharp foreground frame (1 = full width) */
  fillZoom: z.number().min(1).max(3).default(1),
  /** blur-fill: foreground offset as a fraction of the output width/height (0 = centered) */
  fillOffsetX: z.number().min(-1).max(1).default(0),
  fillOffsetY: z.number().min(-1).max(1).default(0),
})
export type FramingConfig = z.infer<typeof FramingConfigSchema>

export const ManualZoomSchema = z.object({
  /** source time */
  t: z.number(),
  scale: z.number().default(1.15),
  durationSec: z.number().default(1.5),
})
export type ManualZoom = z.infer<typeof ManualZoomSchema>

export const ZoomConfigSchema = z.object({
  auto: z
    .object({
      enabled: z.boolean().default(true),
      intensity: z.number().default(0.12),
      maxPerMinute: z.number().default(6),
      onSpikes: z.boolean().default(true),
      onEmphasis: z.boolean().default(true),
    })
    .prefault({}),
  punchOnCuts: z.boolean().default(false),
  punchAmount: z.number().default(0.06),
  manual: z.array(ManualZoomSchema).default([]),
})
export type ZoomConfig = z.infer<typeof ZoomConfigSchema>

export const CaptionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["word", "phrase"]).default("phrase"),
  maxWords: z.number().int().min(1).default(3),
  maxChars: z.number().int().min(1).default(18),
  preset: CaptionPresetSchema.default("bold"),
  font: FontSchema.default("Montserrat"),
  fontSize: z.number().default(78),
  color: z.string().default("#ffffff"),
  highlightColor: z.string().default("#ffd400"),
  strokeColor: z.string().default("#000000"),
  strokeWidth: z.number().default(10),
  boxColor: z.string().default("#000000cc"),
  /** vertical center position, 0 = top, 1 = bottom */
  position: z.number().min(0).max(1).default(0.68),
  uppercase: z.boolean().default(true),
  animation: z.enum(["pop", "none"]).default("pop"),
  /** show emojis above caption lines (picked by the LLM before render, else keyword matching) */
  emoji: z.boolean().default(false),
  /** LLM picks: global word idx (first word of a caption line) -> emoji. Empty = keyword fallback */
  emojiPicks: z.record(z.string(), z.string()).default({}),
  /** frequency cap: at most one caption emoji every this many seconds (LLM budget + render-time spacing) */
  emojiEverySec: z.number().min(1).max(30).default(4),
  /** global word idx -> replacement text (timing unchanged) */
  overrides: z.record(z.string(), z.string()).default({}),
  hiddenWords: z.array(z.number()).default([]),
})
export type CaptionConfig = z.infer<typeof CaptionConfigSchema>

export const HookConfigSchema = z.object({
  enabled: z.boolean().default(true),
  text: z.string().default(""),
  /** 0 = whole clip */
  durationSec: z.number().default(3),
  /** keep the hook on screen until the last frame (durationSec is kept for when this is turned off) */
  wholeVideo: z.boolean().default(false),
  font: FontSchema.default("Montserrat"),
  fontSize: z.number().default(64),
  /** 0 = the font's default weight; otherwise snapped to the nearest bundled weight */
  fontWeight: z.number().int().min(0).max(900).default(0),
  /** letter spacing in em */
  letterSpacing: z.number().min(-0.1).max(0.5).default(0),
  lineHeight: z.number().min(0.8).max(2).default(1.15),
  color: z.string().default("#111111"),
  strokeColor: z.string().default("#000000"),
  /** text outline in px (0 = none) */
  strokeWidth: z.number().min(0).max(24).default(0),
  /** draw the background box (off = bare text, usually with a stroke or shadow) */
  box: z.boolean().default(true),
  background: z.string().default("#ffffff"),
  /** corner radius as a fraction of the font size */
  radius: z.number().min(0).max(1).default(0.22),
  /** box padding as a multiple of the default padding */
  padding: z.number().min(0).max(3).default(1),
  shadow: z.boolean().default(true),
  /** max width as a fraction of the frame width */
  maxWidth: z.number().min(0.3).max(1).default(0.86),
  /** tilt in degrees */
  rotation: z.number().min(-20).max(20).default(0),
  align: z.enum(["left", "center", "right"]).default("center"),
  animation: z.enum(["pop", "fade", "slide", "none"]).default("pop"),
  position: z.number().min(0).max(1).default(0.14),
  uppercase: z.boolean().default(false),
  /** add emojis to the hook (picked by the LLM before render, or typed in) */
  emoji: z.boolean().default(false),
  /** the chosen emojis (one or more); empty = pick before render (LLM, else keyword match) */
  emojiPick: z.string().default(""),
  /** how many emojis the LLM should pick */
  emojiCount: z.number().int().min(1).max(5).default(1),
  /** "both" puts the emojis on each side of the text */
  emojiPosition: z.enum(["start", "end", "both"]).default("end"),
})
export type HookConfig = z.infer<typeof HookConfigSchema>

export const LookConfigSchema = z.object({
  saturation: z.number().default(1.08),
  contrast: z.number().default(1.05),
  brightness: z.number().default(1.0),
  vignette: z.number().min(0).max(1).default(0),
  sharpen: z.number().min(0).max(1).default(0),
})
export type LookConfig = z.infer<typeof LookConfigSchema>

export const ExtrasConfigSchema = z.object({
  progressBar: z
    .object({
      enabled: z.boolean().default(false),
      color: z.string().default("#a855f7"),
      height: z.number().default(10),
    })
    .prefault({}),
  watermark: z
    .object({
      enabled: z.boolean().default(false),
      text: z.string().default("@yourchannel"),
      position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
        .default("bottom-right"),
      opacity: z.number().default(0.6),
    })
    .prefault({}),
  music: z
    .object({
      enabled: z.boolean().default(false),
      /** file name inside data/music */
      file: z.string().default(""),
      volume: z.number().default(0.18),
      duckTo: z.number().default(0.05),
    })
    .prefault({}),
  introFlash: z.boolean().default(false),
})
export type ExtrasConfig = z.infer<typeof ExtrasConfigSchema>

export const SAFE_ZONE_PLATFORMS = ["shorts", "tiktok", "reels"] as const
export const SafeZonePlatformSchema = z.enum(SAFE_ZONE_PLATFORMS)
export type SafeZonePlatform = z.infer<typeof SafeZonePlatformSchema>

export const EditConfigSchema = z.object({
  cuts: CutsConfigSchema.prefault({}),
  speed: z.number().min(0.5).max(2).default(1.02),
  framing: FramingConfigSchema.prefault({}),
  zooms: ZoomConfigSchema.prefault({}),
  captions: CaptionConfigSchema.prefault({}),
  hook: HookConfigSchema.prefault({}),
  look: LookConfigSchema.prefault({}),
  extras: ExtrasConfigSchema.prefault({}),
  safeZones: z
    .object({
      enabled: z.boolean().default(false),
      platform: SafeZonePlatformSchema.default("shorts"),
    })
    .prefault({}),
  audio: z
    .object({ loudnorm: z.boolean().default(true), targetLufs: z.number().default(-14) })
    .prefault({}),
  output: z
    .object({ fps: z.union([z.literal(30), z.literal(60), z.literal("source")]).default("source") })
    .prefault({}),
})
export type EditConfig = z.infer<typeof EditConfigSchema>
export type EditConfigInput = z.input<typeof EditConfigSchema>

export function defaultEditConfig(): EditConfig {
  return EditConfigSchema.parse({})
}

/** Style values a caption preset applies on top of the config */
export const CAPTION_PRESET_STYLES: Record<CaptionPreset, Partial<CaptionConfig>> = {
  bold: {
    font: "Montserrat",
    color: "#ffffff",
    highlightColor: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 12,
    uppercase: true,
  },
  highlight: {
    font: "Montserrat",
    color: "#ffffff",
    highlightColor: "#ffd400",
    strokeColor: "#000000",
    strokeWidth: 10,
    uppercase: true,
  },
  boxed: {
    font: "Inter",
    color: "#ffffff",
    highlightColor: "#a855f7",
    strokeWidth: 0,
    boxColor: "#000000cc",
    uppercase: false,
  },
  minimal: {
    font: "Inter",
    color: "#ffffff",
    highlightColor: "#ffffff",
    strokeWidth: 0,
    uppercase: false,
    fontSize: 60,
  },
}

/** Fraction of the 9:16 frame covered by platform UI (top, bottom, right) */
export const SAFE_ZONES: Record<
  SafeZonePlatform,
  { top: number; bottom: number; right: number; left: number }
> = {
  shorts: { top: 0.08, bottom: 0.2, right: 0.14, left: 0.03 },
  tiktok: { top: 0.09, bottom: 0.24, right: 0.15, left: 0.03 },
  reels: { top: 0.08, bottom: 0.22, right: 0.13, left: 0.03 },
}
