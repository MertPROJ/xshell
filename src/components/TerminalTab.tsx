import { useEffect, useRef, useState, useCallback, useLayoutEffect, useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { invoke, Channel } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { GitBranch, ArrowUp, ArrowDown, RefreshCw, ChevronRight, ChevronDown, Plus, Minus, History, GitFork, Pencil, X as XIcon, Check, Search, AlertTriangle, Cloud, FolderTree, FileDiff, RotateCcw } from "lucide-react";
import { FileExplorerPanel, DRAG_PATH_MIME } from "./FileExplorerPanel";
import { fileIconUrl, plainFolderIconUrl } from "../lib/fileIcons";
import "@xterm/xterm/css/xterm.css";
import { detectMonoFontFamily, ensureMonoFontsLoaded } from "../lib/fonts";
import type { Tab, GitStatus, GitFile, GitCommit, BranchInfo, SessionInfo, GitBranch as GitBranchEntry } from "../types";
import { getShellById } from "../shells";
import { AGENTS } from "../agents";
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
  gitChangesTree: boolean;
  fileExplorerOnStart: boolean;
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
const DEFAULT_PANEL = 280;
// Leave room for the activity bar (32) + splitter (4) + a thin terminal sliver (~40) when the
// panel is dragged to its widest, so it can cover almost the whole terminal but stay grabbable.
const PANEL_EDGE_RESERVE = 76;

export function TerminalTab({ tab, isActive, gitLazyPolling, gitChangesTree, fileExplorerOnStart, terminalBgColor, defaultFontSize, defaultShellId, fullscreenRendering, forceSyncOutput, webglRendering, terminalFontWeight, eagerInit, theme, projectEncodedName, showTerminalHeaderStats, onBranchSwitch }: TerminalTabProps) {
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
  // The git and file-explorer panels share one slot on the right — only one is open at a
  // time (VS Code-style). Width is shared too, so resizing one carries over to the other.
  // Initial open is driven only by the "open file explorer on start" setting (claude tabs);
  // the git panel never auto-opens — it opens when the user clicks its activity-bar button.
  const openExplorerByDefault = fileExplorerOnStart && (tab.shellMode || "claude") === "claude";
  const [showFilePanel, setShowFilePanel] = useState(openExplorerByDefault);
  // Once the file explorer is opened we keep it mounted (just hidden) for the life of the tab,
  // so its browsed path + expansion state survive toggling the panel and switching tabs —
  // resetting only when the tab is closed or the app restarts. Lazy: nothing mounts until the
  // user opens it the first time (or it opens on start), so tabs that never use it pay nothing.
  const [fileExplorerMounted, setFileExplorerMounted] = useState(openExplorerByDefault);
  const [gitPanelWidth, setGitPanelWidth] = useState(DEFAULT_PANEL);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [gitRefreshing, setGitRefreshing] = useState(false);
  // The git panel's bottom area is a Diff/History tab pair. History shows by default; clicking
  // a changed file in the status list switches to Diff and loads that file's diff.
  // Top-level git-panel tabs: "changes" (file list + diff) and "history" (commit log).
  const [panelTab, setPanelTab] = useState<"changes" | "history">("changes");
  const [selectedDiff, setSelectedDiff] = useState<{ path: string; mode: DiffMode } | null>(null);
  // User-resizable height (px) of the bottom Diff/History panel — dragged via the splitter
  // between it and the changes list above.
  const [gitBottomHeight, setGitBottomHeight] = useState(300);
  // Bumped on every git-status fetch so an open diff re-pulls and reflects fresh edits.
  const [gitTick, setGitTick] = useState(0);
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

  // Delayed-tooltip variant for git-change rows — like the file explorer, it waits ~1s so the
  // hint ("Click to show diff") doesn't flicker as the cursor scans the list.
  const ttTimerRef = useRef<number | null>(null);
  const showTtDelayed = useCallback((text: string, el: HTMLElement) => {
    if (ttTimerRef.current) window.clearTimeout(ttTimerRef.current);
    ttTimerRef.current = window.setTimeout(() => showTt(text, el), 1000);
  }, [showTt]);
  const hideTtNow = useCallback(() => { if (ttTimerRef.current) window.clearTimeout(ttTimerRef.current); hideTt(); }, [hideTt]);
  useEffect(() => () => { if (ttTimerRef.current) window.clearTimeout(ttTimerRef.current); }, []);

  // Right-click context menu over a git change row (Show diff / Stage·Unstage / Discard).
  const [gitCtx, setGitCtx] = useState<{ x: number; y: number; column: DiffMode; postRename: string; confirmDiscard?: boolean } | null>(null);
  const openGitCtx = useCallback((x: number, y: number, column: DiffMode, postRename: string) => setGitCtx({ x, y, column, postRename }), []);
  useEffect(() => {
    if (!gitCtx) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setGitCtx(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gitCtx]);

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

    // Rendering tactic: a real programming font (bundled JetBrains Mono, or an installed
    // Nerd Font if present) at NORMAL line-height. The old Consolas + lineHeight:1.3 combo was
    // what squeezed/misaligned the Claude Code logo and status-line glyphs — Consolas lacks the
    // special glyphs and 1.3 stretched every cell 30% taller. No lineHeight here == xterm's
    // default 1.0, so block/pixel art lands on a correct cell aspect ratio.
    const term = new Terminal({
      theme: paletteFor(theme, terminalBgColor),
      fontFamily: detectMonoFontFamily(),
      fontWeight: terminalFontWeight,
      fontWeightBold: Math.min(MAX_FONT_WEIGHT, terminalFontWeight + BOLD_OFFSET),
      fontSize: defaultFontSizeRef.current,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      scrollback: 10000,
      allowProposedApi: true,
      minimumContrastRatio: 1,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // Unicode 11 width tables. xterm defaults to Unicode v6, which gets the cell width of
    // emoji and many wide chars wrong (status-line icons like 📁, box drawing, CJK) — so text
    // after them shifts and TUI layouts misalign. Activating v11 makes widths correct, which
    // is exactly what Claude Code's emoji/glyph-heavy UI needs. Set before the first fit so
    // column math uses the right widths.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

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
    // Gate the first fit on the bundled font being ready too — measuring the cell against a
    // fallback metric and then swapping to JetBrains Mono would resize claude's TUI mid-boot.
    Promise.all([loadZoom(tabRef.current.id, defaultFontSizeRef.current), ensureMonoFontsLoaded()]).then(([size]) => {
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

    // Right-click = paste clipboard into terminal (like Windows Terminal / gnome-terminal).
    // Claude Code handles right-click paste itself (it enables mouse reporting, so xterm
    // forwards the click and Claude reads the clipboard — including images). Doing our own
    // write_terminal too would paste twice, so we only paste manually for raw shells, which
    // don't paste on right-click on their own. We still preventDefault everywhere to suppress
    // the browser context menu.
    const onContextMenu = async (ev: MouseEvent) => {
      ev.preventDefault();
      if ((tabRef.current.shellMode || "claude") === "claude") return;
      try {
        const text = await navigator.clipboard.readText();
        if (text) invoke("write_terminal", { id: tabRef.current.id, data: text }).catch(() => {});
      } catch (_) {}
    };
    containerRef.current.addEventListener("contextmenu", onContextMenu);

    async function spawnBackend(term: Terminal, _fitAddon: FitAddon) {
      const id = tabRef.current.id;

      // Transport: PTY output arrives as RAW BYTES over a Tauri Channel
      // (binary ArrayBuffer, no JSON event + no utf8-lossy round-trip), pre-coalesced on the
      // Rust side into whole-frame chunks. Feeding term.write a Uint8Array lets xterm's parser
      // reassemble multibyte sequences across chunk boundaries — eliminating the partial-frame
      // "flying letters" the old per-4KB `emit` produced.
      const onData = new Channel<ArrayBuffer>();
      onData.onmessage = (buf) => {
        if (!sawFirstOutputRef.current) {
          sawFirstOutputRef.current = true;
          setIsInitializing(false);
        }
        term.write(new Uint8Array(buf));
      };

      const onExit = new Channel<number>();
      onExit.onmessage = () => {
        // Spawn failed before any output (e.g. claude not on PATH) — drop the loader so
        // the error message we're about to write isn't hidden behind it.
        if (!sawFirstOutputRef.current) {
          sawFirstOutputRef.current = true;
          setIsInitializing(false);
        }
        term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      };

      const onDataDisposable = term.onData((data) => {
        invoke("write_terminal", { id, data }).catch(() => {});
      });

      // Debounce the PTY resize (SIGWINCH). xterm reflows visually on every fit(), but Claude
      // (Ink) does a FULL redraw on each SIGWINCH — so firing one per animation frame while the
      // user drags the git-panel splitter or resizes the window causes a redraw storm. We let
      // fit() reflow xterm live for instant feedback, but coalesce the actual PTY resize to a
      // single call ~150ms after the drag settles.
      let resizeTimer: number | undefined;
      const onResizeDisposable = term.onResize(({ cols, rows }) => {
        if (resizeTimer) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = undefined;
          invoke("resize_terminal", { id, cols, rows }).catch(() => {});
        }, 150);
      });

      try {
        const shellMode = tabRef.current.shellMode || "claude";
        // Raw shells always use the tab's explicit shellId. Claude sessions fall back to the
        // user's default shell setting, so claude runs under the shell the user picked.
        const effectiveShellId = tabRef.current.shellId || (shellMode === "claude" ? defaultShellId : null);
        const shellCommand = effectiveShellId ? (getShellById(effectiveShellId)?.command || null) : null;
        await invoke("spawn_terminal", { id, sessionId: tabRef.current.sessionId || null, cwd: tabRef.current.projectPath || ".", cols: term.cols, rows: term.rows, shellMode, shellCommand, shellId: effectiveShellId, agent: tabRef.current.agent || null, fullscreenRendering, forceSyncOutput, onData, onExit });
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
          term.write(`\x1b[90mMake sure '${AGENTS[tabRef.current.agent || "claude"].binary}' is installed and available in your PATH.\x1b[0m\r\n`);
        }
      }

      (term as any)._cleanup = () => {
        // Channels have no explicit unsubscribe — dropping the handler stops processing, and
        // close_terminal tears down the PTY (and thus the Rust side of the channel).
        onData.onmessage = () => {};
        onExit.onmessage = () => {};
        if (resizeTimer) window.clearTimeout(resizeTimer);
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

  // Refit terminal whenever either side panel opens/closes or the shared width changes
  useEffect(() => {
    if (!fitAddonRef.current) return;
    requestAnimationFrame(() => fitAddonRef.current?.fit());
  }, [showGitPanel, showFilePanel, gitPanelWidth]);

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
      setGitTick(t => t + 1); // nudge the open diff to re-pull (catches edits to the shown file)
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

  // Bulk stage/unstage — the +/- button on a section header stages (or unstages) every file in it.
  const handleStageAll = useCallback(async (paths: string[]) => {
    if (!tab.projectPath || paths.length === 0) return;
    try { await invoke("git_stage", { cwd: tab.projectPath, paths }); } catch (_) {}
    fetchGitStatus();
  }, [tab.projectPath, fetchGitStatus]);

  const handleUnstageAll = useCallback(async (paths: string[]) => {
    if (!tab.projectPath || paths.length === 0) return;
    try { await invoke("git_unstage", { cwd: tab.projectPath, paths }); } catch (_) {}
    fetchGitStatus();
  }, [tab.projectPath, fetchGitStatus]);

  // Discard a file's changes (destructive — the context menu confirms first). Section-scoped:
  // unstaged drops only the working-tree edits (keeps staged), staged reverts to HEAD, untracked
  // deletes. Clears the diff selection if it was that file.
  const handleDiscardFile = useCallback(async (path: string, mode: DiffMode) => {
    if (!tab.projectPath) return;
    try { await invoke("git_discard", { cwd: tab.projectPath, path, mode }); } catch (_) {}
    setSelectedDiff(prev => (prev && prev.path === path ? null : prev));
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

  // Refresh commit history whenever the History tab is shown, and when `ahead` changes
  // (likely a new local commit). Cheap enough to just re-fetch alongside normal polls too.
  useEffect(() => {
    if (!showGitPanel || panelTab !== "history") return;
    fetchGitLog();
  }, [showGitPanel, panelTab, gitStatus?.ahead, gitStatus?.branch, fetchGitLog]);

  // Click a file in the status list → show its diff in the Diff tab.
  const selectDiff = useCallback((path: string, mode: DiffMode) => { setSelectedDiff({ path, mode }); setPanelTab("changes"); }, []);

  // Clear any pending highlight timer on unmount
  useEffect(() => () => { if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current); }, []);

  // Splitter drag — grow panel when dragging left
  const onSplitterDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = gitPanelWidth;
    // Cap to the available body width so the panel can stretch across (almost) the whole terminal.
    const bodyWidth = e.currentTarget.parentElement?.clientWidth ?? window.innerWidth;
    const maxPanel = Math.max(MIN_PANEL, bodyWidth - PANEL_EDGE_RESERVE);
    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      setGitPanelWidth(Math.max(MIN_PANEL, Math.min(maxPanel, startWidth + delta)));
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

  // Vertical splitter between the changes list and the Diff/History panel — drag up = taller.
  const onGitBottomSplitterDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = gitBottomHeight;
    // Clamp against the actual panel height so the diff/history area can be dragged from a thin
    // sliver up to nearly the whole panel (leaving the header + a couple of changes rows).
    const panelH = e.currentTarget.parentElement?.clientHeight ?? window.innerHeight;
    const maxH = Math.max(80, panelH - 90);
    const onMove = (ev: PointerEvent) => setGitBottomHeight(Math.max(60, Math.min(maxH, startH + (startY - ev.clientY))));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [gitBottomHeight]);

  const stagedFiles = (gitStatus?.files || []).filter(f => f.staged !== " " && f.staged !== "?");
  const unstagedFiles = (gitStatus?.files || []).filter(f => f.unstaged !== " " && f.staged !== "?");
  const untrackedFiles = (gitStatus?.files || []).filter(f => f.staged === "?");
  const totalChanges = (gitStatus?.files.length) || 0;

  // On opening the git panel (fresh terminal / after restart), default to showing the first
  // change's diff — pick the first file in display order (Staged → Changes → Untracked) when
  // nothing is selected yet. Leaves an existing selection alone.
  useEffect(() => {
    if (!showGitPanel || selectedDiff) return;
    const first = stagedFiles[0] || unstagedFiles[0] || untrackedFiles[0];
    if (!first) return;
    const mode: DiffMode = first.staged === "?" ? "untracked" : first.staged !== " " ? "staged" : "unstaged";
    const postRename = first.path.includes(" -> ") ? first.path.split(" -> ").pop()! : first.path;
    setSelectedDiff({ path: postRename, mode });
    setPanelTab("changes");
  }, [showGitPanel, selectedDiff, stagedFiles, unstagedFiles, untrackedFiles]);

  const gitCounts = [
    gitStatus?.ahead ? `↑${gitStatus.ahead} ahead` : null,
    gitStatus?.behind ? `↓${gitStatus.behind} behind` : null,
    totalChanges ? `${totalChanges} changes` : null,
  ].filter(Boolean).join(" · ");
  const gitButtonTooltip = `${showGitPanel ? "Hide" : "Show"} git panel — ${gitStatus?.branch || "detached"}${gitCounts ? ` (${gitCounts})` : ""}`;

  // Cost/context strip is only meaningful when xshell-stats has populated authoritative
  // numbers for this session AND the user hasn't opted out via the Agents tab toggle.
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
        <div
          className="terminal-container"
          ref={containerRef}
          style={{ background: paletteFor(theme, terminalBgColor).background }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_PATH_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
          onDrop={(e) => {
            const p = e.dataTransfer.getData(DRAG_PATH_MIME) || e.dataTransfer.getData("text/plain");
            if (!p) return;
            e.preventDefault();
            // Quote paths with spaces (common on Windows); trailing space lets the user keep typing.
            invoke("write_terminal", { id: tab.id, data: /\s/.test(p) ? `"${p}" ` : `${p} ` }).catch(() => {});
            terminalRef.current?.focus();
          }}
        >
          {isInitializing && (
            <div className="terminal-loading-overlay">
              <div className="spinner" />
              <span>{isClaudeSession ? `Starting ${AGENTS[tab.agent || "claude"].label}…` : "Starting shell…"}</span>
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
              <div className="git-tabs">
                <button className={`git-tab ${panelTab === "changes" ? "active" : ""}`} onClick={() => setPanelTab("changes")}>
                  <FileDiff size={12} /><span>Changes</span>
                </button>
                <button className={`git-tab ${panelTab === "history" ? "active" : ""}`} onClick={() => setPanelTab("history")}>
                  <History size={12} /><span>History</span>
                </button>
              </div>
              {panelTab === "changes" ? (
                <>
                  <div className="git-panel-scroll git-status-scroll">
                    {totalChanges === 0 && <div className="git-panel-empty">Working tree clean</div>}
                    {stagedFiles.length > 0 && <GitSection label="Staged" files={stagedFiles} column="staged" tree={gitChangesTree} highlightedPaths={recentlyChangedPaths} selectedPath={selectedDiff?.path ?? null} selectedColumn={selectedDiff?.mode ?? null} activePath={gitCtx?.postRename ?? null} activeColumn={gitCtx?.column ?? null} onSelect={selectDiff} onStage={handleStageFile} onUnstage={handleUnstageFile} onStageAll={handleStageAll} onUnstageAll={handleUnstageAll} onContext={openGitCtx} showTt={showTtDelayed} hideTt={hideTtNow} />}
                    {unstagedFiles.length > 0 && <GitSection label="Changes" files={unstagedFiles} column="unstaged" tree={gitChangesTree} highlightedPaths={recentlyChangedPaths} selectedPath={selectedDiff?.path ?? null} selectedColumn={selectedDiff?.mode ?? null} activePath={gitCtx?.postRename ?? null} activeColumn={gitCtx?.column ?? null} onSelect={selectDiff} onStage={handleStageFile} onUnstage={handleUnstageFile} onStageAll={handleStageAll} onUnstageAll={handleUnstageAll} onContext={openGitCtx} showTt={showTtDelayed} hideTt={hideTtNow} />}
                    {untrackedFiles.length > 0 && <GitSection label="Untracked" files={untrackedFiles} column="untracked" tree={gitChangesTree} highlightedPaths={recentlyChangedPaths} selectedPath={selectedDiff?.path ?? null} selectedColumn={selectedDiff?.mode ?? null} activePath={gitCtx?.postRename ?? null} activeColumn={gitCtx?.column ?? null} onSelect={selectDiff} onStage={handleStageFile} onUnstage={handleUnstageFile} onStageAll={handleStageAll} onUnstageAll={handleUnstageAll} onContext={openGitCtx} showTt={showTtDelayed} hideTt={hideTtNow} />}
                  </div>
                  <div className="git-hsplitter" onPointerDown={onGitBottomSplitterDown} onMouseEnter={(e) => showTt("Drag to resize", e.currentTarget)} onMouseLeave={hideTt} />
                  <div className="git-bottom" style={{ height: gitBottomHeight }}>
                    <div className="git-tab-body">
                      <DiffView cwd={tab.projectPath || "."} file={selectedDiff} version={gitTick} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="git-tab-body">
                  <GitHistoryList commits={gitCommits} showTt={showTt} hideTt={hideTt} />
                </div>
              )}
            </div>
          </>
        )}
        {isClaudeSession && tab.projectPath && fileExplorerMounted && (
          // Kept mounted once opened (toggled with `display`, not unmounted) so the explorer's
          // path + expansion state persist across panel toggles and tab switches.
          <>
            <div className="terminal-splitter" style={{ display: showFilePanel ? undefined : "none" }} onPointerDown={onSplitterDown} onMouseEnter={(e) => showTt("Drag to resize", e.currentTarget)} onMouseLeave={hideTt} />
            <div className="terminal-side-panel" style={{ width: gitPanelWidth, display: showFilePanel ? undefined : "none" }}>
              <FileExplorerPanel rootPath={tab.projectPath} terminalId={tab.id} visible={showFilePanel} showTt={showTt} hideTt={hideTt} />
            </div>
          </>
        )}
        {/* Activity bar — claude-only, persistent. Hosts the git + file-explorer toggles; the
            two panels share one slot (opening one closes the other). The git button is
            disabled-but-visible when the cwd isn't a repo, so the bar's column doesn't jump
            in/out as the user switches tabs. */}
        {isClaudeSession && (
          <div className="terminal-activity-bar">
            {(() => {
              const gitDisabled = !gitStatus?.is_repo;
              const tip = gitDisabled ? "Not a git repository" : gitButtonTooltip;
              return (
                <button
                  className={`terminal-activity-btn ${showGitPanel ? "active" : ""}`}
                  disabled={gitDisabled}
                  onClick={() => { if (gitDisabled) return; setShowFilePanel(false); setShowGitPanel(v => !v); if (!showGitPanel) fetchGitStatus(); hideTt(); }}
                  onMouseEnter={(e) => showTt(tip, e.currentTarget)}
                  onMouseLeave={hideTt}
                  aria-label="Toggle git panel"
                >
                  <GitBranch size={15} />
                  {!gitDisabled && totalChanges > 0 && <span className="terminal-activity-badge">{totalChanges > 99 ? "99+" : totalChanges}</span>}
                </button>
              );
            })()}
            <button
              className={`terminal-activity-btn ${showFilePanel ? "active" : ""}`}
              disabled={!tab.projectPath}
              onClick={() => { if (!tab.projectPath) return; setShowGitPanel(false); setFileExplorerMounted(true); setShowFilePanel(v => !v); hideTt(); }}
              onMouseEnter={(e) => showTt(`${showFilePanel ? "Hide" : "Show"} file explorer`, e.currentTarget)}
              onMouseLeave={hideTt}
              aria-label="Toggle file explorer"
            >
              <FolderTree size={15} />
            </button>
          </div>
        )}
      </div>
      {tooltip && <TerminalTooltip text={tooltip.text} rect={tooltip.rect} />}
      {gitCtx && (
        <>
          <div className="file-ctx-backdrop" onClick={() => setGitCtx(null)} onContextMenu={(e) => { e.preventDefault(); setGitCtx(null); }} />
          <div className="file-ctx-menu" style={{ left: Math.min(gitCtx.x, window.innerWidth - 230), top: Math.min(gitCtx.y, window.innerHeight - 150) }}>
            {gitCtx.confirmDiscard ? (
              <>
                <div className="file-ctx-confirm">Discard changes to <b>{basename(gitCtx.postRename)}</b>? This can’t be undone.</div>
                <button className="file-ctx-item file-ctx-danger" onClick={() => { handleDiscardFile(gitCtx.postRename, gitCtx.column); setGitCtx(null); }}><RotateCcw size={13} /><span>Discard{gitCtx.column === "untracked" ? " (delete file)" : ""}</span></button>
                <button className="file-ctx-item" onClick={() => setGitCtx(c => c ? { ...c, confirmDiscard: false } : null)}><XIcon size={13} /><span>Cancel</span></button>
              </>
            ) : (
              <>
                <button className="file-ctx-item" onClick={() => { selectDiff(gitCtx.postRename, gitCtx.column); setGitCtx(null); }}><FileDiff size={13} /><span>Show diff</span></button>
                {gitCtx.column === "staged"
                  ? <button className="file-ctx-item" onClick={() => { handleUnstageFile(gitCtx.postRename); setGitCtx(null); }}><Minus size={13} /><span>Unstage</span></button>
                  : <button className="file-ctx-item" onClick={() => { handleStageFile(gitCtx.postRename); setGitCtx(null); }}><Plus size={13} /><span>Stage</span></button>}
                <button className="file-ctx-item file-ctx-danger" onClick={() => setGitCtx(c => c ? { ...c, confirmDiscard: true } : null)}><RotateCcw size={13} /><span>Discard changes</span></button>
              </>
            )}
          </div>
        </>
      )}
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

type DiffMode = "staged" | "unstaged" | "untracked";

// ── Git changes folder tree ───────────────────────────────────────────
// Each changed file is grouped under its directory (VS Code-style), with single-child folder
// chains compacted (e.g. `src/ViewModels`). Built from the flat status list per section.
type GitFileEntry = { name: string; path: string; gitPath: string; ch: string };
type GitTreeNode = { type: "dir"; name: string; path: string; children: GitTreeNode[] } | { type: "file"; entry: GitFileEntry };

function buildGitTree(entries: GitFileEntry[]): GitTreeNode[] {
  type Tmp = { name: string; path: string; dirs: Map<string, Tmp>; files: GitFileEntry[] };
  const root: Tmp = { name: "", path: "", dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.split(/[\\/]/);
    parts.pop(); // drop the filename
    let cur = root, cp = "";
    for (const seg of parts) {
      if (!seg) continue;
      cp = cp ? `${cp}/${seg}` : seg;
      let next = cur.dirs.get(seg);
      if (!next) { next = { name: seg, path: cp, dirs: new Map(), files: [] }; cur.dirs.set(seg, next); }
      cur = next;
    }
    cur.files.push(e);
  }
  const conv = (t: Tmp): GitTreeNode[] => {
    const nodes: GitTreeNode[] = [];
    for (const dn of [...t.dirs.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      let node = t.dirs.get(dn)!, name = node.name;
      while (node.dirs.size === 1 && node.files.length === 0) { const child = [...node.dirs.values()][0]; name = `${name}/${child.name}`; node = child; }
      nodes.push({ type: "dir", name, path: node.path, children: conv(node) });
    }
    for (const f of [...t.files].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))) nodes.push({ type: "file", entry: f });
    return nodes;
  };
  return conv(root);
}

function GitSection({ label, files, column, tree, highlightedPaths, selectedPath, selectedColumn, activePath, activeColumn, onSelect, onStage, onUnstage, onStageAll, onUnstageAll, onContext, showTt, hideTt }: { label: string; files: GitFile[]; column: DiffMode; tree: boolean; highlightedPaths: Set<string>; selectedPath: string | null; selectedColumn: DiffMode | null; activePath: string | null; activeColumn: DiffMode | null; onSelect: (path: string, mode: DiffMode) => void; onStage: (path: string) => void; onUnstage: (path: string) => void; onStageAll: (paths: string[]) => void; onUnstageAll: (paths: string[]) => void; onContext: (x: number, y: number, column: DiffMode, postRename: string) => void; showTt: (text: string, el: HTMLElement) => void; hideTt: () => void }) {
  const isStagedCol = column === "staged";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (p: string) => setCollapsed(prev => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const entries: GitFileEntry[] = files.map(f => {
    const raw = isStagedCol ? f.staged : column === "unstaged" ? f.unstaged : "?";
    const ch = raw === "?" ? "U" : (raw.trim() || "M");
    const postRename = f.path.includes(" -> ") ? f.path.split(" -> ").pop()! : f.path;
    return { name: basename(postRename), path: postRename, gitPath: f.path, ch };
  }).filter(e => e.name.length > 0); // guard against directory entries (trailing-slash paths)

  // One file row, shared by the tree and the flat list. `dirHint` (flat mode) shows the file's
  // folder dimmed after the name, VS Code-style. Right-click highlights the row (active) like hover.
  const fileRow = (e: GitFileEntry, pad: number, dirHint: string | null) => {
    const selected = selectedPath === e.path && selectedColumn === column;
    const active = activePath === e.path && activeColumn === column;
    const highlighted = highlightedPaths.has(e.gitPath);
    return (
      <div
        key={`f:${e.path}`}
        className={`git-tree-row git-tree-file ${dirHint !== null ? "git-tree-flat" : ""} ${highlighted ? "git-file-blink" : ""} ${selected ? "git-file-selected" : ""} ${active ? "git-file-context" : ""}`}
        style={{ paddingLeft: pad }}
        onClick={() => onSelect(e.path, column)}
        onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); onContext(ev.clientX, ev.clientY, column, e.path); }}
        onMouseEnter={(ev) => showTt("Click to show diff", ev.currentTarget)}
        onMouseLeave={hideTt}
      >
        <span className="git-tree-chev" />
        <img className="git-tree-icon" src={fileIconUrl(e.name)} alt="" draggable={false} />
        <span className="git-tree-name">{e.name}</span>
        {dirHint ? <span className="git-tree-dir-hint">{dirHint}</span> : null}
        <button className="git-file-action" onClick={(ev) => { ev.stopPropagation(); (isStagedCol ? onUnstage : onStage)(e.path); }} onMouseEnter={(ev) => showTt(isStagedCol ? "Unstage" : "Stage", ev.currentTarget)} onMouseLeave={hideTt} aria-label={isStagedCol ? "Unstage" : "Stage"}>{isStagedCol ? <Minus size={11} /> : <Plus size={11} />}</button>
        <span className={`git-tree-status gs-${e.ch}`}>{e.ch}</span>
      </div>
    );
  };

  const renderTree = (nodes: GitTreeNode[], depth: number): React.ReactNode[] => nodes.map((node) => {
    if (node.type === "file") return fileRow(node.entry, 8 + depth * 12, null);
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={`d:${node.path}`}>
        <div className="git-tree-row git-tree-dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(node.path)}>
          <span className="git-tree-chev"><ChevronRight size={12} className={isCollapsed ? "" : "open"} /></span>
          <img className="git-tree-icon" src={plainFolderIconUrl(!isCollapsed)} alt="" draggable={false} />
          <span className="git-tree-name">{node.name}</span>
        </div>
        {/* Children stay mounted; the grid-rows transition (shared with the file explorer) animates open/closed. */}
        <div className={`file-children ${isCollapsed ? "" : "open"}`}>
          <div className="file-children-inner">{renderTree(node.children, depth + 1)}</div>
        </div>
      </div>
    );
  });

  const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i >= 0 ? p.slice(0, i) : ""; };
  const flatRows = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map(e => fileRow(e, 8, dirOf(e.path)));

  return (
    <div className="git-section">
      <div className="git-section-header">
        <span className="git-section-label">{label}</span>
        <span className="git-section-count">{files.length}</span>
        <button className="git-section-action" onClick={() => (isStagedCol ? onUnstageAll : onStageAll)(entries.map(e => e.path))} onMouseEnter={(ev) => showTt(isStagedCol ? "Unstage all" : "Stage all", ev.currentTarget)} onMouseLeave={hideTt} aria-label={isStagedCol ? "Unstage all" : "Stage all"}>{isStagedCol ? <Minus size={12} /> : <Plus size={12} />}</button>
      </div>
      {tree ? renderTree(buildGitTree(entries), 0) : flatRows}
    </div>
  );
}

function GitHistoryList({ commits, showTt, hideTt }: { commits: GitCommit[]; showTt: (text: string, el: HTMLElement) => void; hideTt: () => void }) {
  if (commits.length === 0) return <div className="git-panel-empty">No commits</div>;
  return (
    <div className="git-history-list">
      {commits.map((c) => (
        <div key={c.hash} className="git-commit" onMouseEnter={(e) => showTt(`${c.short_hash} · ${c.author} · ${c.relative_time}`, e.currentTarget)} onMouseLeave={hideTt}>
          <span className="git-commit-hash">{c.short_hash}</span>
          <span className="git-commit-subject">{c.subject}</span>
          <span className="git-commit-time">{c.relative_time}</span>
        </div>
      ))}
    </div>
  );
}

// ── Unified diff (git panel Diff tab) ─────────────────────────────────
// Hand-rendered: fetch `git diff` text via the git_diff command and lay it out inline with
// +/-/context coloring, old/new line gutters, a file header with +/- stats, and per-line
// syntax highlighting (highlight.js, themed in App.css).
type DiffRow = { kind: "hunk" | "add" | "del" | "ctx" | "note"; text: string; oldNo: number | null; newNo: number | null; section?: string; hunkNo?: number };

// Map a file extension to a highlight.js language id (restricted to the common bundle).
// Returns null for unknown types, in which case the diff renders as plain text.
function diffLang(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", scss: "scss", less: "less",
    html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
    rs: "rust", py: "python", rb: "ruby", go: "go", java: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", swift: "swift", kt: "kotlin", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash", md: "markdown", markdown: "markdown",
    yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  };
  const lang = map[ext];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

// Highlight a single diff line. Stateless per line — fine for code, occasional mis-coloring
// inside a multi-line string/comment is acceptable in a narrow diff. null → render plain.
function highlightLine(text: string, lang: string | null): string | null {
  if (!lang || !text) return null;
  try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return null; }
}

function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0, newNo = 0, hunkNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      // @@ -oldStart,oldCount +newStart,newCount @@ optional-section-heading
      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/.exec(raw);
      let label = raw, section = "";
      if (m) {
        oldNo = parseInt(m[1], 10); newNo = parseInt(m[3], 10);
        const count = m[4] ? parseInt(m[4], 10) : 1;
        label = `Lines ${newNo}–${count > 0 ? newNo + count - 1 : newNo}`;
        section = (m[5] || "").trim();
      }
      hunkNo++;
      rows.push({ kind: "hunk", text: label, section, hunkNo, oldNo: null, newNo: null });
      continue;
    }
    // Skip the file-header noise — the panel already knows which file this is.
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity |dissimilarity |rename |copy )/.test(raw)) continue;
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) { rows.push({ kind: "note", text: "Binary file — no text diff", oldNo: null, newNo: null }); continue; }
    if (raw.startsWith("\\")) { rows.push({ kind: "note", text: raw.replace(/^\\ /, ""), oldNo: null, newNo: null }); continue; }
    if (raw === "") continue; // trailing blank from the split
    if (raw.startsWith("+")) { rows.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ }); continue; }
    if (raw.startsWith("-")) { rows.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null }); continue; }
    rows.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
  }
  return rows;
}

function DiffView({ cwd, file, version }: { cwd: string; file: { path: string; mode: DiffMode } | null; version: number }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear the previous file's diff the moment a different file is selected, so the loading
  // spinner shows instead of briefly flashing the old file's diff. Not keyed on `version`, so
  // the periodic background refresh updates in place without flicker.
  useEffect(() => { setDiff(null); setError(null); }, [cwd, file?.path, file?.mode]);

  useEffect(() => {
    if (!file) { setDiff(null); setError(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    invoke<string>("git_diff", { cwd, path: file.path, mode: file.mode })
      .then((d) => { if (alive) setDiff(d); })
      .catch((e) => { if (alive) { setError(String(e)); setDiff(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cwd, file?.path, file?.mode, version]);

  const lang = file ? diffLang(file.path) : null;
  // Parse + highlight once per (diff, language) rather than on every render.
  const model = useMemo(() => {
    if (!diff) return null;
    const rows = parseDiff(diff);
    let adds = 0, dels = 0;
    for (const r of rows) { if (r.kind === "add") adds++; else if (r.kind === "del") dels++; }
    const rendered = rows.map((r) => ({ row: r, html: (r.kind === "add" || r.kind === "del" || r.kind === "ctx") ? highlightLine(r.text, lang) : null }));
    return { rendered, adds, dels };
  }, [diff, lang]);

  if (!file) return <div className="git-panel-empty">Select a file to view its diff</div>;
  if (loading && diff === null) return <div className="diff-loading"><span className="diff-spin" /><span>Loading diff…</span></div>;
  if (error) return <div className="git-panel-empty">{error}</div>;
  if (!model || model.rendered.length === 0) return <div className="git-panel-empty">No changes</div>;

  const modeLabel = file.mode === "staged" ? "Staged" : file.mode === "untracked" ? "Untracked" : "Changes";
  return (
    <>
      <div className="diff-header">
        <span className="diff-header-name" title={file.path}>{basename(file.path)}</span>
        <span className="diff-header-mode">{modeLabel}</span>
        <span className="diff-header-stats">
          {model.adds > 0 && <span className="diff-stat-add">+{model.adds}</span>}
          {model.dels > 0 && <span className="diff-stat-del">-{model.dels}</span>}
        </span>
      </div>
      <div className="diff-scroll">
        <div className="diff-view">
          {model.rendered.map(({ row: r, html }, i) => {
        if (r.kind === "hunk") return (
          <div key={i} className="diff-hunk">
            <span className="diff-hunk-label">Hunk {r.hunkNo}: {r.text}</span>
            {r.section ? <span className="diff-hunk-ctx">{r.section}</span> : null}
          </div>
        );
        if (r.kind === "note") return <div key={i} className="diff-row diff-note">{r.text}</div>;
        return (
          <div key={i} className={`diff-row diff-${r.kind}`}>
            <span className="diff-gutter">{r.oldNo ?? ""}</span>
            <span className="diff-gutter">{r.newNo ?? ""}</span>
            <span className="diff-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : ""}</span>
            {html !== null
              ? <span className="diff-text" dangerouslySetInnerHTML={{ __html: html }} />
              : <span className="diff-text">{r.text || " "}</span>}
          </div>
        );
      })}
        </div>
      </div>
    </>
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
