import { ReactNode } from "react";

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
// Pair the returned nodes with the `.md-content` class to inherit the existing typography.
export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={`b-${k++}`}><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    if (/^\s*---\s*$/.test(line)) { blocks.push(<hr key={`b-${k++}`} />); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const Tag = (`h${lvl}` as unknown) as keyof React.JSX.IntrinsicElements;
      blocks.push(<Tag key={`b-${k++}`}>{renderInline(h[2], `h${k}`)}</Tag>);
      i++; continue;
    }
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
    if (line.trim() === "") { i++; continue; }
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push(<p key={`b-${k++}`}>{renderInline(buf.join(" "), `p${k}`)}</p>);
  }
  return blocks;
}

// Strip YAML frontmatter (--- ... ---) from the start of a markdown document.
export function stripFrontmatter(src: string): string {
  if (!src.startsWith("---")) return src;
  const end = src.indexOf("\n---", 3);
  if (end === -1) return src;
  return src.slice(end + 4).replace(/^\s*\n/, "");
}
