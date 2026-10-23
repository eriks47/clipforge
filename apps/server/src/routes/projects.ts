import { createWriteStream, existsSync } from "node:fs"
import { open, rm, stat } from "node:fs/promises"
import { extname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import { count, eq, inArray, isNotNull } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { nanoid } from "nanoid"
import { z } from "zod"
import { ProjectSettingsSchema, type JobType, type ProjectListItem } from "@clipforge/shared"
import { candidates, clips, jobs, projects } from "../db/schema"
import { bus } from "../lib/events"
import { ensureDir, nowIso, projectDir, projectPaths } from "../lib/paths"
import { clearStepCache } from "../jobs/handlers/analysis"
import {
  enqueuePipeline,
  getDeps,
  getProject,
  HttpError,
  loadAnalysis,
  toProject,
  updateProject,
} from "../services"

const ALLOWED_EXT = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v"])

export async function projectRoutes(app: FastifyInstance) {
  const { db, queue } = getDeps()

  app.get("/api/projects", async (): Promise<ProjectListItem[]> => {
    const rows = db.select().from(projects).all()
    const candCounts = new Map(
      db
        .select({ id: candidates.projectId, n: count() })
        .from(candidates)
        .groupBy(candidates.projectId)
        .all()
        .map((r) => [r.id, r.n])
    )
    const rendered = new Map(
      db
        .select({ id: clips.projectId, n: count() })
        .from(clips)
        .where(isNotNull(clips.renderPath))
        .groupBy(clips.projectId)
        .all()
        .map((r) => [r.id, r.n])
    )
    const active = new Map(
      db
        .select({ id: jobs.projectId, n: count() })
        .from(jobs)
        .where(inArray(jobs.status, ["queued", "running"]))
        .groupBy(jobs.projectId)
        .all()
        .map((r) => [r.id ?? "", r.n])
    )
    return rows
      .map(toProject)
      .map((p) => ({
        ...p,
        candidateCount: candCounts.get(p.id) ?? 0,
        renderedCount: rendered.get(p.id) ?? 0,
        activeJobs: active.get(p.id) ?? 0,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => getProject(req.params.id))

  const CreateBody = z.object({
    title: z.string().min(1),
    filename: z.string().min(1),
    size: z.number().int().positive(),
  })
  app.post("/api/projects", async (req) => {
    const body = CreateBody.parse(req.body)
    const ext = extname(body.filename).toLowerCase()
    if (!ALLOWED_EXT.has(ext))
      throw new HttpError(400, `Unsupported file type ${ext}. Use mp4 or webm.`)
    const id = nanoid(10)
    ensureDir(projectDir(id))
    const now = nowIso()
    db.insert(projects)
      .values({
        id,
        title: body.title,
        sourceFile: `source${ext}`,
        sourceUrl: null,
        sizeBytes: body.size,
        uploadedBytes: 0,
        status: "uploading",
        probe: null,
        settings: ProjectSettingsSchema.parse({}),
        hasProxy: false,
        hasThumbnail: false,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    bus.emitEvent({ type: "project", projectId: id })
    return getProject(id)
  })

  const ImportBody = z.object({ url: z.string().url() })
  app.post("/api/projects/import", async (req) => {
    const { url } = ImportBody.parse(req.body)
    const id = nanoid(10)
    ensureDir(projectDir(id))
    const now = nowIso()
    db.insert(projects)
      .values({
        id,
        title: url,
        sourceFile: "",
        sourceUrl: url,
        sizeBytes: 0,
        uploadedBytes: 0,
        status: "downloading",
        probe: null,
        settings: ProjectSettingsSchema.parse({}),
        hasProxy: false,
        hasThumbnail: false,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const dl = queue.enqueue({ type: "download", projectId: id })
    enqueuePipeline(id, { fromDownload: dl.id })
    return getProject(id)
  })

  // Resumable chunked upload: client asks for the current offset and PUTs chunks at that offset.
  app.get<{ Params: { id: string } }>("/api/projects/:id/upload", async (req) => {
    const p = getProject(req.params.id)
    const file = join(projectDir(p.id), p.sourceFile)
    const onDisk = existsSync(file) ? (await stat(file)).size : 0
    return { uploadedBytes: onDisk, sizeBytes: p.sizeBytes }
  })

  app.put<{ Params: { id: string }; Querystring: { offset: string } }>(
    "/api/projects/:id/upload",
    { bodyLimit: 1024 * 1024 * 1024 },
    async (req) => {
      const p = getProject(req.params.id)
      if (p.status !== "uploading") throw new HttpError(409, "Upload already completed")
      const offset = Number(req.query.offset)
      const file = join(projectDir(p.id), p.sourceFile)
      const current = existsSync(file) ? (await stat(file)).size : 0
      if (!Number.isInteger(offset) || offset !== current)
        throw new HttpError(409, `Offset mismatch: server has ${current} bytes`)
      if (!existsSync(file)) await (await open(file, "w")).close()
      await pipeline(req.body as Readable, createWriteStream(file, { flags: "r+", start: offset }))
      const size = (await stat(file)).size
      db.update(projects)
        .set({ uploadedBytes: size, updatedAt: nowIso() })
        .where(eq(projects.id, p.id))
        .run()
      return { uploadedBytes: size }
    }
  )

  app.post<{ Params: { id: string } }>("/api/projects/:id/upload/complete", async (req) => {
    const p = getProject(req.params.id)
    const file = join(projectDir(p.id), p.sourceFile)
    const size = existsSync(file) ? (await stat(file)).size : 0
    if (size !== p.sizeBytes)
      throw new HttpError(409, `Incomplete upload: ${size} of ${p.sizeBytes} bytes`)
    updateProject(p.id, { status: "analyzing", uploadedBytes: size })
    enqueuePipeline(p.id)
    return getProject(p.id)
  })

  const PatchBody = z.object({
    title: z.string().min(1).optional(),
    settings: ProjectSettingsSchema.partial().optional(),
  })
  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const { settings, ...rest } = PatchBody.parse(req.body)
    const p = getProject(req.params.id)
    updateProject(req.params.id, {
      ...rest,
      ...(settings
        ? { settings: ProjectSettingsSchema.parse({ ...p.settings, ...settings }) }
        : {}),
    })
    return getProject(req.params.id)
  })

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const p = getProject(req.params.id)
    queue.deleteForProject(p.id)
    db.delete(candidates).where(eq(candidates.projectId, p.id)).run()
    db.delete(clips).where(eq(clips.projectId, p.id)).run()
    db.delete(projects).where(eq(projects.id, p.id)).run()
    await rm(projectDir(p.id), { recursive: true, force: true })
    bus.emitEvent({ type: "project", projectId: p.id })
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id/analysis", async (req) => {
    const p = getProject(req.params.id)
    return loadAnalysis(p.id)
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id/jobs", async (req) =>
    queue.list({ projectId: req.params.id }).map((j) => ({ ...j, log: j.log.slice(-20000) }))
  )

  // Re-run one analysis step (clears its cache) and everything downstream of it.
  const RERUNNABLE: JobType[] = [
    "probe",
    "proxy",
    "audio",
    "transcribe",
    "nominate",
    "audio_features",
    "signals",
    "visual",
    "scenes",
    "heatmap",
    "chat",
    "candidates",
  ]
  app.post<{ Params: { id: string; type: string } }>(
    "/api/projects/:id/steps/:type/rerun",
    async (req) => {
      const p = getProject(req.params.id)
      const type = req.params.type as JobType
      if (!RERUNNABLE.includes(type)) throw new HttpError(400, "Step cannot be re-run")
      if (
        queue.list({ projectId: p.id }).some((j) => j.status === "running" || j.status === "queued")
      )
        throw new HttpError(409, "Wait for running jobs to finish")
      await clearStepCache(p.id, type)
      const order: JobType[] = [
        "probe",
        "proxy",
        "audio",
        "transcribe",
        "nominate",
        "audio_features",
        "signals",
        "visual",
        "scenes",
        "heatmap",
        "chat",
      ]
      const downstream: Record<string, JobType[]> = {
        audio: ["transcribe", "nominate", "audio_features", "signals"],
        transcribe: ["nominate"],
        // the nominate prompt includes laughter / cheering tags
        signals: ["nominate"],
        proxy: ["scenes"],
      }
      for (const d of downstream[type] ?? []) await clearStepCache(p.id, d)
      // the whole pipeline (cached steps finish instantly), so steps added since the project was
      // analysed (e.g. audio/visual signals) run before candidates are regenerated
      if (type === "candidates" || order.includes(type)) enqueuePipeline(p.id)
      return { ok: true }
    }
  )

  app.get<{ Params: { id: string } }>("/api/projects/:id/status-files", async (req) => {
    const paths = projectPaths(req.params.id)
    return {
      proxy: existsSync(paths.proxy),
      transcript: existsSync(paths.transcript),
      audio: existsSync(paths.audioAnalysis),
      scenes: existsSync(paths.scenes),
      heatmap: existsSync(paths.heatmap),
      chat: existsSync(paths.chat),
      signals: existsSync(paths.signals),
      visual: existsSync(paths.visual),
    }
  })
}
