"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// A8: per-purpose model routing UI. One row per purpose showing the effective model
// and its source, a free-text model input with clickable suggestion chips (these are
// conveniences, NOT a whitelist: ids change over time and any string is accepted),
// and per-row Save, Reset to default, and Test buttons. Calm, text-forward styling.

interface PurposeModel {
  purpose: string;
  effective: string;
  source: "override" | "env" | "fallback";
  override: string | null;
  envDefault: string | null;
  fallback: string;
}

interface TestResult {
  ok: boolean;
  replySnippet?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  };
  error?: string;
}

// Convenience suggestions only. Aliases (sonnet, opus) work on the claude-code
// transport; the api-key transport needs full ids (see the note below the table).
const SUGGESTIONS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "sonnet",
  "opus",
];

function sourceLabel(source: PurposeModel["source"]): string {
  if (source === "override") return "override";
  if (source === "env") return "env default";
  return "fallback";
}

export function SettingsManager() {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const [models, setModels] = useState<PurposeModel[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [loaded, setLoaded] = useState(false);

  // Sync the editable inputs from the server map: an override prefills its input;
  // a purpose on its default starts blank so Save from blank is a no-op clear.
  const syncInputs = useCallback((next: PurposeModel[]) => {
    setInputs((prev) => {
      const merged = { ...prev };
      for (const m of next) {
        merged[m.purpose] = m.override ?? "";
      }
      return merged;
    });
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/settings/models");
    const data = (await res.json()) as { models: PurposeModel[] };
    setModels(data.models);
    syncInputs(data.models);
    setLoaded(true);
  }, [syncInputs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(purpose: string) {
    setBusy((b) => ({ ...b, [purpose]: true }));
    const res = await fetch("/api/settings/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose, model: inputs[purpose] ?? "" }),
    });
    const data = (await res.json()) as { models: PurposeModel[] };
    setModels(data.models);
    syncInputs(data.models);
    setBusy((b) => ({ ...b, [purpose]: false }));
  }

  async function reset(purpose: string) {
    setBusy((b) => ({ ...b, [purpose]: true }));
    const res = await fetch("/api/settings/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose, model: null }),
    });
    const data = (await res.json()) as { models: PurposeModel[] };
    setModels(data.models);
    // Clear the input explicitly (the merge keeps it, but be certain).
    setInputs((prev) => ({ ...prev, [purpose]: "" }));
    setBusy((b) => ({ ...b, [purpose]: false }));
  }

  async function test(purpose: string, effective: string) {
    setTesting((t) => ({ ...t, [purpose]: true }));
    setResults((r) => {
      const next = { ...r };
      delete next[purpose];
      return next;
    });
    // Test the entered override if present, else the effective model.
    const model = (inputs[purpose] ?? "").trim() || effective;
    const res = await fetch("/api/settings/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, fixtureKey }),
    });
    const data = (await res.json()) as TestResult;
    setResults((r) => ({ ...r, [purpose]: data }));
    setTesting((t) => ({ ...t, [purpose]: false }));
  }

  if (!loaded) {
    return (
      <p className="text-sm text-neutral-500" data-testid="settings-loading">
        Loading...
      </p>
    );
  }

  return (
    <div>
      <ul className="space-y-3" data-testid="model-rows">
        {models.map((m) => {
          const result = results[m.purpose];
          return (
            <li
              key={m.purpose}
              data-testid={`model-row-${m.purpose}`}
              className="rounded border border-neutral-200 bg-white p-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium capitalize">{m.purpose}</span>
                <span className="text-xs text-neutral-500">
                  effective:{" "}
                  <span
                    data-testid={`effective-${m.purpose}`}
                    className="font-mono text-neutral-800"
                  >
                    {m.effective}
                  </span>{" "}
                  <span
                    data-testid={`source-${m.purpose}`}
                    className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 uppercase tracking-wide text-neutral-500"
                  >
                    {sourceLabel(m.source)}
                  </span>
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  data-testid={`model-input-${m.purpose}`}
                  aria-label={`Model for ${m.purpose}`}
                  value={inputs[m.purpose] ?? ""}
                  placeholder={m.envDefault ?? m.fallback}
                  onChange={(e) =>
                    setInputs((prev) => ({
                      ...prev,
                      [m.purpose]: e.target.value,
                    }))
                  }
                  className="min-w-[16rem] flex-1 rounded border border-neutral-300 px-2 py-1 font-mono"
                />
                <button
                  data-testid={`save-${m.purpose}`}
                  onClick={() => save(m.purpose)}
                  disabled={busy[m.purpose]}
                  className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  data-testid={`reset-${m.purpose}`}
                  onClick={() => reset(m.purpose)}
                  disabled={busy[m.purpose]}
                  className="rounded border border-neutral-300 px-3 py-1 text-neutral-700 disabled:opacity-50"
                >
                  Reset to default
                </button>
                <button
                  data-testid={`test-${m.purpose}`}
                  onClick={() => test(m.purpose, m.effective)}
                  disabled={testing[m.purpose]}
                  className="rounded border border-sky-300 px-3 py-1 text-sky-700 disabled:opacity-50"
                >
                  {testing[m.purpose] ? "Testing..." : "Test"}
                </button>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    data-testid={`chip-${m.purpose}-${s}`}
                    onClick={() =>
                      setInputs((prev) => ({ ...prev, [m.purpose]: s }))
                    }
                    className="rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-xs text-neutral-600 hover:bg-neutral-50"
                  >
                    {s}
                  </button>
                ))}
              </div>

              {result && (
                <div
                  data-testid={`test-result-${m.purpose}`}
                  className={`mt-2 rounded border px-2 py-1.5 text-xs ${
                    result.ok
                      ? "border-green-300 bg-green-50 text-green-800"
                      : "border-red-300 bg-red-50 text-red-800"
                  }`}
                >
                  {result.ok ? (
                    <span>
                      OK. Reply:{" "}
                      <span
                        data-testid={`test-snippet-${m.purpose}`}
                        className="italic"
                      >
                        {result.replySnippet}
                      </span>
                      {result.usage && (
                        <span className="ml-2 text-green-700">
                          ({result.usage.inputTokens} in /{" "}
                          {result.usage.outputTokens} out)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span>Error: {result.error}</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p
        data-testid="alias-note"
        className="mt-4 max-w-2xl text-xs text-neutral-500"
      >
        Suggestions are conveniences, not a whitelist: any model id is accepted, and
        ids change over time. Alias names like sonnet or opus work on the claude-code
        transport; the api-key transport needs full model ids (for example
        claude-sonnet-4-6). Use Test to confirm a model is reachable before drafting.
      </p>
    </div>
  );
}
