import { existsSync } from "node:fs"
import { join } from "node:path"
import { TranscriptSchema, type Transcript } from "@clipforge/shared"
import { config } from "../../config"
import { clipFacesFile, ensureDir, projectPaths, readJson, writeJson } from "../../lib/paths"
import { runPythonWorker } from "../../lib/python"
import { getClip, getProject } from "../../services"
import type { JobContext } from "../queue"

export async function transcribeHandler(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const project = getProject(ctx.job.projectId)
  const paths = projectPaths(project.id)
  if (existsSync(paths.transcript)) {
    ctx.log("Transcript already exists, skipping")
    return
  }
  if (!existsSync(paths.audio16k)) {
    ctx.log("No audio track: writing an empty transcript")
    const empty: Transcript = { language: "en", words: [], segments: [] }
    await writeJson(paths.transcript, empty)
    return
  }
  const res = await runPythonWorker(
    "transcribe.py",
    [
      "--audio",
      paths.audio16k,
      "--out",
      paths.transcript,
      "--language",
      project.settings.language,
      "--model-gpu",
      config.whisper.modelGpu,
      "--model-cpu",
      config.whisper.modelCpu,
      "--device",
      config.whisper.device,
    ],
    { log: ctx.log, progress: ctx.progress },
    { signal: ctx.signal }
  )
  // validate what the worker wrote
  const t = TranscriptSchema.safeParse(await readJson(paths.transcript))
  if (!t.success) throw new Error(`Transcript validation failed: ${t.error.message.slice(0, 500)}`)
  ctx.log(
    `Transcribed on ${String(res.device ?? "?")} with ${String(res.model ?? "?")}: ${t.data.words.length} words`
  )
}

/** Face samples for a clip range (+1 s margin), cached per range. */
export async function facesHandler(ctx: JobContext) {
  if (!ctx.job.clipId) throw new Error("Job has no clip")
  const clip = getClip(ctx.job.clipId)
  const paths = projectPaths(clip.projectId)
  const project = getProject(clip.projectId)
  const every = clip.editConfig.framing.sampleEveryFrames
  const start = Math.max(0, clip.start - 1)
  const end = clip.end + 1
  const out = clipFacesFile(clip)
  if (existsSync(out)) {
    ctx.log("Face samples already exist for this range")
    return
  }
  ensureDir(paths.facesDir)
  const video = existsSync(paths.proxy) ? paths.proxy : join(paths.dir, project.sourceFile)
  await runPythonWorker(
    "faces.py",
    [
      "--video",
      video,
      "--start",
      String(start),
      "--end",
      String(end),
      "--every",
      String(every),
      "--out",
      out,
      "--detector",
      process.env.FACE_DETECTOR ?? "auto",
    ],
    { log: ctx.log, progress: ctx.progress },
    { signal: ctx.signal, timeoutMs: 3600 * 1000 }
  )
}
