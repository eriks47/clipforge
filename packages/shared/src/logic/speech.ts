import type { TimeRange, Transcript, Word } from "../schemas/media"
import { wordIndicesInRange } from "./edl"
import { normalizeToken } from "./util"

const LAUGHTER_RE =
  /\[(laugh|laughter|laughs|laughing)\]|\b(ha){2,}h?\b|\bhah(a)+\w*|\blol\b|\blmao\b|\bhehe\w*/i
const PROFANITY = new Set([
  "fuck",
  "fucking",
  "fucked",
  "shit",
  "damn",
  "bitch",
  "ass",
  "hell",
  "crap",
  "wtf",
  "motherfucker",
  "bullshit",
])
const STRONG_CLAIM_RE =
  /\b(never|always|nobody|everyone|secret|truth|biggest|worst|best|crazy|insane|actually|literally|wrong|mistake|stop|why|how|what if|imagine)\b/i

export interface SpeechStats {
  wordCount: number
  speechSec: number
  wordsPerSec: number
  /** fraction of the range not covered by words (pauses > 0.35s count) */
  deadAirRatio: number
  questions: number
  exclamations: number
  laughter: number
  profanity: number
  numbers: number
  entities: number
  lowConfidenceRatio: number
}

export function sentenceText(words: readonly Word[], first: number, last: number): string {
  return words
    .slice(first, last + 1)
    .map((w) => w.text.trim())
    .join(" ")
    .replace(/\s+([,.!?])/g, "$1")
}

export function speechStats(words: readonly Word[], range: TimeRange): SpeechStats {
  const idx = wordIndicesInRange(words, range)
  const dur = Math.max(range.end - range.start, 1e-6)
  let speech = 0
  let questions = 0
  let exclamations = 0
  let laughter = 0
  let profanity = 0
  let numbers = 0
  let entities = 0
  let lowConf = 0
  let prevEnd = range.start
  let gapTotal = 0
  for (let k = 0; k < idx.length; k++) {
    const w = words[idx[k]]
    speech += Math.max(0, w.end - w.start)
    const gap = w.start - prevEnd
    if (gap > 0.35) gapTotal += gap
    prevEnd = Math.max(prevEnd, w.end)
    const raw = w.text.trim()
    if (raw.includes("?")) questions++
    if (raw.includes("!")) exclamations++
    if (LAUGHTER_RE.test(raw)) laughter++
    const tok = normalizeToken(raw)
    if (PROFANITY.has(tok)) profanity++
    if (/\d/.test(raw)) numbers++
    const prevText = k > 0 ? words[idx[k - 1]].text.trim() : "."
    if (/^\p{Lu}/u.test(raw) && !/[.!?]$/.test(prevText) && tok.length > 1 && tok !== "i")
      entities++
    if (w.prob < 0.5) lowConf++
  }
  const tail = range.end - prevEnd
  if (tail > 0.35) gapTotal += tail
  if (idx.length === 0) gapTotal = dur
  return {
    wordCount: idx.length,
    speechSec: speech,
    wordsPerSec: idx.length / dur,
    deadAirRatio: Math.min(1, gapTotal / dur),
    questions,
    exclamations,
    laughter,
    profanity,
    numbers,
    entities,
    lowConfidenceRatio: idx.length ? lowConf / idx.length : 0,
  }
}

export function isStrongOpener(text: string): boolean {
  const t = text.trim()
  return t.endsWith("?") || t.endsWith("!") || STRONG_CLAIM_RE.test(t) || /\d/.test(t)
}

export interface SentenceUnit {
  start: number
  end: number
  first: number
  last: number
  /** begins a real sentence (false = continues a sentence that was split for length) */
  startsSentence: boolean
  /** ends a real sentence (false = split mid-sentence at a clause or for length) */
  endsSentence: boolean
}

const TERMINAL = /[.!?…]["')\]]*$/
const ANY_PUNCT = /[.!?…,;:—–]["')\]]*$/
/** words that are capitalised mid-sentence in English */
const ALWAYS_CAPITAL = /^I('|’)?(m|ve|ll|d|s)?$/
/** after this many words without terminal punctuation, capitals are treated as sentence starts */
const UNPUNCTUATED_RUN = 15

/**
 * Split words into sentence-like units. Breaks on terminal punctuation and long pauses; when
 * Whisper leaves a stretch unpunctuated, a capitalised word (it still capitalises sentence starts)
 * also starts a new sentence. Very long sentences are split at clauses (or hard) so windows can be
 * built, and those splits are flagged as not starting/ending a sentence.
 */
export function sentenceUnits(
  transcript: Transcript,
  maxPauseSec = 1.0,
  maxUnitSec = 12
): SentenceUnit[] {
  const { words } = transcript
  const units: SentenceUnit[] = []
  let first = 0
  let lastTerminal = -1
  let startsSentence = true
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const text = w.text.trim()
    const next = words[i + 1]
    const terminal = TERMINAL.test(text)
    if (terminal) lastTerminal = i
    const pause = next ? next.start - w.end > maxPauseSec : true
    const nextText = next?.text.trim() ?? ""
    const capitalBreak =
      !!next &&
      i - lastTerminal >= UNPUNCTUATED_RUN &&
      !ANY_PUNCT.test(text) &&
      /^\p{Lu}/u.test(nextText) &&
      !ALWAYS_CAPITAL.test(nextText.replace(/[^\p{L}'’]/gu, ""))
    const unitLen = w.end - words[first].start
    const tooLong = (unitLen > maxUnitSec && /[,;:]$/.test(text)) || unitLen > maxUnitSec * 2
    const sentenceEnd = terminal || pause || capitalBreak || !next
    if (sentenceEnd || tooLong) {
      units.push({
        start: words[first].start,
        end: w.end,
        first,
        last: i,
        startsSentence,
        endsSentence: sentenceEnd,
      })
      first = i + 1
      startsSentence = sentenceEnd
    }
  }
  return units
}
