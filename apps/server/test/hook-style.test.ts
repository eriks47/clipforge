import { describe, expect, it } from "vitest"
import { buildHookPassPrompt, buildRankPrompt, hooksPrompt } from "../src/llm"
import {
  cleanHook,
  hookStyleGuide,
  loadHookExamples,
  parseHookExample,
} from "../src/llm/hook-style"

describe("hook style", () => {
  it("loads the example hooks, skipping comments and blank lines", () => {
    const ex = loadHookExamples()
    expect(ex.length).toBeGreaterThanOrEqual(10)
    expect(ex.every((e) => !e.hook.startsWith("#"))).toBe(true)
    expect(ex.map((e) => e.hook)).toContain("<Name> was DONE")
  })

  it("parses optional [tag] and `moment =>` parts", () => {
    expect(parseHookExample("<Name> was DONE")).toEqual({ hook: "<Name> was DONE" })
    expect(parseHookExample("[Reaction] loses the final round => <Name> was DONE")).toEqual({
      hook: "<Name> was DONE",
      moment: "loses the final round",
      tag: "reaction",
    })
    expect(parseHookExample("# comment")).toBeNull()
    expect(parseHookExample("   ")).toBeNull()
  })

  it("puts the examples into every hook-writing prompt, but not into ranking", () => {
    const guide = hookStyleGuide()
    expect(guide).toContain("<Name>'s smile INSTANTLY faded")
    expect(hooksPrompt({ transcript: "hi", current: "", videoTitle: "Ep 4 with Sam" })).toContain(
      guide
    )
    expect(
      buildHookPassPrompt({
        videoTitle: "v",
        clips: [{ id: "a", category: "funny", reason: "r", transcript: "t" }],
      })
    ).toContain(guide)
    expect(
      buildRankPrompt({ videoTitle: "v", minSec: 15, maxSec: 60, candidates: [] })
    ).not.toContain(guide)
  })

  it("shows moments and tags when the examples have them", () => {
    const g = hookStyleGuide([{ hook: "<Name> was DONE", moment: "loses again", tag: "fail" }])
    expect(g).toContain("- [fail] loses again => <Name> was DONE")
    expect(g).toContain("tagged by type")
  })

  it("passes the people list to hook prompts", () => {
    expect(
      hooksPrompt({ transcript: "hi", current: "", people: "Aishah: the streamer, she/her" })
    ).toContain("Aishah: the streamer, she/her")
  })

  it("survives a missing examples file", () => {
    expect(loadHookExamples("/nonexistent/hooks.md")).toEqual([])
    expect(hookStyleGuide([])).not.toContain("Examples")
  })

  it("cleans hooks to the house style or rejects them", () => {
    expect(cleanHook('"Sam was VISIBLY UPSET after losing."')).toBe(
      "Sam was VISIBLY UPSET after losing"
    )
    expect(cleanHook("Sam was upset")).toBeNull() // no caps emphasis
    expect(cleanHook("SAM WAS UPSET")).toBeNull() // all caps
    expect(cleanHook("Was Sam REALLY upset?")).toBeNull() // a question
    expect(cleanHook("Sam was DONE #shorts")).toBeNull()
    expect(cleanHook("Sam was DONE 😭")).toBeNull()
    expect(cleanHook("Sam said one two three four five six seven eight nine ten ELEVEN")).toBeNull()
  })
})
