import { z } from "zod"
import { EditConfigSchema } from "./edit"
import { ProbeInfoSchema } from "./media"

export const JOB_TYPES = [
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
  "faces",
  "render",
  "metadata",
  "emoji",
] as const
export const JobTypeSchema = z.enum(JOB_TYPES)
export type JobType = z.infer<typeof JobTypeSchema>

export const JobStatusSchema = z.enum(["queued", "running", "done", "failed", "canceled"])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const JobSchema = z.object({
  id: z.string(),
  type: JobTypeSchema,
  projectId: z.string().nullable(),
  clipId: z.string().nullable(),
  status: JobStatusSchema,
  /** 0..1 */
  progress: z.number(),
  log: z.string(),
  error: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()),
  attempts: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type Job = z.infer<typeof JobSchema>

export const ProjectStatusSchema = z.enum([
  "uploading",
  "downloading",
  "analyzing",
  "ready",
  "error",
])
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>

export const ProjectSettingsSchema = z.object({
  /** transcription language; the app targets English */
  language: z.literal("en").default("en"),
  /**
   * Who appears in the video, free text (e.g. "Aishah: the streamer, she/her"). Passed to every
   * LLM prompt so hooks and titles use the right names and pronouns.
   */
  people: z.string().max(2000).default(""),
})
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>

export const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceFile: z.string(),
  sourceUrl: z.string().nullable(),
  sizeBytes: z.number(),
  uploadedBytes: z.number(),
  status: ProjectStatusSchema,
  probe: ProbeInfoSchema.nullable(),
  settings: ProjectSettingsSchema,
  hasProxy: z.boolean(),
  hasThumbnail: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Project = z.infer<typeof ProjectSchema>

export type ProjectListItem = Project & {
  candidateCount: number
  renderedCount: number
  activeJobs: number
}

export const ClipStatusSchema = z.enum(["editing", "queued", "rendering", "rendered", "failed"])
export type ClipStatus = z.infer<typeof ClipStatusSchema>

export const ClipMetadataSchema = z.object({
  title: z.string(),
  altTitles: z.array(z.string()),
  description: z.string(),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()),
  source: z.enum(["llm", "template"]),
})
export type ClipMetadata = z.infer<typeof ClipMetadataSchema>

export const ClipSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  candidateId: z.string().nullable(),
  name: z.string(),
  start: z.number(),
  end: z.number(),
  editConfig: EditConfigSchema,
  status: ClipStatusSchema,
  renderPath: z.string().nullable(),
  renderedAt: z.string().nullable(),
  metadata: ClipMetadataSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Clip = z.infer<typeof ClipSchema>

export const PresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  config: EditConfigSchema,
  createdAt: z.string(),
})
export type Preset = z.infer<typeof PresetSchema>

/** A rendered video found on disk (Artifacts page) */
export const ArtifactSchema = z.object({
  file: z.string(),
  /** absolute path on disk */
  path: z.string(),
  /** path relative to the data dir (served under /files/) */
  url: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
  projectId: z.string(),
  projectTitle: z.string().nullable(),
  /** the clip that rendered it, when it is still the clip's current render */
  clipId: z.string().nullable(),
  title: z.string(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export const SystemStatusSchema = z.object({
  ffmpeg: z.object({ ok: z.boolean(), version: z.string().nullable(), nvenc: z.boolean() }),
  python: z.object({ ok: z.boolean(), path: z.string(), detail: z.string().nullable() }),
  ytdlp: z.object({ ok: z.boolean(), version: z.string().nullable() }),
  llm: z.object({
    provider: z.string(),
    model: z.string().nullable(),
    /** CLI availability, for the provider switcher */
    clis: z.object({ claude: z.string().nullable(), codex: z.string().nullable() }),
  }),
  dataDir: z.string(),
})
export type SystemStatus = z.infer<typeof SystemStatusSchema>

/** Server-sent event payloads */
export type ServerEvent =
  | { type: "job"; job: Job }
  | { type: "project"; projectId: string }
  | { type: "candidates"; projectId: string }
  | { type: "clip"; clipId: string; projectId: string }
