use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::ipc::{Channel, Response};
use tauri::State;

// ── Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub encoded_name: String,
    pub session_count: usize,
    pub last_active: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub timestamp: String,
    pub message_count: usize,
    pub project_name: String,
    pub project_path: String,
    pub git_branch: String,
    pub claude_version: String,
    pub tool_use_count: usize,
    pub duration_ms: u64,
    // Raw model id from the latest assistant turn (e.g. "claude-opus-4-7-20260101"). The
    // frontend formats this into a short label like "Opus 4.7".
    pub model: String,
    // Current context usage = last assistant turn's input + cache_creation + cache_read.
    // This is what Claude actually sees — good proxy for the "200k" budget indicator.
    pub context_tokens: u64,
    pub context_limit: u64,
    // Lifetime cost in USD, sourced from the xshell-stats statusline hook (kept monotonic
    // there). 0 when no hook data exists for this session — we don't synthesize.
    pub cost_usd: f64,
    // True when cost/context/model came from the xshell-stats file (statusline hook).
    pub is_authoritative_stats: bool,
    // { "YYYY-MM-DD": usd } — daily breakdown produced by the hook (delta since previous
    // tick added to today's bucket). Lets the UI render trend / per-day totals.
    pub daily_cost: std::collections::BTreeMap<String, f64>,
    // Rate-limit usage from the statusline hook (only present when authoritative).
    pub rate_limit_5h_pct: Option<f64>,
    pub rate_limit_7d_pct: Option<f64>,
    // Lifetime token totals summed from every non-synthetic assistant turn in the JSONL.
    // Always populated — independent of the xshell-stats hook.
    pub total_input_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_output_tokens: u64,
    // Per-day token breakdown keyed by YYYY-MM-DD. Each value is [input, cache_creation,
    // cache_read, output] so the UI can render a stacked area chart with the four bands.
    pub daily_tokens: std::collections::BTreeMap<String, [u64; 4]>,
    // Which coding agent produced this session: "claude" (JSONL under ~/.claude/projects)
    // or "codex" (rollout under ~/.codex/sessions). Drives the row icon, model formatting,
    // and which resume command a terminal tab spawns.
    pub agent: String,
}

// ── State ──────────────────────────────────────────────────────────────

struct TerminalHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

pub struct AppState {
    terminals: Mutex<HashMap<String, TerminalHandle>>,
}

// ── Helpers ────────────────────────────────────────────────────────────

fn get_claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

// Mirror Claude Code's encoding of a project path into the directory name under
// `~/.claude/projects/`. Every non-alphanumeric character collapses to `-` — including
// `.` and `_`, which Claude Code also converts (e.g. `CalcApps.Framework` →
// `CalcApps-Framework`, `SSY2_Lab` → `SSY2-Lab`).
// e.g. `C:\Users\alex\projects\my-app`  →  `C--Users-alex-projects-my-app`
fn encode_project_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

// Cursor records timestamps as unix-epoch milliseconds (createdAtMs / updatedAtMs); reuse
// the SystemTime formatter so its dates render identically to the other agents'.
fn unix_ms_to_iso(ms: u64) -> String {
    system_time_to_iso(SystemTime::UNIX_EPOCH + Duration::from_millis(ms))
}

fn system_time_to_iso(time: SystemTime) -> String {
    let duration = time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs();
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;

    // Simple epoch-to-date calculation
    let mut y = 1970i64;
    let mut d = days as i64;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
        if d < days_in_year { break; }
        d -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if d < md as i64 { m = i; break; }
        d -= md as i64;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m + 1, d + 1, hours, minutes, seconds)
}

// Cached SessionInfo keyed by JSONL path. The cache is invalidated whenever the JSONL's
// mtime changes (active session got a new turn) OR the xshell-stats sidecar's mtime
// changes (cost/rate-limit refresh). Active sessions still re-parse on every tick — those
// are 1-2 files. Idle sessions cost only two stat() calls. Drops the title-sync poll cost
// from "parse every JSONL in the project every 5s" (tens of MB) to a few syscalls.
struct SessionCacheEntry {
    jsonl_mtime: SystemTime,
    stats_mtime: Option<SystemTime>,
    project_path: String,
    info: SessionInfo,
}

fn session_cache() -> &'static Mutex<HashMap<PathBuf, SessionCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, SessionCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stats_path_for(session_id: &str) -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("xshell-stats").join(format!("{}.json", session_id)))
}

fn parse_session(path: &std::path::Path, project_name: &str, project_path: &str) -> Option<SessionInfo> {
    let session_id = path.file_stem()?.to_string_lossy().to_string();
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let mtime_iso = system_time_to_iso(modified);

    // Stats-file mtime (sidecar from the xshell-stats statusline hook). May not exist —
    // None is a valid cache key value, so a session without stats stays cached cleanly.
    let stats_mtime = stats_path_for(&session_id)
        .and_then(|p| fs::metadata(&p).ok())
        .and_then(|m| m.modified().ok());

    // Cache lookup — return clone if all three keys match (jsonl mtime, stats mtime, project_path).
    if let Ok(cache) = session_cache().lock() {
        if let Some(entry) = cache.get(path) {
            if entry.jsonl_mtime == modified && entry.stats_mtime == stats_mtime && entry.project_path == project_path {
                return Some(entry.info.clone());
            }
        }
    }

    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    // Three independent title sources. `custom-title` is what `/rename` writes (also `claude -n`,
    // though the app no longer uses that flag). `agent-name` mirrors `custom-title` for branched
    // sessions. `ai-title` is Claude's auto-summary, emitted after the first turn — only present
    // when no custom title exists. We resolve precedence at the end so a user-chosen name always
    // beats the AI summary.
    let mut custom_title = String::new();
    let mut agent_name = String::new();
    let mut ai_title = String::new();
    let mut first_human_message = String::new();
    let mut message_count: usize = 0;
    let mut git_branch = String::new();
    let mut claude_version = String::new();
    let mut tool_use_count: usize = 0;
    let mut duration_ms: u64 = 0;
    // Track the latest per-line timestamp on real conversation turns (user/assistant).
    // ISO-8601 strings are lexicographically sortable, so String::max() works.
    let mut last_message_ts: String = String::new();

    // Model + usage — we care about the LAST assistant turn (for the context-used bar).
    // Cost is NOT computed here; we rely entirely on the xshell-stats statusline hook below
    // for authoritative numbers. Synthesizing a price-table estimate would drift every time
    // pricing changes and only ever undercount (no system-prompt / tools tokens in JSONL).
    let mut latest_model = String::new();
    let mut last_input: u64 = 0;
    let mut last_cache_creation: u64 = 0;
    let mut last_cache_read: u64 = 0;
    // Track max observed context across the whole session — used to auto-detect 1M context.
    // If we ever see > 200k, the session must be on the 1M beta (a normal 200k session would
    // have auto-compacted before hitting the limit).
    let mut max_context_observed: u64 = 0;
    // Lifetime per-category token totals across every non-synthetic assistant turn. Powers
    // the Tokens view of the project stats panel without depending on the xshell-stats hook.
    let mut total_input_tokens: u64 = 0;
    let mut total_cache_creation_tokens: u64 = 0;
    let mut total_cache_read_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    // Per-day breakdown keyed by YYYY-MM-DD. Each value is [input, cache_creation, cache_read,
    // output] so the UI can render a stacked area chart (cost-impact ordering at render time).
    let mut daily_tokens: std::collections::BTreeMap<String, [u64; 4]> = std::collections::BTreeMap::new();
    // Claude Code splits one assistant API response into multiple JSONL lines — one per content
    // block (text / thinking / tool_use) — but stamps the SAME `usage` block on every line.
    // Summing usage on every line over-counts the same API call N times. Dedup by `message.id`
    // so each real API call contributes its tokens exactly once. Only gates the lifetime totals
    // and per-day buckets — the "latest" / "max" trackers are idempotent under duplicates.
    let mut seen_message_ids: HashSet<String> = HashSet::new();

    for line in reader.lines().flatten() {
        let json: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(b) = json.get("gitBranch").and_then(|v| v.as_str()) { git_branch = b.to_string(); }
        if let Some(v) = json.get("version").and_then(|v| v.as_str()) { claude_version = v.to_string(); }
        if let Some(d) = json.get("durationMs").and_then(|v| v.as_u64()) { duration_ms += d; }
        if json.get("toolUseResult").is_some() { tool_use_count += 1; }

        let ty = json.get("type").and_then(|t| t.as_str());
        // Bump the "last activity" timestamp only on user/assistant lines — tool results,
        // permission-mode flips, and file-history snapshots don't represent user activity.
        if matches!(ty, Some("user") | Some("human") | Some("assistant")) {
            if let Some(ts) = json.get("timestamp").and_then(|t| t.as_str()) {
                if ts > last_message_ts.as_str() { last_message_ts = ts.to_string(); }
            }
        }

        match ty {
            Some("custom-title") => {
                if let Some(t) = json.get("customTitle").and_then(|t| t.as_str()) { custom_title = t.to_string(); }
            }
            Some("ai-title") => {
                if let Some(t) = json.get("aiTitle").and_then(|t| t.as_str()) { ai_title = t.to_string(); }
            }
            Some("agent-name") => {
                if let Some(t) = json.get("agentName").and_then(|t| t.as_str()) { agent_name = t.to_string(); }
            }
            Some("human") | Some("user") => {
                // Both real user prompts AND tool-result responses arrive as `type: "user"`.
                // Tool results are NOT something the user typed — Claude requested a tool,
                // the runtime sent back the result as a `user`-role turn with content like
                // `[{ "type": "tool_result", ... }]`. Counting those as messages overstates
                // the actual conversation length by 2-3×.
                let content_node = json.get("message").and_then(|m| m.get("content")).or_else(|| json.get("content"));
                let mut is_real_prompt = false;
                let mut prompt_text: Option<String> = None;
                if let Some(content) = content_node {
                    if let Some(s) = content.as_str() {
                        is_real_prompt = !s.is_empty();
                        prompt_text = Some(s.chars().take(120).collect());
                    } else if let Some(arr) = content.as_array() {
                        // Real prompt = at least one text/image part AND no tool_result parts.
                        let has_tool_result = arr.iter().any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
                        let has_text_or_image = arr.iter().any(|item| {
                            let ty = item.get("type").and_then(|t| t.as_str());
                            ty == Some("text") || ty == Some("image") || ty.is_none() && item.get("text").is_some()
                        });
                        is_real_prompt = !has_tool_result && has_text_or_image;
                        if is_real_prompt {
                            for item in arr {
                                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                    prompt_text = Some(text.chars().take(120).collect());
                                    break;
                                }
                            }
                        }
                    }
                }
                if is_real_prompt {
                    message_count += 1;
                    if first_human_message.is_empty() {
                        if let Some(t) = prompt_text { first_human_message = t; }
                    }
                }
            }
            Some("assistant") => {
                // Pull model + usage from the assistant's `message` object. We price each
                // turn against the model that handled it (sessions can switch models), and
                // remember the last usage for the "current context used" bar.
                if let Some(msg) = json.get("message") {
                    let turn_model = msg.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    // Branch / resume sessions inject `<synthetic>` model entries — those
                    // are placeholder rows that didn't actually run through a real model,
                    // so they shouldn't pollute the latest-model badge or get priced.
                    let is_synthetic = turn_model.starts_with('<') && turn_model.ends_with('>');
                    if !turn_model.is_empty() && !is_synthetic { latest_model = turn_model.clone(); }
                    if let Some(u) = msg.get("usage") {
                        if is_synthetic { continue; }
                        let inp = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let cc  = u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let cr  = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let out = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        last_input = inp;
                        last_cache_creation = cc;
                        last_cache_read = cr;
                        let turn_context = inp + cc + cr;
                        if turn_context > max_context_observed { max_context_observed = turn_context; }
                        // Skip the lifetime/per-day accumulation if we've already seen this
                        // message.id — see `seen_message_ids` declaration above for why.
                        let message_id = msg.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
                        let first_seen = match &message_id {
                            Some(id) => seen_message_ids.insert(id.clone()),
                            None => true,
                        };
                        if first_seen {
                            total_input_tokens += inp;
                            total_cache_creation_tokens += cc;
                            total_cache_read_tokens += cr;
                            total_output_tokens += out;
                            // Per-day bucket. Use this turn's own ISO timestamp (top-level) so
                            // days line up with when usage actually happened, not when the
                            // session ended.
                            if let Some(ts) = json.get("timestamp").and_then(|v| v.as_str()) {
                                if ts.len() >= 10 {
                                    let day = ts[..10].to_string();
                                    let entry = daily_tokens.entry(day).or_insert([0; 4]);
                                    entry[0] = entry[0].saturating_add(inp);
                                    entry[1] = entry[1].saturating_add(cc);
                                    entry[2] = entry[2].saturating_add(cr);
                                    entry[3] = entry[3].saturating_add(out);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut context_tokens = last_input + last_cache_creation + last_cache_read;
    // Auto-detect 1M context: a 200k-limit session would have auto-compacted well before
    // exceeding 200k, so any observed context above that threshold is proof the session is
    // running on the 1M beta (Opus 4.7 (1M context) / similar).
    let mut context_limit: u64 = if max_context_observed > 200_000 { 1_000_000 } else { 200_000 };
    // Stays at 0 unless the xshell-stats hook overwrites it just below — no JSONL fallback.
    let mut cost_usd: f64 = 0.0;
    let mut model_out = latest_model;
    let mut is_authoritative_stats = false;
    let mut rate_limit_5h_pct: Option<f64> = None;
    let mut rate_limit_7d_pct: Option<f64> = None;
    let mut daily_cost: std::collections::BTreeMap<String, f64> = std::collections::BTreeMap::new();

    // If the user has set up the xshell-stats statusline hook, prefer its values — Claude
    // Code computes cost and context% authoritatively, including system-prompt + tools
    // tokens we can't see in the per-turn `message.usage`. The file is keyed by session id
    // and refreshed every Claude Code refresh tick.
    if let Some(home) = dirs::home_dir() {
        let stats_path = home.join(".claude").join("xshell-stats").join(format!("{}.json", session_id));
        if let Ok(content) = fs::read_to_string(&stats_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                is_authoritative_stats = true;
                if let Some(c) = json.get("cost").and_then(|v| v.get("total_cost_usd")).and_then(|v| v.as_f64()) {
                    cost_usd = c;
                }
                if let Some(cw) = json.get("context_window") {
                    if let Some(size) = cw.get("context_window_size").and_then(|v| v.as_u64()) {
                        context_limit = size;
                    }
                    // Prefer the explicit current_usage breakdown for context_tokens — same
                    // shape we used from JSONL but now sourced from Claude Code itself.
                    if let Some(cu) = cw.get("current_usage") {
                        let inp = cu.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let cc  = cu.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let cr  = cu.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        // If used_percentage is present, use it to back-compute tokens that
                        // include system+tools overhead (the source of our current ~25k drift).
                        if let Some(pct) = cw.get("used_percentage").and_then(|v| v.as_f64()) {
                            context_tokens = ((pct / 100.0) * context_limit as f64) as u64;
                        } else {
                            context_tokens = inp + cc + cr;
                        }
                    }
                }
                // Model display name carries the "[1m]" / "(1M context)" markers Claude
                // Code adds at runtime — strictly better than the raw model id we'd parse
                // from JSONL.
                if let Some(m) = json.get("model") {
                    if let Some(disp) = m.get("display_name").and_then(|v| v.as_str()) { model_out = disp.to_string(); }
                    else if let Some(id) = m.get("id").and_then(|v| v.as_str()) { model_out = id.to_string(); }
                }
                if let Some(rl) = json.get("rate_limits") {
                    rate_limit_5h_pct = rl.get("five_hour").and_then(|v| v.get("used_percentage")).and_then(|v| v.as_f64());
                    rate_limit_7d_pct = rl.get("seven_day").and_then(|v| v.get("used_percentage")).and_then(|v| v.as_f64());
                }
                // Per-day breakdown the hook accumulates. BTreeMap so the UI gets dates in
                // chronological order without sorting on the JS side.
                if let Some(d) = json.get("xshell_daily_cost").and_then(|v| v.as_object()) {
                    for (k, v) in d {
                        if let Some(n) = v.as_f64() { daily_cost.insert(k.clone(), n); }
                    }
                }
            }
        }
    }

    // Title precedence: user-chosen names (custom-title from /rename, agent-name from /branch)
    // beat Claude's auto-summary, which beats the first prompt, which beats the bare session id.
    let display_title = if !custom_title.is_empty() { custom_title }
        else if !agent_name.is_empty() { agent_name }
        else if !ai_title.is_empty() { ai_title }
        else if !first_human_message.is_empty() { first_human_message }
        else { format!("Session {}", &session_id[..8.min(session_id.len())]) };
    // Prefer the real last-message timestamp; fall back to file mtime for brand-new sessions
    // that haven't produced a user/assistant line yet.
    let timestamp = if last_message_ts.is_empty() { mtime_iso } else { last_message_ts };

    let info = SessionInfo { id: session_id, title: display_title, timestamp, message_count, project_name: project_name.to_string(), project_path: project_path.to_string(), git_branch, claude_version, tool_use_count, duration_ms, model: model_out, context_tokens, context_limit, cost_usd, is_authoritative_stats, daily_cost, rate_limit_5h_pct, rate_limit_7d_pct, total_input_tokens, total_cache_creation_tokens, total_cache_read_tokens, total_output_tokens, daily_tokens, agent: "claude".into() };
    if let Ok(mut cache) = session_cache().lock() {
        cache.insert(path.to_path_buf(), SessionCacheEntry { jsonl_mtime: modified, stats_mtime, project_path: project_path.to_string(), info: info.clone() });
    }
    Some(info)
}

// ── Codex session parsing ─────────────────────────────────────────────
// Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) parse into the same
// SessionInfo shape Claude sessions use. Mapping notes: title = first user message (Codex
// has no /rename or auto-summary), model from the latest turn_context, context usage from
// the latest token_count's last_token_usage (the final turn's prompt+completion ≈ current
// conversation size), claude_version carries Codex's cli_version. Cost stays 0 — Codex
// subscription plans have no per-use cost — while is_authoritative_stats is true so the
// context bar renders: the numbers come from Codex itself, not an estimate.

fn codex_rollout_files() -> Vec<std::path::PathBuf> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let mut files = vec![];
    let mut stack = vec![home.join(".codex").join("sessions")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).ok().into_iter().flatten().flatten() {
            let p = entry.path();
            if entry.file_type().map_or(false, |ft| ft.is_dir()) { stack.push(p); continue; }
            if p.extension().map_or(false, |ext| ext == "jsonl") { files.push(p); }
        }
    }
    files
}

// User-assigned session names (Codex's rename feature) don't live in the rollout files —
// they land in ~/.codex/session_index.jsonl, one JSON line per named session. Load once
// per listing call and overlay onto parsed sessions; for repeated renames of the same id
// the last line wins (insertion order preserves that).
fn codex_session_names() -> HashMap<String, String> {
    let mut names = HashMap::new();
    let Some(home) = dirs::home_dir() else { return names };
    let Ok(content) = fs::read_to_string(home.join(".codex").join("session_index.jsonl")) else { return names };
    for line in content.lines() {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if let (Some(id), Some(name)) = (json.get("id").and_then(|v| v.as_str()), json.get("thread_name").and_then(|v| v.as_str())) {
                if !name.trim().is_empty() { names.insert(id.to_string(), name.to_string()); }
            }
        }
    }
    names
}

fn parse_codex_session(path: &std::path::Path, names: &HashMap<String, String>) -> Option<SessionInfo> {
    let content = fs::read_to_string(path).ok()?;

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut git_branch = String::new();
    let mut cli_version = String::new();
    let mut model = String::new();
    let mut first_user_message = String::new();
    let mut message_count = 0usize;
    let mut context_tokens = 0u64;
    let mut context_limit = 0u64;
    let mut last_ts = String::new();
    // Token accounting: total_token_usage snapshots are cumulative and monotonic, so the
    // per-day buckets come from diffing consecutive snapshots (robust against Codex writing
    // several token_count events per turn). Band mapping onto Claude's [input,
    // cache_creation, cache_read, output]: non-cached input, 0 (no such concept), cached
    // input, output (already includes reasoning tokens — total = input + output holds).
    let mut daily_tokens: std::collections::BTreeMap<String, [u64; 4]> = Default::default();
    let mut prev_totals: (u64, u64, u64) = (0, 0, 0); // (input, cached_input, output)
    let mut last_totals: (u64, u64, u64) = (0, 0, 0);

    for line in content.lines() {
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if let Some(ts) = json.get("timestamp").and_then(|v| v.as_str()) { last_ts = ts.to_string(); }
        let Some(payload) = json.get("payload") else { continue };
        match json.get("type").and_then(|v| v.as_str()) {
            Some("session_meta") => {
                session_id = payload.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                cwd = payload.get("cwd").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                cli_version = payload.get("cli_version").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                git_branch = payload.get("git").and_then(|g| g.get("branch")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            }
            Some("turn_context") => {
                if let Some(m) = payload.get("model").and_then(|v| v.as_str()) { model = m.to_string(); }
            }
            Some("event_msg") => match payload.get("type").and_then(|v| v.as_str()) {
                Some("user_message") => {
                    message_count += 1;
                    if first_user_message.is_empty() {
                        if let Some(m) = payload.get("message").and_then(|v| v.as_str()) {
                            first_user_message = m.trim().replace('\n', " ").chars().take(120).collect();
                        }
                    }
                }
                Some("token_count") => {
                    if let Some(info) = payload.get("info") {
                        if let Some(last) = info.get("last_token_usage") {
                            let turn = last.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) + last.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            if turn > 0 { context_tokens = turn; }
                        }
                        if let Some(w) = info.get("model_context_window").and_then(|v| v.as_u64()) { context_limit = w; }
                        if let Some(totals) = info.get("total_token_usage") {
                            let input = totals.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cached = totals.get("cached_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let output = totals.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let (d_input, d_cached, d_output) = (input.saturating_sub(prev_totals.0), cached.saturating_sub(prev_totals.1), output.saturating_sub(prev_totals.2));
                            if (d_input + d_output > 0) && last_ts.len() >= 10 {
                                let day = daily_tokens.entry(last_ts[..10].to_string()).or_insert([0, 0, 0, 0]);
                                day[0] += d_input.saturating_sub(d_cached);
                                day[2] += d_cached;
                                day[3] += d_output;
                            }
                            prev_totals = (input, cached, output);
                            last_totals = (input, cached, output);
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    if session_id.is_empty() || cwd.is_empty() { return None; }
    let timestamp = if last_ts.is_empty() { fs::metadata(path).ok().and_then(|m| m.modified().ok()).map(system_time_to_iso).unwrap_or_default() } else { last_ts };
    let project_name = std::path::Path::new(&cwd).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| cwd.clone());
    // Title precedence mirrors the Claude side: user rename > first prompt > bare id.
    let title = if let Some(name) = names.get(&session_id) { name.clone() }
        else if !first_user_message.is_empty() { first_user_message }
        else { format!("Session {}", &session_id[..8.min(session_id.len())]) };

    Some(SessionInfo {
        id: session_id, title, timestamp, message_count, project_name, project_path: cwd,
        git_branch, claude_version: cli_version, tool_use_count: 0, duration_ms: 0,
        model, context_tokens, context_limit,
        cost_usd: 0.0, is_authoritative_stats: true,
        daily_cost: Default::default(), rate_limit_5h_pct: None, rate_limit_7d_pct: None,
        total_input_tokens: last_totals.0.saturating_sub(last_totals.1), total_cache_creation_tokens: 0, total_cache_read_tokens: last_totals.1, total_output_tokens: last_totals.2,
        daily_tokens,
        agent: "codex".into(),
    })
}

// ── Commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn list_claude_projects() -> Vec<ProjectInfo> {
    let projects_dir = match get_claude_projects_dir() {
        Some(d) if d.exists() => d,
        _ => return vec![],
    };

    let mut projects: Vec<ProjectInfo> = vec![];

    for entry in fs::read_dir(&projects_dir).ok().into_iter().flatten().flatten() {
        if !entry.file_type().map_or(false, |ft| ft.is_dir()) {
            continue;
        }

        let encoded_name = entry.file_name().to_string_lossy().to_string();
        let project_dir = entry.path();

        // Count JSONL files and find cwd from the first one
        let mut session_count = 0usize;
        let mut cwd = String::new();
        let mut latest_modified: Option<SystemTime> = None;

        for jsonl_entry in fs::read_dir(&project_dir).ok().into_iter().flatten().flatten() {
            let p = jsonl_entry.path();
            if p.extension().map_or(true, |ext| ext != "jsonl") { continue; }
            session_count += 1;

            if let Ok(meta) = fs::metadata(&p) {
                if let Ok(modified) = meta.modified() {
                    if latest_modified.map_or(true, |prev| modified > prev) {
                        latest_modified = Some(modified);
                    }
                }
            }

            if cwd.is_empty() {
                if let Ok(file) = fs::File::open(&p) {
                    for line in BufReader::new(file).lines().take(30).flatten() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(c) = json.get("cwd").and_then(|c| c.as_str()) {
                                cwd = c.to_string();
                                break;
                            }
                        }
                    }
                }
            }
        }

        if session_count == 0 { continue; }
        if cwd.is_empty() { continue; }

        let name = std::path::Path::new(&cwd).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| encoded_name.clone());
        let last_active = latest_modified.map(system_time_to_iso).unwrap_or_default();

        projects.push(ProjectInfo { name, path: cwd, encoded_name, session_count, last_active });
    }

    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    projects
}

#[tauri::command]
fn get_sessions(encoded_name: String) -> Vec<SessionInfo> {
    let mut sessions: Vec<SessionInfo> = vec![];

    // Claude sessions live under ~/.claude/projects/<encoded_name>/. A project can be
    // Codex-only (no such directory) — that must not short-circuit the Codex pass below.
    if let Some(project_dir) = get_claude_projects_dir().map(|d| d.join(&encoded_name)) {
        if project_dir.exists() {
            // Get project path from first JSONL
            let mut project_path = String::new();
            let mut project_name = String::new();
            for e in fs::read_dir(&project_dir).ok().into_iter().flatten().flatten() {
                let p = e.path();
                if p.extension().map_or(true, |ext| ext != "jsonl") { continue; }
                if let Ok(file) = fs::File::open(&p) {
                    for line in BufReader::new(file).lines().take(30).flatten() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(c) = json.get("cwd").and_then(|c| c.as_str()) {
                                project_path = c.to_string();
                                project_name = std::path::Path::new(c).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                                break;
                            }
                        }
                    }
                }
                if !project_path.is_empty() { break; }
            }

            sessions.extend(fs::read_dir(&project_dir).ok().into_iter().flatten().flatten().filter_map(|e| {
                let p = e.path();
                if p.extension().map_or(true, |ext| ext != "jsonl") { return None; }
                parse_session(&p, &project_name, &project_path)
            }));
        }
    }

    // Codex sessions have no per-project directory — match rollouts whose recorded cwd
    // encodes to the same project directory name Claude would use.
    let codex_names = codex_session_names();
    for p in codex_rollout_files() {
        if let Some(s) = parse_codex_session(&p, &codex_names) {
            if encode_project_name(&s.project_path) == encoded_name { sessions.push(s); }
        }
    }

    // Cursor chats — same approach: resolve each chat's cwd, then match by encoded name.
    let cursor_ws = cursor_workspace_map();
    for dir in cursor_chat_dirs() {
        if let Some(s) = parse_cursor_session(&dir, &cursor_ws) {
            if !s.project_path.is_empty() && encode_project_name(&s.project_path) == encoded_name { sessions.push(s); }
        }
    }

    // opencode sessions — each row records its cwd directly; match by encoded name.
    sessions.extend(parse_opencode_sessions().into_iter().filter(|s| encode_project_name(&s.project_path) == encoded_name));

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    sessions
}

#[tauri::command]
fn get_all_recent_sessions(limit: usize) -> Vec<SessionInfo> {
    let mut all_sessions: Vec<SessionInfo> = vec![];

    // A machine can have Codex sessions but no ~/.claude/projects (or vice versa) — each
    // agent's pass is independent.
    let projects_dir = get_claude_projects_dir().filter(|d| d.exists());
    for entry in projects_dir.iter().flat_map(|d| fs::read_dir(d).ok().into_iter().flatten().flatten()) {
        if !entry.file_type().map_or(false, |ft| ft.is_dir()) { continue; }

        let project_dir = entry.path();
        let mut project_path = String::new();
        let mut project_name = String::new();

        // Get project info from first JSONL
        for jsonl in fs::read_dir(&project_dir).ok().into_iter().flatten().flatten() {
            let p = jsonl.path();
            if p.extension().map_or(true, |ext| ext != "jsonl") { continue; }
            if let Ok(file) = fs::File::open(&p) {
                for line in BufReader::new(file).lines().take(30).flatten() {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(c) = json.get("cwd").and_then(|c| c.as_str()) {
                            project_path = c.to_string();
                            project_name = std::path::Path::new(c).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                            break;
                        }
                    }
                }
            }
            if !project_path.is_empty() { break; }
        }

        if project_path.is_empty() { continue; }

        for jsonl in fs::read_dir(&project_dir).ok().into_iter().flatten().flatten() {
            let p = jsonl.path();
            if p.extension().map_or(true, |ext| ext != "jsonl") { continue; }
            if let Some(session) = parse_session(&p, &project_name, &project_path) {
                all_sessions.push(session);
            }
        }
    }

    // Codex sessions across all directories — same recency pool as the Claude ones.
    let codex_names = codex_session_names();
    all_sessions.extend(codex_rollout_files().iter().filter_map(|p| parse_codex_session(p, &codex_names)));

    // Cursor chats across all workspaces — same recency pool.
    let cursor_ws = cursor_workspace_map();
    all_sessions.extend(cursor_chat_dirs().iter().filter_map(|d| parse_cursor_session(d, &cursor_ws)));

    // opencode sessions across all directories — same recency pool.
    all_sessions.extend(parse_opencode_sessions());

    all_sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    all_sessions.truncate(limit);
    all_sessions
}

// ── Message Preview ───────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MessagePreview {
    pub role: String,
    pub text: String,
}

#[tauri::command]
fn get_session_messages(encoded_name: String, session_id: String, limit: usize) -> Vec<MessagePreview> {
    let projects_dir = match get_claude_projects_dir() { Some(d) => d, None => return vec![] };
    let path = projects_dir.join(&encoded_name).join(format!("{}.jsonl", session_id));
    if !path.exists() { return vec![]; }
    let file = match fs::File::open(&path) { Ok(f) => f, Err(_) => return vec![] };
    let reader = BufReader::new(file);
    let mut messages: Vec<MessagePreview> = vec![];
    for line in reader.lines().flatten() {
        let json: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        let msg_type = json.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if msg_type != "user" && msg_type != "assistant" { continue; }
        let msg = match json.get("message") { Some(m) => m, None => continue };
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("").to_string();
        let content = msg.get("content");
        let text = if let Some(s) = content.and_then(|c| c.as_str()) {
            s.chars().take(200).collect()
        } else if let Some(arr) = content.and_then(|c| c.as_array()) {
            arr.iter().filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") { item.get("text").and_then(|t| t.as_str()).map(|s| s.chars().take(200).collect::<String>()) } else { None }
            }).next().unwrap_or_default()
        } else { continue };
        if text.is_empty() { continue; }
        messages.push(MessagePreview { role, text });
    }
    // Return the last N messages
    let start = if messages.len() > limit { messages.len() - limit } else { 0 };
    messages[start..].to_vec()
}

// ── Image Helper ──────────────────────────────────────────────────────

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn read_image_base64(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read image: {}", e))?;
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
    let mime = match ext.as_str() { "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "svg" => "image/svg+xml", "webp" => "image/webp", "ico" => "image/x-icon", _ => "image/png" };
    use std::fmt::Write as FmtWrite;
    let mut base64 = String::new();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() { data[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        base64.push(alphabet[((triple >> 18) & 0x3F) as usize] as char);
        base64.push(alphabet[((triple >> 12) & 0x3F) as usize] as char);
        if i + 1 < data.len() { base64.push(alphabet[((triple >> 6) & 0x3F) as usize] as char); } else { base64.push('='); }
        if i + 2 < data.len() { base64.push(alphabet[(triple & 0x3F) as usize] as char); } else { base64.push('='); }
        i += 3;
    }
    let _ = write!(base64, "");
    Ok(format!("data:{};base64,{}", mime, base64))
}

// ── Skills & Plugins ──────────────────────────────────────────────────
//
// Claude Code plugin storage layout (discovered on a real machine):
//   ~/.claude/plugins/installed_plugins.json  — truth for "what's installed"
//     { "plugins": { "<name>@<marketplace>": [ { scope: "user"|"local", projectPath?, installPath, version } ] } }
//   ~/.claude/settings.json                    — user-scope enabledPlugins map
//   <project>/.claude/settings.local.json      — local-scope enabledPlugins map (preferred)
//   <project>/.claude/settings.json            — ...fallback for local-scope
//   <installPath>/.claude-plugin/plugin.json   — plugin manifest (name, version, description)
//   <installPath>/skills/<name>/SKILL.md       — plugin-provided skills
//   <installPath>/.mcp.json                    — plugin-provided MCP servers
//   ~/.claude.json                             — user + per-project MCP servers
//     { mcpServers: {...}, projects: { "<path>": { mcpServers: {...} } } }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Skill {
    pub name: String,
    pub scope: String, // "personal" | "project" | "plugin"
    pub description: Option<String>,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpInfo {
    pub name: String,
    pub kind: String, // "http" | "stdio" | "sse" | "unknown"
    pub source: String, // "user" | "project" | "plugin"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Plugin {
    pub name: String,
    pub marketplace: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub scope: String, // "user" | "local"
    pub enabled: bool,
    pub path: String,
    pub skills: Vec<Skill>,
    pub mcps: Vec<McpInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubagentInfo {
    pub name: String,
    pub path: String,
    pub scope: String,             // "user" | "project"
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SlashCommand {
    pub name: String,
    pub path: String,
    pub scope: String,             // "user" | "project"
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HookEntry {
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub source: String,            // "user" | "project" | "local"
    pub source_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeMdFile {
    pub path: String,
    pub rel_path: String,
    pub scope: String,             // "user" | "project-root" | "project-nested"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SettingsSource {
    pub scope: String,             // "user" | "project" | "local"
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectSkills {
    pub personal_skills: Vec<Skill>,
    pub project_skills: Vec<Skill>,
    pub plugins: Vec<Plugin>,
    pub user_mcps: Vec<McpInfo>,
    pub project_mcps: Vec<McpInfo>,
    pub subagents: Vec<SubagentInfo>,
    pub slash_commands: Vec<SlashCommand>,
    pub hooks: Vec<HookEntry>,
    pub claude_md_files: Vec<ClaudeMdFile>,
    pub settings_sources: Vec<SettingsSource>,
}

fn parse_skill_description(md_path: &std::path::Path) -> Option<String> {
    let content = fs::read_to_string(md_path).ok()?;
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            for line in fm.lines() {
                if let Some(v) = line.trim().strip_prefix("description:") {
                    let s = v.trim().trim_matches('"').trim_matches('\'');
                    if !s.is_empty() { return Some(s.to_string()); }
                }
            }
        }
    }
    for line in content.lines() {
        if let Some(h) = line.trim().strip_prefix("# ") { return Some(h.trim().to_string()); }
    }
    None
}

fn scan_skills_dir(dir: &std::path::Path, scope: &str) -> Vec<Skill> {
    let mut out = vec![];
    if !dir.exists() { return out; }
    for entry in fs::read_dir(dir).ok().into_iter().flatten().flatten() {
        if !entry.file_type().map_or(false, |ft| ft.is_dir()) { continue; }
        let p = entry.path();
        let md = p.join("SKILL.md");
        if !md.exists() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        out.push(Skill { name, scope: scope.to_string(), description: parse_skill_description(&md), path: p.to_string_lossy().to_string() });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// Agents and slash commands are flat .md files (name = filename without extension). Uses
// the same frontmatter parser as skills — looks for `description:` then falls back to the
// first H1. Recurses into subdirectories so namespaced commands like `.claude/commands/git/commit.md`
// show up as "git/commit".
fn scan_md_entries(dir: &std::path::Path, scope: &str) -> Vec<(String, String, Option<String>)> {
    let mut out = vec![];
    if !dir.exists() { return out; }
    fn walk(base: &std::path::Path, cur: &std::path::Path, prefix: &str, out: &mut Vec<(String, String, Option<String>)>) {
        for entry in fs::read_dir(cur).ok().into_iter().flatten().flatten() {
            let p = entry.path();
            let Ok(ft) = entry.file_type() else { continue; };
            if ft.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                let new_prefix = if prefix.is_empty() { name } else { format!("{}/{}", prefix, name) };
                walk(base, &p, &new_prefix, out);
            } else if ft.is_file() && p.extension().map(|e| e == "md").unwrap_or(false) {
                let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let name = if prefix.is_empty() { stem } else { format!("{}/{}", prefix, stem) };
                let desc = parse_skill_description(&p);
                out.push((name, p.to_string_lossy().to_string(), desc));
            }
        }
    }
    walk(dir, dir, "", &mut out);
    let _ = scope;
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    out
}

fn scan_subagents(dir: &std::path::Path, scope: &str) -> Vec<SubagentInfo> {
    scan_md_entries(dir, scope).into_iter().map(|(name, path, description)| SubagentInfo { name, path, scope: scope.to_string(), description }).collect()
}

fn scan_slash_commands(dir: &std::path::Path, scope: &str) -> Vec<SlashCommand> {
    scan_md_entries(dir, scope).into_iter().map(|(name, path, description)| SlashCommand { name, path, scope: scope.to_string(), description }).collect()
}

// Parses hooks from a settings.json file. Claude Code's format is:
//   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
// Events without a matcher (Stop, UserPromptSubmit, etc.) just have the inner "hooks" array.
fn read_hooks_from(path: &std::path::Path, source: &str) -> Vec<HookEntry> {
    let mut out = vec![];
    let Ok(content) = fs::read_to_string(path) else { return out; };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&content) else { return out; };
    let Some(hooks_obj) = json.get("hooks").and_then(|v| v.as_object()) else { return out; };
    let source_path = path.to_string_lossy().to_string();
    for (event, arr) in hooks_obj {
        let Some(arr) = arr.as_array() else { continue; };
        for entry in arr {
            let matcher = entry.get("matcher").and_then(|v| v.as_str()).map(|s| s.to_string());
            let Some(inner) = entry.get("hooks").and_then(|v| v.as_array()) else { continue; };
            for h in inner {
                let command = h.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if command.is_empty() { continue; }
                out.push(HookEntry {
                    event: event.clone(),
                    matcher: matcher.clone(),
                    command,
                    source: source.to_string(),
                    source_path: source_path.clone(),
                });
            }
        }
    }
    out
}

// Walk project looking for CLAUDE.md files. Depth-limited, skips common vendor/build dirs so
// a node_modules with a stray CLAUDE.md doesn't explode the tree.
fn scan_claude_md_files(project_path: &std::path::Path, home: &std::path::Path) -> Vec<ClaudeMdFile> {
    const SKIP: &[&str] = &["node_modules", ".git", "dist", "build", "target", "out", ".next", ".venv", "venv", "__pycache__", ".claude", "coverage"];
    const MAX_DEPTH: usize = 4;
    let mut out = vec![];

    // Project root (shown first, even if missing — no, only existing files).
    let root_md = project_path.join("CLAUDE.md");
    if root_md.exists() {
        out.push(ClaudeMdFile { path: root_md.to_string_lossy().to_string(), rel_path: "CLAUDE.md".to_string(), scope: "project-root".to_string() });
    }

    // Nested — recurse, respecting depth and skip list.
    fn walk(base: &std::path::Path, cur: &std::path::Path, depth: usize, out: &mut Vec<ClaudeMdFile>) {
        if depth > MAX_DEPTH { return; }
        for entry in fs::read_dir(cur).ok().into_iter().flatten().flatten() {
            let p = entry.path();
            let Ok(ft) = entry.file_type() else { continue; };
            if ft.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if SKIP.contains(&name.as_str()) || name.starts_with('.') { continue; }
                walk(base, &p, depth + 1, out);
            } else if ft.is_file() && p.file_name().map(|n| n == "CLAUDE.md").unwrap_or(false) {
                // Skip the root one (already added).
                if p == base.join("CLAUDE.md") { continue; }
                let rel = p.strip_prefix(base).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| p.to_string_lossy().to_string());
                out.push(ClaudeMdFile { path: p.to_string_lossy().to_string(), rel_path: rel, scope: "project-nested".to_string() });
            }
        }
    }
    walk(project_path, project_path, 0, &mut out);

    // User-level (last, so project files lead).
    let user_md = home.join(".claude").join("CLAUDE.md");
    if user_md.exists() {
        out.push(ClaudeMdFile { path: user_md.to_string_lossy().to_string(), rel_path: "~/.claude/CLAUDE.md".to_string(), scope: "user".to_string() });
    }
    out
}

fn scan_settings_sources(project_path: &std::path::Path, home: &std::path::Path) -> Vec<SettingsSource> {
    // Order: local first (wins), then project-shared, then user. UI renders them in the same
    // order so "the one that wins" is on top.
    let local = project_path.join(".claude").join("settings.local.json");
    let project = project_path.join(".claude").join("settings.json");
    let user = home.join(".claude").join("settings.json");
    vec![
        SettingsSource { scope: "local".to_string(), path: local.to_string_lossy().to_string(), exists: local.exists() },
        SettingsSource { scope: "project".to_string(), path: project.to_string_lossy().to_string(), exists: project.exists() },
        SettingsSource { scope: "user".to_string(), path: user.to_string_lossy().to_string(), exists: user.exists() },
    ]
}

fn parse_plugin_manifest(manifest_path: &std::path::Path) -> Option<(String, Option<String>, Option<String>)> {
    let content = fs::read_to_string(manifest_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let name = json.get("name").and_then(|v| v.as_str())?.to_string();
    let version = json.get("version").and_then(|v| v.as_str()).map(|s| s.to_string());
    let description = json.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
    Some((name, version, description))
}

// Read a JSON file's top-level `enabledPlugins: { "<key>": bool }` map.
fn read_enabled_plugins(path: &std::path::Path) -> HashMap<String, bool> {
    let mut out = HashMap::new();
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = json.get("enabledPlugins").and_then(|v| v.as_object()) {
                for (k, v) in obj { if let Some(b) = v.as_bool() { out.insert(k.clone(), b); } }
            }
        }
    }
    out
}

fn parse_mcp_servers(obj: &serde_json::Map<String, serde_json::Value>, source: &str) -> Vec<McpInfo> {
    let mut out = vec![];
    for (name, entry) in obj {
        let kind = entry.get("type").and_then(|v| v.as_str())
            .unwrap_or_else(|| if entry.get("url").is_some() { "http" } else if entry.get("command").is_some() { "stdio" } else { "unknown" })
            .to_string();
        out.push(McpInfo { name: name.clone(), kind, source: source.to_string() });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn read_plugin_mcps(install_path: &std::path::Path) -> Vec<McpInfo> {
    let mcp_json = install_path.join(".mcp.json");
    if !mcp_json.exists() { return vec![]; }
    let Ok(content) = fs::read_to_string(&mcp_json) else { return vec![]; };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&content) else { return vec![]; };
    match json.get("mcpServers").and_then(|v| v.as_object()) {
        Some(obj) => parse_mcp_servers(obj, "plugin"),
        None => vec![],
    }
}

// Case-insensitive Windows-friendly path equality.
fn paths_equal(a: &str, b: &str) -> bool {
    a.replace('\\', "/").to_lowercase() == b.replace('\\', "/").to_lowercase()
}

fn parse_plugin_key(key: &str) -> (String, Option<String>) {
    match key.split_once('@') {
        Some((name, marketplace)) => (name.to_string(), Some(marketplace.to_string())),
        None => (key.to_string(), None),
    }
}

#[tauri::command]
fn get_project_skills(project_path: String) -> ProjectSkills {
    let empty = || ProjectSkills { personal_skills: vec![], project_skills: vec![], plugins: vec![], user_mcps: vec![], project_mcps: vec![], subagents: vec![], slash_commands: vec![], hooks: vec![], claude_md_files: vec![], settings_sources: vec![] };
    let home = match dirs::home_dir() { Some(h) => h, None => return empty() };

    // Regular skills (not plugin-bundled)
    let personal_skills = scan_skills_dir(&home.join(".claude").join("skills"), "personal");
    let project_skills = scan_skills_dir(&std::path::Path::new(&project_path).join(".claude").join("skills"), "project");

    // Enabled maps
    let user_enabled = read_enabled_plugins(&home.join(".claude").join("settings.json"));
    let project_settings_local = std::path::Path::new(&project_path).join(".claude").join("settings.local.json");
    let project_settings = std::path::Path::new(&project_path).join(".claude").join("settings.json");
    let mut project_enabled = read_enabled_plugins(&project_settings_local);
    for (k, v) in read_enabled_plugins(&project_settings) { project_enabled.entry(k).or_insert(v); }

    // Installed plugins
    let mut plugins: Vec<Plugin> = vec![];
    let installed_path = home.join(".claude").join("plugins").join("installed_plugins.json");
    if let Ok(content) = fs::read_to_string(&installed_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = json.get("plugins").and_then(|v| v.as_object()) {
                for (key, entries) in obj {
                    let (name, marketplace) = parse_plugin_key(key);
                    let Some(arr) = entries.as_array() else { continue; };
                    for entry in arr {
                        let scope = entry.get("scope").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let entry_project = entry.get("projectPath").and_then(|v| v.as_str());
                        let install_path = entry.get("installPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let version = entry.get("version").and_then(|v| v.as_str()).map(|s| s.to_string());

                        // Relevance filter: user-scope = global; local-scope = must match current project
                        let relevant = match scope.as_str() {
                            "user" => true,
                            "local" => entry_project.map(|p| paths_equal(p, &project_path)).unwrap_or(false),
                            _ => false,
                        };
                        if !relevant { continue; }

                        let enabled = match scope.as_str() {
                            "user" => user_enabled.get(key).copied().unwrap_or(false),
                            "local" => project_enabled.get(key).copied().unwrap_or(false),
                            _ => false,
                        };

                        let install_path_buf = std::path::PathBuf::from(&install_path);
                        let manifest = install_path_buf.join(".claude-plugin").join("plugin.json");
                        let (resolved_name, resolved_version, description) = if manifest.exists() {
                            let (n, v, d) = parse_plugin_manifest(&manifest).unwrap_or_else(|| (name.clone(), version.clone(), None));
                            (n, v.or(version.clone()), d)
                        } else { (name.clone(), version.clone(), None) };

                        let skills = scan_skills_dir(&install_path_buf.join("skills"), "plugin");
                        let mcps = read_plugin_mcps(&install_path_buf);

                        plugins.push(Plugin {
                            name: resolved_name,
                            marketplace: marketplace.clone(),
                            version: resolved_version,
                            description,
                            scope: scope.clone(),
                            enabled,
                            path: install_path,
                            skills,
                            mcps,
                        });
                    }
                }
            }
        }
    }
    // Show enabled first, then disabled; alpha within each group.
    plugins.sort_by(|a, b| b.enabled.cmp(&a.enabled).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));

    // Standalone MCPs from ~/.claude.json (user-level + per-project)
    let mut user_mcps: Vec<McpInfo> = vec![];
    let mut project_mcps: Vec<McpInfo> = vec![];
    let claude_json_path = home.join(".claude.json");
    if let Ok(content) = fs::read_to_string(&claude_json_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = json.get("mcpServers").and_then(|v| v.as_object()) {
                user_mcps = parse_mcp_servers(obj, "user");
            }
            if let Some(projs) = json.get("projects").and_then(|v| v.as_object()) {
                for (k, v) in projs {
                    if paths_equal(k, &project_path) {
                        if let Some(obj) = v.get("mcpServers").and_then(|v| v.as_object()) {
                            project_mcps = parse_mcp_servers(obj, "project");
                        }
                    }
                }
            }
        }
    }

    // ── Subagents (.claude/agents/*.md) ───────────────────────────────
    let mut subagents = vec![];
    subagents.extend(scan_subagents(&std::path::Path::new(&project_path).join(".claude").join("agents"), "project"));
    subagents.extend(scan_subagents(&home.join(".claude").join("agents"), "user"));

    // ── Slash Commands (.claude/commands/*.md) ────────────────────────
    let mut slash_commands = vec![];
    slash_commands.extend(scan_slash_commands(&std::path::Path::new(&project_path).join(".claude").join("commands"), "project"));
    slash_commands.extend(scan_slash_commands(&home.join(".claude").join("commands"), "user"));

    // ── Hooks (merged from all three settings files) ──────────────────
    let mut hooks = vec![];
    hooks.extend(read_hooks_from(&std::path::Path::new(&project_path).join(".claude").join("settings.local.json"), "local"));
    hooks.extend(read_hooks_from(&std::path::Path::new(&project_path).join(".claude").join("settings.json"), "project"));
    hooks.extend(read_hooks_from(&home.join(".claude").join("settings.json"), "user"));

    // ── CLAUDE.md files ───────────────────────────────────────────────
    let claude_md_files = scan_claude_md_files(std::path::Path::new(&project_path), &home);

    // ── Settings sources (merged view, local > project > user) ────────
    let settings_sources = scan_settings_sources(std::path::Path::new(&project_path), &home);

    ProjectSkills { personal_skills, project_skills, plugins, user_mcps, project_mcps, subagents, slash_commands, hooks, claude_md_files, settings_sources }
}

// ── Project Memories ──────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct Memory {
    name: String,
    description: String,
    #[serde(rename = "type")]
    kind: String,
    path: String,
}

#[derive(Serialize, Clone)]
struct ProjectMemories {
    dir: String,
    items: Vec<Memory>,
}

// Encode a filesystem path the same way Claude Code does when naming project dirs:
// replace any character that isn't alphanumeric / '_' / '-' with '-'.
fn encode_path_for_claude(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect()
}

// Walk up from the project path to find the git repository root. Returns None if we never
// encounter a .git entry — in which case Claude uses the project dir itself for memory storage.
fn find_git_root(start: &std::path::Path) -> Option<PathBuf> {
    let mut cur: Option<&std::path::Path> = Some(start);
    while let Some(d) = cur {
        if d.join(".git").exists() { return Some(d.to_path_buf()); }
        cur = d.parent();
    }
    None
}

// Claude's auto-memory dir: ~/.claude/projects/<encoded-git-root>/memory/.
// All worktrees/subdirs within the same repo share one memory folder; outside a repo the
// project path itself is used. Each .md has YAML frontmatter (name/description/type);
// MEMORY.md is the index and is skipped.
#[tauri::command]
fn get_project_memories(project_path: String) -> ProjectMemories {
    let projects_root = match get_claude_projects_dir() {
        Some(d) => d,
        None => return ProjectMemories { dir: String::new(), items: vec![] },
    };
    let pp = std::path::Path::new(&project_path);
    let repo_root = find_git_root(pp).unwrap_or_else(|| pp.to_path_buf());
    let encoded = encode_path_for_claude(&repo_root.to_string_lossy());
    let dir = projects_root.join(&encoded).join("memory");
    let dir_str = dir.to_string_lossy().to_string();
    if !dir.exists() { return ProjectMemories { dir: dir_str, items: vec![] }; }

    let mut items: Vec<Memory> = Vec::new();
    for entry in fs::read_dir(&dir).ok().into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |e| e != "md") { continue; }
        let filename = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if filename.eq_ignore_ascii_case("MEMORY.md") { continue; }

        let mut name = filename.trim_end_matches(".md").to_string();
        let mut description = String::new();
        let mut kind = String::from("note");

        if let Ok(file) = fs::File::open(&path) {
            let mut in_fm = false;
            let mut fm_started = false;
            for line in BufReader::new(file).lines().take(30).flatten() {
                let trimmed = line.trim();
                if trimmed == "---" {
                    if !fm_started { fm_started = true; in_fm = true; continue; }
                    else { break; }
                }
                if !in_fm { continue; }
                if let Some(v) = trimmed.strip_prefix("name:")       { name = v.trim().trim_matches('"').to_string(); }
                else if let Some(v) = trimmed.strip_prefix("description:") { description = v.trim().trim_matches('"').to_string(); }
                else if let Some(v) = trimmed.strip_prefix("type:") { kind = v.trim().trim_matches('"').to_string(); }
            }
        }
        items.push(Memory { name, description, kind, path: path.to_string_lossy().to_string() });
    }
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    ProjectMemories { dir: dir_str, items }
}

// ── File Explorer ─────────────────────────────────────────────────────

#[tauri::command]
fn get_username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_string())
}

#[tauri::command]
fn get_home_dir() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    use std::process::Command;
    // For file paths we want to open the containing folder (with the file selected on
    // platforms that support it). Without this, Windows' `explorer.exe <file>` would *open*
    // the file in its default app — e.g. launching VS Code for a .md — which is not what
    // "Reveal in Explorer" should do.
    let p = std::path::Path::new(&path);
    let is_file = p.is_file();
    let mut cmd;
    #[cfg(target_os = "windows")]
    {
        cmd = Command::new("explorer.exe");
        if is_file {
            // `/select,<path>` opens the parent folder and highlights the file.
            cmd.arg(format!("/select,{}", path));
        } else {
            cmd.arg(&path);
        }
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(target_os = "macos")]
    {
        cmd = Command::new("open");
        if is_file { cmd.arg("-R"); } // reveal in Finder
        cmd.arg(&path);
    }
    #[cfg(target_os = "linux")]
    {
        cmd = Command::new("xdg-open");
        let target = if is_file {
            p.parent().map(|pp| pp.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())
        } else { path.clone() };
        cmd.arg(target);
    }
    cmd.spawn().map_err(|e| format!("Failed to open explorer: {}", e))?;
    Ok(())
}

// ── File explorer ─────────────────────────────────────────────────────
//
// Single-level directory listing for the terminal's file-explorer panel. Lazy by design:
// the frontend calls this once per folder as the user expands it (mirroring the git panel's
// lazy-polling philosophy) rather than walking the whole tree up front. Returns folders
// first then files, each case-insensitively alphabetical — the order VS Code's explorer uses.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirItem>, String> {
    let rd = fs::read_dir(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    let mut items: Vec<DirItem> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // file_type() avoids a stat syscall on most platforms; for symlinks we follow to
        // decide tree-vs-leaf so a symlinked dir still gets an expand chevron.
        let is_dir = match entry.file_type() {
            Ok(ft) if ft.is_symlink() => entry.path().is_dir(),
            Ok(ft) => ft.is_dir(),
            Err(_) => false,
        };
        items.push(DirItem { name, path: entry.path().to_string_lossy().into_owned(), is_dir });
    }
    items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(items)
}

// Recursive name search under `root` for the file-explorer's search box. Case-insensitive
// substring match on the entry name. Bounded on both axes — at most `limit` matches and a
// hard ceiling on entries visited — so searching a deep tree (or one with node_modules)
// stays responsive rather than walking millions of paths. Symlinked dirs aren't followed,
// which both avoids cycles and keeps the walk bounded.
//
// `async` so Tauri runs it on the async runtime rather than the main thread — a big tree can
// take a moment to walk, and doing it on the main thread would freeze the UI until it returns.
#[tauri::command]
async fn search_dir(root: String, query: String, limit: Option<usize>) -> Vec<DirItem> {
    let q = query.trim().to_lowercase();
    if q.is_empty() { return vec![]; }
    let cap = limit.unwrap_or(300).min(2000);
    const MAX_VISIT: usize = 200_000;
    let mut out: Vec<DirItem> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![std::path::PathBuf::from(&root)];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        if out.len() >= cap || visited >= MAX_VISIT { break; }
        let rd = match fs::read_dir(&dir) { Ok(rd) => rd, Err(_) => continue };
        for entry in rd.flatten() {
            visited += 1;
            if visited >= MAX_VISIT { break; }
            let name = entry.file_name().to_string_lossy().into_owned();
            // Don't follow symlinks: treat them as leaves so the walk can't loop or escape.
            let is_dir = matches!(entry.file_type(), Ok(ft) if ft.is_dir() && !ft.is_symlink());
            if out.len() < cap && name.to_lowercase().contains(&q) {
                out.push(DirItem { name, path: entry.path().to_string_lossy().into_owned(), is_dir });
            }
            if is_dir { stack.push(entry.path()); }
        }
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    use std::process::Command;
    // Only http(s) — open_url is invoked from the frontend, and refusing other schemes
    // prevents an attacker-controlled URL from launching an arbitrary local handler.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http(s) urls are allowed".into());
    }
    let mut cmd;
    #[cfg(target_os = "windows")]
    {
        cmd = Command::new("cmd");
        // Empty "" arg is the window title slot — without it, `start` treats the URL as the title.
        cmd.args(["/c", "start", "", &url]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(target_os = "macos")]
    { cmd = Command::new("open"); cmd.arg(&url); }
    #[cfg(target_os = "linux")]
    { cmd = Command::new("xdg-open"); cmd.arg(&url); }
    cmd.spawn().map_err(|e| format!("Failed to open url: {}", e))?;
    Ok(())
}

// ── Git Status ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitFile {
    pub path: String,
    pub staged: String,   // single char: "M", "A", "D", "R", "C", " ", "?"
    pub unstaged: String, // single char: "M", "D", " ", "?"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub files: Vec<GitFile>,
}

fn parse_porcelain(output: &str) -> GitStatus {
    let mut status = GitStatus { is_repo: true, branch: String::new(), ahead: 0, behind: 0, has_upstream: false, files: vec![] };
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // e.g. "main...origin/main [ahead 1, behind 2]", "main", "HEAD (no branch)"
            let (branch_part, tracking_part) = match rest.find(" [") {
                Some(idx) => (&rest[..idx], &rest[idx + 2..rest.len().saturating_sub(1)]),
                None => (rest, ""),
            };
            let branch_name = branch_part.split("...").next().unwrap_or(branch_part).to_string();
            status.branch = branch_name;
            status.has_upstream = branch_part.contains("...");
            for token in tracking_part.split(", ") {
                if let Some(n) = token.strip_prefix("ahead ") { status.ahead = n.parse().unwrap_or(0); }
                if let Some(n) = token.strip_prefix("behind ") { status.behind = n.parse().unwrap_or(0); }
            }
            continue;
        }
        if line.len() < 3 { continue; }
        let bytes = line.as_bytes();
        let staged = (bytes[0] as char).to_string();
        let unstaged = (bytes[1] as char).to_string();
        let path = line[3..].to_string();
        if path.is_empty() { continue; }
        status.files.push(GitFile { path, staged, unstaged });
    }
    status
}

#[tauri::command]
async fn get_git_status(cwd: String) -> GitStatus {
    use std::process::Command;
    let mut cmd = Command::new("git");
    // core.quotePath=false: emit non-ASCII paths verbatim (UTF-8) instead of octal-escaped and
    // wrapped in quotes. Without it, a file like `Prüflast.cs` comes back as `"Pr\303\274..."`,
    // and that quoted string is then passed to `git diff -- <path>`, which finds nothing — so
    // the diff (and the displayed name) breaks for any path with special characters.
    // --untracked-files=all: list each untracked file individually instead of collapsing a
    // wholly-untracked directory into one `dir/` entry (which rendered as an empty-named row
    // in the changes tree). Matches what VS Code's source-control view shows.
    cmd.arg("-c").arg("core.quotePath=false").arg("status").arg("--porcelain=v1").arg("-b").arg("--untracked-files=all").current_dir(&cwd);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); } // CREATE_NO_WINDOW
    match cmd.output() {
        Ok(o) if o.status.success() => parse_porcelain(&String::from_utf8_lossy(&o.stdout)),
        _ => GitStatus { is_repo: false, branch: String::new(), ahead: 0, behind: 0, has_upstream: false, files: vec![] },
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub relative_time: String,
}

fn git_cmd(cwd: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(cwd);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
    cmd
}

// Repository top-level for `cwd`, or `cwd` itself if it isn't inside a repo. Path-taking git
// commands (diff/add/reset) must run from here because `git status --porcelain` reports paths
// relative to the repo root, while those commands resolve paths relative to the process cwd —
// so a subdirectory cwd would otherwise never match the root-relative paths the UI passes back.
fn git_root(cwd: &str) -> String {
    let mut cmd = git_cmd(cwd);
    cmd.arg("rev-parse").arg("--show-toplevel");
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { cwd.to_string() } else { s }
        }
        _ => cwd.to_string(),
    }
}

#[tauri::command]
async fn get_git_log(cwd: String, limit: Option<u32>) -> Vec<GitCommit> {
    let n = limit.unwrap_or(20).max(1).min(200);
    // Use a rare-in-normal-text separator between fields so we don't collide with subjects.
    let mut cmd = git_cmd(&cwd);
    cmd.arg("log").arg(format!("-{}", n)).arg("--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%cr");
    let out = match cmd.output() { Ok(o) if o.status.success() => o, _ => return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut commits = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(5, '\x1f');
        let hash = parts.next().unwrap_or("").to_string();
        let short_hash = parts.next().unwrap_or("").to_string();
        let subject = parts.next().unwrap_or("").to_string();
        let author = parts.next().unwrap_or("").to_string();
        let relative_time = parts.next().unwrap_or("").to_string();
        if !hash.is_empty() { commits.push(GitCommit { hash, short_hash, subject, author, relative_time }); }
    }
    commits
}

// Take a path as shown in `git status --porcelain` and return the post-rename path when
// it's a rename entry ("old -> new"); otherwise the path unchanged.
fn normalize_git_path(p: &str) -> &str {
    match p.find(" -> ") { Some(idx) => &p[idx + 4..], None => p }
}

// Unified diff for a single changed file, for the git panel's Diff tab. Mode-specific so a file
// that is both staged and further modified shows two distinct diffs depending on the row clicked:
//   staged    → `git diff --cached` (index vs HEAD)
//   unstaged  → `git diff`          (working tree vs index)
//   untracked → `git diff --no-index /dev/null <file>` (whole file as additions)
// Runs from the repo top-level so the root-relative paths from `git status` resolve even when the
// terminal cwd is a subdirectory. --no-ext-diff ignores external diff drivers (diff.external /
// `.gitattributes` diff=<driver>) that would otherwise print nothing; --no-color keeps ANSI out.
#[tauri::command]
async fn git_diff(cwd: String, path: String, mode: String) -> Result<String, String> {
    let p = normalize_git_path(&path).to_string();
    let root = git_root(&cwd);
    let mut cmd = git_cmd(&root);
    cmd.arg("diff").arg("--no-ext-diff").arg("--no-color");
    if mode == "untracked" {
        cmd.arg("--no-index").arg("--").arg("/dev/null").arg(&p);
        let out = cmd.output().map_err(|e| format!("git diff failed: {}", e))?;
        // --no-index exits 1 when the two inputs differ — the normal "found a diff" signal.
        return match out.status.code() {
            Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
            _ => Err(String::from_utf8_lossy(&out.stderr).into_owned()),
        };
    }
    if mode == "staged" { cmd.arg("--cached"); }
    cmd.arg("--").arg(&p);
    let out = cmd.output().map_err(|e| format!("git diff failed: {}", e))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) }
    else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
}

#[tauri::command]
fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() { return Ok(()); }
    let mut cmd = git_cmd(&git_root(&cwd)); // root-relative paths from status; run from the top-level
    cmd.arg("add").arg("--");
    for p in &paths { cmd.arg(normalize_git_path(p)); }
    let out = cmd.output().map_err(|e| format!("git add failed: {}", e))?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).to_string()); }
    Ok(())
}

// ── Branch detection ──────────────────────────────────────────────────
//
// When the user types `/branch` inside a running claude session, claude creates a new
// JSONL that clones the parent's message history — keeping the same message UUIDs. That
// UUID overlap is our structural fingerprint: no unrelated file (manual or otherwise) can
// reproduce 128-bit random UUIDs by accident, so high overlap == this is a real branch.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BranchInfo {
    pub new_session_id: String,
    pub title: String,
}

// Read the first few lines of a jsonl and extract the `forkedFrom.sessionId` field if
// present. Claude writes this on every line of a session that was created via `/branch`,
// so the very first line is enough. Returns None for non-branched sessions.
fn read_forked_from(path: &std::path::Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(5).flatten() {
        let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        if let Some(sid) = v.get("forkedFrom").and_then(|f| f.get("sessionId")).and_then(|s| s.as_str()) {
            return Some(sid.to_string());
        }
    }
    None
}

#[tauri::command]
fn list_project_session_ids(cwd: String) -> Vec<String> {
    let projects_dir = match get_claude_projects_dir() { Some(d) => d, None => return vec![] };
    let project_dir = projects_dir.join(encode_project_name(&cwd));
    if !project_dir.exists() { return vec![]; }
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map_or(true, |e| e != "jsonl") { continue; }
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                out.push(stem.to_string());
            }
        }
    }
    out
}

#[tauri::command]
fn detect_session_branch(cwd: String, current_session_id: String, known_session_ids: Vec<String>) -> Option<BranchInfo> {
    // Project dir derivation mirrors how Claude Code encodes paths (slashes/backslashes/colons → dashes).
    let projects_dir = get_claude_projects_dir()?;
    let encoded = encode_project_name(&cwd);
    let project_dir = projects_dir.join(&encoded);
    if !project_dir.exists() { return None; }

    // `known_session_ids` = snapshot of sibling jsonls that existed at tab startup. Anything
    // NOT in this set is a freshly-created file — the only kind we consider. This also rules
    // out false positives when the user resumes an ancestor session in another tab.
    let known: std::collections::HashSet<String> = known_session_ids.into_iter().collect();

    // Scan new sibling .jsonl files. For each, read the first few lines and check the
    // `forkedFrom.sessionId` field — Claude writes this on every line of a branched session.
    // If it matches our current session id, it's definitively our fork. No heuristics needed.
    for entry in fs::read_dir(&project_dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().map_or(true, |e| e != "jsonl") { continue; }
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if stem == current_session_id { continue; }
        if known.contains(&stem) { continue; }
        match read_forked_from(&p) {
            Some(parent_id) if parent_id == current_session_id => {
                let project_name = std::path::Path::new(&cwd).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let title = parse_session(&p, &project_name, &cwd)
                    .map(|s| s.title)
                    .unwrap_or_else(|| format!("Branch {}", &stem[..8.min(stem.len())]));
                return Some(BranchInfo { new_session_id: stem, title });
            }
            _ => continue,
        }
    }
    None
}

#[tauri::command]
fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() { return Ok(()); }
    let mut cmd = git_cmd(&git_root(&cwd)); // root-relative paths from status; run from the top-level
    cmd.arg("reset").arg("HEAD").arg("--");
    for p in &paths { cmd.arg(normalize_git_path(p)); }
    let out = cmd.output().map_err(|e| format!("git reset failed: {}", e))?;
    // `git reset HEAD` exits non-zero when the repo has no commits yet; surface as success
    // with whatever it wrote, because the state change is still effective for staged files.
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stderr.contains("ambiguous argument 'HEAD'") { return Err(stderr.to_string()); }
    }
    Ok(())
}

// Discard a file's changes, scoped to the section it was invoked from so it never clobbers more
// than intended:
//   unstaged  → `git checkout -- <path>`      (restore working tree from the INDEX — drops only
//               the unstaged edits, keeps anything already staged)
//   staged    → `git checkout HEAD -- <path>` (restore index + working tree to HEAD — drops the
//               file's changes entirely)
//   untracked → delete the file
// Destructive and irreversible, so the UI confirms first. Runs from the repo root.
#[tauri::command]
async fn git_discard(cwd: String, path: String, mode: String) -> Result<(), String> {
    let root = git_root(&cwd);
    let p = normalize_git_path(&path).to_string();
    if mode == "untracked" {
        let full = std::path::Path::new(&root).join(&p);
        return fs::remove_file(&full).map_err(|e| format!("Failed to delete {}: {}", p, e));
    }
    let mut cmd = git_cmd(&root);
    cmd.arg("checkout");
    if mode == "staged" { cmd.arg("HEAD"); } // staged: revert index + worktree to HEAD
    // unstaged (no ref): restore the working tree from the index, leaving staged changes intact
    cmd.arg("--").arg(&p);
    let out = cmd.output().map_err(|e| format!("git checkout failed: {}", e))?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).to_string()); }
    Ok(())
}

// ── Branch list / checkout ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitBranch {
    pub name: String,            // short name: "main", "feature/foo"
    pub full_ref: String,        // "refs/heads/main" or "refs/remotes/origin/foo"
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: String,        // empty when none
    pub last_commit_subject: String,
    pub last_commit_relative: String,
}

#[tauri::command]
fn list_git_branches(cwd: String) -> Vec<GitBranch> {
    // ASCII unit-separator (\x1f) between fields keeps subjects with spaces / tabs intact.
    // Sorted by committer date desc so the dropdown opens with the most-relevant branches up
    // top — current branch + recent feature branches before stale ones.
    let format = "%(refname)\x1f%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(committerdate:relative)\x1f%(subject)";
    let mut cmd = git_cmd(&cwd);
    cmd.arg("for-each-ref").arg("--sort=-committerdate").arg(format!("--format={}", format)).arg("refs/heads/").arg("refs/remotes/");
    let out = match cmd.output() { Ok(o) if o.status.success() => o, _ => return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(6, '\x1f');
        let full_ref = parts.next().unwrap_or("").to_string();
        let name = parts.next().unwrap_or("").to_string();
        let head_marker = parts.next().unwrap_or("");
        let upstream = parts.next().unwrap_or("").to_string();
        let last_commit_relative = parts.next().unwrap_or("").to_string();
        let last_commit_subject = parts.next().unwrap_or("").to_string();
        if name.is_empty() { continue; }
        // Skip `origin/HEAD` symbolic ref — it's a pointer, not a real branch the user can switch to.
        if full_ref.ends_with("/HEAD") { continue; }
        let is_remote = full_ref.starts_with("refs/remotes/");
        let is_current = head_marker == "*";
        branches.push(GitBranch { name, full_ref, is_current, is_remote, upstream, last_commit_subject, last_commit_relative });
    }
    branches
}

#[tauri::command]
fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    // For remote refs we hand `git switch` the bare branch name (e.g. "feature/foo" not
    // "origin/feature/foo"). Since git 2.23, `switch <name>` does DWIM: if no local branch
    // exists but exactly one remote tracks it, git creates the local branch + sets upstream.
    let target = branch.strip_prefix("origin/").unwrap_or(&branch).to_string();
    let mut cmd = git_cmd(&cwd);
    cmd.arg("switch").arg(&target);
    let out = cmd.output().map_err(|e| format!("git switch failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // Empty stderr can happen on truly-fatal git errors; give the user *something* useful.
        return Err(if stderr.is_empty() { format!("git switch exited with status {}", out.status) } else { stderr });
    }
    Ok(())
}

// ── Terminal / PTY Commands ────────────────────────────────────────────

// The Git Bash preset sends bare `bash.exe`, which on Windows resolves via PATH and gets
// shadowed by C:\Windows\System32\bash.exe (the WSL launcher) — that dies with a cryptic
// `execvpe(/bin/bash) failed` when no WSL distro is installed. Probe known Git for Windows
// install locations and return the first existing match so we spawn the real Git Bash.
fn resolve_gitbash_path() -> Option<PathBuf> {
    let candidates: &[(&str, &[&str])] = &[
        ("ProgramFiles",      &["Git", "bin", "bash.exe"]),
        ("ProgramFiles(x86)", &["Git", "bin", "bash.exe"]),
        ("LOCALAPPDATA",      &["Programs", "Git", "bin", "bash.exe"]),
    ];
    for (env_var, parts) in candidates {
        if let Ok(base) = std::env::var(env_var) {
            let mut p = PathBuf::from(base);
            for part in *parts { p.push(part); }
            if p.exists() { return Some(p); }
        }
    }
    None
}

// PTY transport tuning. The flusher coalesces a short window after the first
// byte so a burst ships as one binary chunk; MAX_IDLE is just a wakeup safety net. The pending
// buffer is capped so a frontend that stalls can't grow it unbounded — on overflow we discard
// the backlog and inject a hard reset rather than slice a CSI sequence in half.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
const FLUSH_MAX_IDLE: Duration = Duration::from_millis(50);
const READ_BUF: usize = 16 * 1024;
const MAX_PENDING: usize = 4 * 1024 * 1024;
const OVERFLOW_NOTICE: &[u8] = b"\x1bc\x1b[2m[xshell: dropped output due to backpressure]\x1b[0m\r\n";

#[tauri::command]
fn spawn_terminal(state: State<'_, AppState>, id: String, session_id: Option<String>, cwd: String, cols: u16, rows: u16, shell_mode: Option<String>, shell_command: Option<String>, shell_id: Option<String>, agent: Option<String>, fullscreen_rendering: Option<bool>, force_sync_output: Option<bool>, on_data: Channel<Response>, on_exit: Channel<i32>) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mode = shell_mode.as_deref().unwrap_or("claude");
    // Which agent CLI this tab hosts. Each agent's resume form differs; everything else
    // (shell wrapping, PTY plumbing) is agent-agnostic and shared.
    let agent_bin = match agent.as_deref() {
        Some("codex") => "codex",
        Some("cursor") => "cursor-agent",
        Some("opencode") => "opencode",
        _ => "claude",
    };
    // Resume args per agent:
    //  - Claude: new chats arrive with a pre-allocated UUID and no JSONL on disk → use
    //    `--session-id` so Claude creates the session under our UUID (leaving customTitle
    //    empty so ai-title can fire). Existing sessions have a JSONL → `--resume`.
    //  - Codex:  `codex resume <id>`.
    //  - Cursor: `cursor-agent --resume=<id>`.
    //  - opencode: `opencode --session <id>` (resolved against the project cwd we spawn in).
    // New Codex/Cursor/opencode chats carry no session_id (they start unlinked) → spawn bare.
    let agent_args: Vec<String> = {
        let mut v = Vec::new();
        if let Some(ref sid) = session_id {
            match agent_bin {
                "codex" => { v.push("resume".into()); v.push(sid.clone()); }
                "cursor-agent" => { v.push(format!("--resume={}", sid)); }
                "opencode" => { v.push("--session".into()); v.push(sid.clone()); }
                _ => {
                    let jsonl_exists = get_claude_projects_dir()
                        .map(|d| d.join(encode_project_name(&cwd)).join(format!("{}.jsonl", sid)).exists())
                        .unwrap_or(false);
                    v.push(if jsonl_exists { "--resume".into() } else { "--session-id".into() });
                    v.push(sid.clone());
                }
            }
        }
        v
    };
    let shell_kind = shell_id.as_deref().unwrap_or("");
    // Override the frontend-supplied `bash.exe` for the Git Bash preset with an absolute path
    // — see resolve_gitbash_path() for why. Surface a clear error if Git for Windows isn't
    // installed, instead of letting WSL emit its execvpe message.
    let gitbash_resolved: Option<String> = if shell_kind == "gitbash" {
        Some(resolve_gitbash_path().ok_or_else(|| "Git Bash not found. Install Git for Windows or choose a different shell preset.".to_string())?.to_string_lossy().into_owned())
    } else {
        None
    };
    let effective_shell = gitbash_resolved.as_deref().or(shell_command.as_deref());
    // PowerShell's command precedence ranks `.ps1` external scripts above `.cmd` shims, so a
    // bare `claude` resolves to the unsigned npm `claude.ps1` — which an `AllSigned` execution
    // policy refuses to run (issue #41). Resolve the `.cmd` shim explicitly for the PowerShell
    // host: batch shims aren't subject to execution policy. Falls back to the bare name when no
    // .cmd is on PATH (e.g. a native .exe install), where bare resolution is safe anyway.
    #[cfg(windows)]
    fn resolve_cmd_shim(bin: &str) -> Option<String> {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("where");
        cmd.arg(format!("{}.cmd", bin));
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let out = cmd.output().ok()?;
        if !out.status.success() { return None; }
        String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string()).filter(|s| !s.is_empty())
    }
    #[cfg(not(windows))]
    fn resolve_cmd_shim(_bin: &str) -> Option<String> { None }
    let mut cmd = if mode == "raw" {
        // Raw shell: spawn the chosen shell directly (no claude wrapping).
        let shell = effective_shell.unwrap_or_else(|| if cfg!(windows) { "powershell.exe" } else { "bash" });
        CommandBuilder::new(shell)
    } else if let Some(shell) = effective_shell.filter(|s| !s.is_empty()) {
        // Agent mode with an explicit host shell: launch the shell and run the agent inside it
        // so the user's preferred shell wraps the session (and stays alive after the agent exits).
        match shell_kind {
            "powershell" | "pwsh" => {
                let mut c = CommandBuilder::new(shell);
                c.arg("-NoLogo");
                c.arg("-NoExit");
                c.arg("-Command");
                // & 'claude' 'arg1' 'arg2' — single-quoted to avoid PS expansion surprises.
                // Prefer the .cmd shim over the bare name so AllSigned policies don't block
                // the unsigned .ps1 shim (see resolve_cmd_shim / issue #41).
                let exec = resolve_cmd_shim(agent_bin).unwrap_or_else(|| agent_bin.to_string());
                let mut s = format!("& '{}'", exec.replace('\'', "''"));
                for a in &agent_args { s.push(' '); s.push('\''); s.push_str(&a.replace('\'', "''")); s.push('\''); }
                c.arg(s);
                c
            }
            "cmd" => {
                let mut c = CommandBuilder::new(shell);
                c.arg("/K");
                c.arg(agent_bin);
                for a in &agent_args { c.arg(a); }
                c
            }
            "gitbash" | "bash" | "zsh" | "fish" => {
                // bash -i -c "claude arg1 arg2; exec bash -i"
                let mut c = CommandBuilder::new(shell);
                c.arg("-i");
                c.arg("-c");
                fn q(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }
                let mut s = String::from(agent_bin);
                for a in &agent_args { s.push(' '); s.push_str(&q(a)); }
                // Keep the shell alive after the agent exits so the user retains a prompt.
                let basename = std::path::Path::new(shell).file_stem().and_then(|o| o.to_str()).unwrap_or("bash");
                s.push_str(&format!("; exec {} -i", basename));
                c.arg(s);
                c
            }
            _ => {
                // Unknown shell_id — fall back to the pre-existing OS-default behavior.
                if cfg!(windows) {
                    let mut c = CommandBuilder::new("cmd.exe");
                    c.arg("/C");
                    c.arg(agent_bin);
                    for a in &agent_args { c.arg(a); }
                    c
                } else {
                    let mut c = CommandBuilder::new(agent_bin);
                    for a in &agent_args { c.arg(a); }
                    c
                }
            }
        }
    } else if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/C");
        c.arg(agent_bin);
        for a in &agent_args { c.arg(a); }
        c
    } else {
        let mut c = CommandBuilder::new(agent_bin);
        for a in &agent_args { c.arg(a); }
        c
    };
    // Tag the terminal so Claude Code's OTEL telemetry attributes sessions to this app
    // (telemetry reads `terminal.type` from TERM_PROGRAM; without this we'd land in the
    // Unknown bucket). Always set — no user-facing toggle.
    cmd.env("TERM_PROGRAM", "xshell.sh");
    // Claude Code's flicker-free / alternate-screen-buffer renderer is opt-in via env var.
    // Default ON for any claude-mode spawn; raw shells don't get it (no claude process to read it).
    // Inherited by the wrapping shell → claude child, so setting it here is sufficient.
    if mode != "raw" && agent_bin == "claude" && fullscreen_rendering.unwrap_or(true) {
        cmd.env("CLAUDE_CODE_NO_FLICKER", "1");
    }
    // Force synchronized output mode (DEC 2026). Claude's auto-detection looks at $TERM
    // and won't enable sync output for plain xterm-256color, but xterm.js v5+ supports it
    // natively. With this flag, claude wraps each TUI frame in \x1b[?2026h..\x1b[?2026l
    // so xterm renders only complete frames — fixes the "flying letters" residue we get
    // when xterm sees half-drawn frames. Requires Claude Code ≥ 2.1.129.
    if mode != "raw" && agent_bin == "claude" && force_sync_output.unwrap_or(true) {
        cmd.env("CLAUDE_CODE_FORCE_SYNC_OUTPUT", "1");
    }
    // Empty cwd → fall back to the user's home directory (raw shells launched from home view).
    let effective_cwd = if cwd.is_empty() {
        dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| ".".to_string())
    } else { cwd };
    cmd.cwd(&effective_cwd);

    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn command: {}", e))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair.master.take_writer().map_err(|e| format!("Failed to take writer: {}", e))?;

    // ── PTY → frontend transport ─────────────────────────────────────────
    // Reader thread does blocking reads of large chunks and appends RAW BYTES to a shared
    // buffer. A separate flusher coalesces a short window so a burst (e.g. a full TUI repaint)
    // ships as ONE binary Channel message instead of many JSON events. The frontend feeds the
    // bytes straight to xterm, which reassembles multibyte/escape sequences across chunk
    // boundaries — so the renderer only ever sees whole frames (no partial-frame jitter), and
    // we never split a CSI sequence or a UTF-8 codepoint the way per-4KB from_utf8_lossy did.
    let pending: Arc<(Mutex<Vec<u8>>, Condvar)> = Arc::new((Mutex::new(Vec::with_capacity(READ_BUF)), Condvar::new()));
    let done = Arc::new(AtomicBool::new(false));

    let pending_r = pending.clone();
    let done_r = done.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let (lock, cv) = &*pending_r;
                    let mut g = lock.lock().unwrap();
                    // Backpressure: discard the whole backlog (slicing it would corrupt xterm
                    // mid-escape) and drop a hard reset + notice in its place.
                    if g.len() + n > MAX_PENDING {
                        g.clear();
                        g.extend_from_slice(OVERFLOW_NOTICE);
                    }
                    g.extend_from_slice(&buf[..n]);
                    cv.notify_one();
                }
            }
        }
        done_r.store(true, Ordering::Release);
        pending_r.1.notify_one();
    });

    // Flusher: wait for data, coalesce a burst into one chunk, send as binary. When the reader
    // has hit EOF and the buffer is fully drained, emit the exit signal — same thread, so the
    // exit never races ahead of the final output chunk.
    let pending_f = pending;
    let done_f = done;
    std::thread::spawn(move || {
        let (lock, cv) = &*pending_f;
        loop {
            {
                let mut g = lock.lock().unwrap();
                while g.is_empty() {
                    if done_f.load(Ordering::Acquire) {
                        let _ = on_exit.send(0);
                        return;
                    }
                    let (next, _) = cv.wait_timeout(g, FLUSH_MAX_IDLE).unwrap();
                    g = next;
                }
            }
            std::thread::sleep(FLUSH_COALESCE);
            let chunk = std::mem::take(&mut *lock.lock().unwrap());
            if chunk.is_empty() {
                continue;
            }
            if on_data.send(Response::new(chunk)).is_err() {
                break;
            }
        }
    });

    state.terminals.lock().unwrap().insert(id, TerminalHandle { writer: Box::new(writer), master: pair.master });
    Ok(())
}

#[tauri::command]
fn write_terminal(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let mut terminals = state.terminals.lock().unwrap();
    if let Some(handle) = terminals.get_mut(&id) {
        handle.writer.write_all(data.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
        handle.writer.flush().map_err(|e| format!("Flush failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let terminals = state.terminals.lock().unwrap();
    if let Some(handle) = terminals.get(&id) {
        handle.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("Resize failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn close_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut terminals = state.terminals.lock().unwrap();
    terminals.remove(&id);
    Ok(())
}

// ── xshell-stats integration ──────────────────────────────────────────
// Reads pre-computed session stats produced by a Claude Code statusLine hook (the user's
// own script writes them to ~/.claude/xshell-stats/<session_id>.json). When present, this
// gives us authoritative cost / context-% / rate-limits straight from Claude Code instead
// of our JSONL-derived estimates.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StatuslineProbe {
    // Whether the user has any statusLine configured at all in ~/.claude/settings.json.
    pub has_statusline: bool,
    pub existing_command: Option<String>,
    // Whether xshell-stats/ exists and has at least one session file (proxy for "is the
    // hook script actually running?"). When `has_statusline` is true but this is false,
    // the user likely needs to merge our snippet into their existing script.
    pub stats_dir_present: bool,
    pub stats_session_count: usize,
    // Most recent file mtime in xshell-stats/ as ISO-8601, for the "last update X ago" UI.
    pub last_update_iso: Option<String>,
    pub home_dir: String,
    pub stats_dir_path: String,
}

#[tauri::command]
fn probe_statusline_setup() -> StatuslineProbe {
    let home = dirs::home_dir().unwrap_or_default();
    let stats_dir = home.join(".claude").join("xshell-stats");
    let settings_path = home.join(".claude").join("settings.json");

    let mut has_statusline = false;
    let mut existing_command: Option<String> = None;
    if let Ok(content) = fs::read_to_string(&settings_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(sl) = json.get("statusLine") {
                has_statusline = true;
                existing_command = sl.get("command").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
        }
    }

    let mut stats_session_count = 0usize;
    let mut last_modified: Option<SystemTime> = None;
    if stats_dir.exists() {
        for entry in fs::read_dir(&stats_dir).ok().into_iter().flatten().flatten() {
            if entry.file_type().map_or(false, |ft| ft.is_file()) {
                stats_session_count += 1;
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if last_modified.map_or(true, |m| modified > m) {
                            last_modified = Some(modified);
                        }
                    }
                }
            }
        }
    }

    StatuslineProbe {
        has_statusline,
        existing_command,
        stats_dir_present: stats_dir.exists(),
        stats_session_count,
        last_update_iso: last_modified.map(system_time_to_iso),
        home_dir: home.to_string_lossy().into_owned(),
        stats_dir_path: stats_dir.to_string_lossy().into_owned(),
    }
}

// Global rate-limit snapshot. The numbers are account-wide (not per-session) — Claude Code
// reports the same 5h/7d percentages on every session's statusline at any given moment. We
// pick the freshest stats file as the source of truth and surface it once, in the sidebar.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GlobalRateLimits {
    pub five_hour_pct: Option<f64>,
    pub seven_day_pct: Option<f64>,
    pub five_hour_resets_at: Option<u64>,   // unix seconds
    pub seven_day_resets_at: Option<u64>,
    pub last_update_iso: Option<String>,
    pub source_session_id: Option<String>,
}

#[tauri::command]
fn get_global_rate_limits() -> GlobalRateLimits {
    let mut out = GlobalRateLimits {
        five_hour_pct: None, seven_day_pct: None,
        five_hour_resets_at: None, seven_day_resets_at: None,
        last_update_iso: None, source_session_id: None,
    };
    let Some(home) = dirs::home_dir() else { return out; };
    let stats_dir = home.join(".claude").join("xshell-stats");
    if !stats_dir.exists() { return out; }

    // Collect files newest-first by mtime. We can't just read the single freshest file:
    // Claude Code omits the `rate_limits` block from ~half of its statusline ticks (e.g. a
    // session's early ticks before the first API response carries rate-limit headers), and
    // the hook overwrites the whole payload each tick. So the newest file often lacks rate
    // limits even when older files hold a valid snapshot. Walk newest→oldest and take the
    // first file that actually has rate-limit data — last-known-good beats a blank chip,
    // and rate limits are account-wide + slow-moving so a slightly older snapshot is fine.
    let mut files: Vec<(SystemTime, std::path::PathBuf)> = fs::read_dir(&stats_dir).ok().into_iter().flatten().flatten()
        .filter(|e| e.file_type().map_or(false, |ft| ft.is_file()))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));

    for (mtime, path) in &files {
        let Ok(content) = fs::read_to_string(path) else { continue };
        let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&content) else { continue };
        let Some(rl) = json.get("rate_limits") else { continue };
        let five = rl.get("five_hour");
        let seven = rl.get("seven_day");
        // Require at least one window's percentage to consider this a usable snapshot.
        let five_pct = five.and_then(|w| w.get("used_percentage")).and_then(|v| v.as_f64());
        let seven_pct = seven.and_then(|w| w.get("used_percentage")).and_then(|v| v.as_f64());
        if five_pct.is_none() && seven_pct.is_none() { continue; }

        out.five_hour_pct = five_pct;
        out.five_hour_resets_at = five.and_then(|w| w.get("resets_at")).and_then(|v| v.as_u64());
        out.seven_day_pct = seven_pct;
        out.seven_day_resets_at = seven.and_then(|w| w.get("resets_at")).and_then(|v| v.as_u64());
        // Report the freshness of the snapshot we actually used, not the newest file overall.
        out.last_update_iso = Some(system_time_to_iso(*mtime));
        out.source_session_id = path.file_stem().map(|s| s.to_string_lossy().into_owned());
        break;
    }
    out
}

// ── Codex project context ─────────────────────────────────────────────
// What the context tree shows for Codex. Returned as GENERIC titled sections rather than
// Codex-specific fields — the frontend renders sections without knowing the agent, which
// is the pattern every future agent's context command should follow (Claude's richer
// panel predates this and stays bespoke).

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentContextItem {
    pub name: String,
    pub detail: String, // secondary line (scope, command, …); empty when none
    pub path: String,   // openable file path; empty when not file-backed
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentContextSection {
    pub title: String,
    pub items: Vec<AgentContextItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexContext {
    pub present: bool, // any Codex artifacts found for this project
    pub trust_level: Option<String>, // from [projects.'<path>'] in config.toml
    pub sections: Vec<AgentContextSection>,
}

#[tauri::command]
fn get_codex_context(project_path: String) -> CodexContext {
    let home = dirs::home_dir();
    let mut sections: Vec<AgentContextSection> = vec![];

    // Instructions — AGENTS.md at the project root (plus git root when different) and the
    // global ~/.codex/AGENTS.md; Codex's counterpart of CLAUDE.md files.
    let pp = std::path::Path::new(&project_path);
    let mut candidates: Vec<(std::path::PathBuf, &str)> = vec![(pp.join("AGENTS.md"), "project")];
    if let Some(root) = find_git_root(pp) {
        if root.as_path() != pp { candidates.push((root.join("AGENTS.md"), "repo root")); }
    }
    if let Some(h) = &home { candidates.push((h.join(".codex").join("AGENTS.md"), "global")); }
    let instructions: Vec<AgentContextItem> = candidates.into_iter()
        .filter(|(p, _)| p.exists())
        .map(|(p, scope)| AgentContextItem { name: "AGENTS.md".into(), detail: scope.into(), path: p.to_string_lossy().into_owned() })
        .collect();
    if !instructions.is_empty() { sections.push(AgentContextSection { title: "Instructions".into(), items: instructions }); }

    // Prompts — ~/.codex/prompts/*.md, Codex's slash-command equivalent (always global).
    if let Some(h) = &home {
        let mut prompts: Vec<AgentContextItem> = fs::read_dir(h.join(".codex").join("prompts")).ok().into_iter().flatten().flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.extension().map_or(true, |ext| ext != "md") { return None; }
                let stem = p.file_stem()?.to_string_lossy().into_owned();
                Some(AgentContextItem { name: format!("/{}", stem), detail: "global".into(), path: p.to_string_lossy().into_owned() })
            })
            .collect();
        prompts.sort_by(|a, b| a.name.cmp(&b.name));
        if !prompts.is_empty() { sections.push(AgentContextSection { title: "Prompts".into(), items: prompts }); }
    }

    // MCP servers + per-project trust level from ~/.codex/config.toml. The file is simple
    // enough that a line scan beats pulling in a TOML dependency: section headers carry the
    // server name / project path, `command =` and `trust_level =` live inside them.
    let mut mcp_items: Vec<AgentContextItem> = vec![];
    let mut trust_level: Option<String> = None;
    if let Some(h) = &home {
        if let Ok(cfg) = fs::read_to_string(h.join(".codex").join("config.toml")) {
            let norm_project = project_path.replace('/', "\\").trim_end_matches('\\').to_lowercase();
            let unquote = |s: &str| s.trim().trim_matches('"').trim_matches('\'').to_string();
            let mut current_section = String::new();
            for raw in cfg.lines() {
                let line = raw.trim();
                if line.starts_with('[') && line.ends_with(']') {
                    current_section = line[1..line.len() - 1].trim().to_string();
                    if let Some(name) = current_section.strip_prefix("mcp_servers.") {
                        mcp_items.push(AgentContextItem { name: unquote(name), detail: String::new(), path: String::new() });
                    }
                    continue;
                }
                if current_section.starts_with("mcp_servers.") && line.starts_with("command") {
                    if let (Some(last), Some(v)) = (mcp_items.last_mut(), line.splitn(2, '=').nth(1)) {
                        if last.detail.is_empty() { last.detail = unquote(v); }
                    }
                } else if let Some(key) = current_section.strip_prefix("projects.") {
                    let key = unquote(key).replace('/', "\\").trim_end_matches('\\').to_lowercase();
                    if key == norm_project && line.starts_with("trust_level") {
                        if let Some(v) = line.splitn(2, '=').nth(1) {
                            let v = unquote(v);
                            if !v.is_empty() { trust_level = Some(v); }
                        }
                    }
                }
            }
        }
    }
    if !mcp_items.is_empty() { sections.push(AgentContextSection { title: "MCP servers".into(), items: mcp_items }); }

    CodexContext { present: !sections.is_empty() || trust_level.is_some(), trust_level, sections }
}

// ── Cursor project context ────────────────────────────────────────────
// Cursor reads its own .cursor/rules, plus AGENTS.md and CLAUDE.md at the project root, and
// MCP servers from mcp.json (project + global). Returned as the same generic titled sections
// as Codex so the context tree renders it with no agent-specific frontend code.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CursorContext {
    pub present: bool,
    pub sections: Vec<AgentContextSection>,
}

#[tauri::command]
fn get_cursor_context(project_path: String) -> CursorContext {
    let pp = std::path::Path::new(&project_path);
    let mut sections: Vec<AgentContextSection> = vec![];

    // Rules — .cursor/rules/**/*.{mdc,md}. Cursor allows nested rule folders, so walk the tree.
    let rules_dir = pp.join(".cursor").join("rules");
    let mut rules: Vec<AgentContextItem> = vec![];
    let mut stack = vec![rules_dir.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).ok().into_iter().flatten().flatten() {
            let p = entry.path();
            if entry.file_type().map_or(false, |ft| ft.is_dir()) { stack.push(p); continue; }
            if p.extension().map_or(true, |ext| ext != "mdc" && ext != "md") { continue; }
            let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            // Show the sub-path under rules/ as the detail when the rule is nested.
            let detail = p.parent().and_then(|par| par.strip_prefix(&rules_dir).ok()).map(|r| r.to_string_lossy().replace('\\', "/")).filter(|s| !s.is_empty()).unwrap_or_default();
            rules.push(AgentContextItem { name, detail, path: p.to_string_lossy().into_owned() });
        }
    }
    rules.sort_by(|a, b| a.name.cmp(&b.name));
    if !rules.is_empty() { sections.push(AgentContextSection { title: "Rules".into(), items: rules }); }

    // Instructions — AGENTS.md / CLAUDE.md at the project root (Cursor applies both as rules).
    let instructions: Vec<AgentContextItem> = ["AGENTS.md", "CLAUDE.md"].iter()
        .map(|f| pp.join(f))
        .filter(|p| p.exists())
        .map(|p| AgentContextItem { name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), detail: "project".into(), path: p.to_string_lossy().into_owned() })
        .collect();
    if !instructions.is_empty() { sections.push(AgentContextSection { title: "Instructions".into(), items: instructions }); }

    // MCP servers — project .cursor/mcp.json then global ~/.cursor/mcp.json. Same
    // { "mcpServers": { name: {...} } } shape Claude/Cursor share.
    let mut mcp_items: Vec<AgentContextItem> = vec![];
    let mut read_mcp = |path: std::path::PathBuf, scope: &str| {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in servers {
                        let detail = cfg.get("command").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| scope.to_string());
                        mcp_items.push(AgentContextItem { name: name.clone(), detail, path: String::new() });
                    }
                }
            }
        }
    };
    read_mcp(pp.join(".cursor").join("mcp.json"), "project");
    if let Some(home) = dirs::home_dir() { read_mcp(home.join(".cursor").join("mcp.json"), "global"); }
    if !mcp_items.is_empty() { sections.push(AgentContextSection { title: "MCP servers".into(), items: mcp_items }); }

    CursorContext { present: !sections.is_empty(), sections }
}

// ── Home usage strip ──────────────────────────────────────────────────
// Aggregates for the dashboard strip on the home screen. Claude cost comes from the
// xshell-stats hook files (authoritative, per-session daily maps summed across sessions);
// Codex rate limits and activity come straight from the rollout files — Codex needs no
// hook, every token_count event carries usage + rate-limit data.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailyUsd {
    pub date: String, // YYYY-MM-DD as written by the hook (local date)
    pub usd: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeCostSummary {
    // Whether any xshell-stats session files exist — the strip's "hook is set up" signal.
    pub connected: bool,
    pub daily: Vec<DailyUsd>, // ascending by date; today/this-week math happens client-side
}

#[tauri::command]
fn get_claude_cost_summary() -> ClaudeCostSummary {
    let Some(home) = dirs::home_dir() else { return ClaudeCostSummary { connected: false, daily: vec![] } };
    let stats_dir = home.join(".claude").join("xshell-stats");

    let mut connected = false;
    let mut by_date: HashMap<String, f64> = HashMap::new();
    for entry in fs::read_dir(&stats_dir).ok().into_iter().flatten().flatten() {
        if !entry.file_type().map_or(false, |ft| ft.is_file()) { continue; }
        let Ok(content) = fs::read_to_string(entry.path()) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
        connected = true;
        if let Some(map) = json.get("xshell_daily_cost").and_then(|v| v.as_object()) {
            for (date, usd) in map {
                if let Some(u) = usd.as_f64() { *by_date.entry(date.clone()).or_insert(0.0) += u; }
            }
        }
    }

    let mut daily: Vec<DailyUsd> = by_date.into_iter().map(|(date, usd)| DailyUsd { date, usd }).collect();
    daily.sort_by(|a, b| a.date.cmp(&b.date));
    ClaudeCostSummary { connected, daily }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexRateWindow {
    pub used_percent: Option<f64>,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<u64>, // unix seconds
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailySessionCount {
    pub date: String, // YYYY-MM-DD from the sessions/YYYY/MM/DD/ directory layout (local date)
    pub count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexUsage {
    pub present: bool, // any rollout files at all
    pub primary: Option<CodexRateWindow>,   // 5h window
    pub secondary: Option<CodexRateWindow>, // 7d window
    pub plan_type: Option<String>,
    // When the token_count event we read was written — rate limits are only as fresh as the
    // last Codex run, so the UI shows "as of X ago" instead of presenting them as live.
    pub rate_limits_updated_iso: Option<String>,
    pub daily_sessions: Vec<DailySessionCount>,
}

#[tauri::command]
fn get_codex_usage() -> CodexUsage {
    let mut out = CodexUsage { present: false, primary: None, secondary: None, plan_type: None, rate_limits_updated_iso: None, daily_sessions: vec![] };
    let Some(home) = dirs::home_dir() else { return out };
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() { return out; }

    // Collect rollout files with their mtime and the local date encoded in the directory path.
    let mut files: Vec<(std::path::PathBuf, Option<SystemTime>, Option<String>)> = vec![];
    let mut stack = vec![sessions_dir];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).ok().into_iter().flatten().flatten() {
            let p = entry.path();
            if entry.file_type().map_or(false, |ft| ft.is_dir()) { stack.push(p); continue; }
            if p.extension().map_or(true, |ext| ext != "jsonl") { continue; }
            let date = (|| {
                let dd = p.parent()?.file_name()?.to_str()?.to_string();
                let mm = p.parent()?.parent()?.file_name()?.to_str()?.to_string();
                let yyyy = p.parent()?.parent()?.parent()?.file_name()?.to_str()?.to_string();
                if yyyy.len() == 4 && yyyy.chars().all(|c| c.is_ascii_digit()) { Some(format!("{}-{}-{}", yyyy, mm, dd)) } else { None }
            })();
            let mtime = fs::metadata(&p).ok().and_then(|m| m.modified().ok());
            files.push((p, mtime, date));
        }
    }
    if files.is_empty() { return out; }
    out.present = true;

    let mut by_date: HashMap<String, usize> = HashMap::new();
    for (_, _, date) in &files {
        if let Some(d) = date { *by_date.entry(d.clone()).or_insert(0) += 1; }
    }
    out.daily_sessions = by_date.into_iter().map(|(date, count)| DailySessionCount { date, count }).collect();
    out.daily_sessions.sort_by(|a, b| a.date.cmp(&b.date));

    // Rate limits: the last token_count event of the most recently touched rollout that has
    // one (a just-started session may not have emitted any yet — fall back to the next file).
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let parse_window = |w: &serde_json::Value| CodexRateWindow {
        used_percent: w.get("used_percent").and_then(|v| v.as_f64()),
        window_minutes: w.get("window_minutes").and_then(|v| v.as_u64()),
        resets_at: w.get("resets_at").and_then(|v| v.as_u64()),
    };
    for (path, _, _) in &files {
        let Ok(content) = fs::read_to_string(path) else { continue };
        let Some(line) = content.lines().rev().find(|l| l.contains("\"token_count\"")) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(payload) = json.get("payload") else { continue };
        if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") { continue; }
        let Some(rl) = payload.get("rate_limits") else { continue };
        out.primary = rl.get("primary").map(|w| parse_window(w));
        out.secondary = rl.get("secondary").map(|w| parse_window(w));
        out.plan_type = rl.get("plan_type").and_then(|v| v.as_str()).map(|s| s.to_string());
        out.rate_limits_updated_iso = json.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string());
        break;
    }
    out
}

// ── Codex project discovery ───────────────────────────────────────────
// Codex has no per-project directory layout like ~/.claude/projects — sessions land in
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and each file's first line is a
// `session_meta` record carrying the session's cwd. Group by cwd to get the set of
// directories Codex has been used in, for the Add Projects picker's agent marks.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexProjectInfo {
    pub path: String,
    pub session_count: usize,
    pub last_active: String,
}

#[tauri::command]
fn list_codex_projects() -> Vec<CodexProjectInfo> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() { return vec![]; }

    let mut by_cwd: HashMap<String, (usize, Option<SystemTime>)> = HashMap::new();
    let mut stack = vec![sessions_dir];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).ok().into_iter().flatten().flatten() {
            let p = entry.path();
            if entry.file_type().map_or(false, |ft| ft.is_dir()) { stack.push(p); continue; }
            if p.extension().map_or(true, |ext| ext != "jsonl") { continue; }

            let mut cwd: Option<String> = None;
            if let Ok(file) = fs::File::open(&p) {
                let mut first = String::new();
                if BufReader::new(file).read_line(&mut first).is_ok() {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&first) {
                        cwd = json.get("payload").and_then(|pl| pl.get("cwd")).and_then(|c| c.as_str()).map(|s| s.to_string());
                    }
                }
            }
            let Some(cwd) = cwd else { continue };

            let slot = by_cwd.entry(cwd).or_insert((0, None));
            slot.0 += 1;
            if let Some(modified) = fs::metadata(&p).ok().and_then(|m| m.modified().ok()) {
                if slot.1.map_or(true, |prev| modified > prev) { slot.1 = Some(modified); }
            }
        }
    }

    let mut projects: Vec<CodexProjectInfo> = by_cwd.into_iter()
        .map(|(path, (session_count, latest))| CodexProjectInfo { path, session_count, last_active: latest.map(system_time_to_iso).unwrap_or_default() })
        .collect();
    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    projects
}

// ── Cursor session parsing ────────────────────────────────────────────
// Cursor stores chats under ~/.cursor/chats/<md5(cwd)>/<chat-uuid>/ as a small meta.json
// (title, timestamps, hasConversation) plus a SQLite store.db whose single `meta` row holds
// hex-encoded JSON with the model + mode. Cursor exposes no token/cost/rate-limit data
// locally, so those stay zero. The workspace folder is md5 of the exact cwd string and isn't
// reversible — we resolve it via a md5(path)→path map built below.

fn cursor_workspace_map() -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let Some(home) = dirs::home_dir() else { return map };
    let mut add = |path: &str| {
        if path.is_empty() { return; }
        let digest = format!("{:x}", md5::compute(path.as_bytes()));
        map.entry(digest).or_insert_with(|| path.to_string());
    };
    // Authoritative: every ~/.cursor/projects/<id>/.workspace-trusted records its workspacePath.
    let projects = home.join(".cursor").join("projects");
    for entry in fs::read_dir(&projects).ok().into_iter().flatten().flatten() {
        let wt = entry.path().join(".workspace-trusted");
        if let Ok(c) = fs::read_to_string(&wt) {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&c) {
                if let Some(p) = j.get("workspacePath").and_then(|v| v.as_str()) { add(p); }
            }
        }
    }
    // Safety net: any project the user also uses in Claude or Codex resolves even if Cursor
    // never wrote a trust file for it.
    for p in list_claude_projects() { add(&p.path); }
    for p in list_codex_projects() { add(&p.path); }
    map
}

fn cursor_chats_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor").join("chats"))
}

// Read the model id from a chat's store.db. The `meta` row's value is a TEXT column holding
// hex-encoded JSON; the freshest copy may live in the WAL, so we open it as a real SQLite
// connection (read-only) rather than scraping the file.
fn cursor_model_from_store(store_db: &std::path::Path) -> Option<String> {
    let conn = rusqlite::Connection::open_with_flags(store_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let hex: String = conn.query_row("SELECT value FROM meta LIMIT 1", [], |r| r.get(0)).ok()?;
    let bytes: Vec<u8> = (0..hex.len()).step_by(2).filter_map(|i| hex.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok())).collect();
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("lastUsedModel").and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn parse_cursor_session(chat_dir: &std::path::Path, ws_map: &HashMap<String, String>) -> Option<SessionInfo> {
    let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(chat_dir.join("meta.json")).ok()?).ok()?;
    // Skip empty stubs — Cursor creates a chat folder the moment a session is opened, before
    // any conversation happens; hasConversation flips true once there's real content.
    if !meta.get("hasConversation").and_then(|v| v.as_bool()).unwrap_or(false) { return None; }

    let chat_id = chat_dir.file_name()?.to_string_lossy().into_owned();
    let workspace_hash = chat_dir.parent()?.file_name()?.to_string_lossy().into_owned();
    let cwd = ws_map.get(&workspace_hash).cloned().unwrap_or_default();
    let project_name = if cwd.is_empty() { String::new() } else { std::path::Path::new(&cwd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() };

    let updated_ms = meta.get("updatedAtMs").or_else(|| meta.get("createdAtMs")).and_then(|v| v.as_u64()).unwrap_or(0);
    let timestamp = if updated_ms > 0 { unix_ms_to_iso(updated_ms) } else { fs::metadata(chat_dir.join("meta.json")).ok().and_then(|m| m.modified().ok()).map(system_time_to_iso).unwrap_or_default() };

    let title = meta.get("title").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Session {}", &chat_id[..8.min(chat_id.len())]));

    let model = cursor_model_from_store(&chat_dir.join("store.db")).unwrap_or_default();

    Some(SessionInfo {
        id: chat_id, title, timestamp, message_count: 0, project_name, project_path: cwd,
        git_branch: String::new(), claude_version: String::new(), tool_use_count: 0, duration_ms: 0,
        model, context_tokens: 0, context_limit: 0,
        cost_usd: 0.0, is_authoritative_stats: false,
        daily_cost: Default::default(), rate_limit_5h_pct: None, rate_limit_7d_pct: None,
        total_input_tokens: 0, total_cache_creation_tokens: 0, total_cache_read_tokens: 0, total_output_tokens: 0,
        daily_tokens: Default::default(),
        agent: "cursor".into(),
    })
}

// Directories Cursor has been used in — for the Add Projects picker's per-agent marks.
// Same shape as the Claude/Codex project lists; grouped by each chat's resolved cwd.
#[tauri::command]
fn list_cursor_projects() -> Vec<CodexProjectInfo> {
    let ws = cursor_workspace_map();
    let mut by_cwd: HashMap<String, (usize, String)> = HashMap::new();
    for dir in cursor_chat_dirs() {
        if let Some(s) = parse_cursor_session(&dir, &ws) {
            if s.project_path.is_empty() { continue; }
            let slot = by_cwd.entry(s.project_path).or_insert((0, String::new()));
            slot.0 += 1;
            if s.timestamp > slot.1 { slot.1 = s.timestamp; }
        }
    }
    let mut projects: Vec<CodexProjectInfo> = by_cwd.into_iter()
        .map(|(path, (session_count, last_active))| CodexProjectInfo { path, session_count, last_active })
        .collect();
    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    projects
}

// Enumerate ~/.cursor/chats/<hash>/<chat-uuid>/ session directories.
fn cursor_chat_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![];
    let Some(chats) = cursor_chats_dir() else { return dirs };
    for ws in fs::read_dir(&chats).ok().into_iter().flatten().flatten() {
        if !ws.file_type().map_or(false, |ft| ft.is_dir()) { continue; }
        for chat in fs::read_dir(ws.path()).ok().into_iter().flatten().flatten() {
            if chat.file_type().map_or(false, |ft| ft.is_dir()) { dirs.push(chat.path()); }
        }
    }
    dirs
}

// ── opencode session parsing ──────────────────────────────────────────
// opencode keeps everything in a single SQLite database (~/.local/share/opencode/opencode.db,
// WAL mode — always opened read-only so a running opencode is never disturbed). The `session`
// table carries title, cwd, model, and lifetime token sums directly; the `message` table holds
// one JSON blob per turn whose per-turn usage feeds the per-day bands and the current-context
// figure. Context limits come from opencode's cached models.dev catalog. Cost stays 0 even
// though opencode records it — cost is a Claude-only surface by design — while
// is_authoritative_stats is true so the context bar renders: the numbers come from opencode
// itself, not an estimate.

fn opencode_data_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".local").join("share").join("opencode"))
}

fn opencode_open_db() -> Option<rusqlite::Connection> {
    let db = opencode_data_dir()?.join("opencode.db");
    if !db.exists() { return None; }
    rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

// Context window per "providerID/modelID" from ~/.cache/opencode/models.json (opencode's
// snapshot of the models.dev catalog). A model missing from the cache leaves the limit at 0,
// which hides the context bar — better than guessing a wrong budget.
fn opencode_context_limits() -> HashMap<String, u64> {
    let mut map = HashMap::new();
    let Some(home) = dirs::home_dir() else { return map };
    let Ok(content) = fs::read_to_string(home.join(".cache").join("opencode").join("models.json")) else { return map };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { return map };
    for (pid, provider) in json.as_object().into_iter().flatten() {
        for (mid, model) in provider.get("models").and_then(|m| m.as_object()).into_iter().flatten() {
            if let Some(ctx) = model.get("limit").and_then(|l| l.get("context")).and_then(|v| v.as_u64()) {
                map.insert(format!("{}/{}", pid, mid), ctx);
            }
        }
    }
    map
}

fn parse_opencode_sessions() -> Vec<SessionInfo> {
    let Some(conn) = opencode_open_db() else { return vec![] };
    let limits = opencode_context_limits();

    // One pass over the message table collects everything per-turn: user-message count,
    // per-day token bands, and the newest assistant turn's context size (input + cached
    // input ≈ what the model saw last turn). Band mapping onto Claude's [input,
    // cache_creation, cache_read, output]: input, cache.write, cache.read, output+reasoning.
    #[derive(Default)]
    struct Usage { user_msgs: usize, daily: std::collections::BTreeMap<String, [u64; 4]>, context: u64 }
    let mut usage: HashMap<String, Usage> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT session_id, data FROM message ORDER BY time_created") {
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
        for (sid, data) in rows.ok().into_iter().flatten().flatten() {
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) else { continue };
            let slot = usage.entry(sid).or_default();
            match json.get("role").and_then(|v| v.as_str()) {
                Some("user") => slot.user_msgs += 1,
                Some("assistant") => {
                    let Some(t) = json.get("tokens") else { continue };
                    let g = |k: &str| t.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                    let cache = |k: &str| t.get("cache").and_then(|c| c.get(k)).and_then(|v| v.as_u64()).unwrap_or(0);
                    let (input, output, reasoning, cache_read, cache_write) = (g("input"), g("output"), g("reasoning"), cache("read"), cache("write"));
                    let created = json.get("time").and_then(|tm| tm.get("created")).and_then(|v| v.as_u64()).unwrap_or(0);
                    if input + output + reasoning + cache_read + cache_write > 0 && created > 0 {
                        let day = unix_ms_to_iso(created)[..10].to_string();
                        let band = slot.daily.entry(day).or_insert([0, 0, 0, 0]);
                        band[0] += input; band[1] += cache_write; band[2] += cache_read; band[3] += output + reasoning;
                        slot.context = input + cache_read + cache_write; // rows arrive oldest→newest, so the last write wins
                    }
                }
                _ => {}
            }
        }
    }

    // The sessions themselves. parent_id IS NULL drops subagent child sessions; archived
    // sessions stay hidden, matching opencode's own session list.
    let mut out: Vec<SessionInfo> = vec![];
    let Ok(mut stmt) = conn.prepare("SELECT id, title, directory, model, version, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE parent_id IS NULL AND time_archived IS NULL") else { return out };
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?,
        r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?, r.get::<_, i64>(8)?, r.get::<_, i64>(9)?, r.get::<_, i64>(10)?, r.get::<_, i64>(11)?,
    )));
    for (id, title, directory, model_json, version, created_ms, updated_ms, tok_in, tok_out, tok_reason, tok_cread, tok_cwrite) in rows.ok().into_iter().flatten().flatten() {
        // The directory is recorded with forward slashes even on Windows — normalize to the
        // platform separator so it merges with Claude's recording of the same project.
        let cwd = if cfg!(windows) { directory.replace('/', "\\") } else { directory };
        if cwd.is_empty() { continue; }
        let project_name = std::path::Path::new(&cwd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| cwd.clone());

        // model column: JSON like {"id":"...","providerID":"..."} — id feeds the badge,
        // provider/id together look up the context window.
        let (model, context_limit) = model_json.as_deref()
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .map(|m| {
                let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let provider = m.get("providerID").and_then(|v| v.as_str()).unwrap_or_default();
                let limit = limits.get(&format!("{}/{}", provider, id)).copied().unwrap_or(0);
                (id, limit)
            })
            .unwrap_or_default();

        let title = if title.trim().is_empty() { format!("Session {}", &id[..8.min(id.len())]) } else { title };
        let u = usage.remove(&id).unwrap_or_default();

        out.push(SessionInfo {
            id, title, timestamp: unix_ms_to_iso(updated_ms.max(0) as u64), message_count: u.user_msgs, project_name, project_path: cwd,
            git_branch: String::new(), claude_version: version, tool_use_count: 0, duration_ms: (updated_ms - created_ms).max(0) as u64,
            model, context_tokens: u.context, context_limit,
            cost_usd: 0.0, is_authoritative_stats: true,
            daily_cost: Default::default(), rate_limit_5h_pct: None, rate_limit_7d_pct: None,
            total_input_tokens: tok_in.max(0) as u64, total_cache_creation_tokens: tok_cwrite.max(0) as u64, total_cache_read_tokens: tok_cread.max(0) as u64, total_output_tokens: (tok_out + tok_reason).max(0) as u64,
            daily_tokens: u.daily,
            agent: "opencode".into(),
        });
    }
    out
}

// Directories opencode has been used in — for the Add Projects picker's per-agent marks.
// Grouped from the sessions' recorded directories, same shape as the other agents' lists.
#[tauri::command]
fn list_opencode_projects() -> Vec<CodexProjectInfo> {
    let mut by_cwd: HashMap<String, (usize, String)> = HashMap::new();
    for s in parse_opencode_sessions() {
        let slot = by_cwd.entry(s.project_path).or_insert((0, String::new()));
        slot.0 += 1;
        if s.timestamp > slot.1 { slot.1 = s.timestamp; }
    }
    let mut projects: Vec<CodexProjectInfo> = by_cwd.into_iter()
        .map(|(path, (session_count, last_active))| CodexProjectInfo { path, session_count, last_active })
        .collect();
    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    projects
}

// ── opencode project context ──────────────────────────────────────────
// What the context tree shows for opencode: AGENTS.md instructions (project + global),
// custom commands and agents (markdown files under .opencode/ and ~/.config/opencode/),
// and MCP servers from opencode.json(c). Returned as the same generic titled sections as
// Codex/Cursor so the tree renders it with no agent-specific frontend code.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpencodeContext {
    pub present: bool,
    pub sections: Vec<AgentContextSection>,
}

// opencode configs are JSONC (comments + trailing commas allowed). Try strict JSON first,
// then strip comments and trailing commas outside string literals and retry.
fn parse_jsonc(content: &str) -> Option<serde_json::Value> {
    if let Ok(v) = serde_json::from_str(content) { return Some(v); }
    let mut out = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' { if let Some(n) = chars.next() { out.push(n); } } else if c == '"' { in_str = false; }
        } else if c == '"' { in_str = true; out.push(c); }
        else if c == '/' && chars.peek() == Some(&'/') { while let Some(&n) = chars.peek() { if n == '\n' { break; } chars.next(); } }
        else if c == '/' && chars.peek() == Some(&'*') { chars.next(); let mut prev = ' '; for n in chars.by_ref() { if prev == '*' && n == '/' { break; } prev = n; } }
        else if c == ',' {
            // Drop a comma whose next non-whitespace char closes the container.
            let mut it = chars.clone();
            let mut next_sig = None;
            while let Some(&n) = it.peek() { if n.is_whitespace() { it.next(); } else { next_sig = Some(n); break; } }
            if next_sig != Some('}') && next_sig != Some(']') { out.push(c); }
        }
        else { out.push(c); }
    }
    serde_json::from_str(&out).ok()
}

// The opencode config files that apply to a project, nearest first: project opencode.json(c),
// then global ~/.config/opencode/opencode.json(c).
fn opencode_config_files(project_path: &std::path::Path) -> Vec<(PathBuf, &'static str)> {
    let mut files = vec![];
    for name in ["opencode.json", "opencode.jsonc"] {
        files.push((project_path.join(name), "project"));
    }
    if let Some(home) = dirs::home_dir() {
        for name in ["opencode.json", "opencode.jsonc"] {
            files.push((home.join(".config").join("opencode").join(name), "global"));
        }
    }
    files.into_iter().filter(|(p, _)| p.exists()).collect()
}

#[tauri::command]
fn get_opencode_context(project_path: String) -> OpencodeContext {
    let pp = std::path::Path::new(&project_path);
    let mut sections: Vec<AgentContextSection> = vec![];
    let configs: Vec<(serde_json::Value, &str)> = opencode_config_files(pp).into_iter()
        .filter_map(|(p, scope)| fs::read_to_string(&p).ok().and_then(|c| parse_jsonc(&c)).map(|v| (v, scope)))
        .collect();

    // Instructions — AGENTS.md at the project root and the global one, plus any literal
    // (non-glob) paths from the configs' `instructions` arrays that resolve to real files.
    let mut instructions: Vec<AgentContextItem> = vec![];
    let agents_md = pp.join("AGENTS.md");
    if agents_md.exists() { instructions.push(AgentContextItem { name: "AGENTS.md".into(), detail: "project".into(), path: agents_md.to_string_lossy().into_owned() }); }
    if let Some(home) = dirs::home_dir() {
        let global = home.join(".config").join("opencode").join("AGENTS.md");
        if global.exists() { instructions.push(AgentContextItem { name: "AGENTS.md".into(), detail: "global".into(), path: global.to_string_lossy().into_owned() }); }
    }
    for (cfg, scope) in &configs {
        for entry in cfg.get("instructions").and_then(|v| v.as_array()).into_iter().flatten() {
            let Some(rel) = entry.as_str().filter(|s| !s.contains('*')) else { continue };
            let p = pp.join(rel);
            if p.exists() && !instructions.iter().any(|i| i.path == p.to_string_lossy()) {
                instructions.push(AgentContextItem { name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| rel.to_string()), detail: format!("{} config", scope), path: p.to_string_lossy().into_owned() });
            }
        }
    }
    if !instructions.is_empty() { sections.push(AgentContextSection { title: "Instructions".into(), items: instructions }); }

    // Commands and custom agents — markdown files under .opencode/{command,agent}/ (project)
    // and ~/.config/opencode/{command,agent}/ (global). opencode's slash-command equivalent.
    let mut md_section = |subdir: &str, title: &str| {
        let mut items: Vec<AgentContextItem> = vec![];
        let mut scan = |dir: PathBuf, scope: &str| {
            let mut stack = vec![dir];
            while let Some(d) = stack.pop() {
                for entry in fs::read_dir(&d).ok().into_iter().flatten().flatten() {
                    let p = entry.path();
                    if entry.file_type().map_or(false, |ft| ft.is_dir()) { stack.push(p); continue; }
                    if p.extension().map_or(true, |ext| ext != "md") { continue; }
                    items.push(AgentContextItem { name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), detail: scope.to_string(), path: p.to_string_lossy().into_owned() });
                }
            }
        };
        scan(pp.join(".opencode").join(subdir), "project");
        if let Some(home) = dirs::home_dir() { scan(home.join(".config").join("opencode").join(subdir), "global"); }
        items.sort_by(|a, b| a.name.cmp(&b.name));
        if !items.is_empty() { sections.push(AgentContextSection { title: title.into(), items }); }
    };
    md_section("command", "Commands");
    md_section("agent", "Agents");

    // MCP servers — the `mcp` object in each config; detail shows the transport type or the
    // local command, falling back to the config's scope.
    let mut mcp_items: Vec<AgentContextItem> = vec![];
    for (cfg, scope) in &configs {
        for (name, server) in cfg.get("mcp").and_then(|v| v.as_object()).into_iter().flatten() {
            if mcp_items.iter().any(|i| i.name == *name) { continue; }
            let detail = server.get("command").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" "))
                .or_else(|| server.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| scope.to_string());
            mcp_items.push(AgentContextItem { name: name.clone(), detail, path: String::new() });
        }
    }
    if !mcp_items.is_empty() { sections.push(AgentContextSection { title: "MCP servers".into(), items: mcp_items }); }

    OpencodeContext { present: !sections.is_empty(), sections }
}

// ── Agent binary detection ────────────────────────────────────────────
// Settings → Agents shows whether each supported CLI agent is installed on this machine.
// Resolution goes through `where`/`which` instead of the PTY shell because npm installs
// agents as `.cmd`/`.ps1` shims on Windows — `where` resolves those reliably, a spawned
// shell lookup would not. The version probe then runs the binary once with `--version`.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentBinaryProbe {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[tauri::command]
async fn detect_agent_binary(binary: String) -> Result<AgentBinaryProbe, String> {
    // The name ends up in a process invocation — only accept known agent binaries.
    if binary != "claude" && binary != "codex" && binary != "cursor-agent" && binary != "opencode" {
        return Err(format!("Unknown agent binary: {}", binary));
    }
    use std::process::Command;

    let mut lookup = if cfg!(target_os = "windows") { Command::new("where") } else { Command::new("which") };
    lookup.arg(&binary);
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; lookup.creation_flags(0x08000000); } // CREATE_NO_WINDOW

    // `where` can return multiple matches (e.g. claude.cmd + claude.ps1) — the first line is
    // the one PATH order would pick, same as what a terminal would run.
    let path = lookup.output().ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty());

    let Some(path) = path else { return Ok(AgentBinaryProbe { installed: false, path: None, version: None }) };

    // Version probe is best-effort: a missing/failing `--version` still counts as installed.
    // On Windows the resolved path is usually an npm `.cmd` shim, which CreateProcess can't
    // exec directly — route through cmd.exe.
    #[cfg(target_os = "windows")]
    let mut ver_cmd = { let mut c = Command::new("cmd"); c.args(["/C", &binary, "--version"]); { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); } c };
    #[cfg(not(target_os = "windows"))]
    let mut ver_cmd = { let mut c = Command::new(&binary); c.arg("--version"); c };

    let version = ver_cmd.output().ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty());

    Ok(AgentBinaryProbe { installed: true, path: Some(path), version })
}

// ── App Setup ──────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState { terminals: Mutex::new(HashMap::new()) })
        .invoke_handler(tauri::generate_handler![list_claude_projects, get_sessions, get_all_recent_sessions, get_session_messages, read_image_base64, read_text_file, reveal_in_explorer, list_dir, search_dir, open_url, get_username, get_home_dir, get_project_skills, get_project_memories, get_git_status, get_git_log, git_diff, git_stage, git_unstage, git_discard, list_git_branches, git_checkout, list_project_session_ids, detect_session_branch, probe_statusline_setup, get_global_rate_limits, detect_agent_binary, list_codex_projects, list_cursor_projects, list_opencode_projects, get_codex_context, get_cursor_context, get_opencode_context, get_claude_cost_summary, get_codex_usage, spawn_terminal, write_terminal, resize_terminal, close_terminal])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
