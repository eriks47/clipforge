/**
 * End-to-end smoke test: generates a short synthetic video (test pattern + sine bursts, no speech),
 * uploads it through the HTTP API, runs the whole analysis pipeline, approves the top candidate and
 * renders it to an mp4. Requires ffmpeg; transcription runs if the Python venv exists (it is skipped
 * otherwise, like the "Skip" button in the UI). First run downloads Chrome Headless Shell for Remotion.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Candidate, Clip, Job, Project } from "@clipforge/shared"

const dataDir = mkdtempSync(join(tmpdir(), "clipforge-e2e-"))
process.env.DATA_DIR = dataDir
process.env.LLM_PROVIDER = "none"

let base = ""
let close: (() => Promise<void>) | null = null

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`)
  return JSON.parse(text) as T
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

beforeAll(async () => {
  const { createApp } = await import("../src/app")
  const { setMediaBase } = await import("../src/jobs/handlers/render")
  const created = await createApp()
  await created.app.listen({ port: 0, host: "127.0.0.1" })
  const port = (created.app.server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  setMediaBase(base)
  close = created.close
})

afterAll(async () => {
  await close?.()
  rmSync(dataDir, { recursive: true, force: true })
})

describe("pipeline to rendered mp4", () => {
  it(
    "uploads, analyzes, proposes candidates and renders",
    async () => {
      // 1. synthetic 45 s video: loud bursts every 10 s (energy spikes) with silence in between
      const src = join(dataDir, "sample.mp4")
      execFileSync("ffmpeg", [
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=d=45:s=1280x720:r=30",
        "-f",
        "lavfi",
        "-i",
        "sine=f=440:d=45,volume='if(lt(mod(t,10),7),0.2+0.8*gt(mod(t,10),5),0)':eval=frame",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-shortest",
        src,
      ])
      const size = statSync(src).size

      // 2. chunked upload through the API
      const project = await json<Project>("POST", "/api/projects", {
        title: "e2e",
        filename: "sample.mp4",
        size,
      })
      const res = await fetch(`${base}/api/projects/${project.id}/upload?offset=0`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: readFileSync(src),
      })
      expect(res.ok).toBe(true)
      await json("POST", `/api/projects/${project.id}/upload/complete`)

      // 3. wait for the pipeline; skip transcription if the Python venv is unavailable
      await waitFor(
        async () => {
          const jobs = await json<Job[]>("GET", `/api/projects/${project.id}/jobs`)
          const failed = jobs.find((j) => j.status === "failed")
          if (failed?.type === "transcribe") await json("POST", `/api/jobs/${failed.id}/skip`)
          else if (failed) throw new Error(`${failed.type} failed: ${failed.error}`)
          return jobs.find((j) => j.type === "rank" && j.status === "done") ?? null
        },
        8 * 60_000,
        "analysis pipeline"
      )
      const p = await json<Project>("GET", `/api/projects/${project.id}`)
      expect(p.probe?.duration).toBeGreaterThan(44)
      expect(p.hasProxy).toBe(true)
      const analysis = await json<{ audio: { spikes: unknown[]; silences: unknown[] } }>(
        "GET",
        `/api/projects/${project.id}/analysis`
      )
      expect(analysis.audio.silences.length).toBeGreaterThan(0)

      const candidates = await json<Candidate[]>("GET", `/api/projects/${project.id}/candidates`)
      expect(candidates.length).toBeGreaterThan(0)
      for (const c of candidates) {
        expect(c.finalRating).toBeGreaterThanOrEqual(0)
        expect(c.finalRating).toBeLessThanOrEqual(100)
        expect(c.end - c.start).toBeGreaterThanOrEqual(15 - 0.01)
      }

      // 4. approve the best one, use centre framing (no faces in a test pattern) and render
      const { clip } = await json<{ clip: Clip }>("PATCH", `/api/candidates/${candidates[0].id}`, {
        status: "approved",
      })
      expect(clip).toBeTruthy()
      await json("PATCH", `/api/clips/${clip.id}`, {
        editConfig: { ...clip.editConfig, framing: { ...clip.editConfig.framing, mode: "center" } },
      })
      await json("POST", `/api/clips/${clip.id}/render`)
      const rendered = await waitFor(
        async () => {
          const c = await json<Clip>("GET", `/api/clips/${clip.id}`)
          if (c.status === "failed") {
            const jobs = await json<Job[]>("GET", "/api/render-jobs")
            throw new Error(`render failed: ${jobs.find((j) => j.clipId === clip.id)?.error}`)
          }
          return c.status === "rendered" ? c : null
        },
        8 * 60_000,
        "render"
      )

      // 5. verify the output
      expect(rendered.renderPath).toBeTruthy()
      const probe = JSON.parse(
        execFileSync("ffprobe", [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_streams",
          "-show_format",
          rendered.renderPath!,
        ]).toString()
      ) as {
        streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]
        format: { duration: string }
      }
      const v = probe.streams.find((s) => s.codec_type === "video")
      const a = probe.streams.find((s) => s.codec_type === "audio")
      expect(v).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 })
      expect(a?.codec_name).toBe("aac")
      expect(Number(probe.format.duration)).toBeGreaterThan(5)
      expect(rendered.metadata?.title).toBeTruthy()
    },
    20 * 60_000
  )
})
