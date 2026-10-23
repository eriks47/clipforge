import { z } from "zod"
import {
  CaptionConfigSchema,
  ExtrasConfigSchema,
  FramingModeSchema,
  HookConfigSchema,
  LookConfigSchema,
  SafeZonePlatformSchema,
} from "./edit"

export const EdlSegmentSchema = z.object({
  /** source time (seconds) */
  srcStart: z.number(),
  srcEnd: z.number(),
  /** output time (seconds) */
  outStart: z.number(),
  outEnd: z.number(),
})
export type EdlSegment = z.infer<typeof EdlSegmentSchema>

export const CaptionWordSchema = z.object({
  text: z.string(),
  /** output time */
  start: z.number(),
  end: z.number(),
  emphasis: z.boolean().default(false),
  /** emoji shown above the caption page this word starts */
  emoji: z.string().optional(),
})
export type CaptionWord = z.infer<typeof CaptionWordSchema>

export const CaptionPageSchema = z.object({
  start: z.number(),
  end: z.number(),
  words: z.array(CaptionWordSchema),
})
export type CaptionPage = z.infer<typeof CaptionPageSchema>

export const FramingPointSchema = z.object({
  /** output time */
  t: z.number(),
  /** focus center normalized to source frame */
  cx: z.number(),
  cy: z.number(),
})
export type FramingPoint = z.infer<typeof FramingPointSchema>

export const ZoomPointSchema = z.object({
  t: z.number(),
  scale: z.number(),
  /** easing used when interpolating from the previous point to this one */
  ease: z.enum(["linear", "smooth"]).default("smooth"),
})
export type ZoomPoint = z.infer<typeof ZoomPointSchema>

export const ClipRenderPropsSchema = z.object({
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  durationInFrames: z.number().int().min(1),
  video: z.object({
    src: z.string(),
    /** file time = source time - fileOffset (used when the source was pre-cut) */
    fileOffset: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  segments: z.array(EdlSegmentSchema),
  speed: z.number(),
  crossfadeSec: z.number(),
  framing: z.object({
    mode: FramingModeSchema,
    track: z.array(FramingPointSchema),
    /** second speaker, split mode only */
    trackB: z.array(FramingPointSchema).default([]),
    blurAmount: z.number(),
    /** blur-fill foreground: scale and offset (fractions of the output size) */
    fill: z.object({ zoom: z.number(), x: z.number(), y: z.number() }).default({
      zoom: 1,
      x: 0,
      y: 0,
    }),
    /**
     * blur-fill renders: a low-res, already-blurred copy of the source for the background
     * (same timing as video.src). Null = blur the source with CSS (editor preview).
     */
    background: z
      .object({ src: z.string(), width: z.number(), height: z.number() })
      .nullable()
      .default(null),
  }),
  zoom: z.array(ZoomPointSchema),
  /** extra zoom alternated per EDL segment to hide jump cuts (0 = off) */
  cutPunch: z.number(),
  captions: z.object({
    enabled: z.boolean(),
    style: CaptionConfigSchema,
    pages: z.array(CaptionPageSchema),
  }),
  hook: z.object({
    enabled: z.boolean(),
    style: HookConfigSchema,
    text: z.string(),
    start: z.number(),
    end: z.number(),
  }),
  look: LookConfigSchema,
  extras: ExtrasConfigSchema,
  music: z
    .object({
      src: z.string(),
      volume: z.number(),
      duckTo: z.number(),
      /** output-time speech intervals for ducking */
      speech: z.array(z.object({ start: z.number(), end: z.number() })),
    })
    .nullable(),
  safeZone: SafeZonePlatformSchema.nullable(),
})
export type ClipRenderProps = z.infer<typeof ClipRenderPropsSchema>
