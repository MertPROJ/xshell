import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Paintbrush, Terminal as TerminalIcon, Settings as SettingsIcon, RotateCcw, Sparkles, Info, ExternalLink, RefreshCw, CheckCircle2, ChevronRight, Download, AlertTriangle, Loader2 } from "lucide-react";
import { getAvailableShells } from "../shells";
import { ShellIcon } from "./ShellIcon";
import { useTooltip, ttProps } from "./Tooltip";
import { DetailedSessionInfoWizard } from "./DetailedSessionInfoWizard";
import { DARK_TERM_BG, LIGHT_TERM_BG } from "./TerminalTab";
import type { UpdateInfo, ReleaseEntry } from "../hooks/useUpdateCheck";
import { useInstaller } from "../hooks/useInstaller";
import { renderMarkdown } from "../markdown";
import { detectInstallCommand } from "../installCommand";
import { CodeCopy } from "./CodeCopy";

export type ThemeMode = "dark" | "light";

interface SettingsViewProps {
  theme: ThemeMode;
  onSetTheme: (theme: ThemeMode) => void;
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
  eagerInitTabs: boolean;
  onSetEagerInitTabs: (enabled: boolean) => void;
  showRateLimitInSidebar: boolean;
  onSetShowRateLimitInSidebar: (enabled: boolean) => void;
  showSessionRowMetrics: boolean;
  onSetShowSessionRowMetrics: (enabled: boolean) => void;
  showTerminalHeaderStats: boolean;
  onSetShowTerminalHeaderStats: (enabled: boolean) => void;
  showProjectStatsChart: boolean;
  onSetShowProjectStatsChart: (enabled: boolean) => void;
  updateInfo: UpdateInfo;
}

type Category = "appearance" | "connect" | "terminal" | "behavior" | "about";

const CATEGORIES: { id: Category; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "appearance", label: "Appearance", icon: Paintbrush },
  { id: "connect",    label: "Connect",    icon: Sparkles },
  { id: "terminal",   label: "Terminal",   icon: TerminalIcon },
  { id: "behavior",   label: "Behavior",   icon: SettingsIcon },
  { id: "about",      label: "About",      icon: Info },
];


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

export function SettingsView({ theme, onSetTheme, gitLazyPolling, onSetGitLazyPolling, gitPanelFilenamesOnly, onSetGitPanelFilenamesOnly, contextTreeEnabled, onSetContextTreeEnabled, terminalBgColor, onSetTerminalBgColor, defaultTerminalFontSize, onSetDefaultTerminalFontSize, alwaysOnTop, onSetAlwaysOnTop, defaultShell, onSetDefaultShell, fullscreenRendering, onSetFullscreenRendering, forceSyncOutput, onSetForceSyncOutput, eagerInitTabs, onSetEagerInitTabs, showRateLimitInSidebar, onSetShowRateLimitInSidebar, showSessionRowMetrics, onSetShowSessionRowMetrics, showTerminalHeaderStats, onSetShowTerminalHeaderStats, showProjectStatsChart, onSetShowProjectStatsChart, updateInfo }: SettingsViewProps) {
  const [active, setActive] = useState<Category>("appearance");
  const [wizardOpen, setWizardOpen] = useState(false);
  // Has the user run the wizard? Drives the disabled-state of the rate-limit + session-row
  // metrics toggles — there's no point letting users enable features that have no data
  // source. We re-probe whenever the wizard closes (in case they just installed the hook).
  const [statslineConfigured, setStatslineConfigured] = useState(false);
  const installer = useInstaller();
  const shells = getAvailableShells();
  const { tt, Tooltip } = useTooltip();

  useEffect(() => {
    let cancelled = false;
    invoke<{ stats_dir_present: boolean; stats_session_count: number }>("probe_statusline_setup")
      .then(p => { if (!cancelled) setStatslineConfigured(p.stats_dir_present && p.stats_session_count > 0); })
      .catch(() => { if (!cancelled) setStatslineConfigured(false); });
    return () => { cancelled = true; };
  }, [wizardOpen]);

  return (
    <div className="settings-view fade-in">
      <div className="settings-view-header">
        <h1 className="settings-view-title">Settings</h1>
        <p className="settings-view-subtitle">Configure appearance, connect to Claude Code, terminal behavior, and how the window behaves.</p>
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
              {id === "connect" && !statslineConfigured && <span className="settings-nav-dot settings-nav-dot-recommended" title="Recommended setup" />}
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
                <SettingRow title="Context tree" description="Show the Skills, Plugins, MCPs, and Memories panel on the right side of a project's detail view.">
                  <Toggle checked={contextTreeEnabled} onChange={onSetContextTreeEnabled} />
                </SettingRow>
              </Section>
            </>
          )}

          {active === "connect" && (
            <>
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
                <SettingRow title="Stats chart on project page" description={statslineConfigured ? "Show the daily-cost area chart and totals tile above the session list when a project is selected. Hides automatically for projects with no recorded cost." : "Connect to Claude Code above to enable this — the chart series comes from the live data feed."}>
                  <Toggle checked={showProjectStatsChart} onChange={onSetShowProjectStatsChart} disabled={!statslineConfigured} />
                </SettingRow>
              </Section>
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
                    {defaultTerminalFontSize !== 12 && (
                      <button className="settings-reset-btn settings-reset-btn-block" onClick={() => onSetDefaultTerminalFontSize(12)} {...ttProps(tt, "Reset to default")}><RotateCcw size={11} /> Reset</button>
                    )}
                  </div>
                </SettingRow>
              </Section>

              <Section title="Shell" description="Which shell hosts your terminal and Claude sessions.">
                <SettingRow title="Default shell" description="Shell used when opening a raw terminal tab via the dropdown, and the host shell for Claude sessions.">
                  <div className="settings-shell-row">
                    <ShellIcon id={defaultShell} size={18} />
                    <select className="settings-select" value={defaultShell} onChange={(e) => onSetDefaultShell(e.target.value)}>
                      {shells.map(sh => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                    </select>
                  </div>
                </SettingRow>
              </Section>

              <Section title="Claude Code" description="Tweaks applied to every Claude session launched from xshell. Both toggles below are highly recommended to keep ON — they fix rendering issues that are specific to running Claude Code inside an xterm.js host.">
                <SettingRow title="Full screen rendering" description="Switch Claude Code into the alternate-screen-buffer renderer (no scrollback, no flicker on every refresh). Sets CLAUDE_CODE_NO_FLICKER=1 on each new claude session — open sessions keep their current mode until next launch. Introduced in Claude Code 2.1.89 (April 1, 2026).">
                  <Toggle checked={fullscreenRendering} onChange={onSetFullscreenRendering} />
                </SettingRow>
                <SettingRow title="Force synchronized output" description="Tells Claude Code to wrap each TUI frame in DEC 2026 synchronized-output markers, so xterm.js renders only complete frames — fixes the 'flying letters' residue from half-drawn redraws. Sets CLAUDE_CODE_FORCE_SYNC_OUTPUT=1 on each new claude session. Introduced in Claude Code 2.1.129 (May 6, 2026).">
                  <Toggle checked={forceSyncOutput} onChange={onSetForceSyncOutput} />
                </SettingRow>
              </Section>

              <Section title="Startup" description="What happens to your saved tabs when xshell launches.">
                <SettingRow title="Pre-initialize tabs on launch" description="Spawn each restored tab's session immediately at app start, instead of deferring until you click into the tab. Claude takes a few seconds to boot, so eager init means the session is ready (or close to it) by the time you switch to it. Open a tab whose session is still booting and the 'Starting Claude…' spinner shows until the first frame renders.">
                  <Toggle checked={eagerInitTabs} onChange={onSetEagerInitTabs} />
                </SettingRow>
              </Section>

              <Section title="Terminal sidebar" description="Right-side activity bar inside Claude terminal tabs.">
                <SettingRow title="Only poll git when panel is open" description="When on (default), git status is fetched once when the Claude session starts, then again only while the git panel is open. Turn off to keep polling every few seconds even when the panel is closed.">
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
                <SettingRow title="Update" description="Click Install to run the script automatically, copy the one-liner, or grab the binary from the release page.">
                  <div className="settings-update-col">
                    <div className="settings-version-row">
                      <button className="btn btn-primary settings-action-btn" onClick={installer.run} disabled={installer.state !== "idle"}>
                        {installer.state === "checking" ? <><Loader2 size={11} className="settings-spin" /> Pinging xshell.sh…</> :
                         installer.state === "running"  ? <><Loader2 size={11} className="settings-spin" /> Installer launched</> :
                                                          <><Download size={11} /> Install update</>}
                      </button>
                      <CodeCopy text={detectInstallCommand().command} />
                      {updateInfo.releaseUrl && (
                        <button className="btn btn-ghost settings-action-btn" onClick={() => invoke("open_url", { url: updateInfo.releaseUrl! }).catch(() => {})}><ExternalLink size={11} /> View release</button>
                      )}
                    </div>
                    {installer.error && (
                      <div className="settings-install-error">
                        <AlertTriangle size={12} />
                        <span>{installer.error}</span>
                        {updateInfo.releaseUrl && (
                          <button className="btn btn-ghost settings-action-btn" onClick={() => invoke("open_url", { url: updateInfo.releaseUrl! }).catch(() => {})}><ExternalLink size={11} /> Open releases</button>
                        )}
                      </div>
                    )}
                    {installer.state === "running" && !installer.error && (
                      <div className="settings-install-hint">A new console window is running the installer — once it finishes, restart xshell to pick up the new version.</div>
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
