import { useEffect, useRef, useState } from "react";
import { Cast, Copy, Check, ShieldAlert } from "lucide-react";
import type { HostSessionInfo } from "../types";

// Phone-remote dialog, opened from the cast button in the tab bar. Not hosting: one primary
// action. Hosting: the QR code (scan → phone opens the session URL), the 4-digit code the
// phone must enter, the raw URL for manual entry, and a live read-only toggle. Hosting always
// covers every terminal tab currently open — the tab list itself is synced from App.
export function HostDialog({ info, starting, onStart, onStop, onSetReadOnly, onClose }: {
  info: HostSessionInfo | null;
  starting: boolean;
  onStart: () => void;
  onStop: () => void;
  onSetReadOnly: (readOnly: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [onClose]);

  const copyUrl = () => {
    if (!info) return;
    navigator.clipboard.writeText(info.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  };

  return (
    <div className="picker-overlay">
      <div className="picker host-dialog" ref={ref}>
        <div className="picker-band"><span className="picker-band-label">Phone Remote</span></div>
        <div className="picker-head">
          <div className="picker-title">Control your terminals from your phone</div>
          <div className="picker-sub">Hosts every open terminal tab on your local network — switch tabs, read output, and type into the CLI from a browser.</div>
        </div>

        {!info ? (
          <div className="host-dialog-body">
            <button className="btn btn-primary host-start-btn" onClick={onStart} disabled={starting}>
              <Cast size={13} /> {starting ? "Starting…" : "Start hosting"}
            </button>
            <div className="host-note"><ShieldAlert size={12} /> Anyone on your network with the link and the 4-digit code can use these terminals. Stop hosting when you're done.</div>
          </div>
        ) : (
          <div className="host-dialog-body">
            <div className="host-live-row">
              {/* White tile behind the QR — scanners need the contrast on our dark theme. */}
              <div className="host-qr" dangerouslySetInnerHTML={{ __html: info.qr_svg }} />
              <div className="host-live-meta">
                <div className="host-live-label">Scan with your phone, then enter</div>
                <div className="host-pin">{info.pin}</div>
                <button className="host-url" onClick={copyUrl} title="Copy URL">
                  <span>{info.url}</span>
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                </button>
              </div>
            </div>
            <label className="host-readonly-row">
              <input type="checkbox" checked={info.read_only} onChange={(e) => onSetReadOnly(e.target.checked)} />
              <span>View only — viewers can watch but not type</span>
            </label>
            <div className="host-actions">
              <div className="host-note"><ShieldAlert size={12} /> Same network only. The link dies when you stop hosting or quit xshell.</div>
              <button className="btn host-stop-btn" onClick={onStop}>Stop hosting</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
