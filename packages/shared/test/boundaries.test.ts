import { describe, expect, it } from "vitest"
import { boundaryPieces, rangeFromPieces, sentenceUnits, toSentenceEdges } from "../src"
import { transcriptOf, w } from "./helpers"

// s0: "Hi there." (0–1)  s1: long sentence with a clause break (2–6)  s2: "Short one." (8–9)  s3: "Bye now." (11–12)
const words = w(
  "Hi@0-0.4",
  "there.@0.5-1.0",
  "So@2.0-2.2",
  "when@2.3-2.5",
  "you@2.6-2.8",
  "start,@2.9-3.2",
  "you@3.4-3.6",
  "plan@3.7-4.0",
  "too@4.1-4.3",
  "much.@4.4-6.0",
  "Short@8.0-8.4",
  "one.@8.5-9.0",
  "Bye@11.0-11.4",
  "now.@11.5-12.0"
)
const transcript = transcriptOf(words)

describe("boundary pieces", () => {
  it("lists sentences, splits long ones at clauses, and marks sentence starts/ends", () => {
    const pieces = boundaryPieces(transcript, { start: 1.9, end: 9.2 }, { contextSentences: 1 })
    expect(pieces.map((p) => [p.id, p.text, p.sentenceStart, p.sentenceEnd, p.inside])).toEqual([
      [0, "Hi there.", true, true, false], // context before
      [2, "So when you start,", true, false, true],
      [6, "you plan too much.", false, true, true],
      [10, "Short one.", true, true, true],
      [12, "Bye now.", true, true, false], // context after
    ])
  })

  it("does not split off tiny clauses", () => {
    const t = transcriptOf(w("So,@0-0.2", "this@0.3-0.5", "is@0.6-0.7", "it.@0.8-1.0"))
    expect(boundaryPieces(t, { start: 0, end: 1 }).map((p) => p.text)).toEqual(["So, this is it."])
  })
})

describe("range from pieces", () => {
  const pieces = boundaryPieces(transcript, { start: 1.9, end: 9.2 }, { contextSentences: 1 })
  const opts = { leadInSec: 0.3, tailSec: 0.4, duration: 13 }

  it("starts just before the first word and ends just after the last, never touching neighbours", () => {
    const r = rangeFromPieces(words, pieces, 2, 10 /* "Short one." */, opts)!
    expect(r.start).toBeCloseTo(1.7) // 2.0 - lead-in, after "there." ended at 1.0
    expect(r.end).toBeCloseTo(9.4) // 9.0 + tail, before "Bye" at 11.0
  })

  it("clamps to neighbouring words when they are close", () => {
    const r = rangeFromPieces(words, pieces, 6 /* clause start */, 6, opts)!
    expect(r.start).toBeGreaterThan(words[5].end) // never includes "start,"
    expect(r.start).toBeLessThanOrEqual(words[6].start)
  })

  it("rejects unknown or reversed pieces", () => {
    expect(rangeFromPieces(words, pieces, 99, 10, opts)).toBeNull()
    expect(rangeFromPieces(words, pieces, 10, 2, opts)).toBeNull()
  })
})

describe("sentence detection without punctuation", () => {
  // Whisper sometimes drops punctuation for long stretches but keeps capitals on sentence starts
  const text =
    "it was chaos absolute chaos meetings about meetings ha ha ha it was crazy all day long Then I said we should stop The lesson is simple grow slower than you want to"
  const unpunct = transcriptOf(
    text.split(" ").map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25, prob: 0.9 }))
  )

  it("treats capitalised words as sentence starts in unpunctuated stretches (but not 'I')", () => {
    const units = sentenceUnits(unpunct)
    const starts = units.map((u) => unpunct.words[u.first].text)
    expect(starts).toEqual(["it", "Then", "The"])
    expect(units.every((u) => u.startsSentence && u.endsSentence)).toBe(true)
  })

  it("keeps proper nouns inside punctuated text", () => {
    const t = transcriptOf(
      w("I@0-0.2", "talked@0.3-0.6", "to@0.7-0.8", "John@0.9-1.2", "yesterday.@1.3-1.8")
    )
    expect(sentenceUnits(t)).toHaveLength(1)
  })

  it("flags units split for length as clauses and widens windows to sentence edges", () => {
    // one 30 s sentence with a comma at ~14 s, then a short sentence
    const long = Array.from({ length: 100 }, (_, i) => ({
      text: i === 45 ? "word," : i === 99 ? "end." : "word",
      start: i * 0.3,
      end: i * 0.3 + 0.25,
      prob: 0.9,
    }))
    const units = sentenceUnits(transcriptOf(long))
    expect(units.length).toBeGreaterThan(1)
    expect(units[0]).toMatchObject({ startsSentence: true, endsSentence: false })
    expect(units.at(-1)).toMatchObject({ startsSentence: false, endsSentence: true })
    // a span covering only the first clause widens to the whole sentence when it fits
    expect(toSentenceEdges(units, 0, 0, 60)).toEqual([0, units.length - 1])
    // …but not beyond the length limit
    expect(toSentenceEdges(units, 0, 0, 15)).toEqual([0, 0])
  })
})
