import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, RefreshCw, Folder, ArrowUp, Search, X as XIcon, FolderOpen, Terminal as TerminalIcon } from "lucide-react";
import type { DirItem } from "../types";
import { AgentIcon, type AgentId } from "../agents";
import { fileIconUrl, folderIconUrl } from "../lib/fileIcons";

// Agent config folders get their brand icon instead of a generic folder — a little flourish
// so `.claude` / `.codex` / `.cursor` are recognizable at a glance. Matched by exact name.
const AGENT_DIRS: Record<string, AgentId> = { ".claude": "claude", ".codex": "codex", ".cursor": "cursor" };
function agentForDir(item: DirItem): AgentId | null { return item.is_dir ? (AGENT_DIRS[item.name.toLowerCase()] ?? null) : null; }

// Hover-tooltip delay for tree rows — they shouldn't pop the instant the cursor crosses a
// row (that's noisy when scanning a folder). Header action buttons keep an instant tooltip.
const TOOLTIP_DELAY_MS = 1000;

// Dnd mime carrying an item's absolute path. The terminal body listens for a drop of this
// type and writes the path into the active PTY — see TerminalTab's onDrop handler.
export const DRAG_PATH_MIME = "application/x-xshell-path";

// Wrap paths containing whitespace in double quotes so they survive being typed at a shell
// prompt (Windows paths routinely have spaces). A trailing space lets the user keep typing.
function pathForTerminal(p: string): string { return /\s/.test(p) ? `"${p}" ` : `${p} `; }

function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  const b = i >= 0 ? t.slice(i + 1) : t;
  return b || t; // "C:\" -> "C:"
}

// Parent directory, or null when already at a filesystem root (drive root on Windows, "/").
function parentOf(p: string): string | null {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  if (i < 0) return null;          // "C:" — no parent
  if (i === 0) return "/";         // unix "/home" -> "/"
  const parent = t.slice(0, i);
  return /^[a-zA-Z]:$/.test(parent) ? parent + "\\" : parent; // "C:" -> "C:\"
}

// Directory portion of a search hit, relative to the search root — shown dimmed after the
// name so the user can tell two same-named files apart. Empty for top-level hits.
function relDir(fullPath: string, root: string, name: string): string {
  let p = fullPath.startsWith(root) ? fullPath.slice(root.length) : fullPath;
  p = p.replace(/^[\\/]+/, "");
  if (p.toLowerCase().endsWith(name.toLowerCase())) p = p.slice(0, p.length - name.length);
  return p.replace(/[\\/]+$/, "");
}


interface RowProps {
  item: DirItem;
  depth: number;
  expanded?: boolean;      // undefined → no chevron (files, and flat search hits)
  active: boolean;         // right-click target — kept highlighted while its menu is open
  subtitle?: string;
  onActivate: () => void;
  onContext: (x: number, y: number, item: DirItem) => void;
  showTt: (text: string, el: HTMLElement) => void;
  hideTt: () => void;
}

// Single presentational row, shared by the tree and the flat search results.
function FileRow({ item, depth, expanded, active, subtitle, onActivate, onContext, showTt, hideTt }: RowProps) {
  const agent = agentForDir(item);
  const iconUrl = agent ? "" : item.is_dir ? folderIconUrl(item.name, !!expanded) : fileIconUrl(item.name);
  const tip = item.is_dir ? item.path : `${item.path} — click to reveal · drag to terminal`;
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_PATH_MIME, item.path);
    e.dataTransfer.setData("text/plain", item.path);
    e.dataTransfer.effectAllowed = "copy";
  };
  return (
    <div
      className={`file-row ${active ? "file-row-active" : ""}`}
      style={{ paddingLeft: 6 + depth * 12 }}
      draggable
      onClick={onActivate}
      onDragStart={onDragStart}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY, item); }}
      onMouseEnter={(e) => showTt(tip, e.currentTarget)}
      onMouseLeave={hideTt}
    >
      <span className="file-chev">{item.is_dir && expanded !== undefined && <ChevronRight size={12} className={expanded ? "open" : ""} />}</span>
      {agent ? <AgentIcon agent={agent} size={16} className="file-icon" /> : <img className="file-icon" src={iconUrl} alt="" draggable={false} />}
      <span className="file-name">{item.name}</span>
      {subtitle && <span className="file-row-sub">{subtitle}</span>}
    </div>
  );
}

interface NodeProps {
  item: DirItem;
  depth: number;
  tick: number;
  activePath: string | null;
  onReveal: (path: string) => void;
  onContext: (x: number, y: number, item: DirItem) => void;
  showTt: (text: string, el: HTMLElement) => void;
  hideTt: () => void;
}

// One tree row + its lazily-loaded children. Children load on first expand and then stay
// mounted (height-collapsed) so the open/close height transition is smooth and re-expanding
// is instant. The grid-rows trick (0fr↔1fr) animates to the children's natural height.
function Node({ item, depth, tick, activePath, onReveal, onContext, showTt, hideTt }: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded || children !== null) return;
    let alive = true;
    setLoading(true);
    invoke<DirItem[]>("list_dir", { path: item.path })
      .then((c) => { if (alive) setChildren(c); })
      .catch(() => { if (alive) setChildren([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [expanded, item.path, children]);

  // Silent re-pull on each poll tick (only for an open, already-loaded folder) so additions /
  // deletions inside it show up live. Collapsed or unloaded folders are skipped.
  useEffect(() => {
    if (tick === 0 || !expanded || children === null) return;
    let alive = true;
    invoke<DirItem[]>("list_dir", { path: item.path }).then((c) => { if (alive) setChildren(c); }).catch(() => {});
    return () => { alive = false; };
  }, [tick]);

  const onActivate = () => { if (item.is_dir) setExpanded((v) => !v); else onReveal(item.path); };
  const childPad = 6 + (depth + 1) * 12 + 14;

  return (
    <>
      <FileRow item={item} depth={depth} expanded={item.is_dir ? expanded : undefined} active={activePath === item.path} onActivate={onActivate} onContext={onContext} showTt={showTt} hideTt={hideTt} />
      {item.is_dir && (
        <div className={`file-children ${expanded ? "open" : ""}`}>
          <div className="file-children-inner">
            {children === null
              ? (loading && expanded ? <div className="file-row file-row-muted" style={{ paddingLeft: childPad }}>Loading…</div> : null)
              : children.length === 0
                ? <div className="file-row file-row-muted" style={{ paddingLeft: childPad }}>Empty</div>
                : children.map((c) => <Node key={c.path} item={c} depth={depth + 1} tick={tick} activePath={activePath} onReveal={onReveal} onContext={onContext} showTt={showTt} hideTt={hideTt} />)}
          </div>
        </div>
      )}
    </>
  );
}

interface PanelProps {
  rootPath: string;
  terminalId: string;
  visible: boolean;
  showTt: (text: string, el: HTMLElement) => void;
  hideTt: () => void;
}

// Inner content of the file-explorer side panel — header (current dir + up/search/refresh) and
// a scrollable area showing either the lazy tree or flat search results. TerminalTab wraps this
// in the shared `.terminal-side-panel` + splitter, mirroring how the git panel is hosted.
export function FileExplorerPanel({ rootPath, terminalId, visible, showTt, hideTt }: PanelProps) {
  // The browsable root. Starts at the terminal's cwd but the up-button can climb past it.
  const [cwd, setCwd] = useState(rootPath);
  const [roots, setRoots] = useState<DirItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; item: DirItem } | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset to the terminal's cwd if the tab's project path changes underneath us.
  useEffect(() => { setCwd(rootPath); }, [rootPath]);

  const load = useCallback((silent = false) => {
    if (!silent) setRefreshing(true);
    invoke<DirItem[]>("list_dir", { path: cwd })
      .then(setRoots)
      .catch(() => setRoots([]))
      .finally(() => { if (!silent) setRefreshing(false); });
  }, [cwd]);

  useEffect(() => { load(); }, [load]);

  // Poll for filesystem changes while the panel is visible (the agent adds/removes files, etc.)
  // so the tree updates without a manual refresh. `tick` is threaded into every Node so expanded
  // sub-folders re-pull too; list_dir is async (off the UI thread) so this stays cheap. Silent
  // (no spinner) and paused while hidden or searching.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible || searchOpen) return;
    setTick(t => t + 1); // refresh right away on (re)show, then keep polling
    const id = window.setInterval(() => setTick(t => t + 1), 2500);
    return () => window.clearInterval(id);
  }, [visible, searchOpen]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { if (tick > 0) loadRef.current(true); }, [tick]);

  // Debounced recursive search rooted at the current dir; empty query falls back to the tree.
  useEffect(() => {
    if (!searchOpen) return;
    const q = query.trim();
    if (!q) { setResults(null); setSearching(false); return; }
    setSearching(true);
    const t = window.setTimeout(() => {
      invoke<DirItem[]>("search_dir", { root: cwd, query: q, limit: 300 })
        .then(setResults).catch(() => setResults([])).finally(() => setSearching(false));
    }, 220);
    return () => window.clearTimeout(t);
  }, [query, searchOpen, cwd]);

  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  // Escape closes the context menu first, then the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (ctx) { setCtx(null); return; }
      if (searchOpen) { setSearchOpen(false); setQuery(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx, searchOpen]);

  const reveal = useCallback((path: string) => { invoke("reveal_in_explorer", { path }).catch(() => {}); }, []);
  const writePath = useCallback((path: string) => { invoke("write_terminal", { id: terminalId, data: pathForTerminal(path) }).catch(() => {}); }, [terminalId]);
  const openContext = useCallback((x: number, y: number, item: DirItem) => setCtx({ x, y, item }), []);

  // Tooltip with a hover delay (tree/search rows). The timer is cleared on leave so it never
  // fires for a row the cursor has already left.
  const ttTimer = useRef<number | null>(null);
  const showTtDelayed = useCallback((text: string, el: HTMLElement) => {
    if (ttTimer.current) window.clearTimeout(ttTimer.current);
    ttTimer.current = window.setTimeout(() => showTt(text, el), TOOLTIP_DELAY_MS);
  }, [showTt]);
  const hideTtNow = useCallback(() => { if (ttTimer.current) window.clearTimeout(ttTimer.current); hideTt(); }, [hideTt]);
  useEffect(() => () => { if (ttTimer.current) window.clearTimeout(ttTimer.current); }, []);

  const parent = parentOf(cwd);
  const activePath = ctx?.item.path ?? null;
  const showingSearch = searchOpen && query.trim().length > 0;

  return (
    <>
      <div className="git-panel-header file-panel-header">
        <Folder size={13} className="file-panel-folder" />
        <span className="file-panel-title" onMouseEnter={(e) => showTt(cwd, e.currentTarget)} onMouseLeave={hideTt}>{baseName(cwd)}</span>
        <button className="git-panel-refresh" disabled={!parent} onClick={() => parent && setCwd(parent)} onMouseEnter={(e) => showTt(parent ? "Go to parent folder" : "At filesystem root", e.currentTarget)} onMouseLeave={hideTt}><ArrowUp size={12} /></button>
        <button className={`git-panel-refresh ${searchOpen ? "active" : ""}`} onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(""); }} onMouseEnter={(e) => showTt("Search", e.currentTarget)} onMouseLeave={hideTt}><Search size={12} /></button>
        <button className={`git-panel-refresh ${refreshing ? "spinning" : ""}`} onClick={() => load()} onMouseEnter={(e) => showTt("Refresh", e.currentTarget)} onMouseLeave={hideTt}><RefreshCw size={11} /></button>
      </div>
      {/* Always mounted; the grid-rows trick animates it open/closed smoothly (same approach
          as the folder expand/collapse). Input is taken out of the tab order while collapsed. */}
      <div className={`file-search-wrap ${searchOpen ? "open" : ""}`}>
        <div className="file-search-inner">
          <div className="file-search-bar">
            <Search size={12} className="file-search-icon" />
            <input ref={searchInputRef} className="file-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this folder…" spellCheck={false} tabIndex={searchOpen ? 0 : -1} />
            {searching && <span className="file-search-spinner" />}
            {query && <button className="file-search-clear" onClick={() => { setQuery(""); searchInputRef.current?.focus(); }} aria-label="Clear"><XIcon size={12} /></button>}
          </div>
        </div>
      </div>
      <div className="file-tree-scroll">
        {showingSearch ? (
          searching && results === null ? <div className="file-searching"><span className="file-search-spinner" /><span>Searching…</span></div>
          : results && results.length === 0 ? <div className="git-panel-empty">No matches</div>
          : (results || []).map((item) => {
              const sub = relDir(item.path, cwd, item.name);
              const onActivate = () => { if (item.is_dir) { setCwd(item.path); setSearchOpen(false); setQuery(""); } else reveal(item.path); };
              return <FileRow key={item.path} item={item} depth={0} active={activePath === item.path} subtitle={sub || undefined} onActivate={onActivate} onContext={openContext} showTt={showTtDelayed} hideTt={hideTtNow} />;
            })
        ) : (
          <>
            {roots === null && <div className="git-panel-empty">Loading…</div>}
            {roots !== null && roots.length === 0 && <div className="git-panel-empty">Empty folder</div>}
            {roots?.map((item) => <Node key={item.path} item={item} depth={0} tick={tick} activePath={activePath} onReveal={reveal} onContext={openContext} showTt={showTtDelayed} hideTt={hideTtNow} />)}
          </>
        )}
      </div>
      {ctx && (
        <>
          <div className="file-ctx-backdrop" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
          <div className="file-ctx-menu" style={{ left: Math.min(ctx.x, window.innerWidth - 220), top: Math.min(ctx.y, window.innerHeight - 80) }}>
            <button className="file-ctx-item" onClick={() => { reveal(ctx.item.path); setCtx(null); }}><FolderOpen size={13} /><span>Reveal in folder</span></button>
            <button className="file-ctx-item" onClick={() => { writePath(ctx.item.path); setCtx(null); }}><TerminalIcon size={13} /><span>Write path to terminal</span></button>
          </div>
        </>
      )}
    </>
  );
}
