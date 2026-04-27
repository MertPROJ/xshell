import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity } from "lucide-react";

// Global account-wide rate-limit snapshot, sourced from the freshest xshell-stats file
// across all sessions. Claude Code reports the same 5h/7d numbers on every session's
// statusline at any given moment — they're per-account, not per-session.
interface GlobalRateLimits {
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_resets_at: number | null;
  last_update_iso: string | null;
  source_session_id: string | null;
}

function formatResetIn(unixSec: number | null): string {
  if (!unixSec) return "—";
  const diff = unixSec * 1000 - Date.now();
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function levelFor(pct: number | null): "ok" | "warn" | "hot" {
  const p = pct ?? 0;
  if (p >= 80) return "hot";
  if (p >= 60) return "warn";
  return "ok";
}

// Single-row progress meter inside the popover. Mirrors the Claude usage page layout:
// title on top-left, "X% used" on top-right, 4-px bar below, "Resets in ..." subtitle.
function MeterRow({ label, pct, resetsAt }: { label: string; pct: number | null; resetsAt: number | null }) {
  const value = pct ?? 0;
  const lvl = levelFor(pct);
  return (
    <div className="rl-meter">
      <div className="rl-meter-head">
        <span className="rl-meter-label">{label}</span>
        <span className="rl-meter-pct">{value.toFixed(0)}% used</span>
      </div>
      <div className={`rl-meter-bar rl-meter-${lvl}`}>
        <span className="rl-meter-fill" style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <div className="rl-meter-sub">Resets in {formatResetIn(resetsAt)}</div>
    </div>
  );
}

interface PanelProps { data: GlobalRateLimits; rect: DOMRect }

// Hover popover positioned to the right of the chip. Fixed-positioned so it isn't clipped
// by the sidebar; we measure the chip rect and offset 12px to its right, vertically clamped
// inside the viewport so it never spills off-screen. The first paint must already have the
// final position — otherwise the user sees a brief jump from "default top" to centered.
// useLayoutEffect runs synchronously after DOM mutation but BEFORE the browser paints,
// which is exactly what we need here.
function Panel({ data, rect }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ top: -9999, left: -9999, visibility: "hidden" });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const h = ref.current.offsetHeight;
    const top = Math.max(8, Math.min(rect.top + rect.height / 2 - h / 2, window.innerHeight - h - 8));
    setPos({ top, left: rect.right + 12 });
  }, [rect]);

  return (
    <div ref={ref} className="rl-panel" style={pos}>
      <div className="rl-panel-section">
        <div className="rl-panel-title">Your usage limits</div>
        <MeterRow label="Current session" pct={data.five_hour_pct} resetsAt={data.five_hour_resets_at} />
      </div>
      <div className="rl-panel-divider" />
      <div className="rl-panel-section">
        <div className="rl-panel-title">Weekly limits</div>
        <MeterRow label="All models" pct={data.seven_day_pct} resetsAt={data.seven_day_resets_at} />
      </div>
      <div className="rl-panel-foot">
        Updated {ageLabel(data.last_update_iso)} · sourced from Claude Code statusline
      </div>
    </div>
  );
}

export function RateLimitIndicator() {
  const [data, setData] = useState<GlobalRateLimits | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = () => invoke<GlobalRateLimits>("get_global_rate_limits").then(d => { if (!cancelled) setData(d); }).catch(() => {});
    fetch();
    // Re-poll every 8s — cheap (single file read) and keeps the chip fresh while Claude
    // Code refreshes its statusline. Also re-fetches on window focus so users don't see
    // a stale value when alt-tabbing back in.
    const id = setInterval(fetch, 8000);
    const onFocus = () => fetch();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, []);

  // Hide entirely when no statusline data exists yet — the wizard handles the "set it up"
  // CTA, so cluttering the sidebar with an empty placeholder helps no one.
  if (!data || (data.five_hour_pct == null && data.seven_day_pct == null)) return null;

  const pct = Math.max(data.five_hour_pct ?? 0, data.seven_day_pct ?? 0);
  const level = levelFor(pct);

  const onEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
    setHoverRect(e.currentTarget.getBoundingClientRect());
  };
  const onLeave = () => {
    // Small delay so a momentary mouseout-during-pan doesn't flicker the panel away.
    hideTimer.current = window.setTimeout(() => setHoverRect(null), 100);
  };

  return (
    <div
      className={`ds-rate-limit ds-rate-${level}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="ds-rate-icon">
        <Activity size={11} />
        <span className="ds-rate-pct">{Math.round(pct)}<span className="ds-rate-pct-sym">%</span></span>
      </div>
      {hoverRect && <Panel data={data} rect={hoverRect} />}
    </div>
  );
}
