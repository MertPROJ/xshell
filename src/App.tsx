import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getDefaultShellId, getShellById } from "./shells";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { HomeView } from "./components/HomeView";
import { TerminalTab } from "./components/TerminalTab";
import { SettingsView, type ThemeMode } from "./components/SettingsView";
import { DARK_TERM_BG, LIGHT_TERM_BG } from "./components/TerminalTab";
import { ProjectEditorDialog } from "./components/ProjectEditorDialog";
import { ProjectPicker } from "./components/ProjectPicker";
import type { ProjectInfo, ProjectSettings, SessionFolder, SessionInfo, Tab, Group, LayoutNode, SidebarItem, SidebarFolder } from "./types";
import { GroupView } from "./components/GroupView";
import { countLeaves, collectLeafIds, insertLeaf, removeLeaf, setRatioAt, DropZone } from "./layout";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { UpdateDialog } from "./components/UpdateDialog";

// Flatten sidebar items to an ordered list of project paths (folders expanded in place).
// Used to derive `savedPaths` for downstream code that doesn't care about folders.
function flattenSidebarPaths(layout: SidebarItem[]): string[] {
  const out: string[] = [];
  for (const item of layout) {
    if (item.kind === "project") out.push(item.path);
    else for (const p of item.projectPaths) out.push(p);
  }
  return out;
}

function removeProjectFromLayout(layout: SidebarItem[], path: string): SidebarItem[] {
  const pl = path.toLowerCase();
  const out: SidebarItem[] = [];
  for (const item of layout) {
    if (item.kind === "project") {
      if (item.path.toLowerCase() !== pl) out.push(item);
    } else {
      const kept = item.projectPaths.filter(p => p.toLowerCase() !== pl);
      if (kept.length > 0) out.push({ ...item, projectPaths: kept });
      // An empty folder is dropped entirely — no ghost folders sticking around.
    }
  }
  return out;
}

function addProjectToLayout(layout: SidebarItem[], path: string): SidebarItem[] {
  if (flattenSidebarPaths(layout).some(p => p.toLowerCase() === path.toLowerCase())) return layout;
  return [...layout, { kind: "project", path }];
}

// Overlay that paints a drop-zone rectangle (edge of a target pane) while a tab is
// being dragged. Computed from the target pane's live bounding rect + the zone.
function DropZoneOverlay({ targetTabId, zone }: { targetTabId: string; zone: "left" | "right" | "top" | "bottom" }) {
  const el = document.querySelector(`[data-group-leaf="${CSS.escape(targetTabId)}"]`) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const area = (el.closest(".work-area") as HTMLElement | null)?.getBoundingClientRect();
  if (!area) return null;
  const left = r.left - area.left;
  const top = r.top - area.top;
  const fullW = r.width, fullH = r.height;
  let box: React.CSSProperties = { left, top, width: fullW, height: fullH };
  if (zone === "left")   box = { left,                    top,                    width: fullW * 0.5, height: fullH };
  if (zone === "right")  box = { left: left + fullW * 0.5, top,                    width: fullW * 0.5, height: fullH };
  if (zone === "top")    box = { left,                    top,                    width: fullW,       height: fullH * 0.5 };
  if (zone === "bottom") box = { left,                    top: top + fullH * 0.5,  width: fullW,       height: fullH * 0.5 };
  return <div className="drop-zone-preview" style={box} />;
}

export default function App() {
  const [allProjects, setAllProjects] = useState<ProjectInfo[]>([]);
  const [savedPaths, setSavedPaths] = useState<string[]>([]);
  // Discord-style sidebar — top-level list of projects and folders-of-projects. `savedPaths`
  // is kept as a derived flat view (used by other components that just want "which projects
  // are pinned") but `sidebarLayout` is the source of truth for ordering + grouping.
  const [sidebarLayout, setSidebarLayout] = useState<SidebarItem[]>([]);
  const [projectIcons, setProjectIcons] = useState<Record<string, ProjectSettings>>({});
  const [userProjects, setUserProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState("home");
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const [projectSessions, setProjectSessions] = useState<SessionInfo[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // Lazy polling = only fetch git status while the panel is open (a single fetch fires at
  // session start so the activity-bar icon has something to show). Eager polling re-fetches
  // every 3s while the tab is active. Default lazy: most users only need fresh git data
  // when they're actually looking at it.
  const [gitLazyPolling, setGitLazyPolling] = useState(true);
  const [gitPanelFilenamesOnly, setGitPanelFilenamesOnly] = useState(false);
  const [contextTreeEnabled, setContextTreeEnabled] = useState(true);
  // Both default to true: setting up the statusline hook is the meaningful gesture, the
  // toggles let the user hide either feature even with stats available.
  const [showRateLimitInSidebar, setShowRateLimitInSidebar] = useState(true);
  const [showSessionRowMetrics, setShowSessionRowMetrics] = useState(true);
  // Replaces the project path in the Claude terminal header with a cost/context strip.
  // Only takes effect when the statusline hook has populated authoritative stats for the
  // session — without it there'd be nothing to show, so the header keeps the path.
  const [showTerminalHeaderStats, setShowTerminalHeaderStats] = useState(true);
  // Daily-cost chart + totals panel above the session list on the project page. Same
  // dependency on the statusline hook — the chart series comes from xshell-stats data.
  const [showProjectStatsChart, setShowProjectStatsChart] = useState(true);
  const [terminalBgColor, setTerminalBgColor] = useState("#1c1c1b");
  const [defaultTerminalFontSize, setDefaultTerminalFontSize] = useState(14);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  // Sets CLAUDE_CODE_NO_FLICKER=1 on every claude session so it uses the alternate-screen
  // buffer renderer. Default ON — flicker-free is what most users want; only flip if the
  // user wants scrollback-style output (or hits a renderer bug).
  const [fullscreenRendering, setFullscreenRendering] = useState(true);
  // Sets CLAUDE_CODE_FORCE_SYNC_OUTPUT=1 so claude wraps each TUI frame in DEC 2026
  // synchronized-output markers. xterm.js v5+ honors them and renders only complete
  // frames — fixes the "flying letters" residue where xterm would otherwise see
  // half-drawn intermediate frames. Default ON — strongly recommended.
  const [forceSyncOutput, setForceSyncOutput] = useState(true);
  // Use xterm.js's GPU-accelerated WebGL renderer. Default ON — it eliminates the subpixel
  // seams that show up in Claude Code's startup banner (half-block Unicode chars on the
  // DOM renderer pick up a faint horizontal line between the upper and lower halves) and
  // is generally smoother. Falls back to the DOM renderer if the host's GPU can't give us
  // a WebGL context.
  const [webglRendering, setWebglRendering] = useState(true);
  // Spawn each restored tab's PTY on app launch instead of deferring until the user clicks the
  // tab. Default ON — claude takes a few seconds to boot, so eagerly initing means the session
  // is ready (or close to it) by the time the user switches to the tab. The "Starting Claude…"
  // overlay still shows if the user gets there before the first byte of output.
  const [eagerInitTabs, setEagerInitTabs] = useState(true);
  const [defaultShell, setDefaultShell] = useState<string>(getDefaultShellId());
  // Cost vs Tokens for the per-project stats panel. Global, not per-project — reflects what
  // the user cares about generally, not a trait of any one project.
  const [projectStatsView, setProjectStatsView] = useState<'cost' | 'tokens'>('cost');
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [editingProjectPath, setEditingProjectPath] = useState<string | null>(null);
  // Update check — fetches GitHub Releases on mount; the result drives the red badge on the
  // Settings cog (Sidebar), the About page (SettingsView), and the on-start dialog.
  const updateInfo = useUpdateCheck();
  // One-time-per-version dialog — opens once per launch when GitHub has a newer release AND
  // the user hasn't already skipped that specific version. `lastSeenUpdateVersion` is loaded
  // from the store and re-written on "Skip this version".
  const [lastSeenUpdateVersion, setLastSeenUpdateVersion] = useState<string | null>(null);
  const [lastSeenLoaded, setLastSeenLoaded] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateDialogShown, setUpdateDialogShown] = useState(false);
  const tabsRef = useRef<Tab[]>([]);
  const activeTabIdRef = useRef<string>("home");

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  // ── Initial load ──────────────────────────────────────────────────
  const [tabsRestored, setTabsRestored] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        const [paths, icons, savedTabs, savedGroups, gitLazy, bgColor, aot, shell, ctxEnabled, defFont, gitNamesOnly, storedLayout, rlSidebar, rowMetrics, storedTheme, fsRender, termHeaderStats, projectStatsChart, statsView, syncOut, eagerInit, webgl] = await Promise.all([
          store.get<string[]>("project_paths"),
          store.get<Record<string, ProjectSettings>>("project_icons"),
          store.get<Tab[]>("open_tabs"),
          store.get<Group[]>("open_groups"),
          store.get<boolean>("git_lazy_polling"),
          store.get<string>("terminal_bg_color"),
          store.get<boolean>("always_on_top"),
          store.get<string>("default_shell"),
          store.get<boolean>("context_tree_enabled"),
          store.get<number>("default_terminal_font_size"),
          store.get<boolean>("git_panel_filenames_only"),
          store.get<SidebarItem[]>("sidebar_layout"),
          store.get<boolean>("rate_limit_in_sidebar"),
          store.get<boolean>("session_row_metrics"),
          store.get<ThemeMode>("theme"),
          store.get<boolean>("fullscreen_rendering_enabled"),
          store.get<boolean>("terminal_header_stats"),
          store.get<boolean>("project_stats_chart"),
          store.get<'cost' | 'tokens'>("project_stats_view"),
          store.get<boolean>("force_sync_output_enabled"),
          store.get<boolean>("eager_init_tabs"),
          store.get<boolean>("webgl_rendering_enabled"),
        ]);
        // Layout: prefer the explicit `sidebar_layout` if present; otherwise migrate
        // from the flat `project_paths` list by wrapping each path in a project item.
        let layout: SidebarItem[] = [];
        if (Array.isArray(storedLayout) && storedLayout.length > 0) {
          layout = storedLayout;
        } else if (paths && paths.length > 0) {
          layout = paths.map(p => ({ kind: "project" as const, path: p }));
        }
        setSidebarLayout(layout);
        // Derive the flat paths list from the layout so downstream code stays happy.
        const derivedPaths = flattenSidebarPaths(layout);
        if (derivedPaths.length) setSavedPaths(derivedPaths);
        else if (paths) setSavedPaths(paths);
        if (icons) setProjectIcons(icons);
        if (typeof gitLazy === "boolean") setGitLazyPolling(gitLazy);
        if (typeof bgColor === "string") setTerminalBgColor(bgColor);
        if (typeof aot === "boolean") setAlwaysOnTop(aot);
        if (typeof shell === "string") setDefaultShell(shell);
        if (typeof ctxEnabled === "boolean") setContextTreeEnabled(ctxEnabled);
        if (typeof defFont === "number" && defFont >= 8 && defFont <= 32) setDefaultTerminalFontSize(defFont);
        if (typeof rlSidebar === "boolean") setShowRateLimitInSidebar(rlSidebar);
        if (typeof rowMetrics === "boolean") setShowSessionRowMetrics(rowMetrics);
        if (typeof gitNamesOnly === "boolean") setGitPanelFilenamesOnly(gitNamesOnly);
        if (typeof fsRender === "boolean") setFullscreenRendering(fsRender);
        if (typeof syncOut === "boolean") setForceSyncOutput(syncOut);
        if (typeof eagerInit === "boolean") setEagerInitTabs(eagerInit);
        if (typeof webgl === "boolean") setWebglRendering(webgl);
        if (typeof termHeaderStats === "boolean") setShowTerminalHeaderStats(termHeaderStats);
        if (typeof projectStatsChart === "boolean") setShowProjectStatsChart(projectStatsChart);
        if (storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
        if (statsView === "cost" || statsView === "tokens") setProjectStatsView(statsView);
        // Restore only tabs that have a real sessionId (not abandoned "New Chat" tabs)
        if (savedTabs?.length) {
          const restorable = savedTabs.filter(t => t.sessionId && t.projectPath);
          if (restorable.length) {
            // First, filter groups: keep only those whose leaves are all restorable.
            const restoredIds = new Set(restorable.map(t => t.id));
            const keptGroups: Group[] = [];
            if (savedGroups?.length) {
              for (const g of savedGroups) {
                const leaves = collectLeafIds(g.layout);
                if (leaves.length >= 2 && leaves.every(id => restoredIds.has(id))) keptGroups.push(g);
              }
            }
            const validGroupIds = new Set(keptGroups.map(g => g.id));
            // Then, scrub any orphaned groupId off a tab — a leftover from an earlier bug
            // where tabs kept a groupId pointing at a group that no longer exists.
            const scrubbed = restorable.map(t => (t.groupId && !validGroupIds.has(t.groupId)) ? { ...t, groupId: undefined } : t);
            setTabs(scrubbed);
            setGroups(keptGroups);
            let maxN = 0;
            for (const g of keptGroups) {
              const m = /^Group\s+(\d+)$/.exec(g.name);
              if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
            }
            groupCounterRef.current = maxN + 1;
          }
        }
      } catch (_) {}
      setTabsRestored(true);
      const [projects, sessions] = await Promise.all([
        invoke<ProjectInfo[]>("list_claude_projects").catch(() => [] as ProjectInfo[]),
        invoke<SessionInfo[]>("get_all_recent_sessions", { limit: 100 }).catch(() => [] as SessionInfo[]),
      ]);
      setAllProjects(projects);
      setRecentSessions(sessions);
      setInitialLoading(false);
    })();
  }, []);

  // ── Load the last skipped-update version from the store ───────────
  useEffect(() => {
    (async () => {
      try {
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        const v = await store.get<string>("last_seen_update_version");
        if (typeof v === "string") setLastSeenUpdateVersion(v);
      } catch (_) {}
      setLastSeenLoaded(true);
    })();
  }, []);

  // Open the update dialog once per launch, only if the user hasn't already skipped this
  // exact version. `updateDialogShown` ensures it never re-opens within the same session
  // even if the hook re-renders.
  useEffect(() => {
    if (!lastSeenLoaded || updateDialogShown) return;
    if (updateInfo.loading || updateInfo.error) return;
    if (!updateInfo.updateAvailable || !updateInfo.latestVersion) return;
    if (lastSeenUpdateVersion === updateInfo.latestVersion) return;
    setUpdateDialogOpen(true);
    setUpdateDialogShown(true);
  }, [lastSeenLoaded, updateDialogShown, updateInfo.loading, updateInfo.error, updateInfo.updateAvailable, updateInfo.latestVersion, lastSeenUpdateVersion]);

  // Any close path through the dialog runs through here. Always persists `last_seen_update_version`
  // so the dialog won't fire again until GitHub ships a NEWER tag — the badge + About dot are
  // unaffected and stay until the bundled version actually catches up.
  const dismissUpdateDialog = useCallback(async () => {
    const v = updateInfo.latestVersion;
    setUpdateDialogOpen(false);
    if (!v) return;
    setLastSeenUpdateVersion(v);
    try {
      const store = await load("settings.json", { defaults: {}, autoSave: true });
      await store.set("last_seen_update_version", v);
    } catch (_) {}
  }, [updateInfo.latestVersion]);

  // ── Persist tabs whenever they change (after initial restore) ─────
  useEffect(() => {
    if (!tabsRestored) return;
    (async () => {
      try {
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        await store.set("open_tabs", tabs);
      } catch (_) {}
    })();
  }, [tabs, tabsRestored]);

  // ── Derive user projects ──────────────────────────────────────────
  useEffect(() => {
    setUserProjects(savedPaths.map(path => {
      const found = allProjects.find(p => p.path.toLowerCase() === path.toLowerCase());
      if (found) return found;
      const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
      return { name, path, encoded_name: "", session_count: 0, last_active: "" };
    }));
  }, [savedPaths, allProjects]);

  // ── Tab title sync: lightweight poll only when terminals are open ──
  useEffect(() => {
    if (tabs.length === 0) return;

    const syncTitles = async () => {
      // Collect unique encoded project names from open tabs
      const projectPaths = [...new Set(tabs.filter(t => t.projectPath).map(t => t.projectPath!.toLowerCase()))];
      const projectMap = new Map<string, ProjectInfo>();
      for (const p of allProjects) projectMap.set(p.path.toLowerCase(), p);

      for (const pp of projectPaths) {
        const proj = projectMap.get(pp);
        if (!proj?.encoded_name) continue;
        try {
          const sessions = await invoke<SessionInfo[]>("get_sessions", { encodedName: proj.encoded_name });
          setTabs(prev => {
            let changed = false;
            const next = prev.map(tab => {
              if (tab.projectPath?.toLowerCase() !== pp) return tab;
              // Tabs are created with a pre-allocated sessionId (see handleNewChat), so we only
              // ever match on that — picks up `/rename`, `ai-title`, and first-prompt fallback alike.
              if (!tab.sessionId) return tab;
              const match = sessions.find(s => s.id === tab.sessionId);
              if (match && match.title !== tab.title) { changed = true; return { ...tab, title: match.title }; }
              return tab;
            });
            return changed ? next : prev;
          });
        } catch (_) {}
      }
    };

    const interval = setInterval(syncTitles, 5000);
    return () => clearInterval(interval);
  }, [tabs.length, allProjects]); // Only re-setup when tab count or projects change

  // ── Persistence ───────────────────────────────────────────────────
  const persistPaths = useCallback(async (paths: string[]) => {
    setSavedPaths(paths);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_paths", paths); } catch (_) {}
  }, []);

  // Central sidebar-layout mutator. Also refreshes the derived `savedPaths` and persists both
  // so old code paths (which still consume `savedPaths`) keep working.
  const persistSidebarLayout = useCallback(async (layout: SidebarItem[]) => {
    setSidebarLayout(layout);
    const paths = flattenSidebarPaths(layout);
    setSavedPaths(paths);
    try {
      const store = await load("settings.json", { defaults: {}, autoSave: true });
      await store.set("sidebar_layout", layout);
      await store.set("project_paths", paths);
    } catch (_) {}
  }, []);

  const persistIcons = useCallback(async (icons: Record<string, ProjectSettings>) => {
    setProjectIcons(icons);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_icons", icons); } catch (_) {}
  }, []);

  const persistGitLazyPolling = useCallback(async (enabled: boolean) => {
    setGitLazyPolling(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("git_lazy_polling", enabled); } catch (_) {}
  }, []);

  const persistGitPanelFilenamesOnly = useCallback(async (enabled: boolean) => {
    setGitPanelFilenamesOnly(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("git_panel_filenames_only", enabled); } catch (_) {}
  }, []);

  const persistContextTreeEnabled = useCallback(async (enabled: boolean) => {
    setContextTreeEnabled(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("context_tree_enabled", enabled); } catch (_) {}
  }, []);

  const persistShowRateLimitInSidebar = useCallback(async (enabled: boolean) => {
    setShowRateLimitInSidebar(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("rate_limit_in_sidebar", enabled); } catch (_) {}
  }, []);

  const persistShowSessionRowMetrics = useCallback(async (enabled: boolean) => {
    setShowSessionRowMetrics(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("session_row_metrics", enabled); } catch (_) {}
  }, []);

  const persistShowTerminalHeaderStats = useCallback(async (enabled: boolean) => {
    setShowTerminalHeaderStats(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("terminal_header_stats", enabled); } catch (_) {}
  }, []);

  const persistShowProjectStatsChart = useCallback(async (enabled: boolean) => {
    setShowProjectStatsChart(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_stats_chart", enabled); } catch (_) {}
  }, []);

  const persistDefaultTerminalFontSize = useCallback(async (size: number) => {
    const clamped = Math.max(8, Math.min(32, Math.round(size)));
    setDefaultTerminalFontSize(clamped);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("default_terminal_font_size", clamped); } catch (_) {}
  }, []);

  const persistTerminalBgColor = useCallback(async (color: string) => {
    setTerminalBgColor(color);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("terminal_bg_color", color); } catch (_) {}
  }, []);

  const persistAlwaysOnTop = useCallback(async (value: boolean) => {
    setAlwaysOnTop(value);
    try { await getCurrentWindow().setAlwaysOnTop(value); } catch (_) {}
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("always_on_top", value); } catch (_) {}
  }, []);

  const persistDefaultShell = useCallback(async (shellId: string) => {
    setDefaultShell(shellId);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("default_shell", shellId); } catch (_) {}
  }, []);

  const persistFullscreenRendering = useCallback(async (enabled: boolean) => {
    setFullscreenRendering(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("fullscreen_rendering_enabled", enabled); } catch (_) {}
  }, []);

  const persistProjectStatsView = useCallback(async (view: 'cost' | 'tokens') => {
    setProjectStatsView(view);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_stats_view", view); } catch (_) {}
  }, []);

  const persistForceSyncOutput = useCallback(async (enabled: boolean) => {
    setForceSyncOutput(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("force_sync_output_enabled", enabled); } catch (_) {}
  }, []);

  const persistEagerInitTabs = useCallback(async (enabled: boolean) => {
    setEagerInitTabs(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("eager_init_tabs", enabled); } catch (_) {}
  }, []);

  const persistWebglRendering = useCallback(async (enabled: boolean) => {
    setWebglRendering(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("webgl_rendering_enabled", enabled); } catch (_) {}
  }, []);

  // Apply synchronously alongside the React state change so the next paint already has
  // the new tokens — avoids a flash and any useEffect-timing oddities in the WebView.
  const persistTheme = useCallback(async (next: ThemeMode) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("theme", next); } catch (_) {}
  }, []);

  // Safety net: keep the attribute in sync with state on every change (covers the initial
  // restore from settings.json, where setTheme is called outside persistTheme).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // When the theme flips, slide the terminal bg setting from the previous theme's default
  // to the new theme's default — so the Settings color picker shows the right shade and
  // the saved value matches what's actually rendered. Custom colors stay put. Also fires
  // on first load: if the user originally saved #1c1c1b in dark and then picked Light,
  // this normalizes them to #faf9f5 once the stored theme is restored.
  useEffect(() => {
    const newDefault = theme === "light" ? LIGHT_TERM_BG : DARK_TERM_BG;
    const oldDefault = theme === "light" ? DARK_TERM_BG : LIGHT_TERM_BG;
    if (terminalBgColor.toLowerCase() === oldDefault) persistTerminalBgColor(newDefault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Called by TerminalTab when a branched session is detected. Updates only the tab's
  // metadata — the PTY is already attached to the new sessionId's JSONL, so nothing else
  // needs to change.
  const handleSwitchTabToBranch = useCallback((tabId: string, newSessionId: string, newTitle: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, sessionId: newSessionId, title: newTitle } : t));
  }, []);

  // Apply always-on-top on startup once the value has been restored from disk.
  useEffect(() => { getCurrentWindow().setAlwaysOnTop(alwaysOnTop).catch(() => {}); }, [alwaysOnTop]);


  // ── Navigation: fresh load on every navigate ──────────────────────
  const handleSelectProject = useCallback(async (project: ProjectInfo) => {
    setSelectedProject(project);
    setActiveTabId("home");
    if (!project.encoded_name) { setProjectSessions([]); return; }
    setSessionsLoading(true);
    try { setProjectSessions(await invoke<SessionInfo[]>("get_sessions", { encodedName: project.encoded_name })); } catch (_) { setProjectSessions([]); }
    setSessionsLoading(false);
  }, []);

  const handleGoHome = useCallback(async () => {
    setSelectedProject(null);
    setActiveTabId("home");
    setSessionsLoading(true);
    const [sessions, projects] = await Promise.all([
      invoke<SessionInfo[]>("get_all_recent_sessions", { limit: 100 }).catch(() => [] as SessionInfo[]),
      invoke<ProjectInfo[]>("list_claude_projects").catch(() => allProjects),
    ]);
    setRecentSessions(sessions);
    setAllProjects(projects);
    setSessionsLoading(false);
  }, [allProjects]);

  // ── Project management ────────────────────────────────────────────
  const handleToggleProject = useCallback(async (path: string) => {
    const exists = flattenSidebarPaths(sidebarLayout).some(p => p.toLowerCase() === path.toLowerCase());
    const next = exists ? removeProjectFromLayout(sidebarLayout, path) : addProjectToLayout(sidebarLayout, path);
    await persistSidebarLayout(next);
    if (exists && selectedProject?.path.toLowerCase() === path.toLowerCase()) setSelectedProject(null);
  }, [sidebarLayout, persistSidebarLayout, selectedProject]);

  const handleRemoveProject = useCallback(async (path: string) => {
    await persistSidebarLayout(removeProjectFromLayout(sidebarLayout, path));
    if (selectedProject?.path.toLowerCase() === path.toLowerCase()) { setSelectedProject(null); setActiveTabId("home"); }
  }, [sidebarLayout, persistSidebarLayout, selectedProject]);

  const handleSaveProjectSettings = useCallback(async (path: string, next: ProjectSettings) => {
    const key = path.toLowerCase();
    const existing = projectIcons[key] || {};
    // Editor only touches icon + color + customName; preserve folders that already exist.
    const entry: ProjectSettings = { ...existing, icon: next.icon, color: next.color, customName: next.customName };
    const merged: Record<string, ProjectSettings> = { ...projectIcons, [key]: entry };
    if (!entry.icon && !entry.color && !entry.customName && (!entry.folders || entry.folders.length === 0)) delete merged[key];
    await persistIcons(merged);
  }, [projectIcons, persistIcons]);

  const handleSaveFolders = useCallback(async (path: string, folders: SessionFolder[]) => {
    const key = path.toLowerCase();
    const existing = projectIcons[key] || {};
    const entry: ProjectSettings = { ...existing, folders: folders.length > 0 ? folders : undefined };
    const merged: Record<string, ProjectSettings> = { ...projectIcons, [key]: entry };
    if (!entry.icon && !entry.customName && (!entry.folders || entry.folders.length === 0)) delete merged[key];
    await persistIcons(merged);
  }, [projectIcons, persistIcons]);

  const handleBrowseFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select project folder" });
      if (selected && typeof selected === "string" && !flattenSidebarPaths(sidebarLayout).some(p => p.toLowerCase() === selected.toLowerCase())) {
        await persistSidebarLayout(addProjectToLayout(sidebarLayout, selected));
        setAllProjects(await invoke<ProjectInfo[]>("list_claude_projects"));
      }
    } catch (_) {}
  }, [sidebarLayout, persistSidebarLayout]);

  // ── Tab management ────────────────────────────────────────────────
  const handleOpenSession = useCallback((session: SessionInfo, project?: ProjectInfo) => {
    const existingTab = tabs.find(t => t.sessionId === session.id);
    if (existingTab) {
      if (existingTab.groupId) {
        // Tab lives inside a group — surface that group and focus the matching pane.
        setActiveTabId(existingTab.groupId);
        setActiveLeafByGroup(prev => ({ ...prev, [existingTab.groupId!]: existingTab.id }));
      } else {
        setActiveTabId(existingTab.id);
      }
      return;
    }
    // Unique tab id (not derived from session id) — otherwise, a tab that auto-switches
    // its sessionId after /branch would leave its original session id "free", and a later
    // re-open of that session would generate a colliding tab id.
    const tabId = `terminal-${session.id}-${Date.now().toString(36)}`;
    setTabs(prev => [...prev, { id: tabId, type: "terminal", title: session.title, sessionId: session.id, projectPath: session.project_path || project?.path || "", projectName: session.project_name || project?.name || "", lastActiveAt: Date.now() }]);
    setActiveTabId(tabId);
  }, [tabs]);

  // Add as tab without switching to it — stays on current view.
  const handleOpenSessionBackground = useCallback((session: SessionInfo, project?: ProjectInfo) => {
    const existingTab = tabs.find(t => t.sessionId === session.id);
    if (existingTab) return;
    const tabId = `terminal-${session.id}-${Date.now().toString(36)}`;
    setTabs(prev => [...prev, { id: tabId, type: "terminal", title: session.title, sessionId: session.id, projectPath: session.project_path || project?.path || "", projectName: session.project_name || project?.name || "", lastActiveAt: Date.now() }]);
  }, [tabs]);

  const handleNewChat = useCallback((project: ProjectInfo) => {
    const tabId = `terminal-new-${Date.now()}`;
    // Pre-allocate a UUID and pass it to Claude via `--session-id`. Two wins over the old
    // `-n Chat-xxxxxx` approach: (1) we know the JSONL filename from the start, so the polling
    // sync can match by sessionId immediately instead of racing on customTitle; (2) Claude's
    // `ai-title` summary actually fires (it's suppressed when customTitle is set).
    const sessionId = crypto.randomUUID();
    setTabs(prev => [...prev, { id: tabId, type: "terminal" as const, title: "New Chat", sessionId, projectPath: project.path, projectName: project.name, shellMode: "claude", lastActiveAt: Date.now() }]);
    setActiveTabId(tabId);
  }, []);

  // Open a raw shell tab (no Claude wrapping) — disposable by design, not persisted across restart.
  // project === null → shell spawned in the user's home directory.
  const handleNewShell = useCallback((project: ProjectInfo | null, shellId: string, shellName: string) => {
    const tabId = `terminal-shell-${Date.now()}`;
    setTabs(prev => [...prev, { id: tabId, type: "terminal" as const, title: shellName, projectPath: project?.path || "", projectName: project?.name || "~", shellMode: "raw", shellId, lastActiveAt: Date.now() }]);
    setActiveTabId(tabId);
  }, []);

  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(new Set());

  const handleCloseTab = useCallback((id: string) => {
    // Group close: drop the group entry + all tabs that belong to it.
    const group = groupsRef.current.find(g => g.id === id);
    if (group) {
      const memberIds = collectLeafIds(group.layout);
      if (activeTabId === id) setActiveTabId("home");
      setGroups(prev => prev.filter(g => g.id !== id));
      setTabs(prev => prev.filter(t => !memberIds.includes(t.id)));
      return;
    }
    // Standalone tab close (existing animated path).
    setClosingTabIds(prev => new Set(prev).add(id));
    if (activeTabId === id) {
      const idx = tabsRef.current.findIndex(t => t.id === id);
      const remaining = tabsRef.current.filter(t => t.id !== id);
      setActiveTabId(remaining.length > 0 ? remaining[Math.min(idx, remaining.length - 1)]?.id || "home" : "home");
    }
    setTimeout(() => {
      setTabs(prev => prev.filter(t => t.id !== id));
      setClosingTabIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }, 180);
  }, [activeTabId]);

  const handleReorderProjects = useCallback(async (newPaths: string[]) => {
    await persistPaths(newPaths);
  }, [persistPaths]);

  void handleReorderProjects; // kept for any legacy callers; new Sidebar uses onLayoutChange.

  const handleReorderTabs = useCallback((newTabs: Tab[]) => {
    setTabs(newTabs);
  }, []);

  const [hoveredProjectPath, setHoveredProjectPath] = useState<string | null>(null);

  // Active terminal-tab count per project path (used for sidebar badges).
  const activeCountByProject = new Map<string, number>();
  for (const t of tabs) {
    if (t.projectPath) {
      const key = t.projectPath.toLowerCase();
      activeCountByProject.set(key, (activeCountByProject.get(key) || 0) + 1);
    }
  }
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const showSettings = activeTabId === "settings";
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeTabProjectPath = activeTab?.projectPath || null;

  // ── Groups (multi-pane split view) ────────────────────────────
  // A Group bundles up to 8 tabs into one "entry" in the tab bar, displaying them
  // in a binary-tree split layout. A tab is either standalone OR inside one group.
  const MAX_GROUP_LEAVES = 8;
  const [groups, setGroups] = useState<Group[]>([]);
  const showHome = !showSettings && !tabs.find(t => t.id === activeTabId) && !groups.find(g => g.id === activeTabId);

  // Persist groups whenever they change (after initial restore, same pattern as tabs).
  useEffect(() => {
    if (!tabsRestored) return;
    (async () => {
      try {
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        await store.set("open_groups", groups);
      } catch (_) {}
    })();
  }, [groups, tabsRestored]);
  const groupsRef = useRef<Group[]>([]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  // Which leaf inside an active group currently has focus (receives input).
  const [activeLeafByGroup, setActiveLeafByGroup] = useState<Record<string, string>>({});
  // Live drag state: which tab is being dragged, which leaf it's hovering over, which edge zone.
  const [dragOver, setDragOver] = useState<{ tabId: string; targetTabId: string | null; zone: DropZone | null } | null>(null);
  // Pointer position for rendering the floating drag ghost.
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const workAreaRef = useRef<HTMLDivElement>(null);
  const groupCounterRef = useRef(1);

  // Stable DOM host per terminal tab — owned imperatively so React's reconciliation never
  // destroys them. Each host receives a portal-rendered <TerminalTab/> and is physically
  // reparented into the right slot (or the parking area) after every layout render.
  const terminalHostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const parkingRef = useRef<HTMLDivElement>(null);
  const ensureHost = useCallback((tabId: string) => {
    let host = terminalHostsRef.current.get(tabId);
    if (!host) {
      host = document.createElement("div");
      host.className = "terminal-host";
      host.style.width = "100%";
      host.style.height = "100%";
      host.style.display = "flex";
      terminalHostsRef.current.set(tabId, host);
    }
    return host;
  }, []);

  // Global capture-phase listener: when the user clicks anywhere inside a pane belonging
  // to a group, mark that leaf as the focused one. We do this at the document level so
  // xterm's own internal event handlers can't shadow it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return;
      const pane = tgt.closest("[data-group-leaf]") as HTMLElement | null;
      if (!pane) return;
      const leafId = pane.getAttribute("data-group-leaf");
      if (!leafId) return;
      const tab = tabsRef.current.find(t => t.id === leafId);
      if (!tab?.groupId) return;
      setActiveLeafByGroup(prev => (prev[tab.groupId!] === leafId ? prev : { ...prev, [tab.groupId!]: leafId }));
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Bump lastActiveAt on the currently focused tab whenever activeTabId or the focused
  // leaf inside a group changes. Powers the "recent" sort in the tab search dialog.
  useEffect(() => {
    const group = groupsRef.current.find(g => g.id === activeTabId);
    const id = group ? (activeLeafByGroup[activeTabId] || collectLeafIds(group.layout)[0]) : activeTabId;
    if (!id) return;
    const now = Date.now();
    setTabs(prev => {
      const found = prev.find(t => t.id === id);
      if (!found) return prev;
      return prev.map(t => t.id === id ? { ...t, lastActiveAt: now } : t);
    });
  }, [activeTabId, activeLeafByGroup]);

  // After each render: park every terminal host in its current slot (or the parking div).
  // Drop obsolete hosts for tabs that no longer exist.
  useLayoutEffect(() => {
    const liveIds = new Set(tabs.map(t => t.id));
    for (const [id, host] of Array.from(terminalHostsRef.current.entries())) {
      if (!liveIds.has(id)) {
        host.remove();
        terminalHostsRef.current.delete(id);
        continue;
      }
      const slot = document.querySelector(`[data-terminal-slot="${CSS.escape(id)}"]`) as HTMLElement | null;
      const target = slot || parkingRef.current;
      if (target && host.parentElement !== target) target.appendChild(host);
    }
  });

  // Derived: tab bar entries. A tab with groupId doesn't appear standalone — its group does.
  // Walking tabs in order yields a deterministic, order-preserving set of entries.
  // Memoized so the array reference is stable when tabs/groups don't change — the drag-reorder
  // hook in TabBar uses this as its `items` and would otherwise thrash its effect on every render.
  type Entry = { kind: "tab"; id: string; tab: Tab } | { kind: "group"; id: string; group: Group };
  const entries: Entry[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const t of tabs) {
      if (t.groupId) {
        if (seen.has(t.groupId)) continue;
        const g = groups.find(gr => gr.id === t.groupId);
        if (!g) continue; // orphaned groupId — defensive skip
        seen.add(t.groupId);
        out.push({ kind: "group", id: g.id, group: g });
      } else {
        out.push({ kind: "tab", id: t.id, tab: t });
      }
    }
    return out;
  }, [tabs, groups]);

  // Dissolve a group when it has 0 or 1 leaves left; 1-leaf groups are pointless.
  useEffect(() => {
    const dissolved: string[] = [];
    const updatedTabs: Tab[] = [];
    let changed = false;
    for (const g of groups) {
      const leaves = collectLeafIds(g.layout);
      if (leaves.length <= 1) {
        dissolved.push(g.id);
        changed = true;
      }
    }
    if (!changed) return;
    for (const t of tabs) {
      if (t.groupId && dissolved.includes(t.groupId)) updatedTabs.push({ ...t, groupId: undefined });
      else updatedTabs.push(t);
    }
    setTabs(updatedTabs);
    setGroups(prev => prev.filter(g => !dissolved.includes(g.id)));
    // If the active entry was a dissolved group, switch to the remaining leaf (or home).
    if (dissolved.includes(activeTabIdRef.current)) {
      const survivors = tabs.filter(t => t.groupId && dissolved.includes(t.groupId));
      setActiveTabId(survivors[0]?.id || "home");
    }
  }, [groups, tabs]);

  // Drop a tab into the current work area. If `targetTabId` is a standalone tab, a new
  // group is created containing both. If it's inside a group, the dragged tab is inserted.
  const performDrop = useCallback((draggedTabId: string, targetTabId: string, zone: DropZone) => {
    if (draggedTabId === targetTabId) return;
    const dragged = tabsRef.current.find(t => t.id === draggedTabId);
    const target = tabsRef.current.find(t => t.id === targetTabId);
    if (!dragged || !target) return;
    if (dragged.groupId) return; // Already in a group — not allowed to re-add without removing first.

    if (target.groupId) {
      // Insert into the target's existing group.
      const group = groupsRef.current.find(g => g.id === target.groupId);
      if (!group) return;
      if (countLeaves(group.layout) >= MAX_GROUP_LEAVES) return;
      const newLayout = insertLeaf(group.layout, targetTabId, draggedTabId, zone);
      setGroups(prev => prev.map(g => g.id === group.id ? { ...g, layout: newLayout } : g));
      setTabs(prev => prev.map(t => t.id === draggedTabId ? { ...t, groupId: group.id } : t));
      setActiveTabId(group.id);
      setActiveLeafByGroup(prev => ({ ...prev, [group.id]: draggedTabId }));
    } else {
      // Both tabs are standalone → create a new group with both.
      const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const name = `Group ${groupCounterRef.current++}`;
      const direction: "col" | "row" = zone === "left" || zone === "right" ? "col" : "row";
      const draggedLeaf: LayoutNode = { kind: "leaf", tabId: draggedTabId };
      const targetLeaf: LayoutNode = { kind: "leaf", tabId: targetTabId };
      const children: [LayoutNode, LayoutNode] = zone === "left" || zone === "top"
        ? [draggedLeaf, targetLeaf]
        : [targetLeaf, draggedLeaf];
      const layout: LayoutNode = { kind: "split", direction, children, ratio: 0.5 };
      setGroups(prev => [...prev, { id, name, layout }]);
      setTabs(prev => prev.map(t => (t.id === draggedTabId || t.id === targetTabId) ? { ...t, groupId: id } : t));
      setActiveTabId(id);
      setActiveLeafByGroup(prev => ({ ...prev, [id]: draggedTabId }));
    }
  }, []);

  // Close a pane in a group — removes the underlying tab entirely (matches the
  // expectation that × closes that terminal, not just ejects it).
  const closePaneInGroup = useCallback((tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab?.groupId) return;
    const group = groupsRef.current.find(g => g.id === tab.groupId);
    if (!group) return;
    const nextLayout = removeLeaf(group.layout, tabId);
    if (nextLayout) {
      setGroups(prev => prev.map(g => g.id === group.id ? { ...g, layout: nextLayout } : g));
      // If the closed pane was the focused leaf, advance focus to another surviving leaf.
      setActiveLeafByGroup(prev => {
        if (prev[group.id] !== tabId) return prev;
        const survivors = collectLeafIds(nextLayout).filter(id => id !== tabId);
        const next = { ...prev };
        if (survivors.length) next[group.id] = survivors[0];
        else delete next[group.id];
        return next;
      });
    } else {
      setGroups(prev => prev.filter(g => g.id !== group.id));
      setActiveLeafByGroup(prev => { const n = { ...prev }; delete n[group.id]; return n; });
    }
    setTabs(prev => prev.filter(t => t.id !== tabId));
  }, []);

  // Adjust a split's ratio at the given path in the active group's layout tree.
  const updateGroupRatio = useCallback((groupId: string, path: number[], ratio: number) => {
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      const next = setRatioAt(g.layout, path, ratio);
      return { ...g, layout: next };
    }));
  }, []);

  // ── Drag from tab bar → drop on a pane in the work area ───────
  // One pointerdown listener at the app level. It avoids touching useDragReorder so
  // intra-tab-bar reordering still works; once the pointer leaves the tab bar, we
  // enter split-drag mode and start painting drop zones over the pane under the cursor.
  useEffect(() => {
    let startTabId: string | null = null;
    let startX = 0, startY = 0;
    let dragging = false;

    // Find which leaf pane (and which zone of it) the pointer is over.
    const zoneAt = (x: number, y: number): { targetTabId: string | null; zone: DropZone | null } => {
      const area = workAreaRef.current;
      if (!area) return { targetTabId: null, zone: null };
      const areaRect = area.getBoundingClientRect();
      if (x < areaRect.left || x > areaRect.right || y < areaRect.top || y > areaRect.bottom) {
        return { targetTabId: null, zone: null };
      }
      // Pane-aware: if the active entry is a group, we want the specific pane the user
      // is over. Single-tab work areas carry a data-group-leaf on the wrapper.
      const hits = document.elementsFromPoint(x, y);
      let paneEl: HTMLElement | null = null;
      for (const el of hits) {
        const e = el as HTMLElement;
        if (e.dataset && e.dataset.groupLeaf) { paneEl = e; break; }
      }
      if (!paneEl) return { targetTabId: null, zone: null };
      const r = paneEl.getBoundingClientRect();
      const relX = (x - r.left) / r.width;
      const relY = (y - r.top) / r.height;
      // Split the pane into 4 triangles by its diagonals — every point inside the pane
      // falls into exactly one zone, so there's no dead middle.
      const dx = relX - 0.5;
      const dy = relY - 0.5;
      const zone: DropZone = Math.abs(dx) > Math.abs(dy)
        ? (dx < 0 ? "left" : "right")
        : (dy < 0 ? "top" : "bottom");
      return { targetTabId: paneEl.dataset.groupLeaf || null, zone };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const tgt = e.target as HTMLElement | null;
      if (!tgt || tgt.closest(".tab-item-close")) return;
      const item = tgt.closest(".tab-item[data-drag-id]") as HTMLElement | null;
      if (!item) return;
      const id = item.getAttribute("data-drag-id");
      if (!id) return;
      startTabId = id;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!startTabId) return;
      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (!dragging && dist > 10) dragging = true;
      if (!dragging) return;
      const { targetTabId, zone } = zoneAt(e.clientX, e.clientY);
      // If the pointer is still inside the tab bar (no pane under it), let the intra-bar
      // reorder hook own the gesture — don't churn App state or show the split-drag ghost.
      // Return prev from the setters so React bails out (Object.is equality → no re-render).
      setDragOver(prev => {
        if (!prev && !targetTabId) return prev;
        return { tabId: startTabId!, targetTabId, zone };
      });
      setDragPos(prev => {
        if (!targetTabId && !prev) return prev;
        return { x: e.clientX, y: e.clientY };
      });
    };
    const onUp = (e: PointerEvent) => {
      if (startTabId && dragging) {
        const { targetTabId, zone } = zoneAt(e.clientX, e.clientY);
        if (targetTabId && zone) performDrop(startTabId, targetTabId, zone);
      }
      startTabId = null;
      dragging = false;
      setDragOver(null);
      setDragPos(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [performDrop]);

  // Sidebar only collapses via explicit user action (button in sidebar top, or chevron in TabBar).

  // Current project context: active terminal's project, or selected project on the project view.
  // Null on home (no context → hide + and dropdown).
  const contextProject: ProjectInfo | null = (() => {
    if (activeTabProjectPath) {
      return allProjects.find(p => p.path.toLowerCase() === activeTabProjectPath.toLowerCase())
        || (activeTab?.projectName ? { name: activeTab.projectName, path: activeTabProjectPath, encoded_name: "", session_count: 0, last_active: "" } : null);
    }
    if (selectedProject) return selectedProject;
    return null;
  })();

  const handleNewChatInActive = useCallback(() => {
    if (contextProject) handleNewChat(contextProject);
  }, [contextProject, handleNewChat]);

  // The + button in the tab bar: always open a raw shell using the user's default shell,
  // cwd = context project (or home if none).
  const handleNewShellInContext = useCallback(() => {
    const shell = getShellById(defaultShell);
    handleNewShell(contextProject, defaultShell, shell?.name || "Shell");
  }, [contextProject, defaultShell, handleNewShell]);

  // Group-aware tab selection: a tab inside a group requires activating its group AND
  // marking that pane as the focused leaf. Standalone tabs and groups themselves fall
  // through to a plain setActiveTabId. Used by both the tab bar and the search dialog.
  const handleSelectTab = useCallback((id: string) => {
    const tab = tabsRef.current.find(t => t.id === id);
    if (tab?.groupId) {
      setActiveTabId(tab.groupId);
      setActiveLeafByGroup(prev => ({ ...prev, [tab.groupId!]: id }));
    } else {
      setActiveTabId(id);
    }
  }, []);

  return (
    <div className={`app-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar projects={userProjects} projectIcons={projectIcons} selectedProject={selectedProject} activeCountByProject={activeCountByProject} sidebarLayout={sidebarLayout} onLayoutChange={persistSidebarLayout} onSelectProject={handleSelectProject} onGoHome={handleGoHome} onRemoveProject={handleRemoveProject} onEditProject={(p) => setEditingProjectPath(p)} onHoverProject={setHoveredProjectPath} onOpenSettings={() => setActiveTabId("settings")} onAddProject={() => setShowProjectPicker(true)} onCollapse={() => setSidebarCollapsed(true)} activeTabId={activeTabId} linkedProjectPath={activeTabProjectPath} showRateLimit={showRateLimitInSidebar} updateAvailable={updateInfo.updateAvailable} />
      <div className="main-content">
        <TabBar tabs={tabs} entries={entries} onRenameGroup={(id, name) => setGroups(prev => prev.map(g => g.id === id ? { ...g, name } : g))} closingTabIds={closingTabIds} activeTabId={activeTabId} selectedProject={selectedProject} hoveredProjectPath={hoveredProjectPath} linkedProjectPath={activeTabProjectPath} activeTabProject={contextProject} openSessionIds={new Set(tabs.filter(t => t.sessionId).map(t => t.sessionId!))} projectIcons={projectIcons} pinnedProjects={userProjects} sidebarCollapsed={sidebarCollapsed} defaultShell={defaultShell} onExpandSidebar={() => setSidebarCollapsed(false)} onSelectTab={handleSelectTab} onCloseTab={handleCloseTab} onReorderTabs={handleReorderTabs} onNewChat={handleNewChat} onNewChatInActive={handleNewChatInActive} onNewShellInContext={handleNewShellInContext} onOpenSession={handleOpenSession} onNewShell={handleNewShell} onGoHome={handleGoHome} onOpenSettings={() => setActiveTabId("settings")} onToggleSidebar={() => setSidebarCollapsed(c => !c)} />
        {/* Settings view — hidden unless activeTabId === 'settings' */}
        <div style={{ display: showSettings ? "flex" : "none", flex: 1, overflow: "hidden" }}>
          <SettingsView theme={theme} onSetTheme={persistTheme} gitLazyPolling={gitLazyPolling} onSetGitLazyPolling={persistGitLazyPolling} gitPanelFilenamesOnly={gitPanelFilenamesOnly} onSetGitPanelFilenamesOnly={persistGitPanelFilenamesOnly} contextTreeEnabled={contextTreeEnabled} onSetContextTreeEnabled={persistContextTreeEnabled} terminalBgColor={terminalBgColor} onSetTerminalBgColor={persistTerminalBgColor} defaultTerminalFontSize={defaultTerminalFontSize} onSetDefaultTerminalFontSize={persistDefaultTerminalFontSize} alwaysOnTop={alwaysOnTop} onSetAlwaysOnTop={persistAlwaysOnTop} defaultShell={defaultShell} onSetDefaultShell={persistDefaultShell} fullscreenRendering={fullscreenRendering} onSetFullscreenRendering={persistFullscreenRendering} forceSyncOutput={forceSyncOutput} onSetForceSyncOutput={persistForceSyncOutput} webglRendering={webglRendering} onSetWebglRendering={persistWebglRendering} eagerInitTabs={eagerInitTabs} onSetEagerInitTabs={persistEagerInitTabs} showRateLimitInSidebar={showRateLimitInSidebar} onSetShowRateLimitInSidebar={persistShowRateLimitInSidebar} showSessionRowMetrics={showSessionRowMetrics} onSetShowSessionRowMetrics={persistShowSessionRowMetrics} showTerminalHeaderStats={showTerminalHeaderStats} onSetShowTerminalHeaderStats={persistShowTerminalHeaderStats} showProjectStatsChart={showProjectStatsChart} onSetShowProjectStatsChart={persistShowProjectStatsChart} updateInfo={updateInfo} />
        </div>
        {/* Home view — hidden when a terminal tab is active */}
        <div style={{ display: showHome ? "flex" : "none", flex: 1, overflow: "hidden" }}>
          <HomeView contextTreeEnabled={contextTreeEnabled} showSessionRowMetrics={showSessionRowMetrics} showProjectStatsChart={showProjectStatsChart} projects={userProjects} allProjects={allProjects} selectedProject={selectedProject} projectIcons={projectIcons} recentSessions={recentSessions} projectSessions={projectSessions} openSessionIds={new Set(tabs.filter(t => t.sessionId).map(t => t.sessionId!))} sessionGroupName={(() => {
            const map: Record<string, string> = {};
            for (const t of tabs) {
              if (t.sessionId && t.groupId) {
                const g = groups.find(gr => gr.id === t.groupId);
                if (g) map[t.sessionId] = g.name;
              }
            }
            return map;
          })()} loading={initialLoading} sessionsLoading={sessionsLoading} projectStatsView={projectStatsView} onChangeProjectStatsView={persistProjectStatsView} onOpenSession={handleOpenSession} onOpenSessionBackground={handleOpenSessionBackground} onSelectProject={handleSelectProject} onNewChat={handleNewChat} onAddProject={() => setShowProjectPicker(true)} onRemoveProject={handleRemoveProject} onEditProject={(p) => setEditingProjectPath(p)} onSaveFolders={handleSaveFolders} />
        </div>
        {/* Work area — shows the active entry (either a single tab or a group's split layout).
            Terminal DOM hosts (created imperatively below) are physically reparented into
            the relevant slots on each layout change; the TerminalTab React instance stays
            alive throughout, so its xterm + PTY are never re-spawned. */}
        <div ref={workAreaRef} className="work-area" style={{ display: showSettings || showHome ? "none" : "flex", flex: 1, overflow: "hidden", position: "relative" }}>
          {/* Standalone tabs render a bare slot (no React-level TerminalTab here). */}
          {tabs.filter(t => !t.groupId).map(tab => (
            <div key={tab.id} data-group-leaf={tab.id} className="work-pane" style={{ display: tab.id === activeTabId ? "flex" : "none" }}>
              <div className="terminal-slot" data-terminal-slot={tab.id} />
            </div>
          ))}
          {/* Group panes — the GroupView also renders slot divs for its leaves. */}
          {groups.map(g => {
            const isActive = g.id === activeTabId;
            const activeLeafId = activeLeafByGroup[g.id] || collectLeafIds(g.layout)[0] || null;
            return (
              <div key={g.id} className="work-pane" style={{ display: isActive ? "flex" : "none" }}>
                <GroupView
                  layout={g.layout}
                  activeLeafId={activeLeafId}
                  onFocusLeaf={(tabId) => setActiveLeafByGroup(prev => ({ ...prev, [g.id]: tabId }))}
                  onClosePane={closePaneInGroup}
                  onRatioChange={(path, ratio) => updateGroupRatio(g.id, path, ratio)}
                />
              </div>
            );
          })}
          {dragOver && dragOver.targetTabId && dragOver.zone && (
            <DropZoneOverlay targetTabId={dragOver.targetTabId} zone={dragOver.zone} />
          )}
        </div>

        {/* Floating drag ghost — a small pill with the dragged tab's label that follows the
            cursor while the user is dragging a tab into the work area. */}
        {dragOver && dragPos && (() => {
          const t = tabs.find(x => x.id === dragOver.tabId);
          if (!t) return null;
          const label = t.title || t.projectName || "Tab";
          return (
            <div className="tab-drag-ghost" style={{ top: dragPos.y + 12, left: dragPos.x + 14 }}>
              <span className="tab-drag-ghost-dot" />
              <span className="tab-drag-ghost-label">{label}</span>
              {t.projectName && <span className="tab-drag-ghost-sub">{t.projectName}</span>}
            </div>
          );
        })()}

        {/* Hidden parking area for terminal hosts that currently have no visible slot
            (inactive tabs, groups in the background). Keeps the React tree stable. */}
        <div ref={parkingRef} style={{ display: "none" }} aria-hidden />

        {/* Portal each TerminalTab into its stable DOM host. Because the host is a plain
            DOM node (not managed by React's child reconciliation for the work area),
            we can appendChild it into whichever slot corresponds to its current layout
            position without triggering an unmount — the xterm and PTY keep running. */}
        {tabs.map(tab => {
          const host = ensureHost(tab.id);
          // Look up the encoded claude-projects dir name for this tab's project so the
          // TerminalTab can pull cost/context stats. Empty string when the project hasn't
          // been seen by claude yet — TerminalTab handles that by hiding the stats strip.
          const encodedName = tab.projectPath
            ? (allProjects.find(p => p.path.toLowerCase() === tab.projectPath!.toLowerCase())?.encoded_name || "")
            : "";
          // The third arg is the portal's key — without it, this array reconciles by index,
          // so reordering tabs shuffles which host each portal targets and React remounts
          // the subtree (which kills the PTY in TerminalTab's cleanup). Keying by tab.id
          // makes a reorder a pure move — the TerminalTab instance, xterm, and PTY survive.
          return createPortal(
            <TerminalTab tab={tab} isActive={tab.id === activeTabId || (!!tab.groupId && tab.groupId === activeTabId && activeLeafByGroup[tab.groupId] === tab.id)} gitLazyPolling={gitLazyPolling} gitPanelFilenamesOnly={gitPanelFilenamesOnly} terminalBgColor={terminalBgColor} defaultFontSize={defaultTerminalFontSize} defaultShellId={defaultShell} fullscreenRendering={fullscreenRendering} forceSyncOutput={forceSyncOutput} webglRendering={webglRendering} eagerInit={eagerInitTabs} theme={theme} projectEncodedName={encodedName} showTerminalHeaderStats={showTerminalHeaderStats} onBranchSwitch={handleSwitchTabToBranch} />,
            host,
            tab.id,
          );
        })}
      </div>
      {showProjectPicker && <ProjectPicker allProjects={allProjects} savedPaths={savedPaths} onToggle={handleToggleProject} onBrowse={() => { handleBrowseFolder(); setShowProjectPicker(false); }} onClose={() => setShowProjectPicker(false)} onRefresh={async () => { try { setAllProjects(await invoke<ProjectInfo[]>("list_claude_projects")); } catch (_) {} }} />}
      {editingProjectPath && (() => {
        const proj = allProjects.find(p => p.path.toLowerCase() === editingProjectPath.toLowerCase()) || userProjects.find(p => p.path.toLowerCase() === editingProjectPath.toLowerCase());
        if (!proj) { setEditingProjectPath(null); return null; }
        const settings = projectIcons[editingProjectPath.toLowerCase()] || {};
        return <ProjectEditorDialog project={proj} settings={settings} onSave={(s) => handleSaveProjectSettings(editingProjectPath, s)} onClose={() => setEditingProjectPath(null)} />;
      })()}
      {updateDialogOpen && <UpdateDialog info={updateInfo} onDismiss={dismissUpdateDialog} />}
    </div>
  );
}
