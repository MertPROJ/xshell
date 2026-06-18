import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Paintbrush, Terminal as TerminalIcon, Settings as SettingsIcon, RotateCcw, Sparkles, Info, ExternalLink, RefreshCw, CheckCircle2, ChevronRight, Download, AlertTriangle, Loader2, Bot } from "lucide-react";
import { getAvailableShells } from "../shells";
import { ShellIcon } from "./ShellIcon";
import { AGENT_IDS, AGENTS, AgentIcon, type AgentId } from "../agents";
import { useTooltip, ttProps } from "./Tooltip";
import { DetailedSessionInfoWizard } from "./DetailedSessionInfoWizard";
import { DARK_TERM_BG, LIGHT_TERM_BG } from "./TerminalTab";
import type { UpdateInfo, ReleaseEntry } from "../hooks/useUpdateCheck";
import { useInstaller } from "../hooks/useInstaller";
import { renderMarkdown } from "../markdown";

export type ThemeMode = "dark" | "light";

interface SettingsViewProps {
  theme: ThemeMode;
  onSetTheme: (theme: ThemeMode) => void;
  defaultAgent: "ask" | AgentId;
  onSetDefaultAgent: (agent: "ask" | AgentId) => void;
  gitLazyPolling: boolean;
  onSetGitLazyPolling: (enabled: boolean) => void;
  gitPanelFilenamesOnly: boolean;
  onSetGitPanelFilenamesOnly: (enabled: boolean) => void;
  contextTreeEnabled: boolean;
  onSetContextTreeEnabled: (enabled: boolean) => void;
  terminalBgColor: string;
  onSetTerminalBgColor: (color: string) => void;
  defaultTerminalFontSize: number;
  onSetDefaultTerminalFontSize: (size: number) => void;
  alwaysOnTop: boolean;
  onSetAlwaysOnTop: (value: boolean) => void;
  defaultShell: string;
  onSetDefaultShell: (shellId: string) => void;
  fullscreenRendering: boolean;
  onSetFullscreenRendering: (enabled: boolean) => void;
  forceSyncOutput: boolean;
  onSetForceSyncOutput: (enabled: boolean) => void;
  webglRendering: boolean;
  onSetWebglRendering: (enabled: boolean) => void;
  terminalFontWeight: number;
  onSetTerminalFontWeight: (weight: number) => void;
  eagerInitTabs: boolean;
  onSetEagerInitTabs: (enabled: boolean) => void;
  showRateLimitInSidebar: boolean;
  onSetShowRateLimitInSidebar: (enabled: boolean) => void;
  showSessionRowMetrics: boolean;
  onSetShowSessionRowMetrics: (enabled: boolean) => void;
  showSessionRowMetricsCodex: boolean;
  onSetShowSessionRowMetricsCodex: (enabled: boolean) => void;
  showRateLimitInSidebarCodex: boolean;
  onSetShowRateLimitInSidebarCodex: (enabled: boolean) => void;
  showTerminalHeaderStats: boolean;
  onSetShowTerminalHeaderStats: (enabled: boolean) => void;
  showProjectStatsChart: boolean;
  onSetShowProjectStatsChart: (enabled: boolean) => void;
  updateInfo: UpdateInfo;
}

type Category = "appearance" | "agents" | "terminal" | "behavior" | "about";

const CATEGORIES: { id: Category; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "appearance", label: "Appearance", icon: Paintbrush },
  { id: "agents",     label: "Agents",     icon: Bot },
  { id: "terminal",   label: "Terminal",   icon: TerminalIcon },
  { id: "behavior",   label: "Behavior",   icon: SettingsIcon },
  { id: "about",      label: "About",      icon: Info },
];

// Mirror of the Rust AgentBinaryProbe — result of resolving an agent CLI on the user's PATH.
interface AgentProbe { installed: boolean; path: string | null; version: string | null }
type AgentProbeState = { loading: boolean; probe: AgentProbe | null };

// Identity card at the top of each agent's block on the Agents page: icon + name, the
// resolved binary path once detected, and a live found / not-found chip. `--version` output
// varies per agent ("2.1.129 (Claude Code)", "codex-cli 0.46.0"), so the chip shows just the
// extracted version number. The whole card toggles the agent's settings body open/closed —
// same chevron affordance as the changelog rows — so the detection status stays visible
// even when an agent's settings are collapsed.
function AgentHeader({ icon, name, tagline, state, onRefresh, open, onToggle, tt }: { icon: React.ReactNode; name: string; tagline: string; state: AgentProbeState; onRefresh: () => void; open: boolean; onToggle: () => void; tt: ReturnType<typeof useTooltip>["tt"] }) {
  const { loading, probe } = state;
  const version = probe?.version?.match(/\d+(?:\.\d+)+/)?.[0];
  return (
    <div className={`settings-agent-header ${open ? "is-open" : ""}`} onClick={onToggle} role="button" aria-expanded={open}>
      <ChevronRight size={13} className="settings-agent-chevron" />
      <div className="settings-agent-icon">{icon}</div>
      <div className="settings-agent-text">
        <div className="settings-agent-name">{name}</div>
        <div className="settings-agent-sub">{probe?.installed && probe.path ? <span className="settings-agent-path" {...ttProps(tt, probe.path)}>{probe.path}</span> : tagline}</div>
      </div>
      {loading ? (
        <span className="settings-version-chip settings-version-chip-muted"><Loader2 size={10} className="settings-spin" /> Checking…</span>
      ) : probe?.installed ? (
        <span className="settings-version-chip settings-version-chip-ok"><CheckCircle2 size={10} /> Found in system{version ? ` · v${version}` : ""}</span>
      ) : (
        <span className="settings-version-chip settings-version-chip-muted">Not found</span>
      )}
      <button className="btn btn-ghost settings-action-btn" onClick={(e) => { e.stopPropagation(); onRefresh(); }} disabled={loading}><RefreshCw size={11} /> Re-check</button>
    </div>
  );
}


// Collapsible changelog row — version + date as the header, markdown-rendered notes when
// expanded. The currently-installed version is marked so users can see at a glance which entry
// they're running.
function ChangelogRow({ entry, currentVersion }: { entry: ReleaseEntry; currentVersion: string }) {
  const [open, setOpen] = useState(false);
  const isCurrent = !!currentVersion && entry.version === currentVersion;
  const dateLabel = entry.publishedAt ? new Date(entry.publishedAt).toLocaleDateString() : null;
  return (
    <div className={`settings-changelog-row ${open ? "is-open" : ""}`}>
      <button className="settings-changelog-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <ChevronRight size={12} className="settings-changelog-chevron" />
        <span className="settings-changelog-version">v{entry.version}</span>
        {isCurrent && <span className="settings-version-chip settings-version-chip-ok">Installed</span>}
        {dateLabel && <span className="settings-changelog-date">{dateLabel}</span>}
      </button>
      {open && (
        <div className="settings-changelog-body md-content">
          {entry.notes.trim() ? renderMarkdown(entry.notes) : <span className="settings-version-muted">No release notes.</span>}
          {entry.url && (
            <button className="btn btn-ghost settings-changelog-link" onClick={() => invoke("open_url", { url: entry.url }).catch(() => {})}><ExternalLink size={11} /> View on GitHub</button>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`settings-toggle ${disabled ? "settings-toggle-disabled" : ""}`}>
      <input type="checkbox" checked={checked && !disabled} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="settings-toggle-slider" />
    </label>
  );
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        <div className="settings-row-desc">{description}</div>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

// Section heading inside a category page — groups related settings under a short label so
// users don't have to scan a flat list of toggles to figure out which one they want.
function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title">{title}</div>
        {description && <div className="settings-section-desc">{description}</div>}
      </div>
      <div className="settings-section-body">{children}</div>
    </div>
  );
}

export function SettingsView({ theme, onSetTheme, defaultAgent, onSetDefaultAgent, gitLazyPolling, onSetGitLazyPolling, gitPanelFilenamesOnly, onSetGitPanelFilenamesOnly, contextTreeEnabled, onSetContextTreeEnabled, terminalBgColor, onSetTerminalBgColor, defaultTerminalFontSize, onSetDefaultTerminalFontSize, alwaysOnTop, onSetAlwaysOnTop, defaultShell, onSetDefaultShell, fullscreenRendering, onSetFullscreenRendering, forceSyncOutput, onSetForceSyncOutput, webglRendering, onSetWebglRendering, terminalFontWeight, onSetTerminalFontWeight, eagerInitTabs, onSetEagerInitTabs, showRateLimitInSidebar, onSetShowRateLimitInSidebar, showSessionRowMetrics, onSetShowSessionRowMetrics, showSessionRowMetricsCodex, onSetShowSessionRowMetricsCodex, showRateLimitInSidebarCodex, onSetShowRateLimitInSidebarCodex, showTerminalHeaderStats, onSetShowTerminalHeaderStats, showProjectStatsChart, onSetShowProjectStatsChart, updateInfo }: SettingsViewProps) {
  const [active, setActive] = useState<Category>("appearance");
  const [wizardOpen, setWizardOpen] = useState(false);
  // Has the user run the wizard? Drives the disabled-state of the rate-limit + session-row
  // metrics toggles — there's no point letting users enable features that have no data
  // source. We re-probe whenever the wizard closes (in case they just installed the hook).
  const [statslineConfigured, setStatslineConfigured] = useState(false);
  // Per-agent binary detection for the Agents page. Probed when the page is opened (and on
  // demand via Re-check) rather than on every settings mount — the version probe actually
  // launches the CLI once, which costs ~a second for node-based shims.
  const [agentProbes, setAgentProbes] = useState<Record<AgentId, AgentProbeState>>({ claude: { loading: true, probe: null }, codex: { loading: true, probe: null } });
  // Both agents start collapsed — the header chips already answer the "is it installed?"
  // question on their own; expanding is for digging into an agent's settings.
  const [expandedAgents, setExpandedAgents] = useState<Record<AgentId, boolean>>({ claude: false, codex: false });
  const toggleAgent = (id: AgentId) => setExpandedAgents(prev => ({ ...prev, [id]: !prev[id] }));
  const installer = useInstaller(updateInfo.update);
  const shells = getAvailableShells();
  const { tt, Tooltip } = useTooltip();

  useEffect(() => {
    let cancelled = false;
    invoke<{ stats_dir_present: boolean; stats_session_count: number }>("probe_statusline_setup")
      .then(p => { if (!cancelled) setStatslineConfigured(p.stats_dir_present && p.stats_session_count > 0); })
      .catch(() => { if (!cancelled) setStatslineConfigured(false); });
    return () => { cancelled = true; };
  }, [wizardOpen]);

  const probeAgents = useCallback(() => {
    AGENT_IDS.forEach(id => {
      setAgentProbes(prev => ({ ...prev, [id]: { loading: true, probe: prev[id].probe } }));
      invoke<AgentProbe>("detect_agent_binary", { binary: AGENTS[id].binary })
        .then(probe => setAgentProbes(prev => ({ ...prev, [id]: { loading: false, probe } })))
        .catch(() => setAgentProbes(prev => ({ ...prev, [id]: { loading: false, probe: null } })));
    });
  }, []);

  const onAgentsPage = active === "agents";
  useEffect(() => { if (onAgentsPage) probeAgents(); }, [onAgentsPage, probeAgents]);

  return (
    <div className="settings-view fade-in">
      <div className="settings-view-header">
        <h1 className="settings-view-title">Settings</h1>
        <p className="settings-view-subtitle">Configure appearance, coding agents, terminal behavior, and how the window behaves.</p>
      </div>
      <div className="settings-view-layout">
        <div className="settings-nav">
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <div key={id} className={`settings-nav-item ${active === id ? "active" : ""}`} onClick={() => setActive(id)}>
              <Icon size={13} />
              <span>{label}</span>
              {/* Tells the user where the +1 on the Settings cog is coming from. */}
              {id === "about" && updateInfo.updateAvailable && <span className="settings-nav-dot" title="Update available" />}
              {/* Nudge new users toward the Claude Code hookup — drops once they've connected. */}
              {id === "agents" && !statslineConfigured && <span className="settings-nav-dot settings-nav-dot-recommended" title="Recommended setup" />}
            </div>
          ))}
        </div>

        <div className="settings-body">
          {active === "appearance" && (
            <>
              <Section title="Theme" description="Color palette for the app shell. Terminals keep their own background setting.">
                <SettingRow title="Color theme" description="Dark uses the warm near-black canvas; Light uses a warm parchment palette.">
                  <select className="settings-select" value={theme} onChange={(e) => onSetTheme(e.target.value as ThemeMode)}>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </SettingRow>
              </Section>

              <Section title="Side panels" description="What's visible on either side of the project / session view.">
                <SettingRow title="Context tree" description="Show the context panel on the right side of a project's detail view — skills, plugins, MCPs, instructions, and memories from the agents used in that project.">
                  <Toggle checked={contextTreeEnabled} onChange={onSetContextTreeEnabled} />
                </SettingRow>
              </Section>
            </>
          )}

          {active === "agents" && (
            <>
              {(() => {
                // Default-agent choice only means something with 2+ agents installed; with
                // one, the select is pinned to it and disabled. Probe state drives this.
                const claudeInstalled = !!agentProbes.claude.probe?.installed;
                const codexInstalled = !!agentProbes.codex.probe?.installed;
                const multi = claudeInstalled && codexInstalled;
                const single = claudeInstalled ? "claude" : codexInstalled ? "codex" : "claude";
                return (
                  <Section title="Defaults" description="Which agent hosts a new chat (the + button and the tab dropdown).">
                    <SettingRow title="Default agent" description={multi ? "Pick an agent to start new chats without being asked — or keep “Ask every time” to choose per chat." : "Only one agent was found on this machine, so it's always used. This choice unlocks when a second agent is detected."}>
                      <select className="settings-select" value={multi ? defaultAgent : single} disabled={!multi} onChange={(e) => onSetDefaultAgent(e.target.value as "ask" | AgentId)}>
                        {multi ? (
                          <>
                            <option value="ask">Ask every time</option>
                            {AGENT_IDS.map(id => <option key={id} value={id}>{AGENTS[id].label}</option>)}
                          </>
                        ) : (
                          <option value={single}>{AGENTS[single as AgentId].label}</option>
                        )}
                      </select>
                    </SettingRow>
                  </Section>
                );
              })()}

              <div className="settings-agent-block">
              <AgentHeader icon={<AgentIcon agent="claude" size={18} />} name={AGENTS.claude.label} tagline={AGENTS.claude.tagline} state={agentProbes.claude} onRefresh={probeAgents} open={expandedAgents.claude} onToggle={() => toggleAgent("claude")} tt={tt} />
              {expandedAgents.claude && <div className="settings-agent-body">
              <div className="settings-connect-hero">
                <div className="settings-connect-hero-icon"><Sparkles size={18} /></div>
                <div className="settings-connect-hero-text">
                  <div className="settings-connect-hero-title">{statslineConfigured ? "You're connected" : "Recommended setup"}</div>
                  <div className="settings-connect-hero-sub">{statslineConfigured ? "xshell is reading live cost, context, and rate-limit data from Claude Code. The toggles below control which surfaces use it." : "Connect xshell to Claude Code in one click for live cost, context, and rate-limit tracking — powers the header strip, sidebar chip, and per-session metrics."}</div>
                </div>
                {!statslineConfigured && (
                  <button className="btn btn-primary settings-connect-cta" onClick={() => setWizardOpen(true)}><Sparkles size={12} /> Connect</button>
                )}
              </div>

              <Section title="Session metrics" description="Live cost, context, and rate-limit data sourced from Claude Code. The toggles below depend on the connection — without it they have no data and stay hidden regardless of state.">
                <SettingRow title="Connect to Claude Code" description="One-time setup that lets xshell read live cost, context, and rate-limit data straight from Claude Code (cost stays monotonic across resumes, daily breakdown is captured for the trendline). The wizard handles it in a click — no restart needed.">
                  <button className="btn btn-primary settings-action-btn" onClick={() => setWizardOpen(true)}><Sparkles size={11} /> {statslineConfigured ? "Reconfigure…" : "Configure…"}</button>
                </SettingRow>
                <SettingRow title="Rate limit in sidebar" description={statslineConfigured ? "Show the small percentage chip above the Settings cog. Hover for a popover with 5h / 7d usage breakdown and reset times." : "Connect to Claude Code above to enable this — the chip needs live rate-limit data."}>
                  <Toggle checked={showRateLimitInSidebar} onChange={onSetShowRateLimitInSidebar} disabled={!statslineConfigured} />
                </SettingRow>
                <SettingRow title="Detailed info on session rows" description={statslineConfigured ? "Show context bar and cost figure on each session row. Model and message count always show — those are reliable from the JSONL alone." : "Connect to Claude Code above to enable this — the context bar and cost figure both come from the live data feed."}>
                  <Toggle checked={showSessionRowMetrics} onChange={onSetShowSessionRowMetrics} disabled={!statslineConfigured} />
                </SettingRow>
                <SettingRow title="Cost & context in terminal header" description={statslineConfigured ? "Replace the project path above each Claude terminal with a live progress bar of context usage and total session cost. Falls back to the path automatically for sessions that don't yet have stats data." : "Connect to Claude Code above to enable this — without the hook there's no live cost or context to render."}>
                  <Toggle checked={showTerminalHeaderStats} onChange={onSetShowTerminalHeaderStats} disabled={!statslineConfigured} />
                </SettingRow>
                <SettingRow title="Cost chart on project page" description={statslineConfigured ? "Include the daily-cost view in the project stats panel. The Tokens view is always available — this only controls Cost. Hides automatically for projects with no recorded cost." : "Connect to Claude Code above to enable this — cost data comes from the live data feed. The Tokens view stays available regardless."}>
                  <Toggle checked={showProjectStatsChart} onChange={onSetShowProjectStatsChart} disabled={!statslineConfigured} />
                </SettingRow>
              </Section>

              <Section title="Terminal rendering" description="Tweaks applied to every Claude session launched from xshell. Both toggles below are highly recommended to keep ON — they fix rendering issues that are specific to running Claude Code inside an xterm.js host.">
                <SettingRow title="Full screen rendering" description="Switch Claude Code into the alternate-screen-buffer renderer (no scrollback, no flicker on every refresh). Sets CLAUDE_CODE_NO_FLICKER=1 on each new claude session — open sessions keep their current mode until next launch. Introduced in Claude Code 2.1.89 (April 1, 2026).">
                  <Toggle checked={fullscreenRendering} onChange={onSetFullscreenRendering} />
                </SettingRow>
                <SettingRow title="Force synchronized output" description="Tells Claude Code to wrap each TUI frame in DEC 2026 synchronized-output markers, so xterm.js renders only complete frames — fixes the 'flying letters' residue from half-drawn redraws. Sets CLAUDE_CODE_FORCE_SYNC_OUTPUT=1 on each new claude session. Introduced in Claude Code 2.1.129 (May 6, 2026).">
                  <Toggle checked={forceSyncOutput} onChange={onSetForceSyncOutput} />
                </SettingRow>
              </Section>
              </div>}
              </div>

              <div className="settings-agent-block">
              <AgentHeader icon={<AgentIcon agent="codex" size={18} />} name={AGENTS.codex.label} tagline={AGENTS.codex.tagline} state={agentProbes.codex} onRefresh={probeAgents} open={expandedAgents.codex} onToggle={() => toggleAgent("codex")} tt={tt} />
              {expandedAgents.codex && <div className="settings-agent-body">
              <div className="settings-agent-empty">Codex is integrated: its sessions appear in your project and home lists (click to resume), token usage feeds the project stats, and AGENTS.md, prompts, and MCP servers show in the context tree. No setup needed — everything is read straight from <code>~/.codex</code>.</div>
              <Section title="Session metrics" description="Codex reports usage in its session files directly — no hook or setup required, so these work out of the box.">
                <SettingRow title="Detailed info on session rows" description="Show the context bar on each Codex session row. Model and message count always show — those are reliable from the session file alone.">
                  <Toggle checked={showSessionRowMetricsCodex} onChange={onSetShowSessionRowMetricsCodex} />
                </SettingRow>
                <SettingRow title="Rate limit in sidebar" description="Show Codex's usage in the percentage chip above the Settings cog. Hover for the 5h / 7d breakdown and reset times. Codex only refreshes these while it's running, so the popover notes how recent they are.">
                  <Toggle checked={showRateLimitInSidebarCodex} onChange={onSetShowRateLimitInSidebarCodex} />
                </SettingRow>
              </Section>
              </div>}
              </div>
            </>
          )}

          {active === "terminal" && (
            <>
              <Section title="Appearance" description="How terminal tabs look.">
                <SettingRow title="Background color" description="Override the terminal background. Reset returns it to the current app theme's default — terminals without a custom color follow the app theme automatically.">
                  <div className="settings-color-row">
                    <input type="color" className="settings-color-input" value={terminalBgColor} onChange={(e) => onSetTerminalBgColor(e.target.value)} />
                    <span className="settings-color-hex">{terminalBgColor}</span>
                    {terminalBgColor.toLowerCase() !== DARK_TERM_BG && terminalBgColor.toLowerCase() !== LIGHT_TERM_BG && (
                      <button className="settings-reset-btn" onClick={() => onSetTerminalBgColor(theme === "light" ? LIGHT_TERM_BG : DARK_TERM_BG)} {...ttProps(tt, "Reset to theme default")}><RotateCcw size={11} /> Reset</button>
                    )}
                  </div>
                </SettingRow>
                <SettingRow title="Default zoom" description="Starting font size for new terminal tabs. Ctrl+= / Ctrl+− per tab overrides this; Ctrl+0 resets the active tab to this default.">
                  <div className="settings-zoom-col">
                    <div className="settings-zoom-row">
                      <input type="range" className="settings-range" min={8} max={32} step={1} value={defaultTerminalFontSize} onChange={(e) => onSetDefaultTerminalFontSize(parseInt(e.target.value, 10))} />
                      <span className="settings-zoom-value">{defaultTerminalFontSize}px</span>
                    </div>
                    {defaultTerminalFontSize !== 14 && (
                      <button className="settings-reset-btn settings-reset-btn-block" onClick={() => onSetDefaultTerminalFontSize(14)} {...ttProps(tt, "Reset to default")}><RotateCcw size={11} /> Reset</button>
                    )}
                  </div>
                </SettingRow>
                <SettingRow title="GPU-accelerated rendering" description="Render terminal cells via WebGL. Fixes the subpixel seam between half-block characters (visible on the Claude Code banner). Falls back to the DOM renderer if WebGL is unavailable.">
                  <Toggle checked={webglRendering} onChange={onSetWebglRendering} />
                </SettingRow>
                <SettingRow title="Font weight" description="CSS weight applied to terminal text. Bold scales up automatically.">
                  <div className="settings-zoom-col">
                    <div className="settings-zoom-row">
                      <input type="range" className="settings-range" min={100} max={700} step={100} value={terminalFontWeight} onChange={(e) => onSetTerminalFontWeight(parseInt(e.target.value, 10))} />
                      <span className="settings-zoom-value">{terminalFontWeight}</span>
                    </div>
                    {terminalFontWeight !== 400 && (
                      <button className="settings-reset-btn settings-reset-btn-block" onClick={() => onSetTerminalFontWeight(400)} {...ttProps(tt, "Reset to default")}><RotateCcw size={11} /> Reset</button>
                    )}
                  </div>
                </SettingRow>
              </Section>

              <Section title="Shell" description="Which shell hosts your terminal and agent sessions.">
                <SettingRow title="Default shell" description="Shell used when opening a raw terminal tab via the dropdown, and the host shell for agent sessions (Claude Code, Codex).">
                  <div className="settings-shell-row">
                    <ShellIcon id={defaultShell} size={18} />
                    <select className="settings-select" value={defaultShell} onChange={(e) => onSetDefaultShell(e.target.value)}>
                      {shells.map(sh => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                    </select>
                  </div>
                </SettingRow>
              </Section>

              <Section title="Startup" description="What happens to your saved tabs when xshell launches.">
                <SettingRow title="Pre-initialize tabs on launch" description="Spawn each restored tab's session immediately at app start, instead of deferring until you click into the tab. Agents take a few seconds to boot, so eager init means the session is ready (or close to it) by the time you switch to it. Open a tab whose session is still booting and the starting spinner shows until the first frame renders.">
                  <Toggle checked={eagerInitTabs} onChange={onSetEagerInitTabs} />
                </SettingRow>
              </Section>

              <Section title="Terminal sidebar" description="Right-side activity bar inside agent terminal tabs.">
                <SettingRow title="Only poll git when panel is open" description="When on (default), git status is fetched once when the session starts, then again only while the git panel is open. Turn off to keep polling every few seconds even when the panel is closed.">
                  <Toggle checked={gitLazyPolling} onChange={onSetGitLazyPolling} />
                </SettingRow>
                <SettingRow title="Filenames only" description="In the git panel, show just the file name (basename) instead of the full relative path. Hover a row to see the full path.">
                  <Toggle checked={gitPanelFilenamesOnly} onChange={onSetGitPanelFilenamesOnly} />
                </SettingRow>
              </Section>
            </>
          )}

          {active === "behavior" && (
            <>
              <Section title="Window" description="How the xshell window itself behaves.">
                <SettingRow title="Always on top" description="Keep the xshell window above all other applications, even when they have focus.">
                  <Toggle checked={alwaysOnTop} onChange={onSetAlwaysOnTop} />
                </SettingRow>
              </Section>
            </>
          )}

          {active === "about" && (
            <>
            <Section title="Version" description="xshell ships via GitHub Releases. The check below queries GitHub for the latest tagged release.">
              <SettingRow title="Installed version" description="The version of xshell currently running. Comes from the bundled tauri.conf.json — restart the app after updating.">
                <span className="settings-version-current">{updateInfo.currentVersion || "—"}</span>
              </SettingRow>
              <SettingRow title="Latest release" description={updateInfo.error ? `Couldn't reach GitHub: ${updateInfo.error}` : updateInfo.loading ? "Checking GitHub Releases…" : updateInfo.publishedAt ? `Published ${new Date(updateInfo.publishedAt).toLocaleDateString()}` : "Latest tagged release on GitHub."}>
                <div className="settings-version-row">
                  {updateInfo.loading ? (
                    <span className="settings-version-muted">Checking…</span>
                  ) : updateInfo.latestVersion ? (
                    <>
                      <span className="settings-version-current">{updateInfo.latestVersion}</span>
                      {updateInfo.updateAvailable ? (
                        <span className="settings-version-chip settings-version-chip-new">New</span>
                      ) : (
                        <span className="settings-version-chip settings-version-chip-ok"><CheckCircle2 size={10} /> Up to date</span>
                      )}
                    </>
                  ) : (
                    <span className="settings-version-muted">Unavailable</span>
                  )}
                  <button className="btn btn-ghost settings-action-btn" onClick={updateInfo.refresh} disabled={updateInfo.loading} {...ttProps(tt, "Re-check GitHub Releases")}><RefreshCw size={11} /> Refresh</button>
                </div>
              </SettingRow>
              {updateInfo.updateAvailable && (
                <SettingRow title="Update" description="Download and install the new version in place. xshell restarts automatically when the install finishes.">
                  <div className="settings-update-col">
                    <div className="settings-version-row">
                      <button className="btn btn-primary settings-action-btn" onClick={installer.run} disabled={installer.state !== "idle" || !updateInfo.update}>
                        {installer.state === "downloading" ? <><Loader2 size={11} className="settings-spin" /> Downloading{installer.progress != null ? ` ${Math.round(installer.progress * 100)}%` : "…"}</> :
                         installer.state === "installing"  ? <><Loader2 size={11} className="settings-spin" /> Installing…</> :
                         installer.state === "restarting"  ? <><Loader2 size={11} className="settings-spin" /> Restarting…</> :
                                                             <><Download size={11} /> Install update</>}
                      </button>
                      {updateInfo.releaseUrl && (
                        <button className="btn btn-ghost settings-action-btn" onClick={() => invoke("open_url", { url: updateInfo.releaseUrl! }).catch(() => {})}><ExternalLink size={11} /> View release</button>
                      )}
                    </div>
                    {installer.progress != null && installer.state !== "idle" && !installer.error && (
                      <div className="upd-progress"><div className="upd-progress-bar" style={{ width: `${Math.round(installer.progress * 100)}%` }} /></div>
                    )}
                    {installer.error && (
                      <div className="settings-install-error">
                        <AlertTriangle size={12} />
                        <span>{installer.error}</span>
                        {updateInfo.releaseUrl && (
                          <button className="btn btn-ghost settings-action-btn" onClick={() => invoke("open_url", { url: updateInfo.releaseUrl! }).catch(() => {})}><ExternalLink size={11} /> Open releases</button>
                        )}
                      </div>
                    )}
                  </div>
                </SettingRow>
              )}
            </Section>

            {updateInfo.releases.length > 0 && (
              <Section title="Changelog" description="Recent xshell releases pulled from GitHub. Click a version to expand its release notes.">
                <div className="settings-changelog">
                  {updateInfo.releases.map(r => (
                    <ChangelogRow key={r.version} entry={r} currentVersion={updateInfo.currentVersion} />
                  ))}
                </div>
              </Section>
            )}
            </>
          )}
        </div>
      </div>
      {Tooltip}
      {wizardOpen && <DetailedSessionInfoWizard onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
