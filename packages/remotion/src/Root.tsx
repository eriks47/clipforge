import type React from "react"
import { Composition } from "remotion"
import { defaultEditConfig, type ClipRenderProps } from "@clipforge/shared"
import { ShortClip } from "./ShortClip"

export const COMPOSITION_ID = "ShortClip"

const cfg = defaultEditConfig()

/** Placeholder props for Remotion Studio; real props always come from buildClipRenderProps. */
export const sampleProps: ClipRenderProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 150,
  video: { src: "https://remotion.media/video.mp4", fileOffset: 0, width: 1920, height: 1080 },
  segments: [{ srcStart: 0, srcEnd: 5, outStart: 0, outEnd: 5 }],
  speed: 1,
  crossfadeSec: 0.03,
  framing: {
    mode: "center",
    track: [{ t: 0, cx: 0.5, cy: 0.5 }],
    trackB: [],
    blurAmount: 40,
    fill: { zoom: 1, x: 0, y: 0 },
    background: null,
  },
  zoom: [{ t: 0, scale: 1, ease: "linear" }],
  cutPunch: 0,
  captions: {
    enabled: true,
    style: cfg.captions,
    pages: [
      {
        start: 0.2,
        end: 2,
        words: [
          { text: "Hello", start: 0.2, end: 0.8, emphasis: false },
          { text: "world!", start: 0.9, end: 1.6, emphasis: true },
        ],
      },
    ],
  },
  hook: { enabled: true, style: cfg.hook, text: "This changes everything", start: 0, end: 3 },
  look: cfg.look,
  extras: cfg.extras,
  music: null,
  safeZone: null,
}

export const RemotionRoot: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={ShortClip}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={150}
    defaultProps={sampleProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.durationInFrames,
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
)
