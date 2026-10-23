import { mkdirSync } from "node:fs"
import { join } from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import * as schema from "./schema"

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, source_file TEXT NOT NULL, source_url TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0, uploaded_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    probe TEXT, settings TEXT NOT NULL, has_proxy INTEGER NOT NULL DEFAULT 0, has_thumbnail INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT, clip_id TEXT, status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0, log TEXT NOT NULL DEFAULT '', error TEXT, payload TEXT NOT NULL,
    depends_on TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, finished_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id)`,
  `CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status)`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, start REAL NOT NULL, "end" REAL NOT NULL,
    heuristic_score REAL NOT NULL, llm_rating REAL, final_rating REAL NOT NULL, breakdown TEXT NOT NULL,
    reason TEXT NOT NULL, llm_reason TEXT, category TEXT NOT NULL, suggested_hook TEXT NOT NULL, suggested_title TEXT NOT NULL,
    status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'auto', batch INTEGER NOT NULL DEFAULT 0, rank INTEGER NOT NULL DEFAULT 0,
    clip_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS candidates_project ON candidates(project_id)`,
  `CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, candidate_id TEXT, name TEXT NOT NULL, start REAL NOT NULL, "end" REAL NOT NULL,
    edit_config TEXT NOT NULL, status TEXT NOT NULL, render_path TEXT, rendered_at TEXT, metadata TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS clips_project ON clips(project_id)`,
  `CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // approve/reject decisions with a snapshot of everything ranking knew (for learning weights)
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, project_id TEXT NOT NULL, decision TEXT NOT NULL,
    snapshot TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS feedback_project ON feedback(project_id)`,
]

/** Columns added after the first release: [table, column, definition] */
// (old databases may still hold the removed posted/campaigns tables and clips.campaign_id: unused)
const ADDED_COLUMNS: [string, string, string][] = [
  ["candidates", "llm_scores", "TEXT"],
  ["candidates", "seeds", "TEXT"],
  ["candidates", "nominated", "REAL"],
]

export function openDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const sqlite = new Database(join(dataDir, "clipforge.db"))
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("synchronous = NORMAL")
  sqlite.pragma("foreign_keys = ON")
  for (const m of MIGRATIONS) sqlite.exec(m)
  for (const [table, column, def] of ADDED_COLUMNS) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column))
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
  }
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

export type Db = ReturnType<typeof openDb>["db"]
export { schema }
