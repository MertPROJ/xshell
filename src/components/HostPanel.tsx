import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Copy, Check, Monitor, Smartphone } from "lucide-react";
import type { HostInfo } from "../types";

// Side panel (lives in the terminal's right rail, alongside the git panel) for web-hosting a
// terminal. Deliberately its own component so future hosting options have room to grow here.
// Two states: pre-start (pick view-only + which surface owns the grid size, then Start) and
// live (link, 4-digit code, live toggles, Stop). All persistence/IPC lives in the parent —
// this is a pure controlled view.
interface HostPanelProps {
  hosting: HostInfo | null;
  onStart: (opts: { readOnly: boolean; browserOwns: boolean }) => void;
  onStop: () => void;
  onSetReadOnly: (readOnly: boolean) => void;
  onSetSizeOwner: (browserOwns: boolean) => void;
}

function HostSwitch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`host-switch ${on ? "on" : ""}`} onClick={onClick}>
      <span className="host-switch-knob" />
    </button>
  );
}

// Segmented App | Browser control for grid-size ownership.
function FitSegment({ browserOwns, onPick }: { browserOwns: boolean; onPick: (browserOwns: boolean) => void }) {
  return (
    <div className="host-seg" role="group" aria-label="Fit perfectly to">
      <button type="button" className={`host-seg-btn ${!browserOwns ? "on" : ""}`} onClick={() => onPick(false)}><Monitor size={12} /> App</button>
      <button type="button" className={`host-seg-btn ${browserOwns ? "on" : ""}`} onClick={() => onPick(true)}><Smartphone size={12} /> Browser</button>
    </div>
  );
}

export function HostPanel({ hosting, onStart, onStop, onSetReadOnly, onSetSizeOwner }: HostPanelProps) {
  const [startReadOnly, setStartReadOnly] = useState(false);
  const [startBrowserOwns, setStartBrowserOwns] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(label); window.setTimeout(() => setCopied(null), 1200); }).catch(() => {});
  };

  return (
    <div className="host-side">
      <div className="host-side-header">
        <Globe size={13} />
        <span className="host-side-title">Web hosting</span>
        {hosting && <span className="host-live-pill"><span className="host-live-dot" />Live</span>}
      </div>
      <div className="host-side-scroll">
        {!hosting ? (
          <div className="host-sec">
            <p className="host-hint">Stream this terminal to a browser on your network. Anyone with the link and the 4-digit code can {startReadOnly ? "watch" : "use"} it.</p>
            <div className="host-row">
              <span className="host-row-label">View only</span>
              <HostSwitch on={startReadOnly} onClick={() => setStartReadOnly(v => !v)} />
            </div>
            <div className="host-block">
              <span className="host-row-label">Fit perfectly to</span>
              <FitSegment browserOwns={startBrowserOwns} onPick={setStartBrowserOwns} />
              <span className="host-sub">{startBrowserOwns ? "The browser picks the size; the app view pauses while hosting." : "The app picks the size; the browser scales to fit (letterboxed)."}</span>
            </div>
            <button className="host-action host-action-go" onClick={() => onStart({ readOnly: startReadOnly, browserOwns: startBrowserOwns })}><Globe size={13} /> Start hosting</button>
          </div>
        ) : (
          <div className="host-sec">
            <div className="host-block">
              <span className="host-row-label">Link</span>
              <div className="host-field">
                <a className="host-field-val host-link" href={hosting.url} onClick={(e) => { e.preventDefault(); invoke("open_url", { url: hosting.url }).catch(() => {}); }}>{hosting.url}</a>
                <button className="host-copy" onClick={() => copy(hosting.url, "link")} aria-label="Copy link">{copied === "link" ? <Check size={12} /> : <Copy size={12} />}</button>
              </div>
            </div>
            <div className="host-block">
              <span className="host-row-label">Code</span>
              <div className="host-field">
                <span className="host-code">{hosting.pin}</span>
                <button className="host-copy" onClick={() => copy(hosting.pin, "code")} aria-label="Copy code">{copied === "code" ? <Check size={12} /> : <Copy size={12} />}</button>
              </div>
            </div>
            <div className="host-row">
              <span className="host-row-label">View only</span>
              <HostSwitch on={hosting.read_only} onClick={() => onSetReadOnly(!hosting.read_only)} />
            </div>
            <div className="host-block">
              <span className="host-row-label">Fit perfectly to</span>
              <FitSegment browserOwns={hosting.browser_owns} onPick={onSetSizeOwner} />
              <span className="host-sub">{hosting.browser_owns ? "The browser owns the size — the app view is paused." : "The app owns the size — the browser scales to fit."}</span>
            </div>
            <button className="host-action host-action-stop" onClick={onStop}>Stop hosting</button>
          </div>
        )}
      </div>
    </div>
  );
}
