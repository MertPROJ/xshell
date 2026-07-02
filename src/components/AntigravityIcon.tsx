import antigravityIcon from "../assets/antigravity.png";

interface AntigravityIconProps {
  size?: number;
  className?: string;
}

// Google Antigravity logo — a full-color PNG, so it renders as an <img> (no currentColor),
// same pattern as CursorIcon.
export function AntigravityIcon({ size = 14, className }: AntigravityIconProps) {
  return <img src={antigravityIcon} width={size} height={size} className={className} alt="" draggable={false} />;
}
