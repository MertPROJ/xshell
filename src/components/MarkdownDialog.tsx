import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, FolderOpen } from "lucide-react";
import { useTooltip, ttProps } from "./Tooltip";
import { renderMarkdown, stripFrontmatter } from "../markdown";

interface Props { path: string | null; title?: string; onClose: () => void }

export function MarkdownDialog({ path, title, onClose }: Props) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tt, Tooltip } = useTooltip();

  useEffect(() => {
    if (!path) return;
    setLoading(true); setError(null); setContent("");
    invoke<string>("read_text_file", { path })
      .then(setContent)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, onClose]);

  if (!path) return null;
  const body = stripFrontmatter(content);
  return (
    <div className="md-overlay" onClick={onClose}>
      <div className="md-dialog" onClick={e => e.stopPropagation()}>
        <div className="md-head">
          <span className="md-title">{title || path.split(/[\\/]/).pop()}</span>
          <button className="md-head-btn" onClick={() => invoke("reveal_in_explorer", { path }).catch(() => {})} {...ttProps(tt, "Reveal in Explorer")}><FolderOpen size={13} /></button>
          <button className="md-head-btn" onClick={onClose} {...ttProps(tt, "Close")}><X size={14} /></button>
        </div>
        <div className="md-body">
          {loading && <div className="md-status">Loading…</div>}
          {error && <div className="md-status md-status-error">{error}</div>}
          {!loading && !error && <div className="md-content">{renderMarkdown(body)}</div>}
        </div>
      </div>
      {Tooltip}
    </div>
  );
}
