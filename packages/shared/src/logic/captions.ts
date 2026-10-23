import type { CaptionConfig } from "../schemas/edit"
import type { Spike, Word } from "../schemas/media"
import type { CaptionPage, CaptionWord, EdlSegment } from "../schemas/render"
import { mapInterval } from "./edl"

export interface RetimeOptions {
  overrides?: Record<string, string>
  hidden?: readonly number[]
  deleted?: readonly number[]
  /** source-time spikes; words on a spike are marked as emphasis */
  spikes?: readonly Spike[]
}

const EMPHASIS_RE = /(!|\?$|^\d|^[A-Z]{2,}[.!?,]*$)/

/** Re-time transcript words (by global index) onto the output timeline. */
export function retimeWords(
  words: readonly Word[],
  indices: readonly number[],
  edl: readonly EdlSegment[],
  opts: RetimeOptions = {}
): (CaptionWord & { idx: number })[] {
  const hidden = new Set(opts.hidden ?? [])
  const deleted = new Set(opts.deleted ?? [])
  const out: (CaptionWord & { idx: number })[] = []
  for (const i of indices) {
    if (hidden.has(i) || deleted.has(i)) continue
    const w = words[i]
    const mapped = mapInterval(edl, w.start, w.end)
    if (!mapped) continue
    // Drop words that lost most of their audio to a cut.
    if (mapped.end - mapped.start < 0.04) continue
    const text = (opts.overrides?.[String(i)] ?? w.text).trim()
    if (!text) continue
    const onSpike = (opts.spikes ?? []).some(
      (s) => s.t >= w.start - 0.2 && s.t <= w.end + 0.2 && s.strength > 0.4
    )
    out.push({
      idx: i,
      text,
      start: mapped.start,
      end: mapped.end,
      emphasis: onSpike || EMPHASIS_RE.test(text),
    })
  }
  return out
}

const SENTENCE_END = /[.!?…。]["')\]]*$/

export interface PageOptions {
  mode: CaptionConfig["mode"]
  maxWords: number
  maxChars: number
  /** start a new page when the pause before a word exceeds this */
  breakGapSec?: number
  /** how long a page lingers after its last word when nothing follows */
  linger?: number
}

/** Group retimed words into caption pages. */
export function buildCaptionPages(words: readonly CaptionWord[], opts: PageOptions): CaptionPage[] {
  const maxWords = opts.mode === "word" ? 1 : Math.max(1, opts.maxWords)
  const breakGap = opts.breakGapSec ?? 0.6
  const linger = opts.linger ?? 0.25
  const pages: CaptionPage[] = []
  let cur: CaptionWord[] = []
  let chars = 0
  const flush = () => {
    if (cur.length === 0) return
    pages.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur })
    cur = []
    chars = 0
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const prev = cur[cur.length - 1]
    const len = w.text.length + (cur.length ? 1 : 0)
    if (
      cur.length > 0 &&
      (cur.length >= maxWords || chars + len > opts.maxChars || w.start - prev.end > breakGap)
    )
      flush()
    cur.push({ ...w })
    chars += len
    if (SENTENCE_END.test(w.text)) flush()
  }
  flush()
  // Extend each page until the next starts (no flicker), or linger briefly.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1]
    const lingerEnd = pages[i].end + linger
    pages[i].end = next && next.start <= lingerEnd + 0.12 ? next.start : lingerEnd
  }
  return pages
}

/** Merge word spans into speech intervals (for music ducking). */
export function speechIntervals(
  words: readonly { start: number; end: number }[],
  joinGap = 0.35
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const w of words) {
    const last = out[out.length - 1]
    if (last && w.start - last.end <= joinGap) last.end = Math.max(last.end, w.end)
    else out.push({ start: w.start, end: w.end })
  }
  return out
}

export const KEYWORD_EMOJI: Record<string, string> = {
  money: "💰",
  cash: "💰",
  rich: "💰",
  fire: "🔥",
  hot: "🔥",
  love: "❤️",
  heart: "❤️",
  crazy: "🤯",
  insane: "🤯",
  mind: "🤯",
  laugh: "😂",
  funny: "😂",
  haha: "😂",
  dead: "💀",
  died: "💀",
  win: "🏆",
  won: "🏆",
  best: "🏆",
  time: "⏰",
  secret: "🤫",
  think: "🤔",
  why: "🤔",
  wow: "😮",
  car: "🚗",
  food: "🍔",
  eat: "🍔",
  game: "🎮",
  music: "🎵",
  idea: "💡",
  learn: "💡",
  work: "💼",
}

export function emojiFor(text: string): string | null {
  const key = text.toLowerCase().replace(/[^\p{L}]/gu, "")
  return KEYWORD_EMOJI[key] ?? null
}

/** First keyword emoji in a piece of text (fallback when no LLM picked one). */
export function keywordEmoji(text: string): string | null {
  for (const w of text.split(/\s+/)) {
    const e = emojiFor(w)
    if (e) return e
  }
  return null
}

/** A short string made of emoji, one or a few (validates LLM output before it reaches the video). */
export function isEmoji(s: string): boolean {
  const t = s.trim()
  return (
    t.length > 0 &&
    t.length <= 64 &&
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(t) &&
    /\p{Extended_Pictographic}/u.test(t)
  )
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Split a string of emojis into individual emojis (ZWJ sequences stay whole; spaces dropped). */
export function splitEmojis(s: string): string[] {
  return [...graphemes.segment(s)].map((g) => g.segment).filter((g) => isEmoji(g))
}

/** Hook text with its emojis (picked, else keyword fallback) when the hook emoji is enabled. */
export function hookTextWithEmoji(hook: {
  text: string
  emoji: boolean
  emojiPick: string
  emojiPosition: "start" | "end" | "both"
}): string {
  const text = hook.text.trim()
  if (!hook.emoji || !text) return hook.text
  const e = splitEmojis(hook.emojiPick).join("") || keywordEmoji(text)
  if (!e) return hook.text
  if (hook.emojiPosition === "both") return `${e} ${text} ${e}`
  return hook.emojiPosition === "start" ? `${e} ${text}` : `${text} ${e}`
}
