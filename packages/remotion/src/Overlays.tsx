import type React from "react"
import {
  AbsoluteFill,
  Html5Audio,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion"
import {
  lastIndexAtOrBefore,
  resolveFontWeight,
  SAFE_ZONES,
  type CaptionPage,
  type ClipRenderProps,
} from "@clipforge/shared"
import { FONT_FAMILIES } from "./fonts"

function textStroke(width: number, color: string): React.CSSProperties {
  if (width <= 0) return {}
  return { WebkitTextStroke: `${width}px ${color}`, paintOrder: "stroke fill" }
}

export const Captions: React.FC<{ captions: ClipRenderProps["captions"] }> = ({ captions }) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const t = frame / fps
  const { pages, style } = captions
  const i = lastIndexAtOrBefore(pages, t, (p) => p.start)
  const page: CaptionPage | undefined = i >= 0 && t < pages[i].end ? pages[i] : undefined
  if (!captions.enabled || !page) return null
  const font = FONT_FAMILIES[style.font]
  const pageFrame = frame - Math.round(page.start * fps)
  const pop =
    style.animation === "pop"
      ? spring({ frame: pageFrame, fps, config: { damping: 14, stiffness: 220, mass: 0.6 } })
      : 1
  const scale = style.animation === "pop" ? interpolate(pop, [0, 1], [0.82, 1]) : 1
  const emojiPop = spring({
    frame: pageFrame,
    fps,
    config: { damping: 9, stiffness: 180, mass: 0.7 },
  })
  const active = page.words.findIndex(
    (w, k) => t >= w.start && (k === page.words.length - 1 || t < page.words[k + 1].start)
  )
  // chosen by buildClipRenderProps (LLM pick or keyword fallback), same in preview and render
  const emoji = page.words.find((w) => w.emoji)?.emoji ?? null
  const boxed = style.preset === "boxed"
  const minimal = style.preset === "minimal"

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: width * 0.08,
          right: width * 0.08,
          top: style.position * height,
          transform: `translate(0, -50%) scale(${scale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        {emoji ? (
          <div
            style={{
              fontSize: style.fontSize * 1.6,
              lineHeight: 1,
              marginBottom: style.fontSize * 0.1,
              filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.45))",
              // its own bouncy entrance, slightly tilted, independent of the text pop
              transform: `scale(${interpolate(emojiPop, [0, 1], [0.3, 1])}) rotate(${interpolate(emojiPop, [0, 1], [-14, 0])}deg)`,
            }}
          >
            {emoji}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: `${style.fontSize * 0.12}px ${style.fontSize * 0.36}px`,
            padding: boxed ? `${style.fontSize * 0.2}px ${style.fontSize * 0.35}px` : 0,
            background: boxed ? style.boxColor : "transparent",
            borderRadius: boxed ? style.fontSize * 0.2 : 0,
            fontFamily: font.family,
            fontWeight: font.weight,
            fontSize: style.fontSize,
            lineHeight: 1.12,
            textAlign: "center",
            textTransform: style.uppercase ? "uppercase" : "none",
            textShadow: minimal ? "0 4px 18px rgba(0,0,0,0.75)" : undefined,
          }}
        >
          {page.words.map((w, k) => {
            const isActive = k === active
            const highlightPreset = style.preset === "highlight" || style.preset === "boxed"
            return (
              <span
                key={k}
                style={{
                  color:
                    isActive && highlightPreset
                      ? boxed
                        ? style.color
                        : style.highlightColor
                      : style.color,
                  background: isActive && boxed ? style.highlightColor : "transparent",
                  borderRadius: boxed ? 8 : 0,
                  padding: boxed ? "0 0.12em" : 0,
                  display: "inline-block",
                  transform: isActive && style.preset !== "minimal" ? "scale(1.04)" : "scale(1)",
                  opacity:
                    style.mode === "phrase" && t < w.start - 0.02 && style.preset === "minimal"
                      ? 0.55
                      : 1,
                  ...textStroke(boxed || minimal ? 0 : style.strokeWidth, style.strokeColor),
                }}
              >
                {w.text}
              </span>
            )
          })}
        </div>
      </div>
    </AbsoluteFill>
  )
}

export const Hook: React.FC<{ hook: ClipRenderProps["hook"] }> = ({ hook }) => {
  const frame = useCurrentFrame()
  const { fps, width, height, durationInFrames } = useVideoConfig()
  if (!hook.enabled) return null
  const startF = Math.round(hook.start * fps)
  const endF = Math.round(hook.end * fps)
  if (frame < startF || frame >= endF) return null
  const st = hook.style
  const local = frame - startF
  const s = spring({ frame: local, fps, config: { damping: 13, stiffness: 180 } })
  const fade = interpolate(local, [0, 8], [0, 1], { extrapolateRight: "clamp" })
  // entrance per animation style: scale, vertical offset (px) and opacity
  const enter =
    st.animation === "pop"
      ? { scale: interpolate(s, [0, 1], [0.7, 1]), dy: 0, opacity: Math.min(s * 1.4, 1) }
      : st.animation === "slide"
        ? { scale: 1, dy: interpolate(s, [0, 1], [-height * 0.06, 0]), opacity: fade }
        : st.animation === "fade"
          ? { scale: 1, dy: 0, opacity: fade }
          : { scale: 1, dy: 0, opacity: 1 }
  // a hook that runs to the last frame (whole-video hook) stays fully visible: no fade-out
  const out =
    endF >= durationInFrames - 1
      ? 1
      : interpolate(frame, [endF - 6, endF], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
  const font = FONT_FAMILIES[st.font]
  const pad = st.box ? st.padding : 0
  const margin = (width * (1 - st.maxWidth)) / 2
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: margin,
          right: margin,
          top: st.position * height,
          display: "flex",
          justifyContent:
            st.align === "left" ? "flex-start" : st.align === "right" ? "flex-end" : "center",
          transform: `translateY(calc(-50% + ${enter.dy}px)) scale(${enter.scale}) rotate(${st.rotation}deg)`,
          opacity: enter.opacity * out,
        }}
      >
        <div
          style={{
            background: st.box ? st.background : "transparent",
            color: st.color,
            fontFamily: font.family,
            fontWeight: resolveFontWeight(st.font, st.fontWeight),
            fontSize: st.fontSize,
            letterSpacing: `${st.letterSpacing}em`,
            lineHeight: st.lineHeight,
            padding: `${st.fontSize * 0.28 * pad}px ${st.fontSize * 0.45 * pad}px`,
            borderRadius: st.fontSize * st.radius,
            textAlign: st.align,
            textTransform: st.uppercase ? "uppercase" : "none",
            boxShadow: st.box && st.shadow ? "0 10px 40px rgba(0,0,0,0.35)" : undefined,
            textShadow: !st.box && st.shadow ? "0 4px 18px rgba(0,0,0,0.7)" : undefined,
            maxWidth: "100%",
            ...textStroke(st.strokeWidth, st.strokeColor),
          }}
        >
          {hook.text}
        </div>
      </div>
    </AbsoluteFill>
  )
}

export const Extras: React.FC<{
  extras: ClipRenderProps["extras"]
  look: ClipRenderProps["look"]
}> = ({ extras, look }) => {
  const frame = useCurrentFrame()
  const { durationInFrames, width, height } = useVideoConfig()
  const wm = extras.watermark
  const wmPos: Record<typeof wm.position, React.CSSProperties> = {
    "top-left": { top: height * 0.06, left: width * 0.05 },
    "top-right": { top: height * 0.06, right: width * 0.05 },
    "bottom-left": { bottom: height * 0.06, left: width * 0.05 },
    "bottom-right": { bottom: height * 0.06, right: width * 0.05 },
    center: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
  }
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {look.vignette > 0 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${look.vignette * 0.85}) 100%)`,
          }}
        />
      ) : null}
      {wm.enabled && wm.text ? (
        <div
          style={{
            position: "absolute",
            ...wmPos[wm.position],
            opacity: wm.opacity,
            color: "white",
            fontFamily: FONT_FAMILIES.Inter.family,
            fontWeight: 800,
            fontSize: 38,
            textShadow: "0 2px 10px rgba(0,0,0,0.6)",
          }}
        >
          {wm.text}
        </div>
      ) : null}
      {extras.progressBar.enabled ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            height: extras.progressBar.height,
            width: `${(frame / Math.max(durationInFrames - 1, 1)) * 100}%`,
            background: extras.progressBar.color,
          }}
        />
      ) : null}
      {extras.introFlash && frame < 6 ? (
        <AbsoluteFill
          style={{ background: "white", opacity: interpolate(frame, [0, 5], [0.9, 0]) }}
        />
      ) : null}
    </AbsoluteFill>
  )
}

/** Background music with auto-ducking under speech. */
export const Music: React.FC<{ music: NonNullable<ClipRenderProps["music"]> }> = ({ music }) => {
  const { fps } = useVideoConfig()
  const ramp = 0.3
  return (
    <Html5Audio
      src={music.src}
      loop
      volume={(f) => {
        const t = f / fps
        // distance (s) to the nearest speech interval; 0 inside speech
        let d = Infinity
        for (const s of music.speech) {
          if (t >= s.start && t <= s.end) {
            d = 0
            break
          }
          d = Math.min(d, Math.abs(t - s.start), Math.abs(t - s.end))
        }
        const k = Math.min(1, d / ramp)
        return music.duckTo + (music.volume - music.duckTo) * k
      }}
    />
  )
}

export const SafeZoneOverlay: React.FC<{ platform: NonNullable<ClipRenderProps["safeZone"]> }> = ({
  platform,
}) => {
  const z = SAFE_ZONES[platform]
  const shade = "rgba(255, 40, 80, 0.28)"
  const border = "2px dashed rgba(255,255,255,0.6)"
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: `${z.top * 100}%`,
          background: shade,
          borderBottom: border,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: `${z.bottom * 100}%`,
          background: shade,
          borderTop: border,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: `${z.top * 100}%`,
          bottom: `${z.bottom * 100}%`,
          width: `${z.right * 100}%`,
          background: shade,
          borderLeft: border,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: `${z.top * 100}%`,
          bottom: `${z.bottom * 100}%`,
          width: `${z.left * 100}%`,
          background: shade,
        }}
      />
    </AbsoluteFill>
  )
}
