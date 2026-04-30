import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, ExternalLink, Download } from "lucide-react";
import type { UpdateInfo } from "../hooks/useUpdateCheck";
import { renderMarkdown } from "../markdown";
import { CodeCopy } from "./CodeCopy";

interface Props { info: UpdateInfo; onDismiss: () => void; }

// On-start update notice — fires once per new GitHub release. Any close path (X button,
// backdrop click, Esc, Dismiss, or View release) persists `last_seen_update_version`, so
// the dialog stays gone on subsequent launches until a NEWER tag ships. The +1 badge on the
// Settings cog and the About-tab dot are independent — they stay until the bundled version
// actually catches up.
export function UpdateDialog({ info, onDismiss }: Props) {
  const [installing, setInstalling] = useState(false);
  const canAutoInstall = info.installMethod === "npm";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !installing) onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, installing]);

  // Spawning the npm helper closes the app, so we just need to lock the dialog briefly while
  // the helper boots — Tauri's exit fires ~500ms after the spawn.
  const handleInstall = async () => {
    setInstalling(true);
    try { await invoke("run_npm_update"); }
    catch (e) { setInstalling(false); console.error("run_npm_update failed:", e); }
  };

  const overlayClick = installing ? undefined : onDismiss;

  return (
    <div className="md-overlay" onClick={overlayClick}>
      <div className="md-dialog upd-dialog" onClick={e => e.stopPropagation()}>
        <div className="md-head">
          <span className="md-title">Update available</span>
          <button className="md-head-btn" onClick={onDismiss} disabled={installing} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="md-body upd-body">
          <div className="upd-summary">
            xshell <strong>{info.latestVersion}</strong> is available — you're on <strong>{info.currentVersion}</strong>.
          </div>
          <div className="upd-install">
            {canAutoInstall
              ? <>Click <strong>Install update</strong> to close xshell, run <CodeCopy text="npm i -g xshell-app@latest" />, and relaunch automatically.</>
              : <>Install with <CodeCopy text="npm i -g xshell-app@latest" />, or download the binary from the release page.</>}
          </div>
          {info.releaseNotes && (
            <div className="upd-notes">
              <div className="upd-notes-head">Release notes — v{info.latestVersion}</div>
              <div className="upd-notes-body md-content">{renderMarkdown(info.releaseNotes)}</div>
            </div>
          )}
          {installing && <div className="upd-installing">Closing xshell — the npm install will run in a new console window, then xshell will relaunch.</div>}
        </div>
        <div className="upd-foot">
          <div className="upd-foot-spacer" />
          <button className="btn btn-ghost" onClick={onDismiss} disabled={installing}>Dismiss</button>
          {info.releaseUrl && (
            <button className="btn btn-ghost" disabled={installing} onClick={() => { invoke("open_url", { url: info.releaseUrl! }).catch(() => {}); }}>
              <ExternalLink size={11} /> View release
            </button>
          )}
          {canAutoInstall && (
            <button className="btn btn-primary" onClick={handleInstall} disabled={installing}>
              <Download size={11} /> {installing ? "Installing…" : "Install update"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
