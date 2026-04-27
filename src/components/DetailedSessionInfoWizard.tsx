import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Check, AlertCircle, Copy, RefreshCw, FolderOpen, FileText, Info } from "lucide-react";
import { useTooltip, ttProps } from "./Tooltip";

// Shape returned by the Rust `probe_statusline_setup` command. Drives the wizard's UI state.
interface StatuslineProbe {
  has_statusline: boolean;
  existing_command: string | null;
  stats_dir_present: boolean;
  stats_session_count: number;
  last_update_iso: string | null;
  home_dir: string;
  stats_dir_path: string;
}

// Snippet for a user who already has a statusline. Pastes inside their script, uses the
// local `data` variable that every statusline holds after JSON.parse(input). Two things on
// top of the raw Claude Code JSON:
//   1. cost.total_cost_usd is kept monotonic — Claude Code reports per-launch cost, so we
//      read the existing file and never let the saved total decrease across resumes.
//   2. xshell_daily_cost is a {YYYY-MM-DD → usd} map — every tick the delta since the last
//      observed total is added to today's bucket. xshell_last_total holds the cursor.
function snippetForExistingStatusline(): string {
  return `// xshell: dump session stats for the dashboard (monotonic + daily breakdown)
try {
  const _xs_fs = require('fs'), _xs_path = require('path');
  const _xs_dir = _xs_path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'xshell-stats');
  _xs_fs.mkdirSync(_xs_dir, { recursive: true });
  const _xs_file = _xs_path.join(_xs_dir, \`\${data.session_id}.json\`);
  let _xs_daily = {}, _xs_last = 0;
  try {
    const _xs_prev = JSON.parse(_xs_fs.readFileSync(_xs_file, 'utf8'));
    const _xs_p = _xs_prev && _xs_prev.cost && _xs_prev.cost.total_cost_usd;
    if (typeof _xs_p === 'number' && data.cost && _xs_p > (data.cost.total_cost_usd || 0)) {
      data.cost.total_cost_usd = _xs_p;
    }
    if (_xs_prev && _xs_prev.xshell_daily_cost) _xs_daily = _xs_prev.xshell_daily_cost;
    if (_xs_prev && typeof _xs_prev.xshell_last_total === 'number') _xs_last = _xs_prev.xshell_last_total;
  } catch (_) {}
  const _xs_now = (data.cost && data.cost.total_cost_usd) || 0;
  const _xs_delta = Math.max(0, _xs_now - _xs_last);
  if (_xs_delta > 0) {
    const _xs_today = new Date().toISOString().slice(0, 10);
    _xs_daily[_xs_today] = (_xs_daily[_xs_today] || 0) + _xs_delta;
  }
  data.xshell_daily_cost = _xs_daily;
  data.xshell_last_total = _xs_now;
  _xs_fs.writeFileSync(_xs_file, JSON.stringify(data));
} catch (_) {}`;
}

// Standalone script for users without an existing statusline. Reads stdin, dumps JSON,
// echoes an empty line so Claude Code is satisfied with the statusline output. Two extras
// on top of the raw Claude Code JSON: cost.total_cost_usd is kept monotonic across resumes,
// and xshell_daily_cost accumulates the per-day delta keyed by YYYY-MM-DD.
function snippetForNewScript(): string {
  return `#!/usr/bin/env node
// xshell session-stats hook. Receives the per-session JSON from Claude Code on stdin and
// writes it to ~/.claude/xshell-stats/<session_id>.json so the xshell dashboard can read
// authoritative cost / context / rate-limit numbers for each session. We keep
// cost.total_cost_usd monotonic (Claude Code reports per-launch, we want lifetime) and
// also accumulate xshell_daily_cost: a { YYYY-MM-DD: usd } map of how much was spent each
// day, computed from the delta since the previous tick.
const fs = require('fs'), path = require('path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const dir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'xshell-stats');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, \`\${data.session_id}.json\`);
    let daily = {}, lastTotal = 0;
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      const p = prev && prev.cost && prev.cost.total_cost_usd;
      if (typeof p === 'number' && data.cost && p > (data.cost.total_cost_usd || 0)) {
        data.cost.total_cost_usd = p;
      }
      if (prev && prev.xshell_daily_cost) daily = prev.xshell_daily_cost;
      if (prev && typeof prev.xshell_last_total === 'number') lastTotal = prev.xshell_last_total;
    } catch (_) {}
    const now = (data.cost && data.cost.total_cost_usd) || 0;
    const delta = Math.max(0, now - lastTotal);
    if (delta > 0) {
      const today = new Date().toISOString().slice(0, 10);
      daily[today] = (daily[today] || 0) + delta;
    }
    data.xshell_daily_cost = daily;
    data.xshell_last_total = now;
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (_) {}
  process.stdout.write('');
});`;
}

function snippetForSettingsJson(homeDir: string): string {
  // settings.json wants a forward-slash path even on Windows for portability.
  const scriptPath = `${homeDir.replace(/\\/g, "/")}/.claude/xshell-stats.js`;
  return `"statusLine": {
  "type": "command",
  "command": "node \\"${scriptPath}\\""
}`;
}

// Prompt the user can paste into a Claude Code session to have Claude do the setup
// for them — handles both "existing statusline → merge snippet" and "no statusline →
// install fresh script + patch settings.json". Self-contained (no external links).
function claudePromptForSetup(): string {
  return `Please set up the xshell session-stats integration on my system. xshell is a desktop dashboard for Claude Code sessions; it reads authoritative cost/context/rate-limit data from a JSON file my statusline hook will write.

What I need:
1. Check whether ~/.claude/settings.json already has a "statusLine" entry.
2. If it does: open the script that statusLine.command points to and replace any existing xshell block (or add a new one) INSIDE its main try block — \`data\` must be in scope. The snippet (a) keeps cost.total_cost_usd monotonic across resumes and (b) accumulates xshell_daily_cost as a {YYYY-MM-DD: usd} map by adding the delta since the previous tick:

\`\`\`js
// xshell: dump session stats for the dashboard (monotonic + daily breakdown)
try {
  const _xs_fs = require('fs'), _xs_path = require('path');
  const _xs_dir = _xs_path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'xshell-stats');
  _xs_fs.mkdirSync(_xs_dir, { recursive: true });
  const _xs_file = _xs_path.join(_xs_dir, \`\${data.session_id}.json\`);
  let _xs_daily = {}, _xs_last = 0;
  try {
    const _xs_prev = JSON.parse(_xs_fs.readFileSync(_xs_file, 'utf8'));
    const _xs_p = _xs_prev && _xs_prev.cost && _xs_prev.cost.total_cost_usd;
    if (typeof _xs_p === 'number' && data.cost && _xs_p > (data.cost.total_cost_usd || 0)) {
      data.cost.total_cost_usd = _xs_p;
    }
    if (_xs_prev && _xs_prev.xshell_daily_cost) _xs_daily = _xs_prev.xshell_daily_cost;
    if (_xs_prev && typeof _xs_prev.xshell_last_total === 'number') _xs_last = _xs_prev.xshell_last_total;
  } catch (_) {}
  const _xs_now = (data.cost && data.cost.total_cost_usd) || 0;
  const _xs_delta = Math.max(0, _xs_now - _xs_last);
  if (_xs_delta > 0) {
    const _xs_today = new Date().toISOString().slice(0, 10);
    _xs_daily[_xs_today] = (_xs_daily[_xs_today] || 0) + _xs_delta;
  }
  data.xshell_daily_cost = _xs_daily;
  data.xshell_last_total = _xs_now;
  _xs_fs.writeFileSync(_xs_file, JSON.stringify(data));
} catch (_) {}
\`\`\`

3. If no statusLine exists: create ~/.claude/xshell-stats.js with this content (same monotonic + daily-breakdown behavior):

\`\`\`js
#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const dir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'xshell-stats');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, \`\${data.session_id}.json\`);
    let daily = {}, lastTotal = 0;
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      const p = prev && prev.cost && prev.cost.total_cost_usd;
      if (typeof p === 'number' && data.cost && p > (data.cost.total_cost_usd || 0)) {
        data.cost.total_cost_usd = p;
      }
      if (prev && prev.xshell_daily_cost) daily = prev.xshell_daily_cost;
      if (prev && typeof prev.xshell_last_total === 'number') lastTotal = prev.xshell_last_total;
    } catch (_) {}
    const now = (data.cost && data.cost.total_cost_usd) || 0;
    const delta = Math.max(0, now - lastTotal);
    if (delta > 0) {
      const today = new Date().toISOString().slice(0, 10);
      daily[today] = (daily[today] || 0) + delta;
    }
    data.xshell_daily_cost = daily;
    data.xshell_last_total = now;
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (_) {}
  process.stdout.write('');
});
\`\`\`

Then add this top-level block to ~/.claude/settings.json (alongside other keys, not nested):

\`\`\`json
"statusLine": {
  "type": "command",
  "command": "node \\"<HOME>/.claude/xshell-stats.js\\""
}
\`\`\`

Replace <HOME> with the actual absolute home path (use forward slashes even on Windows).

4. Don't restart anything — Claude Code picks up statusline changes on its next refresh tick.

Show me what you changed and stop.`;
}

// Extract the script path from a `statusLine.command` string. Handles both shell-quoted
// ("node \"C:/path/script.js\"") and bare invocations. Returns null if we can't make sense
// of it — wizard will just hide the reveal button in that case.
function extractScriptPath(command: string | null): string | null {
  if (!command) return null;
  // Match a quoted path first ("..." or '...').
  const quoted = command.match(/["']([^"']+\.(?:js|mjs|cjs|ts|sh|bat|cmd|ps1|exe))["']/i);
  if (quoted) return quoted[1];
  // Otherwise grab the last token that looks like a path.
  const parts = command.trim().split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].replace(/^["']|["']$/g, "");
    if (/[\\/]/.test(p) && /\.(js|mjs|cjs|ts|sh|bat|cmd|ps1|exe)$/i.test(p)) return p;
  }
  return null;
}

// Compact "X minutes ago" formatter; fed an ISO-8601 string from the Rust probe.
function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

interface Props { onClose: () => void }

export function DetailedSessionInfoWizard({ onClose }: Props) {
  const [probe, setProbe] = useState<StatuslineProbe | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Lets a user with a working setup still grab the latest snippet — useful when we ship
  // an updated version (e.g. monotonic cost, new fields), or they're moving machines.
  // Detected setup ≠ "snippet is current"; the probe only checks file presence, not content.
  const [showUpdate, setShowUpdate] = useState(false);
  const { tt, Tooltip } = useTooltip();

  const refresh = useCallback(() => {
    invoke<StatuslineProbe>("probe_statusline_setup").then(setProbe).catch(() => setProbe(null));
  }, []);

  useEffect(() => {
    refresh();
    // Re-probe every 4s while the wizard is open so users see the green tick appear
    // automatically right after they paste the snippet and Claude Code refreshes.
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  };

  const isWorking = probe && probe.stats_dir_present && probe.stats_session_count > 0;
  const hasExisting = probe && probe.has_statusline && !isWorking;
  const needsInstall = probe && !probe.has_statusline && !isWorking;
  const scriptPath = extractScriptPath(probe?.existing_command ?? null);

  return (
    <div className="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-panel dsi-panel">
        <div className="settings-header">
          <span>Detailed session info</span>
          <button className="settings-close" onClick={onClose} aria-label="Close" {...ttProps(tt, "Close")}><X size={14} /></button>
        </div>
        <div className="settings-body dsi-body">
          {!probe && <div className="dsi-loading">Probing setup…</div>}

          {/* Short, always-visible primer — explains what this configures and why it has
              to live in the statusline (the only Claude Code hook that exposes cost+context). */}
          {probe && (
            <div className="dsi-primer">
              <div className="dsi-primer-title"><Info size={11} /> What this configures</div>
              <div className="dsi-primer-body">
                Claude Code only exposes per-session <strong>cost</strong>, <strong>context %</strong>, and <strong>rate-limit usage</strong> through one mechanism: the <code>statusLine</code> hook. The snippet dumps the same JSON Claude Code already feeds the statusline into <code>~/.claude/xshell-stats/&lt;session_id&gt;.json</code>, keeping <code>cost.total_cost_usd</code> monotonic so resuming an old session never lowers its lifetime total. xshell reads that file as the only authoritative source — your statusline output stays unchanged.
              </div>
            </div>
          )}

          {isWorking && (
            <>
              <div className="dsi-status dsi-status-ok">
                <Check size={16} />
                <div className="dsi-status-text">
                  <strong>You're all set.</strong>
                  <span>Reading authoritative stats from {probe.stats_session_count} session{probe.stats_session_count === 1 ? "" : "s"}. Last update: {timeAgo(probe.last_update_iso)}.</span>
                </div>
                <div className="dsi-status-actions">
                  {scriptPath && <button className="btn btn-ghost dsi-icon-btn" onClick={() => invoke("reveal_in_explorer", { path: scriptPath }).catch(() => {})} {...ttProps(tt, `Reveal ${scriptPath.split(/[\\/]/).pop()} in explorer`)}><FileText size={12} /></button>}
                  <button className="btn btn-ghost dsi-icon-btn" onClick={() => invoke("reveal_in_explorer", { path: probe.stats_dir_path }).catch(() => {})} {...ttProps(tt, "Reveal xshell-stats folder")}><FolderOpen size={12} /></button>
                </div>
              </div>
              {/* The probe only sees that *some* xshell-stats files exist — it can't tell whether
                  the snippet inside the user's script is the current version. So we always offer
                  a way to grab the latest snippet here, framed as update/reinstall. */}
              <button className="dsi-update-toggle" onClick={() => setShowUpdate(v => !v)}>
                {showUpdate ? "Hide" : "Show"} latest snippet
                <span className="dsi-update-hint">{showUpdate ? "" : "use this if xshell shipped an updated version, or you're moving machines"}</span>
              </button>
              {showUpdate && (
                <>
                  <CodeBlock label="Paste into your existing statusline script (replaces the previous xshell block)" code={snippetForExistingStatusline()} copied={copied === "merge"} onCopy={() => copy("merge", snippetForExistingStatusline())} />
                  <ClaudePromptButton copied={copied === "claude"} onCopy={() => copy("claude", claudePromptForSetup())} />
                </>
              )}
            </>
          )}

          {hasExisting && (
            <>
              <div className="dsi-status dsi-status-warn">
                <AlertCircle size={16} />
                <div className="dsi-status-text">
                  <strong>Existing statusline detected.</strong>
                  <span className="dsi-mono-tiny">{probe.existing_command}</span>
                  <span>Paste the snippet below into that script — inside its main <code>try</code> block, where the parsed <code>data</code> variable is in scope. Your statusline keeps working as before.</span>
                </div>
                {scriptPath && (
                  <button className="btn btn-ghost dsi-icon-btn" onClick={() => invoke("reveal_in_explorer", { path: scriptPath }).catch(() => {})} {...ttProps(tt, `Reveal ${scriptPath.split(/[\\/]/).pop()} in explorer`)}><FileText size={12} /></button>
                )}
              </div>
              <CodeBlock label="Paste into your existing statusline script" code={snippetForExistingStatusline()} copied={copied === "merge"} onCopy={() => copy("merge", snippetForExistingStatusline())} />
              <ClaudePromptButton copied={copied === "claude"} onCopy={() => copy("claude", claudePromptForSetup())} />
            </>
          )}

          {needsInstall && (
            <>
              <div className="dsi-status dsi-status-warn">
                <AlertCircle size={16} />
                <div className="dsi-status-text">
                  <strong>No statusline configured.</strong>
                  <span>Two manual steps below — or paste the Claude prompt at the bottom and let Claude set it up for you.</span>
                </div>
              </div>
              <div className="dsi-step">
                <div className="dsi-step-label"><span className="dsi-step-num">1</span> Save this script to <code>{`${probe.home_dir.replace(/\\/g, "/")}/.claude/xshell-stats.js`}</code></div>
                <CodeBlock label="xshell-stats.js" code={snippetForNewScript()} copied={copied === "script"} onCopy={() => copy("script", snippetForNewScript())} />
              </div>
              <div className="dsi-step">
                <div className="dsi-step-label"><span className="dsi-step-num">2</span> Add this block to <code>{`${probe.home_dir.replace(/\\/g, "/")}/.claude/settings.json`}</code> (top-level, alongside other keys)</div>
                <CodeBlock label="settings.json" code={snippetForSettingsJson(probe.home_dir)} copied={copied === "settings"} onCopy={() => copy("settings", snippetForSettingsJson(probe.home_dir))} />
              </div>
              <ClaudePromptButton copied={copied === "claude"} onCopy={() => copy("claude", claudePromptForSetup())} />
            </>
          )}

          <div className="dsi-foot">
            <button className="btn btn-ghost" onClick={refresh} {...ttProps(tt, "Re-check")}><RefreshCw size={11} /> Re-check</button>
            <span className="dsi-foot-hint">Without this setup, xshell can't show cost or context — Claude Code only exposes those through the statusline hook. With setup, numbers come straight from Claude Code and stay monotonic across resumes.</span>
          </div>
        </div>
      </div>
      {Tooltip}
    </div>
  );
}

function CodeBlock({ label, code, onCopy, copied }: { label: string; code: string; onCopy: () => void; copied: boolean }) {
  return (
    <div className="dsi-codeblock">
      <div className="dsi-codeblock-head">
        <span className="dsi-codeblock-label">{label}</span>
        <button className="dsi-codeblock-copy" onClick={onCopy}>
          {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
        </button>
      </div>
      <pre className="dsi-codeblock-body">{code}</pre>
    </div>
  );
}

// Single button shown instead of a third CodeBlock for the Claude prompt — the prompt itself
// is too long to be useful as a visible block, and users only ever copy it. Click → clipboard
// gets the full setup prompt; the button briefly says "Copied". One-line hint underneath.
function ClaudePromptButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <div className="dsi-claude-row">
      <div className="dsi-or-row">
        <span className="dsi-or-line" />
        <span className="dsi-or-text">or let Claude do it</span>
        <span className="dsi-or-line" />
      </div>
      <button className="dsi-claude-btn" onClick={onCopy}>
        {copied ? <><Check size={12} /> Copied — paste into Claude Code</> : <><Copy size={12} /> Copy Claude prompt</>}
      </button>
      <span className="dsi-claude-hint">Paste it into a Claude Code session in any project. Claude will install the script and patch your settings.json. This dialog auto-detects success on its next probe.</span>
    </div>
  );
}
