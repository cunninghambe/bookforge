import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { getDraft } from "@/lib/repo/drafts";
import { listUnresolvedComments } from "@/lib/repo/comments";
import { assemblableCanon } from "@/lib/repo/canon";
import { createRevision } from "@/lib/repo/revisions";
import { logLlmCall } from "@/lib/repo/llm";
import { getLlmClient, type CompleteResult } from "@/lib/llm/client";
import { hasEmDash } from "@/lib/llm/lint";
import { revisionSystemPrompt } from "@/lib/llm/prompts";
import { CONTROL_DELIM, extractConsistencyFixes } from "@/lib/llm/markers";
import { analyzeRevision, type FlaggedSpan } from "@/lib/revision/diff";

// Streams a revised chapter, then returns diff analysis in a trailing control
// frame (same protocol as the draft route). The revision is persisted as pending;
// the client resolves any unauthorized hunks via /api/revisions/[id]/resolve.
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
  const system = revisionSystemPrompt(styleRules);
  const prompt = buildRevisionPrompt(oldText, flaggedSpans);

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
        const r1 = await pump(
          client.stream({
            purpose: "revision",
            model,
            system,
            prompt,
            maxTokens: 8192,
            fixtureKey,
          }),
        );
        let rawText = r1.text;
        let inputTokens = r1.inputTokens;
        let outputTokens = r1.outputTokens;
        let retried = false;

        // Em-dash lint: hard reject, auto-retry once (same as drafting).
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
              prompt:
                prompt +
                "\n\nIMPORTANT: your previous attempt used an em-dash, which is forbidden. Rewrite using commas, colons, full stops, or restructured sentences. No em-dashes.",
              maxTokens: 8192,
              fixtureKey: fixtureKey ? `${fixtureKey}.retry` : undefined,
            }),
          );
          rawText = r2.text;
          inputTokens += r2.inputTokens;
          outputTokens += r2.outputTokens;
        }

        logLlmCall(db, {
          purpose: "revision",
          chapterId: chapter.id,
          inputTokens,
          outputTokens,
        });

        const { clean: newText, fixes } = extractConsistencyFixes(rawText);
        // Second-pass safety: never hand back a silent em-dash violation.
        const emDashUnresolved = hasEmDash(newText);

        const analysis = analyzeRevision(oldText, newText, {
          flaggedSpans,
          consistencyFixes: fixes,
        });

        const revision = createRevision(db, {
          draftId,
          chapterId: chapter.id,
          oldText,
          newText,
          flaggedSpans,
          consistencyFixes: fixes,
        });

        const control = {
          revisionId: revision.id,
          hunks: analysis.hunks,
          unauthorizedCount: analysis.unauthorizedCount,
          consistencyFixes: fixes,
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

// The revision user prompt: full chapter text plus the flagged spans with their
// comments. The system prompt already carries the REVISION_PROMPT contract.
function buildRevisionPrompt(oldText: string, spans: FlaggedSpan[]): string {
  const flagged = spans.length
    ? spans
        .map(
          (s, i) =>
            `${i + 1}. Flagged span: "${s.quotedText}"\n   Comment: ${s.comment ?? ""}`,
        )
        .join("\n")
    : "(no spans flagged)";
  return `## CHAPTER TEXT
${oldText}

## FLAGGED SPANS
${flagged}

## TASK
Revise only the flagged spans per your contract. Return the complete revised chapter text. Do not use em-dashes.`;
}
