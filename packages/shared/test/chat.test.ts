import { describe, expect, it } from "vitest"
import {
  buildChatAnalysis,
  chatSummary,
  chatTokens,
  chatValue,
  computeFeatures,
  generateWindows,
  isReactionMessage,
  parseTwitchVodId,
  ScoreWeightsSchema,
  type ChatMessages,
  rankChatPeaks,
} from "../src"

describe("parseTwitchVodId", () => {
  it("reads VOD ids from Twitch URLs", () => {
    expect(parseTwitchVodId("https://www.twitch.tv/videos/2905320411")).toBe("2905320411")
    expect(parseTwitchVodId("twitch.tv/videos/123?t=1h2m3s")).toBe("123")
    expect(parseTwitchVodId("https://m.twitch.tv/videos/42")).toBe("42")
    expect(parseTwitchVodId("https://www.twitch.tv/xqc/video/77")).toBe("77")
    expect(parseTwitchVodId("https://www.twitch.tv/xqc")).toBeNull()
    expect(parseTwitchVodId("https://youtube.com/watch?v=abc")).toBeNull()
    expect(parseTwitchVodId(null)).toBeNull()
  })
})

describe("isReactionMessage", () => {
  it("spots laughter and hype", () => {
    for (const m of ["KEKW", "LMAOOO", "lol", "OMEGALUL OMEGALUL", "no way", "W", "Pog", "💀"])
      expect(isReactionMessage(m)).toBe(true)
    for (const m of ["what game is this", "hello chat", "wow"])
      expect(isReactionMessage(m)).toBe(false)
  })
})

/** steady chat (2 chatters/s) with a burst of laughter from 300-310 s */
function sampleChat(): ChatMessages {
  const messages: ChatMessages["messages"] = []
  for (let t = 0; t < 600; t++) {
    messages.push([t + 0.1, `u${t % 50}`, "hello"], [t + 0.6, `v${t % 50}`, "what game"])
    if (t >= 300 && t < 310)
      for (let k = 0; k < 15; k++) messages.push([t + k / 15, `fan${k}`, "KEKW"])
  }
  return { source: "twitch", videoId: "1", messages }
}

describe("buildChatAnalysis", () => {
  const chat = buildChatAnalysis(sampleChat(), 600, { lagSec: 4 })

  it("bins messages and finds the burst, shifted back by the chat lag", () => {
    expect(chat.count.length).toBe(600)
    expect(chat.totalMessages).toBe(600 * 2 + 150)
    expect(chat.peaks.length).toBe(1)
    // burst in chat at 300-310 s => moment around 296-306 s
    expect(chat.peaks[0].t).toBeGreaterThan(295)
    expect(chat.peaks[0].t).toBeLessThan(307)
    expect(chat.peaks[0].strength).toBeGreaterThan(0.8)
  })

  it("keeps steady chat near zero activity", () => {
    expect(Math.max(...chat.activity.slice(0, 250))).toBeLessThan(0.1)
  })

  it("scores windows by chat activity", () => {
    expect(chatValue(chat, { start: 290, end: 320 })!).toBeGreaterThan(0.5)
    expect(chatValue(chat, { start: 100, end: 130 })!).toBeLessThan(0.1)
    const weights = ScoreWeightsSchema.parse({})
    const ctx = { transcript: null, analysis: null, heatmap: null, chat, weights }
    expect(computeFeatures({ start: 290, end: 320 }, ctx).features.chat).toBeGreaterThan(0.5)
  })

  it("seeds candidate windows at chat peaks", () => {
    const w = generateWindows({
      transcript: null,
      analysis: null,
      heatmap: null,
      chat,
      duration: 600,
      settings: {
        minSec: 15,
        maxSec: 60,
        targetSec: 30,
        leadInSec: 0.3,
        tailSec: 0.4,
        slidingStepSec: 1000,
      },
    })
    const seeded = w.filter((x) => x.seeds.includes("chat"))
    expect(seeded.length).toBeGreaterThan(0)
    expect(seeded.some((x) => x.start <= 300 && x.end >= 305)).toBe(true)
  })

  it("finds emote waves even when the message rate stays flat (slow-mode chats)", () => {
    const messages: ChatMessages["messages"] = []
    for (let t = 0; t < 900; t++)
      for (let k = 0; k < 10; k++) {
        const wave = t >= 500 && t < 515 && k < 7
        messages.push([t + k / 10, `u${(t * 10 + k) % 400}`, wave ? "WWWW" : `m${t}x${k}`])
      }
    const a = buildChatAnalysis({ source: "twitch", videoId: "2", messages }, 900)
    expect(Math.max(...a.count)).toBe(10)
    expect(a.peaks.length).toBe(1)
    expect(a.peaks[0].t).toBeGreaterThan(494)
    expect(a.peaks[0].t).toBeLessThan(515)
  })

  it("normalizes chat tokens", () => {
    expect(chatTokens("WWWWW @someone LMAOOOOO!!")).toEqual(["ww", "lmaoo"])
    expect(chatTokens("the 🔥🔥🔥")).toEqual(["🔥🔥"])
  })

  it("summarizes what chat said in a window", () => {
    const s = chatSummary(sampleChat(), { start: 296, end: 306 }, 4, 600)!
    expect(s).toContain('"KEKW" ×150')
    expect(s).toMatch(/×/)
    expect(chatSummary(sampleChat(), { start: 700, end: 710 }, 4, 600)).toBeNull()
  })
})

describe("rankChatPeaks", () => {
  it("breaks strength ties by message volume, not by time", () => {
    const count = new Array<number>(100).fill(0)
    for (let i = 75; i <= 85; i++) count[i] = 5 // busy around t=80
    count[10] = 1
    const ranked = rankChatPeaks({
      hopSec: 1,
      count,
      peaks: [
        { t: 10, strength: 1 },
        { t: 50, strength: 0.6 },
        { t: 80, strength: 1 },
      ],
    })
    expect(ranked.map((p) => p.t)).toEqual([80, 10, 50])
  })
})
