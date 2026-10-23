import type { ZoomConfig } from "../schemas/edit"
import type { Spike } from "../schemas/media"
import type { EdlSegment, ZoomPoint } from "../schemas/render"
import { edlDuration, srcToOut } from "./edl"
import { lastIndexAtOrBefore, lerp, smoothstep } from "./util"

interface ZoomEvent {
  /** output time of the peak start */
  t: number
  amount: number
  hold: number
  strength: number
}

const RAMP_IN = 0.18
const RAMP_OUT = 0.45
const DEFAULT_HOLD = 1.4

export interface ZoomInput {
  edl: readonly EdlSegment[]
  /** source-time spikes */
  spikes: readonly Spike[]
  /** output times of emphasis words */
  emphasis: readonly number[]
  cfg: ZoomConfig
}

/** Build zoom keyframes on the output timeline from auto punch-ins and manual zooms. */
export function buildZoomTrack(input: ZoomInput): ZoomPoint[] {
  const { edl, cfg } = input
  const duration = edlDuration(edl)
  const events: ZoomEvent[] = []
  if (cfg.auto.enabled && cfg.auto.intensity > 0) {
    const auto: ZoomEvent[] = []
    if (cfg.auto.onSpikes) {
      for (const s of input.spikes) {
        const t = srcToOut(edl, s.t, "strict")
        if (t !== null) auto.push({ t, amount: 0, hold: DEFAULT_HOLD, strength: 0.5 + s.strength })
      }
    }
    if (cfg.auto.onEmphasis)
      for (const t of input.emphasis) auto.push({ t, amount: 0, hold: DEFAULT_HOLD, strength: 0.6 })
    // Greedy by strength with minimum spacing (avoid nausea).
    const spacing = 60 / Math.max(cfg.auto.maxPerMinute, 0.1)
    auto.sort((a, b) => b.strength - a.strength)
    const picked: ZoomEvent[] = []
    for (const e of auto) {
      if (e.t < 0.6 || e.t > duration - 0.8) continue
      if (picked.every((p) => Math.abs(p.t - e.t) >= spacing)) picked.push(e)
    }
    for (const p of picked)
      events.push({
        ...p,
        amount: cfg.auto.intensity * Math.min(1, 0.6 + 0.4 * Math.min(p.strength, 1)),
      })
  }
  for (const m of cfg.manual) {
    const t = srcToOut(edl, m.t, "next")
    if (t !== null) events.push({ t, amount: m.scale - 1, hold: m.durationSec, strength: 2 })
  }
  events.sort((a, b) => a.t - b.t)

  const pts: ZoomPoint[] = [{ t: 0, scale: 1, ease: "linear" }]
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const next = events[i + 1]
    const start = Math.max(e.t - RAMP_IN, pts[pts.length - 1].t + 0.01)
    const peak = start + RAMP_IN
    let holdEnd = peak + e.hold
    let end = holdEnd + RAMP_OUT
    const limit = Math.min(duration, next ? next.t - RAMP_IN - 0.02 : duration)
    if (end > limit) {
      end = limit
      holdEnd = Math.max(peak, end - RAMP_OUT)
    }
    if (end <= peak) continue
    pts.push({ t: start, scale: 1, ease: "linear" })
    pts.push({ t: peak, scale: 1 + e.amount, ease: "smooth" })
    pts.push({ t: holdEnd, scale: 1 + e.amount, ease: "linear" })
    pts.push({ t: end, scale: 1, ease: "smooth" })
  }
  return pts
}

export function evalZoom(points: readonly ZoomPoint[], t: number): number {
  if (points.length === 0) return 1
  const i = lastIndexAtOrBefore(points, t, (p) => p.t)
  if (i < 0) return points[0].scale
  if (i >= points.length - 1) return points[points.length - 1].scale
  const a = points[i]
  const b = points[i + 1]
  const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
  return lerp(a.scale, b.scale, b.ease === "smooth" ? smoothstep(p) : p)
}
