import { existsSync } from "node:fs"
import { and, desc, eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  boundaryPieces,
  buildMomentTracks,
  momentTags,
  chatSummary,
  type ChatMessages,
  rangeFromPieces,
  rangeText,
  type CandidateInput,
  type LlmRankItem,
  type Nominations,
  type ScoredWindow,
  type TimeRange,
} from "@clipforge/shared"
import { candidates } from "../../db/schema"
import { bus } from "../../lib/events"
import { nowIso, projectPaths, readJson, writeJson } from "../../lib/paths"
import { runWorker } from "../../lib/worker"
import { getLlm } from "../../llm"
import {
  getDeps,
  getProject,
  getSettings,
  loadAnalysis,
  refreshProjectStatus,
} from "../../services"
import type { JobContext } from "../queue"

interface Pool {
  batch: number
  createdAt: string
  windows: ScoredWindow[]
}

/** Generate the heuristic pool for a batch (top llmTopK windows, excluding already-seen ranges). */
export async function candidatesHandler(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const project = getProject(ctx.job.projectId)
  if (!project.probe) throw new Error("Project has not been probed")
  const batch = Number(ctx.job.payload.batch ?? 0)
  const paths = projectPaths(project.id)
  const settings = getSettings().candidates
  const analysis = await loadAnalysis(project.id)
  if (!analysis.transcript) ctx.log("No transcript available: using time-based windows")
  if (!analysis.audio) ctx.log("No audio analysis available")
  if (!analysis.signals) ctx.log("No audio signals (laughter, cheering, voice intensity): not used")
  if (!analysis.visual) ctx.log("No visual signals (motion, dancing): not used")

  const { db } = getDeps()
  const existing: TimeRange[] = db
    .select({ start: candidates.start, end: candidates.end })
    .from(candidates)
    .where(eq(candidates.projectId, project.id))
    .all()
  const nominations = await readJson<Nominations>(paths.nominations)
  if (nominations?.moments.length)
    ctx.log(`${nominations.moments.length} LLM-nominated moment(s) from the full transcript`)
  const input: CandidateInput = {
    transcript: analysis.transcript,
    analysis: analysis.audio,
    heatmap: analysis.heatmap && analysis.heatmap.points.length ? analysis.heatmap : null,
    chat: analysis.chat,
    signals: analysis.signals,
    visual: analysis.visual,
    nominations: nominations?.moments ?? null,
    duration: project.probe.duration,
    settings,
    exclude: batch > 0 ? existing : [],
  }
  const poolSize = Math.max(settings.topN, settings.llmTopK)
  ctx.progress(0.1)
  const t0 = Date.now()
  const windows = await runWorker<ScoredWindow[]>(
    new URL("../candidateWorker.ts", import.meta.url),
    { input, poolSize },
    ctx.signal
  )
  const nominatedInPool = windows.filter((w) => w.nominated !== undefined).length
  ctx.log(
    `Scored windows in ${Date.now() - t0} ms; pool of ${windows.length} candidates (batch ${batch}${nominatedInPool ? `, ${nominatedInPool} LLM-nominated` : ""})`
  )
  const pool: Pool = { batch, createdAt: nowIso(), windows }
  await writeJson(paths.pool(batch), pool)
}

/** Rank the pool with the LLM (if configured), blend scores and store the top N as candidates. */
export async function rankHandler(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const project = getProject(ctx.job.projectId)
  const batch = Number(ctx.job.payload.batch ?? 0)
  const paths = projectPaths(project.id)
  const pool = await readJson<Pool>(paths.pool(batch))
  if (!pool)
    throw new Error(`Candidate pool for batch ${batch} missing; re-run candidate generation`)
  const appSettings = getSettings().candidates
  const analysis = await loadAnalysis(project.id)
  const llm = getLlm()

  // each candidate's transcript as sentence/clause pieces (+ context) for boundary choices
  const items = pool.windows.map((w) => ({
    ...w,
    id: nanoid(10),
    pieces: analysis.transcript ? boundaryPieces(analysis.transcript, w) : [],
  }))
  const llmById = new Map<string, LlmRankItem>()
  // raw chat (Twitch VODs) so the LLM sees what chat said during each candidate
  const chatMessages = analysis.chat ? await readJson<ChatMessages>(paths.chatMessages) : null
  const chatDuration = project.probe?.duration ?? analysis.chat?.count.length ?? 1
  // laughter / cheering / dancing the transcript can't show, as tags the LLM can weigh
  const moments = buildMomentTracks(
    analysis.signals,
    analysis.visual,
    project.probe?.duration ?? 0,
    analysis.audio?.hopSec ?? 0.5
  )
  if (llm && items.length) {
    try {
      const ranked = await llm.rankCandidates(
        {
          videoTitle: project.title,
          people: project.settings.people,
          minSec: appSettings.minSec,
          maxSec: appSettings.maxSec,
          candidates: items.slice(0, appSettings.llmTopK).map((w) => ({
            id: w.id,
            start: w.start,
            end: w.end,
            heuristicScore: w.score,
            features: w.breakdown,
            pieces: w.pieces,
            chat:
              chatMessages && analysis.chat
                ? chatSummary(chatMessages, w, analysis.chat.lagSec, chatDuration)
                : null,
            events: moments
              ? momentTags(moments, w)
                  .map((t) => `${t.start.toFixed(1)}-${t.end.toFixed(1)}s ${t.text}`)
                  .join("; ") || null
              : null,
          })),
        },
        ctx.log
      )
      for (const r of ranked) llmById.set(r.id, r)
      ctx.log(`LLM rated ${llmById.size} of ${items.length} candidates`)
    } catch (e) {
      // Never fail the pipeline because of the LLM: fall back to heuristics.
      ctx.log(
        `LLM ranking failed, using heuristic scores only: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  } else if (!llm) ctx.log("No LLM configured: ranking by heuristic score")
  ctx.progress(0.8)

  const blend = appSettings.llmBlend
  const words = analysis.transcript?.words ?? []
  const duration = project.probe?.duration ?? Infinity
  let moved = 0
  let rejected = 0
  const finals = items.map((w) => {
    const l = llmById.get(w.id)
    let start = w.start
    let end = w.end
    let text = w.text
    if (l && (typeof l.start_piece === "number" || typeof l.end_piece === "number")) {
      // Boundaries come from transcript pieces, so they land exactly on sentence/clause edges.
      // A missing side keeps the current boundary's piece.
      const inside = w.pieces.filter((p) => p.inside)
      const startId = l.start_piece ?? inside[0]?.id
      const endId = l.end_piece ?? inside[inside.length - 1]?.id
      const r =
        startId !== undefined && endId !== undefined
          ? rangeFromPieces(words, w.pieces, startId, endId, {
              leadInSec: appSettings.leadInSec,
              tailSec: appSettings.tailSec,
              duration,
            })
          : null
      const len = r ? r.end - r.start : 0
      if (r && len >= appSettings.minSec * 0.9 && len <= appSettings.maxSec * 1.1) {
        if (Math.abs(r.start - start) > 0.05 || Math.abs(r.end - end) > 0.05) moved++
        start = r.start
        end = r.end
        text = rangeText(analysis.transcript, { start, end }).text
      } else rejected++
    }
    const finalRating = l
      ? Math.round((blend * l.rating + (1 - blend) * w.score) * 10) / 10
      : w.score
    return {
      w,
      l,
      start,
      end,
      text,
      finalRating,
    }
  })
  finals.sort((a, b) => b.finalRating - a.finalRating)
  const top = finals.slice(0, appSettings.topN)

  // Dedicated hook pass for the final clips only, written against their final boundaries.
  const hooks = new Map<string, string>()
  if (llm && top.length && analysis.transcript) {
    ctx.log(`Writing hooks for the top ${top.length} clips`)
    try {
      const written = await llm.writeHooks({
        videoTitle: project.title,
        people: project.settings.people,
        clips: top.map((f) => ({
          id: f.w.id,
          category: f.l?.category ?? f.w.category,
          reason: f.l?.reason ?? f.w.reason,
          transcript: f.text,
        })),
      })
      for (const [id, h] of written) hooks.set(id, h)
      ctx.log(
        `Wrote ${hooks.size} hook(s)${hooks.size < top.length ? "; the rest keep the fallback hook" : ""}`
      )
    } catch (e) {
      ctx.log(
        `Hook pass failed, keeping fallback hooks: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  if (moved || rejected)
    ctx.log(
      `LLM moved ${moved} clip boundar${moved === 1 ? "y" : "ies"} to sentence/clause edges${rejected ? `; ignored ${rejected} invalid or out-of-length suggestion(s)` : ""}`
    )

  const { db } = getDeps()
  const now = nowIso()
  db.transaction((tx) => {
    // replace this batch's auto candidates that weren't acted on
    tx.delete(candidates)
      .where(
        and(
          eq(candidates.projectId, project.id),
          eq(candidates.batch, batch),
          eq(candidates.source, "auto"),
          eq(candidates.status, "new")
        )
      )
      .run()
    top.forEach((f, i) => {
      tx.insert(candidates)
        .values({
          id: f.w.id,
          projectId: project.id,
          start: f.start,
          end: f.end,
          heuristicScore: f.w.score,
          llmRating: f.l?.rating ?? null,
          finalRating: f.finalRating,
          breakdown: f.w.breakdown,
          reason: f.l?.reason ?? f.w.reason,
          llmReason: f.l?.reason ?? null,
          llmScores: f.l?.scores ?? null,
          seeds: f.w.seeds,
          nominated: f.w.nominated ?? null,
          category: f.l?.category ?? f.w.category,
          suggestedHook: hooks.get(f.w.id) ?? f.l?.suggested_hook ?? f.w.suggestedHook,
          suggestedTitle: f.l?.suggested_title ?? f.w.suggestedTitle,
          status: "new",
          source: "auto",
          batch,
          rank: i + 1,
          clipId: null,
          createdAt: now,
        })
        .run()
    })
  })
  ctx.log(`Stored ${top.length} candidates`)
  bus.emitEvent({ type: "candidates", projectId: project.id })
  refreshProjectStatus(project.id)
}

/** Next batch number for "find more". */
export function nextBatch(projectId: string): number {
  const r = getDeps()
    .db.select({ batch: candidates.batch })
    .from(candidates)
    .where(eq(candidates.projectId, projectId))
    .orderBy(desc(candidates.batch))
    .get()
  let b = r ? r.batch + 1 : 0
  while (existsSync(projectPaths(projectId).pool(b))) b++
  return b
}
