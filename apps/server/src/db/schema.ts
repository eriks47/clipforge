import type {
  ClipMetadata,
  EditConfig,
  JobStatus,
  JobType,
  ProbeInfo,
  ProjectSettings,
} from "@clipforge/shared"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  sourceFile: text("source_file").notNull(),
  sourceUrl: text("source_url"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  uploadedBytes: integer("uploaded_bytes").notNull().default(0),
  status: text("status").notNull(),
  probe: text("probe", { mode: "json" }).$type<ProbeInfo | null>(),
  settings: text("settings", { mode: "json" }).$type<ProjectSettings>().notNull(),
  hasProxy: integer("has_proxy", { mode: "boolean" }).notNull().default(false),
  hasThumbnail: integer("has_thumbnail", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").$type<JobType>().notNull(),
  projectId: text("project_id"),
  clipId: text("clip_id"),
  status: text("status").$type<JobStatus>().notNull(),
  progress: real("progress").notNull().default(0),
  log: text("log").notNull().default(""),
  error: text("error"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  dependsOn: text("depends_on", { mode: "json" }).$type<string[]>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
})

export const candidates = sqliteTable("candidates", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  start: real("start").notNull(),
  end: real("end").notNull(),
  heuristicScore: real("heuristic_score").notNull(),
  llmRating: real("llm_rating"),
  finalRating: real("final_rating").notNull(),
  breakdown: text("breakdown", { mode: "json" }).$type<Record<string, number>>().notNull(),
  reason: text("reason").notNull(),
  llmReason: text("llm_reason"),
  /** LLM per-aspect scores (0-10): hook, self_contained, payoff, emotion, novelty */
  llmScores: text("llm_scores", { mode: "json" }).$type<Record<string, number>>(),
  /** which signals proposed the window (spike, heatmap, chat, dense, sliding, llm) */
  seeds: text("seeds", { mode: "json" }).$type<string[]>(),
  /** 0..1 when the LLM nominated the moment from the full transcript */
  nominated: real("nominated"),
  category: text("category").notNull(),
  suggestedHook: text("suggested_hook").notNull(),
  suggestedTitle: text("suggested_title").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull().default("auto"),
  batch: integer("batch").notNull().default(0),
  rank: integer("rank").notNull().default(0),
  clipId: text("clip_id"),
  createdAt: text("created_at").notNull(),
})

export const clips = sqliteTable("clips", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  candidateId: text("candidate_id"),
  name: text("name").notNull(),
  start: real("start").notNull(),
  end: real("end").notNull(),
  editConfig: text("edit_config", { mode: "json" }).$type<EditConfig>().notNull(),
  status: text("status").notNull(),
  renderPath: text("render_path"),
  renderedAt: text("rendered_at"),
  metadata: text("metadata", { mode: "json" }).$type<ClipMetadata | null>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const presets = sqliteTable("presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).$type<EditConfig>().notNull(),
  createdAt: text("created_at").notNull(),
})

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
})

export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id").notNull(),
  projectId: text("project_id").notNull(),
  /** approved | rejected | new (undone) | deleted */
  decision: text("decision").notNull(),
  snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
})
