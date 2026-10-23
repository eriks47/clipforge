import type { Word } from "../schemas/media"
import { lastIndexAtOrBefore } from "./util"

export type Edge = "start" | "end"

/**
 * Snap a time to the nearest word boundary. `start` edges snap to word starts (slightly before),
 * `end` edges to word ends (slightly after). Returns t unchanged if no word is within maxDist.
 */
export function snapToWord(
  words: readonly Word[],
  t: number,
  edge: Edge,
  maxDist = 2,
  padSec = 0.05
): number {
  if (words.length === 0) return t
  const i = lastIndexAtOrBefore(words, t, (w) => w.start)
  let best: number | null = null
  let bestDist = Infinity
  for (let k = Math.max(0, i - 2); k <= Math.min(words.length - 1, i + 2); k++) {
    const w = words[k]
    const b = edge === "start" ? w.start : w.end
    const d = Math.abs(b - t)
    if (d < bestDist) {
      bestDist = d
      best = k
    }
  }
  if (best === null || bestDist > maxDist) return t
  const w = words[best]
  if (edge === "start") {
    const prevEnd = best > 0 ? words[best - 1].end : 0
    return Math.max(prevEnd, w.start - padSec, 0)
  }
  const nextStart = best < words.length - 1 ? words[best + 1].start : Infinity
  return Math.min(nextStart, w.end + padSec)
}
