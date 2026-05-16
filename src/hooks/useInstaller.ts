import { useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Drives the auto-update download/install flow (used from Settings → About and the on-start
// UpdateDialog). The Update object comes from useUpdateCheck — same signed handle the updater
// plugin's check() returned. downloadAndInstall() streams Started/Progress/Finished events;
// once the await resolves the install has been applied and we call relaunch() to swap into
// the new version. On Windows the passive NSIS/MSI installer handles the relaunch itself.
export type InstallState = "idle" | "downloading" | "installing" | "restarting";

export interface Installer {
  state: InstallState;
  progress: number | null; // 0..1 if Content-Length is known, else null (indeterminate)
  error: string | null;
  run: () => Promise<void>;
  reset: () => void;
}

export function useInstaller(update: Update | null): Installer {
  const [state, setState] = useState<InstallState>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!update) {
      setError("No update is available to install.");
      return;
    }
    setError(null);
    setProgress(null);
    setState("downloading");
    let contentLength = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength || 0;
          downloaded = 0;
          setProgress(contentLength > 0 ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) setProgress(downloaded / contentLength);
        } else if (event.event === "Finished") {
          setProgress(1);
          setState("installing");
        }
      });
      setState("restarting");
      await relaunch();
    } catch (e: any) {
      setError(e?.message || String(e));
      setState("idle");
      setProgress(null);
    }
  }

  function reset() {
    setError(null);
    setState("idle");
    setProgress(null);
  }

  return { state, progress, error, run, reset };
}
