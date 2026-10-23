import { createWriteStream, existsSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import { desc, eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { nanoid } from "nanoid"
import { z } from "zod"
import {
  AppSettingsSchema,
  LlmProviderSchema,
  LlmSettingsSchema,
  EditConfigSchema,
  suggestWeights,
  type SystemStatus,
  type WeightSample,
} from "@clipforge/shared"
import { config } from "../config"
import { candidates, presets } from "../db/schema"
import { bus } from "../lib/events"
import { ffmpegVersion, hasNvenc } from "../lib/ffmpeg"
import { ensureDir, musicDir, nowIso } from "../lib/paths"
import { capture } from "../lib/proc"
import { pythonAvailable } from "../lib/python"
import { createLlmProvider, getLlm } from "../llm"
import { getDeps, getSettings, HttpError, saveSettings, toPreset } from "../services"

let systemCache: { at: number; value: SystemStatus } | null = null

export async function systemStatus(force = false): Promise<SystemStatus> {
  if (!force && systemCache && Date.now() - systemCache.at < 60_000) return systemCache.value
  const version = (bin: string) =>
    capture(bin, ["--version"], { timeoutMs: 10000 })
      .then((out) => out.trim().split("\n")[0] || null)
      .catch(() => null)
  const [ffv, nvenc, ytv, claudeV, codexV] = await Promise.all([
    ffmpegVersion(),
    hasNvenc(),
    version(config.ytdlp),
    version(config.llm.claudeBin),
    version(config.llm.codexBin),
  ])
  const llm = getLlm()
  const llmVersion = llm?.name === "claude" ? claudeV : llm?.name === "codex" ? codexV : null
  const value: SystemStatus = {
    ffmpeg: { ok: ffv !== null, version: ffv, nvenc },
    python: {
      ok: pythonAvailable(),
      path: config.python,
      detail: pythonAvailable() ? null : "Run ./setup.sh to create the Python venv",
    },
    ytdlp: { ok: ytv !== null, version: ytv },
    llm: {
      provider: llm?.name ?? "none",
      model: llm
        ? `${llm.model || "default model"}${llmVersion ? ` · ${llmVersion}` : " · CLI not found"}`
        : null,
      clis: { claude: claudeV, codex: codexV },
    },
    dataDir: config.dataDir,
  }
  systemCache = { at: Date.now(), value }
  return value
}

export async function miscRoutes(app: FastifyInstance) {
  const { db, queue } = getDeps()

  app.get("/api/system", async () => systemStatus(true))

  // ---------- events (SSE) ----------
  app.get("/api/events", (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    })
    res.write(": connected\n\n")
    const unsubscribe = bus.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`))
    const ping = setInterval(() => res.write(": ping\n\n"), 20000)
    req.raw.on("close", () => {
      clearInterval(ping)
      unsubscribe()
    })
  })

  // ---------- jobs ----------
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    const j = queue.get(req.params.id)
    if (!j) throw new HttpError(404, "Job not found")
    return j
  })
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) =>
    queue.cancel(req.params.id)
  )
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req) =>
    queue.retry(req.params.id)
  )
  app.post<{ Params: { id: string } }>("/api/jobs/:id/skip", async (req) =>
    queue.skip(req.params.id)
  )

  // ---------- settings ----------
  app.get("/api/settings", async () => getSettings())
  app.put("/api/settings", async (req) => saveSettings(AppSettingsSchema.parse(req.body)))

  /**
   * Suggest heuristic weights fitted to your decisions. Approved = positive; rejected, and
   * candidates you left undecided while approving lower-ranked ones in the same batch, = negative.
   */
  app.get("/api/settings/learned-weights", async () => {
    const rows = getDeps()
      .db.select()
      .from(candidates)
      .where(eq(candidates.source, "auto"))
      .all()
    const approved = (r: (typeof rows)[number]) => r.status === "approved" || !!r.clipId
    // deepest approved rank per project + batch: undecided candidates above it were passed over
    const deepest = new Map<string, number>()
    for (const r of rows)
      if (approved(r)) {
        const k = `${r.projectId}:${r.batch}`
        deepest.set(k, Math.max(deepest.get(k) ?? 0, r.rank))
      }
    const samples: WeightSample[] = []
    for (const r of rows) {
      const bd = r.breakdown as Record<string, number>
      if (approved(r)) samples.push({ breakdown: bd, label: 1 })
      else if (r.status === "rejected") samples.push({ breakdown: bd, label: 0 })
      else if (r.rank < (deepest.get(`${r.projectId}:${r.batch}`) ?? -1))
        samples.push({ breakdown: bd, label: 0 })
    }
    return suggestWeights(samples, getSettings().candidates.weights)
  })

  /** Switch the LLM (Claude Code ⇄ Codex ⇄ off) at runtime; applies to the next LLM call. */
  app.patch("/api/settings/llm", async (req) => {
    const patch = LlmSettingsSchema.partial().parse(req.body)
    const s = getSettings()
    return saveSettings({ ...s, llm: { ...s.llm, ...patch } })
  })

  /** Round-trip a tiny request through a CLI to check it is installed and logged in. */
  const TestBody = z.object({
    provider: LlmProviderSchema.exclude(["none"]),
    model: z.string().default(""),
  })
  app.post("/api/llm/test", async (req) => {
    const { provider, model } = TestBody.parse(req.body)
    const llm = createLlmProvider(provider, model)!
    const t0 = Date.now()
    try {
      const hooks = await llm.generateHooks({
        transcript:
          "Everyone is scared of charging money. Charge more than you think. Seriously, double it.",
        current: "Charge more",
      })
      return { ok: true, ms: Date.now() - t0, sample: hooks[0] ?? "" }
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---------- presets ----------
  app.get("/api/presets", async () =>
    db.select().from(presets).orderBy(desc(presets.createdAt)).all().map(toPreset)
  )
  const PresetBody = z.object({
    name: z.string().min(1),
    config: EditConfigSchema,
    makeDefault: z.boolean().optional(),
  })
  app.post("/api/presets", async (req) => {
    const body = PresetBody.parse(req.body)
    // strip clip-specific bits so a preset is a pure style
    const cfg = {
      ...body.config,
      hook: { ...body.config.hook, text: "", emojiPick: "" },
      cuts: { ...body.config.cuts, deletedWords: [], restoredCuts: [] },
      captions: { ...body.config.captions, overrides: {}, hiddenWords: [], emojiPicks: {} },
      framing: { ...body.config.framing, manualKeyframes: [] },
      zooms: { ...body.config.zooms, manual: [] },
    }
    const id = nanoid(8)
    db.insert(presets).values({ id, name: body.name, config: cfg, createdAt: nowIso() }).run()
    if (body.makeDefault) saveSettings({ ...getSettings(), defaultPresetId: id })
    return toPreset(db.select().from(presets).where(eq(presets.id, id)).get()!)
  })
  app.patch<{ Params: { id: string } }>("/api/presets/:id", async (req) => {
    const body = PresetBody.partial().parse(req.body)
    if (body.name)
      db.update(presets).set({ name: body.name }).where(eq(presets.id, req.params.id)).run()
    if (body.makeDefault !== undefined)
      saveSettings({ ...getSettings(), defaultPresetId: body.makeDefault ? req.params.id : null })
    const r = db.select().from(presets).where(eq(presets.id, req.params.id)).get()
    if (!r) throw new HttpError(404, "Preset not found")
    return toPreset(r)
  })
  app.delete<{ Params: { id: string } }>("/api/presets/:id", async (req) => {
    db.delete(presets).where(eq(presets.id, req.params.id)).run()
    const s = getSettings()
    if (s.defaultPresetId === req.params.id) saveSettings({ ...s, defaultPresetId: null })
    return { ok: true }
  })

  // ---------- music ----------
  app.get("/api/music", async () => {
    const dir = ensureDir(musicDir())
    return (await readdir(dir)).filter((f) => /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(f)).sort()
  })
  app.put<{ Querystring: { name: string } }>(
    "/api/music",
    { bodyLimit: 200 * 1024 * 1024 },
    async (req) => {
      const name = basename(req.query.name ?? "").replace(/[^\w.\- ]+/g, "_")
      if (!name || !/\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(name))
        throw new HttpError(400, "Unsupported audio file")
      const dir = ensureDir(musicDir())
      await pipeline(req.body as Readable, createWriteStream(join(dir, name)))
      return { name }
    }
  )
  app.delete<{ Params: { name: string } }>("/api/music/:name", async (req) => {
    const f = join(musicDir(), basename(req.params.name))
    if (existsSync(f) && extname(f)) await rm(f)
    return { ok: true }
  })
}
