"use client";

import { useEffect, useState } from "react";
import { captureException } from "@/lib/uh-oh-client";
import "./globals.css";

// Root-level fallback: catches errors that escape even the root layout (Next
// 15+ requires this file to define its own <html>/<body>, replacing the whole
// tree while active). Kept minimal and calm, consistent with the rest of the
// app, rather than a stack-trace dump. captureException is a silent no-op
// until NEXT_PUBLIC_UH_OH_DSN/UH_OH_DSN are configured, so this file behaves
// identically before and after a DSN exists, aside from the report itself.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    captureException(error);
  }, [error]);

  useEffect(() => {
    // No server render here to stamp the theme class (this file replaces the
    // root layout, which is what normally reads the cookie), so read it back
    // on mount, same mechanism as ThemeToggle.
    setDark(document.cookie.includes("bookforge_theme=dark"));
  }, []);

  return (
    <html lang="en" className={dark ? "dark" : undefined}>
      <body className="font-sans antialiased">
        <main className="mx-auto mt-40 max-w-sm text-center">
          <h1 className="mb-1 font-serif text-2xl">bookforge</h1>
          <p className="mb-8 text-sm text-muted">
            Something went wrong. The error has been recorded.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="btn-primary w-full px-3 py-2"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
