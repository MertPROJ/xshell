// Brand-style icons for known shells. Small rounded squares with shell-specific glyph + color.
// Avoids pulling in a full brand-icon package for just a handful of icons.

interface Props { size?: number; className?: string }

function Wrap({ size = 14, bg, children, className }: Props & { bg: string; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="4" fill={bg} />
      {children}
    </svg>
  );
}

export function PowerShellIcon(p: Props) {
  return (
    <Wrap {...p} bg="#012456">
      <path d="M5 7L10 12L5 17" stroke="#CBE0FF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="11" y1="18" x2="18" y2="18" stroke="#CBE0FF" strokeWidth="2" strokeLinecap="round" />
    </Wrap>
  );
}

export function CmdIcon(p: Props) {
  return (
    <Wrap {...p} bg="#1E1E1E">
      <path d="M6 8L9 12L6 16" stroke="#E5E5E5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="10" y1="16" x2="17" y2="16" stroke="#E5E5E5" strokeWidth="1.8" strokeLinecap="round" />
    </Wrap>
  );
}

export function GitBashIcon(p: Props) {
  return (
    <Wrap {...p} bg="#F05033">
      <text x="6" y="17" fontSize="11" fill="white" fontWeight="700" fontFamily="monospace">$_</text>
    </Wrap>
  );
}

export function BashIcon(p: Props) {
  return (
    <Wrap {...p} bg="#4EAA25">
      <text x="6" y="17" fontSize="11" fill="white" fontWeight="700" fontFamily="monospace">$_</text>
    </Wrap>
  );
}

export function ZshIcon(p: Props) {
  return (
    <Wrap {...p} bg="#4B4B4B">
      <text x="5" y="17" fontSize="10" fill="#FFD166" fontWeight="700" fontFamily="monospace">%_</text>
    </Wrap>
  );
}

export function FishIcon(p: Props) {
  return (
    <Wrap {...p} bg="#75F3E9">
      <text x="4" y="17" fontSize="11" fill="#1a1a1a" fontWeight="700" fontFamily="monospace">&gt;_</text>
    </Wrap>
  );
}

export function ShellIcon({ id, size, className }: { id?: string; size?: number; className?: string }) {
  switch (id) {
    case "powershell": return <PowerShellIcon size={size} className={className} />;
    case "cmd":        return <CmdIcon size={size} className={className} />;
    case "gitbash":    return <GitBashIcon size={size} className={className} />;
    case "bash":       return <BashIcon size={size} className={className} />;
    case "zsh":        return <ZshIcon size={size} className={className} />;
    case "fish":       return <FishIcon size={size} className={className} />;
    default:           return <BashIcon size={size} className={className} />;
  }
}
