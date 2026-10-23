import type { ScoreWeights } from "../schemas/candidate"
import { clamp, mean, std } from "./util"

export interface WeightSample {
  /** the candidate's score breakdown (features 0..100, penalties negative) */
  breakdown: Record<string, number>
  /** 1 = approved, 0 = rejected / skipped */
  label: 0 | 1
}

export interface WeightSuggestion {
  positives: number
  negatives: number
  /** null when there isn't enough data to fit */
  weights: ScoreWeights | null
  changes: { key: keyof ScoreWeights; from: number; to: number; coef: number }[]
  message: string
}

export const MIN_SAMPLES_PER_CLASS = 8

/**
 * Fit an L2-regularized logistic regression of approve/reject on the score breakdown and turn its
 * standardized coefficients into gentle weight multipliers (e^(±0.5·coef), at most ~2x per fit):
 * features that separate what you approve from what you skip gain weight, ones that don't lose
 * some. Features present in fewer than half the samples are left alone.
 */
export function suggestWeights(
  samples: readonly WeightSample[],
  current: ScoreWeights
): WeightSuggestion {
  const positives = samples.filter((s) => s.label === 1).length
  const negatives = samples.length - positives
  const empty = (message: string): WeightSuggestion => ({
    positives,
    negatives,
    weights: null,
    changes: [],
    message,
  })
  if (positives < MIN_SAMPLES_PER_CLASS || negatives < MIN_SAMPLES_PER_CLASS)
    return empty(
      `Need at least ${MIN_SAMPLES_PER_CLASS} approved and ${MIN_SAMPLES_PER_CLASS} rejected/skipped candidates (have ${positives} and ${negatives}).`
    )

  const keys = (Object.keys(current) as (keyof ScoreWeights)[]).filter(
    (k) => samples.filter((s) => typeof s.breakdown[k] === "number").length >= samples.length / 2
  )
  if (keys.length === 0) return empty("No features in common across the decisions.")
  // design matrix: |value| / 100, missing = column mean; then standardize
  const raw = keys.map((k) => samples.map((s) => Math.abs(s.breakdown[k] ?? NaN) / 100))
  const cols = raw.map((col) => {
    const present = col.filter((v) => Number.isFinite(v))
    const m = mean(present)
    const filled = col.map((v) => (Number.isFinite(v) ? v : m))
    const sd = std(filled)
    return { m, sd, x: filled.map((v) => (sd > 1e-6 ? (v - m) / sd : 0)) }
  })
  const n = samples.length
  const y = samples.map((s) => s.label)
  // class-balanced weights so a pile of skipped candidates doesn't swamp the approvals
  const sw = y.map((l) => (l === 1 ? n / (2 * positives) : n / (2 * negatives)))
  const beta = new Array<number>(keys.length).fill(0)
  let b0 = 0
  const lambda = 0.5
  const lr = 0.3
  for (let iter = 0; iter < 800; iter++) {
    const g = new Array<number>(keys.length).fill(0)
    let g0 = 0
    for (let i = 0; i < n; i++) {
      let z = b0
      for (let j = 0; j < keys.length; j++) z += beta[j] * cols[j].x[i]
      const err = (1 / (1 + Math.exp(-z)) - y[i]) * sw[i]
      g0 += err
      for (let j = 0; j < keys.length; j++) g[j] += err * cols[j].x[i]
    }
    b0 -= (lr * g0) / n
    for (let j = 0; j < keys.length; j++) beta[j] -= lr * (g[j] / n + (lambda * beta[j]) / n)
  }

  const weights = { ...current }
  const changes: WeightSuggestion["changes"] = []
  keys.forEach((k, j) => {
    if (cols[j].sd <= 1e-6) return
    // penalties are stored as negative contributions: a positive coef on |penalty| = more approvals
    const isPenalty = samples.some((s) => (s.breakdown[k] ?? 0) < 0)
    const coef = isPenalty ? -beta[j] : beta[j]
    const mult = Math.exp(clamp(coef, -1.4, 1.4) * 0.5)
    const from = current[k]
    const to = Math.round(clamp(from * mult, 0, 3) * 10) / 10
    weights[k] = to
    if (to !== from) changes.push({ key: k, from, to, coef: Math.round(coef * 100) / 100 })
  })
  changes.sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef))
  return {
    positives,
    negatives,
    weights,
    changes,
    message: changes.length
      ? `Fitted on ${positives} approved and ${negatives} rejected/skipped candidates.`
      : "Your decisions agree with the current weights.",
  }
}
