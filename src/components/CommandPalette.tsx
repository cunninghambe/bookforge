"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

// Amendment A11: the command palette. Mounted once in the root layout as a
// client island; owns the Ctrl/Cmd+K shortcut and also opens on the
// bookforge:open-palette window event dispatched by the TopNav search button
// (D107). Renders nothing on /login, where the search API would 401 anyway.

interface ApiHit {
  kind: "chapter" | "canon" | "character" | "state";
  id: number;
  projectId: number | null;
  title: string;
  snippet: string;
  chapter?: number;
  status?: string;
  canonType?: string;
  role?: string | null;
  characterId?: number;
  url: string;
}

interface NavCommand {
  label: string;
  url: string;
}

const NAV_COMMANDS: NavCommand[] = [
  { label: "Canon", url: "/canon" },
  { label: "Characters", url: "/characters" },
  { label: "Books", url: "/" },
  { label: "Settings", url: "/settings" },
  { label: "Import bible", url: "/import-bible" },
];

const KIND_ORDER: ApiHit["kind"][] = ["chapter", "canon", "character", "state"];

const GROUP_LABEL: Record<ApiHit["kind"], string> = {
  chapter: "Chapters",
  canon: "Canon",
  character: "Characters",
  state: "Character states",
};

const CANON_TYPE_LABEL: Record<string, string> = {
  world_rule: "world rule",
  style_rule: "style rule",
  timeline_event: "timeline",
  character_fact: "character",
  plot_decision: "plot",
};

type Item = { type: "nav"; nav: NavCommand } | { type: "hit"; hit: ApiHit };

interface Group {
  label: string;
  items: Item[];
}

// Snippet markers per D106: matched ranges arrive wrapped in U+0001/U+0002.
// Splitting on either marker leaves the matched text at odd indices, which
// render as <mark> elements. No raw HTML is ever injected.
function renderSnippet(snippet: string) {
  const parts = snippet.split(/[\u0001\u0002]/);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[2px] bg-warn-chip px-0.5 text-ink">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function buildGroups(query: string, hits: ApiHit[]): Group[] {
  const q = query.trim().toLowerCase();
  const navMatches = q
    ? NAV_COMMANDS.filter((n) => n.label.toLowerCase().includes(q))
    : NAV_COMMANDS;
  const groups: Group[] = [];
  if (navMatches.length > 0) {
    groups.push({
      label: "Go to",
      items: navMatches.map((nav) => ({ type: "nav", nav })),
    });
  }
  for (const kind of KIND_ORDER) {
    const forKind = hits.filter((h) => h.kind === kind);
    if (forKind.length > 0) {
      groups.push({
        label: GROUP_LABEL[kind],
        items: forKind.map((hit) => ({ type: "hit", hit })),
      });
    }
  }
  return groups;
}

function itemUrl(item: Item): string {
  return item.type === "nav" ? item.nav.url : item.hit.url;
}

function HitRow({ hit }: { hit: ApiHit }) {
  const meta: string[] = [];
  if (hit.kind === "chapter") {
    if (hit.chapter) meta.push(`ch ${hit.chapter}`);
    if (hit.status) meta.push(hit.status);
  } else if (hit.kind === "canon") {
    if (hit.canonType) meta.push(CANON_TYPE_LABEL[hit.canonType] ?? hit.canonType);
    if (hit.status) meta.push(hit.status);
  } else if (hit.kind === "character") {
    if (hit.role) meta.push(hit.role);
  } else if (hit.kind === "state") {
    if (hit.chapter) meta.push(`from ch ${hit.chapter}`);
  }
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        {hit.title && <span className="truncate text-sm text-ink">{hit.title}</span>}
        {meta.length > 0 && (
          <span className="shrink-0 text-xs text-faint">{meta.join(" / ")}</span>
        )}
      </div>
      {hit.snippet && (
        <div className="truncate text-xs text-muted">{renderSnippet(hit.snippet)}</div>
      )}
    </div>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ApiHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Sequence guard (the CanonManager pattern): only the latest request's
  // response is applied, so a slow stale response cannot overwrite a newer one.
  const requestIdRef = useRef(0);

  // The shortcut and the TopNav button both toggle the palette. /login is
  // checked at event time so the gate cannot go stale in a closure.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        if (window.location.pathname === "/login") return;
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => {
      if (window.location.pathname === "/login") return;
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("bookforge:open-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("bookforge:open-palette", onOpen);
    };
  }, []);

  // Opening starts fresh and focuses the input; navigating closes.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Debounced search with the stale-response guard.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const requestId = ++requestIdRef.current;
    if (q.length === 0) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as { results?: ApiHit[] };
        if (requestIdRef.current !== requestId) return;
        setHits(Array.isArray(data.results) ? data.results : []);
        setLoading(false);
      } catch {
        if (requestIdRef.current !== requestId) return;
        setHits([]);
        setLoading(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [open, query]);

  const groups = buildGroups(query, hits);
  const flat: Item[] = groups.flatMap((g) => g.items);

  // Clamp the selection when the list shrinks; reset it when the query changes.
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    if (selected >= flat.length && flat.length > 0) setSelected(flat.length - 1);
  }, [selected, flat.length]);
  useEffect(() => {
    document
      .getElementById(`palette-item-${selected}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (pathname === "/login" || !open) return null;

  const navigate = (item: Item) => {
    setOpen(false);
    router.push(itemUrl(item));
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0) setSelected((s) => (s + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length > 0) setSelected((s) => (s - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[selected];
      if (item) navigate(item);
    }
  };

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-[18vh]"
      onMouseDown={() => setOpen(false)}
      data-testid="command-palette"
    >
      <div
        className="w-full max-w-xl rounded-lg border border-edge bg-surface shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Search everything"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="Search chapters, canon, characters..."
          aria-label="Search everything"
          data-testid="palette-input"
          className="w-full rounded-t-lg border-b border-edge-soft bg-surface px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={
            flat.length > 0 ? `palette-item-${selected}` : undefined
          }
        />
        <div
          id="palette-results"
          role="listbox"
          className="max-h-[50vh] overflow-y-auto p-2"
        >
          {groups.map((group) => (
            <div key={group.label}>
              <div className="px-2 pb-1 pt-2 text-xs uppercase tracking-wide text-faint">
                {group.label}
              </div>
              {group.items.map((item) => {
                flatIndex += 1;
                const idx = flatIndex;
                const isSelected = idx === selected;
                return (
                  <div
                    key={
                      item.type === "nav"
                        ? `nav-${item.nav.url}`
                        : `hit-${item.hit.kind}-${item.hit.id}`
                    }
                    id={`palette-item-${idx}`}
                    role="option"
                    aria-selected={isSelected}
                    data-testid="palette-result"
                    data-hit={
                      item.type === "nav"
                        ? `nav-${item.nav.url}`
                        : `${item.hit.kind}-${item.hit.id}`
                    }
                    onMouseEnter={() => setSelected(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigate(item);
                    }}
                    className={`cursor-pointer rounded px-2 py-1.5 ${
                      isSelected ? "bg-inset" : ""
                    }`}
                  >
                    {item.type === "nav" ? (
                      <span className="text-sm text-ink">{item.nav.label}</span>
                    ) : (
                      <HitRow hit={item.hit} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {query.trim().length > 0 && !loading && hits.length === 0 && (
            <div className="px-2 py-4 text-sm text-muted" data-testid="palette-empty">
              No matches in chapters, canon, characters, or states.
            </div>
          )}
        </div>
        <div className="flex gap-4 border-t border-edge-soft px-4 py-2 text-xs text-faint">
          <span>Up/Down to navigate</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
