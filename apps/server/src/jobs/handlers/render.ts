import { existsSync } from "node:fs"
import { copyFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  makeCancelSignal,
  renderMedia,
  selectComposition,
  type ChromiumOptions,
} from "@remotion/renderer"
import {
  BLUR_BG_HEIGHT,
  blurBackgroundSigma,
  buildClipRenderProps,
  rangeText,
  templateMetadata,
  type Clip,
  type ClipMetadata,
} from "@clipforge/shared"
import { COMPOSITION_ID } from "@clipforge/remotion"
import { config } from "../../config"
import { ffmpegWithProgress, h264Args } from "../../lib/ffmpeg"
import {
  clipFacesFile,
  ensureDir,
  musicDir,
  nowIso,
  projectPaths,
  safeFileName,
} from "../../lib/paths"
import { CanceledError, run } from "../../lib/proc"
import { getLlm } from "../../llm"
import { ensureRemotionBrowser, getBundle } from "../../render/bundle"
import {
  getClip,
  getProject,
  getSettings,
  loadAnalysis,
  loadFaces,
  updateClip,
} from "../../services"
import type { JobContext } from "../queue"

/** Base URL the headless browser uses to fetch media from this server. */
let mediaBase = `http://127.0.0.1:${config.port}`
export function setMediaBase(url: string) {
  mediaBase = url
}

const fileUrl = (rel: string) =>
  `${mediaBase}/files/${rel.split("/").map(encodeURIComponent).join("/")}`

interface LoudnormStats {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

async function measureLoudness(
  file: string,
  target: number,
  signal: AbortSignal
): Promise<LoudnormStats | null> {
  let stderr = ""
  await run(
    config.ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    {
      signal,
      stderrTailChars: 20000,
      onStderrLine: (l) => (stderr += l + "\n"),
    }
  )
  const m = /\{[\s\S]*"input_i"[\s\S]*?\}/.exec(stderr)
  if (!m) return null
  return JSON.parse(m[0]) as LoudnormStats
}

export function clipBaseName(clip: Clip): string {
  return `${safeFileName(clip.name)}_${clip.id}`
}

export async function writeMetadataFiles(clip: Clip, mp4Path: string) {
  if (!clip.metadata) return
  const base = mp4Path.replace(/\.mp4$/, "")
  const md = clip.metadata
  await writeFile(`${base}.json`, JSON.stringify(md, null, 2))
  const txt = [
    md.title,
    "",
    md.description,
    "",
    md.hashtags.join(" "),
    "",
    `Tags: ${md.tags.join(", ")}`,
    "",
    "Alternative titles:",
    ...md.altTitles.map((t) => `- ${t}`),
  ].join("\n")
  await writeFile(`${base}.txt`, txt)
}

async function exportCopy(clip: Clip, mp4: string, log: (s: string) => void) {
  const dir = getSettings().exportDir.trim()
  if (!dir) return
  try {
    ensureDir(dir)
    const dest = join(dir, mp4.split("/").pop() ?? "clip.mp4")
    await copyFile(mp4, dest)
    if (clip.metadata) await writeMetadataFiles(clip, dest)
    log(`Copied to export directory ${dest}`)
  } catch (e) {
    log(`Export copy failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function renderHandler(ctx: JobContext) {
  if (!ctx.job.clipId) throw new Error("Job has no clip")
  let clip = getClip(ctx.job.clipId)
  const project = getProject(clip.projectId)
  if (!project.probe) throw new Error("Project not probed")
  const paths = projectPaths(project.id)
  const work = ensureDir(paths.clipWorkDir(clip.id))
  ensureDir(paths.rendersDir)
  updateClip(clip.id, { status: "rendering" })

  try {
    const analysis = await loadAnalysis(project.id)
    const cfg = clip.editConfig
    let faces = null
    if (cfg.framing.mode === "face-track" || cfg.framing.mode === "split") {
      faces = await loadFaces(clipFacesFile(clip))
      if (!faces)
        ctx.log(
          "No face samples for this clip (run face tracking in the editor) — framing falls back to centre"
        )
    }

    // 1. Pre-cut the source to the clip range so the renderer never seeks through the full file.
    const margin = 1
    const cutStart = Math.max(0, clip.start - margin)
    const cutEnd = Math.min(project.probe.duration, clip.end + margin)
    const precut = join(work, "precut.mp4")
    const src = join(paths.dir, project.sourceFile)
    ctx.log(`Pre-cutting ${cutStart.toFixed(2)}–${cutEnd.toFixed(2)} s`)
    const maxH = Math.min(project.probe.height, 2160)
    await ffmpegWithProgress(
      [
        "-ss",
        cutStart.toFixed(3),
        "-i",
        src,
        "-t",
        (cutEnd - cutStart).toFixed(3),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        `scale=-2:${maxH}`,
        ...(await h264Args({ quality: 16, gop: 15, preset: "quality" })),
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-movflags",
        "+faststart",
        precut,
      ],
      cutEnd - cutStart,
      (p) => ctx.progress(p * 0.1),
      { signal: ctx.signal }
    )

    const videoW = Math.round((project.probe.width * maxH) / project.probe.height / 2) * 2

    // 2. Build props with the shared function (same one the editor preview uses).
    const musicFile =
      cfg.extras.music.enabled && cfg.extras.music.file
        ? join(musicDir(), cfg.extras.music.file)
        : null
    const props = buildClipRenderProps({
      range: { start: clip.start, end: clip.end },
      config: cfg,
      transcript: analysis.transcript,
      analysis: analysis.audio,
      faces,
      scenes: analysis.scenes,
      probe: project.probe,
      video: {
        src: fileUrl(`projects/${project.id}/renders/work/${clip.id}/precut.mp4`),
        fileOffset: cutStart,
        width: videoW,
        height: maxH,
      },
      musicSrc:
        musicFile && existsSync(musicFile) ? fileUrl(`music/${cfg.extras.music.file}`) : null,
      preview: false,
    })
    const { plan, ...inputProps } = props

    // Blur-fill: blurring a second full-res copy in Chrome is the slowest part of a render.
    // ffmpeg makes a tiny pre-blurred background once (same timing as the pre-cut) instead.
    if (inputProps.framing.mode === "blur-fill") {
      const bgH = BLUR_BG_HEIGHT
      const bgW = Math.round((videoW * bgH) / maxH / 2) * 2
      const sigma = blurBackgroundSigma(cfg.framing.blurAmount, { width: bgW, height: bgH })
      ctx.log(`Pre-blurring the background (${bgW}x${bgH}, sigma ${sigma.toFixed(1)})`)
      await run(
        config.ffmpeg,
        [
          "-hide_banner",
          "-v",
          "error",
          "-y",
          "-i",
          precut,
          "-an",
          "-vf",
          `scale=${bgW}:${bgH},gblur=sigma=${sigma.toFixed(2)}`,
          ...(await h264Args({ quality: 23, gop: 15 })),
          join(work, "bg.mp4"),
        ],
        { signal: ctx.signal, timeoutMs: 600000 }
      )
      inputProps.framing.background = {
        src: fileUrl(`projects/${project.id}/renders/work/${clip.id}/bg.mp4`),
        width: bgW,
        height: bgH,
      }
    }
    ctx.log(
      `EDL: ${plan.edl.length} segments, ${plan.cuts.filter((c) => c.active).length} cuts, output ${plan.duration.toFixed(2)} s @ ${props.fps} fps`
    )

    // 3. Render with Remotion
    await ensureRemotionBrowser(ctx.log)
    const serveUrl = await getBundle(ctx.log)
    ctx.checkCanceled()
    const raw = join(work, "raw.mp4")
    const { cancelSignal, cancel } = makeCancelSignal()
    ctx.signal.addEventListener("abort", () => cancel(), { once: true })
    const renderWith = async (gl: ChromiumOptions["gl"]) => {
      const chromiumOptions: ChromiumOptions = { gl }
      const composition = await selectComposition({
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
        chromiumOptions,
      })
      const started = Date.now()
      await renderMedia({
        composition,
        serveUrl,
        codec: "h264",
        outputLocation: raw,
        inputProps,
        crf: 18,
        x264Preset: "medium",
        pixelFormat: "yuv420p",
        audioCodec: "aac",
        audioBitrate: "320k",
        concurrency: config.render.concurrency,
        chromiumOptions,
        cancelSignal,
        logLevel: "warn",
        onProgress: ({ progress, renderedFrames }) => {
          ctx.progress(0.1 + progress * 0.8)
          if (renderedFrames % 150 === 0 && renderedFrames > 0) {
            const fpsRate = renderedFrames / ((Date.now() - started) / 1000)
            ctx.log(
              `rendered ${renderedFrames}/${composition.durationInFrames} frames (${fpsRate.toFixed(1)} fps)`
            )
          }
        },
      })
      ctx.log(
        `Rendered ${composition.durationInFrames} frames in ${((Date.now() - started) / 1000).toFixed(1)} s`
      )
    }
    const gl = config.render.gl === "default" ? null : config.render.gl
    ctx.log(`Rendering with Chromium GL "${gl ?? "default"}", ${config.render.concurrency} tabs`)
    try {
      await renderWith(gl)
    } catch (e) {
      // a GPU backend that doesn't work on this machine: fall back to CPU rendering once
      if (ctx.signal.aborted || gl === "swangle" || gl === null) throw e
      ctx.log(
        `GPU rendering failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); retrying on the CPU`
      )
      await renderWith("swangle")
    }
    ctx.checkCanceled()

    // 4. Loudness normalisation (two-pass loudnorm), H.264 stream copied, faststart.
    const outName = `${clipBaseName(clip)}.mp4`
    const outPath = join(paths.rendersDir, outName)
    const tmpOut = outPath + ".tmp.mp4"
    const target = cfg.audio.targetLufs
    let af: string[] = []
    if (cfg.audio.loudnorm) {
      ctx.log(`Measuring loudness (target ${target} LUFS)`)
      const m = await measureLoudness(raw, target, ctx.signal)
      if (m && Number.isFinite(Number(m.input_i))) {
        ctx.log(`Input ${m.input_i} LUFS, TP ${m.input_tp}`)
        af = [
          "-af",
          `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
        ]
      } else ctx.log("Loudness measurement unavailable (silent audio?) — skipping normalisation")
    }
    await ffmpegWithProgress(
      [
        "-i",
        raw,
        "-map",
        "0",
        "-c:v",
        "copy",
        ...af,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        tmpOut,
      ],
      plan.duration,
      (p) => ctx.progress(0.9 + p * 0.09),
      {
        signal: ctx.signal,
      }
    )
    await rename(tmpOut, outPath)
    await rm(raw, { force: true })

    clip = updateClip(clip.id, { status: "rendered", renderPath: outPath, renderedAt: nowIso() })
    // Template metadata so every render has something; LLM metadata via the metadata job.
    if (!clip.metadata) {
      const text = rangeText(analysis.transcript, { start: clip.start, end: clip.end }).text
      const md: ClipMetadata = templateMetadata({
        transcript: text,
        hook: cfg.hook.text,
        title: clip.name,
        category: "other",
        sourceTitle: project.title,
      })
      clip = updateClip(clip.id, { metadata: md })
    }
    await writeMetadataFiles(clip, outPath)
    await exportCopy(clip, outPath, ctx.log)
    ctx.log(`Done: ${outPath}`)
    if (getLlm() && clip.metadata?.source === "template")
      ctx.log("Tip: use 'Generate metadata' to get LLM-written title/description")
  } catch (e) {
    const canceled = e instanceof CanceledError || ctx.signal.aborted
    updateClip(clip.id, { status: canceled ? "editing" : "failed" })
    throw e
  }
}
