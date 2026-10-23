import type { TimeRange, Transcript, Word } from "../schemas/media"
import { sentenceUnits } from "./speech"

/**
 * A sentence or clause of the transcript that a clip may start or end on.
 * `id` is the global index of its first word (stable across prompts and edits).
 */
export interface BoundaryPiece {
  id: number
  /** global index of its last word */
  last: number
  start: number
  end: number
  text: string
  /** the piece begins a sentence */
  sentenceStart: boolean
  /** the piece ends a sentence */
  sentenceEnd: boolean
  /** overlaps the current range (false = context just outside it) */
  inside: boolean
}

const CLAUSE_END = /[,;:—–]["')\]]*$/

function joinText(words: readonly Word[], first: number, last: number): string {
  return words
    .slice(first, last + 1)
    .map((w) => w.text.trim())
    .join(" ")
}

/**
 * Split the sentences around a range into pieces an LLM can choose clip boundaries from:
 * whole sentences, with long sentences further split at clause punctuation (, ; : —).
 * Includes `contextSentences` sentences before and after the range so a clip can be extended
 * to complete a thought.
 */
export function boundaryPieces(
  transcript: Transcript,
  range: TimeRange,
  opts: { contextSentences?: number; minClauseWords?: number } = {}
): BoundaryPiece[] {
  const context = opts.contextSentences ?? 2
  const minClause = opts.minClauseWords ?? 3
  const words = transcript.words
  const units = sentenceUnits(transcript)
  const insideIdx = units
    .map((u, i) => (u.end > range.start && u.start < range.end ? i : -1))
    .filter((i) => i >= 0)
  if (insideIdx.length === 0) return []
  const from = Math.max(0, insideIdx[0] - context)
  const to = Math.min(units.length - 1, insideIdx[insideIdx.length - 1] + context)
  const pieces: BoundaryPiece[] = []
  for (let u = from; u <= to; u++) {
    const unit = units[u]
    const inside = unit.end > range.start && unit.start < range.end
    // clause cut points: after punctuation, only if both sides keep enough words
    const cuts: number[] = []
    let segStart = unit.first
    for (let i = unit.first; i < unit.last; i++) {
      if (!CLAUSE_END.test(words[i].text.trim())) continue
      if (i - segStart + 1 < minClause || unit.last - i < minClause) continue
      cuts.push(i)
      segStart = i + 1
    }
    let first = unit.first
    for (const [k, last] of [...cuts, unit.last].entries()) {
      pieces.push({
        id: first,
        last,
        start: words[first].start,
        end: words[last].end,
        text: joinText(words, first, last),
        // units split for length are clauses, not sentences
        sentenceStart: k === 0 && unit.startsSentence,
        sentenceEnd: last === unit.last && unit.endsSentence,
        inside,
      })
      first = last + 1
    }
  }
  return pieces
}

/**
 * Clip range from a start piece and an end piece: begins just before the first word and ends just
 * after the last, never reaching into the neighbouring words. Null if the ids are unknown or reversed.
 */
export function rangeFromPieces(
  words: readonly Word[],
  pieces: readonly BoundaryPiece[],
  startId: number,
  endId: number,
  opts: { leadInSec: number; tailSec: number; duration: number }
): TimeRange | null {
  const a = pieces.find((p) => p.id === startId)
  const b = pieces.find((p) => p.id === endId)
  if (!a || !b || b.last < a.id) return null
  const prevEnd = a.id > 0 ? words[a.id - 1].end : 0
  const nextStart = b.last + 1 < words.length ? words[b.last + 1].start : opts.duration
  const start = Math.max(0, prevEnd + (a.id > 0 ? 0.02 : 0), words[a.id].start - opts.leadInSec)
  const end = Math.min(opts.duration, nextStart - 0.02, words[b.last].end + opts.tailSec)
  return end > start ? { start, end } : null
}
