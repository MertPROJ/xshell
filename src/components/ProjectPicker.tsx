import { useEffect, useRef } from "react";
import { FolderOpen, Check, FolderPlus } from "lucide-react";
import type { ProjectInfo } from "../types";

interface ProjectPickerProps {
  allProjects: ProjectInfo[];
  savedPaths: string[];
  onToggle: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
  onRefresh?: () => void;
}

export function ProjectPicker({ allProjects, savedPaths, onToggle, onBrowse, onClose, onRefresh }: ProjectPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Refresh the list every time the dialog is opened so projects created since app start
  // (or since the last open) appear without requiring a restart.
  useEffect(() => { onRefresh?.(); }, []);

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

  const isChecked = (path: string) => savedPaths.some(p => p.toLowerCase() === path.toLowerCase());

  return (
    <div className="picker-overlay">
      <div className="picker" ref={ref}>
        <div className="picker-header">Add Projects</div>
        <div className="picker-desc">These are Claude Code projects recognized on your machine. Tick the ones to pin to the sidebar.</div>

        <div className="picker-list">
          {allProjects.map(project => (
            <div key={project.encoded_name} className={`picker-item ${isChecked(project.path) ? "checked" : ""}`} onClick={() => onToggle(project.path)}>
              <div className="picker-check">
                {isChecked(project.path) && <Check size={12} />}
              </div>
              <FolderOpen size={14} className="picker-folder-icon" />
              <div className="picker-item-info">
                <div className="picker-item-name">{project.name}</div>
                <div className="picker-item-path">{project.path}</div>
              </div>
              <div className="picker-item-count">{project.session_count}</div>
            </div>
          ))}
          {allProjects.length === 0 && (
            <div className="picker-empty">No Claude Code sessions found on this machine.</div>
          )}
        </div>

        <div className="picker-footer">
          <button className="btn" onClick={onBrowse}><FolderPlus size={12} /> Browse...</button>
        </div>
      </div>
    </div>
  );
}
