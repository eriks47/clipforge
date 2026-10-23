import { existsSync } from "node:fs"
import {
  buildChatAnalysis,
  ChatAnalysisSchema,
  rankChatPeaks,
  parseTwitchVodId,
  type ChatMessages,
} from "@clipforge/shared"
import { downloadTwitchChat, twitchVodInfo } from "../../lib/twitch"
import { projectPaths, readJson, writeJson } from "../../lib/paths"
import { getProject } from "../../services"
import type { JobContext } from "../queue"

/**
 * Twitch VOD imports: download the chat replay and turn it into a chat-activity track
 * (messages per second relative to the stream's baseline, laughter/hype, peaks).
 * Runs alongside the video download; both files are cached.
 */
const fmtMin = (sec: number) =>
  `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

export async function chatHandler(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const project = getProject(ctx.job.projectId)
  const paths = projectPaths(project.id)
  if (existsSync(paths.chat)) {
    ctx.log("Chat analysis already exists, skipping (re-run the step to force)")
    return ctx.progress(1)
  }
  const videoId = parseTwitchVodId(project.sourceUrl)
  if (!videoId) {
    ctx.log("Not a Twitch VOD: no chat replay")
    return
  }

  let chat = await readJson<ChatMessages>(paths.chatMessages)
  const info = await twitchVodInfo(videoId, ctx.signal)
  if (chat && chat.videoId === videoId) {
    ctx.log(`Using cached chat replay (${chat.messages.length} messages)`)
  } else {
    ctx.log(
      `Downloading chat replay of Twitch VOD ${videoId}${info.owner ? ` (${info.owner})` : ""}, ${Math.round(info.lengthSeconds / 60)} min`
    )
    const t0 = Date.now()
    // first progress line after 5 s, then every 15 s (short downloads only log the total)
    let lastLog = t0 - 10000
    chat = await downloadTwitchChat(videoId, info.lengthSeconds, {
      signal: ctx.signal,
      onProgress: (f, n) => {
        ctx.progress(f * 0.95)
        if (Date.now() - lastLog > 15000) {
          lastLog = Date.now()
          ctx.log(`${Math.round(f * 100)}% · ${n} messages`)
        }
      },
    })
    ctx.log(`${chat.messages.length} messages in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
    await writeJson(paths.chatMessages, chat)
  }

  // the downloaded video may not be probed yet; the VOD length is the same timeline
  const duration = project.probe?.duration ?? info.lengthSeconds
  const analysis = ChatAnalysisSchema.parse(buildChatAnalysis(chat, duration))
  const msgs = chat.messages
  if (msgs.length)
    ctx.log(
      `Chat covers ${fmtMin(msgs[0][0])}–${fmtMin(msgs[msgs.length - 1][0])} of ${fmtMin(duration)}`
    )
  const ranked = rankChatPeaks(analysis)
  const maxed = ranked.filter((p) => p.strength >= 0.999).length
  ctx.log(
    `${analysis.peaks.length} chat peaks${
      ranked.length
        ? `; strongest at ${ranked
            .slice(0, 5)
            .map((p) => fmtMin(p.t))
            .join(", ")}${maxed > 5 ? ` (${maxed} peaks at max strength)` : ""}`
        : ""
    } (chat lag ${analysis.lagSec} s compensated)`
  )
  await writeJson(paths.chat, analysis)
}
