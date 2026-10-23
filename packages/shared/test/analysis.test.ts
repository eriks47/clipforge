import { describe, expect, it } from "vitest"
import {
  CandidateSettingsSchema,
  computeFeatures,
  detectSpikes,
  generateCandidates,
  generateWindows,
  heuristicScore,
  normalizeLoudness,
  rollingMedian,
  ScoreWeightsSchema,
  selectTop,
  snapToWord,
  type AudioAnalysis,
} from "../src"
import { evenWords, transcriptOf, w } from "./helpers"

describe("spike detection", () => {
  it("computes a rolling median", () => {
    expect(rollingMedian([1, 5, 2, 8, 3], 3)).toEqual([3, 2, 5, 3, 5.5])
  })

  it("finds peaks above the rolling median and suppresses neighbours", () => {
    const e = new Array(200).fill(0.3)
    e[50] = 0.9
    e[52] = 0.85 // within minGap of 50 -> suppressed
    e[150] = 0.7
    const spikes = detectSpikes(e, 0.5, { windowSec: 15, minRatio: 1.5, minGapSec: 2 })
    expect(spikes.map((s) => s.t)).toEqual([25.25, 75.25])
    expect(spikes[0].strength).toBeGreaterThan(spikes[1].strength)
  })

  it("ignores small bumps", () => {
    const e = new Array(100).fill(0.5)
    e[30] = 0.55
    expect(detectSpikes(e, 0.5, { windowSec: 10, minRatio: 1.2 })).toEqual([])
  })

  it("normalizes loudness robustly", () => {
    const n = normalizeLoudness([-120, -40, -30, -20, -10, Number.NEGATIVE_INFINITY])
    expect(n[0]).toBe(0)
    expect(n[5]).toBe(0)
    expect(Math.max(...n)).toBeLessThanOrEqual(1)
    expect(n[4]).toBeGreaterThan(n[2])
  })
})

describe("windowing", () => {
  const words = evenWords(400, { sentenceEvery: 10 }) // 160 s of speech
  const transcript = transcriptOf(words)
  const settings = CandidateSettingsSchema.parse({})

  it("snaps windows to sentence boundaries within min/max length", () => {
    const windows = generateWindows({
      transcript,
      analysis: null,
      heatmap: null,
      duration: 165,
      settings,
    })
    expect(windows.length).toBeGreaterThan(5)
    for (const win of windows) {
      const len = win.end - win.start
      expect(len).toBeGreaterThanOrEqual(settings.minSec - 0.01)
      expect(len).toBeLessThanOrEqual(
        settings.maxSec + settings.leadInSec + settings.tailSec + 0.01
      )
      // starts just before a sentence start, ends just after a sentence end
      expect(words[win.firstWord].start - win.start).toBeLessThanOrEqual(settings.leadInSec + 1e-6)
      expect(words[win.lastWord].text.endsWith(".")).toBe(true)
      expect(win.firstWord === 0 || words[win.firstWord - 1].text.endsWith(".")).toBe(true)
      // never cuts into neighbouring words
      if (win.firstWord > 0) expect(win.start).toBeGreaterThan(words[win.firstWord - 1].end)
      if (win.lastWord < words.length - 1)
        expect(win.end).toBeLessThan(words[win.lastWord + 1].start)
    }
  })

  it("falls back to time windows without a transcript", () => {
    const windows = generateWindows({
      transcript: null,
      analysis: null,
      heatmap: null,
      duration: 120,
      settings,
    })
    expect(windows.length).toBeGreaterThan(3)
    expect(windows.every((x) => x.end - x.start >= settings.minSec)).toBe(true)
  })

  it("dedups overlapping windows by IoU keeping the best", () => {
    const items = [
      { start: 0, end: 30, score: 50 },
      { start: 2, end: 32, score: 80 },
      { start: 40, end: 70, score: 60 },
      { start: 100, end: 130, score: 10 },
    ]
    const top = selectTop(items, 10, 0.3)
    expect(top.map((x) => x.score)).toEqual([80, 60, 10])
    expect(selectTop(items, 10, 0.3, [{ start: 40, end: 70 }]).map((x) => x.score)).toEqual([
      80, 10,
    ])
  })

  it("snaps times to word boundaries", () => {
    const ws = w("a@1-1.5", "b@2-2.5", "c@3-3.5")
    expect(snapToWord(ws, 1.9, "start")).toBeCloseTo(1.95)
    expect(snapToWord(ws, 2.6, "end")).toBeCloseTo(2.55)
    expect(snapToWord(ws, 10, "end")).toBe(10)
  })
})

describe("scoring", () => {
  const weights = ScoreWeightsSchema.parse({})
  const hop = 0.5
  const dur = 200
  const n = dur / hop
  const energy = new Array(n).fill(0.25)
  for (let i = 200; i < 260; i++) energy[i] = 0.4 + 0.4 * Math.abs(Math.sin(i)) // lively section 100-130 s
  const analysis: AudioAnalysis = {
    hopSec: hop,
    loudness: energy.map((e) => -40 + e * 30),
    energyNorm: energy,
    spikes: [{ t: 110, strength: 0.8 }],
    silences: [{ start: 150, end: 190 }],
  }
  const words = evenWords(500, { sentenceEvery: 9 })

  it("scores lively, dense windows above silent ones", () => {
    const ctx = {
      transcript: transcriptOf(words.filter((x) => x.start < 150 || x.start > 190)),
      analysis,
      heatmap: null,
      weights,
    }
    const lively = heuristicScore(computeFeatures({ start: 100, end: 130 }, ctx).features, weights)
    const silent = heuristicScore(computeFeatures({ start: 155, end: 185 }, ctx).features, weights)
    expect(lively.score).toBeGreaterThan(silent.score + 15)
    expect(silent.breakdown.silencePenalty).toBeLessThan(0)
    expect(lively.score).toBeLessThanOrEqual(100)
    expect(silent.score).toBeGreaterThanOrEqual(0)
  })

  it("rewards heatmap peaks when present", () => {
    const base = { transcript: transcriptOf(words), analysis, heatmap: null, weights }
    const heat = {
      ...base,
      heatmap: {
        points: [
          { start: 40, end: 70, value: 1 },
          { start: 0, end: 40, value: 0.1 },
        ],
      },
    }
    const r = { start: 40, end: 70 }
    expect(heuristicScore(computeFeatures(r, heat).features, weights).score).toBeGreaterThan(
      heuristicScore(computeFeatures(r, base).features, weights).score
    )
  })

  it("generates ranked, non-overlapping candidates", () => {
    const settings = CandidateSettingsSchema.parse({ topN: 5 })
    const cands = generateCandidates({
      transcript: transcriptOf(words),
      analysis,
      heatmap: null,
      duration: dur,
      settings,
    })
    expect(cands.length).toBe(5)
    for (let i = 1; i < cands.length; i++)
      expect(cands[i - 1].score).toBeGreaterThanOrEqual(cands[i].score)
    expect(cands[0].reason.length).toBeGreaterThan(3)
    expect(cands[0].suggestedHook.split(" ").length).toBeLessThanOrEqual(8)
  })

  it("reserves pool slots for LLM-nominated moments the heuristic would miss", () => {
    const settings = CandidateSettingsSchema.parse({ topN: 4 })
    const base = {
      transcript: transcriptOf(words),
      analysis,
      heatmap: null,
      duration: dur,
      settings,
    }
    const quiet = { start: 5, end: 35 }
    expect(generateCandidates(base).some((c) => c.nominated !== undefined)).toBe(false)

    const cands = generateCandidates({
      ...base,
      nominations: [{ ...quiet, strength: 0.9, why: "great story" }],
    })
    expect(cands.length).toBe(4)
    const nom = cands.find((c) => c.nominated !== undefined)
    expect(nom).toBeDefined()
    expect(nom!.seeds).toContain("llm")
    expect(nom!.nominated).toBe(0.9)
    // snapped to sentence edges near the nominated range
    expect(Math.abs(nom!.start - quiet.start)).toBeLessThan(4)
    expect(Math.abs(nom!.end - quiet.end)).toBeLessThan(4)
  })

  it("trims an over-long nomination to the max length from its start", () => {
    const settings = CandidateSettingsSchema.parse({ topN: 4, maxSec: 40, targetSec: 30 })
    const ws = generateWindows({
      transcript: transcriptOf(words),
      analysis,
      heatmap: null,
      nominations: [{ start: 2, end: 120, strength: 0.8, why: "" }],
      duration: dur,
      settings,
    })
    const nom = ws.filter((x) => x.nominated !== undefined)
    expect(nom.length).toBe(1)
    expect(nom[0].start).toBeLessThan(5)
    expect(nom[0].end - nom[0].start).toBeLessThanOrEqual(40)
  })
})
