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
      <p className="mb-8 text-sm text-neutral-500">
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
          className="w-full rounded border border-neutral-300 px-3 py-2 outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Checking..." : "Enter"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
