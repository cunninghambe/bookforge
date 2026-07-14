import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getLlmClient } from "@/lib/llm/client";
import { logLlmCall } from "@/lib/repo/llm";

// A8: the settings-page Test button. Makes ONE tiny call through the ACTIVE
// transport with the entered model (purpose "model_test", logged to llm_calls like
// every other call), then returns { ok, replySnippet, usage } or { ok:false, error }
// with the underlying message verbatim, so an unentitled or misspelled model id
// fails at settings time rather than mid-draft.
export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model === "") {
    return NextResponse.json({ error: "model required" }, { status: 400 });
  }
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const client = getLlmClient();
  try {
    const res = await client.complete({
      purpose: "model_test",
      model,
      prompt: "Reply with a single short word to confirm you are reachable.",
      maxTokens: 16,
      fixtureKey,
    });
    logLlmCall(db, {
      purpose: "model_test",
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      cacheReadTokens: res.cacheReadTokens,
      cacheWriteTokens: res.cacheWriteTokens,
      model,
    });
    const snippet = res.text.trim().slice(0, 200);
    return NextResponse.json({
      ok: true,
      replySnippet: snippet,
      usage: {
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        cacheReadTokens: res.cacheReadTokens ?? null,
        cacheWriteTokens: res.cacheWriteTokens ?? null,
      },
    });
  } catch (err) {
    // The verbatim underlying message: a bad model id must surface its real error.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message });
  }
}
