import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { JobType } from "@clipforge/shared"

export const ROOT_DIR = resolve(import.meta.dirname, "../../..")

/** Minimal .env loader (no dependency); real env vars win. */
function loadDotEnv() {
  const file = resolve(ROOT_DIR, ".env")
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trimStart().startsWith("#")) continue
    const raw = m[2].trim()
    // quoted values are taken literally; unquoted ones may carry a trailing "# comment"
    const quoted = /^(["'])(.*)\1$/.exec(raw)
    const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "")
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}
loadDotEnv()

const env = process.env

const DEFAULT_CONCURRENCY: Partial<Record<JobType, number>> = {
  download: 1,
  probe: 2,
  proxy: 2,
  audio: 2,
  transcribe: 1,
  nominate: 1,
  audio_features: 2,
  // GPU models: one at a time
  signals: 1,
  visual: 1,
  scenes: 1,
  heatmap: 2,
  chat: 1,
  candidates: 1,
  rank: 1,
  faces: 1,
  render: 1,
  metadata: 2,
  emoji: 2,
}

function parseConcurrency(): Partial<Record<JobType, number>> {
  if (!env.JOB_CONCURRENCY) return DEFAULT_CONCURRENCY
  try {
    return {
      ...DEFAULT_CONCURRENCY,
      ...(JSON.parse(env.JOB_CONCURRENCY) as Partial<Record<JobType, number>>),
    }
  } catch {
    console.warn("Invalid JOB_CONCURRENCY, using defaults")
    return DEFAULT_CONCURRENCY
  }
}

export const config = {
  port: Number(env.PORT ?? 5174),
  host: env.HOST ?? "127.0.0.1",
  dataDir: resolve(ROOT_DIR, env.DATA_DIR ?? "data"),
  ffmpeg: env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe: env.FFPROBE_PATH ?? "ffprobe",
  ytdlp: env.YTDLP_PATH ?? "yt-dlp",
  python: resolve(ROOT_DIR, env.PYTHON_PATH ?? "workers/py/.venv/bin/python"),
  pyWorkersDir: resolve(ROOT_DIR, "workers/py"),
  concurrency: parseConcurrency(),
  render: {
    /**
     * Chromium GL backend for Remotion renders. "angle" lets headless Chrome draw on the GPU
     * (~2× faster here than the software default); "swangle" = CPU only; "default" = Chrome decides.
     */
    gl: (env.REMOTION_GL ?? "angle") as
      "angle" | "egl" | "vulkan" | "angle-egl" | "swangle" | "swiftshader" | "default",
    /** parallel browser tabs; with the GPU doing the drawing, ~3 beats more (they contend for it) */
    concurrency: env.RENDER_CONCURRENCY ? Number(env.RENDER_CONCURRENCY) : 3,
  },
  whisper: {
    modelGpu: env.WHISPER_MODEL_GPU ?? "large-v3-turbo",
    modelCpu: env.WHISPER_MODEL_CPU ?? "small.en",
    device: env.WHISPER_DEVICE ?? "auto",
  },
  llm: {
    /** none | claude | codex — local CLI agents using your existing login, no API keys */
    provider: (env.LLM_PROVIDER ?? "none").toLowerCase(),
    claudeBin: env.CLAUDE_PATH ?? "claude",
    /** empty = the CLI's default model */
    claudeModel: env.CLAUDE_MODEL ?? "",
    codexBin: env.CODEX_PATH ?? "codex",
    codexModel: env.CODEX_MODEL ?? "",
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 300000),
  },
}

export type Config = typeof config
