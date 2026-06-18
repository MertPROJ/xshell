import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, FolderPlus, Search } from "lucide-react";
import type { CodexProjectInfo, ProjectInfo } from "../types";
import { AGENT_IDS, AGENTS, AgentIcon, type AgentId } from "../agents";
import { useTooltip, ttProps } from "./Tooltip";
import { normalizePath } from "../utils";

interface ProjectPickerProps {
  allProjects: ProjectInfo[];
  savedPaths: string[];
  onToggle: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
  onRefresh?: () => void;
}

// One row per directory where a coding agent has been used. Claude rows come from
// ~/.claude/projects (the allProjects prop, owned by App); Codex and Cursor are fetched
// here (the picker is their only consumer). A directory several agents know collapses into
// a single row carrying each agent's mark + session count.
interface PickerRow {
  path: string;
  name: string;
  counts: Partial<Record<AgentId, number>>; // sessions per agent in this directory
  lastActive: string;
}

export function ProjectPicker({ allProjects, savedPaths, onToggle, onBrowse, onClose, onRefresh }: ProjectPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [codexProjects, setCodexProjects] = useState<CodexProjectInfo[]>([]);
  const [cursorProjects, setCursorProjects] = useState<CodexProjectInfo[]>([]);
  const [filter, setFilter] = useState("");
  const { tt, Tooltip } = useTooltip();

  // Refresh every agent's list when the dialog opens so directories used since app start
  // (or since the last open) appear without requiring a restart.
  useEffect(() => {
    onRefresh?.();
    invoke<CodexProjectInfo[]>("list_codex_projects").then(setCodexProjects).catch(() => {});
    invoke<CodexProjectInfo[]>("list_cursor_projects").then(setCursorProjects).catch(() => {});
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [onClose]);

  const rows = useMemo(() => {
    const map = new Map<string, PickerRow>();
    // Fold one agent's directory list into the row map: create-or-merge by normalized path,
    // record the agent's session count, and keep the freshest activity timestamp.
    const fold = (agent: AgentId, path: string, sessionCount: number, lastActive: string) => {
      const key = normalizePath(path);
      const existing = map.get(key);
      if (existing) {
        existing.counts[agent] = sessionCount;
        if (lastActive > existing.lastActive) existing.lastActive = lastActive;
      } else {
        const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
        map.set(key, { path, name, counts: { [agent]: sessionCount }, lastActive });
      }
    };
    for (const p of allProjects) fold("claude", p.path, p.session_count, p.last_active);
    for (const c of codexProjects) fold("codex", c.path, c.session_count, c.last_active);
    for (const c of cursorProjects) fold("cursor", c.path, c.session_count, c.last_active);
    const list = [...map.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    const q = filter.trim().toLowerCase();
    return q ? list.filter(r => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : list;
  }, [allProjects, codexProjects, cursorProjects, filter]);

  const isChecked = (path: string) => savedPaths.some(p => normalizePath(p) === normalizePath(path));

  return (
    <div className="picker-overlay">
      <div className="picker" ref={ref}>
        <div className="picker-band">
          <span className="picker-band-label">Add Projects</span>
        </div>

        <div className="picker-head">
          <div className="picker-title">Pin projects to your sidebar</div>
          <div className="picker-sub">Every directory where a coding agent has been used on this machine. The marks on the right show which agent has sessions there.</div>
        </div>

        <div className="picker-search">
          <Search size={12} />
          <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${rows.length || ""} directories…`} spellCheck={false} />
        </div>

        <div className="picker-listwrap">
          <span className="corner-dot corner-dot-tl" aria-hidden />
          <span className="corner-dot corner-dot-tr" aria-hidden />
          <span className="corner-dot corner-dot-bl" aria-hidden />
          <span className="corner-dot corner-dot-br" aria-hidden />
          <div className="picker-list">
            {rows.map(row => (
              <div key={row.path} className={`picker-item ${isChecked(row.path) ? "checked" : ""}`} onClick={() => onToggle(row.path)}>
                <div className="picker-check">
                  {isChecked(row.path) && <Check size={12} />}
                </div>
                <div className="picker-item-info">
                  <div className="picker-item-name">{row.name}</div>
                  <div className="picker-item-path" {...ttProps(tt, row.path)}>{row.path}</div>
                </div>
                <div className="picker-item-agents">
                  {AGENT_IDS.filter(id => row.counts[id]).map(id => (
                    <span key={id} className="picker-agent" {...ttProps(tt, `${row.counts[id]} ${AGENTS[id].label} session${row.counts[id] === 1 ? "" : "s"}`)}><AgentIcon agent={id} size={12} /></span>
                  ))}
                  <span className="picker-item-count" {...ttProps(tt, "Total sessions in this directory")}>{AGENT_IDS.reduce((sum, id) => sum + (row.counts[id] ?? 0), 0)}</span>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="picker-empty">{filter.trim() ? "No directories match your filter." : "No coding agent sessions found on this machine."}</div>
            )}
          </div>
        </div>

        <div className="picker-footer">
          <span className="picker-footer-hint">Missing one? Pin any folder manually.</span>
          <button className="btn" onClick={onBrowse}><FolderPlus size={12} /> Browse…</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
      {Tooltip}
    </div>
  );
}
