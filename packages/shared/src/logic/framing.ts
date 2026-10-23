import type { FramingConfig, ManualFramingKeyframe } from "../schemas/edit"
import type { FaceBox, FaceSamples } from "../schemas/media"
import type { EdlSegment, FramingPoint } from "../schemas/render"
import { outToSrc } from "./edl"
import { clamp, lastIndexAtOrBefore, lerp, smoothstep } from "./util"

/** A point on a source-time track */
export interface SrcPoint {
  t: number
  cx: number
  cy: number
}

export interface TrackedDetection {
  t: number
  id: number
  cx: number
  cy: number
  area: number
  score: number
}

export const CENTER: Readonly<{ cx: number; cy: number }> = { cx: 0.5, cy: 0.45 }

/** Assign stable identities to faces across samples (nearest-centre matching, reset on scene cuts). */
export function assignIdentities(
  samples: FaceSamples["samples"],
  sceneCuts: readonly number[] = [],
  maxJump = 0.12,
  maxAgeSec = 3
): TrackedDetection[][] {
  let nextId = 0
  let tracks: { id: number; cx: number; cy: number; t: number }[] = []
  const out: TrackedDetection[][] = []
  let prevT = -Infinity
  for (const s of samples) {
    if (sceneCuts.some((c) => c > prevT && c <= s.t)) tracks = []
    prevT = s.t
    tracks = tracks.filter((tr) => s.t - tr.t <= maxAgeSec)
    const faces = s.faces.map((f: FaceBox) => ({
      cx: f.x + f.w / 2,
      cy: f.y + f.h / 2,
      area: f.w * f.h,
      score: f.score,
    }))
    const used = new Set<number>()
    const dets: TrackedDetection[] = []
    // greedy by area so big faces claim their track first
    const order = faces.map((_, i) => i).sort((a, b) => faces[b].area - faces[a].area)
    for (const fi of order) {
      const f = faces[fi]
      let best = -1
      let bestD = maxJump
      for (let k = 0; k < tracks.length; k++) {
        if (used.has(k)) continue
        const d = Math.hypot(tracks[k].cx - f.cx, tracks[k].cy - f.cy)
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
      let id: number
      if (best >= 0) {
        used.add(best)
        id = tracks[best].id
        tracks[best] = { id, cx: f.cx, cy: f.cy, t: s.t }
      } else {
        id = nextId++
        tracks.push({ id, cx: f.cx, cy: f.cy, t: s.t })
        used.add(tracks.length - 1)
      }
      dets.push({ t: s.t, id, cx: f.cx, cy: f.cy, area: f.area, score: f.score })
    }
    out.push(dets)
  }
  return out
}

interface Target extends SrcPoint {
  snap: boolean
  fast: boolean
}

/**
 * Critically damped spring towards a piecewise-constant target.
 * `snap` targets jump immediately (scene cuts); `fast` targets use a quicker spring (speaker switch).
 */
export function smoothTargets(
  targets: readonly Target[],
  cfg: Pick<FramingConfig, "smoothing" | "switchEaseSec">
): SrcPoint[] {
  if (targets.length === 0) return []
  const baseOmega = lerp(14, 1.6, clamp(cfg.smoothing, 0, 1))
  const fastOmega = Math.max(baseOmega, 7 / Math.max(cfg.switchEaseSec, 0.05))
  let x = targets[0].cx
  let y = targets[0].cy
  let vx = 0
  let vy = 0
  let fastUntil = -Infinity
  const out: SrcPoint[] = [{ t: targets[0].t, cx: x, cy: y }]
  for (let i = 1; i < targets.length; i++) {
    const prev = targets[i - 1]
    const cur = targets[i]
    if (cur.snap) {
      x = cur.cx
      y = cur.cy
      vx = 0
      vy = 0
      out.push({ t: cur.t, cx: x, cy: y })
      continue
    }
    if (cur.fast) fastUntil = cur.t + cfg.switchEaseSec * 2
    const total = cur.t - prev.t
    const steps = Math.max(1, Math.ceil(total / (1 / 120)))
    const dt = total / steps
    for (let k = 0; k < steps; k++) {
      const t = prev.t + dt * (k + 1)
      const w = t < fastUntil ? fastOmega : baseOmega
      // semi-implicit critically damped spring
      const ax = w * w * (prev.cx - x) - 2 * w * vx
      const ay = w * w * (prev.cy - y) - 2 * w * vy
      vx += ax * dt
      vy += ay * dt
      x += vx * dt
      y += vy * dt
    }
    out.push({ t: cur.t, cx: x, cy: y })
  }
  // The spring chases the target of the *previous* sample (targets are held until the next sample).
  return out
}

export interface FaceTrackResult {
  /** active-speaker camera */
  primary: SrcPoint[]
  /** split mode: left-most and right-most of the two most prominent speakers (empty if < 2 faces) */
  splitTop: SrcPoint[]
  splitBottom: SrcPoint[]
}

/**
 * Build the camera track: follow the dominant (largest) face, hold through short dropouts,
 * switch speakers only after they dominate for `switchMinSec`, ease switches, hard-cut on scene changes.
 */
export function buildFaceTrack(
  faces: FaceSamples,
  cfg: FramingConfig,
  sceneCuts: readonly number[] = []
): FaceTrackResult {
  const samples = faces.samples
  if (samples.length === 0) return { primary: [], splitTop: [], splitBottom: [] }
  const tracked = assignIdentities(samples, sceneCuts)
  const deadzone = 0.015
  // Never aim at empty space: until the first detection, look ahead to the first face in the clip.
  const firstDets = tracked.find((d) => d.length > 0)
  const firstFace = firstDets?.reduce((a, b) => (b.area * b.score > a.area * a.score ? b : a))

  let active: number | null = null
  /** after a scene cut with no face visible yet, snap (don't glide) to the first face that appears */
  let snapPending = false
  let lastSeen = -Infinity
  let challenger: number | null = null
  let challengerSince = 0
  let prevT = -Infinity
  const targets: Target[] = []
  let cur = firstFace ? { cx: firstFace.cx, cy: firstFace.cy } : { ...CENTER }
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].t
    const dets = tracked[i]
    const cut = sceneCuts.some((c) => c > prevT && c <= t)
    prevT = t
    const dominant = dets.length
      ? dets.reduce((a, b) => (b.area * b.score > a.area * a.score ? b : a))
      : null
    const activeDet = dets.find((d) => d.id === active)
    let snap = false
    let fast = false
    if (cut) {
      active = dominant?.id ?? null
      challenger = null
      snap = dominant !== null
      snapPending = dominant === null
      if (dominant) lastSeen = t
    } else if (activeDet) {
      lastSeen = t
      if (dominant && dominant.id !== active && dominant.area > activeDet.area * 1.3) {
        if (challenger !== dominant.id) {
          challenger = dominant.id
          challengerSince = t
        } else if (t - challengerSince >= cfg.switchMinSec) {
          active = dominant.id
          challenger = null
          fast = true
        }
      } else challenger = null
    } else if (t - lastSeen > cfg.holdDropoutSec || active === null) {
      // active face lost for too long: switch to whoever is visible
      if (dominant) {
        snap = snapPending
        fast = !snapPending && active !== null
        snapPending = false
        active = dominant.id
        lastSeen = t
      }
    }
    const a = dets.find((d) => d.id === active)
    // No face right now: hold the last framed face (never drift to the empty centre of the shot).
    let next = cur
    if (a) next = { cx: a.cx, cy: a.cy }
    if (!snap && !fast && Math.hypot(next.cx - cur.cx, next.cy - cur.cy) < deadzone) next = cur
    cur = next
    targets.push({ t, ...cur, snap: snap || i === 0, fast })
  }
  const primary = smoothTargets(targets, cfg)

  // Split mode: the two identities with the largest total screen presence.
  const totals = new Map<number, number>()
  for (const dets of tracked)
    for (const d of dets) totals.set(d.id, (totals.get(d.id) ?? 0) + d.area)
  const ids = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  if (ids.length >= 2) {
    const follow = (id: number): Target[] => {
      // backfill with this person's first known position rather than the frame centre
      const first = tracked.flat().find((x) => x.id === id)
      let pos: { cx: number; cy: number } | null = first ? { cx: first.cx, cy: first.cy } : null
      const ts: Target[] = []
      for (let i = 0; i < samples.length; i++) {
        const d = tracked[i].find((x) => x.id === id)
        if (d) pos = { cx: d.cx, cy: d.cy }
        ts.push({ t: samples[i].t, ...(pos ?? CENTER), snap: i === 0, fast: false })
      }
      return ts
    }
    // order top/bottom by horizontal position: left speaker on top
    const [a, b] = [ids[0], ids[1]]
    const meanX = (id: number) => {
      let s = 0
      let n = 0
      for (const dets of tracked)
        for (const d of dets)
          if (d.id === id) {
            s += d.cx
            n++
          }
      return n ? s / n : 0.5
    }
    const [top, bottom] = meanX(a) <= meanX(b) ? [a, b] : [b, a]
    return {
      primary,
      splitTop: smoothTargets(follow(top), cfg),
      splitBottom: smoothTargets(follow(bottom), cfg),
    }
  }
  return { primary, splitTop: [], splitBottom: [] }
}

/** True when face samples exist and at least one sample contains a face. */
export function hasFaceDetections(faces: FaceSamples | null | undefined): faces is FaceSamples {
  return !!faces && faces.samples.some((s) => s.faces.length > 0)
}

/** Linear interpolation of a time-sorted track (source or output time). */
export function evalTrack<T extends { t: number; cx: number; cy: number }>(
  track: readonly T[],
  t: number
): { cx: number; cy: number } {
  if (track.length === 0) return { ...CENTER }
  const i = lastIndexAtOrBefore(track, t, (p) => p.t)
  if (i < 0) return { cx: track[0].cx, cy: track[0].cy }
  if (i >= track.length - 1)
    return { cx: track[track.length - 1].cx, cy: track[track.length - 1].cy }
  const a = track[i]
  const b = track[i + 1]
  const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0
  return { cx: lerp(a.cx, b.cx, p), cy: lerp(a.cy, b.cy, p) }
}

/** Manual keyframes eased with smoothstep. */
export function manualTrack(
  keyframes: readonly ManualFramingKeyframe[]
): (t: number) => { cx: number; cy: number } {
  const kfs = [...keyframes].sort((a, b) => a.t - b.t)
  return (t: number) => {
    if (kfs.length === 0) return { ...CENTER }
    const i = lastIndexAtOrBefore(kfs, t, (k) => k.t)
    if (i < 0) return { cx: kfs[0].x, cy: kfs[0].y }
    if (i >= kfs.length - 1) return { cx: kfs[i].x, cy: kfs[i].y }
    const a = kfs[i]
    const b = kfs[i + 1]
    const p = smoothstep((t - a.t) / Math.max(b.t - a.t, 1e-6))
    return { cx: lerp(a.x, b.x, p), cy: lerp(a.y, b.y, p) }
  }
}

/**
 * Re-time a source-time framing function onto the output timeline,
 * sampling every `step` seconds, with exact points at every cut so cuts are hard.
 */
export function resampleToOutput(
  edl: readonly EdlSegment[],
  fn: (srcT: number) => { cx: number; cy: number },
  step = 0.1
): FramingPoint[] {
  const out: FramingPoint[] = []
  for (const seg of edl) {
    const n = Math.max(1, Math.ceil((seg.outEnd - seg.outStart) / step))
    for (let k = 0; k <= n; k++) {
      const t = k === n ? seg.outEnd - 1e-3 : seg.outStart + k * step
      if (t < seg.outStart) continue
      const v = fn(outToSrc(edl, t))
      out.push({
        t: Math.round(t * 1000) / 1000,
        cx: Math.round(v.cx * 1e4) / 1e4,
        cy: Math.round(v.cy * 1e4) / 1e4,
      })
    }
  }
  return out
}

/** Compute the crop window (in source pixels) for a focus point, 9:16 output, cover scaling. */
export function cropFor(
  src: { width: number; height: number },
  out: { width: number; height: number },
  focus: { cx: number; cy: number },
  zoom: number
): { scale: number; left: number; top: number } {
  const scale = Math.max(out.height / src.height, out.width / src.width) * Math.max(zoom, 1)
  const visW = out.width / scale
  const visH = out.height / scale
  const left = clamp(focus.cx * src.width - visW / 2, 0, Math.max(0, src.width - visW))
  const top = clamp(focus.cy * src.height - visH / 2, 0, Math.max(0, src.height - visH))
  return { scale, left, top }
}
