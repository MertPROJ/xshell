import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, ExternalLink, Download, Loader2, AlertTriangle } from "lucide-react";
import type { UpdateInfo } from "../hooks/useUpdateCheck";
import { useInstaller } from "../hooks/useInstaller";
import { renderMarkdown } from "../markdown";

interface Props { info: UpdateInfo; onDismiss: () => void; }

// On-start update notice — fires once per new GitHub release. Any close path (X button,
// backdrop click, Esc, Dismiss, or View release) persists `last_seen_update_version`, so
// the dialog stays gone on subsequent launches until a NEWER tag ships. The +1 badge on the
// Settings cog and the About-tab dot are independent — they stay until the bundled version
// actually catches up.
export function UpdateDialog({ info, onDismiss }: Props) {
  const installer = useInstaller(info.update);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const pct = installer.progress != null ? Math.round(installer.progress * 100) : null;
  const busy = installer.state !== "idle";
  const btnLabel =
    installer.state === "downloading" ? <><Loader2 size={11} className="settings-spin" /> Downloading{pct != null ? ` ${pct}%` : "…"}</> :
    installer.state === "installing"  ? <><Loader2 size={11} className="settings-spin" /> Installing…</> :
    installer.state === "restarting"  ? <><Loader2 size={11} className="settings-spin" /> Restarting…</> :
                                        <><Download size={11} /> Install update</>;

  return (
    <div className="md-overlay" onClick={onDismiss}>
      <div className="md-dialog upd-dialog" onClick={e => e.stopPropagation()}>
        <div className="md-head">
          <span className="md-title">Update available</span>
          <button className="md-head-btn" onClick={onDismiss} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="md-body upd-body">
          <div className="upd-summary">
            xshell <strong>{info.latestVersion}</strong> is available — you're on <strong>{info.currentVersion}</strong>.
          </div>
          <div className="upd-install">Click Install to download and apply the update; xshell will restart automatically.</div>
          {installer.error && (
            <div className="settings-install-error upd-install-error">
              <AlertTriangle size={12} />
              <span>{installer.error}</span>
              {info.releaseUrl && (
                <button className="btn btn-ghost settings-action-btn" onClick={() => invoke("open_url", { url: info.releaseUrl! }).catch(() => {})}><ExternalLink size={11} /> Open releases</button>
              )}
            </div>
          )}
          {pct != null && busy && !installer.error && (
            <div className="upd-progress"><div className="upd-progress-bar" style={{ width: `${pct}%` }} /></div>
          )}
          {info.releaseNotes && (
            <div className="upd-notes">
              <div className="upd-notes-head">Release notes — v{info.latestVersion}</div>
              <div className="upd-notes-body md-content">{renderMarkdown(info.releaseNotes)}</div>
            </div>
          )}
        </div>
        <div className="upd-foot">
          <div className="upd-foot-spacer" />
          <button className="btn btn-primary" onClick={installer.run} disabled={busy || !info.update}>
            {btnLabel}
          </button>
          <button className="btn btn-ghost" onClick={onDismiss}>Dismiss</button>
          {info.releaseUrl && (
            <button className="btn btn-ghost" onClick={() => { invoke("open_url", { url: info.releaseUrl! }).catch(() => {}); }}>
              <ExternalLink size={11} /> View release
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
