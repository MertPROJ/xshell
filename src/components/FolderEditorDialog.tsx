import { useEffect, useRef, useState } from "react";
import { X, Folder as FolderIcon } from "lucide-react";
import type { SidebarFolder } from "../types";
import { ColorPicker } from "./ColorPicker";

interface Props {
  folder: SidebarFolder;
  onSave: (next: { name: string; color: string | undefined }) => void;
  onClose: () => void;
}

export function FolderEditorDialog({ folder, onSave, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(folder.name);
  const [color, setColor] = useState<string | undefined>(folder.color);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    requestAnimationFrame(() => nameInputRef.current?.select());
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSave = () => {
    const trimmed = name.trim() || "Folder";
    onSave({ name: trimmed, color });
    onClose();
  };

  // Preview tint — the folder header visual uses the custom color when set.
  const previewBg = color || "var(--bg-deep)";
  const previewIconColor = color ? "#ffffff" : "var(--accent-terracotta)";

  return (
    <div className="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-panel edit-folder-panel" ref={panelRef}>
        <div className="settings-header">
          <span>Edit Folder</span>
          <button className="settings-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="settings-body">
          <div className="edit-preview-row">
            <div style={{ width: 56, height: 56, borderRadius: 14, background: previewBg, display: "flex", alignItems: "center", justifyContent: "center", color: previewIconColor }}>
              <FolderIcon size={28} />
            </div>
            <div className="edit-preview-info">
              <div className="edit-preview-name">{name.trim() || "Folder"}</div>
              <div className="edit-preview-path">{folder.projectPaths.length} project{folder.projectPaths.length === 1 ? "" : "s"}</div>
            </div>
          </div>

          <div className="edit-field">
            <label className="edit-label">Folder name</label>
            <input ref={nameInputRef} className="edit-input" value={name} placeholder="Folder name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }} />
          </div>

          <div className="edit-field">
            <ColorPicker label="Folder Color" value={color} onChange={setColor} />
          </div>
        </div>
        <div className="settings-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
