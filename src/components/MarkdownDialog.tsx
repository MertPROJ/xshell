import { useEffect, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, FolderOpen } from "lucide-react";
import { useTooltip, ttProps } from "./Tooltip";

interface Props { path: string | null; title?: string; onClose: () => void }

// Strip YAML frontmatter (--- ... ---) from the start of a markdown document.
function stripFrontmatter(src: string): string {
  if (!src.startsWith("---")) return src;
  const end = src.indexOf("\n---", 3);
  if (end === -1) return src;
  return src.slice(end + 4).replace(/^\s*\n/, "");
}

// Inline markdown: **bold**, *italic*, `code`, [text](url).
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={`${keyPrefix}-t-${i++}`}>{text.slice(last, m.index)}</span>);
    if (m[2]) out.push(<strong key={`${keyPrefix}-b-${i++}`}>{m[2]}</strong>);
    else if (m[4]) out.push(<em key={`${keyPrefix}-i-${i++}`}>{m[4]}</em>);
    else if (m[6]) out.push(<code key={`${keyPrefix}-c-${i++}`}>{m[6]}</code>);
    else if (m[8]) out.push(<a key={`${keyPrefix}-l-${i++}`} href={m[9]} target="_blank" rel="noreferrer">{m[8]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={`${keyPrefix}-t-${i++}`}>{text.slice(last)}</span>);
  return out;
}

// Minimal block-level markdown renderer: headings, paragraphs, lists, fenced code, hr.
function renderMarkdown(src: string): ReactNode[] {
  const lines = src.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={`b-${k++}`}><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    // Horizontal rule
    if (/^\s*---\s*$/.test(line)) { blocks.push(<hr key={`b-${k++}`} />); i++; continue; }
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const Tag = (`h${lvl}` as unknown) as keyof React.JSX.IntrinsicElements;
      blocks.push(<Tag key={`b-${k++}`}>{renderInline(h[2], `h${k}`)}</Tag>);
      i++; continue;
    }
    // List (- item / * item / 1. item)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(<ListTag key={`b-${k++}`}>{items.map((it, idx) => <li key={`li-${k}-${idx}`}>{renderInline(it, `li${k}${idx}`)}</li>)}</ListTag>);
      continue;
    }
    // Blank line
    if (line.trim() === "") { i++; continue; }
    // Paragraph (collect until blank / block starter)
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push(<p key={`b-${k++}`}>{renderInline(buf.join(" "), `p${k}`)}</p>);
  }
  return blocks;
}

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
