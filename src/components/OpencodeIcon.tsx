interface OpencodeIconProps {
  size?: number;
  className?: string;
}

// opencode logo mark (path data from the official opencode-logo-light.svg). Inlined and
// recolored to currentColor — the source ships fixed light-theme colors that would draw
// near-black on the dark theme; the lighter inner panel keeps its two-tone look via opacity.
// The source canvas is 240x300, so the viewBox pads it to a centered square to align with
// the other (square) agent marks.
export function OpencodeIcon({ size = 14, className }: OpencodeIconProps) {
  return (
    <svg width={size} height={size} viewBox="-30 0 300 300" fill="none" className={className} aria-hidden="true">
      <path d="M180 240H60V120H180V240Z" fill="currentColor" opacity="0.45" />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="currentColor" />
    </svg>
  );
}
