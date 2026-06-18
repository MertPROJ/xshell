import cursorIcon from "../assets/cursor-ai.png";

interface CursorIconProps {
  size?: number;
  className?: string;
}

// Cursor agent CLI logo — a full-color PNG, so it renders as an <img> (no currentColor),
// same pattern as ClaudeChatIcon.
export function CursorIcon({ size = 14, className }: CursorIconProps) {
  return <img src={cursorIcon} width={size} height={size} className={className} alt="" draggable={false} />;
}
