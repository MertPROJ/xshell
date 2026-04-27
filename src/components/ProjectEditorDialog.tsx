import { useEffect, useRef, useState, useMemo } from "react";
import { X, Image as ImageIcon } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useProjectImage } from "../hooks/useProjectImage";
import { ColorPicker } from "./ColorPicker";
import type { ProjectInfo, ProjectSettings } from "../types";

const EMOJI_OPTIONS = ["\u{1F680}", "\u{1F527}", "\u{1F4E6}", "\u{1F3AF}", "\u{1F4A1}", "\u{1F9EA}", "\u{1F4CA}", "\u{1F310}", "\u{26A1}", "\u{1F3A8}", "\u{1F52C}", "\u{1F4F1}", "\u{1F5A5}\u{FE0F}", "\u{1F5C4}\u{FE0F}", "\u{1F6E0}\u{FE0F}", "\u{1F4DD}", "\u{1F4BB}", "\u{1F4D6}"];

type IconMode = "auto" | "letters" | "emoji" | "image";

function isLetterIcon(icon: string): boolean {
  return /^[\x20-\x7E]{1,4}$/.test(icon);
}

function detectMode(icon: string): IconMode {
  if (!icon) return "auto";
  if (icon.startsWith("img:")) return "image";
  if (isLetterIcon(icon)) return "letters";
  return "emoji";
}

function deriveInitials(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9\s\-_.]/g, "").split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function IconPreview({ mode, letters, emoji, imagePath, name, color, size = 56 }: { mode: IconMode; letters: string; emoji: string; imagePath: string; name: string; color?: string; size?: number }) {
  const imgSrc = useProjectImage(mode === "image" && imagePath ? `img:${imagePath}` : undefined);
  const bg = color || "var(--accent-terracotta)";
  if (mode === "image" && imgSrc) {
    return <img src={imgSrc} style={{ width: size, height: size, borderRadius: 14, objectFit: "cover" }} alt="" />;
  }
  let display = "";
  if (mode === "letters") display = letters || deriveInitials(name);
  else if (mode === "emoji") display = emoji || "\u{1F4E6}";
  else display = deriveInitials(name);
  const isEmoji = mode === "emoji";
  return (
    <div style={{ width: size, height: size, borderRadius: 14, background: bg, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-primary)", fontSize: isEmoji ? size * 0.5 : size * 0.36, fontWeight: 600 }}>
      {display}
    </div>
  );
}

interface Props {
  project: ProjectInfo;
  settings: ProjectSettings;
  onSave: (settings: ProjectSettings) => void;
  onClose: () => void;
}

export function ProjectEditorDialog({ project, settings, onSave, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const initialIcon = settings.icon || "";
  const initialMode = detectMode(initialIcon);

  const [name, setName] = useState(settings.customName || "");
  const [mode, setMode] = useState<IconMode>(initialMode);
  const [letters, setLetters] = useState(initialMode === "letters" ? initialIcon : "");
  const [emoji, setEmoji] = useState(initialMode === "emoji" ? initialIcon : "");
  const [imagePath, setImagePath] = useState(initialMode === "image" ? initialIcon.slice(4) : "");
  const [color, setColor] = useState<string | undefined>(settings.color);

  const effectiveName = useMemo(() => name.trim() || project.name, [name, project.name]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    // Auto-focus the name field for quick editing
    requestAnimationFrame(() => nameInputRef.current?.select());
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSave = () => {
    const trimmedName = name.trim();
    let icon = "";
    if (mode === "letters") icon = letters.trim().toUpperCase();
    else if (mode === "emoji") icon = emoji;
    else if (mode === "image" && imagePath) icon = `img:${imagePath}`;
    // Color is only meaningful for non-image icons; strip it when saving an image so old
    // settings don't leave a stray color field behind.
    const effectiveColor = mode === "image" ? undefined : color;
    onSave({ icon: icon || undefined, color: effectiveColor, customName: trimmedName || undefined });
    onClose();
  };

  const handlePickImage = async () => {
    try {
      const selected = await openDialog({ multiple: false, title: "Choose an image", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"] }] });
      if (selected && typeof selected === "string") setImagePath(selected);
    } catch (_) {}
  };

  return (
    <div className="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-panel edit-project-panel" ref={panelRef}>
        <div className="settings-header">
          <span>Edit Project</span>
          <button className="settings-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="settings-body">
          <div className="edit-preview-row">
            <IconPreview mode={mode} letters={letters} emoji={emoji} imagePath={imagePath} name={effectiveName} color={color} />
            <div className="edit-preview-info">
              <div className="edit-preview-name">{effectiveName}</div>
              <div className="edit-preview-path" title={project.path}>{project.path}</div>
            </div>
          </div>

          <div className="edit-field">
            <label className="edit-label">Display name</label>
            <input ref={nameInputRef} className="edit-input" value={name} placeholder={project.name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }} />
            <div className="edit-hint">Leave empty to use the folder name.</div>
          </div>

          <div className="edit-field">
            <label className="edit-label">Icon</label>
            <div className="edit-tabs">
              {(["auto", "letters", "emoji", "image"] as IconMode[]).map(m => (
                <button key={m} className={`edit-tab ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>
              ))}
            </div>

            {mode === "auto" && (
              <div className="edit-hint">Shows the first two letters of the name: <code>{deriveInitials(effectiveName)}</code></div>
            )}
            {mode === "letters" && (
              <input className="edit-input edit-letters-input" maxLength={4} value={letters} onChange={(e) => setLetters(e.target.value.toUpperCase())} placeholder={deriveInitials(effectiveName)} />
            )}
            {mode === "emoji" && (
              <div className="edit-emoji-grid">
                {EMOJI_OPTIONS.map((e, i) => (
                  <div key={i} className={`edit-emoji-item ${emoji === e ? "active" : ""}`} onClick={() => setEmoji(e)}>{e}</div>
                ))}
              </div>
            )}
            {mode === "image" && (
              <div className="edit-image-row">
                <button className="btn" onClick={handlePickImage}><ImageIcon size={12} /> {imagePath ? "Change image" : "Choose image..."}</button>
                {imagePath && <div className="edit-image-path" title={imagePath}>{imagePath}</div>}
              </div>
            )}
          </div>

          {/* Color only matters when the icon isn't an image — image icons render without a background. */}
          {mode !== "image" && (
            <div className="edit-field">
              <ColorPicker label="Icon color" value={color} onChange={setColor} />
            </div>
          )}
        </div>
        <div className="settings-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
