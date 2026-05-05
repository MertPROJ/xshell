import claudeCodeIcon from "../assets/claudecode-color.svg";

interface ClaudeChatIconProps {
  size?: number;
  className?: string;
}

// Visual marker for "this row represents a Claude Code session" — replaces the `$` prompt
// glyph that was previously used in session rows, the recent-sessions dropdown, and the
// quick actions dialog.
export function ClaudeChatIcon({ size = 14, className }: ClaudeChatIconProps) {
  return <img src={claudeCodeIcon} width={size} height={size} className={className} alt="" draggable={false} />;
}
