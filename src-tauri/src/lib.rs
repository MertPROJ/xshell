use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, State};

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
// `~/.claude/projects/`. Non-alphanumeric characters (except `.` and `_`) collapse to `-`.
// e.g. `C:\Users\alex\projects\my-app`  →  `C--Users-alex-projects-my-app`
fn encode_project_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' { c } else { '-' }).collect()
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

fn parse_session(path: &std::path::Path, project_name: &str, project_path: &str) -> Option<SessionInfo> {
    let session_id = path.file_stem()?.to_string_lossy().to_string();
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let mtime_iso = system_time_to_iso(modified);

    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut title = String::new();
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
                if let Some(t) = json.get("customTitle").and_then(|t| t.as_str()) { title = t.to_string(); }
            }
            Some("agent-name") => {
                if title.is_empty() {
                    if let Some(t) = json.get("agentName").and_then(|t| t.as_str()) { title = t.to_string(); }
                }
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
                        last_input = inp;
                        last_cache_creation = cc;
                        last_cache_read = cr;
                        let turn_context = inp + cc + cr;
                        if turn_context > max_context_observed { max_context_observed = turn_context; }
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

    let display_title = if !title.is_empty() { title } else if !first_human_message.is_empty() { first_human_message } else { format!("Session {}", &session_id[..8.min(session_id.len())]) };
    // Prefer the real last-message timestamp; fall back to file mtime for brand-new sessions
    // that haven't produced a user/assistant line yet.
    let timestamp = if last_message_ts.is_empty() { mtime_iso } else { last_message_ts };

    Some(SessionInfo { id: session_id, title: display_title, timestamp, message_count, project_name: project_name.to_string(), project_path: project_path.to_string(), git_branch, claude_version, tool_use_count, duration_ms, model: model_out, context_tokens, context_limit, cost_usd, is_authoritative_stats, daily_cost, rate_limit_5h_pct, rate_limit_7d_pct })
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
    let projects_dir = match get_claude_projects_dir() {
        Some(d) => d,
        None => return vec![],
    };

    let project_dir = projects_dir.join(&encoded_name);
    if !project_dir.exists() { return vec![]; }

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

    let mut sessions: Vec<SessionInfo> = fs::read_dir(&project_dir).ok().into_iter().flatten().flatten().filter_map(|e| {
        let p = e.path();
        if p.extension().map_or(true, |ext| ext != "jsonl") { return None; }
        parse_session(&p, &project_name, &project_path)
    }).collect();

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    sessions
}

#[tauri::command]
fn get_all_recent_sessions(limit: usize) -> Vec<SessionInfo> {
    let projects_dir = match get_claude_projects_dir() {
        Some(d) if d.exists() => d,
        _ => return vec![],
    };

    let mut all_sessions: Vec<SessionInfo> = vec![];

    for entry in fs::read_dir(&projects_dir).ok().into_iter().flatten().flatten() {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateMethod {
    pub method: String,
    pub helper: Option<String>,
    pub node: Option<String>,
}

// Detected from env vars set by the npm wrapper (npm/bin/xshell.js). When both are present
// we know we were launched through the npm install path, and the helper script + Node binary
// give us everything needed to run an in-app update without the user touching a shell.
#[tauri::command]
fn detect_update_method() -> UpdateMethod {
    let helper = std::env::var("XSHELL_UPDATE_HELPER").ok();
    let node = std::env::var("XSHELL_NODE_PATH").ok();
    let method = if helper.is_some() && node.is_some() { "npm" } else { "manual" };
    UpdateMethod { method: method.to_string(), helper, node }
}

// Spawns the npm update helper detached, then exits the app a beat later so the .exe lock
// is released. The helper waits for our PID, runs `npm i -g xshell-app@latest`, and relaunches.
#[tauri::command]
fn run_npm_update(app: tauri::AppHandle) -> Result<(), String> {
    let helper = std::env::var("XSHELL_UPDATE_HELPER").map_err(|_| "no update helper available".to_string())?;
    let node = std::env::var("XSHELL_NODE_PATH").map_err(|_| "no node path available".to_string())?;
    let pid = std::process::id().to_string();
    let mut cmd = std::process::Command::new(&node);
    cmd.arg(&helper).arg(&pid);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP — give the helper its own visible
        // console (so the user sees npm progress) and let it survive our exit.
        cmd.creation_flags(0x10 | 0x200);
    }
    cmd.spawn().map_err(|e| format!("Failed to spawn update helper: {}", e))?;
    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app_clone.exit(0);
    });
    Ok(())
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
fn get_git_status(cwd: String) -> GitStatus {
    use std::process::Command;
    let mut cmd = Command::new("git");
    cmd.arg("status").arg("--porcelain=v1").arg("-b").current_dir(&cwd);
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

#[tauri::command]
fn get_git_log(cwd: String, limit: Option<u32>) -> Vec<GitCommit> {
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

#[tauri::command]
fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() { return Ok(()); }
    let mut cmd = git_cmd(&cwd);
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
    let mut cmd = git_cmd(&cwd);
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

// ── Terminal / PTY Commands ────────────────────────────────────────────

#[tauri::command]
fn spawn_terminal(app: AppHandle, state: State<'_, AppState>, id: String, session_id: Option<String>, custom_name: Option<String>, cwd: String, cols: u16, rows: u16, shell_mode: Option<String>, shell_command: Option<String>, shell_id: Option<String>) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mode = shell_mode.as_deref().unwrap_or("claude");
    // Build the claude argv tail (session resume / custom name). Reused by every claude-mode branch.
    let claude_args: Vec<String> = {
        let mut v = Vec::new();
        if let Some(ref sid) = session_id { v.push("--resume".into()); v.push(sid.clone()); }
        else if let Some(ref name) = custom_name { v.push("-n".into()); v.push(name.clone()); }
        v
    };
    let shell_kind = shell_id.as_deref().unwrap_or("");
    let mut cmd = if mode == "raw" {
        // Raw shell: spawn the chosen shell directly (no claude wrapping).
        let shell = shell_command.as_deref().unwrap_or_else(|| if cfg!(windows) { "powershell.exe" } else { "bash" });
        CommandBuilder::new(shell)
    } else if let Some(shell) = shell_command.as_deref().filter(|s| !s.is_empty()) {
        // Claude mode with an explicit host shell: launch the shell and run `claude` inside it
        // so the user's preferred shell wraps the session (and stays alive after claude exits).
        match shell_kind {
            "powershell" => {
                let mut c = CommandBuilder::new(shell);
                c.arg("-NoLogo");
                c.arg("-NoExit");
                c.arg("-Command");
                // & 'claude' 'arg1' 'arg2' — single-quoted to avoid PS expansion surprises.
                let mut s = String::from("& 'claude'");
                for a in &claude_args { s.push(' '); s.push('\''); s.push_str(&a.replace('\'', "''")); s.push('\''); }
                c.arg(s);
                c
            }
            "cmd" => {
                let mut c = CommandBuilder::new(shell);
                c.arg("/K");
                c.arg("claude");
                for a in &claude_args { c.arg(a); }
                c
            }
            "gitbash" | "bash" | "zsh" | "fish" => {
                // bash -i -c "claude arg1 arg2; exec bash -i"
                let mut c = CommandBuilder::new(shell);
                c.arg("-i");
                c.arg("-c");
                fn q(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }
                let mut s = String::from("claude");
                for a in &claude_args { s.push(' '); s.push_str(&q(a)); }
                // Keep the shell alive after claude exits so the user retains a prompt.
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
                    c.arg("claude");
                    for a in &claude_args { c.arg(a); }
                    c
                } else {
                    let mut c = CommandBuilder::new("claude");
                    for a in &claude_args { c.arg(a); }
                    c
                }
            }
        }
    } else if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/C");
        c.arg("claude");
        for a in &claude_args { c.arg(a); }
        c
    } else {
        let mut c = CommandBuilder::new("claude");
        for a in &claude_args { c.arg(a); }
        c
    };
    // Empty cwd → fall back to the user's home directory (raw shells launched from home view).
    let effective_cwd = if cwd.is_empty() {
        dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| ".".to_string())
    } else { cwd };
    cmd.cwd(&effective_cwd);

    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn command: {}", e))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair.master.take_writer().map_err(|e| format!("Failed to take writer: {}", e))?;

    // Spawn reader thread that emits terminal output events
    let terminal_id = id.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app_handle.emit(&format!("terminal-exit-{}", terminal_id), ());
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(&format!("terminal-output-{}", terminal_id), data);
                }
                Err(_) => {
                    let _ = app_handle.emit(&format!("terminal-exit-{}", terminal_id), ());
                    break;
                }
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

    // Find the freshest file by mtime — that's whichever Claude Code refreshed most recently.
    let mut freshest: Option<(SystemTime, std::path::PathBuf)> = None;
    for entry in fs::read_dir(&stats_dir).ok().into_iter().flatten().flatten() {
        if !entry.file_type().map_or(false, |ft| ft.is_file()) { continue; }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if freshest.as_ref().map_or(true, |(t, _)| modified > *t) {
                    freshest = Some((modified, entry.path()));
                }
            }
        }
    }

    let Some((mtime, path)) = freshest else { return out; };
    let Ok(content) = fs::read_to_string(&path) else { return out; };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&content) else { return out; };

    if let Some(rl) = json.get("rate_limits") {
        if let Some(fh) = rl.get("five_hour") {
            out.five_hour_pct = fh.get("used_percentage").and_then(|v| v.as_f64());
            out.five_hour_resets_at = fh.get("resets_at").and_then(|v| v.as_u64());
        }
        if let Some(sd) = rl.get("seven_day") {
            out.seven_day_pct = sd.get("used_percentage").and_then(|v| v.as_f64());
            out.seven_day_resets_at = sd.get("resets_at").and_then(|v| v.as_u64());
        }
    }
    out.last_update_iso = Some(system_time_to_iso(mtime));
    out.source_session_id = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    out
}

// ── App Setup ──────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState { terminals: Mutex::new(HashMap::new()) })
        .invoke_handler(tauri::generate_handler![list_claude_projects, get_sessions, get_all_recent_sessions, get_session_messages, read_image_base64, read_text_file, reveal_in_explorer, open_url, detect_update_method, run_npm_update, get_username, get_home_dir, get_project_skills, get_project_memories, get_git_status, get_git_log, git_stage, git_unstage, list_project_session_ids, detect_session_branch, probe_statusline_setup, get_global_rate_limits, spawn_terminal, write_terminal, resize_terminal, close_terminal])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
