import { existsSync } from "node:fs"
import {
  buildMomentTracks,
  endAfterClimax,
  iou,
  momentTags,
  sentenceText,
  sentenceUnits,
  type Nomination,
  type Nominations,
  type SentenceUnit,
} from "@clipforge/shared"
import { projectPaths, writeJson } from "../../lib/paths"
import { getLlm } from "../../llm"
import { getProject, getSettings, loadAnalysis } from "../../services"
import type { JobContext } from "../queue"

/** Transcript section per LLM call, and how much consecutive sections overlap. */
const SECTION_SEC = 15 * 60
const OVERLAP_SEC = 60
/** parallel LLM calls (each is a CLI process) */
const PARALLEL = 4

/** Split sentence units into ~15 min sections that overlap by ~1 min (moments on a seam survive). */
export function transcriptSections(
  units: readonly SentenceUnit[],
  sectionSec = SECTION_SEC,
  overlapSec = OVERLAP_SEC
): SentenceUnit[][] {
  const out: SentenceUnit[][] = []
  let i = 0
  while (i < units.length) {
    const t0 = units[i].start
    let j = i
    while (j + 1 < units.length && units[j + 1].end - t0 <= sectionSec) j++
    out.push(units.slice(i, j + 1))
    if (j + 1 >= units.length) break
    // next section starts ~overlapSec before this one ends
    let k = j + 1
    while (k - 1 > i && units[j].end - units[k - 1].start <= overlapSec) k--
    i = k
  }
  return out
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

/**
 * The LLM reads the whole transcript (in parallel sections) and nominates clip-worthy moments.
 * They become candidate windows next to the heuristic ones, so the ranker isn't limited to what
 * loudness / regex signals happened to surface. Never fails the pipeline: no LLM = no nominations.
 */
export async function nominateHandler(ctx: JobContext) {
  if (!ctx.job.projectId) throw new Error("Job has no project")
  const project = getProject(ctx.job.projectId)
  const paths = projectPaths(project.id)
  if (existsSync(paths.nominations)) {
    ctx.log("Nominations already exist, skipping")
    return
  }
  const llm = getLlm()
  const { transcript, signals, visual, audio } = await loadAnalysis(project.id)
  const tracks = buildMomentTracks(
    signals,
    visual,
    project.probe?.duration ?? 0,
    audio?.hopSec ?? 0.5
  )
  const units = transcript ? sentenceUnits(transcript) : []
  if (!llm || units.length === 0) {
    ctx.log(llm ? "No transcript: nothing to read" : "No LLM configured: skipping moment search")
    await writeJson(paths.nominations, { model: null, moments: [] } satisfies Nominations)
    return
  }
  const settings = getSettings().candidates
  const words = transcript?.words ?? []
  const sections = transcriptSections(units)
  ctx.log(
    `Reading the transcript in ${sections.length} section(s) with the ${llm.name} CLI${llm.model ? ` (${llm.model})` : ""}`
  )
  let done = 0
  let failed = 0
  const found = await mapLimit(sections, PARALLEL, async (sec, i) => {
    const minutes = (sec[sec.length - 1].end - sec[0].start) / 60
    const idxById = new Map(sec.map((u, i) => [u.first, i]))
    try {
      const moments = await llm.nominateMoments({
        videoTitle: project.title,
        people: project.settings.people,
        minSec: settings.minSec,
        maxSec: settings.maxSec,
        count: Math.max(2, Math.min(6, Math.round(minutes / 3))),
        pieces: sec.map((u) => ({
          id: u.first,
          start: u.start,
          end: u.end,
          text: sentenceText(words, u.first, u.last),
          // a laugh/cheer just after the piece belongs to it (reactions lag the line)
          events: tracks
            ? [
                ...new Set(
                  momentTags(tracks, { start: u.start, end: u.end + 1.5 }).map((t) => t.text)
                ),
              ].join(", ")
            : undefined,
        })),
      })
      const out: Nomination[] = []
      for (const m of moments) {
        const ai = idxById.get(m.start_piece)
        let bi = idxById.get(m.end_piece)
        if (ai === undefined || bi === undefined || sec[bi].end <= sec[ai].start) continue
        const ci = m.climax_piece === null ? undefined : idxById.get(m.climax_piece)
        // nothing after the climax but a short reaction
        if (ci !== undefined)
          bi = endAfterClimax(sec, ai, ci, bi, { maxTailSec: 5, minSec: settings.minSec })
        out.push({
          start: sec[ai].start,
          end: sec[bi].end,
          strength: m.rating / 100,
          why: m.why,
          ...(ci !== undefined && ci >= ai && ci <= bi ? { climax: sec[ci].start } : {}),
        })
      }
      return out
    } catch (e) {
      failed++
      ctx.log(`Section ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`)
      return []
    } finally {
      ctx.progress(++done / sections.length)
    }
  })
  // overlapping sections can nominate the same moment twice: keep the stronger one
  const moments: Nomination[] = []
  for (const m of found.flat().sort((x, y) => y.strength - x.strength))
    if (!moments.some((k) => iou(k, m) > 0.5)) moments.push(m)
  moments.sort((x, y) => x.start - y.start)
  if (failed === sections.length) {
    // don't cache a total failure (e.g. CLI not logged in): candidates go ahead without
    // nominations, and re-running the pipeline tries again
    ctx.log("Every section failed: continuing without LLM nominations")
    return
  }
  ctx.log(
    `LLM nominated ${moments.length} moment(s)${failed ? ` (${failed} section(s) failed)` : ""}`
  )
  await writeJson(paths.nominations, {
    model: llm.model || llm.name,
    moments,
  } satisfies Nominations)
}
