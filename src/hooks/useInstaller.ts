import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Shared state machine for the auto-installer (Settings → About and the on-start UpdateDialog).
// Pings xshell.sh first via the `check_reachable` Tauri command (HTTPS + cert verification + body
// sanity-check, see lib.rs::check_reachable) so we can fall back to a clear "download manually"
// message on networks that DNS-sinkhole the domain. Holds the "Pinging…" state visible for at
// least 600ms so the check is observable on near-instant networks.
export type InstallState = "idle" | "checking" | "running";

export interface Installer {
  state: InstallState;
  error: string | null;
  run: () => Promise<void>;
  reset: () => void;
}

export function useInstaller(): Installer {
  const [state, setState] = useState<InstallState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setState("checking");
    const minVisibleMs = 600;
    const started = performance.now();
    try {
      const reachable = await invoke<boolean>("check_reachable", { host: "xshell.sh" });
      const elapsed = performance.now() - started;
      if (elapsed < minVisibleMs) await new Promise(r => setTimeout(r, minVisibleMs - elapsed));
      if (!reachable) {
        setError("xshell.sh isn't reachable — download the latest release from GitHub manually.");
        setState("idle");
        return;
      }
      setState("running");
      await invoke("run_install_script");
    } catch (e: any) {
      setError(e?.message || String(e));
      setState("idle");
    }
  }

  function reset() {
    setError(null);
    setState("idle");
  }

  return { state, error, run, reset };
}
