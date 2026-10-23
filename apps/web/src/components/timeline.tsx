import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  snapToWord,
  type AudioAnalysis,
  type ChatAnalysis,
  type Heatmap,
  type MomentTracks,
  type SceneCuts,
  type TimeRange,
  type Word,
} from "@clipforge/shared"
import { formatTime } from "@/lib/format"

export interface TimelineCandidate extends TimeRange {
  id: string
  rating: number
  status: string
}

export interface TimelineProps {
  duration: number
  currentTime: number
  audio: AudioAnalysis | null
  heatmap: Heatmap | null
  /** Twitch chat activity (lag-compensated), VOD imports only */
  chat?: ChatAnalysis | null
  /** salience tracks from the audio/visual models (laughter, cheering, voice, dance) */
  moments?: MomentTracks | null
  scenes: SceneCuts | null
  words: readonly Word[]
  candidates: TimelineCandidate[]
  selectedId: string | null
  selection: TimeRange | null
  view: TimeRange
  onViewChange: (v: TimeRange) => void
  onSeek: (t: number) => void
  onSelectCandidate: (id: string) => void
  /** live while dragging; `final` on release. kind "create" = a brand-new range, "trim" = moved a handle */
  onSelectionChange: (
    r: TimeRange,
    final: boolean,
    kind: "create" | "trim"
  ) => void
}

const RULER = 20
const ENERGY = 64
const HEAT = 22
const CHAT = 26
const MOMENT_ROW = 7
const MOMENT_ROWS = [
  { key: "laughter", label: "laugh", color: "c2" },
  { key: "crowd", label: "cheer", color: "c4" },
  { key: "excitement", label: "voice", color: "c1" },
  { key: "dance", label: "dance", color: "c3" },
] as const
const MOMENTS = MOMENT_ROWS.length * (MOMENT_ROW + 1) + 1
const MARKS = 14
const CANDS = 26
const GAP = 4

function cssVar(name: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    "#888"
  )
}

function useThemeVersion() {
  const [v, setV] = useState(0)
  useEffect(() => {
    const mo = new MutationObserver(() => setV((x) => x + 1))
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => mo.disconnect()
  }, [])
  return v
}

function niceStep(secPerPx: number): number {
  const target = secPerPx * 90
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  return steps.find((s) => s >= target) ?? 3600
}

type Drag =
  | { kind: "seek" }
  | { kind: "handle"; edge: "start" | "end"; other: number }
  | { kind: "create"; anchor: number }
  | { kind: "pan"; x0: number; view0: TimeRange }

export function Timeline(props: TimelineProps) {
  const { duration, view } = props
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(800)
  const drag = useRef<Drag | null>(null)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const themeV = useThemeVersion()
  const hasHeat = !!props.heatmap && props.heatmap.points.length > 0
  const chat = props.chat && props.chat.totalMessages > 0 ? props.chat : null
  const height =
    RULER +
    ENERGY +
    (hasHeat ? HEAT + GAP : 0) +
    (chat ? CHAT + GAP : 0) +
    (props.moments ? MOMENTS + GAP : 0) +
    MARKS +
    GAP +
    CANDS +
    GAP

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const xOf = useCallback(
    (t: number) =>
      ((t - view.start) / Math.max(view.end - view.start, 1e-6)) * width,
    [view, width]
  )
  const tOf = useCallback(
    (x: number) => view.start + (x / width) * (view.end - view.start),
    [view, width]
  )

  // ---------- drawing ----------
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(width * dpr)
    c.height = Math.round(height * dpr)
    const ctx = c.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const col = {
      bg: cssVar("--background"),
      muted: cssVar("--muted"),
      mutedFg: cssVar("--muted-foreground"),
      fg: cssVar("--foreground"),
      border: cssVar("--border"),
      primary: cssVar("--primary"),
      c1: cssVar("--chart-1"),
      c2: cssVar("--chart-2"),
      c3: cssVar("--chart-3"),
      c4: cssVar("--chart-4"),
      c5: cssVar("--chart-5"),
      destructive: cssVar("--destructive"),
    }
    ctx.clearRect(0, 0, width, height)
    const span = view.end - view.start
    const secPerPx = span / width

    // ruler
    ctx.fillStyle = col.mutedFg
    ctx.font = "10px 'Inter Variable', sans-serif"
    ctx.textBaseline = "middle"
    const step = niceStep(secPerPx)
    ctx.strokeStyle = col.border
    ctx.lineWidth = 1
    for (
      let t = Math.ceil(view.start / step) * step;
      t <= view.end;
      t += step
    ) {
      const x = Math.round(xOf(t)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, RULER - 6)
      ctx.lineTo(x, height)
      ctx.globalAlpha = 0.35
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillText(formatTime(t), x + 3, RULER / 2)
    }

    let y = RULER
    // energy curve
    ctx.fillStyle = col.muted
    ctx.fillRect(0, y, width, ENERGY)
    const a = props.audio
    if (a && a.energyNorm.length) {
      const i0 = Math.max(0, Math.floor(view.start / a.hopSec))
      const i1 = Math.min(
        a.energyNorm.length - 1,
        Math.ceil(view.end / a.hopSec)
      )
      ctx.beginPath()
      ctx.moveTo(xOf(i0 * a.hopSec), y + ENERGY)
      // downsample to ~1 point per pixel (max within bucket)
      const per = Math.max(1, Math.floor((i1 - i0) / width))
      for (let i = i0; i <= i1; i += per) {
        let m = 0
        for (let k = i; k < Math.min(i + per, a.energyNorm.length); k++)
          m = Math.max(m, a.energyNorm[k])
        ctx.lineTo(xOf((i + 0.5) * a.hopSec), y + ENERGY - m * (ENERGY - 4))
      }
      ctx.lineTo(xOf(i1 * a.hopSec), y + ENERGY)
      ctx.closePath()
      ctx.fillStyle = col.c1
      ctx.globalAlpha = 0.55
      ctx.fill()
      ctx.globalAlpha = 1
      // silences shaded
      ctx.fillStyle = col.fg
      ctx.globalAlpha = 0.08
      for (const s of a.silences) {
        if (s.end < view.start || s.start > view.end) continue
        ctx.fillRect(
          xOf(s.start),
          y,
          Math.max(1, xOf(s.end) - xOf(s.start)),
          ENERGY
        )
      }
      ctx.globalAlpha = 1
      // spikes
      ctx.fillStyle = col.c2
      for (const s of a.spikes) {
        if (s.t < view.start || s.t > view.end) continue
        const x = xOf(s.t)
        ctx.beginPath()
        ctx.moveTo(x, y + 2)
        ctx.lineTo(x - 4, y + 9)
        ctx.lineTo(x + 4, y + 9)
        ctx.closePath()
        ctx.globalAlpha = 0.4 + 0.6 * s.strength
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = col.mutedFg
    ctx.fillText("energy", 4, y + 8)
    y += ENERGY + GAP

    // heatmap
    if (hasHeat && props.heatmap) {
      ctx.fillStyle = col.muted
      ctx.fillRect(0, y, width, HEAT)
      for (const p of props.heatmap.points) {
        if (p.end < view.start || p.start > view.end) continue
        ctx.fillStyle = col.c3
        ctx.globalAlpha = 0.15 + 0.85 * p.value
        const h = p.value * (HEAT - 2)
        ctx.fillRect(
          xOf(p.start),
          y + HEAT - h,
          Math.max(1, xOf(p.end) - xOf(p.start) - 0.5),
          h
        )
      }
      ctx.globalAlpha = 1
      ctx.fillStyle = col.mutedFg
      ctx.fillText("most replayed", 4, y + 7)
      y += HEAT + GAP
    }

    // chat activity (bars, max per pixel bucket) + peak markers
    if (chat) {
      ctx.fillStyle = col.muted
      ctx.fillRect(0, y, width, CHAT)
      const hop = chat.hopSec
      const i0 = Math.max(0, Math.floor(view.start / hop))
      const i1 = Math.min(chat.activity.length - 1, Math.ceil(view.end / hop))
      const per = Math.max(1, Math.floor((i1 - i0) / width))
      ctx.fillStyle = col.c5
      for (let i = i0; i <= i1; i += per) {
        let m = 0
        for (let k = i; k < Math.min(i + per, chat.activity.length); k++)
          m = Math.max(m, chat.activity[k])
        if (m <= 0.02) continue
        const h = m * (CHAT - 2)
        ctx.globalAlpha = 0.25 + 0.75 * m
        ctx.fillRect(
          xOf(i * hop),
          y + CHAT - h,
          Math.max(1, xOf((i + per) * hop) - xOf(i * hop)),
          h
        )
      }
      ctx.globalAlpha = 1
      ctx.fillStyle = col.fg
      for (const p of chat.peaks) {
        if (p.t < view.start || p.t > view.end) continue
        const x = xOf(p.t)
        ctx.beginPath()
        ctx.moveTo(x, y + 1)
        ctx.lineTo(x - 3.5, y + 7)
        ctx.lineTo(x + 3.5, y + 7)
        ctx.closePath()
        ctx.globalAlpha = 0.4 + 0.6 * p.strength
        ctx.fill()
      }
      ctx.globalAlpha = 1
      ctx.fillStyle = col.mutedFg
      ctx.fillText("chat", 4, y + 8)
      y += CHAT + GAP
    }

    // moments: laughter / cheering / vocal intensity / dancing, one thin row each
    const mt = props.moments
    if (mt) {
      ctx.fillStyle = col.muted
      ctx.fillRect(0, y, width, MOMENTS)
      const hop = mt.hopSec
      MOMENT_ROWS.forEach((row, r) => {
        const xs = mt[row.key]
        const ry = y + 1 + r * (MOMENT_ROW + 1)
        const i0 = Math.max(0, Math.floor(view.start / hop))
        const i1 = Math.min(xs.length - 1, Math.ceil(view.end / hop))
        const per = Math.max(1, Math.floor((i1 - i0) / width))
        ctx.fillStyle = col[row.color]
        for (let i = i0; i <= i1; i += per) {
          let m = 0
          for (let k = i; k < Math.min(i + per, xs.length); k++)
            m = Math.max(m, xs[k])
          if (m < 0.3) continue
          ctx.globalAlpha = 0.15 + 0.85 * ((m - 0.3) / 0.7)
          ctx.fillRect(
            xOf(i * hop),
            ry,
            Math.max(1, xOf((i + per) * hop) - xOf(i * hop)),
            MOMENT_ROW
          )
        }
        ctx.globalAlpha = 1
      })
      ctx.fillStyle = col.mutedFg
      ctx.font = "8px 'Inter Variable', sans-serif"
      MOMENT_ROWS.forEach((row, r) =>
        ctx.fillText(row.label, 4, y + 1 + r * (MOMENT_ROW + 1) + MOMENT_ROW / 2)
      )
      ctx.font = "10px 'Inter Variable', sans-serif"
      y += MOMENTS + GAP
    }

    // scene cuts + words density
    ctx.fillStyle = col.muted
    ctx.fillRect(0, y, width, MARKS)
    if (secPerPx < 0.5) {
      ctx.fillStyle = col.mutedFg
      ctx.globalAlpha = 0.35
      for (const w of props.words) {
        if (w.end < view.start) continue
        if (w.start > view.end) break
        ctx.fillRect(
          xOf(w.start),
          y + MARKS / 2 - 2,
          Math.max(1, xOf(w.end) - xOf(w.start) - 1),
          4
        )
      }
      ctx.globalAlpha = 1
    }
    ctx.strokeStyle = col.fg
    ctx.globalAlpha = 0.7
    for (const t of props.scenes?.cuts ?? []) {
      if (t < view.start || t > view.end) continue
      const x = Math.round(xOf(t)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x, y + MARKS)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    y += MARKS + GAP

    // candidates
    ctx.fillStyle = col.muted
    ctx.fillRect(0, y, width, CANDS)
    for (const cnd of props.candidates) {
      if (cnd.end < view.start || cnd.start > view.end) continue
      const x0 = xOf(cnd.start)
      const x1 = xOf(cnd.end)
      const color =
        cnd.status === "rejected"
          ? col.mutedFg
          : cnd.rating >= 75
            ? col.c2
            : cnd.rating >= 55
              ? col.c3
              : col.c5
      ctx.fillStyle = color
      ctx.globalAlpha =
        cnd.status === "rejected" ? 0.25 : 0.35 + 0.6 * (cnd.rating / 100)
      ctx.fillRect(x0, y + 2, Math.max(2, x1 - x0), CANDS - 4)
      ctx.globalAlpha = 1
      if (cnd.status === "approved") {
        ctx.fillStyle = col.fg
        ctx.fillRect(x0, y + CANDS - 4, Math.max(2, x1 - x0), 2)
      }
      if (x1 - x0 > 24) {
        ctx.fillStyle = col.fg
        ctx.fillText(String(Math.round(cnd.rating)), x0 + 4, y + CANDS / 2)
      }
    }

    // selection overlay with handles
    const sel = props.selection
    if (sel) {
      const x0 = xOf(sel.start)
      const x1 = xOf(sel.end)
      ctx.fillStyle = col.primary
      ctx.globalAlpha = 0.14
      ctx.fillRect(x0, RULER, x1 - x0, height - RULER)
      ctx.globalAlpha = 1
      ctx.fillStyle = col.primary
      ctx.fillRect(x0 - 1, RULER, 3, height - RULER)
      ctx.fillRect(x1 - 2, RULER, 3, height - RULER)
      ctx.fillRect(x0 - 5, height / 2 - 10, 9, 20)
      ctx.fillRect(x1 - 4, height / 2 - 10, 9, 20)
    }

    // hover line
    if (hoverT !== null) {
      ctx.strokeStyle = col.mutedFg
      ctx.setLineDash([3, 3])
      const x = Math.round(xOf(hoverT)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, RULER)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // playhead
    const px = Math.round(xOf(props.currentTime)) + 0.5
    ctx.strokeStyle = col.destructive
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, height)
    ctx.stroke()
    ctx.fillStyle = col.destructive
    ctx.beginPath()
    ctx.moveTo(px - 5, 0)
    ctx.lineTo(px + 5, 0)
    ctx.lineTo(px, 7)
    ctx.closePath()
    ctx.fill()
  }, [
    width,
    height,
    view,
    props.audio,
    props.heatmap,
    chat,
    props.moments,
    props.scenes,
    props.words,
    props.candidates,
    props.selection,
    props.currentTime,
    hoverT,
    xOf,
    hasHeat,
    themeV,
  ])

  // ---------- interaction ----------
  const candTop = height - CANDS - GAP
  const pointerT = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const snap = (t: number, edge: "start" | "end", shift: boolean) =>
    shift ? t : snapToWord(props.words, t, edge, 1.5)
  const clampT = (t: number) => Math.max(0, Math.min(duration, t))

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = pointerT(e)
    canvas.current!.setPointerCapture(e.pointerId)
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      drag.current = { kind: "pan", x0: x, view0: view }
      return
    }
    const sel = props.selection
    if (sel) {
      if (Math.abs(x - xOf(sel.start)) < 7) {
        drag.current = { kind: "handle", edge: "start", other: sel.end }
        return
      }
      if (Math.abs(x - xOf(sel.end)) < 7) {
        drag.current = { kind: "handle", edge: "end", other: sel.start }
        return
      }
    }
    const t = clampT(tOf(x))
    if (y >= candTop) {
      const hit = props.candidates.find((c) => t >= c.start && t <= c.end)
      if (hit) {
        props.onSelectCandidate(hit.id)
        return
      }
      drag.current = { kind: "create", anchor: snap(t, "start", e.shiftKey) }
      return
    }
    drag.current = { kind: "seek" }
    props.onSeek(t)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const { x } = pointerT(e)
    const t = clampT(tOf(x))
    setHoverT(t)
    const d = drag.current
    if (!d) {
      const sel = props.selection
      const nearHandle =
        sel &&
        (Math.abs(x - xOf(sel.start)) < 7 || Math.abs(x - xOf(sel.end)) < 7)
      canvas.current!.style.cursor = nearHandle ? "ew-resize" : "crosshair"
      return
    }
    if (d.kind === "seek") props.onSeek(t)
    else if (d.kind === "pan") {
      const dt = ((x - d.x0) / width) * (d.view0.end - d.view0.start)
      const len = d.view0.end - d.view0.start
      const start = Math.max(0, Math.min(duration - len, d.view0.start - dt))
      props.onViewChange({ start, end: start + len })
    } else if (d.kind === "handle") {
      const s = snap(t, d.edge, e.shiftKey)
      const r =
        d.edge === "start"
          ? { start: Math.min(s, d.other - 1), end: d.other }
          : { start: d.other, end: Math.max(s, d.other + 1) }
      props.onSelectionChange(r, false, "trim")
    } else if (d.kind === "create") {
      const a = d.anchor
      const r =
        t >= a
          ? { start: a, end: snap(t, "end", e.shiftKey) }
          : { start: snap(t, "start", e.shiftKey), end: a }
      if (r.end - r.start > 0.2) props.onSelectionChange(r, false, "create")
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    canvas.current?.releasePointerCapture(e.pointerId)
    if (!d) return
    if ((d.kind === "handle" || d.kind === "create") && props.selection)
      props.onSelectionChange(
        props.selection,
        true,
        d.kind === "create" ? "create" : "trim"
      )
  }

  // wheel = zoom around cursor; shift+wheel = pan
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      const x = e.clientX - r.left
      const len = view.end - view.start
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.shiftKey ? e.deltaY : e.deltaX) / width) * len
        const start = Math.max(0, Math.min(duration - len, view.start + d))
        props.onViewChange({ start, end: start + len })
        return
      }
      const factor = Math.exp(e.deltaY * 0.0015)
      const newLen = Math.max(5, Math.min(duration, len * factor))
      const anchor = view.start + (x / width) * len
      let start = anchor - (x / width) * newLen
      start = Math.max(0, Math.min(duration - newLen, start))
      props.onViewChange({ start, end: start + newLen })
    }
    c.addEventListener("wheel", onWheel, { passive: false })
    return () => c.removeEventListener("wheel", onWheel)
  }, [view, width, duration, props])

  return (
    <div ref={wrap} className="w-full select-none">
      <canvas
        ref={canvas}
        style={{ width: "100%", height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverT(null)}
        aria-label="Timeline: click to seek, drag in the candidate lane to select a range, drag handles to trim, scroll to zoom"
      />
    </div>
  )
}
