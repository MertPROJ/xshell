import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface Props { text: string; label?: string }

// Inline copy-on-click code snippet. Body has `user-select: none` app-wide so a plain `<code>`
// can't be selected; this exposes a button that drops the command on the clipboard with a
// transient "Copied!" tick. The visible text is whatever the caller passes (`label` defaults
// to `text`) so we can keep the displayed string short while copying the full command.
export function CodeCopy({ text, label }: Props) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch (_) { /* clipboard API unavailable — silently no-op */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button type="button" className={`code-copy ${copied ? "code-copy-flash" : ""}`} onClick={onClick} title="Click to copy">
      <code className="code-copy-text">{label || text}</code>
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}
