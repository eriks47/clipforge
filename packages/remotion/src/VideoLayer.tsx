import type React from "react"
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion"
import { Video } from "@remotion/media"
import {
  cropFor,
  evalTrack,
  evalZoom,
  segmentIndexAt,
  type ClipRenderProps,
  type EdlSegment,
  type FramingPoint,
} from "@clipforge/shared"

type Props = Pick<
  ClipRenderProps,
  "video" | "segments" | "speed" | "crossfadeSec" | "framing" | "zoom" | "cutPunch" | "look"
>

function lookFilter(look: ClipRenderProps["look"]): string {
  const parts = [
    `saturate(${look.saturation})`,
    `contrast(${look.contrast})`,
    `brightness(${look.brightness})`,
  ]
  if (look.sharpen > 0) parts.push("url(#cf-sharpen)")
  return parts.join(" ")
}

/** One kept EDL segment: a trimmed video whose audio fades in/out briefly to avoid pops at cuts. */
const SegmentVideo: React.FC<{
  seg: EdlSegment
  index: number
  count: number
  props: Props
  muted?: boolean
  style?: React.CSSProperties
}> = ({ seg, index, count, props, muted, style }) => {
  const { fps } = useVideoConfig()
  const from = Math.round(seg.outStart * fps)
  const dur = Math.max(1, Math.round(seg.outEnd * fps) - from)
  const fadeFrames = Math.max(1, props.crossfadeSec * fps)
  return (
    <Video
      src={props.video.src}
      trimBefore={Math.max(0, Math.round((seg.srcStart - props.video.fileOffset) * fps))}
      playbackRate={props.speed}
      muted={muted}
      volume={(f) => {
        const fadeIn = index === 0 ? 1 : Math.min(1, (f + 0.5) / fadeFrames)
        const fadeOut = index === count - 1 ? 1 : Math.min(1, (dur - f - 0.5) / fadeFrames)
        return Math.max(0, Math.min(fadeIn, fadeOut))
      }}
      style={{ width: "100%", height: "100%", ...style }}
    />
  )
}

/** A box of size (w,h) showing the source cover-cropped around a focus point, with zoom. */
const CroppedFrame: React.FC<{
  w: number
  h: number
  track: FramingPoint[]
  props: Props
  children: React.ReactNode
}> = ({ w, h, track, props, children }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  const segIdx = segmentIndexAt(props.segments, t)
  const punch = props.cutPunch > 0 && segIdx % 2 === 1 ? 1 + props.cutPunch : 1
  const zoom = evalZoom(props.zoom, t) * punch
  const focus = evalTrack(track, t)
  const src = { width: props.video.width, height: props.video.height }
  const crop = cropFor(src, { width: w, height: h }, focus, zoom)
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          width: src.width * crop.scale,
          height: src.height * crop.scale,
          transform: `translate(${-crop.left * crop.scale}px, ${-crop.top * crop.scale}px)`,
          filter: lookFilter(props.look),
        }}
      >
        {children}
      </div>
    </div>
  )
}

function Segments({
  props,
  muted,
  style,
}: {
  props: Props
  muted?: boolean
  style?: React.CSSProperties
}) {
  const { fps } = useVideoConfig()
  return (
    <>
      {props.segments.map((seg, i) => {
        const from = Math.round(seg.outStart * fps)
        const dur = Math.max(1, Math.round(seg.outEnd * fps) - from)
        return (
          <Sequence
            key={`${seg.srcStart}-${i}`}
            from={from}
            durationInFrames={dur}
            premountFor={Math.round(fps)}
          >
            <SegmentVideo
              seg={seg}
              index={i}
              count={props.segments.length}
              props={props}
              muted={muted}
              style={style}
            />
          </Sequence>
        )
      })}
    </>
  )
}

export const VideoLayer: React.FC<{ props: Props }> = ({ props }) => {
  const { width, height } = useVideoConfig()
  const mode = props.framing.mode

  if (mode === "blur-fill") {
    const fitScale = width / props.video.width
    const fill = props.framing.fill
    // the sharp foreground: full-width fit, scaled by fill.zoom and moved by the offsets
    const fgW = width * fill.zoom
    const fgH = props.video.height * fitScale * fill.zoom
    const bg = props.framing.background
    return (
      <AbsoluteFill>
        {bg ? (
          // renders: a small video ffmpeg already blurred (one cheap decode, no CSS blur)
          <CroppedFrame
            w={width}
            h={height}
            track={[{ t: 0, cx: 0.5, cy: 0.5 }]}
            props={{
              ...props,
              video: { ...props.video, src: bg.src, width: bg.width, height: bg.height },
              zoom: [],
              cutPunch: 0,
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                filter: "brightness(0.6)",
                transform: "scale(1.1)",
              }}
            >
              <Segments props={{ ...props, video: { ...props.video, src: bg.src } }} muted />
            </div>
          </CroppedFrame>
        ) : (
          <CroppedFrame
            w={width}
            h={height}
            track={[{ t: 0, cx: 0.5, cy: 0.5 }]}
            props={{ ...props, zoom: [], cutPunch: 0 }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                filter: `blur(${props.framing.blurAmount}px) brightness(0.6)`,
                transform: "scale(1.1)",
              }}
            >
              <Segments props={props} muted />
            </div>
          </CroppedFrame>
        )}
        <div
          style={{
            position: "absolute",
            left: (width - fgW) / 2 + fill.x * width,
            top: (height - fgH) / 2 + fill.y * height,
            width: fgW,
            height: fgH,
            overflow: "hidden",
          }}
        >
          <CroppedFrame w={fgW} h={fgH} track={[{ t: 0, cx: 0.5, cy: 0.5 }]} props={props}>
            <Segments props={props} />
          </CroppedFrame>
        </div>
      </AbsoluteFill>
    )
  }

  if (mode === "split" && props.framing.trackB.length) {
    const half = height / 2
    return (
      <AbsoluteFill>
        <div
          style={{ position: "absolute", left: 0, top: 0, width, height: half, overflow: "hidden" }}
        >
          <CroppedFrame w={width} h={half} track={props.framing.track} props={props}>
            <Segments props={props} />
          </CroppedFrame>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: half,
            width,
            height: half,
            overflow: "hidden",
          }}
        >
          <CroppedFrame w={width} h={half} track={props.framing.trackB} props={props}>
            <Segments props={props} muted />
          </CroppedFrame>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: half - 3,
            width,
            height: 6,
            background: "#000",
          }}
        />
      </AbsoluteFill>
    )
  }

  return (
    <AbsoluteFill>
      <CroppedFrame w={width} h={height} track={props.framing.track} props={props}>
        <Segments props={props} />
      </CroppedFrame>
    </AbsoluteFill>
  )
}
