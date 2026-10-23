import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { Job, JobType } from "@clipforge/shared"
import type { Db } from "../db"
import { jobs } from "../db/schema"
import { bus } from "../lib/events"
import { nowIso } from "../lib/paths"
import { CanceledError } from "../lib/proc"

export interface JobContext {
  job: Job
  signal: AbortSignal
  log: (line: string) => void
  progress: (p: number) => void
  /** throws CanceledError if the job was canceled */
  checkCanceled: () => void
}

export type JobHandler = (ctx: JobContext) => Promise<void>

export interface EnqueueInput {
  type: JobType
  projectId?: string | null
  clipId?: string | null
  payload?: Record<string, unknown>
  dependsOn?: string[]
}

const MAX_LOG_CHARS = 200_000

export function rowToJob(r: typeof jobs.$inferSelect): Job {
  return { ...r, payload: r.payload ?? {}, dependsOn: r.dependsOn ?? [] }
}

/**
 * Persistent in-process job queue. Jobs live in SQLite, run with per-type concurrency,
 * wait for their dependencies, and report progress/logs over the event bus.
 */
export class JobQueue {
  private handlers = new Map<JobType, JobHandler>()
  private running = new Map<string, { abort: AbortController; type: JobType }>()
  private tickScheduled = false
  private stopped = false

  constructor(
    private db: Db,
    private concurrency: Partial<Record<JobType, number>>
  ) {}

  register(type: JobType, handler: JobHandler) {
    this.handlers.set(type, handler)
  }

  /** Mark jobs that were running when the server died as failed (retryable). */
  recover() {
    const now = nowIso()
    const stale = this.db.select().from(jobs).where(eq(jobs.status, "running")).all()
    for (const j of stale) {
      this.db
        .update(jobs)
        .set({
          status: "failed",
          error: "Interrupted by server restart — retry to resume",
          updatedAt: now,
          finishedAt: now,
        })
        .where(eq(jobs.id, j.id))
        .run()
    }
    if (stale.length) console.log(`[queue] marked ${stale.length} interrupted job(s) as failed`)
    this.schedule()
  }

  get(id: string): Job | null {
    const r = this.db.select().from(jobs).where(eq(jobs.id, id)).get()
    return r ? rowToJob(r) : null
  }

  list(
    filter: { projectId?: string; clipId?: string; types?: JobType[]; limit?: number } = {}
  ): Job[] {
    const conds = []
    if (filter.projectId) conds.push(eq(jobs.projectId, filter.projectId))
    if (filter.clipId) conds.push(eq(jobs.clipId, filter.clipId))
    if (filter.types?.length) conds.push(inArray(jobs.type, filter.types))
    return this.db
      .select()
      .from(jobs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(filter.limit ?? 500)
      .all()
      .map(rowToJob)
  }

  enqueue(input: EnqueueInput): Job {
    const now = nowIso()
    const row = {
      id: nanoid(12),
      type: input.type,
      projectId: input.projectId ?? null,
      clipId: input.clipId ?? null,
      status: "queued" as const,
      progress: 0,
      log: "",
      error: null,
      payload: input.payload ?? {},
      dependsOn: input.dependsOn ?? [],
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    }
    this.db.insert(jobs).values(row).run()
    const job = rowToJob(row)
    this.emit(job)
    this.schedule()
    return job
  }

  /** Active (queued/running) job of a type for a project/clip, if any — used to avoid duplicates. */
  findActive(type: JobType, scope: { projectId?: string; clipId?: string }): Job | null {
    const conds = [eq(jobs.type, type), inArray(jobs.status, ["queued", "running"])]
    if (scope.projectId) conds.push(eq(jobs.projectId, scope.projectId))
    if (scope.clipId) conds.push(eq(jobs.clipId, scope.clipId))
    const r = this.db
      .select()
      .from(jobs)
      .where(and(...conds))
      .get()
    return r ? rowToJob(r) : null
  }

  cancel(id: string): Job | null {
    const job = this.get(id)
    if (!job) return null
    const r = this.running.get(id)
    if (r) r.abort.abort()
    if (job.status === "queued" || job.status === "running") {
      this.update(id, { status: "canceled", finishedAt: nowIso(), error: "Canceled by user" })
    }
    // Cancel queued dependents too, otherwise they would wait forever.
    for (const dep of this.db.select().from(jobs).where(eq(jobs.status, "queued")).all()) {
      if ((dep.dependsOn ?? []).includes(id)) this.cancel(dep.id)
    }
    return this.get(id)
  }

  retry(id: string): Job | null {
    const job = this.get(id)
    if (!job || job.status === "running" || job.status === "queued") return job
    this.update(id, {
      status: "queued",
      error: null,
      progress: 0,
      finishedAt: null,
      startedAt: null,
      attempts: job.attempts + 1,
    })
    // Re-queue canceled dependents as well
    for (const dep of this.db.select().from(jobs).where(eq(jobs.status, "canceled")).all()) {
      if ((dep.dependsOn ?? []).includes(id)) this.retry(dep.id)
    }
    this.schedule()
    return this.get(id)
  }

  /** Mark a failed/queued job as done without running it, unblocking dependents. */
  skip(id: string): Job | null {
    const job = this.get(id)
    if (!job || job.status === "running") return job
    this.update(id, {
      status: "done",
      error: null,
      progress: 1,
      finishedAt: nowIso(),
      log: job.log + "\n[skipped by user]",
    })
    this.schedule()
    return this.get(id)
  }

  deleteForProject(projectId: string) {
    for (const j of this.list({ projectId })) {
      this.running.get(j.id)?.abort.abort()
    }
    this.db.delete(jobs).where(eq(jobs.projectId, projectId)).run()
  }

  stop() {
    this.stopped = true
    for (const r of this.running.values()) r.abort.abort()
  }

  private update(id: string, patch: Partial<typeof jobs.$inferInsert>) {
    this.db
      .update(jobs)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(jobs.id, id))
      .run()
    const j = this.get(id)
    if (j) this.emit(j)
  }

  private emit(job: Job) {
    // Don't ship megabytes of logs on every progress tick.
    bus.emitEvent({ type: "job", job: { ...job, log: job.log.slice(-4000) } })
  }

  schedule() {
    if (this.tickScheduled || this.stopped) return
    this.tickScheduled = true
    setImmediate(() => {
      this.tickScheduled = false
      this.tick()
    })
  }

  private tick() {
    const queued = this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "queued"))
      .orderBy(asc(jobs.createdAt))
      .all()
    if (queued.length === 0) return
    const statusOf = new Map<string, string>()
    const deps = [...new Set(queued.flatMap((q) => q.dependsOn ?? []))]
    if (deps.length)
      for (const d of this.db
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(inArray(jobs.id, deps))
        .all())
        statusOf.set(d.id, d.status)
    for (const q of queued) {
      const limit = this.concurrency[q.type] ?? 1
      const runningOfType = [...this.running.values()].filter((r) => r.type === q.type).length
      if (runningOfType >= limit) continue
      // A deleted dependency counts as satisfied.
      if (!(q.dependsOn ?? []).every((d) => !statusOf.has(d) || statusOf.get(d) === "done"))
        continue
      this.start(rowToJob(q))
    }
  }

  private start(job: Job) {
    const handler = this.handlers.get(job.type)
    const abort = new AbortController()
    this.running.set(job.id, { abort, type: job.type })
    const startedAt = nowIso()
    this.update(job.id, { status: "running", startedAt, progress: 0, error: null })

    let logBuf = ""
    let lastProgress = 0
    let dirty = false
    const current = this.get(job.id) ?? job
    let fullLog = current.log ? current.log + `\n--- attempt ${current.attempts + 1} ---\n` : ""
    const flush = () => {
      if (!dirty) return
      dirty = false
      fullLog = (fullLog + logBuf).slice(-MAX_LOG_CHARS)
      logBuf = ""
      this.update(job.id, { progress: lastProgress, log: fullLog })
    }
    const timer = setInterval(flush, 400)

    const ctx: JobContext = {
      job: current,
      signal: abort.signal,
      log: (line) => {
        logBuf += line.endsWith("\n") ? line : line + "\n"
        dirty = true
      },
      progress: (p) => {
        const v = Math.max(0, Math.min(1, p))
        if (Math.abs(v - lastProgress) >= 0.002 || v === 1) {
          lastProgress = v
          dirty = true
        }
      },
      checkCanceled: () => {
        if (abort.signal.aborted) throw new CanceledError()
      },
    }

    const exec = async () => {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`)
      await handler(ctx)
    }
    exec()
      .then(() => {
        clearInterval(timer)
        dirty = true
        lastProgress = 1
        flush()
        if (this.get(job.id)?.status === "running")
          this.update(job.id, { status: "done", progress: 1, finishedAt: nowIso() })
      })
      .catch((err: unknown) => {
        clearInterval(timer)
        dirty = true
        const canceled = err instanceof CanceledError || abort.signal.aborted
        const message = err instanceof Error ? err.message : String(err)
        if (!canceled) ctx.log(`ERROR: ${message}`)
        flush()
        if (canceled) {
          if (this.get(job.id)?.status === "running")
            this.update(job.id, { status: "canceled", finishedAt: nowIso(), error: "Canceled" })
        } else {
          console.error(`[job ${job.type} ${job.id}]`, message)
          this.update(job.id, { status: "failed", error: message, finishedAt: nowIso() })
        }
      })
      .finally(() => {
        this.running.delete(job.id)
        this.schedule()
      })
  }
}
