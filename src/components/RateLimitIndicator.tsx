import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity } from "lucide-react";
import { AGENTS, AgentIcon, type AgentId } from "../agents";
import type { CodexUsage } from "../types";

// Claude's account-wide rate-limit snapshot, sourced from the freshest xshell-stats file
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

// Agent-agnostic shape the chip + popover render from. Each enabled agent with data
// contributes one source; a third agent only needs to produce one of these.
interface RateSource {
  agent: AgentId;
  fivePct: number | null;
  fiveResetsAt: number | null;
  sevenPct: number | null;
  sevenResetsAt: number | null;
  updatedIso: string | null;
  // Codex only refreshes its limits while running, so its numbers are as old as the last
  // session — flagged so the footer says "as of" rather than "updated".
  stale: boolean;
  note: string | null; // extra footer context (e.g. plan type)
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

// Single-row progress meter inside the popover: title top-left, "X% used" top-right, a
// 4-px bar, then a "Resets in …" subtitle.
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

interface PanelProps { sources: RateSource[]; rect: DOMRect }

// Hover popover positioned to the right of the chip. Fixed-positioned so it isn't clipped
// by the sidebar; measured + clamped before paint (useLayoutEffect) so there's no jump.
// One section per agent — both limits live in this single dialog.
function Panel({ sources, rect }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ top: -9999, left: -9999, visibility: "hidden" });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const h = ref.current.offsetHeight;
    const top = Math.max(8, Math.min(rect.top + rect.height / 2 - h / 2, window.innerHeight - h - 8));
    setPos({ top, left: rect.right + 12 });
  }, [rect, sources.length]);

  return (
    <div ref={ref} className="rl-panel" style={pos}>
      {sources.map((src, i) => (
        <div key={src.agent}>
          {i > 0 && <div className="rl-panel-divider" />}
          <div className="rl-panel-section">
            <div className="rl-panel-head">
              <AgentIcon agent={src.agent} size={12} className={AGENTS[src.agent].neutralIcon ? "rl-panel-agent-icon-neutral" : "rl-panel-agent-icon"} />
              <span className="rl-panel-title">{AGENTS[src.agent].label}</span>
            </div>
            <MeterRow label="5-hour limit" pct={src.fivePct} resetsAt={src.fiveResetsAt} />
            <MeterRow label="Weekly limit" pct={src.sevenPct} resetsAt={src.sevenResetsAt} />
            <div className="rl-panel-foot">
              {src.stale ? "Limits as of " : "Updated "}{ageLabel(src.updatedIso)}{src.note ? ` · ${src.note}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Account-wide usage chip above the Settings cog. Hosts every enabled agent that has data:
// Claude (needs the statusline hook) and Codex (read straight from its rollout files). The
// collapsed chip shows the single worst percentage across all shown agents; the popover
// breaks it down per agent.
export function RateLimitIndicator({ showClaude, showCodex }: { showClaude: boolean; showCodex: boolean }) {
  const [claude, setClaude] = useState<GlobalRateLimits | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimer = useRef<number | null>(null);

  // Claude's hook file is cheap to read → poll every 8s, refresh on focus. Codex requires
  // scanning rollout files and only changes when Codex runs, so poll it less often.
  useEffect(() => {
    let cancelled = false;
    if (!showClaude) { setClaude(null); return; }
    const fetch = () => invoke<GlobalRateLimits>("get_global_rate_limits").then(d => { if (!cancelled) setClaude(d); }).catch(() => {});
    fetch();
    const id = setInterval(fetch, 8000);
    const onFocus = () => fetch();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [showClaude]);

  useEffect(() => {
    let cancelled = false;
    if (!showCodex) { setCodex(null); return; }
    const fetch = () => invoke<CodexUsage>("get_codex_usage").then(d => { if (!cancelled) setCodex(d); }).catch(() => {});
    fetch();
    const id = setInterval(fetch, 30000);
    const onFocus = () => fetch();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [showCodex]);

  // Assemble the visible sources. An agent contributes only when enabled AND it actually
  // has a percentage to show — no empty placeholder rows.
  const sources: RateSource[] = [];
  if (showClaude && claude && (claude.five_hour_pct != null || claude.seven_day_pct != null)) {
    sources.push({ agent: "claude", fivePct: claude.five_hour_pct, fiveResetsAt: claude.five_hour_resets_at, sevenPct: claude.seven_day_pct, sevenResetsAt: claude.seven_day_resets_at, updatedIso: claude.last_update_iso, stale: false, note: null });
  }
  if (showCodex && codex?.present && (codex.primary?.used_percent != null || codex.secondary?.used_percent != null)) {
    sources.push({ agent: "codex", fivePct: codex.primary?.used_percent ?? null, fiveResetsAt: codex.primary?.resets_at ?? null, sevenPct: codex.secondary?.used_percent ?? null, sevenResetsAt: codex.secondary?.resets_at ?? null, updatedIso: codex.rate_limits_updated_iso, stale: true, note: null });
  }

  if (sources.length === 0) return null;

  // Chip shows the worst window across every visible agent.
  const pct = Math.max(0, ...sources.flatMap(s => [s.fivePct ?? 0, s.sevenPct ?? 0]));
  const level = levelFor(pct);

  const onEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
    setHoverRect(e.currentTarget.getBoundingClientRect());
  };
  const onLeave = () => {
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
      {hoverRect && <Panel sources={sources} rect={hoverRect} />}
    </div>
  );
}
