import { existsSync } from "node:fs"
import { join } from "node:path"
import { AudioSignalsSchema, VisualSignalsSchema } from "@clipforge/shared"
import { config } from "../../config"
import { canGpuDecode } from "../../lib/ffmpeg"
import { projectPaths, readJson } from "../../lib/paths"
import { CanceledError } from "../../lib/proc"
import { runPythonWorker } from "../../lib/python"
import { getProject } from "../../services"
import type { JobContext } from "../queue"

/**
 * Model outputs are an extra: when a worker fails (no torch, no GPU memory, model download
 * failed) the pipeline continues without them, and nothing is cached so a re-run tries again.
 */
async function optional(ctx: JobContext, what: string, fn: () => Promise<void>) {
  try {
    await fn()
  } catch (e) {
    if (e instanceof CanceledError || ctx.signal.aborted) throw e
    ctx.log(
      `${what} failed, continuing without it: ${e instanceof Error ? e.message.slice(0, 500) : String(e)}`
    )
  }
}

/** Laughter / cheering / singing tags, voice arousal, pitch and vocal effort over the whole audio. */
export async function signalsHandler(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const paths = projectPaths(getProject(ctx.job.projectId).id)
  if (existsSync(paths.signals)) {
    ctx.log("Audio signals already exist, skipping")
    return
  }
  if (!existsSync(paths.audio16k)) {
    ctx.log("No audio track: skipping audio signals")
    return
  }
  await optional(ctx, "Audio signal analysis", async () => {
    const res = await runPythonWorker(
      "signals.py",
      ["--audio", paths.audio16k, "--out", paths.signals, "--device", config.whisper.device],
      { log: ctx.log, progress: ctx.progress },
      { signal: ctx.signal }
    )
    const parsed = AudioSignalsSchema.safeParse(await readJson(paths.signals))
    if (!parsed.success) throw new Error(`invalid output: ${parsed.error.message.slice(0, 300)}`)
    ctx.log(
      `Audio signals on ${String(res.device ?? "?")}: ${Object.keys(parsed.data.tracks).join(", ")}`
    )
  })
}

/** Motion curve and X-CLIP dance score from one low-resolution decode of the video. */
export async function visualHandler(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const project = getProject(ctx.job.projectId)
  const paths = projectPaths(project.id)
  if (existsSync(paths.visual)) {
    ctx.log("Visual signals already exist, skipping")
    return
  }
  const probe = project.probe
  if (!probe) throw new Error("Project has not been probed")
  // an existing proxy (H.264, 720p) decodes faster than most sources
  const useProxy = existsSync(paths.proxy)
  const video = useProxy ? paths.proxy : join(paths.dir, project.sourceFile)
  const codec = useProxy ? "h264" : probe.videoCodec
  const gpu = await canGpuDecode(useProxy ? { videoCodec: "h264", rotation: 0 } : probe)
  await optional(ctx, "Visual signal analysis", async () => {
    await runPythonWorker(
      "visual.py",
      [
        "--video",
        video,
        "--out",
        paths.visual,
        "--duration",
        String(probe.duration),
        "--ffmpeg",
        config.ffmpeg,
        "--codec",
        codec,
        "--device",
        config.whisper.device,
        ...(gpu ? ["--gpu-decode"] : []),
      ],
      { log: ctx.log, progress: ctx.progress },
      { signal: ctx.signal }
    )
    const parsed = VisualSignalsSchema.safeParse(await readJson(paths.visual))
    if (!parsed.success) throw new Error(`invalid output: ${parsed.error.message.slice(0, 300)}`)
    ctx.log(`Visual signals: motion${parsed.data.dance ? " + dance score" : " only (no X-CLIP)"}`)
  })
}
