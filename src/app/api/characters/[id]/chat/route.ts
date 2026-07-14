import { getDb } from "@/lib/db";
import { getCharacter } from "@/lib/repo/characters";
import { listChapters } from "@/lib/repo/chapters";
import { logLlmCall } from "@/lib/repo/llm";
import { getLlmClient, type CompleteResult } from "@/lib/llm/client";
import { hasEmDash } from "@/lib/llm/lint";
import { CONTROL_DELIM, extractMarkers } from "@/lib/llm/markers";
import { buildChatContext, buildChatRemainder, type ChatTurn } from "@/lib/chat";
import { validatePinChapter, pinRangeLabel } from "@/lib/chatPin";

// Character chatbot turn (Amendment A5). Body: { projectId, uiChapter, history,
// message, fixtureKey? }. The character context is the cacheable prompt prefix
// (A4.1); the transcript plus the new message is the variable remainder. Streams
// the reply with the same CONTROL_DELIM protocol as the draft route: raw text
// chunks, then a control frame carrying the clean marker-stripped reply, any
// [MISSING FACT] lines, and the em-dash flags. Nothing is persisted: chat history
// is client-state only, and the reply enters canon only through the explicit
// propose-as-fact gate on the client. Logs one llm_calls row, purpose "chat",
// chapterId null.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await ctx.params;
  const characterId = Number(id);
  const character = getCharacter(db, characterId);
  if (!character) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty body: defaults below apply and validation will reject.
  }
  const projectId = Number(body.projectId);
  const uiChapter = Number(body.uiChapter);
  const message = typeof body.message === "string" ? body.message : "";
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;
  const history: ChatTurn[] = Array.isArray(body.history)
    ? (body.history as unknown[])
        .map((h) => {
          const turn = h as { role?: unknown; text?: unknown };
          const role = turn.role === "assistant" ? "assistant" : "user";
          const text = typeof turn.text === "string" ? turn.text : "";
          return { role, text } as ChatTurn;
        })
        .filter((t) => t.text.trim().length > 0)
    : [];

  if (!Number.isFinite(projectId) || !Number.isFinite(uiChapter)) {
    return new Response(
      JSON.stringify({ error: "projectId and uiChapter required" }),
      { status: 400 },
    );
  }
  if (message.trim().length === 0) {
    return new Response(JSON.stringify({ error: "message required" }), {
      status: 400,
    });
  }

  // A5.1b: reject a pin outside [1, chapter count of the selected book] with a
  // clear message rather than assembling a context for a chapter that does not
  // exist.
  const chapterCount = listChapters(db, projectId).length;
  const pinCheck = validatePinChapter(uiChapter, chapterCount);
  if (!pinCheck.valid) {
    return new Response(
      JSON.stringify({
        error: `pinned chapter ${uiChapter} is out of range; valid chapters are ${pinRangeLabel(chapterCount)}`,
      }),
      { status: 400 },
    );
  }

  const context = buildChatContext(db, {
    characterId,
    projectId,
    uiChapter,
  });
  const remainder = buildChatRemainder({
    characterName: character.name,
    history,
    message,
  });

  const client = getLlmClient();
  const model = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";
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
        // The character context is the cacheable prefix; the transcript plus the
        // new message is the uncached remainder, so every turn after the first
        // reads the cached context (A4.1).
        const r1 = await pump(
          client.stream({
            purpose: "chat",
            model,
            system: context.system,
            promptPrefix: context.contextPrefix,
            prompt: remainder,
            maxTokens: 1024,
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
              "\n\n[em-dash detected in the reply, regenerating without it]\n\n",
            ),
          );
          const r2 = await pump(
            client.stream({
              purpose: "chat",
              model,
              system: context.system,
              promptPrefix: context.contextPrefix,
              prompt:
                remainder +
                "\n\nIMPORTANT: your previous reply used an em-dash, which is forbidden. Reply again using commas, colons, full stops, or restructured sentences. No em-dashes.",
              maxTokens: 1024,
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
          purpose: "chat",
          chapterId: null,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        });

        const markers = extractMarkers(finalText);
        // Second-pass safety: a retry that still contains an em-dash is flagged,
        // never silently accepted.
        const stillHasEmDash = hasEmDash(markers.clean);
        const control = {
          finalText: markers.clean,
          retried,
          emDashUnresolved: stillHasEmDash,
          missingFacts: markers.missingFacts,
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
