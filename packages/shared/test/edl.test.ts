import { describe, expect, it } from "vitest"
import {
  buildEdl,
  computeCuts,
  CutsConfigSchema,
  edlDuration,
  findFillers,
  mapInterval,
  outToSrc,
  srcToOut,
  type CutsConfig,
} from "../src"
import { w } from "./helpers"

const cfg = (over: Partial<CutsConfig> = {}): CutsConfig => ({
  ...CutsConfigSchema.parse({}),
  ...over,
})

describe("computeCuts", () => {
  const words = w("Hello@0-0.4", "there.@0.5-0.9", "So@2.0-2.2", "um@2.3-2.5", "anyway@2.6-3.0")
  const range = { start: 0, end: 3.2 }

  it("removes dead air longer than minGap, keeping padding", () => {
    const cuts = computeCuts(
      words,
      range,
      cfg({ fillers: { enabled: false, words: [], minProb: 0.5 } })
    )
    expect(cuts).toHaveLength(1)
    const c = cuts[0]
    expect(c.kind).toBe("gap")
    expect(c.id).toBe("gap:1")
    expect(c.start).toBeCloseTo(0.98)
    expect(c.end).toBeCloseTo(1.92)
  })

  it("does not cut gaps shorter than minGap", () => {
    const cuts = computeCuts(
      words,
      range,
      cfg({
        deadAir: { enabled: true, minGapMs: 2000, padMs: 80 },
        fillers: { enabled: false, words: [], minProb: 0.5 },
      })
    )
    expect(cuts).toHaveLength(0)
  })

  it("cuts filler words with enough confidence", () => {
    const cuts = computeCuts(
      words,
      range,
      cfg({ deadAir: { enabled: false, minGapMs: 350, padMs: 80 } })
    )
    const filler = cuts.find((c) => c.kind === "filler")
    expect(filler?.id).toBe("filler:3")
    expect(filler?.start).toBeLessThanOrEqual(2.3)
    expect(filler?.end).toBeGreaterThanOrEqual(2.5)
    // never eats into neighbouring words
    expect(filler!.start).toBeGreaterThanOrEqual(2.2)
    expect(filler!.end).toBeLessThanOrEqual(2.6)
  })

  it("skips low-confidence fillers", () => {
    const low = words.map((x) => (x.text === "um" ? { ...x, prob: 0.2 } : x))
    const cuts = computeCuts(
      low,
      range,
      cfg({ deadAir: { enabled: false, minGapMs: 350, padMs: 80 } })
    )
    expect(cuts.find((c) => c.kind === "filler")).toBeUndefined()
  })

  it("marks restored cuts inactive", () => {
    const cuts = computeCuts(words, range, cfg({ restoredCuts: ["gap:1"] }))
    expect(cuts.find((c) => c.id === "gap:1")?.active).toBe(false)
  })

  it("adds manual deletions", () => {
    const cuts = computeCuts(
      words,
      range,
      cfg({
        deadAir: { enabled: false, minGapMs: 350, padMs: 80 },
        fillers: { enabled: false, words: [], minProb: 0.5 },
        deletedWords: [0],
      })
    )
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toMatchObject({ kind: "deleted", id: "word:0", start: 0 })
  })
})

describe("findFillers", () => {
  it("matches multi-word fillers and ambiguous words only with punctuation", () => {
    const words = w(
      "I@0-0.1",
      "like@0.2-0.4",
      "pizza,@0.5-0.8",
      "you@0.9-1.0",
      "know,@1.0-1.2",
      "like,@1.3-1.5",
      "really.@1.6-2"
    )
    const hits = findFillers(
      words,
      words.map((_, i) => i),
      ["like", "you know"],
      0.5
    )
    expect(hits).toEqual([
      [3, 4],
      [5, 5],
    ])
  })
})

describe("buildEdl", () => {
  const cuts = [
    { id: "a", kind: "gap" as const, start: 1, end: 2, label: "", active: true },
    { id: "b", kind: "gap" as const, start: 3, end: 3.5, label: "", active: true },
    { id: "c", kind: "gap" as const, start: 4, end: 4.5, label: "", active: false },
  ]

  it("produces kept segments with cumulative output times", () => {
    const edl = buildEdl({ start: 0, end: 5 }, cuts, 1)
    expect(edl.map((s) => [s.srcStart, s.srcEnd])).toEqual([
      [0, 1],
      [2, 3],
      [3.5, 5],
    ])
    expect(edl.map((s) => [s.outStart, s.outEnd])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3.5],
    ])
    expect(edlDuration(edl)).toBe(3.5)
  })

  it("applies speed to output timing", () => {
    const edl = buildEdl({ start: 0, end: 5 }, cuts, 2)
    expect(edlDuration(edl)).toBeCloseTo(1.75)
    expect(edl[1].outStart).toBeCloseTo(0.5)
  })

  it("merges overlapping cuts and drops slivers", () => {
    const edl = buildEdl(
      { start: 0, end: 4 },
      [
        { id: "x", kind: "gap", start: 1, end: 2, label: "", active: true },
        { id: "y", kind: "filler", start: 1.5, end: 2.5, label: "", active: true },
        { id: "z", kind: "gap", start: 2.53, end: 3, label: "", active: true },
      ],
      1
    )
    expect(edl.map((s) => [s.srcStart, s.srcEnd])).toEqual([
      [0, 1],
      [3, 4],
    ])
  })

  it("never returns an empty edl", () => {
    const edl = buildEdl(
      { start: 10, end: 12 },
      [{ id: "all", kind: "gap", start: 9, end: 13, label: "", active: true }],
      1
    )
    expect(edl).toHaveLength(1)
  })
})

describe("time mapping", () => {
  const edl = buildEdl(
    { start: 10, end: 20 },
    [{ id: "a", kind: "gap", start: 12, end: 15, label: "", active: true }],
    1.25
  )

  it("maps source to output and back", () => {
    expect(srcToOut(edl, 11)).toBeCloseTo(0.8)
    expect(srcToOut(edl, 16)).toBeCloseTo(1.6 + 0.8)
    expect(outToSrc(edl, 0.8)).toBeCloseTo(11)
    expect(outToSrc(edl, 2.4)).toBeCloseTo(16)
  })

  it("handles times inside removed regions", () => {
    expect(srcToOut(edl, 13, "strict")).toBeNull()
    expect(srcToOut(edl, 13, "next")).toBeCloseTo(1.6)
    expect(srcToOut(edl, 13, "prev")).toBeCloseTo(1.6)
  })

  it("maps intervals spanning a cut", () => {
    const m = mapInterval(edl, 11.5, 15.5)
    expect(m?.start).toBeCloseTo(1.2)
    expect(m?.end).toBeCloseTo(2.0)
    expect(mapInterval(edl, 12.5, 14.5)).toBeNull()
  })
})
