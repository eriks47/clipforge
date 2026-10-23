import { describe, expect, it } from "vitest"
import {
  buildClipRenderProps,
  defaultEditConfig,
  hookTextWithEmoji,
  isEmoji,
  keywordEmoji,
  resolveFontWeight,
  splitEmojis,
} from "../src"
import { transcriptOf, w } from "./helpers"

describe("emoji helpers", () => {
  it("validates emoji strings", () => {
    expect(isEmoji("🔥")).toBe(true)
    expect(isEmoji("❤️")).toBe(true)
    expect(isEmoji("👩‍💻")).toBe(true)
    expect(isEmoji("fire")).toBe(false)
    expect(isEmoji("🔥 fire")).toBe(false)
    expect(isEmoji("")).toBe(false)
    expect(isEmoji("1")).toBe(false)
  })

  it("adds the hook emoji at the chosen side, with keyword fallback", () => {
    const hook = {
      text: "Charge more money",
      emoji: true,
      emojiPick: "🤑",
      emojiPosition: "end" as const,
    }
    expect(hookTextWithEmoji(hook)).toBe("Charge more money 🤑")
    expect(hookTextWithEmoji({ ...hook, emojiPosition: "start" })).toBe("🤑 Charge more money")
    expect(hookTextWithEmoji({ ...hook, emojiPick: "" })).toBe("Charge more money 💰")
    expect(hookTextWithEmoji({ ...hook, emoji: false })).toBe("Charge more money")
    expect(keywordEmoji("nothing here")).toBeNull()
  })

  it("supports several hook emojis, on both sides", () => {
    expect(splitEmojis("🔥😂 👩‍💻❤️")).toEqual(["🔥", "😂", "👩‍💻", "❤️"])
    expect(isEmoji("🔥😂💀")).toBe(true)
    const hook = {
      text: "Wait for it",
      emoji: true,
      emojiPick: "🚨 👀",
      emojiPosition: "both" as const,
    }
    expect(hookTextWithEmoji(hook)).toBe("🚨👀 Wait for it 🚨👀")
    expect(hookTextWithEmoji({ ...hook, emojiPosition: "end" })).toBe("Wait for it 🚨👀")
  })
})

describe("font weights", () => {
  it("uses the font default for 0 and snaps to the nearest bundled weight", () => {
    expect(resolveFontWeight("TikTok Sans", 0)).toBe(800)
    expect(resolveFontWeight("TikTok Sans", 300)).toBe(300)
    expect(resolveFontWeight("Montserrat", 300)).toBe(400)
    expect(resolveFontWeight("Anton", 900)).toBe(400)
  })
})

describe("emoji in render props", () => {
  const words = w(
    "We@0-0.3",
    "made@0.4-0.7",
    "money.@0.8-1.2",
    "Then@2-2.3",
    "it@2.4-2.6",
    "burned.@2.7-3.1"
  )
  const base = () => {
    const config = defaultEditConfig()
    config.cuts.deadAir.enabled = false
    config.cuts.fillers.enabled = false
    config.hook.text = "We got rich"
    return config
  }
  const build = (config: ReturnType<typeof defaultEditConfig>) =>
    buildClipRenderProps({
      range: { start: 0, end: 3.2 },
      config,
      transcript: transcriptOf(words),
      analysis: null,
      faces: null,
      scenes: null,
      probe: { width: 1920, height: 1080, fps: 30 },
      video: { src: "x.mp4", fileOffset: 0, width: 1280, height: 720 },
    })
  const pageEmojis = (p: ReturnType<typeof build>) =>
    p.captions.pages.map((pg) => pg.words.find((x) => x.emoji)?.emoji ?? null)

  it("shows no emojis when the settings are off", () => {
    const p = build(base())
    expect(pageEmojis(p)).toEqual([null, null])
    expect(p.hook.text).toBe("We got rich")
  })

  it("uses keyword matching when no LLM picks exist", () => {
    const c = base()
    c.captions.emoji = true
    c.hook.emoji = true
    const p = build(c)
    expect(pageEmojis(p)).toEqual(["💰", null])
    expect(p.hook.text).toBe("We got rich 💰")
  })

  it("uses only the LLM picks when present (on the line containing the picked word)", () => {
    const c = base()
    c.captions.emoji = true
    c.captions.emojiPicks = { "3": "🔥" } // "Then" starts the second line
    c.hook.emoji = true
    c.hook.emojiPick = "🚀"
    const p = build(c)
    expect(pageEmojis(p)).toEqual([null, "🔥"])
    expect(p.hook.text).toBe("We got rich 🚀")
  })

  it("caps caption emoji frequency at render time", () => {
    const c = base()
    c.captions.emoji = true
    // picks on both lines, which start at 0 s and 2 s
    c.captions.emojiPicks = { "0": "💰", "3": "🔥" }
    c.captions.emojiEverySec = 1
    expect(pageEmojis(build(c))).toEqual(["💰", "🔥"])
    c.captions.emojiEverySec = 5
    expect(pageEmojis(build(c))).toEqual(["💰", null])
  })
})

describe("whole-video hook", () => {
  it("keeps the hook until the end and remembers the normal duration", () => {
    const config = defaultEditConfig()
    config.cuts.deadAir.enabled = false
    config.hook.text = "Stay with me"
    const props = (cfg: typeof config) =>
      buildClipRenderProps({
        range: { start: 0, end: 20 },
        config: cfg,
        transcript: null,
        analysis: null,
        faces: null,
        scenes: null,
        probe: { width: 1920, height: 1080, fps: 30 },
        video: { src: "x.mp4", fileOffset: 0, width: 1280, height: 720 },
      })
    const normal = props(config)
    expect(normal.hook.end).toBeCloseTo(3)
    config.hook.wholeVideo = true
    const whole = props(config)
    expect(whole.hook.end).toBeCloseTo(whole.durationInFrames / whole.fps, 1)
    expect(config.hook.durationSec).toBe(3)
  })
})
