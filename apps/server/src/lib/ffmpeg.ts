import { stat } from "node:fs/promises"
import { ProbeInfoSchema, type ProbeInfo } from "@clipforge/shared"
import { config } from "../config"
import { capture, run, type RunOptions } from "./proc"

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  side_data_list?: { rotation?: number }[]
  tags?: { rotate?: string }
}
interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; format_name?: string; size?: string }
}

function parseRate(r: string | undefined): number {
  if (!r) return 0
  const [n, d] = r.split("/").map(Number)
  if (!d) return n || 0
  return n / d
}

export async function probe(file: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const out = await capture(
    config.ffprobe,
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
    { signal }
  )
  const j = JSON.parse(out) as FfprobeOutput
  const streams = j.streams ?? []
  const v = streams.find((s) => s.codec_type === "video")
  const audio = streams.filter((s) => s.codec_type === "audio")
  if (!v) throw new Error("No video stream found in file")
  const rotation = Math.abs(
    v.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? Number(v.tags?.rotate ?? 0)
  )
  const swap = rotation === 90 || rotation === 270
  const size = j.format?.size ? Number(j.format.size) : (await stat(file)).size
  return ProbeInfoSchema.parse({
    duration: Number(j.format?.duration ?? 0),
    width: swap ? (v.height ?? 0) : (v.width ?? 0),
    height: swap ? (v.width ?? 0) : (v.height ?? 0),
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30,
    videoCodec: v.codec_name ?? "unknown",
    audioCodec: audio[0]?.codec_name ?? null,
    audioStreams: audio.length,
    sizeBytes: size,
    formatName: j.format?.format_name ?? "",
    rotation,
  })
}

let nvencCache: boolean | null = null

/** NVENC can be listed but unusable (driver mismatch); test-encode a few frames. */
export async function hasNvenc(): Promise<boolean> {
  if (nvencCache !== null) return nvencCache
  try {
    await run(
      config.ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x256:d=0.2",
        "-c:v",
        "h264_nvenc",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 20000 }
    )
    nvencCache = true
  } catch {
    nvencCache = false
  }
  return nvencCache
}

/** Codecs NVDEC (`-hwaccel cuda`) decodes on NVIDIA GPUs from the last few generations. */
const NVDEC_CODECS = new Set(["h264", "hevc", "vp9", "av1", "vp8", "mpeg2video", "mpeg4", "vc1"])

/**
 * Whether a source can be decoded and scaled on the GPU (NVDEC + scale_cuda) before NVENC.
 * Rotated sources are left to the CPU path: ffmpeg's autorotate filter needs system-memory frames.
 * Callers still fall back to the CPU path if the GPU run fails (odd pixel formats, driver issues).
 */
export async function canGpuDecode(info: Pick<ProbeInfo, "videoCodec" | "rotation">) {
  if (!NVDEC_CODECS.has(info.videoCodec) || info.rotation) return false
  return hasNvenc()
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const out = await capture(config.ffmpeg, ["-version"], { timeoutMs: 10000 })
    return (
      out
        .split("\n")[0]
        ?.replace(/^ffmpeg version /, "")
        .split(" ")[0] ?? null
    )
  } catch {
    return null
  }
}

/** H.264 encoder args: NVENC when available, else libx264. `quality` is a CRF-like number. */
export async function h264Args(opts: {
  quality: number
  gop?: number
  preset?: "fast" | "quality"
}): Promise<string[]> {
  const gop = opts.gop ? ["-g", String(opts.gop), "-keyint_min", String(opts.gop)] : []
  if (await hasNvenc()) {
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      opts.preset === "quality" ? "p6" : "p4",
      "-rc",
      "vbr",
      "-cq",
      String(opts.quality),
      "-b:v",
      "0",
      "-bf",
      "0",
      ...gop,
      "-pix_fmt",
      "yuv420p",
    ]
  }
  return [
    "-c:v",
    "libx264",
    "-preset",
    opts.preset === "quality" ? "medium" : "veryfast",
    "-crf",
    String(opts.quality),
    ...gop,
    "-pix_fmt",
    "yuv420p",
  ]
}

/**
 * Run ffmpeg with `-progress pipe:1` and report progress (0..1) relative to `duration` seconds.
 */
export async function ffmpegWithProgress(
  args: string[],
  duration: number,
  onProgress: (p: number) => void,
  opts: Omit<RunOptions, "onStdoutLine"> = {}
): Promise<void> {
  await run(config.ffmpeg, ["-hide_banner", "-nostats", "-y", "-progress", "pipe:1", ...args], {
    ...opts,
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line)
      if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration))
    },
  })
}
