import { getDb } from "@/lib/db";
import { assemblePrompt } from "@/lib/assembler";
import { getChapter } from "@/lib/repo/chapters";
import { logLlmCall } from "@/lib/repo/llm";
import { getLlmClient, type CompleteResult } from "@/lib/llm/client";
import { hasEmDash } from "@/lib/llm/lint";
import { CONTROL_DELIM, extractMarkers } from "@/lib/llm/markers";

// Streams prose for the marked beats. Protocol: raw text chunks, then a final
// control frame ("<<<BOOKFORGE_CTRL>>>" + JSON) carrying the clean marker-stripped
// text, retry flag, and any [MISSING FACT] / [CANON TENSION] alerts.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  const chapter = getChapter(db, chapterId);
  if (!chapter) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty body is allowed; defaults below apply.
  }
  const beats = Array.isArray(body.beats)
    ? body.beats.map(Number).filter((n) => Number.isFinite(n))
    : [];
  const draftedSoFar =
    typeof body.draftedSoFar === "string" ? body.draftedSoFar : "";
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const assembled = assemblePrompt(db, {
    chapterId,
    targetBeatIndices: beats,
    draftedSoFar,
  });

  const client = getLlmClient();
  const model = process.env.DRAFT_MODEL ?? "claude-sonnet-4-6";
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const pump = async (
        gen: AsyncGenerator<string, CompleteResult, unknown>,
      ): Promise<CompleteResult> => {
        while (true) {
          const { value, done } = await gen.next();
          if (done) return value;
          controller.enqueue(encoder.encode(value));
        }
      };

      try {
        // A4.1: the stable prefix (canon, characters, story so far, previous
        // chapter) is cached; only the variable remainder changes across the
        // scene-by-scene draft calls and the em-dash retry.
        const r1 = await pump(
          client.stream({
            purpose: "draft",
            model,
            system: assembled.system,
            promptPrefix: assembled.stablePrefix,
            prompt: assembled.variableRemainder,
            maxTokens: 4096,
            fixtureKey,
          }),
        );
        let finalText = r1.text;
        let inputTokens = r1.inputTokens;
        let outputTokens = r1.outputTokens;
        let cacheReadTokens = r1.cacheReadTokens ?? 0;
        let cacheWriteTokens = r1.cacheWriteTokens ?? 0;
        let retried = false;

        // Em-dash lint: hard reject, auto-retry once.
        if (hasEmDash(finalText)) {
          retried = true;
          controller.enqueue(
            encoder.encode(
              "\n\n[em-dash detected in the draft, regenerating without it]\n\n",
            ),
          );
          const r2 = await pump(
            client.stream({
              purpose: "draft",
              model,
              system: assembled.system,
              promptPrefix: assembled.stablePrefix,
              prompt:
                assembled.variableRemainder +
                "\n\nIMPORTANT: your previous attempt used an em-dash, which is forbidden. Rewrite the same scene using commas, colons, full stops, or restructured sentences. No em-dashes.",
              maxTokens: 4096,
              fixtureKey: fixtureKey ? `${fixtureKey}.retry` : undefined,
            }),
          );
          finalText = r2.text;
          inputTokens += r2.inputTokens;
          outputTokens += r2.outputTokens;
          cacheReadTokens += r2.cacheReadTokens ?? 0;
          cacheWriteTokens += r2.cacheWriteTokens ?? 0;
        }

        logLlmCall(db, {
          purpose: "draft",
          chapterId,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        });

        const markers = extractMarkers(finalText);
        // Second-pass safety: if a retry still contains an em-dash, flag it so the
        // author is never handed a silent violation.
        const stillHasEmDash = hasEmDash(markers.clean);
        const control = {
          finalText: markers.clean,
          retried,
          emDashUnresolved: stillHasEmDash,
          missingFacts: markers.missingFacts,
          canonTensions: markers.canonTensions,
          warnings: assembled.warnings,
        };
        controller.enqueue(
          encoder.encode(CONTROL_DELIM + JSON.stringify(control)),
        );
        controller.close();
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            CONTROL_DELIM + JSON.stringify({ error: (err as Error).message }),
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
