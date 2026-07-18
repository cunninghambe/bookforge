"use client";

import { useEffect, useState } from "react";

// Amendment A10: the quiet search affordance in TopNav. The palette itself
// lives in the root layout; this button just asks it to open via the window
// event contract (D105).
export function SearchTrigger() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac/.test(navigator.userAgent));
  }, []);
  return (
    <button
      type="button"
      data-testid="nav-search"
      aria-label="Search everything"
      onClick={() => window.dispatchEvent(new Event("bookforge:open-palette"))}
      className="flex items-center gap-2 rounded border border-edge px-2 py-1 text-xs text-muted hover:text-ink"
    >
      Search
      <span className="rounded border border-edge-soft bg-inset px-1 text-[10px] text-faint">
        {isMac ? "Cmd K" : "Ctrl K"}
      </span>
    </button>
  );
}
