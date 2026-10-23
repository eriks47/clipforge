import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import type { FastifyInstance } from "fastify"
import type { Artifact } from "@clipforge/shared"
import { config } from "../config"
import { clips, projects } from "../db/schema"
import { readJson } from "../lib/paths"
import { getDeps } from "../services"
import { openFolder } from "./clips"

/** Rendered videos found on disk (data/projects/<id>/renders/*.mp4), newest first. */
export async function listArtifacts(): Promise<Artifact[]> {
  const { db } = getDeps()
  const root = join(config.dataDir, "projects")
  if (!existsSync(root)) return []
  const titles = new Map(
    db
      .select({ id: projects.id, title: projects.title })
      .from(projects)
      .all()
      .map((p) => [p.id, p.title])
  )
  const clipByPath = new Map(
    db
      .select({ id: clips.id, name: clips.name, renderPath: clips.renderPath })
      .from(clips)
      .all()
      .filter((c) => c.renderPath)
      .map((c) => [c.renderPath!, c])
  )
  const out: Artifact[] = []
  for (const projectId of await readdir(root)) {
    const dir = join(root, projectId, "renders")
    if (!existsSync(dir)) continue
    for (const file of await readdir(dir)) {
      // skip half-written renders
      if (!file.endsWith(".mp4") || file.endsWith(".tmp.mp4")) continue
      const path = join(dir, file)
      const st = await stat(path).catch(() => null)
      if (!st?.isFile()) continue
      const clip = clipByPath.get(path)
      const meta = await readJson<{ title?: string }>(path.replace(/\.mp4$/, ".json"))
      out.push({
        file,
        path,
        url: relative(config.dataDir, path),
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        projectId,
        projectTitle: titles.get(projectId) ?? null,
        clipId: clip?.id ?? null,
        title:
          meta?.title ??
          clip?.name ??
          file.replace(/_[\w-]{10}\.mp4$|\.mp4$/, "").replace(/_/g, " "),
      })
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

export async function artifactRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", async () => listArtifacts())
  app.post<{ Params: { projectId: string } }>(
    "/api/artifacts/:projectId/open-folder",
    async (req) => {
      const dir = join(
        config.dataDir,
        "projects",
        req.params.projectId.replace(/[^\w-]/g, ""),
        "renders"
      )
      if (existsSync(dir)) openFolder(dir)
      return { ok: existsSync(dir), dir }
    }
  )
}
