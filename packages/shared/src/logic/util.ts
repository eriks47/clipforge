import type { TimeRange } from "../schemas/media"

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

export function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let s = 0
  for (const x of xs) s += (x - m) * (x - m)
  return Math.sqrt(s / xs.length)
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = clamp((sorted.length - 1) * p, 0, sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lerp(sorted[lo], sorted[hi], idx - lo)
}

export function overlap(a: TimeRange, b: TimeRange): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

export function iou(a: TimeRange, b: TimeRange): number {
  const inter = overlap(a, b)
  if (inter <= 0) return 0
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start)
  return union > 0 ? inter / union : 0
}

/** Merge overlapping/touching ranges. Returns a new sorted array. */
export function mergeRanges(ranges: readonly TimeRange[], touchEps = 1e-6): TimeRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.start - b.start)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + touchEps) last.end = Math.max(last.end, r.end)
    else out.push(r)
  }
  return out
}

/** Fraction of `range` covered by the union of `ranges`. */
export function coverage(range: TimeRange, ranges: readonly TimeRange[]): number {
  const len = range.end - range.start
  if (len <= 0) return 0
  let covered = 0
  for (const r of mergeRanges(ranges)) covered += overlap(range, r)
  return clamp(covered / len, 0, 1)
}

/** Index of the last element with key(el) <= t, or -1. Array must be sorted by key. */
export function lastIndexAtOrBefore<T>(
  arr: readonly T[],
  t: number,
  key: (el: T) => number
): number {
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (key(arr[mid]) <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}' ]+/gu, "")
    .trim()
}

export const round = (v: number, digits = 3): number => {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
