import { useEffect, useRef, useState, useCallback, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { GitBranch, ArrowUp, ArrowDown, RefreshCw, ChevronRight, ChevronDown, Plus, Minus, History, GitFork, Pencil, X as XIcon, Check, Search, AlertTriangle, Cloud } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { Tab, GitStatus, GitFile, GitCommit, BranchInfo, SessionInfo, GitBranch as GitBranchEntry } from "../types";
import { getShellById } from "../shells";
import type { ThemeMode } from "./SettingsView";

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
// Bold weight always sits two CSS steps above the regular weight so the contrast between
// normal/bold scales with the user's pick. Capped at 900 (the heaviest CSS weight).
const BOLD_OFFSET = 200;
const MAX_FONT_WEIGHT = 900;

// Default xterm bg per app theme. Exported so SettingsView's "Reset" button can fall
// back to the right shade per theme, and so App.tsx can detect "user is on default"
// vs "user picked a custom color" when migrating an existing terminalBgColor across themes.
export const DARK_TERM_BG = "#1c1c1b";
export const LIGHT_TERM_BG = "#faf9f5";

// Two complete xterm palettes that pair with the app's dark/light themes. The brand
// (cursor, terracotta-as-yellow, selection wash) is constant across themes — it's the
// surface and ink that flip. ANSI "white" maps to a dark gray on the light palette so
// `echo "white text"` doesn't disappear into the parchment background.
const DARK_PALETTE = {
  background: DARK_TERM_BG,
  foreground: "#faf9f5",
  cursor: "#c96442",
  cursorAccent: "#141413",
  selectionBackground: "rgba(201, 100, 66, 0.3)",
  selectionForeground: "#faf9f5",
  black: "#30302e",
  red: "#b53333",
  green: "#4a9968",
  yellow: "#c96442",
  blue: "#3898ec",
  magenta: "#9a6dd7",
  cyan: "#4a9999",
  white: "#b0aea5",
  brightBlack: "#5e5d59",
  brightRed: "#d97757",
  brightGreen: "#6cc088",
  brightYellow: "#d97757",
  brightBlue: "#5ab0f0",
  brightMagenta: "#b088e0",
  brightCyan: "#6cc0c0",
  brightWhite: "#faf9f5",
} as const;

const LIGHT_PALETTE = {
  background: LIGHT_TERM_BG,
  foreground: "#141413",
  cursor: "#c96442",
  cursorAccent: "#faf9f5",
  selectionBackground: "rgba(201, 100, 66, 0.22)",
  selectionForeground: "#141413",
  black: "#141413",
  red: "#b53333",
  green: "#3d7a52",
  yellow: "#c96442",
  blue: "#2a7cc9",
  magenta: "#7a52b5",
  cyan: "#377a7a",
  white: "#5e5d59",
  brightBlack: "#87867f",
  brightRed: "#d97757",
  brightGreen: "#4a9968",
  brightYellow: "#b35538",
  brightBlue: "#3898ec",
  brightMagenta: "#9a6dd7",
  brightCyan: "#4a9999",
  brightWhite: "#141413",
} as const;

function paletteFor(theme: ThemeMode, bgOverride: string) {
  const base = theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  // The user's saved bg only overrides if it's a real custom pick — i.e. not one of the
  // two known theme defaults. That way, users who never touched the picker get the right
  // shade automatically when they flip themes; users who chose, say, solarized #002b36
  // keep their pick on both themes.
  const isThemeDefault = bgOverride === DARK_TERM_BG || bgOverride === LIGHT_TERM_BG;
  return isThemeDefault ? base : { ...base, background: bgOverride };
}

async function loadZoom(tabId: string, fallback: number): Promise<number> {
  try {
    const store = await load("settings.json", { defaults: {}, autoSave: true });
    const map = (await store.get<Record<string, number>>("terminal_zoom")) || {};
    const v = map[tabId];
    return typeof v === "number" && v >= MIN_FONT_SIZE && v <= MAX_FONT_SIZE ? v : fallback;
  } catch { return fallback; }
}
async function saveZoom(tabId: string, size: number) {
  try {
    const store = await load("settings.json", { defaults: {}, autoSave: true });
    const map = (await store.get<Record<string, number>>("terminal_zoom")) || {};
    map[tabId] = size;
    await store.set("terminal_zoom", map);
  } catch {}
}

interface TerminalTabProps {
  tab: Tab;
  isActive: boolean;
  gitLazyPolling: boolean;
  gitPanelFilenamesOnly: boolean;
  terminalBgColor: string;
  defaultFontSize: number;
  defaultShellId: string;
  fullscreenRendering: boolean;
  forceSyncOutput: boolean;
  // Use the GPU-accelerated WebGL renderer for xterm.js. Default ON — it eliminates
  // subpixel seams in the half-block characters that Claude Code's startup banner uses,
  // and is generally a smoother render. Falls back to the DOM renderer automatically if
  // the host's GPU can't provide a WebGL context (e.g. forced-software-render WebViews).
  webglRendering: boolean;
  // CSS font weight for regular text (100–700). Bold text auto-derives as +200, capped at
  // 900. Defaults to 300 — bumping to 400+ helps compensate for the lack of subpixel AA
  // under the WebGL renderer.
  terminalFontWeight: number;
  // When true, spawn the backend PTY as soon as this tab mounts even if its host is currently
  // hidden (parking div / inactive group leaf). When false (legacy behavior), spawn waits
  // until the host has non-zero dimensions — i.e. until the user actually clicks the tab.
  eagerInit: boolean;
  theme: ThemeMode;
  // Encoded project dir name (e.g. `C--Users-foo-app`) so we can fetch session stats from
  // `~/.claude/projects/<encoded>/<id>.jsonl`. Empty when the project hasn't been seen by
  // claude yet — in that case the cost/context strip falls back to the project path.
  projectEncodedName: string;
  // User-controlled override on top of `is_authoritative_stats`. When false, the header
  // always shows the project path even if stats are available — handy for users who don't
  // want the cost figure visible in screen-shares.
  showTerminalHeaderStats: boolean;
  onBranchSwitch: (tabId: string, newSessionId: string, newTitle: string) => void;
}

// Compact USD formatter for the header strip — keeps the value tight on narrow terminals
// without dropping precision for small totals (≪ $1).
function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}

// 200k context budget colors: ok < 60% < warn < 85% < hot. Mirrors the dashboard tiers.
function ctxLevel(pct: number): "ok" | "warn" | "hot" {
  if (pct >= 85) return "hot";
  if (pct >= 60) return "warn";
  return "ok";
}

function TerminalTooltip({ text, rect }: { text: string; rect: DOMRect }) {
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

const MIN_PANEL = 200;
const MAX_PANEL = 600;
const DEFAULT_PANEL = 280;

export function TerminalTab({ tab, isActive, gitLazyPolling, gitPanelFilenamesOnly, terminalBgColor, defaultFontSize, defaultShellId, fullscreenRendering, forceSyncOutput, webglRendering, terminalFontWeight, eagerInit, theme, projectEncodedName, showTerminalHeaderStats, onBranchSwitch }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const [_error, setError] = useState<string | null>(null);
  const tabRef = useRef(tab);
  // Loading state: true from spawn until the PTY emits its first byte. That window covers
  // Node.js boot + claude TUI first paint — the "blank screen" the user sees before claude
  // is ready. Universal: works for fresh, --resume, and raw shells.
  const [isInitializing, setIsInitializing] = useState(true);
  const sawFirstOutputRef = useRef(false);

  const [showGitPanel, setShowGitPanel] = useState(false);
  const [gitPanelWidth, setGitPanelWidth] = useState(DEFAULT_PANEL);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [gitRefreshing, setGitRefreshing] = useState(false);
  // History expanded by default — most users want to see recent commits the moment they open
  // the panel. The user can still collapse it; the choice isn't persisted across tabs.
  const [gitHistoryOpen, setGitHistoryOpen] = useState(true);
  // Branch dropdown anchor — null when closed. The chip in the panel header opens the
  // dropdown next to itself; we capture the rect on open and reuse it for positioning.
  const [branchDropdown, setBranchDropdown] = useState<{ rect: DOMRect; el: HTMLElement } | null>(null);
  // Last-failed checkout error, surfaced as a thin red banner above the panel. Auto-clears
  // after ~7s; the user can also dismiss it manually.
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const checkoutErrorTimerRef = useRef<number | null>(null);
  const [checkoutInFlight, setCheckoutInFlight] = useState(false);
  // Paths that changed in the latest status update — marked for a brief blink animation.
  const [recentlyChangedPaths, setRecentlyChangedPaths] = useState<Set<string>>(new Set());
  const prevFileKeysRef = useRef<Set<string>>(new Set());
  // Guard against flagging every file on the very first poll (before we have a baseline).
  const gitPolledOnceRef = useRef<boolean>(false);
  const highlightTimerRef = useRef<number | null>(null);
  // Confirmation banner shown briefly after a branch is detected and auto-applied.
  // { oldTitle, newTitle } — auto-dismisses after ~6s, or on X click.
  const [branchNotice, setBranchNotice] = useState<{ oldTitle: string; newTitle: string } | null>(null);
  const branchNoticeTimerRef = useRef<number | null>(null);
  // Same idea, but for /rename — the title-sync poll in App.tsx silently swaps tab.title
  // when the on-disk session title changes. Surface that as a banner so the user knows.
  const [renameNotice, setRenameNotice] = useState<{ oldTitle: string; newTitle: string } | null>(null);
  const renameNoticeTimerRef = useRef<number | null>(null);
  // Snapshot of session jsonls that already existed when this tab attached — plus any we've
  // observed since. Only files OUTSIDE this set count as fresh forks. Without this, resuming
  // an ancestor session in another tab would bump its mtime and trigger a false positive.
  const knownSessionIdsRef = useRef<Set<string>>(new Set());
  const knownSeededRef = useRef<boolean>(false);
  const [tooltip, setTooltip] = useState<{ text: string; rect: DOMRect } | null>(null);
  // Cost / context strip — driven by the xshell-stats statusline hook (only present when
  // the user wired it up). Stays null when no authoritative data exists; the header then
  // falls back to showing the project path verbatim.
  const [sessionStats, setSessionStats] = useState<SessionInfo | null>(null);

  const showTt = useCallback((text: string, el: HTMLElement) => setTooltip({ text, rect: el.getBoundingClientRect() }), []);
  const hideTt = useCallback(() => setTooltip(null), []);

  // Zoom state kept in a ref so the key handler sees the latest value without re-binding.
  const fontSizeRef = useRef<number>(defaultFontSize);
  // Keep a live ref to the settings-level default so Ctrl+0 resets to the current preference,
  // not whatever the prop was at mount time.
  const defaultFontSizeRef = useRef<number>(defaultFontSize);
  useEffect(() => { defaultFontSizeRef.current = defaultFontSize; }, [defaultFontSize]);
  const applyFontSize = useCallback((size: number, save = true) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size)));
    fontSizeRef.current = clamped;
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = clamped;
      requestAnimationFrame(() => fitAddonRef.current?.fit());
    }
    if (save) saveZoom(tabRef.current.id, clamped);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: paletteFor(theme, terminalBgColor),
      fontFamily: "Consolas, 'Courier New', monospace",
      fontWeight: terminalFontWeight,
      fontWeightBold: Math.min(MAX_FONT_WEIGHT, terminalFontWeight + BOLD_OFFSET),
      fontSize: defaultFontSizeRef.current,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // WebGL renderer — must be loaded AFTER term.open(), since the addon attaches to the
    // open xterm's DOM. Loading throws if the host can't give us a WebGL context (CI,
    // forced-software-render WebViews); in that case we silently fall back to the default
    // DOM renderer. The addon also raises a `contextLoss` event if the driver yanks the
    // context later — we dispose on that so xterm reverts cleanly to DOM rendering instead
    // of leaving a frozen canvas behind.
    if (webglRendering) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); webglAddonRef.current = null; });
        term.loadAddon(addon);
        webglAddonRef.current = addon;
      } catch (_) { /* WebGL unavailable — DOM renderer takes over automatically */ }
    }

    // Intercept Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 for zoom, and Ctrl+V for paste
    // (Windows Terminal convention — the terminal would otherwise swallow Ctrl+V as ^V).
    term.attachCustomKeyEventHandler((ev) => {
      if (!ev.ctrlKey || ev.type !== "keydown") return true;
      if (ev.key === "+" || ev.key === "=") { applyFontSize(fontSizeRef.current + 1); ev.preventDefault(); return false; }
      if (ev.key === "-" || ev.key === "_") { applyFontSize(fontSizeRef.current - 1); ev.preventDefault(); return false; }
      if (ev.key === "0") { applyFontSize(defaultFontSizeRef.current); ev.preventDefault(); return false; }
      // Ctrl+V (but not Ctrl+Shift+V — that stays for xterm's default / bracketed escape).
      if (!ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        navigator.clipboard.readText().then((text) => {
          if (text) invoke("write_terminal", { id: tabRef.current.id, data: text }).catch(() => {});
        }).catch(() => {});
        return false;
      }
      return true;
    });

    // Ctrl+wheel zoom — natural in editors/terminals.
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      applyFontSize(fontSizeRef.current + (ev.deltaY < 0 ? 1 : -1));
    };
    containerRef.current.addEventListener("wheel", onWheel, { passive: false });

    // Restore persisted zoom for this tab, then kick off fit + backend spawn.
    // Critical: wait until the container has non-zero, settled dimensions before fitting,
    // otherwise xterm computes cols/rows from a partial layout and we hand claude wrong
    // dimensions on spawn. Claude's Ink-based TUI then renders to that smaller box and
    // doesn't fully redraw until a real SIGWINCH (e.g. when the user resizes the window).
    // This is the "first render is too small" bug specific to xterm.js + ink CLIs.
    loadZoom(tabRef.current.id, defaultFontSizeRef.current).then(size => {
      fontSizeRef.current = size;
      term.options.fontSize = size;
      const el = containerRef.current;
      if (!el) return;
      const tick = () => {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          // One extra rAF lets any pending flex/layout work flush before we measure.
          requestAnimationFrame(() => {
            fitAddon.fit();
            spawnBackend(term, fitAddon);
          });
        } else if (eagerInit) {
          // Host is hidden (e.g. parked while another tab is active) but the user opted
          // into eager init — spawn anyway. xterm boots at its default 80x24; the
          // ResizeObserver + IntersectionObserver below will fit + send a SIGWINCH the
          // moment the host is reparented into a visible slot, so claude gets the right
          // dimensions on first view. Without this, every restored tab waits to spawn
          // until the user clicks it, which makes the launch experience feel sluggish.
          requestAnimationFrame(() => spawnBackend(term, fitAddon));
        } else {
          requestAnimationFrame(tick);
        }
      };
      tick();
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit());
    });
    resizeObserver.observe(containerRef.current);

    const intersectionObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) requestAnimationFrame(() => { fitAddon.fit(); term.focus(); });
    });
    intersectionObserver.observe(containerRef.current);

    // Right-click = paste clipboard into terminal (like Windows Terminal / gnome-terminal)
    const onContextMenu = async (ev: MouseEvent) => {
      ev.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text) invoke("write_terminal", { id: tabRef.current.id, data: text }).catch(() => {});
      } catch (_) {}
    };
    containerRef.current.addEventListener("contextmenu", onContextMenu);

    async function spawnBackend(term: Terminal, _fitAddon: FitAddon) {
      const id = tabRef.current.id;

      const unlistenOutput = await listen<string>(`terminal-output-${id}`, (event) => {
        if (!sawFirstOutputRef.current) {
          sawFirstOutputRef.current = true;
          setIsInitializing(false);
        }
        term.write(event.payload);
      });

      const unlistenExit = await listen(`terminal-exit-${id}`, () => {
        // Spawn failed before any output (e.g. claude not on PATH) — drop the loader so
        // the error message we're about to write isn't hidden behind it.
        if (!sawFirstOutputRef.current) {
          sawFirstOutputRef.current = true;
          setIsInitializing(false);
        }
        term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      });

      const onDataDisposable = term.onData((data) => {
        invoke("write_terminal", { id, data }).catch(() => {});
      });

      const onResizeDisposable = term.onResize(({ cols, rows }) => {
        invoke("resize_terminal", { id, cols, rows }).catch(() => {});
      });

      try {
        const shellMode = tabRef.current.shellMode || "claude";
        // Raw shells always use the tab's explicit shellId. Claude sessions fall back to the
        // user's default shell setting, so claude runs under the shell the user picked.
        const effectiveShellId = tabRef.current.shellId || (shellMode === "claude" ? defaultShellId : null);
        const shellCommand = effectiveShellId ? (getShellById(effectiveShellId)?.command || null) : null;
        await invoke("spawn_terminal", { id, sessionId: tabRef.current.sessionId || null, cwd: tabRef.current.projectPath || ".", cols: term.cols, rows: term.rows, shellMode, shellCommand, shellId: effectiveShellId, fullscreenRendering, forceSyncOutput });
        // Post-spawn nudge for ink-based TUIs (claude code). Some Ink renderers ignore the
        // very first SIGWINCH if it arrives mid-bootstrap; a delayed re-fit + forced PTY
        // resize ensures the final cols/rows are picked up cleanly even if xterm's own
        // dimensions haven't changed (in which case onResize wouldn't fire on its own).
        setTimeout(() => {
          if (!terminalRef.current || !fitAddonRef.current) return;
          fitAddonRef.current.fit();
          invoke("resize_terminal", { id, cols: terminalRef.current.cols, rows: terminalRef.current.rows }).catch(() => {});
        }, 250);
      } catch (err) {
        setError(String(err));
        // Locally-written errors don't go through the terminal-output event, so the
        // loader wouldn't auto-clear. Dismiss it here so the message is visible.
        sawFirstOutputRef.current = true;
        setIsInitializing(false);
        term.write(`\x1b[31mFailed to start terminal: ${err}\x1b[0m\r\n`);
        if ((tabRef.current.shellMode || "claude") === "claude") {
          term.write(`\x1b[90mMake sure 'claude' is installed and available in your PATH.\x1b[0m\r\n`);
        }
      }

      (term as any)._cleanup = () => {
        unlistenOutput();
        unlistenExit();
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        invoke("close_terminal", { id }).catch(() => {});
      };
    }

    const containerEl = containerRef.current;
    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      containerEl?.removeEventListener("contextmenu", onContextMenu);
      containerEl?.removeEventListener("wheel", onWheel);
      if ((term as any)._cleanup) (term as any)._cleanup();
      // Dispose the WebGL addon explicitly before the terminal — its docs note that an
      // explicit dispose() is required to free the GL resources cleanly. term.dispose()
      // does cascade, but ordering it this way mirrors the xterm.js example.
      if (webglAddonRef.current) { webglAddonRef.current.dispose(); webglAddonRef.current = null; }
      term.dispose();
    };
  }, []);

  // Apply font-weight changes live. Setting `term.options.fontWeight` (and the matching
  // bold derivation) triggers an xterm internal redraw — and under the WebGL renderer it
  // also rebuilds the glyph atlas, so the new weight shows up immediately without needing
  // to dispose/recreate the terminal.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontWeight = terminalFontWeight as any;
    term.options.fontWeightBold = Math.min(MAX_FONT_WEIGHT, terminalFontWeight + BOLD_OFFSET) as any;
  }, [terminalFontWeight]);

  // Live-toggle the WebGL renderer when the user flips the setting without recreating the
  // terminal. Disposing the addon hands rendering back to the default DOM renderer; loading
  // a fresh one switches back. Wrapped in try/catch so a runtime failure (driver loss, etc.)
  // doesn't tear down the surrounding effect.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    if (webglRendering && !webglAddonRef.current) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); webglAddonRef.current = null; });
        term.loadAddon(addon);
        webglAddonRef.current = addon;
      } catch (_) {}
    } else if (!webglRendering && webglAddonRef.current) {
      webglAddonRef.current.dispose();
      webglAddonRef.current = null;
    }
  }, [webglRendering]);

  // Refit terminal whenever the git panel opens/closes or resizes
  useEffect(() => {
    if (!fitAddonRef.current) return;
    requestAnimationFrame(() => fitAddonRef.current?.fit());
  }, [showGitPanel, gitPanelWidth]);

  // Live-update the full xterm palette whenever the app theme or the user's bg-override
  // changes. Using `paletteFor` keeps the brand-relative colors (cursor, ANSI) consistent
  // with whichever theme is active without firing a full terminal teardown.
  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = paletteFor(theme, terminalBgColor);
  }, [theme, terminalBgColor]);

  // A stable key for a file entry: `path|staged|unstaged`. Any character change ("M"→"A",
  // or a new file appearing) yields a new key, which is how we detect "something changed".
  const fileKey = (f: GitFile) => `${f.path}|${f.staged}|${f.unstaged}`;

  // Fetch git status (async, non-blocking). Diffs against the previous snapshot and flags
  // newly-changed files so the UI can blink them for the user.
  const fetchGitStatus = useCallback(async () => {
    if (!tab.projectPath) return;
    setGitRefreshing(true);
    try {
      const status = await invoke<GitStatus>("get_git_status", { cwd: tab.projectPath });
      const currentKeys = new Set((status.files || []).map(fileKey));
      // "Changed since last poll" = keys present now that weren't present before. This
      // captures new files, newly-staged, newly-modified, etc. Pure removals aren't flagged
      // (the row vanishes — no point blinking it). Skip flagging on the very first poll
      // (otherwise every file would blink when the panel first opens).
      const changed = new Set<string>();
      if (gitPolledOnceRef.current) {
        for (const f of status.files || []) {
          if (!prevFileKeysRef.current.has(fileKey(f))) changed.add(f.path);
        }
      }
      prevFileKeysRef.current = currentKeys;
      gitPolledOnceRef.current = true;
      setGitStatus(status);
      if (changed.size > 0) {
        setRecentlyChangedPaths(changed);
        if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = window.setTimeout(() => setRecentlyChangedPaths(new Set()), 1800);
      }
    } catch (_) {
      setGitStatus(null);
    } finally {
      setGitRefreshing(false);
    }
  }, [tab.projectPath]);

  const fetchGitLog = useCallback(async () => {
    if (!tab.projectPath) return;
    try {
      const commits = await invoke<GitCommit[]>("get_git_log", { cwd: tab.projectPath, limit: 25 });
      setGitCommits(commits);
    } catch (_) { setGitCommits([]); }
  }, [tab.projectPath]);

  const handleStageFile = useCallback(async (path: string) => {
    if (!tab.projectPath) return;
    try { await invoke("git_stage", { cwd: tab.projectPath, paths: [path] }); } catch (_) {}
    fetchGitStatus();
  }, [tab.projectPath, fetchGitStatus]);

  const handleUnstageFile = useCallback(async (path: string) => {
    if (!tab.projectPath) return;
    try { await invoke("git_unstage", { cwd: tab.projectPath, paths: [path] }); } catch (_) {}
    fetchGitStatus();
  }, [tab.projectPath, fetchGitStatus]);

  // Surface a checkout failure as a thin banner; auto-dismisses so it doesn't linger.
  const showCheckoutError = useCallback((msg: string) => {
    if (checkoutErrorTimerRef.current) window.clearTimeout(checkoutErrorTimerRef.current);
    setCheckoutError(msg);
    checkoutErrorTimerRef.current = window.setTimeout(() => setCheckoutError(null), 7000);
  }, []);
  const dismissCheckoutError = useCallback(() => {
    if (checkoutErrorTimerRef.current) { window.clearTimeout(checkoutErrorTimerRef.current); checkoutErrorTimerRef.current = null; }
    setCheckoutError(null);
  }, []);

  // Switch to `branch`. When the working tree is dirty we ask for confirmation up front —
  // git itself may still allow the switch (non-conflicting changes), but the user wanted the
  // typical safety prompt. On failure we surface git's stderr verbatim.
  const handleCheckout = useCallback(async (branch: string) => {
    if (!tab.projectPath || checkoutInFlight) return;
    const dirty = (gitStatus?.files.length || 0) > 0;
    if (dirty) {
      const ok = window.confirm(`You have uncommitted changes. Switch to "${branch}" anyway?\n\nGit will refuse the switch if any of those changes would be overwritten by the target branch.`);
      if (!ok) return;
    }
    setCheckoutInFlight(true);
    try {
      await invoke("git_checkout", { cwd: tab.projectPath, branch });
      dismissCheckoutError();
      setBranchDropdown(null);
      // Refresh status immediately so the chip updates without waiting for the 3s tick.
      fetchGitStatus();
    } catch (err) {
      showCheckoutError(typeof err === "string" ? err : String(err));
    } finally {
      setCheckoutInFlight(false);
    }
  }, [tab.projectPath, checkoutInFlight, gitStatus, fetchGitStatus, showCheckoutError, dismissCheckoutError]);

  // Seed the known-ids set once per tab-session attachment. Any jsonl present now is
  // "pre-existing" and won't be flagged as a fork of us. Runs async; checkBranch gates
  // itself on `knownSeededRef` so we never scan with an empty set.
  const seedKnownSessionIds = useCallback(async () => {
    if (!tab.projectPath) return;
    try {
      const ids = await invoke<string[]>("list_project_session_ids", { cwd: tab.projectPath });
      const set = new Set<string>(ids);
      if (tab.sessionId) set.add(tab.sessionId);
      knownSessionIdsRef.current = set;
      knownSeededRef.current = true;
    } catch (_) {
      knownSessionIdsRef.current = new Set(tab.sessionId ? [tab.sessionId] : []);
      knownSeededRef.current = true;
    }
  }, [tab.projectPath, tab.sessionId]);

  // Detect /branch forks. Rust verifies candidacy via (a) our-session UUID overlap AND
  // (b) tail-UUID match — so sibling forks of a shared ancestor don't trigger. The known
  // filter also excludes any jsonl that existed when we attached (e.g. user resumed the
  // parent in another tab; that bumps mtime but the file is pre-existing → correctly ignored).
  const checkBranch = useCallback(async () => {
    if (!tab.projectPath || !tab.sessionId || (tab.shellMode || "claude") !== "claude") return;
    if (!knownSeededRef.current) return;
    try {
      const info = await invoke<BranchInfo | null>("detect_session_branch", {
        cwd: tab.projectPath,
        currentSessionId: tab.sessionId,
        knownSessionIds: Array.from(knownSessionIdsRef.current),
      });
      if (!info) return;
      // Always auto-follow. Add to known first so we don't re-detect on the next tick
      // (the new jsonl keeps getting writes from the PTY — it's pre-existing now).
      knownSessionIdsRef.current.add(info.new_session_id);
      const oldTitle = tab.title || "previous session";
      onBranchSwitch(tab.id, info.new_session_id, info.title);
      // Show the confirmation banner. Auto-dismiss after ~6s so it doesn't linger.
      if (branchNoticeTimerRef.current) window.clearTimeout(branchNoticeTimerRef.current);
      setBranchNotice({ oldTitle, newTitle: info.title });
      branchNoticeTimerRef.current = window.setTimeout(() => setBranchNotice(null), 6000);
    } catch (_) {}
  }, [tab.projectPath, tab.sessionId, tab.shellMode, tab.id, tab.title, onBranchSwitch]);

  // Re-seed whenever the tab's sessionId changes (initial attach, or after a branch-switch).
  useEffect(() => {
    knownSeededRef.current = false;
    seedKnownSessionIds();
  }, [tab.sessionId, seedKnownSessionIds]);

  // Clean up notice timers on unmount.
  useEffect(() => () => {
    if (branchNoticeTimerRef.current) window.clearTimeout(branchNoticeTimerRef.current);
    if (renameNoticeTimerRef.current) window.clearTimeout(renameNoticeTimerRef.current);
    if (checkoutErrorTimerRef.current) window.clearTimeout(checkoutErrorTimerRef.current);
  }, []);

  const dismissBranchNotice = useCallback(() => {
    if (branchNoticeTimerRef.current) { window.clearTimeout(branchNoticeTimerRef.current); branchNoticeTimerRef.current = null; }
    setBranchNotice(null);
  }, []);

  const dismissRenameNotice = useCallback(() => {
    if (renameNoticeTimerRef.current) { window.clearTimeout(renameNoticeTimerRef.current); renameNoticeTimerRef.current = null; }
    setRenameNotice(null);
  }, []);

  // /rename detection. App.tsx's title-sync poll already updates tab.title in place when
  // the JSONL's title changes — we just need to notice the change here. A rename keeps the
  // sessionId stable, which lets us tell it apart from a /branch (sessionId also changes).
  // First mount: snapshot the current title without firing. Subsequent renders: fire only
  // when title actually changes AND sessionId is unchanged.
  const lastTitleRef = useRef<string>(tab.title);
  const lastSessionIdRef = useRef<string | undefined>(tab.sessionId);
  useEffect(() => {
    const prevTitle = lastTitleRef.current;
    const prevSessionId = lastSessionIdRef.current;
    lastTitleRef.current = tab.title;
    lastSessionIdRef.current = tab.sessionId;
    if (!prevTitle || prevTitle === tab.title) return;
    if (prevSessionId !== tab.sessionId) return; // /branch handles its own banner
    if (!tab.sessionId) return;
    if (renameNoticeTimerRef.current) window.clearTimeout(renameNoticeTimerRef.current);
    setRenameNotice({ oldTitle: prevTitle, newTitle: tab.title });
    renameNoticeTimerRef.current = window.setTimeout(() => setRenameNotice(null), 6000);
  }, [tab.title, tab.sessionId]);

  // The git panel is paired with the Claude experience (matches /branch + /rename detection,
  // commit history alongside session history, etc.). Raw shells are intentionally minimal —
  // no git panel, no polling, no header indicator.
  const isClaudeSession = (tab.shellMode || "claude") === "claude";

  // One-shot fetch when a Claude session attaches, so the activity-bar icon has data even
  // before the user opens the panel. Fires regardless of polling mode.
  useEffect(() => {
    if (!tab.projectPath || !isClaudeSession) return;
    fetchGitStatus();
  }, [tab.projectPath, isClaudeSession, tab.sessionId, fetchGitStatus]);

  // Continuous polling. In lazy mode (default), polling runs only while the panel is open —
  // so a closed panel is essentially free. In eager mode, it runs whenever the tab is the
  // active one. Raw shells skip this entirely; they don't have git chrome anywhere.
  useEffect(() => {
    if (!isActive || !tab.projectPath || !isClaudeSession) return;
    const shouldPoll = gitLazyPolling ? showGitPanel : true;
    if (!shouldPoll) return;
    fetchGitStatus();
    const interval = setInterval(fetchGitStatus, 3000);
    return () => clearInterval(interval);
  }, [isActive, tab.projectPath, gitLazyPolling, showGitPanel, isClaudeSession, fetchGitStatus]);

  // Drop stale stats whenever the underlying session changes (raw shell / no sessionId /
  // session swap via /branch). Polling itself only runs while active — but we keep the
  // last-seen values in state across activate/deactivate so switching tabs doesn't flash
  // an empty strip for the 4s until the next poll lands.
  useEffect(() => {
    if (!isClaudeSession || !tab.sessionId || !projectEncodedName) setSessionStats(null);
  }, [isClaudeSession, tab.sessionId, projectEncodedName]);

  // Poll session stats (cost, context tokens) while active. Cost ticks up as claude works,
  // so 4s feels live without hammering disk; the underlying Rust cache short-circuits when
  // mtimes haven't changed. Skipped entirely for raw shells and tabs without a sessionId.
  useEffect(() => {
    if (!isActive || !isClaudeSession || !tab.sessionId || !projectEncodedName) return;
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const sessions = await invoke<SessionInfo[]>("get_sessions", { encodedName: projectEncodedName });
        if (cancelled) return;
        const match = sessions.find(s => s.id === tab.sessionId);
        if (match) setSessionStats(match);
      } catch (_) {}
    };
    fetchStats();
    const interval = setInterval(fetchStats, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isActive, isClaudeSession, tab.sessionId, projectEncodedName]);

  // Poll every 5s, but only while this tab is the active (focused) one. Background tabs
  // don't scan — the user can't /branch in a tab they aren't looking at. On each tick we
  // ask Rust whether any jsonl has appeared in the project that (a) isn't in our known
  // set and (b) has the UUID fingerprint of a fork of our current session.
  useEffect(() => {
    if (!isActive) return;
    if (!tab.projectPath || !tab.sessionId) return;
    if ((tab.shellMode || "claude") !== "claude") return;
    checkBranch();
    const interval = window.setInterval(checkBranch, 5000);
    return () => window.clearInterval(interval);
  }, [isActive, tab.projectPath, tab.sessionId, tab.shellMode, checkBranch]);

  // Refresh commit history whenever the history section is opened, and when `ahead` changes
  // (likely a new local commit). Cheap enough to just re-fetch alongside normal polls too.
  useEffect(() => {
    if (!showGitPanel || !gitHistoryOpen) return;
    fetchGitLog();
  }, [showGitPanel, gitHistoryOpen, gitStatus?.ahead, gitStatus?.branch, fetchGitLog]);

  // Clear any pending highlight timer on unmount
  useEffect(() => () => { if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current); }, []);

  // Splitter drag — grow panel when dragging left
  const onSplitterDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = gitPanelWidth;
    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      setGitPanelWidth(Math.max(MIN_PANEL, Math.min(MAX_PANEL, startWidth + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [gitPanelWidth]);

  const stagedFiles = (gitStatus?.files || []).filter(f => f.staged !== " " && f.staged !== "?");
  const unstagedFiles = (gitStatus?.files || []).filter(f => f.unstaged !== " " && f.staged !== "?");
  const untrackedFiles = (gitStatus?.files || []).filter(f => f.staged === "?");
  const totalChanges = (gitStatus?.files.length) || 0;

  const gitCounts = [
    gitStatus?.ahead ? `↑${gitStatus.ahead} ahead` : null,
    gitStatus?.behind ? `↓${gitStatus.behind} behind` : null,
    totalChanges ? `${totalChanges} changes` : null,
  ].filter(Boolean).join(" · ");
  const gitButtonTooltip = `${showGitPanel ? "Hide" : "Show"} git panel — ${gitStatus?.branch || "detached"}${gitCounts ? ` (${gitCounts})` : ""}`;

  // Cost/context strip is only meaningful when xshell-stats has populated authoritative
  // numbers for this session AND the user hasn't opted out via the Connect tab toggle.
  // Without authoritative stats the cost would always be $0 and the bar empty — falls back
  // to the plain path in that case (or whenever the user has explicitly disabled the strip).
  const showStatsStrip = isClaudeSession && showTerminalHeaderStats && sessionStats?.is_authoritative_stats && sessionStats.context_limit > 0;
  const ctxPct = showStatsStrip ? Math.min(100, (sessionStats!.context_tokens / sessionStats!.context_limit) * 100) : 0;

  return (
    <div className="terminal-wrapper" onMouseLeave={hideTt}>
      <div className="terminal-header" data-tauri-drag-region>
        {tab.groupId && (
          <span className="terminal-header-label">
            {tab.projectName && <span className="terminal-header-project">{tab.projectName}</span>}
            {tab.projectName && tab.title && <span className="terminal-header-sep">·</span>}
            {tab.title && <span className="terminal-header-title">{tab.title}</span>}
          </span>
        )}
        {showStatsStrip ? (
          <div className="terminal-header-stats" data-tauri-drag-region>
            <span className="terminal-ctx-label" data-tauri-drag-region>Context:</span>
            <div className={`terminal-ctx-bar terminal-ctx-${ctxLevel(ctxPct)}`} data-tauri-drag-region>
              <span className="terminal-ctx-fill" style={{ width: `${ctxPct}%` }} />
            </div>
            <span className="terminal-ctx-pct" data-tauri-drag-region>{ctxPct.toFixed(0)}%</span>
            <span className="terminal-ctx-label" data-tauri-drag-region>Cost:</span>
            <span className="terminal-ctx-cost" data-tauri-drag-region>{formatCost(sessionStats!.cost_usd)}</span>
          </div>
        ) : tab.projectPath ? (
          <span className="terminal-header-path" data-tauri-drag-region>{tab.projectPath}</span>
        ) : null}
      </div>
      {branchNotice && (
        <div className="branch-banner">
          <GitFork size={13} className="branch-banner-icon" />
          <span className="branch-banner-text">
            <span className="branch-banner-lead">Branch detected — switched from</span>
            <span className="branch-banner-title">{branchNotice.oldTitle}</span>
            <span className="branch-banner-lead">to</span>
            <span className="branch-banner-title">{branchNotice.newTitle}</span>
          </span>
          <button className="branch-banner-btn" onClick={dismissBranchNotice} aria-label="Dismiss"><XIcon size={12} /></button>
        </div>
      )}
      {renameNotice && (
        <div className="branch-banner">
          <Pencil size={13} className="branch-banner-icon" />
          <span className="branch-banner-text">
            <span className="branch-banner-lead">Rename detected — renamed from</span>
            <span className="branch-banner-title">{renameNotice.oldTitle}</span>
            <span className="branch-banner-lead">to</span>
            <span className="branch-banner-title">{renameNotice.newTitle}</span>
          </span>
          <button className="branch-banner-btn" onClick={dismissRenameNotice} aria-label="Dismiss"><XIcon size={12} /></button>
        </div>
      )}
      <div className="terminal-body">
        <div className="terminal-container" ref={containerRef} style={{ background: paletteFor(theme, terminalBgColor).background }}>
          {isInitializing && (
            <div className="terminal-loading-overlay">
              <div className="spinner" />
              <span>{isClaudeSession ? "Starting Claude…" : "Starting shell…"}</span>
            </div>
          )}
        </div>
        {isClaudeSession && showGitPanel && gitStatus?.is_repo && (
          <>
            <div className="terminal-splitter" onPointerDown={onSplitterDown} onMouseEnter={(e) => showTt("Drag to resize", e.currentTarget)} onMouseLeave={hideTt} />
            <div className="terminal-side-panel" style={{ width: gitPanelWidth }}>
              <div className="git-panel-header">
                <GitBranch size={12} />
                <button
                  className={`git-panel-branch-btn ${branchDropdown ? "open" : ""}`}
                  onClick={(e) => { const el = e.currentTarget as HTMLElement; setBranchDropdown(prev => prev ? null : { rect: el.getBoundingClientRect(), el }); }}
                  onMouseEnter={(e) => showTt("Switch branch", e.currentTarget)}
                  onMouseLeave={hideTt}
                  disabled={checkoutInFlight}
                >
                  <span className="git-panel-branch">{gitStatus.branch || "detached"}</span>
                  <ChevronDown size={13} className="git-panel-branch-chev" />
                </button>
                {gitStatus.ahead > 0 && <span className="git-panel-ab" onMouseEnter={(e) => showTt(`${gitStatus.ahead} commit(s) ahead of remote`, e.currentTarget)} onMouseLeave={hideTt}><ArrowUp size={10} />{gitStatus.ahead}</span>}
                {gitStatus.behind > 0 && <span className="git-panel-ab" onMouseEnter={(e) => showTt(`${gitStatus.behind} commit(s) behind remote`, e.currentTarget)} onMouseLeave={hideTt}><ArrowDown size={10} />{gitStatus.behind}</span>}
                <button className={`git-panel-refresh ${gitRefreshing ? "spinning" : ""}`} onClick={fetchGitStatus} onMouseEnter={(e) => showTt("Refresh now", e.currentTarget)} onMouseLeave={hideTt}><RefreshCw size={11} /></button>
              </div>
              {checkoutError && (
                <div className="branch-error-banner">
                  <AlertTriangle size={11} className="branch-error-icon" />
                  <span className="branch-error-text">{checkoutError}</span>
                  <button className="branch-error-dismiss" onClick={dismissCheckoutError} aria-label="Dismiss"><XIcon size={11} /></button>
                </div>
              )}
              <div className="git-panel-scroll">
                {totalChanges === 0 && <div className="git-panel-empty">Working tree clean</div>}
                {stagedFiles.length > 0 && <GitSection label="Staged" files={stagedFiles} column="staged" filenamesOnly={gitPanelFilenamesOnly} highlightedPaths={recentlyChangedPaths} onStage={handleStageFile} onUnstage={handleUnstageFile} showTt={showTt} hideTt={hideTt} />}
                {unstagedFiles.length > 0 && <GitSection label="Changes" files={unstagedFiles} column="unstaged" filenamesOnly={gitPanelFilenamesOnly} highlightedPaths={recentlyChangedPaths} onStage={handleStageFile} onUnstage={handleUnstageFile} showTt={showTt} hideTt={hideTt} />}
                {untrackedFiles.length > 0 && <GitSection label="Untracked" files={untrackedFiles} column="untracked" filenamesOnly={gitPanelFilenamesOnly} highlightedPaths={recentlyChangedPaths} onStage={handleStageFile} onUnstage={handleUnstageFile} showTt={showTt} hideTt={hideTt} />}
                <GitHistorySection open={gitHistoryOpen} commits={gitCommits} onToggle={() => setGitHistoryOpen(v => !v)} showTt={showTt} hideTt={hideTt} />
              </div>
            </div>
          </>
        )}
        {/* Activity bar — claude-only, persistent. Currently hosts the git toggle; future
            slots (file explorer, search, etc) will land here too. Disabled-but-visible when
            the panel feature is off or the cwd isn't a git repo, so the bar's column doesn't
            jump in/out as the user switches tabs. */}
        {isClaudeSession && (
          <div className="terminal-activity-bar">
            {(() => {
              const gitDisabled = !gitStatus?.is_repo;
              const tip = gitDisabled ? "Not a git repository" : gitButtonTooltip;
              return (
                <button
                  className={`terminal-activity-btn ${showGitPanel ? "active" : ""}`}
                  disabled={gitDisabled}
                  onClick={() => { if (gitDisabled) return; setShowGitPanel(v => !v); if (!showGitPanel) fetchGitStatus(); hideTt(); }}
                  onMouseEnter={(e) => showTt(tip, e.currentTarget)}
                  onMouseLeave={hideTt}
                  aria-label="Toggle git panel"
                >
                  <GitBranch size={15} />
                  {!gitDisabled && totalChanges > 0 && <span className="terminal-activity-badge">{totalChanges > 99 ? "99+" : totalChanges}</span>}
                </button>
              );
            })()}
          </div>
        )}
      </div>
      {tooltip && <TerminalTooltip text={tooltip.text} rect={tooltip.rect} />}
      {branchDropdown && tab.projectPath && gitStatus && (
        <BranchDropdown
          cwd={tab.projectPath}
          currentBranch={gitStatus.branch}
          dirty={(gitStatus.files?.length || 0) > 0}
          busy={checkoutInFlight}
          panelWidth={gitPanelWidth}
          anchorRect={branchDropdown.rect}
          anchorEl={branchDropdown.el}
          onPick={handleCheckout}
          onClose={() => setBranchDropdown(null)}
        />
      )}
    </div>
  );
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function GitSection({ label, files, column, filenamesOnly, highlightedPaths, onStage, onUnstage, showTt, hideTt }: { label: string; files: GitFile[]; column: "staged" | "unstaged" | "untracked"; filenamesOnly: boolean; highlightedPaths: Set<string>; onStage: (path: string) => void; onUnstage: (path: string) => void; showTt: (text: string, el: HTMLElement) => void; hideTt: () => void }) {
  const isStagedCol = column === "staged";
  return (
    <div className="git-section">
      <div className="git-section-header"><span>{label}</span><span className="git-section-count">{files.length}</span></div>
      {files.map((f, i) => {
        const ch = isStagedCol ? f.staged : column === "unstaged" ? f.unstaged : "?";
        const postRename = f.path.includes(" -> ") ? f.path.split(" -> ").pop()! : f.path;
        const displayName = filenamesOnly ? basename(postRename) : postRename;
        const statusName: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked", "?": "Untracked" };
        const tipText = `${statusName[ch] || "Changed"} — ${f.path}`;
        const highlighted = highlightedPaths.has(f.path);
        return (
          <div key={i} className={`git-file ${highlighted ? "git-file-blink" : ""}`} onMouseEnter={(e) => showTt(tipText, e.currentTarget)} onMouseLeave={hideTt}>
            <span className={`git-file-status gs-${ch === "?" ? "U" : ch}`}>{ch === "?" ? "U" : ch.trim() || " "}</span>
            <span className="git-file-path" title={filenamesOnly ? f.path : undefined}>{displayName}</span>
            {isStagedCol ? (
              <button className="git-file-action" onClick={(e) => { e.stopPropagation(); onUnstage(postRename); }} onMouseEnter={(ev) => showTt("Unstage", ev.currentTarget)} onMouseLeave={hideTt} aria-label="Unstage"><Minus size={11} /></button>
            ) : (
              <button className="git-file-action" onClick={(e) => { e.stopPropagation(); onStage(postRename); }} onMouseEnter={(ev) => showTt("Stage", ev.currentTarget)} onMouseLeave={hideTt} aria-label="Stage"><Plus size={11} /></button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GitHistorySection({ open, commits, onToggle, showTt, hideTt }: { open: boolean; commits: GitCommit[]; onToggle: () => void; showTt: (text: string, el: HTMLElement) => void; hideTt: () => void }) {
  return (
    <div className="git-section git-history-section">
      <div className={`git-section-header git-history-header ${open ? "open" : ""}`} onClick={onToggle}>
        <ChevronRight size={11} className={`git-history-chev ${open ? "open" : ""}`} />
        <History size={11} />
        <span>History</span>
        {open && commits.length > 0 && <span className="git-section-count">{commits.length}</span>}
      </div>
      {open && (
        <div className="git-history-list">
          {commits.length === 0 && <div className="git-history-empty">No commits</div>}
          {commits.map((c) => (
            <div key={c.hash} className="git-commit" onMouseEnter={(e) => showTt(`${c.short_hash} · ${c.author} · ${c.relative_time}`, e.currentTarget)} onMouseLeave={hideTt}>
              <span className="git-commit-hash">{c.short_hash}</span>
              <span className="git-commit-subject">{c.subject}</span>
              <span className="git-commit-time">{c.relative_time}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Branch picker — opens from the branch chip in the panel header. Lists local branches
// first (most-recent committerdate at the top), then a "Remote-only" section for refs
// under refs/remotes/* that have no matching local branch yet (clicking those uses git's
// DWIM checkout to create a tracking branch). Search filters by name.
function BranchDropdown({ cwd, currentBranch, dirty, busy, panelWidth, anchorRect, anchorEl, onPick, onClose }: { cwd: string; currentBranch: string; dirty: boolean; busy: boolean; panelWidth: number; anchorRect: DOMRect; anchorEl: HTMLElement; onPick: (branch: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [branches, setBranches] = useState<GitBranchEntry[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    invoke<GitBranchEntry[]>("list_git_branches", { cwd })
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [cwd]);

  // Click-outside / Escape close. Ignore clicks on the anchor itself so toggling works.
  useEffect(() => {
    const handle = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", handle, true);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("pointerdown", handle, true); document.removeEventListener("keydown", handleKey); };
  }, [onClose, anchorEl]);

  // Build the two sections. A remote ref is "covered" when there's already a local branch
  // with the matching short name — those are redundant rows, so we drop them.
  const filtered = (branches || []).filter(b => !query.trim() || b.name.toLowerCase().includes(query.trim().toLowerCase()));
  const localBranches = filtered.filter(b => !b.is_remote);
  const localNames = new Set(localBranches.map(b => b.name));
  const remoteOnly = filtered.filter(b => b.is_remote && !localNames.has(b.name.replace(/^[^/]+\//, "")));

  // Position: right-anchor to the chip so the dropdown grows leftward into the terminal
  // area rather than clipping past the window's right edge (the git panel itself is already
  // near that edge). Open downward by default; flip upward when there's no room below.
  // Width = max(default, current panel width) so a user who's resized the panel wide gets
  // a dropdown that lines up with it instead of looking thin and offset.
  const dropdownHeight = 360; // matches max-height in CSS
  const dropdownWidth = Math.max(320, panelWidth);
  const opensUp = anchorRect.bottom + dropdownHeight + 8 > window.innerHeight && anchorRect.top > dropdownHeight;
  const right = Math.max(8, window.innerWidth - anchorRect.right);
  // Keep the dropdown fully on-screen if the chip is so close to the left edge that
  // right-anchoring would push it off-screen. In that case fall back to left-anchoring.
  const wouldOverflowLeft = window.innerWidth - right - dropdownWidth < 8;
  const horizontal: React.CSSProperties = wouldOverflowLeft
    ? { left: Math.max(8, window.innerWidth - dropdownWidth - 8) }
    : { right };
  const positionStyle: React.CSSProperties = {
    ...horizontal,
    width: dropdownWidth,
    ...(opensUp ? { bottom: window.innerHeight - anchorRect.top + 4 } : { top: anchorRect.bottom + 4 }),
  };

  return (
    <div className="branch-dropdown" ref={ref} style={positionStyle}>
      <div className="branch-dropdown-search">
        <Search size={11} className="branch-dropdown-search-icon" />
        <input autoFocus className="branch-dropdown-search-input" placeholder="Switch to…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {dirty && (
        <div className="branch-dropdown-warn">
          <AlertTriangle size={11} />
          <span>You have uncommitted changes</span>
        </div>
      )}
      <div className="branch-dropdown-scroll">
        {branches === null && <div className="branch-dropdown-loading"><div className="spinner-small" /></div>}
        {branches !== null && filtered.length === 0 && <div className="branch-dropdown-empty">No matches</div>}
        {localBranches.length > 0 && (
          <>
            <div className="branch-dropdown-section">Local</div>
            {localBranches.map(b => (
              <div key={b.full_ref} className={`branch-dropdown-item ${b.is_current ? "current" : ""} ${busy ? "busy" : ""}`} onClick={() => { if (!b.is_current && !busy) onPick(b.name); }}>
                <span className="branch-dropdown-check">{b.is_current ? <Check size={11} /> : <GitBranch size={11} />}</span>
                <div className="branch-dropdown-text">
                  <span className="branch-dropdown-name">{b.name}</span>
                  {b.last_commit_subject && <span className="branch-dropdown-sub">{b.last_commit_subject}</span>}
                </div>
                <span className="branch-dropdown-time">{b.last_commit_relative}</span>
              </div>
            ))}
          </>
        )}
        {remoteOnly.length > 0 && (
          <>
            <div className="branch-dropdown-section">Remote-only</div>
            {remoteOnly.map(b => (
              <div key={b.full_ref} className={`branch-dropdown-item ${busy ? "busy" : ""}`} onClick={() => { if (!busy) onPick(b.name); }}>
                <span className="branch-dropdown-check"><Cloud size={11} /></span>
                <div className="branch-dropdown-text">
                  <span className="branch-dropdown-name">{b.name}</span>
                  {b.last_commit_subject && <span className="branch-dropdown-sub">{b.last_commit_subject}</span>}
                </div>
                <span className="branch-dropdown-time">{b.last_commit_relative}</span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="branch-dropdown-foot">on <span className="branch-dropdown-foot-current">{currentBranch || "detached"}</span></div>
    </div>
  );
}
