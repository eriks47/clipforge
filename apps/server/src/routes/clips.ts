import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { spawn } from "node:child_process"
import { desc, eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { nanoid } from "nanoid"
import { z } from "zod"
import {
  CandidateStatusSchema,
  ClipMetadataSchema,
  EditConfigSchema,
  rangeText,
  scoreRange,
  type Clip,
} from "@clipforge/shared"
import { candidates, feedback, clips } from "../db/schema"
import { bus } from "../lib/events"
import { clipFacesFile, nowIso, projectPaths } from "../lib/paths"
import { hookAlternatives } from "../jobs/handlers/metadata"
import { writeMetadataFiles } from "../jobs/handlers/render"
import { nextBatch } from "../jobs/handlers/candidates"
import { getLlm } from "../llm"
import { clipNeedsEmojiPicks } from "../jobs/handlers/emoji"
import {
  createClipFromCandidate,
  defaultConfigForNewClip,
  ensureFaceDetection,
  getClip,
  getDeps,
  getProject,
  getSettings,
  HttpError,
  listCandidates,
  loadAnalysis,
  loadFaces,
  recordFeedback,
  refreshProjectStatus,
  toCandidate,
  toClip,
  updateClip,
} from "../services"

export async function clipRoutes(app: FastifyInstance) {
  const { db, queue } = getDeps()

  // ---------- candidates ----------
  app.get<{ Params: { id: string } }>("/api/projects/:id/candidates", async (req) =>
    listCandidates(req.params.id)
  )

  app.post<{ Params: { id: string } }>("/api/projects/:id/candidates/more", async (req) => {
    const p = getProject(req.params.id)
    if (
      queue.findActive("candidates", { projectId: p.id }) ||
      queue.findActive("rank", { projectId: p.id })
    )
      throw new HttpError(409, "Candidate generation already running")
    const batch = nextBatch(p.id)
    const c = queue.enqueue({ type: "candidates", projectId: p.id, payload: { batch } })
    queue.enqueue({ type: "rank", projectId: p.id, dependsOn: [c.id], payload: { batch } })
    refreshProjectStatus(p.id)
    return { batch }
  })

  const ManualBody = z.object({ start: z.number().min(0), end: z.number() })
  app.post<{ Params: { id: string } }>("/api/projects/:id/candidates", async (req) => {
    const p = getProject(req.params.id)
    const { start, end } = ManualBody.parse(req.body)
    if (end - start < 1) throw new HttpError(400, "Range too short")
    const a = await loadAnalysis(p.id)
    const settings = getSettings().candidates
    const s = scoreRange(
      { start, end },
      {
        transcript: a.transcript,
        analysis: a.audio,
        heatmap: a.heatmap,
        chat: a.chat,
        signals: a.signals,
        visual: a.visual,
        duration: p.probe?.duration ?? 0,
        settings,
      }
    )
    const id = nanoid(10)
    db.insert(candidates)
      .values({
        id,
        projectId: p.id,
        start,
        end,
        heuristicScore: s.score,
        llmRating: null,
        finalRating: s.score,
        breakdown: s.breakdown,
        reason: "Manual selection",
        llmReason: null,
        category: s.category,
        suggestedHook: s.suggestedHook,
        suggestedTitle: s.suggestedTitle,
        status: "new",
        source: "manual",
        batch: -1,
        rank: 0,
        clipId: null,
        createdAt: nowIso(),
      })
      .run()
    bus.emitEvent({ type: "candidates", projectId: p.id })
    return toCandidate(db.select().from(candidates).where(eq(candidates.id, id)).get()!)
  })

  const CandPatch = z.object({
    start: z.number().min(0).optional(),
    end: z.number().optional(),
    status: CandidateStatusSchema.optional(),
    suggestedHook: z.string().optional(),
  })
  app.patch<{ Params: { id: string } }>("/api/candidates/:id", async (req) => {
    const body = CandPatch.parse(req.body)
    const c = db.select().from(candidates).where(eq(candidates.id, req.params.id)).get()
    if (!c) throw new HttpError(404, "Candidate not found")
    const patch: Partial<typeof candidates.$inferInsert> = { ...body }
    if (body.start !== undefined || body.end !== undefined) {
      const start = body.start ?? c.start
      const end = body.end ?? c.end
      if (end - start < 1) throw new HttpError(400, "Range too short")
      // re-score the trimmed range so the heuristic stays honest
      const a = await loadAnalysis(c.projectId)
      const s = scoreRange(
        { start, end },
        {
          transcript: a.transcript,
          analysis: a.audio,
          heatmap: a.heatmap,
          chat: a.chat,
          signals: a.signals,
          visual: a.visual,
          duration: getProject(c.projectId).probe?.duration ?? end,
          settings: getSettings().candidates,
        }
      )
      patch.heuristicScore = s.score
      patch.breakdown = s.breakdown
      const blend = getSettings().candidates.llmBlend
      patch.finalRating =
        c.llmRating !== null
          ? Math.round((blend * c.llmRating + (1 - blend) * s.score) * 10) / 10
          : s.score
      if (c.clipId) {
        db.update(clips)
          .set({ start, end, updatedAt: nowIso() })
          .where(eq(clips.id, c.clipId))
          .run()
        ensureFaceDetection(getClip(c.clipId))
      }
    }
    db.update(candidates).set(patch).where(eq(candidates.id, c.id)).run()
    let clip: Clip | null = null
    if (body.status === "approved") clip = createClipFromCandidate(c.id)
    if (body.status !== undefined && body.status !== c.status)
      await recordFeedback(c.id, body.status).catch((e: unknown) =>
        req.log.warn({ err: e }, "could not record candidate feedback")
      )
    bus.emitEvent({ type: "candidates", projectId: c.projectId })
    return {
      candidate: toCandidate(db.select().from(candidates).where(eq(candidates.id, c.id)).get()!),
      clip,
    }
  })

  app.delete<{ Params: { id: string } }>("/api/candidates/:id", async (req) => {
    const c = db.select().from(candidates).where(eq(candidates.id, req.params.id)).get()
    if (!c) throw new HttpError(404, "Candidate not found")
    await recordFeedback(c.id, "deleted").catch((e: unknown) =>
      req.log.warn({ err: e }, "could not record candidate feedback")
    )
    db.delete(candidates).where(eq(candidates.id, c.id)).run()
    bus.emitEvent({ type: "candidates", projectId: c.projectId })
    return { ok: true }
  })

  /** Every approve/reject decision with its ranking snapshot (export for fitting weights). */
  app.get<{ Querystring: { projectId?: string } }>("/api/feedback", async (req) => {
    const q = db.select().from(feedback)
    return (req.query.projectId ? q.where(eq(feedback.projectId, req.query.projectId)) : q)
      .orderBy(feedback.createdAt)
      .all()
  })

  // ---------- clips ----------
  app.get<{ Params: { id: string } }>("/api/projects/:id/clips", async (req) =>
    db
      .select()
      .from(clips)
      .where(eq(clips.projectId, req.params.id))
      .orderBy(desc(clips.createdAt))
      .all()
      .map(toClip)
  )

  app.get("/api/clips", async () => {
    const rows = db.select().from(clips).orderBy(desc(clips.updatedAt)).all().map(toClip)
    const projectTitles = new Map<string, string>()
    return rows.map((c) => {
      if (!projectTitles.has(c.projectId)) {
        try {
          projectTitles.set(c.projectId, getProject(c.projectId).title)
        } catch {
          projectTitles.set(c.projectId, "(deleted)")
        }
      }
      return { ...c, projectTitle: projectTitles.get(c.projectId) ?? "" }
    })
  })

  app.get<{ Params: { id: string } }>("/api/clips/:id", async (req) => getClip(req.params.id))

  /** Everything the editor needs in one request. */
  app.get<{ Params: { id: string } }>("/api/clips/:id/context", async (req) => {
    const clip = getClip(req.params.id)
    // opening the editor on a face-framed clip without (current) face data starts detection
    ensureFaceDetection(clip)
    const project = getProject(clip.projectId)
    const a = await loadAnalysis(project.id)
    const faces = await loadFaces(clipFacesFile(clip))
    const candidate = clip.candidateId
      ? db.select().from(candidates).where(eq(candidates.id, clip.candidateId)).get()
      : undefined
    return {
      clip,
      project,
      candidate: candidate ? toCandidate(candidate) : null,
      transcript: a.transcript,
      audio: a.audio,
      scenes: a.scenes,
      faces,
      text: rangeText(a.transcript, { start: clip.start, end: clip.end }).text,
    }
  })

  const ClipPatch = z.object({
    name: z.string().min(1).optional(),
    start: z.number().min(0).optional(),
    end: z.number().optional(),
    editConfig: EditConfigSchema.optional(),
    metadata: ClipMetadataSchema.nullable().optional(),
  })
  app.patch<{ Params: { id: string } }>("/api/clips/:id", async (req) => {
    const body = ClipPatch.parse(req.body)
    const clip = getClip(req.params.id)
    const updated = updateClip(clip.id, body)
    // range, framing mode or sampling changed → (re)detect faces for the new setup
    ensureFaceDetection(updated)
    if (body.metadata && updated.renderPath && existsSync(updated.renderPath))
      await writeMetadataFiles(updated, updated.renderPath)
    return updated
  })

  app.delete<{ Params: { id: string } }>("/api/clips/:id", async (req) => {
    const clip = getClip(req.params.id)
    for (const j of queue.list({ clipId: clip.id }))
      if (j.status === "queued" || j.status === "running") queue.cancel(j.id)
    db.delete(clips).where(eq(clips.id, clip.id)).run()
    if (clip.candidateId)
      db.update(candidates)
        .set({ clipId: null, status: "new" })
        .where(eq(candidates.id, clip.candidateId))
        .run()
    await rm(projectPaths(clip.projectId).clipWorkDir(clip.id), { recursive: true, force: true })
    bus.emitEvent({ type: "candidates", projectId: clip.projectId })
    bus.emitEvent({ type: "clip", clipId: clip.id, projectId: clip.projectId })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>("/api/clips/:id/faces", async (req) => {
    const clip = getClip(req.params.id)
    const existing = queue.findActive("faces", { clipId: clip.id })
    if (existing) return existing
    return queue.enqueue({ type: "faces", projectId: clip.projectId, clipId: clip.id })
  })

  /** Queue a render, after missing emoji picks and face detection. */
  const enqueueRender = (clip: Clip) => {
    const existing = queue.findActive("render", { clipId: clip.id })
    if (existing) return existing
    const deps: string[] = []
    if (clipNeedsEmojiPicks(clip) && getLlm()) {
      const e =
        queue.findActive("emoji", { clipId: clip.id }) ??
        queue.enqueue({ type: "emoji", projectId: clip.projectId, clipId: clip.id })
      deps.push(e.id)
    }
    const faces = ensureFaceDetection(clip)
    if (faces) deps.push(faces.id)
    updateClip(clip.id, { status: "queued" })
    return queue.enqueue({
      type: "render",
      projectId: clip.projectId,
      clipId: clip.id,
      dependsOn: deps,
    })
  }

  /** Pre-render emoji choices: true/false switch hook or caption emojis on/off for this clip, omitted = keep. */
  const EmojiOptions = z.object({
    hookEmoji: z.boolean().optional(),
    captionEmoji: z.boolean().optional(),
    /** keep the hook on screen for the whole video */
    hookWholeVideo: z.boolean().optional(),
  })
  const applyEmojiOptions = (clip: Clip, o: z.infer<typeof EmojiOptions>): Clip => {
    if (o.hookEmoji === undefined && o.captionEmoji === undefined && o.hookWholeVideo === undefined)
      return clip
    const cfg = structuredClone(clip.editConfig)
    if (o.hookEmoji !== undefined) cfg.hook.emoji = o.hookEmoji
    if (o.captionEmoji !== undefined) cfg.captions.emoji = o.captionEmoji
    if (o.hookWholeVideo !== undefined) cfg.hook.wholeVideo = o.hookWholeVideo
    return updateClip(clip.id, { editConfig: cfg })
  }

  app.post<{ Params: { id: string } }>("/api/clips/:id/render", async (req) => {
    const opts = EmojiOptions.parse(req.body ?? {})
    return enqueueRender(applyEmojiOptions(getClip(req.params.id), opts))
  })

  /** Pick (or re-pick) emojis now with the LLM, e.g. from the editor to review them before rendering. */
  app.post<{ Params: { id: string } }>("/api/clips/:id/emojis", async (req) => {
    const clip = getClip(req.params.id)
    if (!getLlm())
      throw new HttpError(400, "Picking emojis needs an LLM — select Claude Code or Codex")
    return (
      queue.findActive("emoji", { clipId: clip.id }) ??
      queue.enqueue({
        type: "emoji",
        projectId: clip.projectId,
        clipId: clip.id,
        payload: { force: true },
      })
    )
  })

  /** Batch: render all approved clips of a project (optionally re-applying the default preset). */
  const BatchBody = z.object({
    applyDefaultPreset: z.boolean().default(false),
    onlyUnrendered: z.boolean().default(true),
    /** true/false = switch on/off for every clip in the batch, omitted = keep each clip's setting */
    hookEmoji: z.boolean().optional(),
    captionEmoji: z.boolean().optional(),
    hookWholeVideo: z.boolean().optional(),
  })
  app.post<{ Params: { id: string } }>("/api/projects/:id/render-all", async (req) => {
    const body = BatchBody.parse(req.body ?? {})
    const p = getProject(req.params.id)
    const rows = db.select().from(clips).where(eq(clips.projectId, p.id)).all().map(toClip)
    const out = []
    for (let c of rows) {
      if (body.onlyUnrendered && c.renderPath) continue
      if (body.applyDefaultPreset) {
        const cfg = defaultConfigForNewClip()
        cfg.hook.text = c.editConfig.hook.text
        c = updateClip(c.id, { editConfig: cfg })
      }
      c = applyEmojiOptions(c, {
        hookEmoji: body.hookEmoji,
        captionEmoji: body.captionEmoji,
        hookWholeVideo: body.hookWholeVideo,
      })
      out.push(enqueueRender(c))
    }
    return { queued: out.length }
  })

  app.post<{ Params: { id: string } }>("/api/clips/:id/metadata", async (req) => {
    const clip = getClip(req.params.id)
    return (
      queue.findActive("metadata", { clipId: clip.id }) ??
      queue.enqueue({ type: "metadata", projectId: clip.projectId, clipId: clip.id })
    )
  })

  app.post<{ Params: { id: string } }>("/api/clips/:id/hooks", async (req) =>
    hookAlternatives(req.params.id)
  )

  app.post<{ Params: { id: string } }>("/api/clips/:id/open-folder", async (req) => {
    const clip = getClip(req.params.id)
    const dir = clip.renderPath ? dirname(clip.renderPath) : projectPaths(clip.projectId).rendersDir
    openFolder(existsSync(dir) ? dir : projectPaths(clip.projectId).dir)
    return { ok: true, dir }
  })

  app.post<{ Params: { id: string } }>("/api/projects/:id/open-folder", async (req) => {
    const dir = projectPaths(getProject(req.params.id).id).dir
    openFolder(dir)
    return { ok: true, dir }
  })

  // render jobs across all projects (render queue page)
  app.get("/api/render-jobs", async () =>
    queue
      .list({ types: ["render", "faces", "metadata", "emoji"], limit: 200 })
      .map((j) => ({ ...j, log: j.log.slice(-6000) }))
  )
}

export function openFolder(dir: string) {
  const child = spawn("xdg-open", [dir], { detached: true, stdio: "ignore" })
  child.on("error", () => undefined)
  child.unref()
}
