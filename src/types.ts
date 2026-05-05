export interface ProjectInfo {
  name: string;
  path: string;
  encoded_name: string;
  session_count: number;
  last_active: string;
}

export interface SessionFolder {
  id: string;
  name: string;
  collapsed?: boolean;
  sessionIds: string[];
}

export interface ProjectSettings {
  icon?: string;       // emoji, letters (e.g. "AB"), or "img:<path>". Empty string / missing = auto initials.
  color?: string;      // hex (e.g. "#3498DB") for icon background — ignored when icon is an image
  customName?: string; // user-supplied display name; falls back to ProjectInfo.name when empty
  folders?: SessionFolder[];
}

export interface SessionInfo {
  id: string;
  title: string;
  timestamp: string;
  message_count: number;          // counts user-prompted turns only
  project_name: string;
  project_path: string;
  git_branch: string;
  claude_version: string;
  tool_use_count: number;
  duration_ms: number;
  model: string;                  // raw model id from last assistant turn, e.g. "claude-opus-4-7-..."
  context_tokens: number;         // last assistant turn's input + cache_creation + cache_read
  context_limit: number;          // e.g. 200000
  cost_usd: number;               // 0 unless xshell-stats hook is set up; sourced from Claude Code's reported total
  is_authoritative_stats: boolean; // true when xshell-stats hook data exists for this session
  daily_cost: Record<string, number>; // { "YYYY-MM-DD": usd } from the hook; empty when no hook
  rate_limit_5h_pct: number | null;
  rate_limit_7d_pct: number | null;
}

export interface MessagePreview {
  role: string;
  text: string;
}

export interface GitFile {
  path: string;
  staged: string;
  unstaged: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  files: GitFile[];
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  subject: string;
  author: string;
  relative_time: string;
}

export interface GitBranch {
  name: string;                 // short name (e.g. "main" or "feature/foo")
  full_ref: string;             // "refs/heads/main" | "refs/remotes/origin/foo"
  is_current: boolean;
  is_remote: boolean;
  upstream: string;             // empty when none
  last_commit_subject: string;
  last_commit_relative: string; // "2 days ago", "3 hours ago", ...
}

export interface BranchInfo {
  new_session_id: string;
  title: string;
}

// ── Sidebar layout (Discord-style folders) ──────────────────────────
// Top-level sidebar is an ordered list of items: a project or a folder containing projects.
export interface SidebarFolder {
  kind: "folder";
  id: string;
  name: string;
  color?: string; // hex, e.g. "#c96442" — optional background tint for the folder pill
  collapsed: boolean;
  projectPaths: string[];
}

export interface SidebarProject {
  kind: "project";
  path: string;
}

export type SidebarItem = SidebarFolder | SidebarProject;

export interface Skill {
  name: string;
  scope: 'personal' | 'project' | 'plugin';
  description: string | null;
  path: string;
}

export interface McpInfo {
  name: string;
  kind: string;          // "http" | "stdio" | "sse" | "unknown"
  source: string;        // "user" | "project" | "plugin"
}

export interface Plugin {
  name: string;
  marketplace: string | null;
  version: string | null;
  description: string | null;
  scope: 'user' | 'local';
  enabled: boolean;
  path: string;
  skills: Skill[];
  mcps: McpInfo[];
}

export interface SubagentInfo {
  name: string;
  path: string;
  scope: 'user' | 'project';
  description: string | null;
}

export interface SlashCommand {
  name: string;            // without leading slash, e.g. "review" (file: review.md)
  path: string;
  scope: 'user' | 'project';
  description: string | null;
}

// A single hook entry from one of the settings files. `matcher` is the tool-name pattern
// (or null for events that don't have one, like Stop/UserPromptSubmit).
export interface HookEntry {
  event: string;              // e.g. "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"
  matcher: string | null;
  command: string;
  source: 'user' | 'project' | 'local';
  source_path: string;
}

export interface ClaudeMdFile {
  path: string;
  rel_path: string;           // "CLAUDE.md", "src/nested/CLAUDE.md", or "~/.claude/CLAUDE.md"
  scope: 'user' | 'project-root' | 'project-nested';
}

// One of the three settings files (user / project-shared / project-local). Precedence runs
// local > project > user — rendering order in the UI mirrors that (local on top).
export interface SettingsSource {
  scope: 'user' | 'project' | 'local';
  path: string;
  exists: boolean;
}

export interface ProjectSkills {
  personal_skills: Skill[];
  project_skills: Skill[];
  plugins: Plugin[];
  user_mcps: McpInfo[];
  project_mcps: McpInfo[];
  subagents: SubagentInfo[];
  slash_commands: SlashCommand[];
  hooks: HookEntry[];
  claude_md_files: ClaudeMdFile[];
  settings_sources: SettingsSource[];
}

export interface Memory {
  name: string;
  description: string;
  type: string;
  path: string;
}

export interface ProjectMemories {
  dir: string;
  items: Memory[];
}

export interface Tab {
  id: string;
  type: 'home' | 'terminal';
  title: string;
  sessionId?: string;
  customName?: string; // for new chats: passed to `claude -n <name>` so the session is trackable
  projectPath?: string;
  projectName?: string;
  encodedName?: string;
  shellMode?: 'claude' | 'raw'; // default 'claude'. 'raw' = plain shell, no claude command
  shellId?: string; // e.g. 'powershell', 'cmd', 'bash', 'zsh' — when shellMode='raw'
  groupId?: string; // when set, the tab is a member of a group (not standalone in the tab bar)
}

// Binary layout tree for a group's split view. Leaves point at tab ids.
export interface LayoutLeaf { kind: 'leaf'; tabId: string }
export interface LayoutSplit { kind: 'split'; direction: 'col' | 'row'; children: [LayoutNode, LayoutNode]; ratio: number }
export type LayoutNode = LayoutLeaf | LayoutSplit

export interface Group {
  id: string;
  name: string;       // e.g. "Group 1"
  layout: LayoutNode;
}

export interface AppSettings {
  gitLazyPolling: boolean;  // true = poll only while panel is open + once at session start
  terminalBgColor: string;  // hex, default '#141413'
  alwaysOnTop: boolean;
  defaultShell: string;     // shell id (must match a preset in SHELL_PRESETS)
}

export interface ShellPreset {
  id: string;
  name: string;
  command: string;
  platforms: ('windows' | 'macos' | 'linux')[];
}
