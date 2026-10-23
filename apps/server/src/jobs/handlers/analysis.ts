import { existsSync } from "node:fs"
import { readdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  AudioAnalysisSchema,
  binSeries,
  detectSpikes,
  normalizeLoudness,
  type Heatmap,
  type SceneCuts,
  type TimeRange,
} from "@clipforge/shared"
import { config } from "../../config"
import { canGpuDecode, ffmpegWithProgress, h264Args, probe } from "../../lib/ffmpeg"
import { projectPaths, readJson, writeJson } from "../../lib/paths"
import { CanceledError, run } from "../../lib/proc"
import { getProject, getSettings, updateProject } from "../../services"
import type { JobContext } from "../queue"

function requireProject(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const project = getProject(ctx.job.projectId)
  return { project, paths: projectPaths(project.id) }
}

function requireProbe(ctx: JobContext) {
  const r = requireProject(ctx)
  if (!r.project.probe) throw new Error("Project has not been probed yet")
  return { ...r, probeInfo: r.project.probe }
}

const cached = (ctx: JobContext, what: string) => {
  ctx.log(`${what} already exists, skipping (delete it or use "re-run" to force)`)
  ctx.progress(1)
}

export async function downloadHandler(ctx: JobContext) {
  const { project, paths } = requireProject(ctx)
  if (!project.sourceUrl) throw new Error("Project has no source URL")
  if (project.sourceFile && existsSync(join(paths.dir, project.sourceFile)))
    return cached(ctx, "Source video")
  ctx.log(`Downloading ${project.sourceUrl}`)
  // Track up to two download phases (video + audio) for progress.
  let phase = 0
  let lastPct = 0
  await run(
    config.ytdlp,
    [
      "--newline",
      "--no-playlist",
      // parallel fragment downloads: YouTube/Twitch throttle per connection (~2.5x faster)
      "--concurrent-fragments",
      "8",
      "-f",
      "bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format",
      "mp4",
      "--write-info-json",
      "-o",
      join(paths.dir, "source.%(ext)s"),
      project.sourceUrl,
    ],
    {
      signal: ctx.signal,
      timeoutMs: 6 * 3600 * 1000,
      onStdoutLine: (line) => {
        const m = /\[download\]\s+([\d.]+)%/.exec(line)
        if (m) {
          const pct = Number(m[1]) / 100
          if (pct < lastPct - 0.5) phase = Math.min(phase + 1, 1)
          lastPct = pct
          ctx.progress((phase + pct) / 2)
        } else if (line.trim()) ctx.log(line)
      },
      onStderrLine: (l) => ctx.log(l),
    }
  )
  const files = await readdir(paths.dir)
  const video = files.find((f) => /^source\.(mp4|webm|mkv|mov)$/.test(f))
  if (!video) throw new Error("yt-dlp finished but no source video was found")
  // yt-dlp writes source.info.json next to the video (= paths.info)
  const info = await readJson<{ title?: string }>(paths.info)
  const size = (await stat(join(paths.dir, video))).size
  updateProject(project.id, {
    sourceFile: video,
    sizeBytes: size,
    uploadedBytes: size,
    title: info?.title ?? project.title,
  })
}

export async function probeHandler(ctx: JobContext) {
  const { project, paths } = requireProject(ctx)
  const src = join(paths.dir, project.sourceFile)
  if (!existsSync(src)) throw new Error(`Source file missing: ${src}`)
  const info = await probe(src, ctx.signal)
  ctx.log(
    `${info.width}x${info.height} @ ${info.fps.toFixed(2)} fps, ${info.duration.toFixed(1)} s, video ${info.videoCodec}, audio ${info.audioCodec ?? "none"}`
  )
  if (info.audioStreams === 0)
    ctx.log("WARNING: no audio stream — transcription and audio analysis will be empty")
  updateProject(project.id, { probe: info })
}

export async function proxyHandler(ctx: JobContext) {
  const { project, paths, probeInfo } = requireProbe(ctx)
  const src = join(paths.dir, project.sourceFile)
  if (!existsSync(paths.thumbnail)) {
    await run(
      config.ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-ss",
        String(Math.min(probeInfo.duration * 0.1, 60)),
        "-i",
        src,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        "-q:v",
        "4",
        paths.thumbnail,
      ],
      { signal: ctx.signal, timeoutMs: 120000 }
    ).catch((e: unknown) =>
      ctx.log(`thumbnail failed: ${e instanceof Error ? e.message : String(e)}`)
    )
    if (existsSync(paths.thumbnail)) updateProject(project.id, { hasThumbnail: true })
  }
  if (existsSync(paths.proxy)) {
    updateProject(project.id, { hasProxy: true })
    return cached(ctx, "Proxy")
  }
  const tmp = paths.proxy.replace(/\.mp4$/, ".tmp.mp4")
  const venc = await h264Args({ quality: 27, gop: 30 })
  const fps30 = probeInfo.fps > 60
  const audioOut = ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", tmp]
  const logIssues = (l: string) => /error|warning/i.test(l) && ctx.log(l)

  if (await canGpuDecode(probeInfo)) {
    // Decode + scale on the GPU, and detect scene cuts from the same decoded frames
    // (a second, tiny branch) so the scenes job doesn't decode the whole video again.
    const threshold = getSettings().analysis.sceneThreshold
    const wantScenes = !existsSync(paths.scenes)
    const height = Math.min(720, probeInfo.height) & ~1
    const proxyChain = `scale_cuda=-2:${height}:format=yuv420p${fps30 ? ",fps=30" : ""}`
    const graph = wantScenes
      ? `[0:v:0]split=2[p][s];[p]${proxyChain}[pv];[s]scale_cuda=320:-2:format=nv12,hwdownload,format=nv12,select='gt(scene,${threshold})',showinfo[sv]`
      : `[0:v:0]${proxyChain}[pv]`
    // frames stay in GPU memory: -pix_fmt would make ffmpeg insert a CPU conversion and fail
    // (scale_cuda already outputs yuv420p)
    const pf = venc.indexOf("-pix_fmt")
    const gpuVenc = pf >= 0 ? [...venc.slice(0, pf), ...venc.slice(pf + 2)] : venc
    const cuts: number[] = []
    ctx.log(`Encoding proxy on the GPU (NVDEC → scale_cuda → ${venc[1]})`)
    try {
      await ffmpegWithProgress(
        [
          "-hwaccel",
          "cuda",
          "-hwaccel_output_format",
          "cuda",
          "-i",
          src,
          "-filter_complex",
          graph,
          "-map",
          "[pv]",
          "-map",
          "0:a:0?",
          ...gpuVenc,
          ...audioOut,
          ...(wantScenes ? ["-map", "[sv]", "-f", "null", "-"] : []),
        ],
        probeInfo.duration,
        ctx.progress,
        {
          signal: ctx.signal,
          onStderrLine: (l) => {
            if (l.includes("Parsed_showinfo")) {
              const m = /pts_time:\s*([\d.]+)/.exec(l)
              if (m) cuts.push(Number(m[1]))
            } else logIssues(l)
          },
        }
      )
      await rename(tmp, paths.proxy)
      updateProject(project.id, { hasProxy: true })
      if (wantScenes) {
        ctx.log(`${cuts.length} scene cuts (detected during the proxy encode)`)
        await writeJson(paths.scenes, { threshold, cuts } satisfies SceneCuts)
      }
      return
    } catch (e) {
      if (e instanceof CanceledError) throw e
      ctx.log(
        `GPU proxy encode failed, retrying on the CPU: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`
      )
      await rm(tmp, { force: true })
      ctx.progress(0)
    }
  }

  ctx.log(`Encoding proxy with ${venc[1]}`)
  await ffmpegWithProgress(
    [
      "-i",
      src,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      "scale=-2:'min(720,ih)'",
      ...(fps30 ? ["-r", "30"] : []),
      ...venc,
      ...audioOut,
    ],
    probeInfo.duration,
    ctx.progress,
    { signal: ctx.signal, onStderrLine: logIssues }
  )
  await rename(tmp, paths.proxy)
  updateProject(project.id, { hasProxy: true })
}

export async function audioHandler(ctx: JobContext) {
  const { project, paths, probeInfo } = requireProbe(ctx)
  if (probeInfo.audioStreams === 0) {
    ctx.log("No audio stream, skipping")
    return
  }
  const src = join(paths.dir, project.sourceFile)
  if (existsSync(paths.audio16k) && existsSync(paths.audio48k)) return cached(ctx, "Audio")
  const t16 = paths.audio16k + ".tmp.wav"
  const t48 = paths.audio48k + ".tmp.flac"
  // One decode, two outputs
  await ffmpegWithProgress(
    [
      "-i",
      src,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      t16,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "flac",
      t48,
    ],
    probeInfo.duration,
    ctx.progress,
    { signal: ctx.signal }
  )
  await rename(t16, paths.audio16k)
  await rename(t48, paths.audio48k)
}

export async function audioFeaturesHandler(ctx: JobContext) {
  const { paths, probeInfo } = requireProbe(ctx)
  if (existsSync(paths.audioAnalysis)) return cached(ctx, "Audio analysis")
  const settings = getSettings().analysis
  const hopSec = 0.5
  if (!existsSync(paths.audio48k)) {
    ctx.log("No audio, writing empty analysis")
    const n = Math.ceil(probeInfo.duration / hopSec)
    await writeJson(paths.audioAnalysis, {
      hopSec,
      loudness: new Array(n).fill(-70),
      energyNorm: new Array(n).fill(0),
      spikes: [],
      silences: [],
    })
    return
  }
  const points: { t: number; v: number }[] = []
  const silences: TimeRange[] = []
  let silenceStart: number | null = null
  await run(
    config.ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      paths.audio48k,
      "-af",
      `ebur128=framelog=info,silencedetect=n=${settings.silenceNoiseDb}dB:d=${settings.silenceMinSec}`,
      "-f",
      "null",
      "-",
    ],
    {
      signal: ctx.signal,
      onStderrLine: (line) => {
        const m = /t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)/.exec(line)
        if (m) {
          const t = Number(m[1])
          const momentary = m[2] === "-inf" ? -120 : Number(m[2])
          points.push({ t, v: momentary })
          if (points.length % 200 === 0) ctx.progress(Math.min(0.99, t / probeInfo.duration))
          return
        }
        const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
        if (s) {
          silenceStart = Math.max(0, Number(s[1]))
          return
        }
        const e = /silence_end:\s*([\d.]+)/.exec(line)
        if (e && silenceStart !== null) {
          silences.push({ start: silenceStart, end: Number(e[1]) })
          silenceStart = null
        }
      },
    }
  )
  if (silenceStart !== null) silences.push({ start: silenceStart, end: probeInfo.duration })
  // ebur128 reports at the end of each 100ms frame and the momentary value covers the last 400 ms; centre it.
  const loudness = binSeries(
    points.map((p) => ({ t: Math.max(0, p.t - 0.2), v: p.v })),
    hopSec,
    probeInfo.duration
  )
  const energyNorm = normalizeLoudness(loudness)
  const spikes = detectSpikes(energyNorm, hopSec, {
    windowSec: settings.spikeWindowSec,
    minRatio: settings.spikeMinRatio,
  })
  const analysis = AudioAnalysisSchema.parse({
    hopSec,
    loudness: loudness.map((v) => Math.round(v * 10) / 10),
    energyNorm: energyNorm.map((v) => Math.round(v * 1000) / 1000),
    spikes,
    silences,
  })
  ctx.log(`${loudness.length} loudness bins, ${spikes.length} spikes, ${silences.length} silences`)
  await writeJson(paths.audioAnalysis, analysis)
}

export async function scenesHandler(ctx: JobContext) {
  const { project, paths, probeInfo } = requireProbe(ctx)
  if (existsSync(paths.scenes)) return cached(ctx, "Scene cuts")
  const threshold = getSettings().analysis.sceneThreshold
  const hasProxy = existsSync(paths.proxy)
  const input = hasProxy ? paths.proxy : join(paths.dir, project.sourceFile)
  const select = `select='gt(scene,${threshold})',showinfo`
  let cuts: number[] = []
  const detect = (pre: string[], vf: string) => {
    cuts = []
    return ffmpegWithProgress(
      [...pre, "-i", input, "-an", "-vf", vf, "-f", "null", "-"],
      probeInfo.duration,
      ctx.progress,
      {
        signal: ctx.signal,
        onStderrLine: (line) => {
          if (!line.includes("Parsed_showinfo")) return
          const m = /pts_time:\s*([\d.]+)/.exec(line)
          if (m) cuts.push(Number(m[1]))
        },
      }
    )
  }
  // the proxy is always H.264; otherwise it depends on the source codec
  const gpu = await canGpuDecode(hasProxy ? { videoCodec: "h264", rotation: 0 } : probeInfo)
  let done = false
  if (gpu) {
    try {
      await detect(
        ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
        `scale_cuda=320:-2:format=nv12,hwdownload,format=nv12,${select}`
      )
      done = true
    } catch (e) {
      if (e instanceof CanceledError) throw e
      ctx.log("GPU decode failed, detecting scene cuts on the CPU")
    }
  }
  if (!done) await detect([], `scale=320:-2,${select}`)
  ctx.log(`${cuts.length} scene cuts`)
  const out: SceneCuts = { threshold, cuts }
  await writeJson(paths.scenes, out)
}

interface YtInfo {
  heatmap?: { start_time: number; end_time: number; value: number }[] | null
}

export async function heatmapHandler(ctx: JobContext) {
  const { project, paths } = requireProject(ctx)
  if (existsSync(paths.heatmap)) return cached(ctx, "Heatmap")
  let info = await readJson<YtInfo>(paths.info)
  if (!info && project.sourceUrl) {
    ctx.log("Fetching video info with yt-dlp --dump-json")
    const lines: string[] = []
    await run(config.ytdlp, ["--dump-json", "--no-playlist", project.sourceUrl], {
      signal: ctx.signal,
      timeoutMs: 120000,
      onStdoutLine: (l) => lines.push(l),
    })
    info = JSON.parse(lines.join("\n")) as YtInfo
  }
  const raw = info?.heatmap ?? []
  if (!raw.length) {
    ctx.log("No 'most replayed' heatmap available for this video")
    await writeJson(paths.heatmap, { points: [] } satisfies Heatmap)
    return
  }
  const max = Math.max(...raw.map((p) => p.value), 1e-9)
  const heat: Heatmap = {
    points: raw.map((p) => ({ start: p.start_time, end: p.end_time, value: p.value / max })),
  }
  ctx.log(`${heat.points.length} heatmap points`)
  await writeJson(paths.heatmap, heat)
}

/** Remove a step's cached output so it is recomputed. */
export async function clearStepCache(projectId: string, type: string) {
  const p = projectPaths(projectId)
  const files: Record<string, string[]> = {
    proxy: [p.proxy],
    audio: [p.audio16k, p.audio48k],
    transcribe: [p.transcript],
    nominate: [p.nominations],
    audio_features: [p.audioAnalysis],
    signals: [p.signals],
    visual: [p.visual],
    scenes: [p.scenes],
    heatmap: [p.heatmap],
    // keep chat_messages.json: re-running only recomputes the analysis
    chat: [p.chat],
  }
  for (const f of files[type] ?? []) await rm(f, { force: true })
}
