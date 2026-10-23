import { existsSync, mkdirSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { config } from "../config"

export function projectDir(projectId: string): string {
  return join(config.dataDir, "projects", projectId)
}

/** Well-known files inside a project folder. */
export function projectPaths(projectId: string) {
  const dir = projectDir(projectId)
  return {
    dir,
    proxy: join(dir, "proxy.mp4"),
    thumbnail: join(dir, "thumb.jpg"),
    audio16k: join(dir, "audio16k.wav"),
    audio48k: join(dir, "audio48k.flac"),
    transcript: join(dir, "transcript.json"),
    /** moments the LLM nominated from the full transcript */
    nominations: join(dir, "nominations.json"),
    audioAnalysis: join(dir, "audio_analysis.json"),
    /** audio model outputs: laughter, cheering, arousal, pitch... (workers/py/signals.py) */
    signals: join(dir, "signals.json"),
    /** video model outputs: motion and dance score (workers/py/visual.py) */
    visual: join(dir, "visual.json"),
    scenes: join(dir, "scenes.json"),
    heatmap: join(dir, "heatmap.json"),
    /** Twitch chat replay: raw messages + per-second activity */
    chatMessages: join(dir, "chat_messages.json"),
    chat: join(dir, "chat.json"),
    info: join(dir, "source.info.json"),
    pool: (batch: number) => join(dir, `candidates_pool_${batch}.json`),
    facesDir: join(dir, "faces"),
    rendersDir: join(dir, "renders"),
    clipWorkDir: (clipId: string) => join(dir, "renders", "work", clipId),
  }
}

export const musicDir = () => join(config.dataDir, "music")

/**
 * Bump when face detection changes so stale cached results are re-detected
 * (v2: YuNet became the default — MediaPipe's short-range model missed faces in wide shots).
 */
const FACES_CACHE_VERSION = 2

/** Cached face samples for a clip: its range plus a 1 s margin, at its sampling rate. */
export function clipFacesFile(clip: {
  projectId: string
  start: number
  end: number
  editConfig: { framing: { sampleEveryFrames: number } }
}): string {
  const start = Math.max(0, clip.start - 1)
  const end = clip.end + 1
  const every = clip.editConfig.framing.sampleEveryFrames
  return join(
    projectPaths(clip.projectId).facesDir,
    `${start.toFixed(2)}-${end.toFixed(2)}-e${every}-v${FACES_CACHE_VERSION}.json`
  )
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** URL under /files for a path inside the data dir */
export function fileUrl(absPath: string): string {
  return "/files/" + relative(config.dataDir, absPath).split("/").map(encodeURIComponent).join("/")
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return null
  }
}

/** Atomic JSON write (write temp + rename) so a crash never leaves a half-written cache file. */
export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(data))
  await rename(tmp, path)
}

export const nowIso = () => new Date().toISOString()

export function safeFileName(name: string): string {
  return (
    name
      .replace(/…/g, "")
      .normalize("NFKD")
      .replace(/[^\w\s.-]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/\.{2,}/g, "")
      .slice(0, 80) || "clip"
  )
}
