import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sparkles } from "lucide-react";
import { ClaudeChatIcon } from "./ClaudeChatIcon";
import { OpenAIIcon } from "./OpenAIIcon";
import { ttProps, type TtFns } from "./Tooltip";
import { timeAgo } from "../utils";
import type { ClaudeCostSummary, CodexUsage, SessionInfo } from "../types";

interface GlobalRateLimits {
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_resets_at: number | null;
}

interface UsageStripProps {
  recentSessions: SessionInfo[];
  tt: TtFns;
  onOpenSettings: () => void;
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function lastNDates(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(localDate(d));
  }
  return out;
}

function fmtUsd(v: number): string {
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

function fmtResetCountdown(resetsAt: number | null): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt * 1000 - Date.now();
  if (ms <= 0) return "resets soon";
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `resets in ${Math.round(h / 24)}d`;
  if (h >= 1) return `resets in ${h}h`;
  return `resets in ${Math.max(1, Math.round(ms / 60000))}m`;
}

// Mini rate-limit gauge: window label, a small fill bar, and the percentage. Color
// thresholds mirror the sidebar rate-limit chip (ok → warn → hot).
function Gauge({ label, pct, resetsAt, tt }: { label: string; pct: number | null; resetsAt: number | null; tt: TtFns }) {
  if (pct == null) return null;
  const state = pct >= 85 ? "hot" : pct >= 60 ? "warn" : "ok";
  const countdown = fmtResetCountdown(resetsAt);
  return (
    <div className={`usage-gauge usage-gauge-${state}`} {...ttProps(tt, `${label} window · ${Math.round(pct)}% used${countdown ? ` · ${countdown}` : ""}`)}>
      <span className="usage-gauge-label">{label}</span>
      <div className="usage-gauge-track"><div className="usage-gauge-fill" style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <span className="usage-gauge-pct">{Math.round(pct)}%</span>
    </div>
  );
}

// Home dashboard strip — one card per agent. Claude's cost numbers are hook-gated
// (authoritative only); without the hook the card falls back to JSONL-derived activity
// counts plus the Connect nudge. Codex needs no setup: rate limits and activity are read
// straight from its rollout files, with a staleness note since they only update when
// Codex actually runs.
export function UsageStrip({ recentSessions, tt, onOpenSettings }: UsageStripProps) {
  const [claudeCost, setClaudeCost] = useState<ClaudeCostSummary | null>(null);
  const [claudeLimits, setClaudeLimits] = useState<GlobalRateLimits | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      invoke<ClaudeCostSummary>("get_claude_cost_summary").then(v => { if (!cancelled) setClaudeCost(v); }).catch(() => {});
      invoke<GlobalRateLimits>("get_global_rate_limits").then(v => { if (!cancelled) setClaudeLimits(v); }).catch(() => {});
      invoke<CodexUsage>("get_codex_usage").then(v => { if (!cancelled) setCodex(v); }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const today = localDate(new Date());
  const weekDates = useMemo(() => new Set(lastNDates(7)), [today]);

  // Claude activity (always available from the JSONL — independent of the hook).
  const claudeSessionsToday = useMemo(() => recentSessions.filter(s => s.timestamp && localDate(new Date(s.timestamp)) === today).length, [recentSessions, today]);
  const claudeSessionsWeek = useMemo(() => recentSessions.filter(s => s.timestamp && weekDates.has(localDate(new Date(s.timestamp)))).length, [recentSessions, weekDates]);

  const costByDate = useMemo(() => new Map((claudeCost?.daily ?? []).map(d => [d.date, d.usd])), [claudeCost]);
  const costToday = costByDate.get(today) ?? 0;
  const costWeek = [...weekDates].reduce((sum, d) => sum + (costByDate.get(d) ?? 0), 0);
  const sparkDates = useMemo(() => lastNDates(14), [today]);
  const sparkMax = Math.max(...sparkDates.map(d => costByDate.get(d) ?? 0), 0.01);

  const codexSessionsByDate = useMemo(() => new Map((codex?.daily_sessions ?? []).map(d => [d.date, d.count])), [codex]);
  const codexToday = codexSessionsByDate.get(today) ?? 0;
  const codexWeek = [...weekDates].reduce((sum, d) => sum + (codexSessionsByDate.get(d) ?? 0), 0);

  const connected = claudeCost?.connected ?? false;

  return (
    <div className="usage-strip">
      <div className="usage-card">
        <div className="usage-card-head">
          <ClaudeChatIcon size={13} />
          <span className="usage-card-title">Claude Code</span>
          {connected && (
            <div className="usage-gauges">
              <Gauge label="5h" pct={claudeLimits?.five_hour_pct ?? null} resetsAt={claudeLimits?.five_hour_resets_at ?? null} tt={tt} />
              <Gauge label="7d" pct={claudeLimits?.seven_day_pct ?? null} resetsAt={claudeLimits?.seven_day_resets_at ?? null} tt={tt} />
            </div>
          )}
        </div>
        {connected ? (
          <div className="usage-card-body">
            <div className="usage-stat">
              <span className="usage-stat-value">{fmtUsd(costToday)}</span>
              <span className="usage-stat-label">today</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{fmtUsd(costWeek)}</span>
              <span className="usage-stat-label">this week</span>
            </div>
            <div className="usage-spark">
              {sparkDates.map(d => {
                const usd = costByDate.get(d) ?? 0;
                return <div key={d} className={`usage-spark-bar ${d === today ? "is-today" : ""}`} style={{ height: `${Math.max(8, (usd / sparkMax) * 100)}%` }} {...ttProps(tt, `${d} · ${fmtUsd(usd)}`)} />;
              })}
            </div>
          </div>
        ) : (
          <div className="usage-card-body">
            <div className="usage-stat">
              <span className="usage-stat-value">{claudeSessionsToday}</span>
              <span className="usage-stat-label">session{claudeSessionsToday === 1 ? "" : "s"} today</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{claudeSessionsWeek}</span>
              <span className="usage-stat-label">this week</span>
            </div>
            <button className="btn usage-connect" onClick={onOpenSettings}><Sparkles size={11} /> Connect for live cost &amp; limits</button>
          </div>
        )}
      </div>

      <div className="usage-card">
        <div className="usage-card-head">
          <span className="usage-card-openai"><OpenAIIcon size={13} /></span>
          <span className="usage-card-title">Codex</span>
          {codex?.present && (
            <div className="usage-gauges">
              <Gauge label="5h" pct={codex.primary?.used_percent ?? null} resetsAt={codex.primary?.resets_at ?? null} tt={tt} />
              <Gauge label="7d" pct={codex.secondary?.used_percent ?? null} resetsAt={codex.secondary?.resets_at ?? null} tt={tt} />
            </div>
          )}
        </div>
        {codex?.present ? (
          <div className="usage-card-body">
            <div className="usage-stat">
              <span className="usage-stat-value">{codexToday}</span>
              <span className="usage-stat-label">session{codexToday === 1 ? "" : "s"} today</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{codexWeek}</span>
              <span className="usage-stat-label">this week</span>
            </div>
            {codex.rate_limits_updated_iso && (
              <span className="usage-asof" {...ttProps(tt, "Codex only reports limits while running — these are from its last session")}>limits as of {timeAgo(codex.rate_limits_updated_iso)}</span>
            )}
          </div>
        ) : (
          <div className="usage-card-body">
            <span className="usage-empty">No Codex activity on this machine yet.</span>
          </div>
        )}
      </div>
    </div>
  );
}
