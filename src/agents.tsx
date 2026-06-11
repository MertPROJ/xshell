import { ClaudeChatIcon } from "./components/ClaudeChatIcon";
import { OpenAIIcon } from "./components/OpenAIIcon";

// ── Agent registry ─────────────────────────────────────────────────────
// Single source of truth for the coding agents xshell knows about. Adding an agent means:
// extending this registry (id, label, icon, binary), adding its Rust-side session/context
// parsing in lib.rs, and allowlisting its binary in detect_agent_binary — the UI surfaces
// (session rows, dropdowns, pickers, settings) all render from here.

export type AgentId = "claude" | "codex";

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
  claude: { id: "claude", label: "Claude Code", binary: "claude", tagline: "Anthropic's coding agent CLI", neutralIcon: false },
  codex:  { id: "codex",  label: "Codex",       binary: "codex",  tagline: "OpenAI's coding agent CLI",   neutralIcon: true },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

export function AgentIcon({ agent, size = 14, className }: { agent: AgentId | undefined; size?: number; className?: string }) {
  if (agent === "codex") return <OpenAIIcon size={size} className={className} />;
  return <ClaudeChatIcon size={size} className={className} />;
}
