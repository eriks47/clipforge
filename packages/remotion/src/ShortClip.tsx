import type React from "react"
import { AbsoluteFill } from "remotion"
import type { ClipRenderProps } from "@clipforge/shared"
import { Captions, Extras, Hook, Music, SafeZoneOverlay } from "./Overlays"
import { VideoLayer } from "./VideoLayer"

/**
 * The single composition used both for the live Player preview and for final rendering.
 * Everything is driven by ClipRenderProps (built by buildClipRenderProps in @clipforge/shared).
 */
export const ShortClip: React.FC<ClipRenderProps> = (props) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id="cf-sharpen">
          <feConvolveMatrix
            order="3"
            preserveAlpha="true"
            kernelMatrix={(() => {
              const a = props.look.sharpen
              return `0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0`
            })()}
          />
        </filter>
      </svg>
      <VideoLayer props={props} />
      <Extras extras={props.extras} look={props.look} />
      <Captions captions={props.captions} />
      <Hook hook={props.hook} />
      {props.music ? <Music music={props.music} /> : null}
      {props.safeZone ? <SafeZoneOverlay platform={props.safeZone} /> : null}
    </AbsoluteFill>
  )
}
