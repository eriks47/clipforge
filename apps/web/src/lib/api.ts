import type {
  Artifact,
  AppSettings,
  AudioAnalysis,
  Candidate,
  Clip,
  ClipMetadata,
  EditConfig,
  FaceSamples,
  ChatAnalysis,
  AudioSignals,
  VisualSignals,
  WeightSuggestion,
  Heatmap,
  Job,
  LlmSettings,
  Preset,
  Project,
  ProjectListItem,
  SceneCuts,
  SystemStatus,
  Transcript,
} from "@clipforge/shared"

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = (await res.json()) as { error?: string }
      if (j.error) msg = j.error
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, msg)
  }
  return (await res.json()) as T
}

export type CandidateRow = Candidate & { llmReason: string | null }
export type ClipWithProject = Clip & { projectTitle: string }

export interface Analysis {
  transcript: Transcript | null
  audio: AudioAnalysis | null
  scenes: SceneCuts | null
  heatmap: Heatmap | null
  chat: ChatAnalysis | null
  signals: AudioSignals | null
  visual: VisualSignals | null
}

export interface ClipContext {
  clip: Clip
  project: Project
  candidate: CandidateRow | null
  transcript: Transcript | null
  audio: AudioAnalysis | null
  scenes: SceneCuts | null
  faces: FaceSamples | null
  text: string
}

export const api = {
  system: () => req<SystemStatus>("GET", "/api/system"),
  projects: () => req<ProjectListItem[]>("GET", "/api/projects"),
  project: (id: string) => req<Project>("GET", `/api/projects/${id}`),
  createProject: (b: { title: string; filename: string; size: number }) =>
    req<Project>("POST", "/api/projects", b),
  importUrl: (url: string) =>
    req<Project>("POST", "/api/projects/import", { url }),
  uploadStatus: (id: string) =>
    req<{ uploadedBytes: number; sizeBytes: number }>(
      "GET",
      `/api/projects/${id}/upload`
    ),
  completeUpload: (id: string) =>
    req<Project>("POST", `/api/projects/${id}/upload/complete`),
  patchProject: (
    id: string,
    b: { title?: string; settings?: Partial<Project["settings"]> }
  ) => req<Project>("PATCH", `/api/projects/${id}`, b),
  deleteProject: (id: string) =>
    req<{ ok: true }>("DELETE", `/api/projects/${id}`),
  analysis: (id: string) =>
    req<Analysis>("GET", `/api/projects/${id}/analysis`),
  projectJobs: (id: string) => req<Job[]>("GET", `/api/projects/${id}/jobs`),
  rerunStep: (id: string, type: string) =>
    req<{ ok: true }>("POST", `/api/projects/${id}/steps/${type}/rerun`),
  openProjectFolder: (id: string) =>
    req<{ ok: true }>("POST", `/api/projects/${id}/open-folder`),

  candidates: (projectId: string) =>
    req<CandidateRow[]>("GET", `/api/projects/${projectId}/candidates`),
  moreCandidates: (projectId: string) =>
    req<{ batch: number }>(
      "POST",
      `/api/projects/${projectId}/candidates/more`
    ),
  manualCandidate: (projectId: string, r: { start: number; end: number }) =>
    req<CandidateRow>("POST", `/api/projects/${projectId}/candidates`, r),
  patchCandidate: (
    id: string,
    b: Partial<Pick<Candidate, "start" | "end" | "status" | "suggestedHook">>
  ) =>
    req<{ candidate: CandidateRow; clip: Clip | null }>(
      "PATCH",
      `/api/candidates/${id}`,
      b
    ),
  deleteCandidate: (id: string) =>
    req<{ ok: true }>("DELETE", `/api/candidates/${id}`),

  clips: () => req<ClipWithProject[]>("GET", "/api/clips"),
  projectClips: (projectId: string) =>
    req<Clip[]>("GET", `/api/projects/${projectId}/clips`),
  clipContext: (id: string) =>
    req<ClipContext>("GET", `/api/clips/${id}/context`),
  patchClip: (
    id: string,
    b: {
      name?: string
      start?: number
      end?: number
      editConfig?: EditConfig
      metadata?: ClipMetadata | null
    }
  ) => req<Clip>("PATCH", `/api/clips/${id}`, b),
  deleteClip: (id: string) => req<{ ok: true }>("DELETE", `/api/clips/${id}`),
  trackFaces: (id: string) => req<Job>("POST", `/api/clips/${id}/faces`),
  renderClip: (id: string) => req<Job>("POST", `/api/clips/${id}/render`, {}),
  /** pick (or re-pick) hook + caption emojis with the LLM now */
  pickEmojis: (id: string) => req<Job>("POST", `/api/clips/${id}/emojis`),
  renderAll: (
    projectId: string,
    b: {
      applyDefaultPreset?: boolean
      onlyUnrendered?: boolean
      /** true/false = on/off for every clip, omitted = keep each clip's */
      hookEmoji?: boolean
      captionEmoji?: boolean
      hookWholeVideo?: boolean
    }
  ) =>
    req<{ queued: number }>("POST", `/api/projects/${projectId}/render-all`, b),
  generateMetadata: (id: string) =>
    req<Job>("POST", `/api/clips/${id}/metadata`),
  hookAlternatives: (id: string) =>
    req<{ hooks: string[]; source: "llm" | "template" }>(
      "POST",
      `/api/clips/${id}/hooks`
    ),
  openClipFolder: (id: string) =>
    req<{ ok: true; dir: string }>("POST", `/api/clips/${id}/open-folder`),
  renderJobs: () => req<Job[]>("GET", "/api/render-jobs"),
  artifacts: () => req<Artifact[]>("GET", "/api/artifacts"),
  openArtifactFolder: (projectId: string) =>
    req<{ ok: boolean; dir: string }>(
      "POST",
      `/api/artifacts/${projectId}/open-folder`
    ),

  cancelJob: (id: string) => req<Job>("POST", `/api/jobs/${id}/cancel`),
  retryJob: (id: string) => req<Job>("POST", `/api/jobs/${id}/retry`),
  skipJob: (id: string) => req<Job>("POST", `/api/jobs/${id}/skip`),

  settings: () => req<AppSettings>("GET", "/api/settings"),
  saveSettings: (s: AppSettings) => req<AppSettings>("PUT", "/api/settings", s),
  learnedWeights: () =>
    req<WeightSuggestion>("GET", "/api/settings/learned-weights"),
  setLlm: (b: Partial<LlmSettings>) =>
    req<AppSettings>("PATCH", "/api/settings/llm", b),
  testLlm: (b: { provider: "claude" | "codex"; model?: string }) =>
    req<{ ok: boolean; ms: number; sample?: string; error?: string }>(
      "POST",
      "/api/llm/test",
      b
    ),

  presets: () => req<Preset[]>("GET", "/api/presets"),
  createPreset: (b: {
    name: string
    config: EditConfig
    makeDefault?: boolean
  }) => req<Preset>("POST", "/api/presets", b),
  patchPreset: (id: string, b: { name?: string; makeDefault?: boolean }) =>
    req<Preset>("PATCH", `/api/presets/${id}`, b),
  deletePreset: (id: string) =>
    req<{ ok: true }>("DELETE", `/api/presets/${id}`),

  music: () => req<string[]>("GET", "/api/music"),
  uploadMusic: async (file: File) => {
    const res = await fetch(
      `/api/music?name=${encodeURIComponent(file.name)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      }
    )
    if (!res.ok) throw new ApiError(res.status, "Upload failed")
    return (await res.json()) as { name: string }
  },
  deleteMusic: (name: string) =>
    req<{ ok: true }>("DELETE", `/api/music/${encodeURIComponent(name)}`),
}

/** Public URL of a file inside the data dir */
export const fileUrl = (rel: string) =>
  `/files/${rel.split("/").map(encodeURIComponent).join("/")}`
export const proxyUrl = (projectId: string) =>
  fileUrl(`projects/${projectId}/proxy.mp4`)
export const thumbUrl = (projectId: string) =>
  fileUrl(`projects/${projectId}/thumb.jpg`)
export const renderUrl = (renderPath: string | null): string | null => {
  if (!renderPath) return null
  const i = renderPath.indexOf("/projects/")
  return i >= 0 ? fileUrl(renderPath.slice(i + 1)) : null
}
