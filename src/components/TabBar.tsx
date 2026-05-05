import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Minus, Square, X as XIcon, Plus, ChevronDown, ChevronLeft, ChevronRight, Terminal as TerminalIcon, Command } from "lucide-react";
import { ShellIcon } from "./ShellIcon";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { timeAgo, processSessions } from "../utils";
import type { ProjectInfo, ProjectSettings, SessionInfo, Tab, Group } from "../types";
import { getAvailableShells } from "../shells";
import { collectLeafIds } from "../layout";
import { Layers } from "lucide-react";
import { useDragReorder } from "../hooks/useDragReorder";
import { QuickActionsDialog } from "./QuickActionsDialog";
import { ClaudeChatIcon } from "./ClaudeChatIcon";

// Tab bar shows tabs and groups interleaved. A group is one "entry" representing
// its bundled tabs; the individual tabs inside it don't appear standalone.
export type TabBarEntry = { kind: "tab"; id: string; tab: Tab } | { kind: "group"; id: string; group: Group };

interface TabBarProps {
  tabs: Tab[];
  entries: TabBarEntry[];
  closingTabIds: Set<string>;
  activeTabId: string;
  selectedProject: ProjectInfo | null;
  hoveredProjectPath: string | null;
  linkedProjectPath: string | null;
  activeTabProject: ProjectInfo | null;
  openSessionIds: Set<string>;
  projectIcons: Record<string, ProjectSettings>;
  pinnedProjects: ProjectInfo[];
  sidebarCollapsed: boolean;
  defaultShell: string;
  onExpandSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onReorderTabs: (tabs: Tab[]) => void;
  onNewChat: (project: ProjectInfo) => void;
  onNewChatInActive: () => void;
  onNewShellInContext: () => void;
  onOpenSession: (session: SessionInfo, project: ProjectInfo) => void;
  onNewShell: (project: ProjectInfo | null, shellId: string, shellName: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onGoHome: () => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}

function RecentSessionsDropdown({ project, displayName, openSessionIds, anchorRect, anchorEl, onPick, onPickShell, onNewChat, onClose }: { project: ProjectInfo | null; displayName: string; openSessionIds: Set<string>; anchorRect: DOMRect; anchorEl: HTMLElement; onPick: (s: SessionInfo) => void; onPickShell: (shellId: string, shellName: string) => void; onNewChat: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);

  // Fetch fresh sessions on open (only when a project is in context)
  useEffect(() => {
    if (!project?.encoded_name) { setSessions([]); return; }
    invoke<SessionInfo[]>("get_sessions", { encodedName: project.encoded_name })
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [project?.encoded_name]);

  // Close on click outside (ignore clicks on the anchor so toggling works)
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

  // Filter out sessions that are already open in tabs
  const filtered = (sessions || []).filter(s => !openSessionIds.has(s.id));
  const sorted = processSessions(filtered).slice(0, 5);

  // Prefer opening rightward from the anchor (readable when anchor is far left).
  // Fall back to leftward anchoring only if the dropdown would overflow the viewport.
  const dropdownWidth = 280; // matches .tab-dropdown min-width
  const top = anchorRect.bottom + 4;
  const canOpenRight = anchorRect.left + dropdownWidth + 4 <= window.innerWidth;
  const positionStyle: React.CSSProperties = canOpenRight
    ? { top, left: Math.max(4, anchorRect.left) }
    : { top, right: Math.max(4, window.innerWidth - anchorRect.right) };

  const shells = getAvailableShells();
  // If there's no project, collapsing the shells makes no sense — there's nothing else in the dropdown.
  const [shellsOpen, setShellsOpen] = useState(!project);

  return (
    <div className="tab-dropdown" ref={ref} style={positionStyle}>
      {project && (
        <>
          <div className="tab-dropdown-item" onClick={() => { onNewChat(); onClose(); }}>
            <ClaudeChatIcon size={14} className="tab-dropdown-shell-icon" />
            <div className="tab-dropdown-item-content">
              <div className="tab-dropdown-item-title">New chat in {displayName}</div>
            </div>
          </div>
          <div className="tab-dropdown-divider" />
        </>
      )}
      <div className={`tab-dropdown-group-header ${shellsOpen ? "open" : ""}`} onClick={() => setShellsOpen(v => !v)}>
        <ChevronRight size={11} className="tab-dropdown-group-chev" />
        <TerminalIcon size={11} />
        <span className="tab-dropdown-group-label">{project ? "Start new shell" : "Start new shell in ~"}</span>
        <span className="tab-dropdown-group-count">{shells.length}</span>
      </div>
      {shellsOpen && (
        <div className="tab-dropdown-group-body">
          {shells.map(sh => (
            <div key={sh.id} className="tab-dropdown-item tab-dropdown-item-nested" onClick={() => { onPickShell(sh.id, sh.name); onClose(); }}>
              <ShellIcon id={sh.id} size={14} />
              <div className="tab-dropdown-item-content">
                <div className="tab-dropdown-item-title">{sh.name}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {project && (
        <>
          <div className="tab-dropdown-divider" />
          <div className="tab-dropdown-header">Recent in {displayName}</div>
          {sessions === null && <div className="tab-dropdown-loading"><div className="spinner-small" /></div>}
          {sessions !== null && sorted.length === 0 && <div className="tab-dropdown-empty">{sessions.length === 0 ? "No sessions yet" : "All sessions are already open"}</div>}
          {sorted.map(s => (
            <div key={s.id} className="tab-dropdown-item" onClick={() => { onPick(s); onClose(); }}>
              <ClaudeChatIcon size={13} className="tab-dropdown-prompt" />
              <div className="tab-dropdown-item-content">
                <div className="tab-dropdown-item-title">{s.title}</div>
                <div className="tab-dropdown-item-time">{timeAgo(s.timestamp)}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function TabTooltip({ text, rect }: { text: string; rect: DOMRect }) {
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

export function TabBar({ tabs, entries, closingTabIds, activeTabId, selectedProject, hoveredProjectPath, linkedProjectPath, activeTabProject, openSessionIds, projectIcons, pinnedProjects, sidebarCollapsed, defaultShell, onExpandSidebar, onSelectTab, onCloseTab, onReorderTabs, onNewChat, onNewChatInActive, onNewShellInContext, onOpenSession, onNewShell, onRenameGroup, onGoHome, onOpenSettings, onToggleSidebar }: TabBarProps) {
  const appWindow = getCurrentWindow();
  const highlightPath = hoveredProjectPath || linkedProjectPath || selectedProject?.path || null;
  const [dropdown, setDropdown] = useState<{ rect: DOMRect; el: HTMLElement } | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const shortcutLabel = isMac ? "⌘ K" : "Ctrl K";

  // Global Cmd/Ctrl+K toggles the tab search dialog. Capture-phase + preventDefault so
  // the active terminal (xterm) doesn't also see the keystroke as kill-to-end-of-line.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(v => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isMac]);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const commitRename = () => {
    if (renamingGroupId) {
      const trimmed = renameDraft.trim();
      if (trimmed) onRenameGroup(renamingGroupId, trimmed);
    }
    setRenamingGroupId(null);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  // Reorder tabs/groups within the bar. We reorder at the entry level (treating each
  // group as an atomic slot), then expand back to a flat `tabs` array so the existing
  // entry-derivation in App.tsx reproduces the new order.
  const handleEntryReorder = useCallback((newEntries: TabBarEntry[]) => {
    const tabsById = new Map(tabs.map(t => [t.id, t]));
    const tabsByGroup = new Map<string, Tab[]>();
    for (const t of tabs) {
      if (t.groupId) {
        const list = tabsByGroup.get(t.groupId) || [];
        list.push(t);
        tabsByGroup.set(t.groupId, list);
      }
    }
    const next: Tab[] = [];
    for (const e of newEntries) {
      if (e.kind === "tab") {
        const t = tabsById.get(e.id);
        if (t) next.push(t);
      } else {
        // Group entry — splice in all member tabs together (preserves intra-group order).
        const members = tabsByGroup.get(e.id) || [];
        for (const t of members) next.push(t);
      }
    }
    if (next.length === tabs.length) onReorderTabs(next);
  }, [tabs, onReorderTabs]);

  const { dragIdx, overIdx, onPointerDown: onEntryPointerDown } = useDragReorder<TabBarEntry>({
    items: entries,
    direction: "horizontal",
    itemSelector: ".tab-item[data-idx]",
    onReorder: handleEntryReorder,
  });

  const checkOverflow = () => {
    const el = scrollRef.current;
    if (!el) return;
    const hasOverflow = el.scrollWidth > el.clientWidth + 1;
    setOverflow({
      left: hasOverflow && el.scrollLeft > 2,
      right: hasOverflow && el.scrollLeft < el.scrollWidth - el.clientWidth - 2,
    });
  };

  useLayoutEffect(() => {
    checkOverflow();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    el.addEventListener("scroll", checkOverflow);
    return () => { ro.disconnect(); el.removeEventListener("scroll", checkOverflow); };
  }, [tabs.length]);

  const scrollBy = (delta: number) => scrollRef.current?.scrollBy({ left: delta, behavior: "smooth" });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector(".tab-item.active") as HTMLElement | null;
    if (active) {
      const elRect = el.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      if (activeRect.left < elRect.left) active.scrollIntoView({ block: "nearest", inline: "start", behavior: "smooth" });
      else if (activeRect.right > elRect.right) active.scrollIntoView({ block: "nearest", inline: "end", behavior: "smooth" });
    }
  }, [activeTabId]);

  const showTooltip = (text: string, el: HTMLElement) => setTooltip({ text, rect: el.getBoundingClientRect() });
  const hideTooltip = () => setTooltip(null);

  return (
    <div className="tab-bar">
      <button className={`tb-expand-sidebar ${sidebarCollapsed ? "show" : ""}`} onClick={onExpandSidebar} onMouseEnter={(e) => showTooltip("Show sidebar", e.currentTarget)} onMouseLeave={hideTooltip} tabIndex={sidebarCollapsed ? 0 : -1} aria-hidden={!sidebarCollapsed}>
        <ChevronRight size={13} />
      </button>
      <div className="tab-bar-scroll-wrapper">
        {overflow.left && (
          <button className="tab-scroll-btn tab-scroll-left" onClick={() => scrollBy(-200)}><ChevronLeft size={12} /></button>
        )}
        <div className="tab-bar-tabs" ref={scrollRef}>
          {entries.map((entry, i) => {
            const isDragging = dragIdx === i;
            const showDropBefore = dragIdx !== null && overIdx === i && overIdx !== dragIdx && overIdx !== dragIdx + 1;
            const showDropAfter = dragIdx !== null && overIdx === i + 1 && overIdx !== dragIdx && overIdx !== dragIdx + 1;
            if (entry.kind === "group") {
              const g = entry.group;
              const leafCount = collectLeafIds(g.layout).length;
              const isActive = g.id === activeTabId;
              const tooltipText = `${g.name} — ${leafCount} pane${leafCount === 1 ? "" : "s"}`;
              const isRenaming = renamingGroupId === g.id;
              const startRename = () => { setRenamingGroupId(g.id); setRenameDraft(g.name); setTooltip(null); };
              return (
                <div key={g.id} data-idx={i} className={`tab-item tab-group-item ${isActive ? "active" : ""} ${isDragging ? "tab-dragging" : ""}`} onPointerDown={(e) => onEntryPointerDown(e, i)} onClick={() => { if (!isRenaming) onSelectTab(g.id); }} onDoubleClick={startRename} onContextMenu={(e) => { e.preventDefault(); startRename(); }} onMouseEnter={(e) => { if (!isRenaming) setTooltip({ text: tooltipText, rect: e.currentTarget.getBoundingClientRect() }); }} onMouseLeave={() => setTooltip(null)}>
                  {showDropBefore && <div className="tab-drop-line tab-drop-line-before" />}
                  <Layers size={13} className="tab-group-icon" />
                  <div className="tab-item-text">
                    {isRenaming ? (
                      <input autoFocus className="tab-group-rename-input" value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenamingGroupId(null); }} onClick={(e) => e.stopPropagation()} />
                    ) : (
                      <span className="tab-item-title truncate">{g.name}</span>
                    )}
                    <span className="tab-item-project">{leafCount} panes</span>
                  </div>
                  <div className="tab-item-close" onClick={(e) => { e.stopPropagation(); onCloseTab(g.id); }}>
                    <X size={11} />
                  </div>
                  {showDropAfter && <div className="tab-drop-line tab-drop-line-after" />}
                </div>
              );
            }
            const tab = entry.tab;
            const matches = highlightPath && tab.projectPath && tab.projectPath.toLowerCase() === highlightPath.toLowerCase();
            const isClosing = closingTabIds.has(tab.id);
            const customName = tab.projectPath ? projectIcons[tab.projectPath.toLowerCase()]?.customName : undefined;
            const projectDisplayName = customName || tab.projectName || "";
            const isRawShell = tab.shellMode === "raw";
            const displayTitle = isRawShell ? (projectDisplayName || tab.title) : tab.title;
            const displaySubtitle = isRawShell ? tab.title : projectDisplayName;
            const tooltipText = displaySubtitle ? `${displayTitle} — ${displaySubtitle}` : displayTitle;
            return (
              <div key={tab.id} data-idx={i} data-drag-id={tab.id} className={`tab-item ${tab.id === activeTabId ? "active" : ""} ${isClosing ? "tab-closing" : ""} ${tab.shellMode === "raw" ? "tab-raw-shell" : ""} ${isDragging ? "tab-dragging" : ""}`} onPointerDown={(e) => onEntryPointerDown(e, i)} onClick={() => { if (!isClosing) onSelectTab(tab.id); }} onMouseEnter={(e) => setTooltip({ text: tooltipText, rect: e.currentTarget.getBoundingClientRect() })} onMouseLeave={() => setTooltip(null)}>
                {showDropBefore && <div className="tab-drop-line tab-drop-line-before" />}
                {isRawShell
                  ? <ShellIcon id={tab.shellId} size={14} className="tab-shell-icon" />
                  : <div className={`tab-dot ${matches ? "tab-dot-active" : ""}`} />}
                <div className="tab-item-text">
                  <span className="tab-item-title truncate">{displayTitle}</span>
                  {displaySubtitle && <span className="tab-item-project">{displaySubtitle}</span>}
                </div>
                <div className="tab-item-close" onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}>
                  <X size={11} />
                </div>
                {showDropAfter && <div className="tab-drop-line tab-drop-line-after" />}
              </div>
            );
          })}
        </div>
        {overflow.right && (
          <button className="tab-scroll-btn tab-scroll-right" onClick={() => scrollBy(200)}><ChevronRight size={12} /></button>
        )}
      </div>

      {(() => {
        const activeDisplayName = activeTabProject ? (projectIcons[activeTabProject.path.toLowerCase()]?.customName || activeTabProject.name) : null;
        const defaultShellName = activeTabProject
          ? `Open ${defaultShell} in ${activeDisplayName}`
          : `Open ${defaultShell} in home`;
        const dropdownTip = activeTabProject ? "New chat · recent sessions · shells" : "New shell";
        return (
          <div className="tab-actions">
            <button className="tab-action-btn" onClick={onNewShellInContext} onMouseEnter={(e) => showTooltip(defaultShellName, e.currentTarget)} onMouseLeave={hideTooltip}>
              <Plus size={12} />
            </button>
            <button className={`tab-action-btn ${dropdown ? "active" : ""}`} onClick={(e) => { const el = e.currentTarget as HTMLElement; setDropdown(prev => prev ? null : { rect: el.getBoundingClientRect(), el }); }} onMouseEnter={(e) => showTooltip(dropdownTip, e.currentTarget)} onMouseLeave={hideTooltip}>
              <ChevronDown size={12} />
            </button>
          </div>
        );
      })()}

      <div className="tab-bar-drag" data-tauri-drag-region />

      {tabs.length > 0 && (
        <button className={`tb-search-btn ${searchOpen ? "active" : ""}`} onClick={() => setSearchOpen(v => !v)} onMouseEnter={(e) => showTooltip(`Quick Actions (${shortcutLabel})`, e.currentTarget)} onMouseLeave={hideTooltip} aria-label="Quick Actions">
          <Command size={13} />
          <span className="tb-search-kbd">{shortcutLabel}</span>
        </button>
      )}

      <div className="window-controls">
        <button className="wc-btn" onClick={() => appWindow.minimize()}><Minus size={13} /></button>
        <button className="wc-btn" onClick={() => appWindow.toggleMaximize()}><Square size={10} /></button>
        <button className="wc-btn wc-close" onClick={() => appWindow.close()}><XIcon size={13} /></button>
      </div>

      {dropdown && (
        <RecentSessionsDropdown project={activeTabProject} displayName={activeTabProject ? (projectIcons[activeTabProject.path.toLowerCase()]?.customName || activeTabProject.name) : ""} openSessionIds={openSessionIds} anchorRect={dropdown.rect} anchorEl={dropdown.el} onPick={(s) => activeTabProject && onOpenSession(s, activeTabProject)} onPickShell={(id, name) => onNewShell(activeTabProject, id, name)} onNewChat={onNewChatInActive} onClose={() => setDropdown(null)} />
      )}

      {tooltip && <TabTooltip text={tooltip.text} rect={tooltip.rect} />}

      {searchOpen && (
        <QuickActionsDialog
          tabs={tabs}
          activeTabId={activeTabId}
          projectIcons={projectIcons}
          pinnedProjects={pinnedProjects}
          contextProject={activeTabProject}
          hoveredProjectPath={hoveredProjectPath}
          linkedProjectPath={linkedProjectPath}
          selectedProjectPath={selectedProject?.path || null}
          hasActiveTab={!!tabs.find(t => t.id === activeTabId)}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onNewChat={onNewChat}
          onNewShell={onNewShell}
          onGoHome={onGoHome}
          onOpenSettings={onOpenSettings}
          onToggleSidebar={onToggleSidebar}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
