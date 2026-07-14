import { TopNav } from "@/components/TopNav";
import { SettingsManager } from "@/components/SettingsManager";

export const dynamic = "force-dynamic";

// A8: per-purpose model routing. One row per purpose; the client fetches the live
// map from GET /api/settings/models so a save/reset reflects immediately.
export default function SettingsPage() {
  return (
    <main>
      <TopNav active="settings" />
      <h1 className="mt-6 font-serif text-xl">Settings</h1>
      <p className="mb-4 max-w-2xl text-sm text-muted">
        Choose the model per purpose. An override wins over the deploy-time env
        default (the prose default for drafting and revision, the utility default for
        the rest), which in turn wins over the built-in fallback. Reset deletes the
        override and reverts to the env default.
      </p>
      <SettingsManager />
    </main>
  );
}
