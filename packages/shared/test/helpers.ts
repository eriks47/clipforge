import type { Transcript, Word } from "../src"

/** Build words from "text@start-end" specs, e.g. w("Hello@0-0.4", "world.@0.5-0.9") */
export function w(...specs: string[]): Word[] {
  return specs.map((s) => {
    const [text, times] = s.split("@")
    const [start, end] = times.split("-").map(Number)
    return { text, start, end, prob: 0.95 }
  })
}

/** Evenly spaced words: n words of `dur` seconds separated by `gap`. Every `sentenceEvery` word ends with ". " */
export function evenWords(
  n: number,
  opts: { start?: number; dur?: number; gap?: number; sentenceEvery?: number } = {}
): Word[] {
  const { start = 0, dur = 0.3, gap = 0.1, sentenceEvery = 8 } = opts
  const out: Word[] = []
  let t = start
  for (let i = 0; i < n; i++) {
    const end = (i + 1) % sentenceEvery === 0
    out.push({ text: `word${i}${end ? "." : ""}`, start: t, end: t + dur, prob: 0.9 })
    t += dur + gap
  }
  return out
}

export function transcriptOf(words: Word[]): Transcript {
  return {
    language: "en",
    words,
    segments: [
      {
        id: 0,
        text: words.map((x) => x.text).join(" "),
        start: words[0]?.start ?? 0,
        end: words.at(-1)?.end ?? 0,
        wordIdxStart: 0,
        wordIdxEnd: words.length - 1,
      },
    ],
  }
}
