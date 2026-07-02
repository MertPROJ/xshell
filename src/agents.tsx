import { ClaudeChatIcon } from "./components/ClaudeChatIcon";
import { OpenAIIcon } from "./components/OpenAIIcon";
import { CursorIcon } from "./components/CursorIcon";
import { OpencodeIcon } from "./components/OpencodeIcon";
import { AntigravityIcon } from "./components/AntigravityIcon";

// ── Agent registry ─────────────────────────────────────────────────────
// Single source of truth for the coding agents xshell knows about. Adding an agent means:
// extending this registry (id, label, icon, binary), adding its Rust-side session/context
// parsing in lib.rs, and allowlisting its binary in detect_agent_binary — the UI surfaces
// (session rows, dropdowns, pickers, settings) all render from here.

export type AgentId = "claude" | "codex" | "cursor" | "opencode" | "antigravity";

export interface AgentMeta {
  id: AgentId;
  label: string;       // display name, e.g. "Claude Code"
  binary: string;      // CLI binary probed by detect_agent_binary
  tagline: string;     // short descriptor used in settings / pickers
  // True when the icon draws with currentColor and needs a neutral text color instead of
  // the terracotta accent classes designed around the Claude mark.
  neutralIcon: boolean;
}

export const AGENTS: Record<AgentId, AgentMeta> = {
  claude: { id: "claude", label: "Claude Code", binary: "claude",       tagline: "Anthropic's coding agent CLI", neutralIcon: false },
  codex:  { id: "codex",  label: "Codex",       binary: "codex",        tagline: "OpenAI's coding agent CLI",    neutralIcon: true },
  cursor: { id: "cursor", label: "Cursor",      binary: "cursor-agent", tagline: "Cursor's coding agent CLI",    neutralIcon: false },
  opencode: { id: "opencode", label: "opencode", binary: "opencode",    tagline: "The open-source coding agent CLI", neutralIcon: true },
  antigravity: { id: "antigravity", label: "Antigravity", binary: "agy", tagline: "Google's coding agent CLI",       neutralIcon: false },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

export function AgentIcon({ agent, size = 14, className }: { agent: AgentId | undefined; size?: number; className?: string }) {
  if (agent === "codex") return <OpenAIIcon size={size} className={className} />;
  if (agent === "cursor") return <CursorIcon size={size} className={className} />;
  if (agent === "opencode") return <OpencodeIcon size={size} className={className} />;
  if (agent === "antigravity") return <AntigravityIcon size={size} className={className} />;
  return <ClaudeChatIcon size={size} className={className} />;
}
