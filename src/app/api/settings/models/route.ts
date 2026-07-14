import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { modelMap, isModelPurpose } from "@/lib/modelFor";
import { setSetting, deleteSetting } from "@/lib/repo/settings";

// A8: the per-purpose model map. GET returns every purpose with its effective model
// and where the value came from (override | env | fallback). PUT sets or clears one
// purpose's override (clearing deletes the settings row), then returns the fresh map.

export async function GET() {
  const db = getDb();
  return NextResponse.json({ models: modelMap(db) });
}

export async function PUT(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const purpose = typeof body.purpose === "string" ? body.purpose : "";
  if (!isModelPurpose(purpose)) {
    return NextResponse.json({ error: `unknown purpose "${purpose}"` }, {
      status: 400,
    });
  }

  // A non-empty string sets the override; null / omitted / blank clears it (delete
  // the row, so the purpose reverts to its env default).
  const raw = body.model;
  const model = typeof raw === "string" ? raw.trim() : "";
  if (model === "") {
    deleteSetting(db, `model.${purpose}`);
  } else {
    setSetting(db, `model.${purpose}`, model);
  }

  return NextResponse.json({ models: modelMap(db) });
}
