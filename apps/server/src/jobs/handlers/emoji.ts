import {
  buildCaptionPages,
  planEdit,
  retimeWords,
  wordIndicesInRange,
  type Clip,
} from "@clipforge/shared"
import { getLlm } from "../../llm"
import { getClip, getProject, loadAnalysis, updateClip } from "../../services"
import type { JobContext } from "../queue"

export interface EmojiJobPayload {
  /** re-pick even if picks already exist */
  force?: boolean
}

/** Does this clip still need LLM emoji picks before it is rendered? */
export function clipNeedsEmojiPicks(clip: Clip): boolean {
  const { hook, captions } = clip.editConfig
  const hookPending =
    hook.emoji && hook.enabled && hook.text.trim() !== "" && hook.emojiPick.trim() === ""
  const captionsPending =
    captions.emoji && captions.enabled && Object.keys(captions.emojiPicks).length === 0
  return hookPending || captionsPending
}

/**
 * Pre-render step: the LLM picks an emoji for the hook and for the caption lines that deserve one.
 * Without an LLM nothing is stored and rendering falls back to keyword matching.
 */
export async function emojiHandler(ctx: JobContext) {
  if (!ctx.job.clipId) throw new Error("Job has no clip")
  const force = (ctx.job.payload as EmojiJobPayload).force === true
  const clip = getClip(ctx.job.clipId)
  const cfg = clip.editConfig
  const wantHook =
    cfg.hook.emoji &&
    cfg.hook.enabled &&
    cfg.hook.text.trim() !== "" &&
    (force || !cfg.hook.emojiPick.trim())
  const wantCaptions =
    cfg.captions.emoji &&
    cfg.captions.enabled &&
    (force || Object.keys(cfg.captions.emojiPicks).length === 0)
  if (!wantHook && !wantCaptions) {
    ctx.log("Emoji picks are up to date (or emoji is off for this clip)")
    return
  }
  const llm = getLlm()
  if (!llm) {
    ctx.log("No LLM selected: rendering uses keyword-matched emojis instead")
    return
  }

  const project = getProject(clip.projectId)
  const analysis = await loadAnalysis(project.id)
  const range = { start: clip.start, end: clip.end }
  const plan = planEdit(range, cfg, analysis.transcript)
  let lines: { id: number; start: number; text: string }[] | null = null
  if (wantCaptions && analysis.transcript) {
    const words = retimeWords(
      analysis.transcript.words,
      wordIndicesInRange(analysis.transcript.words, range),
      plan.edl,
      {
        overrides: cfg.captions.overrides,
        hidden: cfg.captions.hiddenWords,
        deleted: cfg.cuts.deletedWords,
      }
    )
    const pages = buildCaptionPages(words, {
      mode: cfg.captions.mode,
      maxWords: cfg.captions.maxWords,
      maxChars: cfg.captions.maxChars,
    })
    lines = pages.map((p) => ({
      id: (p.words[0] as (typeof words)[number]).idx,
      start: p.start,
      text: p.words.map((w) => w.text).join(" "),
    }))
  }
  // frequency cap from the clip settings: budget + minimum spacing between emoji lines
  const everySec = cfg.captions.emojiEverySec
  const maxLines = Math.max(1, Math.floor(plan.duration / everySec) + 1)
  ctx.log(
    `Picking emojis with the ${llm.name} CLI${llm.model ? ` (${llm.model})` : ""}: ${wantHook ? "hook" : ""}${wantHook && lines ? " + " : ""}${lines ? `${lines.length} caption lines (max ${maxLines})` : ""}`
  )
  const r = await llm.pickEmojis({
    hook: wantHook ? cfg.hook.text : null,
    hookEmojiCount: cfg.hook.emojiCount,
    lines,
    maxLines,
    minGapSec: everySec,
  })

  // Re-read: the clip may have been edited while the LLM was thinking.
  const fresh = getClip(clip.id).editConfig
  const next = structuredClone(fresh)
  if (wantHook) {
    next.hook.emojiPick = r.hook ?? ""
    ctx.log(
      r.hook
        ? `Hook: "${fresh.hook.text}" + ${r.hook}`
        : "Hook: no fitting emoji (keyword fallback applies)"
    )
  }
  if (lines) {
    next.captions.emojiPicks = Object.fromEntries(r.lines.map((l) => [String(l.id), l.emoji]))
    for (const l of r.lines) ctx.log(`${l.emoji}  ${lines.find((x) => x.id === l.id)?.text ?? ""}`)
    ctx.log(`${r.lines.length} caption line(s) got an emoji`)
  }
  updateClip(clip.id, { editConfig: next })
}
