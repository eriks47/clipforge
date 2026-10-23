import type { Spike } from "../schemas/media"
import { clamp, percentile } from "./util"

/** LUFS values at or below this are treated as digital silence */
export const LUFS_FLOOR = -70

/**
 * Map short-term loudness (LUFS) to a 0..1 energy curve using robust percentiles,
 * so a quiet podcast and a loud stream both use the full range.
 */
export function normalizeLoudness(lufs: readonly number[]): number[] {
  const cleaned = lufs.map((v) => (Number.isFinite(v) ? Math.max(v, LUFS_FLOOR) : LUFS_FLOOR))
  const audible = cleaned.filter((v) => v > LUFS_FLOOR + 1)
  if (audible.length === 0) return cleaned.map(() => 0)
  const lo = percentile(audible, 0.05)
  const hi = percentile(audible, 0.995)
  const span = Math.max(hi - lo, 6)
  return cleaned.map((v) => clamp((v - lo) / span, 0, 1))
}

/** Rolling median with a centered window of `win` samples (odd-ized). */
export function rollingMedian(values: readonly number[], win: number): number[] {
  const n = values.length
  const half = Math.max(1, Math.floor(win / 2))
  const out = new Array<number>(n)
  // Sorted window maintained by insertion/removal: O(n * w), fine for w ~ 30-60.
  const window: number[] = []
  const insert = (v: number) => {
    let lo = 0
    let hi = window.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (window[mid] < v) lo = mid + 1
      else hi = mid
    }
    window.splice(lo, 0, v)
  }
  const remove = (v: number) => {
    let lo = 0
    let hi = window.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (window[mid] < v) lo = mid + 1
      else hi = mid
    }
    window.splice(lo, 1)
  }
  let left = 0
  let right = -1
  for (let i = 0; i < n; i++) {
    const wantLeft = Math.max(0, i - half)
    const wantRight = Math.min(n - 1, i + half)
    while (right < wantRight) insert(values[++right])
    while (left < wantLeft) remove(values[left++])
    const m = window.length
    out[i] = m % 2 === 1 ? window[(m - 1) >> 1] : (window[m / 2 - 1] + window[m / 2]) / 2
  }
  return out
}

export interface SpikeOptions {
  /** rolling median window in seconds */
  windowSec: number
  /** energy must be >= median * minRatio */
  minRatio: number
  /** and at least this much above the median (absolute, 0..1 scale) */
  minDelta?: number
  /** minimum distance between reported spikes */
  minGapSec?: number
}

/**
 * Detect local peaks that stand significantly above the rolling median.
 * Often laughter, shouting or reactions.
 */
export function detectSpikes(
  energy: readonly number[],
  hopSec: number,
  opts: SpikeOptions
): Spike[] {
  const n = energy.length
  if (n < 3) return []
  const minDelta = opts.minDelta ?? 0.12
  const minGap = opts.minGapSec ?? 2
  const med = rollingMedian(energy, Math.max(3, Math.round(opts.windowSec / hopSec)))
  const raw: Spike[] = []
  for (let i = 1; i < n - 1; i++) {
    const e = energy[i]
    if (e < energy[i - 1] || e < energy[i + 1]) continue
    const m = med[i]
    if (e - m < minDelta) continue
    if (e < m * opts.minRatio) continue
    const strength = clamp((e - m) / Math.max(1 - m, 0.15), 0, 1)
    raw.push({ t: (i + 0.5) * hopSec, strength })
  }
  // Non-maximum suppression: keep strongest, drop neighbours within minGap.
  raw.sort((a, b) => b.strength - a.strength)
  const kept: Spike[] = []
  for (const s of raw) {
    if (kept.every((k) => Math.abs(k.t - s.t) >= minGap)) kept.push(s)
  }
  return kept.sort((a, b) => a.t - b.t)
}

/** Average a fine-grained series into coarser bins (e.g. 100ms ebur128 frames -> 500ms hops). */
export function binSeries(
  points: readonly { t: number; v: number }[],
  hopSec: number,
  duration: number
): number[] {
  const bins = Math.max(1, Math.ceil(duration / hopSec))
  const sums = new Array<number>(bins).fill(0)
  const counts = new Array<number>(bins).fill(0)
  for (const p of points) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(p.t / hopSec)))
    sums[i] += p.v
    counts[i]++
  }
  let last = LUFS_FLOOR
  return sums.map((s, i) => {
    if (counts[i] === 0) return last
    last = s / counts[i]
    return last
  })
}
