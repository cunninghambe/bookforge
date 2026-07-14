"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) {
      // push() alone: a refresh() here races and cancels the push on slow
      // (cold) servers, leaving the URL stuck on /login. Do not reintroduce.
      router.push("/canon");
    } else {
      setError("Incorrect password.");
    }
  }

  return (
    <main className="mx-auto mt-40 max-w-sm">
      <h1 className="mb-1 font-serif text-2xl">bookforge</h1>
      <p className="mb-8 text-sm text-muted">
        AI-drafted, human-steered.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <input
          type="password"
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="w-full rounded border border-edge px-3 py-2 outline-none focus-visible:border-focus"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-accent hover:bg-accent-hover px-3 py-2 text-accent-ink disabled:opacity-50"
        >
          {busy ? "Checking..." : "Enter"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-danger-ink">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
