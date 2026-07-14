// A8: per-purpose model routing. One resolver, used by EVERY LLM call site (routes
// and MCP tools); no call site keeps a private process.env read. This file is the
// single place the DRAFT_MODEL / UTILITY_MODEL env vars are consulted.
//
// Precedence for each purpose: a settings override (key model.<purpose>) if present,
// then the purpose's env default (DRAFT_MODEL for draft and revision, UTILITY_MODEL
// for the rest), then the hardcoded fallback. The env vars remain the deploy-time
// defaults and are documented as such in .env.example.

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { getSetting } from "./repo/settings";

type Db = BetterSQLite3Database<typeof schema>;

// The exact eight purposes A8 routes. "model_test" (the Test button) is NOT here:
// it uses the user-entered model directly, not the resolver.
export const MODEL_PURPOSES = [
  "draft",
  "revision",
  "chat",
  "interrogation",
  "summary",
  "extraction",
  "sweep",
  "bible",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export const FALLBACK_MODEL = "claude-sonnet-4-6";

// draft and revision share DRAFT_MODEL (prose); everything else shares UTILITY_MODEL.
function isProsePurpose(purpose: ModelPurpose): boolean {
  return purpose === "draft" || purpose === "revision";
}

export function isModelPurpose(value: string): value is ModelPurpose {
  return (MODEL_PURPOSES as readonly string[]).includes(value);
}

// The env default for a purpose, or undefined when the relevant env var is unset or
// blank. This is the ONLY reader of DRAFT_MODEL / UTILITY_MODEL in the codebase.
export function envDefaultFor(purpose: ModelPurpose): string | undefined {
  const raw = isProsePurpose(purpose)
    ? process.env.DRAFT_MODEL
    : process.env.UTILITY_MODEL;
  return raw && raw.trim() !== "" ? raw : undefined;
}

export type ModelSource = "override" | "env" | "fallback";

export interface ResolvedModel {
  model: string;
  source: ModelSource;
}

// Resolve one purpose to its effective model and where the value came from. Throws
// on an unknown purpose so a typo fails loudly rather than silently falling back.
export function resolveModel(db: Db, purpose: string): ResolvedModel {
  if (!isModelPurpose(purpose)) {
    throw new Error(
      `unknown model purpose "${purpose}"; expected one of ${MODEL_PURPOSES.join(", ")}`,
    );
  }
  const override = getSetting(db, `model.${purpose}`);
  if (override !== undefined && override.trim() !== "") {
    return { model: override, source: "override" };
  }
  const env = envDefaultFor(purpose);
  if (env !== undefined) {
    return { model: env, source: "env" };
  }
  return { model: FALLBACK_MODEL, source: "fallback" };
}

// The effective model string for a purpose. The value every call site passes into
// the LLM client and into logLlmCall.
export function modelFor(db: Db, purpose: string): string {
  return resolveModel(db, purpose).model;
}

export interface PurposeModelInfo {
  purpose: ModelPurpose;
  effective: string;
  source: ModelSource;
  override: string | null;
  envDefault: string | null;
  fallback: string;
}

// The full purpose map for the settings page and GET /api/settings/models.
export function modelMap(db: Db): PurposeModelInfo[] {
  return MODEL_PURPOSES.map((purpose) => {
    const override = getSetting(db, `model.${purpose}`);
    const resolved = resolveModel(db, purpose);
    return {
      purpose,
      effective: resolved.model,
      source: resolved.source,
      override: override !== undefined && override.trim() !== "" ? override : null,
      envDefault: envDefaultFor(purpose) ?? null,
      fallback: FALLBACK_MODEL,
    };
  });
}
