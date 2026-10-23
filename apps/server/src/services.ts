import { existsSync } from "node:fs"
import { and, desc, eq, inArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  parseTwitchVodId,
  rangeText,
  AppSettingsSchema,
  EditConfigSchema,
  ProjectSettingsSchema,
  type AppSettings,
  type AudioAnalysis,
  type AudioSignals,
  type Candidate,
  type Category,
  type Clip,
  type EditConfig,
  type FaceSamples,
  type ChatAnalysis,
  type Heatmap,
  type Job,
  type JobType,
  type Preset,
  type Project,
  type SceneCuts,
  type Transcript,
  type VisualSignals,
} from "@clipforge/shared"
import type { Db } from "./db"
import { candidates, clips, feedback, jobs, presets, projects, settings } from "./db/schema"
import { bus } from "./lib/events"
import { clipFacesFile, nowIso, projectPaths, readJson } from "./lib/paths"
import type { JobQueue } from "./jobs/queue"

export interface AppDeps {
  db: Db
  queue: JobQueue
}

let deps: AppDeps | null = null
export function setDeps(d: AppDeps) {
  deps = d
}
export function getDeps(): AppDeps {
  if (!deps) throw new Error("App dependencies not initialized")
  return deps
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

// ---------- projects ----------

export function toProject(r: typeof projects.$inferSelect): Project {
  return {
    ...r,
    status: r.status as Project["status"],
    probe: r.probe ?? null,
    settings: ProjectSettingsSchema.parse(r.settings ?? {}),
  }
}

export function getProject(id: string): Project {
  const r = getDeps().db.select().from(projects).where(eq(projects.id, id)).get()
  if (!r) throw new HttpError(404, "Project not found")
  return toProject(r)
}

export function updateProject(id: string, patch: Partial<typeof projects.$inferInsert>) {
  getDeps()
    .db.update(projects)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(projects.id, id))
    .run()
  bus.emitEvent({ type: "project", projectId: id })
}

const ANALYSIS_TYPES: JobType[] = [
  "download",
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
  "rank",
]

/** Derive project status from its analysis jobs. */
export function refreshProjectStatus(projectId: string) {
  const { db } = getDeps()
  const p = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!p || p.status === "uploading") return
  const js = db
    .select({ status: jobs.status, type: jobs.type })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), inArray(jobs.type, ANALYSIS_TYPES)))
    .all()
  let status: Project["status"] = "ready"
  if (js.some((j) => j.status === "running" || j.status === "queued")) {
    status = js.some(
      (j) => j.type === "download" && (j.status === "running" || j.status === "queued")
    )
      ? "downloading"
      : "analyzing"
  } else if (js.some((j) => j.status === "failed")) status = "error"
  if (status !== p.status) updateProject(projectId, { status })
}

/**
 * Enqueue the analysis pipeline. Each step caches its output, so re-running is cheap.
 * Returns the created jobs.
 */
export function enqueuePipeline(projectId: string, opts: { fromDownload?: string } = {}): Job[] {
  const { queue } = getDeps()
  const project = getProject(projectId)
  const base = opts.fromDownload ? [opts.fromDownload] : []
  const probe = queue.enqueue({ type: "probe", projectId, dependsOn: base })
  const proxy = queue.enqueue({ type: "proxy", projectId, dependsOn: [probe.id] })
  const audio = queue.enqueue({ type: "audio", projectId, dependsOn: [probe.id] })
  const transcribe = queue.enqueue({ type: "transcribe", projectId, dependsOn: [audio.id] })
  const features = queue.enqueue({ type: "audio_features", projectId, dependsOn: [audio.id] })
  const scenes = queue.enqueue({ type: "scenes", projectId, dependsOn: [proxy.id] })
  // audio models (laughter, cheering, arousal, pitch) run after Whisper so they don't compete for
  // GPU memory; video models (motion, dancing) decode the source in parallel with transcription
  const signals = queue.enqueue({
    type: "signals",
    projectId,
    dependsOn: [audio.id, transcribe.id],
  })
  const visual = queue.enqueue({ type: "visual", projectId, dependsOn: [probe.id] })
  // LLM reads the whole transcript and nominates moments (no-op without an LLM); it waits for the
  // audio signals (~30 s per hour of audio) so laughter/cheering show up in what it reads
  const nominate = queue.enqueue({
    type: "nominate",
    projectId,
    dependsOn: [transcribe.id, signals.id],
  })
  const all = [probe, proxy, audio, transcribe, features, signals, visual, scenes, nominate]
  // Scene cuts are only used for framing at render time, so candidates don't wait for the
  // proxy + scene pass (on long videos that used to delay candidates by half an hour).
  const candDeps = [transcribe.id, features.id, signals.id, visual.id, nominate.id]
  if (project.sourceUrl) {
    const heat = queue.enqueue({ type: "heatmap", projectId, dependsOn: base })
    all.push(heat)
    candDeps.push(heat.id)
  }
  if (parseTwitchVodId(project.sourceUrl)) {
    // chat replay doesn't need the video: runs in parallel with the download
    const chat = queue.enqueue({ type: "chat", projectId })
    all.push(chat)
    candDeps.push(chat.id)
  }
  const cand = queue.enqueue({
    type: "candidates",
    projectId,
    dependsOn: candDeps,
    payload: { batch: 0 },
  })
  const rank = queue.enqueue({
    type: "rank",
    projectId,
    dependsOn: [cand.id],
    payload: { batch: 0 },
  })
  all.push(cand, rank)
  refreshProjectStatus(projectId)
  return all
}

// ---------- analysis files ----------

export interface ProjectAnalysis {
  transcript: Transcript | null
  audio: AudioAnalysis | null
  scenes: SceneCuts | null
  heatmap: Heatmap | null
  chat: ChatAnalysis | null
  signals: AudioSignals | null
  visual: VisualSignals | null
}

export async function loadAnalysis(projectId: string): Promise<ProjectAnalysis> {
  const p = projectPaths(projectId)
  const [transcript, audio, scenes, heatmap, chat, signals, visual] = await Promise.all([
    readJson<Transcript>(p.transcript),
    readJson<AudioAnalysis>(p.audioAnalysis),
    readJson<SceneCuts>(p.scenes),
    readJson<Heatmap>(p.heatmap),
    readJson<ChatAnalysis>(p.chat),
    readJson<AudioSignals>(p.signals),
    readJson<VisualSignals>(p.visual),
  ])
  return { transcript, audio, scenes, heatmap, chat, signals, visual }
}

// ---------- settings ----------

export function getSettings(): AppSettings {
  const r = getDeps().db.select().from(settings).where(eq(settings.key, "app")).get()
  return AppSettingsSchema.parse(r?.value ?? {})
}

export function saveSettings(s: AppSettings) {
  const value = AppSettingsSchema.parse(s)
  getDeps()
    .db.insert(settings)
    .values({ key: "app", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
  return value
}

// ---------- candidates ----------

/**
 * Log an approve/reject (or undo/delete) decision with a snapshot of what ranking knew about the
 * candidate, so heuristic weights and the LLM blend can later be fitted to real choices.
 */
export async function recordFeedback(
  candidateId: string,
  decision: "approved" | "rejected" | "new" | "deleted"
) {
  const { db } = getDeps()
  const c = db.select().from(candidates).where(eq(candidates.id, candidateId)).get()
  if (!c) return
  const p = db.select().from(projects).where(eq(projects.id, c.projectId)).get()
  const a = await loadAnalysis(c.projectId).catch(() => null)
  const text = a ? rangeText(a.transcript, { start: c.start, end: c.end }).text : ""
  db.insert(feedback)
    .values({
      id: nanoid(10),
      candidateId,
      projectId: c.projectId,
      decision,
      snapshot: {
        candidate: c,
        durationSec: c.end - c.start,
        projectTitle: p?.title ?? "",
        sourceUrl: p?.sourceUrl ?? null,
        settings: getSettings().candidates,
        text,
      },
      createdAt: nowIso(),
    })
    .run()
}

export function toCandidate(
  r: typeof candidates.$inferSelect
): Candidate & { llmReason: string | null } {
  return {
    ...r,
    category: r.category as Category,
    status: r.status as Candidate["status"],
    source: r.source as Candidate["source"],
  }
}

export function listCandidates(projectId: string) {
  return getDeps()
    .db.select()
    .from(candidates)
    .where(eq(candidates.projectId, projectId))
    .orderBy(desc(candidates.finalRating))
    .all()
    .map(toCandidate)
}

// ---------- presets & clips ----------

export function toPreset(r: typeof presets.$inferSelect): Preset {
  return { ...r, config: EditConfigSchema.parse(r.config) }
}

export function defaultConfigForNewClip(): EditConfig {
  const s = getSettings()
  if (s.defaultPresetId) {
    const p = getDeps().db.select().from(presets).where(eq(presets.id, s.defaultPresetId)).get()
    if (p) return EditConfigSchema.parse(p.config)
  }
  return EditConfigSchema.parse({})
}

export function toClip(r: typeof clips.$inferSelect): Clip {
  return {
    ...r,
    status: r.status as Clip["status"],
    editConfig: EditConfigSchema.parse(r.editConfig ?? {}),
    metadata: r.metadata ?? null,
  }
}

export function getClip(id: string): Clip {
  const r = getDeps().db.select().from(clips).where(eq(clips.id, id)).get()
  if (!r) throw new HttpError(404, "Clip not found")
  return toClip(r)
}

export function updateClip(id: string, patch: Partial<typeof clips.$inferInsert>) {
  const { db } = getDeps()
  db.update(clips)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(clips.id, id))
    .run()
  const c = getClip(id)
  bus.emitEvent({ type: "clip", clipId: id, projectId: c.projectId })
  return c
}

/** Approving a candidate creates (or returns) its clip with the default style applied. */
export function createClipFromCandidate(candidateId: string): Clip {
  const { db } = getDeps()
  const c = db.select().from(candidates).where(eq(candidates.id, candidateId)).get()
  if (!c) throw new HttpError(404, "Candidate not found")
  if (c.clipId) {
    const existing = db.select().from(clips).where(eq(clips.id, c.clipId)).get()
    if (existing) {
      if (existing.start !== c.start || existing.end !== c.end)
        return withFaces(updateClip(existing.id, { start: c.start, end: c.end }))
      return withFaces(toClip(existing))
    }
  }
  const config = defaultConfigForNewClip()
  config.hook.text = c.suggestedHook
  const now = nowIso()
  const id = nanoid(10)
  db.insert(clips)
    .values({
      id,
      projectId: c.projectId,
      candidateId: c.id,
      name: c.suggestedTitle || `Clip ${Math.round(c.start)}s`,
      start: c.start,
      end: c.end,
      editConfig: config,
      status: "editing",
      renderPath: null,
      renderedAt: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.update(candidates).set({ clipId: id, status: "approved" }).where(eq(candidates.id, c.id)).run()
  bus.emitEvent({ type: "candidates", projectId: c.projectId })
  return withFaces(getClip(id))
}

/** Face framing modes need face samples for the clip's current range. */
export function clipNeedsFaces(clip: Clip): boolean {
  return clip.editConfig.framing.mode === "face-track" || clip.editConfig.framing.mode === "split"
}

/**
 * Always use face detection for face framing: queue it when the clip has no samples for its
 * current range/settings yet, so previews and renders never guess a crop. Idempotent.
 */
export function ensureFaceDetection(clip: Clip): Job | null {
  if (!clipNeedsFaces(clip) || existsSync(clipFacesFile(clip))) return null
  const { queue } = getDeps()
  return (
    queue.findActive("faces", { clipId: clip.id }) ??
    queue.enqueue({ type: "faces", projectId: clip.projectId, clipId: clip.id })
  )
}

function withFaces(clip: Clip): Clip {
  ensureFaceDetection(clip)
  return clip
}

export async function loadFaces(path: string): Promise<FaceSamples | null> {
  return existsSync(path) ? readJson<FaceSamples>(path) : null
}
