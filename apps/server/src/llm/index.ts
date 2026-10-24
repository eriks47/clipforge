import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { cleanHook, hookStyleGuide } from "./hook-style"
import {
  CATEGORIES,
  LLM_SUBSCORES,
  LlmMomentsResponseSchema,
  type LlmMoment,
  isEmoji,
  splitEmojis,
  type BoundaryPiece,
  LlmRankResponseSchema,
  type Category,
  type ClipMetadata,
  type LlmRankItem,
} from "@clipforge/shared"
import { config } from "../config"
import { ProcessError, run } from "../lib/proc"
import { getSettings } from "../services"

// ---------- public interface ----------

export interface RankInputCandidate {
  id: string
  start: number
  end: number
  heuristicScore: number
  features: Record<string, number>
  /** the candidate's transcript as sentence/clause pieces (plus context just outside the range) */
  pieces: BoundaryPiece[]
  /** Twitch VOD imports: how chat reacted during the candidate (rate + most repeated messages) */
  chat?: string | null
  /** non-verbal events detected in the audio/video (laughter, cheering, dancing...) with times */
  events?: string | null
}

export interface RankInput {
  videoTitle: string
  /** who appears in the video (names, roles, pronouns), free text */
  people?: string
  /** allowed clip length (seconds) when the LLM moves boundaries */
  minSec: number
  maxSec: number
  candidates: RankInputCandidate[]
}

export interface MetadataInput {
  videoTitle: string
  people?: string
  transcript: string
  hook: string
  category: Category
  currentTitle: string
}

export interface EmojiInput {
  /** hook text to decorate, or null when no hook emoji is wanted */
  hook: string | null
  /** how many emojis the hook gets (default 1) */
  hookEmojiCount?: number
  /** caption lines (id = first word index), or null when no caption emojis are wanted */
  lines: { id: number; start: number; text: string }[] | null
  /** at most this many caption lines get an emoji */
  maxLines: number
  /** chosen lines must start at least this many seconds apart */
  minGapSec: number
}

export interface EmojiResult {
  hook: string | null
  lines: { id: number; emoji: string }[]
}

export interface HooksInput {
  transcript: string
  current: string
  /** source video title: often holds the names of the people in the clip */
  videoTitle?: string
  people?: string
}

export interface NominateInput {
  videoTitle: string
  people?: string
  minSec: number
  maxSec: number
  /** how many moments to ask for in this section */
  count: number
  /** one section of the transcript as sentence pieces (id = first word index); `events` are
   * non-verbal tags detected during the piece (laughter, cheering, dancing...) */
  pieces: { id: number; start: number; end: number; text: string; events?: string }[]
}

export interface HookPassClip {
  id: string
  category: Category
  /** why the clip was picked (ranking reason) */
  reason: string
  transcript: string
}

export interface HookPassInput {
  videoTitle: string
  people?: string
  clips: HookPassClip[]
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  rankCandidates(input: RankInput, log?: (s: string) => void): Promise<LlmRankItem[]>
  /** read one transcript section and nominate the best clip-worthy moments in it */
  nominateMoments(input: NominateInput): Promise<LlmMoment[]>
  /** write the on-screen hook for each final clip (id -> house-style hook) */
  writeHooks(input: HookPassInput): Promise<Map<string, string>>
  generateMetadata(input: MetadataInput): Promise<Omit<ClipMetadata, "source">>
  generateHooks(input: HooksInput): Promise<string[]>
  /** choose emojis for the hook and the caption lines that deserve one */
  pickEmojis(input: EmojiInput): Promise<EmojiResult>
}

// ---------- JSON schemas sent to the model (no numeric bounds: kept simple for strict modes) ----------

const RANK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "scores",
          "rating",
          "reason",
          "suggested_title",
          "start_piece",
          "end_piece",
          "category",
        ],
        properties: {
          id: { type: "string" },
          scores: {
            type: "object",
            additionalProperties: false,
            required: [...LLM_SUBSCORES],
            properties: Object.fromEntries(
              LLM_SUBSCORES.map((k) => [k, { type: "integer", description: "0-10" }])
            ),
          },
          rating: { type: "integer", description: "0-100" },
          reason: { type: "string", description: "<= 20 words" },
          suggested_title: { type: "string" },
          start_piece: {
            type: ["integer", "null"],
            description: "piece id the clip starts on, or null",
          },
          end_piece: {
            type: ["integer", "null"],
            description: "piece id the clip ends with, or null",
          },
          category: { type: "string", enum: [...CATEGORIES] },
        },
      },
    },
  },
} as const

const MOMENTS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["moments"],
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_piece", "climax_piece", "end_piece", "rating", "why"],
        properties: {
          start_piece: { type: "integer", description: "the hook" },
          climax_piece: { type: "integer", description: "where the climax lands" },
          end_piece: { type: "integer", description: "climax or its short reaction" },
          rating: { type: "integer", description: "0-100" },
          why: { type: "string", description: "<= 15 words: the hook and the payoff" },
        },
      },
    },
  },
} as const

const HookPassResponseSchema = z.object({
  clips: z.array(
    z.object({ id: z.string(), options: z.array(z.string()), best: z.number().int() })
  ),
})
const HOOK_PASS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "options", "best"],
        properties: {
          id: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          best: { type: "integer", description: "index into options of the strongest hook" },
        },
      },
    },
  },
} as const

const MetadataResponseSchema = z.object({
  title: z.string(),
  alt_titles: z.array(z.string()),
  description: z.string(),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()),
})
const METADATA_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "alt_titles", "description", "tags", "hashtags"],
  properties: {
    title: { type: "string" },
    alt_titles: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    hashtags: { type: "array", items: { type: "string" } },
  },
} as const

const HooksResponseSchema = z.object({ hooks: z.array(z.string()) })
const HOOKS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hooks"],
  properties: { hooks: { type: "array", items: { type: "string" } } },
} as const

const EmojiResponseSchema = z.object({
  hook_emoji: z.string().nullable(),
  lines: z.array(z.object({ id: z.number().int(), emoji: z.string() })),
})
const EMOJI_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hook_emoji", "lines"],
  properties: {
    hook_emoji: { type: ["string", "null"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "emoji"],
        properties: { id: { type: "integer" }, emoji: { type: "string" } },
      },
    },
  },
} as const

// ---------- prompts ----------

/** shared by the scouting (nominate) and ranking passes: what makes a moment viral */
const VIRAL_CRITERIA = `Judge every moment on two factors, the hook first and the payoff second.
1. Hook (highest priority): a short line or segment that would make a viewer stop scrolling instantly. Look for something attention-grabbing, out of pocket, shocking, polarizing, emotionally intense, highly curiosity-inducing, or unexpected compared to the rest of the transcript. Strong hooks often create a curiosity gap, sound controversial, challenge a common belief or the status quo, reference something surprising, taboo, risky, dramatic, impressive or unusual, or touch on current viral topics, trends, cultural moments or online narratives when present. Never open on filler, greetings or slow setup.
2. Payoff (secondary priority): the part that answers or fulfills the curiosity the hook created: it explains the hook, resolves its tension or question, gives the viewer the "why", "how" or "what happened", and makes the clip feel satisfying and complete (punchline, reveal, comeback, the answer, the reaction). Keep the hook and its payoff connected in one clip whenever possible, with only the lines between them that the payoff needs; the clip ends right after the payoff, plus at most a beat of reaction.
Do not reject a strong hook just because its payoff is weak or incomplete: a very strong hook is worth clipping on its own.
Prefer moments that work as standalone short clips. When several moments are similar, keep the strongest, cleanest, most scroll-stopping one. Skip moments that are only informative unless they are also highly attention-grabbing, and skip long boring setup unless it is needed for context.`

const RANK_SYSTEM = `You are an expert short-form video editor who picks moments from long videos (podcasts, streams, interviews) that will perform well as YouTube Shorts / TikTok / Reels.
${VIRAL_CRITERIA}
Judge each candidate mainly on its hook, then on its payoff, whether it is understandable without context, and how intense and shareable it is.
An "audio/video events" line lists what audio and video models detected that a transcript can't show (people laughing, cheering or shouting, an excited voice, dancing or singing), with times: laughter right after a line is strong evidence it landed; a performance can be a great clip with little speech.
For livestream VODs a "live chat" line shows how the stream's chat reacted to the moment (already lined up for chat delay): a chat explosion with laughter or hype (KEKW, LUL, OMEGALUL, LMAO, Pog, W) is strong evidence of a clip-worthy moment; chat spam alone without anything happening in the transcript is not.
First score each aspect 0-10 on an absolute scale (5 = typical podcast/stream moment, 8 = clearly above what most Shorts manage, 10 = exceptional), then give the overall rating:
- hook: would the first 2-3 seconds stop a viewer scrolling on their own (shocking, polarizing, curiosity gap, unexpected)?
- progress: does the middle stay tight and lead to the payoff without dead weight or boring setup?
- climax: the payoff: does the clip answer or fulfill the hook's curiosity (why, how, what happened) and feel complete? Low if the clip trails on after it.
- self_contained: understandable with no context from the rest of the video?
- emotion: intensity (funny, angry, shocked, moving)?
The overall rating is driven mainly by the hook, then the payoff: a weak hook caps the rating at ~55 however good the rest is, while a very strong hook with a weak or incomplete payoff can still rate 70+.
Be critical and use the full 0-100 range for rating: most moments are mediocre (30-60); reserve 85+ for clips you'd confidently post. Rate on the same absolute scale in every request: you see only some of the candidates at a time.
A Short must never begin or end in the middle of a sentence. Each candidate's transcript is listed as numbered pieces (sentences, long sentences split into clauses) with timestamps and sentence markers. To move a clip's boundaries, answer with piece ids:
- start_piece: the hook, the piece the clip begins with. Prefer a piece that starts a sentence (S). Skip preamble: if the attention-grabbing line comes a few pieces in, start there (as long as the payoff still makes sense). A clause start is acceptable only when that sentence is long and the clause makes sense on its own as an opening.
- end_piece: the payoff, or the short reaction right after it: the last piece of the clip. Prefer a piece that ends a sentence (E). Never end on a piece that leaves the thought unfinished, and never keep talking after the payoff.
- You may use the ~ context pieces just outside the current range to start earlier or finish a thought.
- Use null for both to keep the current range. Set both whenever the current range starts or ends mid-sentence or a tighter cut that starts on the hook would be better.
suggested_title: under 70 characters, no clickbait lies.
Respond with JSON only.`

function peopleBlock(people: string | undefined): string {
  const p = people?.trim()
  return p ? `People in this video (use these names and pronouns):\n${p}\n` : ""
}

const NOMINATE_SYSTEM = `You scout long videos (podcasts, streams, interviews, debates) for moments to cut into YouTube Shorts / TikTok / Reels.
You get one section of the transcript as numbered sentence pieces. Read all of it and pick the best self-contained moments.
${VIRAL_CRITERIA}
For each moment: start_piece = the hook (prefer a piece that starts a sentence), climax_piece = the piece where the payoff lands (the hook piece itself if there is no real payoff), end_piece = the last piece: the payoff itself or a short reaction right after it (at most ~5 s after the payoff).
Bracketed tags like [laughter] or [cheering/shouting] come from audio/video models, not the transcript: laughter or cheering right after a line means it landed, and [dancing/singing] marks a performance worth clipping even with few words.
Quality over quantity: return fewer moments (or none) when the section is dull. Never pick a moment that only makes sense with context from earlier in the video.
rating 0-100 on an absolute scale: 50 = an average moment for this kind of video, 85+ = you would confidently post it.
rating reflects mainly how strong the hook is, then the payoff. Use the piece ids exactly as listed; start_piece <= climax_piece <= end_piece.
Respond with JSON only.`

export function buildNominatePrompt(input: NominateInput): string {
  const lines = input.pieces.map(
    (p) => `#${p.id} ${fmt(p.start)}-${fmt(p.end)}s ${p.text}${p.events ? ` [${p.events}]` : ""}`
  )
  return `Source video: ${input.videoTitle}
${peopleBlock(input.people)}
Pick up to ${input.count} moments, each ${input.minSec}-${input.maxSec} s long (end of end_piece minus start of start_piece).
Transcript section (#<piece id> <start>-<end>s <text> [non-verbal events detected in the audio/video, if any]):
${lines.join("\n")}

Return {"moments": [...]}, best first.`
}

const HOOK_PASS_SYSTEM = `You write the on-screen hook text for vertical short videos: one line at the top of the video that makes viewers keep watching.
Each clip is built Hook - Progress - Climax, with its big moment at the end: the hook text sets up the question or tension that the climax answers, and never gives the climax away.
Respond with JSON only.`

/** read per call so edits to hook-examples.md apply without a restart */
export function buildHookPassPrompt(input: HookPassInput): string {
  const clips = input.clips.map(
    (c) => `### id=${c.id} (${c.category}; picked because: ${c.reason})\n${c.transcript}`
  )
  return `Source video: ${input.videoTitle}
${peopleBlock(input.people)}
${hookStyleGuide()}

For each clip below, write 4 different hook options in the house style (different angles: the key moment, the emotion, the surprising detail, the person's reaction), then set best to the index of the strongest one. Each hook must be true to that clip's transcript.

${clips.join("\n\n")}

Return {"clips": [...]} with exactly one entry per clip id above.`
}

function fmt(t: number) {
  return t.toFixed(1)
}

export function buildRankPrompt(input: RankInput): string {
  const parts: string[] = [`Source video: ${input.videoTitle}`]
  const people = peopleBlock(input.people)
  if (people) parts.push(people.trimEnd())
  parts.push(
    `\nClip length when you move boundaries: ${input.minSec}-${input.maxSec} s.` +
      "\nTranscript pieces are listed as `#<piece id> <start>-<end>s <flags> <text>`. Flags: S = starts a sentence, E = ends a sentence, · = neither. Lines starting with ~ are context just outside the current range."
  )
  parts.push("\nCandidates:")
  for (const c of input.candidates) {
    const feats = Object.entries(c.features)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")
    const lines = c.pieces.length
      ? c.pieces.map(
          (p) =>
            `${p.inside ? " " : "~"} #${p.id} ${fmt(p.start)}-${fmt(p.end)}s ${p.sentenceStart ? "S" : "·"}${p.sentenceEnd ? "E" : "·"} ${p.text}`
        )
      : ["  (no speech — use null for start_piece and end_piece)"]
    parts.push(
      `\n### id=${c.id}  current range=${fmt(c.start)}-${fmt(c.end)}s (${fmt(c.end - c.start)}s)  heuristic=${c.heuristicScore}\nsignals: ${feats}${c.events ? `\naudio/video events: ${c.events}` : ""}${c.chat ? `\nlive chat: ${c.chat}` : ""}\ntranscript:\n${lines.join("\n")}`
    )
  }
  parts.push(`\nReturn {"candidates": [...]} with exactly one entry per candidate id above.`)
  return parts.join("\n")
}

function metadataPrompt(input: MetadataInput): string {
  return `Write publishing metadata for a vertical short clip cut from "${input.videoTitle}".
${peopleBlock(input.people)}Category: ${input.category}. On-screen hook: "${input.hook}". Working title: "${input.currentTitle}".
Transcript of the clip:
${input.transcript}

Return JSON with: title (<= 70 chars, curiosity-driven but honest), alt_titles (exactly 3 alternatives, <= 70 chars),
description (2-3 short sentences + call to action, no hashtags), tags (8-15 lowercase keywords), hashtags (3-5, each starting with #, include #shorts).`
}

export function hooksPrompt(input: HooksInput): string {
  return `Suggest 5 alternative on-screen hook texts for this short clip${input.videoTitle ? ` cut from "${input.videoTitle}"` : ""}. Current hook: "${input.current}".
They appear at the top of the video and must make viewers keep watching. All 5 follow the house style below; vary the angle (different moment, emotion or detail of the clip), not the style.

${peopleBlock(input.people)}${hookStyleGuide()}

Transcript:
${input.transcript}

Return {"hooks": [5 strings]}.`
}

const EMOJI_SYSTEM = `You add emojis to vertical short videos (YouTube Shorts / TikTok / Reels) the way a skilled editor does: sparingly, where an emoji adds meaning or emotion, never as decoration on every line.
Use exactly one emoji per caption line; the hook gets the number of emojis asked for. Prefer universally understood emojis; avoid flags, skin-tone variants and anything that could read as mocking. Never repeat the same emoji on consecutive lines.
Respond with JSON only.`

export function buildEmojiPrompt(input: EmojiInput): string {
  const parts: string[] = []
  if (input.hook !== null) {
    const n = Math.max(1, input.hookEmojiCount ?? 1)
    parts.push(
      `On-screen hook (shown at the start of the video): "${input.hook}"\nhook_emoji: ${n === 1 ? "the single emoji that best amplifies this hook" : `exactly ${n} different emojis, written together with no spaces, that together best amplify this hook`}.`
    )
  } else parts.push("No hook emoji is needed: set hook_emoji to null.")
  if (input.lines) {
    parts.push(
      `Caption lines (id, time, text):\n${input.lines.map((l) => `${l.id} @${l.start.toFixed(1)}s: ${l.text}`).join("\n")}\n\nlines: pick at most ${input.maxLines} of these lines where an emoji clearly adds meaning or emotion (punchlines, key objects, numbers/money, strong reactions, surprises) and give each one emoji. Chosen lines must start at least ${input.minGapSec} s apart (see the @time of each line). Use the ids exactly as listed. Fewer is fine.`
    )
  } else parts.push("No caption emojis are needed: return an empty lines array.")
  return parts.join("\n\n")
}

// ---------- providers ----------

type JsonSchema = Readonly<Record<string, unknown>>

abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string
  abstract readonly model: string
  /** One model call that returns the raw final text (expected to be JSON matching `schema`). */
  protected abstract complete(system: string, user: string, schema: JsonSchema): Promise<string>

  /** Ask for JSON, validate with zod, retry once with the validation error on failure. */
  protected async json<T>(
    system: string,
    user: string,
    schema: JsonSchema,
    validator: z.ZodType<T>
  ): Promise<T> {
    let lastErr = ""
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? user
          : `${user}\n\nYour previous answer was invalid (${lastErr}). Return ONLY valid JSON matching the schema.`
      const raw = await this.complete(system, prompt, schema)
      try {
        const text = raw
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/, "")
        const start = text.indexOf("{")
        const end = text.lastIndexOf("}")
        const parsed: unknown = JSON.parse(start >= 0 ? text.slice(start, end + 1) : text)
        const r = validator.safeParse(parsed)
        if (r.success) return r.data
        lastErr = r.error.message.slice(0, 400)
      } catch (e) {
        lastErr = `JSON parse error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    throw new Error(`LLM returned invalid output twice: ${lastErr}`)
  }

  /** Chunks of 10 run in parallel; a failed chunk is logged and skipped (heuristics fill in). */
  async rankCandidates(input: RankInput, log?: (s: string) => void): Promise<LlmRankItem[]> {
    const chunkSize = 10
    const chunks: RankInputCandidate[][] = []
    for (let i = 0; i < input.candidates.length; i += chunkSize)
      chunks.push(input.candidates.slice(i, i + chunkSize))
    log?.(
      `Ranking ${input.candidates.length} candidates in ${chunks.length} parallel call(s) with the ${this.name} CLI${this.model ? ` (${this.model})` : ""}`
    )
    const results = await Promise.allSettled(
      chunks.map((chunk) =>
        this.json(
          RANK_SYSTEM,
          buildRankPrompt({ ...input, candidates: chunk }),
          RANK_JSON_SCHEMA,
          LlmRankResponseSchema
        )
      )
    )
    const out: LlmRankItem[] = []
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        log?.(
          `Ranking chunk ${i + 1} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
        )
        return
      }
      const ids = new Set(chunks[i].map((c) => c.id))
      out.push(...r.value.candidates.filter((c) => ids.has(c.id)))
    })
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    if (out.length === 0 && failed.length) {
      const reason: unknown = failed[0].reason
      throw reason instanceof Error ? reason : new Error(String(reason))
    }
    return out
  }

  async nominateMoments(input: NominateInput): Promise<LlmMoment[]> {
    const r = await this.json(
      NOMINATE_SYSTEM,
      buildNominatePrompt(input),
      MOMENTS_JSON_SCHEMA,
      LlmMomentsResponseSchema
    )
    return r.moments.slice(0, input.count)
  }

  async writeHooks(input: HookPassInput): Promise<Map<string, string>> {
    const r = await this.json(
      HOOK_PASS_SYSTEM,
      buildHookPassPrompt(input),
      HOOK_PASS_JSON_SCHEMA,
      HookPassResponseSchema
    )
    const ids = new Set(input.clips.map((c) => c.id))
    const out = new Map<string, string>()
    for (const c of r.clips) {
      if (!ids.has(c.id)) continue
      // the model's favourite first, then the other options, keeping the first that fits the style
      const order = [c.options[c.best], ...c.options.filter((_, i) => i !== c.best)]
      const hook = order.map((h) => (h ? cleanHook(h) : null)).find((h) => h !== null)
      if (hook) out.set(c.id, hook)
    }
    return out
  }

  async generateMetadata(input: MetadataInput) {
    const r = await this.json(
      "You write metadata for YouTube Shorts. Respond with JSON only.",
      metadataPrompt(input),
      METADATA_JSON_SCHEMA,
      MetadataResponseSchema
    )
    return {
      title: r.title.slice(0, 100),
      altTitles: r.alt_titles.slice(0, 3),
      description: r.description,
      tags: r.tags.slice(0, 20),
      hashtags: r.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).slice(0, 6),
    }
  }

  async pickEmojis(input: EmojiInput): Promise<EmojiResult> {
    const r = await this.json(
      EMOJI_SYSTEM,
      buildEmojiPrompt(input),
      EMOJI_JSON_SCHEMA,
      EmojiResponseSchema
    )
    const startOf = new Map((input.lines ?? []).map((l) => [l.id, l.start]))
    const lines: (EmojiResult["lines"][number] & { start: number })[] = []
    for (const l of r.lines) {
      // keep only valid, known, unique lines that respect the spacing, within the budget
      const start = startOf.get(l.id)
      if (start === undefined || !isEmoji(l.emoji) || lines.some((k) => k.id === l.id)) continue
      if (lines.some((k) => Math.abs(k.start - start) < input.minGapSec - 1e-6)) continue
      lines.push({ id: l.id, emoji: l.emoji.trim(), start })
      if (lines.length >= input.maxLines) break
    }
    const hookEmojis =
      input.hook !== null && r.hook_emoji && isEmoji(r.hook_emoji)
        ? splitEmojis(r.hook_emoji).slice(0, Math.max(1, input.hookEmojiCount ?? 1))
        : []
    const hook = hookEmojis.length ? hookEmojis.join("") : null
    return { hook, lines: lines.map(({ id, emoji }) => ({ id, emoji })) }
  }

  async generateHooks(input: HooksInput) {
    const r = await this.json(
      "You write on-screen hooks for short videos. Respond with JSON only.",
      hooksPrompt(input),
      HOOKS_JSON_SCHEMA,
      HooksResponseSchema
    )
    const hooks = r.hooks.map((h) => h.trim()).filter(Boolean)
    // prefer hooks that fit the house style, but never return nothing when the model answered
    const clean = hooks.map(cleanHook).filter((h): h is string => h !== null)
    return (clean.length ? clean : hooks).slice(0, 5)
  }
}

/** Run a CLI agent in an empty scratch dir so it never sees (or touches) the project files. */
async function inScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "clipforge-llm-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Child env for the CLIs: drop API-key variables so they always use the local login. */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"])
    delete env[k]
  return env
}

interface ClaudePrintResult {
  is_error?: boolean
  subtype?: string
  result?: string
  structured_output?: unknown
}

/**
 * Local Claude Code CLI in print mode (`claude -p`), using your existing login.
 * Tools are disabled and user settings/hooks are not loaded; output is constrained with --json-schema.
 */
class ClaudeCliProvider extends BaseProvider {
  readonly name = "claude"

  constructor(
    readonly model: string,
    private bin: string
  ) {
    super()
  }

  protected complete(system: string, user: string, schema: JsonSchema): Promise<string> {
    return inScratchDir(async (cwd) => {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(schema),
        "--system-prompt",
        system,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--no-session-persistence",
      ]
      if (this.model) args.push("--model", this.model)
      let stdout: string
      try {
        ;({ stdout } = await run(this.bin, args, {
          cwd,
          env: cliEnv(),
          input: user,
          collectStdout: true,
          timeoutMs: config.llm.timeoutMs,
        }))
      } catch (e) {
        // claude -p reports failures as JSON on stdout with a non-zero exit code
        if (!(e instanceof ProcessError) || !e.stdout.trim().startsWith("{")) throw e
        stdout = e.stdout
      }
      let res: ClaudePrintResult
      try {
        res = JSON.parse(stdout) as ClaudePrintResult
      } catch {
        throw new Error(`claude returned non-JSON output: ${stdout.slice(0, 300)}`)
      }
      if (res.is_error) throw new Error(`claude: ${res.result ?? res.subtype ?? "error"}`)
      return res.structured_output !== undefined && res.structured_output !== null
        ? JSON.stringify(res.structured_output)
        : (res.result ?? "")
    })
  }
}

/**
 * Local Codex CLI (`codex exec`), using your existing login. Runs ephemeral with a read-only
 * sandbox in an empty scratch dir; the final message is constrained with --output-schema.
 */
class CodexCliProvider extends BaseProvider {
  readonly name = "codex"

  constructor(
    readonly model: string,
    private bin: string
  ) {
    super()
  }

  protected complete(system: string, user: string, schema: JsonSchema): Promise<string> {
    return inScratchDir(async (cwd) => {
      const schemaFile = join(cwd, "schema.json")
      const outFile = join(cwd, "answer.json")
      await writeFile(schemaFile, JSON.stringify(schema))
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--output-schema",
        schemaFile,
        "-o",
        outFile,
        "-C",
        cwd,
      ]
      if (this.model) args.push("-m", this.model)
      args.push("-")
      await run(this.bin, args, {
        cwd,
        env: cliEnv(),
        input: `${system}\n\n${user}`,
        timeoutMs: config.llm.timeoutMs,
      })
      try {
        return await readFile(outFile, "utf8")
      } catch {
        throw new Error("codex finished without writing a final answer")
      }
    })
  }
}

export function createLlmProvider(provider: string, model = ""): LLMProvider | null {
  if (provider === "claude")
    return new ClaudeCliProvider(model || config.llm.claudeModel, config.llm.claudeBin)
  if (provider === "codex")
    return new CodexCliProvider(model || config.llm.codexModel, config.llm.codexBin)
  return null
}

/** Provider name in effect: the Settings choice, else LLM_PROVIDER from .env. */
export function activeLlmProvider(): string {
  return getSettings().llm.provider ?? config.llm.provider
}

/**
 * The active provider, or null when running without an LLM (heuristics + templates).
 * Resolved on every call so switching Claude Code ⇄ Codex in the UI applies to the next job.
 */
export function getLlm(): LLMProvider | null {
  const s = getSettings().llm
  const provider = s.provider ?? config.llm.provider
  return createLlmProvider(
    provider,
    provider === "claude" ? s.claudeModel : provider === "codex" ? s.codexModel : ""
  )
}
