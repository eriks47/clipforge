import { signalsHandler, visualHandler } from "./jobs/handlers/signals"
import { existsSync } from "node:fs"
import { join } from "node:path"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import Fastify from "fastify"
import { ZodError } from "zod"
import { config, ROOT_DIR } from "./config"
import { openDb } from "./db"
import { bus } from "./lib/events"
import { ensureDir } from "./lib/paths"
import {
  audioFeaturesHandler,
  audioHandler,
  downloadHandler,
  heatmapHandler,
  probeHandler,
  proxyHandler,
  scenesHandler,
} from "./jobs/handlers/analysis"
import { candidatesHandler, rankHandler } from "./jobs/handlers/candidates"
import { chatHandler } from "./jobs/handlers/chat"
import { emojiHandler } from "./jobs/handlers/emoji"
import { metadataHandler } from "./jobs/handlers/metadata"
import { facesHandler, transcribeHandler } from "./jobs/handlers/ml"
import { nominateHandler } from "./jobs/handlers/nominate"
import { renderHandler } from "./jobs/handlers/render"
import { JobQueue } from "./jobs/queue"
import { artifactRoutes } from "./routes/artifacts"
import { clipRoutes } from "./routes/clips"
import { miscRoutes } from "./routes/misc"
import { projectRoutes } from "./routes/projects"
import { HttpError, refreshProjectStatus, setDeps } from "./services"

export async function createApp(opts: { logger?: boolean } = {}) {
  ensureDir(config.dataDir)
  ensureDir(join(config.dataDir, "projects"))
  const { db, sqlite } = openDb(config.dataDir)
  const queue = new JobQueue(db, config.concurrency)
  setDeps({ db, queue })

  queue.register("download", downloadHandler)
  queue.register("probe", probeHandler)
  queue.register("proxy", proxyHandler)
  queue.register("audio", audioHandler)
  queue.register("transcribe", transcribeHandler)
  queue.register("nominate", nominateHandler)
  queue.register("audio_features", audioFeaturesHandler)
  queue.register("signals", signalsHandler)
  queue.register("visual", visualHandler)
  queue.register("scenes", scenesHandler)
  queue.register("heatmap", heatmapHandler)
  queue.register("chat", chatHandler)
  queue.register("candidates", candidatesHandler)
  queue.register("rank", rankHandler)
  queue.register("faces", facesHandler)
  queue.register("render", renderHandler)
  queue.register("metadata", metadataHandler)
  queue.register("emoji", emojiHandler)

  // Keep project status in sync with its analysis jobs.
  bus.subscribe((ev) => {
    if (ev.type === "job" && ev.job.projectId && ev.job.status !== "running")
      refreshProjectStatus(ev.job.projectId)
  })

  const app = Fastify({
    logger: opts.logger ? { level: "warn" } : false,
    bodyLimit: 10 * 1024 * 1024,
  })
  await app.register(cors, { origin: true })
  await app.register(fastifyStatic, {
    root: config.dataDir,
    prefix: "/files/",
    decorateReply: false,
    acceptRanges: true,
    cacheControl: false,
  })

  // Serve the built web app if present (pnpm build); in dev Vite serves it.
  const webDist = join(ROOT_DIR, "apps/web/dist")
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/files/"))
        return reply.code(404).send({ error: "Not found" })
      return reply.sendFile("index.html", webDist)
    })
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: "Invalid request", details: err.issues })
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error(err)
    return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) })
  })

  // Raw uploads (video chunks, music) arrive as streams; never buffered by Fastify.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload))

  await app.register(projectRoutes)
  await app.register(clipRoutes)
  await app.register(artifactRoutes)
  await app.register(miscRoutes)

  queue.recover()

  const close = async () => {
    queue.stop()
    await app.close()
    sqlite.close()
  }
  return { app, db, queue, close }
}
