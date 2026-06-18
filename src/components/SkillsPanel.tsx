import { useEffect, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Network, User, FolderTree, Puzzle, ChevronRight, Plug, Globe, Terminal as TerminalIcon, Wand2, FolderOpen, Sparkles, Brain, Bot, Slash, Zap, FileText, Layers } from "lucide-react";
import type { ProjectSkills, Skill, Plugin, McpInfo, ProjectMemories, Memory, SubagentInfo, SlashCommand, HookEntry, ClaudeMdFile, SettingsSource, CodexContext, CursorContext, AgentContextSection } from "../types";
import { useTooltip, useTt, ttProps, TooltipProvider } from "./Tooltip";
import { MarkdownDialog } from "./MarkdownDialog";
import { AGENTS, AgentIcon } from "../agents";

interface Props {
  projectPath: string;
  projectName: string;
  // Which agents have sessions in this project — part of the root-section gating (a pure
  // Codex/Cursor project hides the Claude roots and vice versa; see visibility rules below).
  agentPresence?: { claude: boolean; codex: boolean; cursor: boolean };
}

function revealFolder(path: string) { invoke("reveal_in_explorer", { path }).catch(() => {}); }

// Reveal-in-explorer icon button with custom tooltip (no native title).
function RevealBtn({ path, size = 10, label = "Reveal in Explorer" }: { path: string; size?: number; label?: string }) {
  const tt = useTt();
  return <button className="tn-act" onClick={() => revealFolder(path)} {...ttProps(tt, label)}><FolderOpen size={size} /></button>;
}

// ─── Generic tree node ─────────────────────────────────────────────
interface TreeNodeProps {
  depth: number;
  icon?: ReactNode;
  label: ReactNode;
  sublabel?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  variant?: "root" | "group" | "item" | "leaf";
  dim?: boolean;
  onClickLabel?: () => void;
}

function TreeNode({ depth, icon, label, sublabel, meta, actions, children, defaultOpen = false, variant = "item", dim }: TreeNodeProps) {
  const hasChildren = !!children;
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => hasChildren && setOpen(v => !v);

  return (
    <div className={`tn tn-${variant} ${dim ? "tn-dim" : ""}`}>
      <div className="tn-row" style={{ paddingLeft: 6 + depth * 14 }} onClick={toggle}>
        {hasChildren
          ? <ChevronRight size={11} className={`tn-chev ${open ? "open" : ""}`} />
          : <span className="tn-chev-placeholder" />}
        {icon && <span className="tn-icon">{icon}</span>}
        <span className="tn-label-wrap">
          <span className="tn-label">{label}</span>
          {sublabel && <span className="tn-sublabel">{sublabel}</span>}
        </span>
        {meta && <span className="tn-meta">{meta}</span>}
        {/* Always render the actions slot (even if empty) so rows without actions keep the
            same right-edge gutter as rows with them — otherwise meta/count shifts horizontally
            across rows and the whole column looks ragged. */}
        <span className="tn-actions" onClick={e => e.stopPropagation()}>{actions}</span>
      </div>
      {hasChildren && (
        <div className={`tn-body-wrap ${open ? "open" : ""}`}>
          <div className="tn-body">{children}</div>
        </div>
      )}
    </div>
  );
}

// ─── Leaf renderers ────────────────────────────────────────────────
function SkillNode({ skill, depth }: { skill: Skill; depth: number }) {
  return (
    <TreeNode
      depth={depth}
      icon={<Wand2 size={11} className="skill-icon-unified" />}
      label={skill.name}
      actions={<RevealBtn path={skill.path} />}
    />
  );
}

function McpNode({ mcp, depth }: { mcp: McpInfo; depth: number }) {
  const KindIcon = mcp.kind === "http" || mcp.kind === "sse" ? Globe : TerminalIcon;
  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      icon={<KindIcon size={11} className="mcp-kind-icon" />}
      label={mcp.name}
      meta={<span className="tn-tag">{mcp.kind}</span>}
    />
  );
}

function PluginNode({ plugin, depth }: { plugin: Plugin; depth: number }) {
  const tt = useTt();
  const total = plugin.skills.length + plugin.mcps.length;
  const hasChildren = total > 0;
  return (
    <TreeNode
      depth={depth}
      dim={!plugin.enabled}
      icon={<Puzzle size={11} className="plugin-icon" />}
      label={plugin.name}
      sublabel={plugin.marketplace}
      meta={
        <>
          <span className="tn-version" style={{ visibility: plugin.version ? "visible" : "hidden" }}>v{plugin.version || "0.0.0"}</span>
          <span className={`tn-dot ${plugin.enabled ? "on" : "off"}`} {...ttProps(tt, plugin.enabled ? "Enabled" : "Disabled")} />
          <span className="tn-count" style={{ visibility: total > 0 ? "visible" : "hidden" }}>{total || 0}</span>
        </>
      }
      actions={<RevealBtn path={plugin.path} />}
    >
      {hasChildren ? (
        <>
          {plugin.skills.map(s => <SkillNode key={`${plugin.name}-s-${s.name}`} skill={s} depth={depth + 1} />)}
          {plugin.mcps.map(m => <McpNode key={`${plugin.name}-m-${m.name}`} mcp={m} depth={depth + 1} />)}
        </>
      ) : undefined}
    </TreeNode>
  );
}

function MemoryNode({ mem, depth, onOpen }: { mem: Memory; depth: number; onOpen: (m: Memory) => void }) {
  const tt = useTt();
  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      icon={<Brain size={11} className="memory-icon" />}
      label={<span className="tn-clickable" onClick={() => onOpen(mem)} {...ttProps(tt, mem.description || "Open memory")}>{mem.name}</span>}
      actions={<RevealBtn path={mem.path} label="Reveal file" />}
    />
  );
}

// Title-case a memory kind ("feedback" → "Feedback"). Unknown types stay as-is.
function labelForKind(k: string): string {
  if (!k) return "Notes";
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function Group({ depth, icon, label, count, children }: { depth: number; icon: ReactNode; label: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <TreeNode depth={depth} variant="group" icon={icon} label={label} meta={<span className="tn-count">{count}</span>}>
      {children}
    </TreeNode>
  );
}

// ─── Subagents / Slash Commands ────────────────────────────────────
// Both share: name as label, optional description as tooltip on the label. Clicking the
// label opens the underlying .md file in the same MarkdownDialog used for memories.
function AgentOrCmdNode({ name, path, description, depth, icon, tooltipFallback, onOpen }: { name: string; path: string; description: string | null; depth: number; icon: ReactNode; tooltipFallback: string; onOpen?: (path: string, title: string) => void }) {
  const tt = useTt();
  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      icon={icon}
      label={<span className="tn-clickable" onClick={() => onOpen?.(path, name)} {...ttProps(tt, description || tooltipFallback)}>{name}</span>}
      actions={<RevealBtn path={path} />}
    />
  );
}

// Group-shaped renderers for Subagents / Slash Commands — depth-parametrized so they can
// live inside a scope-specific RootSection (USER or THIS PROJECT).
function SubagentsGroup({ subagents, depth, onOpen }: { subagents: SubagentInfo[]; depth: number; onOpen?: (path: string, title: string) => void }) {
  return (
    <Group depth={depth} icon={<Bot size={11} />} label="Subagents" count={subagents.length}>
      {subagents.map(a => <AgentOrCmdNode key={`sa-${a.scope}-${a.name}`} name={a.name} path={a.path} description={a.description} depth={depth + 1} icon={<Bot size={11} />} tooltipFallback="Subagent" onOpen={onOpen} />)}
    </Group>
  );
}

function SlashCommandsGroup({ commands, depth, onOpen }: { commands: SlashCommand[]; depth: number; onOpen?: (path: string, title: string) => void }) {
  return (
    <Group depth={depth} icon={<Slash size={11} />} label="Slash Commands" count={commands.length}>
      {commands.map(c => <AgentOrCmdNode key={`sc-${c.scope}-${c.name}`} name={`/${c.name}`} path={c.path} description={c.description} depth={depth + 1} icon={<Slash size={11} />} tooltipFallback="Slash command" onOpen={onOpen} />)}
    </Group>
  );
}

// ─── Hooks ─────────────────────────────────────────────────────────
// Grouped by event. Each hook row shows matcher + command preview, with a colored badge
// indicating which settings file it came from (local / project / user).
function HookNode({ hook, depth }: { hook: HookEntry; depth: number }) {
  const tt = useTt();
  const label = hook.matcher ? <><span className="tn-matcher">[{hook.matcher}]</span> <span className="tn-hook-cmd">{hook.command}</span></> : <span className="tn-hook-cmd">{hook.command}</span>;
  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      icon={<Zap size={11} className="hook-icon" />}
      label={<span {...ttProps(tt, hook.command)}>{label}</span>}
      meta={<span className={`tn-source-badge tn-source-${hook.source}`}>{hook.source}</span>}
      actions={<RevealBtn path={hook.source_path} label={`Reveal ${hook.source} settings`} />}
    />
  );
}

function HooksGroup({ hooks, depth }: { hooks: HookEntry[]; depth: number }) {
  if (hooks.length === 0) return null;
  const byEvent = hooks.reduce<Record<string, HookEntry[]>>((acc, h) => { (acc[h.event] ||= []).push(h); return acc; }, {});
  const eventOrder = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "Notification"];
  const events = Object.keys(byEvent).sort((a, b) => {
    const ia = eventOrder.indexOf(a), ib = eventOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return (
    <Group depth={depth} icon={<Zap size={11} />} label="Hooks" count={hooks.length}>
      {events.map(ev => (
        <TreeNode key={`hk-${ev}`} depth={depth + 1} variant="group" icon={<Zap size={11} />} label={ev} meta={<span className="tn-count">{byEvent[ev].length}</span>}>
          {byEvent[ev].map((h, i) => <HookNode key={`hk-${ev}-${i}`} hook={h} depth={depth + 2} />)}
        </TreeNode>
      ))}
    </Group>
  );
}

// ─── CLAUDE.md files ───────────────────────────────────────────────
function ClaudeMdGroup({ files, onOpen, depth }: { files: ClaudeMdFile[]; onOpen: (f: ClaudeMdFile) => void; depth: number }) {
  if (files.length === 0) return null;
  const tt = useTt();
  const scopeLabel = (s: ClaudeMdFile["scope"]) => s === "project-root" ? "project" : s === "project-nested" ? "nested" : "user";
  return (
    <Group depth={depth} icon={<FileText size={11} />} label="CLAUDE.md" count={files.length}>
      {files.map(f => (
        <TreeNode
          key={`md-${f.path}`}
          depth={depth + 1}
          variant="leaf"
          icon={<FileText size={11} className="claudemd-icon" />}
          label={<span className="tn-clickable" onClick={() => onOpen(f)} {...ttProps(tt, "Open CLAUDE.md")}>{f.rel_path}</span>}
          meta={<span className={`tn-source-badge tn-source-${f.scope === "user" ? "user" : f.scope === "project-root" ? "project" : "local"}`}>{scopeLabel(f.scope)}</span>}
          actions={<RevealBtn path={f.path} label="Reveal file" />}
        />
      ))}
    </Group>
  );
}

// ─── Settings (merged view) ────────────────────────────────────────
// The big UX win: renders the 3 sources in precedence order (local > project > user), tags
// the topmost *existing* one as "wins", and dims any that don't exist. Reveal action on each.
// Renders a set of settings sources. When multiple are present (project section, which has
// both local + project), shows the "wins" badge on the topmost existing one so the precedence
// is obvious at a glance. For user scope there's only one file — no badge needed.
function SettingsGroup({ sources, depth, sublabel }: { sources: SettingsSource[]; depth: number; sublabel?: string }) {
  if (sources.length === 0) return null;
  const wins = sources.find(s => s.exists)?.scope ?? null;
  const showWinsBadge = sources.length > 1;
  const scopeDesc = (s: SettingsSource["scope"]) => s === "local" ? "project-local (gitignored)" : s === "project" ? "project shared (committed)" : "user global";
  const filename = (s: SettingsSource) => {
    const m = s.path.replace(/\\/g, "/").match(/[^/]+$/);
    return m ? m[0] : s.path;
  };
  return (
    <TreeNode depth={depth} variant="group" icon={<Layers size={11} />} label="Settings" sublabel={sublabel ? <span className="tn-hint">{sublabel}</span> : undefined} meta={<span className="tn-count">{sources.length}</span>}>
      {sources.map(src => (
        <TreeNode
          key={`st-${src.scope}`}
          depth={depth + 1}
          variant="leaf"
          dim={!src.exists}
          icon={<Layers size={11} className={`settings-icon settings-icon-${src.scope}`} />}
          label={filename(src)}
          sublabel={<span className="tn-hint">{scopeDesc(src.scope)}</span>}
          meta={
            <>
              {showWinsBadge && src.exists && src.scope === wins && <span className="tn-source-badge tn-wins">wins</span>}
              {!src.exists && <span className="tn-source-badge tn-missing">missing</span>}
            </>
          }
          actions={src.exists ? <RevealBtn path={src.path} label="Reveal settings file" /> : undefined}
        />
      ))}
    </TreeNode>
  );
}

// ─── Root section (user / project) ─────────────────────────────────
interface RootProps {
  icon: ReactNode;
  title: string;
  hint: string;
  revealPath?: string;
  plugins: Plugin[];
  skills: Skill[];
  mcps: McpInfo[];
  memories?: Memory[];
  memoryDir?: string;
  onOpenMemory?: (m: Memory) => void;
  subagents?: SubagentInfo[];
  slashCommands?: SlashCommand[];
  hooks?: HookEntry[];
  claudeMdFiles?: ClaudeMdFile[];
  settingsSources?: SettingsSource[];
  settingsSublabel?: string;
  onOpenDoc?: (path: string, title: string) => void;
}

function RootSection({ icon, title, hint, revealPath, plugins, skills, mcps, memories, memoryDir, onOpenMemory, subagents, slashCommands, hooks, claudeMdFiles, settingsSources, settingsSublabel, onOpenDoc }: RootProps) {
  const mems = memories || [];
  const agents = subagents || [];
  const cmds = slashCommands || [];
  const hks = hooks || [];
  const mdFiles = claudeMdFiles || [];
  const settings = settingsSources || [];
  const totalItems = plugins.length + skills.length + mcps.length + mems.length + agents.length + cmds.length + hks.length + mdFiles.length + settings.length;
  const hasAny = totalItems > 0;

  // Group memories by their frontmatter "type" (feedback / reference / project / user / ...).
  const memsByKind = mems.reduce<Record<string, Memory[]>>((acc, m) => {
    const k = m.type || "note";
    (acc[k] ||= []).push(m);
    return acc;
  }, {});
  const kindOrder = ["user", "project", "feedback", "reference"];
  const sortedKinds = Object.keys(memsByKind).sort((a, b) => {
    const ia = kindOrder.indexOf(a), ib = kindOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return (
    <TreeNode
      depth={0}
      variant="root"
      icon={icon}
      label={title}
      sublabel={<span className="tn-hint">{hint}</span>}
      actions={revealPath ? <RevealBtn path={revealPath} size={11} /> : undefined}
      defaultOpen
    >
      {hasAny ? (
        <>
          <Group depth={1} icon={<Puzzle size={11} className="plugin-icon" />} label="Plugins" count={plugins.length}>
            {plugins.map(pl => <PluginNode key={`pl-${pl.name}`} plugin={pl} depth={2} />)}
          </Group>
          <Group depth={1} icon={<Wand2 size={11} className="skill-icon-unified" />} label="Skills" count={skills.length}>
            {skills.map(s => <SkillNode key={`sk-${s.name}`} skill={s} depth={2} />)}
          </Group>
          <Group depth={1} icon={<Plug size={11} className="mcp-kind-icon" />} label="MCP Servers" count={mcps.length}>
            {mcps.map(m => <McpNode key={`m-${m.name}`} mcp={m} depth={2} />)}
          </Group>
          {mems.length > 0 && (
            <TreeNode
              depth={1}
              variant="group"
              icon={<Brain size={11} className="memory-icon" />}
              label="Memories"
              meta={<span className="tn-count">{mems.length}</span>}
              actions={memoryDir ? <RevealBtn path={memoryDir} label="Reveal memory folder" /> : undefined}
            >
              {sortedKinds.map(k => (
                <TreeNode key={`mk-${k}`} depth={2} variant="group" icon={<Brain size={10} className="memory-icon" />} label={labelForKind(k)} meta={<span className="tn-count">{memsByKind[k].length}</span>}>
                  {memsByKind[k].map(m => <MemoryNode key={`mem-${m.path}`} mem={m} depth={3} onOpen={onOpenMemory || (() => {})} />)}
                </TreeNode>
              ))}
            </TreeNode>
          )}
          {agents.length > 0 && <SubagentsGroup subagents={agents} depth={1} onOpen={onOpenDoc} />}
          {cmds.length > 0 && <SlashCommandsGroup commands={cmds} depth={1} onOpen={onOpenDoc} />}
          {hks.length > 0 && <HooksGroup hooks={hks} depth={1} />}
          {mdFiles.length > 0 && <ClaudeMdGroup files={mdFiles} depth={1} onOpen={(f) => onOpenDoc?.(f.path, f.rel_path)} />}
          {settings.length > 0 && <SettingsGroup sources={settings} depth={1} sublabel={settingsSublabel} />}
        </>
      ) : <div className="tn-empty" style={{ paddingLeft: 22 }}>Nothing here yet</div>}
    </TreeNode>
  );
}

// ─── Codex root section ────────────────────────────────────────────
// Renders the generic sections shape from get_codex_context — no Codex-specific structure,
// so any future agent returning the same shape gets this rendering for free. The trust
// badge is the one Codex-specific extra (per-project trust level from config.toml).
function sectionIcon(title: string): ReactNode {
  if (title === "Instructions") return <FileText size={11} className="claudemd-icon" />;
  if (title === "Prompts") return <Slash size={11} />;
  if (title === "MCP servers") return <Plug size={11} className="mcp-kind-icon" />;
  return <Bot size={11} />;
}

function AgentContextRoot({ title, icon, trustLevel, sections, onOpenDoc }: { title: string; icon: ReactNode; trustLevel: string | null; sections: AgentContextSection[]; onOpenDoc: (path: string, title: string) => void }) {
  const tt = useTt();
  const total = sections.reduce((sum, sec) => sum + sec.items.length, 0);
  return (
    <TreeNode
      depth={0}
      variant="root"
      icon={icon}
      label={title}
      sublabel={<span className="tn-hint">agent</span>}
      meta={trustLevel ? <span className="tn-tag" {...ttProps(tt, "Project trust level from config.toml")}>{trustLevel}</span> : undefined}
      defaultOpen
    >
      {total > 0 ? sections.map(sec => (
        <Group key={sec.title} depth={1} icon={sectionIcon(sec.title)} label={sec.title} count={sec.items.length}>
          {sec.items.map(item => (
            <TreeNode
              key={`${sec.title}-${item.name}-${item.path}`}
              depth={2}
              variant="leaf"
              icon={sectionIcon(sec.title)}
              label={item.path ? <span className="tn-clickable" onClick={() => onOpenDoc(item.path, item.name)} {...ttProps(tt, "Open file")}>{item.name}</span> : item.name}
              sublabel={item.detail ? <span className="tn-hint">{item.detail}</span> : undefined}
              actions={item.path ? <RevealBtn path={item.path} label="Reveal file" /> : undefined}
            />
          ))}
        </Group>
      )) : <div className="tn-empty" style={{ paddingLeft: 22 }}>Nothing here yet</div>}
    </TreeNode>
  );
}

// ─── Main panel ────────────────────────────────────────────────────
export function SkillsPanel({ projectPath, projectName, agentPresence }: Props) {
  const [data, setData] = useState<ProjectSkills | null>(null);
  const [codexCtx, setCodexCtx] = useState<CodexContext | null>(null);
  const [cursorCtx, setCursorCtx] = useState<CursorContext | null>(null);
  const [memories, setMemories] = useState<ProjectMemories>({ dir: "", items: [] });
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState("user");
  const [homeDir, setHomeDir] = useState<string>("");
  const [openMemory, setOpenMemory] = useState<Memory | null>(null);
  const [openDoc, setOpenDoc] = useState<{ path: string; title: string } | null>(null);
  const { tt, Tooltip } = useTooltip();

  useEffect(() => {
    invoke<string>("get_username").then(setUsername).catch(() => {});
    invoke<string>("get_home_dir").then(setHomeDir).catch(() => {});
  }, []);

  const fetchData = async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const skills = await invoke<ProjectSkills>("get_project_skills", { projectPath });
      setData(skills);
    } catch (e) {
      console.error("[SkillsPanel] skills error:", e);
      setData({ personal_skills: [], project_skills: [], plugins: [], user_mcps: [], project_mcps: [], subagents: [], slash_commands: [], hooks: [], claude_md_files: [], settings_sources: [] });
    }
    try {
      const mems = await invoke<ProjectMemories>("get_project_memories", { projectPath });
      setMemories(mems);
    } catch (e) {
      console.error("[SkillsPanel] memories error:", e);
      setMemories({ dir: "", items: [] });
    } finally { setLoading(false); }
    try {
      setCodexCtx(await invoke<CodexContext>("get_codex_context", { projectPath }));
    } catch (e) {
      console.error("[SkillsPanel] codex context error:", e);
      setCodexCtx(null);
    }
    try {
      setCursorCtx(await invoke<CursorContext>("get_cursor_context", { projectPath }));
    } catch (e) {
      console.error("[SkillsPanel] cursor context error:", e);
      setCursorCtx(null);
    }
  };
  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [projectPath]);

  const userPlugins  = data?.plugins.filter(p => p.scope === "user")  || [];
  const localPlugins = data?.plugins.filter(p => p.scope === "local") || [];
  const totalSkills = (data?.personal_skills.length || 0) + (data?.project_skills.length || 0) + (data?.plugins.reduce((s, p) => s + p.skills.length, 0) || 0);
  const totalMcps   = (data?.user_mcps.length || 0) + (data?.project_mcps.length || 0) + (data?.plugins.reduce((s, p) => s + p.mcps.length, 0) || 0);

  // Split the cross-scope collections into user- vs project-scoped so each RootSection only
  // sees its own data. Settings precedence — local > project > user — is visualized twice:
  //   - USER root shows only its single user-level settings.json
  //   - THIS PROJECT root shows local + project, tagging the topmost existing as "wins"
  const userSubagents     = data?.subagents.filter(a => a.scope === "user")        || [];
  const projectSubagents  = data?.subagents.filter(a => a.scope === "project")     || [];
  const userCommands      = data?.slash_commands.filter(c => c.scope === "user")   || [];
  const projectCommands   = data?.slash_commands.filter(c => c.scope === "project") || [];
  const userHooks         = data?.hooks.filter(h => h.source === "user")           || [];
  const projectHooks      = data?.hooks.filter(h => h.source !== "user")           || [];
  const userMdFiles       = data?.claude_md_files.filter(f => f.scope === "user")  || [];
  const projectMdFiles    = data?.claude_md_files.filter(f => f.scope !== "user")  || [];
  const userSettings      = data?.settings_sources.filter(s => s.scope === "user") || [];
  const projectSettings   = data?.settings_sources.filter(s => s.scope !== "user") || [];

  // ─── Agent-conditional visibility ──────────────────────────────────
  // Claude roots show when there's any Claude content or the project has Claude sessions —
  // a pure Codex/Cursor user (no ~/.claude content) never reads Claude vocabulary. Each
  // other agent's root shows when its artifacts or sessions exist for this project. If no
  // agent has anything, fall back to the Claude roots (the pre-multi-agent empty state).
  const claudeContentCount = data ? data.personal_skills.length + data.project_skills.length + data.plugins.length + data.user_mcps.length + data.project_mcps.length + data.subagents.length + data.slash_commands.length + data.hooks.length + data.claude_md_files.length + data.settings_sources.filter(s => s.exists).length : 0;
  const codexVisible = !!(codexCtx?.present || agentPresence?.codex);
  const cursorVisible = !!(cursorCtx?.present || agentPresence?.cursor);
  let claudeVisible = claudeContentCount + memories.items.length > 0 || !!agentPresence?.claude;
  if (!claudeVisible && !codexVisible && !cursorVisible) claudeVisible = true;
  // When Claude shares the tree with another agent, its roots name their agent in the hint
  // so the grouping is unambiguous; single-agent trees stay free of agent labels.
  const claudeHintSuffix = claudeVisible && (codexVisible || cursorVisible) ? ` · ${AGENTS.claude.label}` : "";

  return (
    <TooltipProvider tt={tt}>
    <aside className="skills-panel">
      <div className="skills-panel-head">
        <Network size={14} className="skills-panel-head-icon" />
        <span className="skills-panel-title">Context Tree</span>
        <div className="skills-panel-stats">
          {totalSkills > 0 && <span className="skills-stat" {...ttProps(tt, "Skills")}><Sparkles size={9} />{totalSkills}</span>}
          {totalMcps > 0 && <span className="skills-stat" {...ttProps(tt, "MCP servers")}><Plug size={9} />{totalMcps}</span>}
          {memories.items.length > 0 && <span className="skills-stat" {...ttProps(tt, "Memories")}><Brain size={9} />{memories.items.length}</span>}
        </div>
      </div>

      <div className="skills-panel-scroll">
        {!data && loading && <div className="skills-empty"><div className="spinner-small" /></div>}
        {data && (
          <div className="tn-root-list">
            {claudeVisible && <>
            <RootSection
              icon={<User size={12} />}
              title={username}
              hint={`user${claudeHintSuffix}`}
              revealPath={homeDir ? `${homeDir}/.claude` : undefined}
              plugins={userPlugins}
              skills={data.personal_skills}
              mcps={data.user_mcps}
              subagents={userSubagents}
              slashCommands={userCommands}
              hooks={userHooks}
              claudeMdFiles={userMdFiles}
              settingsSources={userSettings}
              onOpenDoc={(path, title) => setOpenDoc({ path, title })}
            />
            <RootSection
              icon={<FolderTree size={12} />}
              title={projectName}
              hint={`this project${claudeHintSuffix}`}
              revealPath={`${projectPath}/.claude`}
              plugins={localPlugins}
              skills={data.project_skills}
              mcps={data.project_mcps}
              memories={memories.items}
              memoryDir={memories.dir}
              onOpenMemory={setOpenMemory}
              subagents={projectSubagents}
              slashCommands={projectCommands}
              hooks={projectHooks}
              claudeMdFiles={projectMdFiles}
              settingsSources={projectSettings}
              onOpenDoc={(path, title) => setOpenDoc({ path, title })}
            />
            </>}
            {codexVisible && codexCtx && (
              <AgentContextRoot
                title={AGENTS.codex.label}
                icon={<AgentIcon agent="codex" size={12} className="tn-agent-icon-neutral" />}
                trustLevel={codexCtx.trust_level}
                sections={codexCtx.sections}
                onOpenDoc={(path, title) => setOpenDoc({ path, title })}
              />
            )}
            {cursorVisible && cursorCtx && (
              <AgentContextRoot
                title={AGENTS.cursor.label}
                icon={<AgentIcon agent="cursor" size={12} />}
                trustLevel={null}
                sections={cursorCtx.sections}
                onOpenDoc={(path, title) => setOpenDoc({ path, title })}
              />
            )}
          </div>
        )}
      </div>
      {Tooltip}
      <MarkdownDialog path={openMemory?.path || null} title={openMemory?.name} onClose={() => setOpenMemory(null)} />
      <MarkdownDialog path={openDoc?.path || null} title={openDoc?.title} onClose={() => setOpenDoc(null)} />
    </aside>
    </TooltipProvider>
  );
}
