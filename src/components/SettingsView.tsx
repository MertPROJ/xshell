import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Paintbrush, Terminal as TerminalIcon, Settings as SettingsIcon, RotateCcw, Sparkles } from "lucide-react";
import { getAvailableShells } from "../shells";
import { ShellIcon } from "./ShellIcon";
import { useTooltip, ttProps } from "./Tooltip";
import { DetailedSessionInfoWizard } from "./DetailedSessionInfoWizard";
import { DARK_TERM_BG, LIGHT_TERM_BG } from "./TerminalTab";

export type ThemeMode = "dark" | "light";

interface SettingsViewProps {
  theme: ThemeMode;
  onSetTheme: (theme: ThemeMode) => void;
  gitPanelEnabled: boolean;
  onSetGitPanelEnabled: (enabled: boolean) => void;
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
  showRateLimitInSidebar: boolean;
  onSetShowRateLimitInSidebar: (enabled: boolean) => void;
  showSessionRowMetrics: boolean;
  onSetShowSessionRowMetrics: (enabled: boolean) => void;
}

type Category = "appearance" | "terminal" | "behavior";

const CATEGORIES: { id: Category; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "appearance", label: "Appearance", icon: Paintbrush },
  { id: "terminal",   label: "Terminal",   icon: TerminalIcon },
  { id: "behavior",   label: "Behavior",   icon: SettingsIcon },
];


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

export function SettingsView({ theme, onSetTheme, gitPanelEnabled, onSetGitPanelEnabled, gitPanelFilenamesOnly, onSetGitPanelFilenamesOnly, contextTreeEnabled, onSetContextTreeEnabled, terminalBgColor, onSetTerminalBgColor, defaultTerminalFontSize, onSetDefaultTerminalFontSize, alwaysOnTop, onSetAlwaysOnTop, defaultShell, onSetDefaultShell, showRateLimitInSidebar, onSetShowRateLimitInSidebar, showSessionRowMetrics, onSetShowSessionRowMetrics }: SettingsViewProps) {
  const [active, setActive] = useState<Category>("appearance");
  const [wizardOpen, setWizardOpen] = useState(false);
  // Has the user run the wizard? Drives the disabled-state of the rate-limit + session-row
  // metrics toggles — there's no point letting users enable features that have no data
  // source. We re-probe whenever the wizard closes (in case they just installed the hook).
  const [statslineConfigured, setStatslineConfigured] = useState(false);
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
        <p className="settings-view-subtitle">Configure appearance, terminal behavior, and how the window behaves.</p>
      </div>
      <div className="settings-view-layout">
        <div className="settings-nav">
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <div key={id} className={`settings-nav-item ${active === id ? "active" : ""}`} onClick={() => setActive(id)}>
              <Icon size={13} />
              <span>{label}</span>
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

              <Section title="Session metrics" description="Live cost, context, and rate-limit data sourced from Claude Code. Both toggles below depend on the connection set up here — without it they have no data and stay hidden regardless of the toggle state.">
                <SettingRow title="Connect to Claude Code" description="One-time setup that lets xshell read live cost, context, and rate-limit data straight from Claude Code (cost stays monotonic across resumes, daily breakdown is captured for the trendline). The wizard handles it in a click — no restart needed.">
                  <button className="btn btn-ghost settings-action-btn" onClick={() => setWizardOpen(true)}><Sparkles size={11} /> Configure…</button>
                </SettingRow>
                <SettingRow title="Rate limit in sidebar" description={statslineConfigured ? "Show the small percentage chip above the Settings cog. Hover for a popover with 5h / 7d usage breakdown and reset times." : "Connect to Claude Code above to enable this — the chip needs live rate-limit data."}>
                  <Toggle checked={showRateLimitInSidebar} onChange={onSetShowRateLimitInSidebar} disabled={!statslineConfigured} />
                </SettingRow>
                <SettingRow title="Detailed info on session rows" description={statslineConfigured ? "Show context bar and cost figure on each session row. Model and message count always show — those are reliable from the JSONL alone." : "Connect to Claude Code above to enable this — the context bar and cost figure both come from the live data feed."}>
                  <Toggle checked={showSessionRowMetrics} onChange={onSetShowSessionRowMetrics} disabled={!statslineConfigured} />
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

              <Section title="Git panel" description="Inline git status shown alongside Claude terminal tabs.">
                <SettingRow title="Show git panel" description="Show the branch indicator and side panel inside Claude terminal tabs. Turning this off also stops the background git status polling.">
                  <Toggle checked={gitPanelEnabled} onChange={onSetGitPanelEnabled} />
                </SettingRow>
                <SettingRow title="Filenames only" description="Show just the file name (basename) instead of the full relative path. Hover a row to see the full path.">
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
        </div>
      </div>
      {Tooltip}
      {wizardOpen && <DetailedSessionInfoWizard onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
