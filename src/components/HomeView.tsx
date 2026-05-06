import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPlus, Plus, Trash2, GitBranch, Search, ArrowRight, ArrowUp, Pencil, Folder as FolderIcon, ChevronRight, X, FolderOpen, MessageSquare, Sparkles } from "lucide-react";
import { SkillsPanel } from "./SkillsPanel";
import { ClaudeChatIcon } from "./ClaudeChatIcon";
import { timeAgo, processSessions } from "../utils";
import { useProjectImage } from "../hooks/useProjectImage";
import logo from "../assets/logo.png";
import type { ProjectInfo, ProjectSettings, SessionFolder, SessionInfo } from "../types";

interface HomeViewProps {
  projects: ProjectInfo[];
  allProjects: ProjectInfo[];
  selectedProject: ProjectInfo | null;
  projectIcons: Record<string, ProjectSettings>;
  recentSessions: SessionInfo[];
  projectSessions: SessionInfo[];
  openSessionIds: Set<string>;
  sessionGroupName?: Record<string, string>;
  loading: boolean;
  sessionsLoading: boolean;
  contextTreeEnabled: boolean;
  showSessionRowMetrics: boolean;
  showProjectStatsChart: boolean;
  projectStatsView: 'cost' | 'tokens';
  onChangeProjectStatsView: (view: 'cost' | 'tokens') => void;
  onOpenSession: (session: SessionInfo, project?: ProjectInfo) => void;
  onOpenSessionBackground: (session: SessionInfo, project?: ProjectInfo) => void;
  onSelectProject: (project: ProjectInfo) => void;
  onNewChat: (project: ProjectInfo) => void;
  onAddProject: () => void;
  onRemoveProject: (path: string) => void;
  onEditProject: (path: string) => void;
  onSaveFolders: (path: string, folders: SessionFolder[]) => void;
}

function genFolderId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

type TtFns = { showTt: (text: string, el: HTMLElement) => void; hideTt: () => void };

function HomeTooltip({ text, rect }: { text: string; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ top: rect.bottom + 6, left: -9999 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const w = ref.current.offsetWidth;
    const half = w / 2;
    const preferred = rect.left + rect.width / 2;
    const left = Math.max(half + 4, Math.min(preferred, window.innerWidth - half - 4));
    setStyle({ top: rect.bottom + 6, left });
  }, [rect, text]);
  return <div className="tab-tooltip" ref={ref} style={style}>{text}</div>;
}

// Pull already-assigned session IDs out of folders for quick "is categorized?" checks.
function getCategorizedIds(folders: SessionFolder[]): Set<string> {
  const s = new Set<string>();
  for (const f of folders) for (const id of f.sessionIds) s.add(id);
  return s;
}

// Condense a raw Claude model id like "claude-opus-4-7-20260101" into the short label users
// recognize ("Opus 4.7"). Unknown IDs fall back to whatever we can recover.
function formatModel(raw: string): string {
  if (!raw) return "";
  // Display names from the xshell-stats hook ("Opus 4.7 (1M context)") are already friendly —
  // don't re-format them, just strip the parenthetical for the badge (the ([1M]) lives on
  // the bar tooltip).
  if (raw.includes(" ") || raw.includes("(")) {
    return raw.split("(")[0].trim();
  }
  const m = raw.toLowerCase();
  const pickVersion = (prefix: string) => {
    const re = new RegExp(`${prefix}-(\\d+)(?:-(\\d+))?`);
    const match = m.match(re);
    if (!match) return null;
    return match[2] ? `${match[1]}.${match[2]}` : match[1];
  };
  if (m.includes("opus")) { const v = pickVersion("opus"); return v ? `Opus ${v}` : "Opus"; }
  if (m.includes("sonnet")) { const v = pickVersion("sonnet"); return v ? `Sonnet ${v}` : "Sonnet"; }
  if (m.includes("haiku")) { const v = pickVersion("haiku"); return v ? `Haiku ${v}` : "Haiku"; }
  return raw;
}

// Tier class used for color-coding the model badge — "opus" stands out, "haiku" recedes.
function modelTier(raw: string): "opus" | "sonnet" | "haiku" | "unknown" {
  const m = raw.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  return "unknown";
}

function formatCost(usd: number): string {
  if (usd < 0.005) return "<$0.01";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}

// Compact token count: 1.2M / 50k / 123 — used by the tokens chart, legend, and tooltip.
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

// A point in either a single-band (cost) or multi-band (tokens) series. `values` indexes
// match the `bandLabels` passed to MetricAreaChart — for cost that's a single $ band, for
// tokens it's [cache_read, cache_creation, input, output] in cost-impact order so the
// cheapest band sits visually at the bottom and pricier bands stack above.
type SeriesPoint = { date: string; values: number[] };

// Token band ordering used everywhere downstream — chart bands, legend chips, hover tooltip.
// Bottom→top in cost-impact order so the cheapest category forms the base of the stack and
// the most expensive sits visually on top of the pile.
const TOKEN_BAND_CLASSES = ["trend-band-cache-read", "trend-band-cache-creation", "trend-band-input", "trend-band-output"];
const TOKEN_BAND_LABELS  = ["Cache read", "Cache creation", "Input", "Output"];

// Aggregate per-day cost across a project's sessions and produce a continuous N-day series
// (oldest → newest, missing days = 0). The hook only stores days that had spending, so we
// pad zeros for quiet days — that's what makes the trendline read as a real trend rather
// than a few disconnected pillars.
function dailyCostSeries(sessions: SessionInfo[], days: number): SeriesPoint[] {
  const byDate = new Map<string, number>();
  for (const s of sessions) {
    if (!s.daily_cost) continue;
    for (const [date, usd] of Object.entries(s.daily_cost)) {
      byDate.set(date, (byDate.get(date) || 0) + usd);
    }
  }
  return paddedSeries(byDate, days, (v) => [v ?? 0]);
}

// Same shape as dailyCostSeries but with four token bands per day. Source is the JSONL-derived
// daily_tokens map on each session — independent of the xshell-stats hook, so it works even
// for users without the hook installed. Reorder Rust's [input, cache_creation, cache_read,
// output] tuple into [cache_read, cache_creation, input, output] for visual cost-impact order.
function dailyTokensSeries(sessions: SessionInfo[], days: number): SeriesPoint[] {
  const byDate = new Map<string, [number, number, number, number]>();
  for (const s of sessions) {
    if (!s.daily_tokens) continue;
    for (const [date, t] of Object.entries(s.daily_tokens)) {
      const cur = byDate.get(date) || [0, 0, 0, 0];
      // Rust order: [input, cache_creation, cache_read, output] →
      // chart order: [cache_read, cache_creation, input, output]
      cur[0] += t[2] || 0;
      cur[1] += t[1] || 0;
      cur[2] += t[0] || 0;
      cur[3] += t[3] || 0;
      byDate.set(date, cur);
    }
  }
  return paddedSeries(byDate, days, (v) => v ?? [0, 0, 0, 0]);
}

// Common pad-with-zeros loop shared by both daily series.
function paddedSeries<T>(byDate: Map<string, T>, days: number, fill: (v: T | undefined) => number[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, values: fill(byDate.get(key)) });
  }
  return out;
}

// Format a YYYY-MM-DD key as a short user-facing label like "Apr 27".
function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

// Smooth area chart for either a single-band metric (cost) or a stacked multi-band metric
// (tokens). Renders one filled area per visible band, a polyline along the topmost visible
// band, a "today" dot, a hover crosshair, and (in multi-band mode) a hover tooltip with
// per-band breakdown. SVG uses a fixed viewBox in pixel space so path math is clean, but
// stretches via CSS to fit the parent container.
//
// `bandClasses`/`bandLabels` are paired arrays (bottom→top order). `visibleBands` lets the
// caller hide a dominant band so smaller bands become readable — the chart re-scales to fit
// only the visible bands' totals.
function MetricAreaChart({
  series, bandClasses, bandLabels, visibleBands, format, height = 96,
}: {
  series: SeriesPoint[];
  bandClasses: string[];
  bandLabels?: string[];
  visibleBands?: boolean[];
  format: (n: number) => string;
  height?: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const W = 600; // viewBox width (px); the SVG itself is width:100% via CSS
  const padL = 4, padR = 4, padT = 6, padB = 14;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const bandCount = bandClasses.length;
  const visible = visibleBands ?? bandClasses.map(() => true);
  // Per-band visible value at point i — hidden bands contribute zero so the y-axis re-scales
  // to whatever's left. Cumulative sums use these masked values too.
  const visibleVal = (i: number, k: number) => (visible[k] ? series[i].values[k] : 0);
  const cumAt: number[][] = series.map((_, i) => {
    let acc = 0;
    return bandClasses.map((_, k) => (acc += visibleVal(i, k)));
  });
  const totals = cumAt.map(row => row[row.length - 1]);
  const max = totals.reduce((m, v) => Math.max(m, v), 0);
  const x = (i: number) => series.length <= 1 ? padL + innerW / 2 : padL + (i / (series.length - 1)) * innerW;
  const y = (v: number) => max <= 0 ? padT + innerH : padT + innerH - (v / max) * innerH;

  // Path for a single band k. The bottom edge tracks the cumulative-sum frontier of the
  // bands BELOW k that are still visible — when a lower band is hidden, k's bottom drops
  // to whatever's left underneath, so it stacks against the next visible neighbor.
  const bandPath = (k: number) => {
    const top: string[] = [];
    const bot: string[] = [];
    for (let i = 0; i < series.length; i++) {
      top.push(`${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(cumAt[i][k]).toFixed(1)}`);
      const lower = k === 0 ? 0 : cumAt[i][k - 1];
      bot.push(`L ${x(i).toFixed(1)} ${y(lower).toFixed(1)}`);
    }
    bot.reverse();
    return `${top.join(" ")} ${bot.join(" ")} Z`;
  };
  const linePath = series.map((_, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(totals[i]).toFixed(1)}`).join(" ");

  const todayIdx = series.length - 1;
  const hovered = hoverIdx != null ? { point: series[hoverIdx], total: totals[hoverIdx] } : null;
  const grandTotal = totals.reduce((a, b) => a + b, 0);
  const peak = max;

  // Three date ticks: oldest, middle, newest. Skip middle if the range is too short.
  const ticks = series.length >= 3
    ? [{ i: 0, label: shortDate(series[0].date) }, { i: Math.floor(series.length / 2), label: shortDate(series[Math.floor(series.length / 2)].date) }, { i: series.length - 1, label: "Today" }]
    : series.map((p, i) => ({ i, label: i === series.length - 1 ? "Today" : shortDate(p.date) }));

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(((px - padL) / innerW) * (series.length - 1))));
    setHoverIdx(idx);
  };

  // Tooltip lives in HTML space (not SVG) so font + layout stay consistent with the rest of
  // the panel. We position by the SVG's hover x ratio relative to the wrapper, and flip to
  // the left side of the cursor when hovering near the right edge so it never gets clipped.
  let tooltipStyle: React.CSSProperties | undefined;
  if (hovered && hoverIdx != null && wrapRef.current && bandCount > 1) {
    const ratio = x(hoverIdx) / W;
    const flipLeft = ratio > 0.6;
    tooltipStyle = {
      [flipLeft ? "right" : "left"]: `${flipLeft ? (1 - ratio) * 100 : ratio * 100}%`,
      [flipLeft ? "marginRight" : "marginLeft"]: 8,
    } as React.CSSProperties;
  }

  return (
    <div className="trend-chart" ref={wrapRef}>
      <div className="trend-chart-axis">
        <span>{hovered ? shortDate(hovered.point.date) : `Last ${series.length} days`}</span>
        <span>{hovered ? format(hovered.total) : `${format(grandTotal)} total · peak ${format(peak)}`}</span>
      </div>
      <div className="trend-chart-stage">
        <svg ref={svgRef} className={`trend-chart-svg ${bandCount > 1 ? "trend-stacked" : ""}`} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" onMouseMove={handleMove} onMouseLeave={() => setHoverIdx(null)}>
          <defs>
            <linearGradient id="metric-area-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.45" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {/* One filled path per visible band, bottom→top. Hidden bands are skipped entirely. */}
          {max > 0 && bandClasses.map((cls, k) => (
            visible[k] ? <path key={k} d={bandPath(k)} className={`trend-band ${cls}`} /> : null
          ))}
          {max > 0 && <path d={linePath} className="trend-line" />}
          {/* baseline */}
          <line x1={padL} x2={W - padR} y1={padT + innerH + 0.5} y2={padT + innerH + 0.5} className="trend-baseline" />
          {/* today dot */}
          {max > 0 && totals[todayIdx] > 0 && <circle cx={x(todayIdx)} cy={y(totals[todayIdx])} r="3" className="trend-today-dot" />}
          {/* hover crosshair + dot */}
          {hovered && (
            <g className="trend-hover">
              <line x1={x(hoverIdx!)} x2={x(hoverIdx!)} y1={padT} y2={padT + innerH} />
              {hovered.total > 0 && <circle cx={x(hoverIdx!)} cy={y(hovered.total)} r="3.5" />}
            </g>
          )}
        </svg>
        {/* Hover tooltip (multi-band only). Single-band charts already show the day total in
            the axis row, so a duplicate tooltip would just be noise. */}
        {hovered && bandCount > 1 && bandLabels && tooltipStyle && (
          <div className="trend-tooltip" style={tooltipStyle}>
            <div className="trend-tooltip-date">{shortDate(hovered.point.date)}</div>
            {bandLabels.map((label, k) => (
              visible[k] ? (
                <div key={k} className="trend-tooltip-row">
                  <span className={`trend-tooltip-swatch ${bandClasses[k]}`} />
                  <span className="trend-tooltip-label">{label}</span>
                  <span className="trend-tooltip-value">{format(hovered.point.values[k] || 0)}</span>
                </div>
              ) : null
            ))}
            <div className="trend-tooltip-row trend-tooltip-total">
              <span className="trend-tooltip-label">Total</span>
              <span className="trend-tooltip-value">{format(hovered.total)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="trend-chart-ticks">
        {ticks.map(t => <span key={t.i} style={{ left: `${(x(t.i) / W) * 100}%` }}>{t.label}</span>)}
      </div>
    </div>
  );
}

// Clickable color-keyed legend for the multi-band token chart. Click a chip to hide its
// band — the chart re-stacks and re-scales the y-axis to fit what's left, so a dominant
// cache_read band can be muted to expose the smaller bands underneath.
function MetricLegend({
  bandLabels, bandClasses, totals, visible, onToggle, format,
}: {
  bandLabels: string[];
  bandClasses: string[];
  totals: number[];
  visible: boolean[];
  onToggle: (k: number) => void;
  format: (n: number) => string;
}) {
  return (
    <div className="trend-legend" role="group" aria-label="Token band visibility">
      {bandLabels.map((label, k) => (
        <button
          key={k}
          type="button"
          className={`trend-legend-chip ${visible[k] ? "" : "is-hidden"}`}
          onClick={() => onToggle(k)}
          aria-pressed={visible[k]}
        >
          <span className={`trend-legend-swatch ${bandClasses[k]}`} />
          <span className="trend-legend-label">{label}</span>
          <span className="trend-legend-value">{format(totals[k] || 0)}</span>
        </button>
      ))}
    </div>
  );
}

function SessionRow({ session, isOpen, groupName, onClick, isDragging, onPointerDownDrag, onAddAsTab, tt, showMetrics }: { session: SessionInfo; isOpen: boolean; groupName?: string; onClick: () => void; isDragging?: boolean; onPointerDownDrag?: (e: React.PointerEvent) => void; onAddAsTab?: () => void; tt?: TtFns; showMetrics: boolean }) {
  const primaryLabel = isOpen ? "Switch to tab" : "Open in terminal";
  const modelLabel = formatModel(session.model);
  const tier = modelTier(session.model);
  const contextPct = session.context_limit > 0 ? Math.min(100, Math.round((session.context_tokens / session.context_limit) * 100)) : 0;
  // Color the context bar green/yellow/red based on how close we are to the limit — same
  // thresholds Claude's own `/status` output uses loosely: <60% fine, 60-85% warn, >85% hot.
  const contextLevel = contextPct >= 85 ? "hot" : contextPct >= 60 ? "warn" : "ok";
  // Cost is only ever shown when the xshell-stats statusline hook is configured — that's
  // the single authoritative source (Claude Code's own running total for the session,
  // including system-prompt + tools tokens). Without the hook there's nothing to show, so
  // the row hides cost + context entirely. Model + msg count + branch still show since
  // those come straight from the JSONL. Rate-limit usage lives once in the sidebar.
  const showCostContext = session.is_authoritative_stats && showMetrics;
  const hasMetrics = !!session.model || session.message_count > 0 || (showCostContext && (session.context_tokens > 0 || session.cost_usd > 0));
  return (
    <div className={`session-item ${isDragging ? "session-dragging" : ""}`} onClick={onClick} onPointerDown={onPointerDownDrag} onContextMenu={(e) => { if (onAddAsTab && !isOpen) { e.preventDefault(); onAddAsTab(); } }}>
      <div className={`session-item-icon ${isOpen ? "session-open" : ""}`}>
        {isOpen && <div className="session-open-dot" />}
      </div>
      <ClaudeChatIcon size={14} className="session-item-prompt" />
      <div className="session-item-content">
        <div className="session-item-title">{session.title}</div>
        <div className="session-item-meta">
          {session.project_name && <span>{session.project_name}</span>}
          {session.git_branch && <><span className="dot">&middot;</span><GitBranch size={10} style={{ display: "inline", verticalAlign: "-1px" }} /><span>{session.git_branch}</span></>}
        </div>
        {hasMetrics && (
          <div className="session-item-metrics">
            {modelLabel && <span className={`session-model-badge session-model-${tier}`} onMouseEnter={(e) => tt?.showTt(session.model, e.currentTarget)} onMouseLeave={() => tt?.hideTt()}><Sparkles size={9} />{modelLabel}</span>}
            {session.message_count > 0 && <span className="session-metric" onMouseEnter={(e) => tt?.showTt(`${session.message_count} user message${session.message_count === 1 ? "" : "s"}`, e.currentTarget)} onMouseLeave={() => tt?.hideTt()}><MessageSquare size={9} />{session.message_count}</span>}
            {showCostContext && session.context_tokens > 0 && (
              <span className={`session-metric session-metric-ctx`} onMouseEnter={(e) => tt?.showTt(`${session.context_tokens.toLocaleString()} / ${session.context_limit.toLocaleString()} tokens (${contextPct}%)`, e.currentTarget)} onMouseLeave={() => tt?.hideTt()}>
                <span className={`session-ctx-bar session-ctx-${contextLevel}`}>
                  <span className="session-ctx-fill" style={{ width: `${contextPct}%` }} />
                </span>
                {contextPct}%
              </span>
            )}
            {showCostContext && session.cost_usd > 0 && <span className="session-metric session-cost" onMouseEnter={(e) => tt?.showTt("Cost reported by Claude Code", e.currentTarget)} onMouseLeave={() => tt?.hideTt()}>{formatCost(session.cost_usd)}</span>}
          </div>
        )}
      </div>
      {groupName && <span className="session-group-badge" onMouseEnter={(e) => tt?.showTt(`In ${groupName}`, e.currentTarget)} onMouseLeave={() => tt?.hideTt()}>{groupName}</span>}
      <span className="session-item-time">{timeAgo(session.timestamp)}</span>
      <div className="session-item-actions" onPointerDown={(e) => e.stopPropagation()}>
        {onAddAsTab && !isOpen ? (
          <button className="session-action-btn" onClick={(e) => { e.stopPropagation(); tt?.hideTt(); onAddAsTab(); }} onMouseEnter={(e) => tt?.showTt("Add as tab (stay here)", e.currentTarget)} onMouseLeave={() => tt?.hideTt()}><Plus size={11} /></button>
        ) : (
          // Keep the column width stable when the Plus is omitted (active sessions)
          <span className="session-action-placeholder" aria-hidden />
        )}
        <button className="session-action-btn session-action-primary" onClick={(e) => { e.stopPropagation(); tt?.hideTt(); onClick(); }} onMouseEnter={(e) => tt?.showTt(primaryLabel, e.currentTarget)} onMouseLeave={() => tt?.hideTt()}><ArrowRight size={12} /></button>
      </div>
    </div>
  );
}

function SessionsLoader() {
  return <div className="sessions-loader"><div className="spinner-small" /></div>;
}

function sortWithOpen(sessions: SessionInfo[], openIds: Set<string>): SessionInfo[] {
  const processed = processSessions(sessions);
  return [...processed.filter(s => openIds.has(s.id)), ...processed.filter(s => !openIds.has(s.id))];
}

function SearchBar({ value, onChange, placeholder, onFocus, onBlur }: { value: string; onChange: (v: string) => void; placeholder?: string; onFocus?: () => void; onBlur?: () => void }) {
  return (
    <div className="search-bar">
      <Search size={13} className="search-bar-icon" />
      <input type="text" className="search-bar-input" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || "Search sessions..."} onFocus={onFocus} onBlur={onBlur} />
    </div>
  );
}

// Replaces the old "Continue where you left" cards with a slim stats overview: a daily area
// chart on the left, and two tiles on the right (Total + Messages). The chart + total tile
// switch between Cost and Tokens via the segmented control. Cost mode is gated on hook data;
// Tokens mode is JSONL-only so it works without the xshell-stats hook.
function ProjectStatsPanel({ sessions, view, onChangeView }: { sessions: SessionInfo[]; view: 'cost' | 'tokens'; onChangeView: (v: 'cost' | 'tokens') => void }) {
  const totalCost = sessions.reduce((sum, s) => sum + (s.is_authoritative_stats ? s.cost_usd : 0), 0);
  // Sum the four token categories across every session for the Total tile and the toggle gate.
  // Indexing follows the Rust SessionInfo field order: [input, cache_creation, cache_read, output].
  const tokenTotals = sessions.reduce(
    (acc, s) => {
      acc[0] += s.total_input_tokens || 0;
      acc[1] += s.total_cache_creation_tokens || 0;
      acc[2] += s.total_cache_read_tokens || 0;
      acc[3] += s.total_output_tokens || 0;
      return acc;
    },
    [0, 0, 0, 0],
  );
  const totalTokens = tokenTotals[0] + tokenTotals[1] + tokenTotals[2] + tokenTotals[3];
  // Per-band visibility for the tokens chart legend. Click a chip to mute its band — handy
  // when one category dominates the stack and hides the smaller bands. Reset on session set
  // changes would surprise users mid-toggle, so it survives across re-renders.
  const [visibleTokenBands, setVisibleTokenBands] = useState<boolean[]>([true, true, true, true]);
  const toggleTokenBand = (k: number) => setVisibleTokenBands(prev => {
    const next = prev.slice();
    next[k] = !next[k];
    // If the user just hid the last visible band, restore everything — empty chart is useless.
    if (!next.some(Boolean)) return prev.map(() => true);
    return next;
  });
  // Hide the panel entirely when neither mode has anything to show — same "empty project"
  // feel as before, just generalized.
  if (totalCost <= 0 && totalTokens <= 0) return null;

  const totalMessages = sessions.reduce((sum, s) => sum + (s.message_count || 0), 0);

  // The segmented control: only enable a mode when its data exists. If the user has no hook
  // at all we lock onto Tokens; if a session is too new for the JSONL to have any usage we
  // fall back to Cost.
  const costAvailable = totalCost > 0;
  const tokensAvailable = totalTokens > 0;
  const effectiveView: 'cost' | 'tokens' = view === 'cost' && !costAvailable ? 'tokens'
    : view === 'tokens' && !tokensAvailable ? 'cost'
    : view;

  return (
    <div className="project-stats">
      <div className="project-stats-row">
        <div className="project-stats-chart">
          <div className="project-stats-section-row">
            <div className="project-stats-section-label">
              {effectiveView === 'cost' ? 'Daily cost · last 30 days' : 'Daily tokens · last 30 days'}
            </div>
            <div className="metric-toggle" role="tablist" aria-label="Stats metric">
              <button
                role="tab"
                aria-selected={effectiveView === 'cost'}
                className={`metric-toggle-btn ${effectiveView === 'cost' ? 'is-active' : ''}`}
                disabled={!costAvailable}
                onClick={() => onChangeView('cost')}
              >Cost</button>
              <button
                role="tab"
                aria-selected={effectiveView === 'tokens'}
                className={`metric-toggle-btn ${effectiveView === 'tokens' ? 'is-active' : ''}`}
                disabled={!tokensAvailable}
                onClick={() => onChangeView('tokens')}
              >Tokens</button>
            </div>
          </div>
          {effectiveView === 'cost' ? (
            <MetricAreaChart series={dailyCostSeries(sessions, 30)} bandClasses={["trend-band-cost"]} format={formatCost} />
          ) : (
            <>
              <MetricAreaChart
                series={dailyTokensSeries(sessions, 30)}
                bandClasses={TOKEN_BAND_CLASSES}
                bandLabels={TOKEN_BAND_LABELS}
                visibleBands={visibleTokenBands}
                format={formatTokens}
              />
              <MetricLegend
                bandLabels={TOKEN_BAND_LABELS}
                bandClasses={TOKEN_BAND_CLASSES}
                // Legend totals follow chart order: [cache_read, cache_creation, input, output].
                totals={[tokenTotals[2], tokenTotals[1], tokenTotals[0], tokenTotals[3]]}
                visible={visibleTokenBands}
                onToggle={toggleTokenBand}
                format={formatTokens}
              />
            </>
          )}
        </div>
        <div className="project-stats-tiles">
          {effectiveView === 'cost' ? (
            <Tile label="Total" value={formatCost(totalCost)} sub={`across ${sessions.length} session${sessions.length === 1 ? "" : "s"}`} accent="success" />
          ) : (
            <Tile
              label="Total"
              value={formatTokens(totalTokens)}
              sub={`${Math.round((tokenTotals[2] / Math.max(1, totalTokens)) * 100)}% cache read`}
              accent="success"
            />
          )}
          <Tile label="Messages" value={totalMessages.toLocaleString()} sub="user prompts" />
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: "success" }) {
  return (
    <div className={`project-stats-tile ${accent ? `project-stats-tile-${accent}` : ""}`}>
      <div className="project-stats-tile-label">{label}</div>
      <div className="project-stats-tile-value">{value}</div>
      {sub && <div className="project-stats-tile-sub">{sub}</div>}
    </div>
  );
}

function ProjectIcon({ project, projectIcons, size }: { project: ProjectInfo; projectIcons: Record<string, ProjectSettings>; size: number }) {
  const settings = projectIcons[project.path.toLowerCase()];
  const iconValue = settings?.icon;
  const displayName = settings?.customName || project.name;
  const imgSrc = useProjectImage(iconValue);
  if (imgSrc) return <img src={imgSrc} style={{ width: size, height: size, borderRadius: 10, objectFit: "cover", flexShrink: 0 }} alt="" />;
  const bg = settings?.color || "var(--accent-terracotta)";
  return (
    <div style={{ width: size, height: size, borderRadius: 10, background: bg, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-primary)", fontSize: iconValue ? size * 0.5 : size * 0.35, fontWeight: 600, flexShrink: 0 }}>
      {iconValue || displayName.slice(0, 2).toUpperCase()}
    </div>
  );
}

function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
  if (!query.trim()) return sessions;
  const q = query.toLowerCase();
  return sessions.filter(s => s.title.toLowerCase().includes(q) || s.project_name.toLowerCase().includes(q) || s.git_branch.toLowerCase().includes(q));
}

export function HomeView({ projects, selectedProject, projectIcons, recentSessions, projectSessions, openSessionIds, sessionGroupName, loading, sessionsLoading, contextTreeEnabled, showSessionRowMetrics, showProjectStatsChart, projectStatsView, onChangeProjectStatsView, onOpenSession, onOpenSessionBackground, onSelectProject, onNewChat, onAddProject, onRemoveProject, onEditProject, onSaveFolders }: HomeViewProps) {
  const [search, setSearch] = useState("");
  // Scroll-driven collapse of the stats strip in the project detail view. Same UX the old
  // preview cards had: scroll down → strip slides up out of view; pull back up at the very
  // top with enough delta (or click the chip) → strip restores. Pulling-up uses a deliberate
  // accumulator so ordinary scroll-back-to-top doesn't yank the strip back unexpectedly.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const upAccumRef = useRef(0);
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop > 2) setStatsCollapsed(true);
  }, []);
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!statsCollapsed) { upAccumRef.current = 0; return; }
    if (el.scrollTop <= 0 && e.deltaY < 0) {
      upAccumRef.current += -e.deltaY;
      if (upAccumRef.current > 400) { upAccumRef.current = 0; setStatsCollapsed(false); }
    } else if (e.deltaY > 0) {
      upAccumRef.current = 0;
    }
  }, [statsCollapsed]);
  const restoreStats = useCallback(() => {
    setStatsCollapsed(false);
    upAccumRef.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  // Folder UX state (scoped to the selected project)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [folderCtxMenu, setFolderCtxMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  const [dragState, setDragState] = useState<{ sessionId: string; sourceFolderId: string | null; hoverFolderId: string | null | undefined; pos: { x: number; y: number }; offset: { x: number; y: number }; active: boolean; title: string } | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const showTt = useCallback((text: string, el: HTMLElement) => setTooltip({ text, rect: el.getBoundingClientRect() }), []);
  const hideTt = useCallback(() => setTooltip(null), []);
  const tt: TtFns = useMemo(() => ({ showTt, hideTt }), [showTt, hideTt]);

  // Live-read folders for the selected project. A new array identity only when it actually changes.
  const folders: SessionFolder[] = useMemo(() => {
    if (!selectedProject) return [];
    return projectIcons[selectedProject.path.toLowerCase()]?.folders || [];
  }, [selectedProject, projectIcons]);

  // Reset search / any in-progress folder ops when project changes
  useEffect(() => { setSearch(""); setRenamingFolderId(null); setFolderCtxMenu(null); setDragState(null); setStatsCollapsed(false); upAccumRef.current = 0; if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [selectedProject?.path]);

  // Close the folder context menu on outside click or Escape
  useEffect(() => {
    if (!folderCtxMenu) return;
    const onDown = () => setFolderCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFolderCtxMenu(null); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [folderCtxMenu]);

  const persistFolders = useCallback((next: SessionFolder[]) => {
    if (!selectedProject) return;
    onSaveFolders(selectedProject.path, next);
  }, [selectedProject, onSaveFolders]);

  const handleCreateFolder = useCallback(() => {
    const id = genFolderId();
    const next: SessionFolder[] = [...folders, { id, name: "New folder", collapsed: false, sessionIds: [] }];
    persistFolders(next);
    // Open rename immediately so the user can name it without extra clicks
    setRenamingFolderId(id);
    setRenameDraft("New folder");
  }, [folders, persistFolders]);

  const commitRename = useCallback(() => {
    if (!renamingFolderId) return;
    const trimmed = renameDraft.trim() || "Untitled";
    const next = folders.map(f => f.id === renamingFolderId ? { ...f, name: trimmed } : f);
    persistFolders(next);
    setRenamingFolderId(null);
  }, [renamingFolderId, renameDraft, folders, persistFolders]);

  const handleDeleteFolder = useCallback((id: string) => {
    persistFolders(folders.filter(f => f.id !== id));
  }, [folders, persistFolders]);

  const handleToggleCollapse = useCallback((id: string) => {
    persistFolders(folders.map(f => f.id === id ? { ...f, collapsed: !f.collapsed } : f));
  }, [folders, persistFolders]);

  // Move a session between folders (or to ungrouped when target is null).
  const handleMoveSession = useCallback((sessionId: string, _sourceId: string | null, targetId: string | null) => {
    // Remove from all folders first (handles drag from folder A to folder B, or to ungrouped)
    const stripped = folders.map(f => f.sessionIds.includes(sessionId) ? { ...f, sessionIds: f.sessionIds.filter(x => x !== sessionId) } : f);
    const next = targetId === null
      ? stripped
      : stripped.map(f => f.id === targetId ? { ...f, sessionIds: [sessionId, ...f.sessionIds], collapsed: false } : f);
    persistFolders(next);
  }, [folders, persistFolders]);

  // Drag logic — pointer-based (HTML5 DnD is blocked in Tauri webview)
  const startSessionDrag = useCallback((e: React.PointerEvent, session: SessionInfo, sourceFolderId: string | null) => {
    // Ignore clicks on interactive descendants already handled elsewhere
    if ((e.target as HTMLElement).closest("button, input")) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = { x: startX - rect.left, y: startY - rect.top };
    let active = false;
    let suppressedClick = false;

    const findDropFolder = (x: number, y: number): string | null | undefined => {
      let el: Element | null = document.elementFromPoint(x, y);
      while (el) {
        const ds = (el as HTMLElement).dataset;
        if (ds && "dropFolder" in ds) return ds.dropFolder === "" ? null : ds.dropFolder!;
        el = el.parentElement;
      }
      return undefined;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!active && Math.hypot(dx, dy) > 5) {
        active = true;
        suppressedClick = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        setDragState({ sessionId: session.id, sourceFolderId, hoverFolderId: undefined, pos: { x: ev.clientX, y: ev.clientY }, offset, active: true, title: session.title });
      }
      if (active) {
        const hover = findDropFolder(ev.clientX, ev.clientY);
        setDragState(prev => prev ? { ...prev, pos: { x: ev.clientX, y: ev.clientY }, hoverFolderId: hover } : prev);
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (active) {
        const hover = findDropFolder(ev.clientX, ev.clientY);
        if (hover !== undefined && hover !== sourceFolderId) handleMoveSession(session.id, sourceFolderId, hover);
        setDragState(null);
      }
      // Prevent the synthetic click that pointerup triggers when we intended a drag
      if (suppressedClick) {
        const preventClick = (clickEv: MouseEvent) => { clickEv.stopPropagation(); clickEv.preventDefault(); window.removeEventListener("click", preventClick, true); };
        window.addEventListener("click", preventClick, true);
        setTimeout(() => window.removeEventListener("click", preventClick, true), 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [handleMoveSession]);

  if (loading) {
    return <div className="loading-wrapper"><div className="spinner" /><span>Loading...</span></div>;
  }

  // Project sessions view
  if (selectedProject) {
    const sortedAll = sortWithOpen(projectSessions, openSessionIds);
    const filteredAll = filterSessions(sortedAll, search);
    const sessionById = new Map(projectSessions.map(s => [s.id, s]));

    // Split into: categorized (inside folders) vs ungrouped
    const categorized = getCategorizedIds(folders);
    const ungrouped = sortedAll.filter(s => !categorized.has(s.id));

    // When searching we flatten — folders are a long-term organization tool, not a filter layer.
    const isSearching = search.trim().length > 0;
    // The stats panel renders when at least one session has either authoritative cost data
    // (hook installed) or any non-zero JSONL token totals — mirror the panel's own gate so
    // the "Show stats" chip stays in sync with whether the panel actually has anything.
    // Also respect the user-level showProjectStatsChart toggle so the chip stays hidden
    // when the user has disabled the panel entirely from settings.
    const hasStats = projectSessions.some(s =>
      (s.is_authoritative_stats && s.cost_usd > 0) ||
      ((s.total_input_tokens || 0) + (s.total_cache_creation_tokens || 0) + (s.total_cache_read_tokens || 0) + (s.total_output_tokens || 0)) > 0
    );
    const showChip = statsCollapsed && !isSearching && hasStats && showProjectStatsChart;
    return (
      <div className="view-fixed fade-in project-detail-split">
        <div className="project-detail-main">
          <div className="project-detail-fixed-head">
            <div className="sessions-view-header">
              <div className="sessions-view-title-row">
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <ProjectIcon project={selectedProject} projectIcons={projectIcons} size={40} />
                  <div>
                    <div className="sessions-view-title">{projectIcons[selectedProject.path.toLowerCase()]?.customName || selectedProject.name}</div>
                    <div className="sessions-view-path">{selectedProject.path}</div>
                  </div>
                </div>
                <div className="sessions-view-header-actions">
                  <button className="btn btn-ghost" onClick={() => invoke("reveal_in_explorer", { path: selectedProject.path }).catch(() => {})} onMouseEnter={(e) => showTt("Reveal in Explorer", e.currentTarget)} onMouseLeave={hideTt}><FolderOpen size={12} /></button>
                  <button className="btn btn-ghost" onClick={() => onEditProject(selectedProject.path)} onMouseEnter={(e) => showTt("Edit project", e.currentTarget)} onMouseLeave={hideTt}><Pencil size={12} /></button>
                  <button className="btn btn-ghost" onClick={() => onRemoveProject(selectedProject.path)} onMouseEnter={(e) => showTt("Remove from sidebar", e.currentTarget)} onMouseLeave={hideTt}><Trash2 size={12} /></button>
                </div>
              </div>
            </div>
            <button className={`continue-chip ${showChip ? "show" : ""}`} onClick={restoreStats} onMouseEnter={(e) => showTt("Show project stats", e.currentTarget)} onMouseLeave={hideTt}>
              <ArrowUp size={11} />
              <span>Project stats</span>
            </button>
          </div>

          <div className="project-detail-scroll" ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel}>
            {!isSearching && showProjectStatsChart && (
              <div className={`project-stats-wrap ${statsCollapsed ? "collapsed" : ""}`}>
                <ProjectStatsPanel sessions={projectSessions} view={projectStatsView} onChangeView={onChangeProjectStatsView} />
              </div>
            )}

            <div className="project-detail-sticky">
              <div className="section-header section-header-with-actions">
                <span className="section-header-label">Sessions</span>
                <span className="section-header-line" />
                <div className="section-header-actions">
                  <button className="btn btn-primary" onClick={() => onNewChat(selectedProject)} onMouseEnter={(e) => showTt(`New chat in ${selectedProject.name}`, e.currentTarget)} onMouseLeave={hideTt}><Plus size={12} /> New Chat</button>
                  <button className="btn btn-ghost" onClick={handleCreateFolder} onMouseEnter={(e) => showTt("Create a folder to group sessions", e.currentTarget)} onMouseLeave={hideTt}><FolderPlus size={12} /> New Folder</button>
                </div>
              </div>
              <SearchBar value={search} onChange={setSearch} placeholder={sessionsLoading ? "Loading..." : `Search through ${sortedAll.length} session${sortedAll.length !== 1 ? "s" : ""}...`} />
            </div>

            <div className="project-detail-sessions" key={selectedProject.path}>
          {sessionsLoading ? <SessionsLoader /> : isSearching ? (
            <div className="session-list">
              {filteredAll.map(session => <SessionRow key={session.id} session={session} isOpen={openSessionIds.has(session.id)} groupName={sessionGroupName?.[session.id]} onClick={() => onOpenSession(session, selectedProject)} onAddAsTab={() => onOpenSessionBackground(session, selectedProject)} tt={tt} showMetrics={showSessionRowMetrics} />)}
              {filteredAll.length === 0 && <div className="empty-state"><div className="empty-state-desc">No sessions matching "{search}"</div></div>}
            </div>
          ) : (
            <>
              {folders.length > 0 && (
                <div className="folder-list">
                  {folders.map(folder => {
                    // Session objects sorted by newest first (open ones still pinned to top for visibility)
                    const folderSessionObjs = folder.sessionIds.map(id => sessionById.get(id)).filter((s): s is SessionInfo => !!s);
                    const folderSessions = sortWithOpen(folderSessionObjs, openSessionIds);
                    const activeInFolder = folderSessions.filter(s => openSessionIds.has(s.id)).length;
                    const isHoverTarget = dragState?.active && dragState.hoverFolderId === folder.id && dragState.sourceFolderId !== folder.id;
                    const isCollapsed = !!folder.collapsed;
                    const isRenaming = renamingFolderId === folder.id;
                    return (
                      <div key={folder.id} className={`folder ${isCollapsed ? "folder-collapsed" : "folder-open"} ${isHoverTarget ? "folder-drop-hover" : ""}`} data-drop-folder={folder.id}>
                        <div className="folder-header" onClick={() => !isRenaming && handleToggleCollapse(folder.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setFolderCtxMenu({ x: e.clientX, y: e.clientY, folderId: folder.id }); }}>
                          <ChevronRight size={12} className={`folder-chev ${isCollapsed ? "" : "open"}`} />
                          <FolderIcon size={13} className="folder-icon" />
                          {isRenaming ? (
                            <input autoFocus className="folder-rename-input" value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenamingFolderId(null); }} onClick={(e) => e.stopPropagation()} />
                          ) : (
                            <span className="folder-name" onDoubleClick={(e) => { e.stopPropagation(); setRenamingFolderId(folder.id); setRenameDraft(folder.name); }}>{folder.name}</span>
                          )}
                          {activeInFolder > 0 && <span className="folder-active-badge" onMouseEnter={(e) => showTt(`${activeInFolder} active session${activeInFolder > 1 ? "s" : ""}`, e.currentTarget)} onMouseLeave={hideTt}>{activeInFolder}</span>}
                          <span className="folder-count">{folderSessions.length}</span>
                          <button className="folder-action" onClick={(e) => { e.stopPropagation(); setRenamingFolderId(folder.id); setRenameDraft(folder.name); }} onMouseEnter={(e) => showTt("Rename", e.currentTarget)} onMouseLeave={hideTt}><Pencil size={10} /></button>
                          <button className="folder-action folder-action-danger" onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id); }} onMouseEnter={(e) => showTt("Delete folder", e.currentTarget)} onMouseLeave={hideTt}><X size={11} /></button>
                        </div>
                        <div className={`folder-body-wrap ${isCollapsed ? "collapsed" : ""}`} data-drop-folder={folder.id}>
                          <div className="folder-body">
                            {folderSessions.length === 0 ? (
                              <div className="folder-empty">Drop sessions here</div>
                            ) : folderSessions.map(session => (
                              <SessionRow key={session.id} session={session} isOpen={openSessionIds.has(session.id)} groupName={sessionGroupName?.[session.id]} onClick={() => onOpenSession(session, selectedProject)} isDragging={dragState?.active && dragState.sessionId === session.id} onPointerDownDrag={(e) => startSessionDrag(e, session, folder.id)} onAddAsTab={() => onOpenSessionBackground(session, selectedProject)} tt={tt} showMetrics={showSessionRowMetrics} />
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {folders.length > 0 && ungrouped.length > 0 && <div className="sessions-divider" />}

              <div className={`ungrouped-zone ${dragState?.active && dragState.hoverFolderId === null && dragState.sourceFolderId !== null ? "ungrouped-drop-hover" : ""}`} data-drop-folder="">
                {ungrouped.length === 0 && folders.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-title">No sessions yet</div>
                    <div className="empty-state-desc">Start a new chat to begin.</div>
                  </div>
                ) : (
                  <div className="session-list">
                    {ungrouped.map(session => (
                      <SessionRow key={session.id} session={session} isOpen={openSessionIds.has(session.id)} groupName={sessionGroupName?.[session.id]} onClick={() => onOpenSession(session, selectedProject)} isDragging={dragState?.active && dragState.sessionId === session.id} onPointerDownDrag={(e) => startSessionDrag(e, session, null)} onAddAsTab={() => onOpenSessionBackground(session, selectedProject)} tt={tt} showMetrics={showSessionRowMetrics} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          </div>
        </div>

        {/* Floating drag preview */}
        {dragState?.active && (
          <div className="session-drag-preview" style={{ position: "fixed", top: dragState.pos.y - dragState.offset.y, left: dragState.pos.x - dragState.offset.x }}>
            <div className="session-item session-drag-ghost">
              <ClaudeChatIcon size={14} className="session-item-prompt" />
              <div className="session-item-content"><div className="session-item-title">{dragState.title}</div></div>
            </div>
          </div>
        )}

        {tooltip && <HomeTooltip text={tooltip.text} rect={tooltip.rect} />}
        {folderCtxMenu && (() => {
          const folder = folders.find(f => f.id === folderCtxMenu.folderId);
          if (!folder) return null;
          const close = () => setFolderCtxMenu(null);
          return (
            <div className="ctx-menu" style={{ top: folderCtxMenu.y, left: folderCtxMenu.x }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="ctx-item" onClick={() => { setRenamingFolderId(folder.id); setRenameDraft(folder.name); close(); }}>Rename</div>
              <div className="ctx-item" onClick={() => { handleToggleCollapse(folder.id); close(); }}>{folder.collapsed ? "Expand" : "Collapse"}</div>
              <div className="ctx-separator" />
              <div className="ctx-item ctx-danger" onClick={() => { handleDeleteFolder(folder.id); close(); }}>Delete folder</div>
            </div>
          );
        })()}
        </div>
        {contextTreeEnabled && <SkillsPanel projectPath={selectedProject.path} projectName={projectIcons[selectedProject.path.toLowerCase()]?.customName || selectedProject.name} />}
      </div>
    );
  }

  // Home dashboard
  const sortedRecent = sortWithOpen(recentSessions, openSessionIds);
  const filtered = filterSessions(sortedRecent, search);

  return (
    <div className="view-fixed fade-in">
      <div className="view-fixed-header">
        <div className="home-header">
          <div className="home-logo"><img src={logo} alt="" /></div>
          <div>
            <div className="home-title">xshell</div>
            <div className="home-subtitle">Pick a project to start chatting, or jump back into a recent session.</div>
          </div>
        </div>

        {projects.length > 0 && (
          <div className="home-section" style={{ marginBottom: 0 }}>
            <div className="home-section-header">
              <span className="home-section-title">Recent Projects</span>
              <div className="home-section-actions">
                <button className="btn" onClick={onAddProject}><FolderPlus size={11} /> Add Project</button>
              </div>
            </div>
            <div className="project-cards">
              {projects.map(project => (
                <div key={project.path} className="project-card" onClick={() => onSelectProject(project)}>
                  <div className="project-card-header">
                    <div className="project-card-dot" />
                    <span className="project-card-name">{projectIcons[project.path.toLowerCase()]?.customName || project.name}</span>
                  </div>
                  <div className="project-card-path" title={project.path}>{project.path}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {projects.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-title">No projects added</div>
            <div className="empty-state-desc" style={{ marginBottom: 12 }}>Add a project to get started.</div>
            <button className="btn btn-primary" onClick={onAddProject}><FolderPlus size={12} /> Add Project</button>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <SearchBar value={search} onChange={setSearch} placeholder={sessionsLoading ? "Loading..." : `Search through ${sortedRecent.length} session${sortedRecent.length !== 1 ? "s" : ""}...`} />
        </div>
      </div>

      <div className="view-fixed-scroll home-scroll-enter">
        {sessionsLoading ? <SessionsLoader /> : (
          filtered.length > 0 ? (
            <div className="session-list">
              {filtered.map(session => <SessionRow key={session.id} session={session} isOpen={openSessionIds.has(session.id)} groupName={sessionGroupName?.[session.id]} onClick={() => onOpenSession(session)} onAddAsTab={() => onOpenSessionBackground(session)} tt={tt} showMetrics={showSessionRowMetrics} />)}
            </div>
          ) : search ? (
            <div className="empty-state"><div className="empty-state-desc">No sessions matching "{search}"</div></div>
          ) : null
        )}
      </div>
      {tooltip && <HomeTooltip text={tooltip.text} rect={tooltip.rect} />}
    </div>
  );
}
