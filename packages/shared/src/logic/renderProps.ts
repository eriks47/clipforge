import { CAPTION_PRESET_STYLES, type EditConfig } from "../schemas/edit"
import type {
  AudioAnalysis,
  FaceSamples,
  ProbeInfo,
  SceneCuts,
  TimeRange,
  Transcript,
} from "../schemas/media"
import type { ClipRenderProps, EdlSegment, FramingPoint } from "../schemas/render"
import {
  buildCaptionPages,
  emojiFor,
  hookTextWithEmoji,
  retimeWords,
  speechIntervals,
} from "./captions"
import { buildEdl, computeCuts, edlDuration, wordIndicesInRange, type Cut } from "./edl"
import {
  buildFaceTrack,
  CENTER,
  evalTrack,
  hasFaceDetections,
  manualTrack,
  resampleToOutput,
} from "./framing"
import { buildZoomTrack } from "./zooms"

export const OUTPUT_WIDTH = 1080
export const OUTPUT_HEIGHT = 1920

export interface RenderPropsInput {
  range: TimeRange
  config: EditConfig
  transcript: Transcript | null
  analysis: AudioAnalysis | null
  faces: FaceSamples | null
  scenes: SceneCuts | null
  probe: Pick<ProbeInfo, "width" | "height" | "fps">
  video: { src: string; fileOffset: number; width: number; height: number }
  musicSrc?: string | null
  /** blur-fill renders: pre-blurred low-res background video (see ClipRenderProps.framing.background) */
  background?: { src: string; width: number; height: number } | null
  /** show the safe-zone overlay (preview only) */
  preview?: boolean
}

export function outputFps(config: EditConfig, sourceFps: number): number {
  if (config.output.fps === 30 || config.output.fps === 60) return config.output.fps
  const f = Math.round(sourceFps)
  if (!Number.isFinite(f) || f < 24) return 30
  return Math.min(f, 60)
}

/** Emoji for a caption page: an LLM pick on any of its words, else (no picks at all) a keyword match. */
function captionPageEmoji(
  words: readonly { text: string; idx?: number }[],
  picks: Record<string, string>
): string | null {
  const hasPicks = Object.keys(picks).length > 0
  if (hasPicks) {
    for (const w of words)
      if (w.idx !== undefined && picks[String(w.idx)]) return picks[String(w.idx)]
    return null
  }
  for (const w of words) {
    const e = emojiFor(w.text)
    if (e) return e
  }
  return null
}

export interface EditPlan {
  cuts: Cut[]
  edl: EdlSegment[]
  duration: number
}

/** Cuts + EDL for a clip (no rendering concerns). */
export function planEdit(
  range: TimeRange,
  config: EditConfig,
  transcript: Transcript | null
): EditPlan {
  const cuts = transcript ? computeCuts(transcript.words, range, config.cuts) : []
  const edl = buildEdl(range, cuts, config.speed)
  return { cuts, edl, duration: edlDuration(edl) }
}

/**
 * Single source of truth for what gets rendered: used by the live Player preview in the web app
 * and by the server's renderMedia call.
 */
export function buildClipRenderProps(
  input: RenderPropsInput
): ClipRenderProps & { plan: EditPlan } {
  const { config, transcript, range } = input
  const plan = planEdit(range, config, transcript)
  const { edl } = plan
  const fps = outputFps(config, input.probe.fps)
  const duration = plan.duration

  // Captions
  const idx = transcript ? wordIndicesInRange(transcript.words, range) : []
  const spikes = (input.analysis?.spikes ?? []).filter(
    (s) => s.t >= range.start && s.t <= range.end
  )
  const words = transcript
    ? retimeWords(transcript.words, idx, edl, {
        overrides: config.captions.overrides,
        hidden: config.captions.hiddenWords,
        deleted: config.cuts.deletedWords,
        spikes,
      })
    : []
  const pages = buildCaptionPages(words, {
    mode: config.captions.mode,
    maxWords: config.captions.maxWords,
    maxChars: config.captions.maxChars,
  })

  // Framing (source-time function -> output-time samples)
  let track: FramingPoint[] = [{ t: 0, cx: CENTER.cx, cy: CENTER.cy }]
  let trackB: FramingPoint[] = []
  const sceneCuts = input.scenes?.cuts ?? []
  const wantsFaces = config.framing.mode === "face-track" || config.framing.mode === "split"
  // Face framing without any known face would crop blindly into the middle of the shot (often a
  // wall between two people). Show the whole frame instead until/unless faces are found.
  const mode = wantsFaces && !hasFaceDetections(input.faces) ? "blur-fill" : config.framing.mode
  if (mode === "manual" && config.framing.manualKeyframes.length) {
    track = resampleToOutput(edl, manualTrack(config.framing.manualKeyframes))
  } else if ((mode === "face-track" || mode === "split") && hasFaceDetections(input.faces)) {
    const ft = buildFaceTrack(input.faces, config.framing, sceneCuts)
    if (mode === "split" && ft.splitTop.length && ft.splitBottom.length) {
      track = resampleToOutput(edl, (t) => evalTrack(ft.splitTop, t))
      trackB = resampleToOutput(edl, (t) => evalTrack(ft.splitBottom, t))
    } else if (ft.primary.length) {
      track = resampleToOutput(edl, (t) => evalTrack(ft.primary, t))
    }
  }

  // Zooms
  const zoom = buildZoomTrack({
    edl,
    spikes,
    emphasis: words.filter((w) => w.emphasis).map((w) => w.start),
    cfg: config.zooms,
  })

  /** start time of the last caption page that showed an emoji (frequency cap) */
  let lastEmojiAt: number | null = null
  const hookEnd =
    config.hook.wholeVideo || config.hook.durationSec <= 0
      ? duration
      : Math.min(config.hook.durationSec, duration)
  const music =
    config.extras.music.enabled && input.musicSrc
      ? {
          src: input.musicSrc,
          volume: config.extras.music.volume,
          duckTo: config.extras.music.duckTo,
          speech: speechIntervals(words),
        }
      : null

  return {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps,
    durationInFrames: Math.max(1, Math.round(duration * fps)),
    video: input.video,
    segments: edl,
    speed: config.speed,
    crossfadeSec: config.cuts.crossfadeMs / 1000,
    framing: {
      mode,
      track,
      trackB,
      blurAmount: config.framing.blurAmount,
      fill: {
        zoom: config.framing.fillZoom,
        x: config.framing.fillOffsetX,
        y: config.framing.fillOffsetY,
      },
      background: mode === "blur-fill" ? (input.background ?? null) : null,
    },
    zoom,
    cutPunch: config.zooms.punchOnCuts ? config.zooms.punchAmount : 0,
    captions: {
      enabled: config.captions.enabled,
      style: config.captions,
      pages: pages.map((p) => {
        let emoji = config.captions.emoji
          ? captionPageEmoji(p.words, config.captions.emojiPicks)
          : null
        // frequency cap: drop emojis closer than emojiEverySec to the previous one shown
        if (
          emoji &&
          lastEmojiAt !== null &&
          p.start - lastEmojiAt < config.captions.emojiEverySec - 1e-6
        )
          emoji = null
        if (emoji) lastEmojiAt = p.start
        return {
          ...p,
          words: p.words.map(({ text, start, end, emphasis }, i) => ({
            text,
            start,
            end,
            emphasis,
            ...(i === 0 && emoji ? { emoji } : {}),
          })),
        }
      }),
    },
    hook: {
      enabled: config.hook.enabled && config.hook.text.trim().length > 0,
      style: config.hook,
      text: hookTextWithEmoji(config.hook),
      start: 0,
      end: hookEnd,
    },
    look: config.look,
    extras: config.extras,
    music,
    safeZone: input.preview && config.safeZones.enabled ? config.safeZones.platform : null,
    plan,
  }
}

/** Apply a caption preset's styling to a config (used when the user picks a preset). */
export function applyCaptionPreset(
  config: EditConfig,
  preset: EditConfig["captions"]["preset"]
): EditConfig {
  return { ...config, captions: { ...config.captions, ...CAPTION_PRESET_STYLES[preset], preset } }
}

/** Height of the pre-blurred blur-fill background video (it is blurred anyway, so tiny is fine). */
export const BLUR_BG_HEIGHT = 270

/**
 * Gaussian sigma (in background-video pixels) that matches CSS `blur(blurAmount px)` once the
 * background is cover-scaled into the output frame (plus the 1.1× overscan the composition adds).
 */
export function blurBackgroundSigma(
  blurAmount: number,
  bg: { width: number; height: number },
  out: { width: number; height: number } = { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT }
): number {
  const scale = Math.max(out.width / bg.width, out.height / bg.height) * 1.1
  return blurAmount / scale
}
