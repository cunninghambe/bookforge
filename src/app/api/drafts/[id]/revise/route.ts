import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { getDraft } from "@/lib/repo/drafts";
import { listUnresolvedComments } from "@/lib/repo/comments";
import { assemblableCanon } from "@/lib/repo/canon";
import { createRevision } from "@/lib/repo/revisions";
import { logLlmCall } from "@/lib/repo/llm";
import { getLlmClient, type CompleteResult } from "@/lib/llm/client";
import { modelFor } from "@/lib/modelFor";
import { hasEmDash } from "@/lib/llm/lint";
import {
  revisionSystemPrompt,
  patchRevisionSystemPrompt,
} from "@/lib/llm/prompts";
import { CONTROL_DELIM, extractConsistencyFixes } from "@/lib/llm/markers";
import { analyzeRevision, type FlaggedSpan } from "@/lib/revision/diff";
import {
  parsePatchEnvelope,
  applyPatches,
  replacementsHaveEmDash,
  shouldUseFullMode,
  type FailedPatch,
} from "@/lib/revision/patch";

// A4.2. Patch mode is the default: the model returns a JSON envelope of
// verbatim-anchored patches, which we apply mechanically to produce the revised
// full text. That full text then flows through the UNMODIFIED analyzeRevision +
// revisions-table + resolve enforcement path, exactly as full mode does. The
// route falls back to full-text mode when flagged spans cover more than 40% of the
// chapter (decided before calling) or when the patch JSON fails to parse after one
// patch-mode retry. Full mode keeps the old streaming, em-dash-linted behavior.
// The client buffers the whole stream and reads the trailing control frame, so
// patch mode's non-streaming complete() and full mode's streaming both end the
// same way: prose (if any) then CONTROL_DELIM + JSON.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const draftId = Number(id);
  const draft = getDraft(db, draftId);
  if (!draft) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }
  const chapter = getChapter(db, draft.chapterId);
  if (!chapter) {
    return new Response(JSON.stringify({ error: "chapter not found" }), {
      status: 404,
    });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty body allowed.
  }
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const oldText = draft.content;
  const comments = listUnresolvedComments(db, draftId);
  const flaggedSpans: FlaggedSpan[] = comments.map((c) => ({
    quotedText: c.quotedText,
    spanStart: c.spanStart,
    spanEnd: c.spanEnd,
    comment: c.comment,
  }));

  const styleRules = assemblableCanon(db, {
    projectId: chapter.projectId,
    types: ["style_rule"],
  }).map((f) => f.content);

  // A4.1: system + chapter text is the cacheable prefix; the flagged spans and
  // task are the variable remainder, so a retry (em-dash or JSON) reads the cache.
  const chapterPrefix = `## CHAPTER TEXT\n${oldText}\n\n`;
  const remainder = buildRevisionRemainder(flaggedSpans);
  const patchRemainder = buildPatchRemainder(flaggedSpans);

  const client = getLlmClient();
  // Revision shares the draft (prose) model per A8's env grouping.
  const model = modelFor(db, "revision");
  const encoder = new TextEncoder();

  // >40% coverage: skip patches, go straight to full mode (computed before any call).
  const startFull = shouldUseFullMode(oldText, flaggedSpans);

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

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      const accumulate = (r: CompleteResult) => {
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
        cacheReadTokens += r.cacheReadTokens ?? 0;
        cacheWriteTokens += r.cacheWriteTokens ?? 0;
      };

      try {
        let mode: "patch" | "full" = startFull ? "full" : "patch";
        let retried = false;
        let emDashUnresolved = false;
        let newText = "";
        let declaredFixes: string[] = [];
        let failedPatches: FailedPatch[] = [];

        if (mode === "patch") {
          const patchSystem = patchRevisionSystemPrompt(styleRules);
          const a1 = await client.complete({
            purpose: "revision",
            model,
            system: patchSystem,
            promptPrefix: chapterPrefix,
            prompt: patchRemainder,
            maxTokens: 4096,
            fixtureKey,
          });
          accumulate(a1);
          let parsed = parsePatchEnvelope(a1.text);

          if (!parsed.ok) {
            // One patch-mode retry. Same fixtureKey: a full-text response
            // deterministically fails to parse again in tests, so we fall through
            // to full mode without needing a separate retry fixture (D53).
            const a2 = await client.complete({
              purpose: "revision",
              model,
              system: patchSystem,
              promptPrefix: chapterPrefix,
              prompt:
                patchRemainder +
                "\n\nIMPORTANT: your previous reply was not valid JSON in the required shape. Return ONLY the JSON object with \"patches\" and \"consistency_fixes\". No prose outside the JSON.",
              maxTokens: 4096,
              fixtureKey,
            });
            accumulate(a2);
            parsed = parsePatchEnvelope(a2.text);
          }

          if (parsed.ok) {
            let env = parsed.envelope;
            // Em-dash lint on replacements: reject and retry once in patch mode.
            if (replacementsHaveEmDash(env.patches, env.consistencyFixes)) {
              retried = true;
              const a3 = await client.complete({
                purpose: "revision",
                model,
                system: patchSystem,
                promptPrefix: chapterPrefix,
                prompt:
                  patchRemainder +
                  "\n\nIMPORTANT: a replacement used an em-dash, which is forbidden. Return the JSON again with commas, colons, full stops, or restructured sentences. No em-dashes in any replacement.",
                maxTokens: 4096,
                fixtureKey: fixtureKey ? `${fixtureKey}.retry` : undefined,
              });
              accumulate(a3);
              const reparsed = parsePatchEnvelope(a3.text);
              if (reparsed.ok) env = reparsed.envelope;
              // Still dirty after the retry: warn via the existing mechanism.
              if (replacementsHaveEmDash(env.patches, env.consistencyFixes)) {
                emDashUnresolved = true;
              }
            }
            const applied = applyPatches(
              oldText,
              env.patches,
              env.consistencyFixes,
            );
            newText = applied.newText;
            declaredFixes = applied.declaredJustifications;
            failedPatches = applied.failedPatches;
          } else {
            // Patch JSON failed to parse after one retry: fall back to full mode.
            mode = "full";
          }
        }

        if (mode === "full") {
          const system = revisionSystemPrompt(styleRules);
          const r1 = await pump(
            client.stream({
              purpose: "revision",
              model,
              system,
              promptPrefix: chapterPrefix,
              prompt: remainder,
              maxTokens: 8192,
              fixtureKey,
            }),
          );
          accumulate(r1);
          let rawText = r1.text;

          if (hasEmDash(rawText)) {
            retried = true;
            controller.enqueue(
              encoder.encode(
                "\n\n[em-dash detected in the revision, regenerating without it]\n\n",
              ),
            );
            const r2 = await pump(
              client.stream({
                purpose: "revision",
                model,
                system,
                promptPrefix: chapterPrefix,
                prompt:
                  remainder +
                  "\n\nIMPORTANT: your previous attempt used an em-dash, which is forbidden. Rewrite using commas, colons, full stops, or restructured sentences. No em-dashes.",
                maxTokens: 8192,
                fixtureKey: fixtureKey ? `${fixtureKey}.retry` : undefined,
              }),
            );
            accumulate(r2);
            rawText = r2.text;
          }

          const { clean, fixes } = extractConsistencyFixes(rawText);
          newText = clean;
          declaredFixes = fixes;
          emDashUnresolved = hasEmDash(newText);
        }

        logLlmCall(db, {
          purpose: "revision",
          chapterId: chapter.id,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          model,
        });

        const analysis = analyzeRevision(oldText, newText, {
          flaggedSpans,
          consistencyFixes: declaredFixes,
        });

        const revision = createRevision(db, {
          draftId,
          chapterId: chapter.id,
          oldText,
          newText,
          flaggedSpans,
          consistencyFixes: declaredFixes,
        });

        const control = {
          revisionId: revision.id,
          mode,
          hunks: analysis.hunks,
          unauthorizedCount: analysis.unauthorizedCount,
          consistencyFixes: declaredFixes,
          failedPatches,
          retried,
          emDashUnresolved,
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

// Renders the flagged spans with their comments. Shared by both modes.
function renderFlaggedSpans(spans: FlaggedSpan[]): string {
  return spans.length
    ? spans
        .map(
          (s, i) =>
            `${i + 1}. Flagged span: "${s.quotedText}"\n   Comment: ${s.comment ?? ""}`,
        )
        .join("\n")
    : "(no spans flagged)";
}

// Full-mode remainder: flagged spans plus the full-text task. The chapter text is
// the cached prefix, so it is not repeated here.
function buildRevisionRemainder(spans: FlaggedSpan[]): string {
  return `## FLAGGED SPANS
${renderFlaggedSpans(spans)}

## TASK
Revise only the flagged spans per your contract. Return the complete revised chapter text. Do not use em-dashes.`;
}

// Patch-mode remainder: flagged spans plus the patch-envelope task.
function buildPatchRemainder(spans: FlaggedSpan[]): string {
  return `## FLAGGED SPANS
${renderFlaggedSpans(spans)}

## TASK
Revise only the flagged spans per your contract. Return the JSON envelope of patches and consistency_fixes described in the system prompt. Copy each "original" verbatim from the chapter text. Do not use em-dashes.`;
}
