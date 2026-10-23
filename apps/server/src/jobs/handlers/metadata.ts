import { eq } from "drizzle-orm"
import {
  rangeText,
  templateHooks,
  templateMetadata,
  type Category,
  type ClipMetadata,
} from "@clipforge/shared"
import { candidates } from "../../db/schema"
import { getLlm } from "../../llm"
import { getClip, getDeps, getProject, loadAnalysis, updateClip } from "../../services"
import type { JobContext } from "../queue"
import { writeMetadataFiles } from "./render"

async function clipContext(clipId: string) {
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  const analysis = await loadAnalysis(project.id)
  const text = rangeText(analysis.transcript, { start: clip.start, end: clip.end }).text
  const cand = clip.candidateId
    ? getDeps().db.select().from(candidates).where(eq(candidates.id, clip.candidateId)).get()
    : undefined
  const category = (cand?.category ?? "other") as Category
  return { clip, project, text, category, analysis }
}

export async function metadataHandler(ctx: JobContext) {
  if (!ctx.job.clipId) throw new Error("Job has no clip")
  const c = await clipContext(ctx.job.clipId)
  const { clip, project, text, category } = c
  const llm = getLlm()
  let md: ClipMetadata
  const tpl = templateMetadata({
    transcript: text,
    hook: clip.editConfig.hook.text,
    title: clip.name,
    category,
    sourceTitle: project.title,
  })
  if (llm) {
    try {
      ctx.log(`Generating metadata with the ${llm.name} CLI${llm.model ? ` (${llm.model})` : ""}`)
      const r = await llm.generateMetadata({
        videoTitle: project.title,
        people: project.settings.people,
        transcript: text,
        hook: clip.editConfig.hook.text,
        category,
        currentTitle: clip.name,
      })
      md = { ...r, source: "llm" }
    } catch (e) {
      ctx.log(`LLM failed, using templates: ${e instanceof Error ? e.message : String(e)}`)
      md = tpl
    }
  } else {
    ctx.log("No LLM configured: using template metadata")
    md = tpl
  }
  const updated = updateClip(clip.id, { metadata: md })
  if (updated.renderPath) await writeMetadataFiles(updated, updated.renderPath)
}

/** 5 hook alternatives (LLM or templates). Called synchronously from the API. */
export async function hookAlternatives(
  clipId: string
): Promise<{ hooks: string[]; source: "llm" | "template" }> {
  const { clip, project, text } = await clipContext(clipId)
  const llm = getLlm()
  if (llm) {
    try {
      const hooks = await llm.generateHooks({
        transcript: text,
        current: clip.editConfig.hook.text,
        videoTitle: project.title,
        people: project.settings.people,
      })
      if (hooks.length) return { hooks, source: "llm" }
    } catch {
      // fall through to templates
    }
  }
  return { hooks: templateHooks(text, clip.editConfig.hook.text), source: "template" }
}
