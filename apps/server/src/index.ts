import { createApp } from "./app"
import { LLM_PROVIDERS } from "@clipforge/shared"
import { config } from "./config"
import { setMediaBase } from "./jobs/handlers/render"
import { ffmpegVersion } from "./lib/ffmpeg"
import { systemStatus } from "./routes/misc"

async function main() {
  // pre-flight: nothing works without ffmpeg (the full status needs the DB, so it comes after createApp)
  if ((await ffmpegVersion()) === null) {
    console.error(
      "\n  ✖ ffmpeg/ffprobe not found on PATH. ClipForge needs them for everything.\n" +
        "    Arch: sudo pacman -S ffmpeg   ·   Mint/Ubuntu: sudo apt install ffmpeg\n" +
        "    Or set FFMPEG_PATH / FFPROBE_PATH in .env\n"
    )
    process.exit(1)
  }
  if (!(LLM_PROVIDERS as readonly string[]).includes(config.llm.provider)) {
    console.warn(
      `  ⚠ LLM_PROVIDER="${config.llm.provider}" is not supported (use none | claude | codex) — running without an LLM`
    )
  }
  const { app, close } = await createApp({ logger: true })
  // Listen first so the UI can connect immediately; the slower environment checks
  // (NVENC test encode, CLI versions) run afterwards just for this startup summary.
  await app.listen({ port: config.port, host: config.host })
  setMediaBase(`http://127.0.0.1:${config.port}`)
  console.log(`ClipForge server on http://${config.host}:${config.port}`)
  const status = await systemStatus(true)
  console.log(`  ffmpeg ${status.ffmpeg.version} (NVENC: ${status.ffmpeg.nvenc ? "yes" : "no"})`)
  console.log(`  python workers: ${status.python.ok ? "ok" : `missing — ${status.python.detail}`}`)
  console.log(`  yt-dlp: ${status.ytdlp.version ?? "not installed (URL import disabled)"}`)
  console.log(
    `  LLM: ${status.llm.provider}${status.llm.model ? ` (${status.llm.model})` : " — heuristic ranking + template metadata"}`
  )
  console.log(`  data: ${status.dataDir}`)

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
