import { describe, expect, it } from "vitest"
import {
  buildCaptionPages,
  buildEdl,
  computeCuts,
  CutsConfigSchema,
  retimeWords,
  wordIndicesInRange,
} from "../src"
import { w } from "./helpers"

describe("caption re-timing", () => {
  const words = w(
    "This@0-0.3",
    "is@0.4-0.6",
    "great.@0.7-1.0",
    "Um@2.0-2.2",
    "really@2.3-2.6",
    "great!@2.7-3.0"
  )
  const range = { start: 0, end: 3.1 }
  const cfg = CutsConfigSchema.parse({ deadAir: { minGapMs: 350, padMs: 50 } })
  const cuts = computeCuts(words, range, cfg)
  const idx = wordIndicesInRange(words, range)

  it("shifts words after removed gaps and drops cut fillers", () => {
    const edl = buildEdl(range, cuts, 1)
    const out = retimeWords(words, idx, edl)
    expect(out.map((x) => x.text)).toEqual(["This", "is", "great.", "really", "great!"])
    // gap 1.0..2.0 was removed (pad 50ms) and "Um" (2.0..2.2 + padding) too
    const really = out[3]
    expect(really.start).toBeLessThan(1.3)
    expect(really.start).toBeGreaterThan(1.0)
    expect(really.end - really.start).toBeCloseTo(0.3)
  })

  it("re-times correctly with speed change", () => {
    const edl1 = buildEdl(range, cuts, 1)
    const edl2 = buildEdl(range, cuts, 1.5)
    const a = retimeWords(words, idx, edl1)
    const b = retimeWords(words, idx, edl2)
    for (let i = 0; i < a.length; i++) {
      expect(b[i].start).toBeCloseTo(a[i].start / 1.5)
      expect(b[i].end).toBeCloseTo(a[i].end / 1.5)
    }
  })

  it("applies overrides, hidden and deleted words", () => {
    const edl = buildEdl(range, [], 1)
    const out = retimeWords(words, idx, edl, {
      overrides: { "0": "That" },
      hidden: [1],
      deleted: [2],
    })
    expect(out.map((x) => x.text)).toEqual(["That", "Um", "really", "great!"])
    expect(out[0].start).toBe(0)
  })

  it("marks emphasis words", () => {
    const edl = buildEdl(range, [], 1)
    const out = retimeWords(words, idx, edl)
    expect(out.find((x) => x.text === "great!")?.emphasis).toBe(true)
    expect(out.find((x) => x.text === "is")?.emphasis).toBe(false)
  })
})

describe("caption pages", () => {
  const words = w("one@0-0.2", "two@0.3-0.5", "three@0.6-0.8", "four.@0.9-1.1", "five@3-3.2").map(
    (x) => ({ ...x, emphasis: false })
  )

  it("groups by max words and breaks on sentence ends and pauses", () => {
    const pages = buildCaptionPages(words, { mode: "phrase", maxWords: 3, maxChars: 40 })
    expect(pages.map((p) => p.words.map((x) => x.text).join(" "))).toEqual([
      "one two three",
      "four.",
      "five",
    ])
    // first page holds until the next starts
    expect(pages[0].end).toBeCloseTo(0.9)
    // page before a long pause lingers briefly
    expect(pages[1].end).toBeCloseTo(1.35)
  })

  it("respects max chars", () => {
    const pages = buildCaptionPages(words, { mode: "phrase", maxWords: 10, maxChars: 8 })
    expect(pages[0].words.map((x) => x.text)).toEqual(["one", "two"])
  })

  it("word mode = one word per page", () => {
    const pages = buildCaptionPages(words, { mode: "word", maxWords: 3, maxChars: 40 })
    expect(pages).toHaveLength(5)
  })
})
