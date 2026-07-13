import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// These table definitions mirror the DDL in SPEC.md. The actual CREATE TABLE
// statements live in migrate.ts (applied idempotently). Drizzle uses these for
// typed query building only.

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  orderIndex: integer("order_index").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const canonFacts = sqliteTable("canon_facts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id), // NULL = series-wide
  type: text("type").notNull(), // world_rule | style_rule | timeline_event | character_fact | plot_decision
  content: text("content").notNull(),
  status: text("status").notNull().default("provisional"), // locked | provisional | retired
  source: text("source"), // seed | interrogation:<id> | extraction:<id> | manual
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const characters = sqliteTable("characters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  role: text("role"),
  voiceRules: text("voice_rules"),
  physical: text("physical"),
  notes: text("notes"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const characterStates = sqliteTable("character_states", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  characterId: integer("character_id")
    .notNull()
    .references(() => characters.id),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  chapterOrder: integer("chapter_order").notNull(),
  knows: text("knows"),
  feels: text("feels"),
  hiding: text("hiding"),
  // 'manual' for UI-created states, 'extraction:<chapter_id>' for approved
  // lock-time proposals (Amendment A1). Added via a guarded ALTER TABLE in
  // migrate.ts so existing databases upgrade idempotently.
  source: text("source").default("manual"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const chapters = sqliteTable("chapters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  orderIndex: integer("order_index").notNull(),
  title: text("title"),
  pov: text("pov"),
  synopsis: text("synopsis"),
  beats: text("beats"), // JSON array of beat strings
  dependencies: text("dependencies"), // JSON array of canon_fact ids
  summary: text("summary"),
  status: text("status").notNull().default("planned"), // planned | interrogating | drafting | review | locked
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const drafts = sqliteTable("drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chapterId: integer("chapter_id")
    .notNull()
    .references(() => chapters.id),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id")
    .notNull()
    .references(() => drafts.id),
  quotedText: text("quoted_text").notNull(),
  spanStart: integer("span_start"),
  spanEnd: integer("span_end"),
  comment: text("comment").notNull(),
  resolved: integer("resolved").default(0),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const questions = sqliteTable("questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chapterId: integer("chapter_id")
    .notNull()
    .references(() => chapters.id),
  question: text("question").notNull(),
  answer: text("answer"),
  resultingFactId: integer("resulting_fact_id").references(() => canonFacts.id),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// A pending revision awaiting hunk resolution (Phase 4). Holds the old and new
// text plus the flagged spans and declared consistency fixes, so the diff analysis
// is recomputed deterministically at resolve time. Resolving creates a new draft
// version and marks the revision resolved.
export const revisions = sqliteTable("revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id")
    .notNull()
    .references(() => drafts.id),
  chapterId: integer("chapter_id")
    .notNull()
    .references(() => chapters.id),
  oldText: text("old_text").notNull(),
  newText: text("new_text").notNull(),
  flaggedSpans: text("flagged_spans").notNull(), // JSON array
  consistencyFixes: text("consistency_fixes").notNull(), // JSON array of strings
  status: text("status").notNull().default("pending"), // pending | resolved
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Cost / drift logging for every LLM call.
export const llmCalls = sqliteTable("llm_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purpose: text("purpose").notNull(),
  chapterId: integer("chapter_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});
