import { describe, expect, it } from "vitest"
import {
  buildMomentTracks,
  CandidateSettingsSchema,
  climaxScore,
  endAfterClimax,
  computeFeatures,
  generateCandidates,
  heuristicScore,
  momentTags,
  peakValue,
  relativeSalience,
  ScoreWeightsSchema,
  suggestWeights,
  trackPeaks,
  type AudioAnalysis,
  type AudioSignals,
  type VisualSignals,
  type WindowFeatures,
} from "../src"
import { evenWords, transcriptOf } from "./helpers"

const hop = 0.5
const dur = 300
const n = dur / hop

/** Flat background with bumps: [startSec, endSec, value] */
function track(base: number, bumps: [number, number, number][] = []): number[] {
  const xs = new Array<number>(n).fill(base)
  for (const [a, b, v] of bumps) for (let i = a / hop; i < b / hop; i++) xs[i] = v
  return xs
}

function signals(over: Partial<AudioSignals["tracks"]> = {}): AudioSignals {
  return {
    version: 1,
    hopSec: hop,
    duration: dur,
    models: {},
    tracks: {
      laughter: track(0.002, [[100, 104, 0.3]]),
      crowd: track(0.001),
      shout: track(0.001),
      gasp: track(0.001),
      singing: track(0.001),
      music: track(0.05),
      danceMusic: track(0.01),
      speech: track(0.85),
      arousal: track(0.45, [[200, 210, 0.85]]),
      voiced: track(0.6),
      pitch: track(22, [[200, 210, 28]]),
      pitchHi: track(25, [[200, 210, 33]]),
      effort: track(-12, [[200, 210, -4]]),
      ...over,
    },
  }
}

describe("moment tracks", () => {
  it("normalizes against the video's own distribution, with a noise floor", () => {
    const s = relativeSalience(track(0.001, [[10, 12, 0.08]]), 0.06)
    expect(Math.max(...s)).toBe(1)
    expect(s[0]).toBe(0)
    // a video with no laughter: tiny wiggles stay small instead of being stretched to 1
    const quiet = relativeSalience(track(0.001, [[10, 12, 0.01]]), 0.06)
    expect(Math.max(...quiet)).toBeLessThan(0.2)
  })

  it("marks laughter and an excited voice where they happen", () => {
    const tr = buildMomentTracks(signals(), null, dur)!
    expect(Math.max(...tr.laughter.slice(200, 208))).toBe(1)
    expect(Math.max(...tr.laughter.slice(0, 150))).toBe(0)
    expect(Math.max(...tr.excitement.slice(400, 420))).toBeGreaterThan(0.5)
    expect(Math.max(...tr.excitement.slice(0, 300))).toBeLessThan(0.1)
    expect(Math.max(...tr.pitch.slice(400, 420))).toBeGreaterThan(0.5)
    const peaks = trackPeaks(tr, "laughter")
    expect(peaks.length).toBe(1)
    expect(peaks[0].t).toBeGreaterThan(99)
    expect(peaks[0].t).toBeLessThan(105)
    const tags = momentTags(tr, { start: 90, end: 120 })
    expect(tags.map((t) => t.text)).toEqual(["strong laughter"])
  })

  it("doesn't count singing as an excited speaking voice", () => {
    const sung = signals({
      singing: track(0.001, [[200, 210, 0.8]]),
      speech: track(0.85, [[200, 210, 0.1]]),
    })
    const tr = buildMomentTracks(sung, null, dur)!
    expect(Math.max(...tr.excitement.slice(400, 420))).toBeLessThan(0.2)
    expect(Math.max(...tr.dance.slice(400, 420))).toBeGreaterThan(0.6)
  })

  it("needs X-CLIP, music and motion together for a strong dance score", () => {
    const visual: VisualSignals = {
      version: 1,
      hopSec: hop,
      duration: dur,
      motion: track(0.03, [[50, 70, 0.15]]),
      cut: track(0),
      dance: track(0.15, [
        [50, 70, 0.85],
        [150, 170, 0.85],
      ]),
      model: "x",
    }
    // music only during the first dance-looking stretch
    const s = signals({ music: track(0.05, [[50, 70, 0.9]]) })
    const tr = buildMomentTracks(s, visual, dur)!
    expect(peakValue(tr.dance.slice(100, 140))).toBeGreaterThan(0.8)
    // looks like dancing but silent and still: weak
    expect(peakValue(tr.dance.slice(300, 340))).toBeLessThan(0.35)
    expect(Math.max(...tr.dance.slice(500, 560))).toBe(0)
  })

  it("peakValue keeps a short spike instead of averaging it away", () => {
    const slice = new Array(120).fill(0)
    slice[60] = 1
    slice[61] = 1
    expect(peakValue(slice)).toBeGreaterThan(0.7)
  })
})

describe("peak-aware scoring", () => {
  const weights = ScoreWeightsSchema.parse({})
  const base: WindowFeatures = {
    energyPeak: 0.5,
    energyVariance: 0.5,
    heatmap: null,
    chat: null,
    speechDensity: 0.6,
    deadAir: 0.8,
    hook: 0.5,
    cleanEnding: 0.5,
    climax: 0.5,
    reactions: 0.5,
    laughter: 0.5,
    crowd: 0.5,
    excitement: 0.5,
    pitch: 0.5,
    dance: 0.5,
    silencePenalty: 0,
    lowConfidencePenalty: 0,
  }
  // one huge laugh, everything else quiet
  const spiky: WindowFeatures = {
    ...base,
    energyPeak: 0.3,
    energyVariance: 0.2,
    reactions: 0.1,
    laughter: 1,
    crowd: 0.1,
    excitement: 0.3,
    pitch: 0.1,
    dance: 0,
  }

  it("p = 1 is the plain weighted mean (old behaviour)", () => {
    expect(heuristicScore(spiky, weights, 1).score).toBeLessThan(
      heuristicScore(base, weights, 1).score
    )
  })

  it("p > 1 lets one strong signal beat uniformly middling ones", () => {
    expect(heuristicScore(spiky, weights, 3).score).toBeGreaterThan(
      heuristicScore(base, weights, 3).score
    )
  })

  it("music with dancing is not penalized as music-only filler", () => {
    const words = evenWords(40, { start: 0 }) // speech only at the start
    const music = track(0.9)
    const analysis: AudioAnalysis = {
      hopSec: hop,
      loudness: music.map(() => -14),
      energyNorm: music.map(() => 0.7),
      spikes: [],
      silences: [],
    }
    const visual: VisualSignals = {
      version: 1,
      hopSec: hop,
      duration: dur,
      motion: track(0.03, [[100, 140, 0.2]]),
      cut: track(0),
      dance: track(0.1, [[100, 140, 0.9]]),
      model: "x",
    }
    const ctx = {
      transcript: transcriptOf(words),
      analysis,
      heatmap: null,
      weights,
      moments: buildMomentTracks(signals({ music }), visual, dur),
    }
    const dancing = computeFeatures({ start: 105, end: 135 }, ctx).features
    const filler = computeFeatures({ start: 200, end: 230 }, ctx).features
    expect(dancing.dance).toBeGreaterThan(0.8)
    expect(dancing.silencePenalty).toBeLessThan(0.1)
    expect(filler.silencePenalty).toBeGreaterThan(0.5)
  })

  it("finds the laugh and the dance as candidates, with time windows for wordless dancing", () => {
    // speech everywhere except a wordless 100 s stretch with a dance in it
    const words = evenWords(700, { sentenceEvery: 9 }).filter((x) => x.start < 150 || x.start > 250)
    const energy = track(0.4)
    const analysis: AudioAnalysis = {
      hopSec: hop,
      loudness: energy.map(() => -20),
      energyNorm: energy,
      spikes: [],
      silences: [],
    }
    const visual: VisualSignals = {
      version: 1,
      hopSec: hop,
      duration: dur,
      motion: track(0.03, [[170, 230, 0.2]]),
      cut: track(0),
      dance: track(0.1, [[170, 230, 0.9]]),
      model: "x",
    }
    const cands = generateCandidates({
      transcript: transcriptOf(words),
      analysis,
      heatmap: null,
      signals: signals({ music: track(0.05, [[160, 240, 0.9]]) }),
      visual,
      duration: dur,
      settings: CandidateSettingsSchema.parse({ topN: 4 }),
    })
    const covers = (t: number) => cands.some((c) => c.start <= t && c.end >= t)
    expect(covers(102)).toBe(true) // the laugh
    expect(covers(200)).toBe(true) // the dance
    const dance = cands.find((c) => c.start <= 200 && c.end >= 200)!
    expect(dance.seeds).toContain("dance")
    expect(dance.category).toBe("performance")
    const laugh = cands.find((c) => c.start <= 102 && c.end >= 102)!
    expect(laugh.category).toBe("funny")
  })
})

describe("weight learning", () => {
  const weights = ScoreWeightsSchema.parse({})
  it("needs enough decisions of each kind", () => {
    const r = suggestWeights([{ breakdown: { laughter: 90 }, label: 1 }], weights)
    expect(r.weights).toBeNull()
    expect(r.message).toMatch(/at least/)
  })

  it("raises weights of features that separate approvals from skips", () => {
    const samples = Array.from({ length: 40 }, (_, i) => {
      const label = (i % 2) as 0 | 1
      return {
        label,
        breakdown: {
          laughter: label ? 70 + (i % 7) * 4 : 10 + (i % 5) * 4,
          deadAir: 60 + (i % 9) * 4, // unrelated to the decision
          energyPeak: label ? 40 + (i % 3) : 80 + (i % 4), // approvals are calmer
        },
      }
    })
    const r = suggestWeights(samples, weights)
    expect(r.weights).not.toBeNull()
    expect(r.weights!.laughter).toBeGreaterThan(weights.laughter)
    expect(r.weights!.energyPeak).toBeLessThan(weights.energyPeak)
    expect(Math.abs(r.weights!.deadAir - weights.deadAir)).toBeLessThanOrEqual(0.2)
  })
})

describe("hook - progress - climax", () => {
  const weights = ScoreWeightsSchema.parse({})
  const energy = track(0.3, [[140, 143, 0.95]]) // one big moment at 140 s
  const analysis: AudioAnalysis = {
    hopSec: hop,
    loudness: energy.map((e) => -40 + e * 30),
    energyNorm: energy,
    spikes: [{ t: 141, strength: 0.9 }],
    silences: [],
  }
  const ctx = { transcript: null, analysis, heatmap: null, weights }

  it("rewards windows whose big moment lands near the end", () => {
    const late = climaxScore({ start: 110, end: 145 }, ctx)!
    const early = climaxScore({ start: 137, end: 172 }, ctx)!
    const longTail = climaxScore({ start: 100, end: 175 }, ctx)!
    expect(late).toBeGreaterThan(0.8)
    expect(early).toBeLessThan(0.1)
    expect(longTail).toBeLessThan(late)
  })

  it("trims a nominated moment to end shortly after its climax", () => {
    const units = Array.from({ length: 12 }, (_, i) => ({ start: i * 4, end: i * 4 + 3.5 }))
    // hook at 0, climax at unit 6 (24-27.5 s), model ended at unit 11 (47.5 s)
    expect(endAfterClimax(units, 0, 6, 11, { maxTailSec: 5 })).toBe(7)
    // too short after trimming: keep the model's end
    expect(endAfterClimax(units, 0, 6, 11, { maxTailSec: 5, minSec: 40 })).toBe(11)
    // climax outside the range: unchanged
    expect(endAfterClimax(units, 2, 1, 11)).toBe(11)
  })
})
