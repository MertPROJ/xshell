import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, FolderPlus, Search } from "lucide-react";
import type { CodexProjectInfo, ProjectInfo } from "../types";
import { ClaudeChatIcon } from "./ClaudeChatIcon";
import { OpenAIIcon } from "./OpenAIIcon";
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

// One row per directory where a coding agent has been used. Claude Code rows come from
// ~/.claude/projects (via the allProjects prop, owned by App), Codex rows from
// ~/.codex/sessions rollout metadata (fetched here — the picker is the only consumer).
// A directory both agents know collapses into a single row carrying both marks.
interface PickerRow {
  path: string;
  name: string;
  claude?: ProjectInfo;
  codex?: CodexProjectInfo;
  lastActive: string;
}

export function ProjectPicker({ allProjects, savedPaths, onToggle, onBrowse, onClose, onRefresh }: ProjectPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [codexProjects, setCodexProjects] = useState<CodexProjectInfo[]>([]);
  const [filter, setFilter] = useState("");
  const { tt, Tooltip } = useTooltip();

  // Refresh both agents' lists every time the dialog is opened so directories used since
  // app start (or since the last open) appear without requiring a restart.
  useEffect(() => {
    onRefresh?.();
    invoke<CodexProjectInfo[]>("list_codex_projects").then(setCodexProjects).catch(() => {});
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
    for (const p of allProjects) {
      map.set(normalizePath(p.path), { path: p.path, name: p.name, claude: p, lastActive: p.last_active });
    }
    for (const c of codexProjects) {
      const key = normalizePath(c.path);
      const existing = map.get(key);
      if (existing) {
        existing.codex = c;
        if (c.last_active > existing.lastActive) existing.lastActive = c.last_active;
      } else {
        const name = c.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || c.path;
        map.set(key, { path: c.path, name, codex: c, lastActive: c.last_active });
      }
    }
    const list = [...map.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    const q = filter.trim().toLowerCase();
    return q ? list.filter(r => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : list;
  }, [allProjects, codexProjects, filter]);

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
                  {row.claude && (
                    <span className="picker-agent" {...ttProps(tt, `${row.claude.session_count} Claude Code session${row.claude.session_count === 1 ? "" : "s"}`)}><ClaudeChatIcon size={13} /></span>
                  )}
                  {row.codex && (
                    <span className="picker-agent" {...ttProps(tt, `${row.codex.session_count} Codex session${row.codex.session_count === 1 ? "" : "s"}`)}><OpenAIIcon size={12} /></span>
                  )}
                  <span className="picker-item-count" {...ttProps(tt, "Total sessions in this directory")}>{(row.claude?.session_count ?? 0) + (row.codex?.session_count ?? 0)}</span>
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
