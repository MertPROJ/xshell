<div align="center">

<img src="src/assets/logo.png" alt="xshell" width="120" />

# xshell

**A native home for your Claude Code sessions.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?labelColor=1a1a1a)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-7aa2f7?labelColor=1a1a1a)](https://github.com/MertPROJ/xshell/releases/latest)
[![Latest Release](https://img.shields.io/github/v/release/MertPROJ/xshell?labelColor=1a1a1a&color=e0af68)](https://github.com/MertPROJ/xshell/releases/latest)
[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131?logo=tauri&labelColor=1a1a1a)](https://tauri.app/)
[![Built with Rust](https://img.shields.io/badge/Built_with-Rust-DEA584?logo=rust&labelColor=1a1a1a)](https://www.rust-lang.org/)

</div>

> Independent project. Not affiliated with, endorsed by, or a product of Anthropic. xshell reads files written by the official `claude` CLI and spawns it as a subprocess. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.

## Screenshots

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Project overview with daily cost chart, sessions list, and context tree" width="100%">
  <br><sub><em>Project overview — daily cost across the last 30 days, every session in one list, full context tree on the right.</em></sub>
</p>

<p align="center">
  <img src="docs/screenshots/terminal.png" alt="Claude Code session inside an xshell terminal tab with the inline git panel" width="100%">
  <br><sub><em>Claude Code session inside an xshell tab — inline git panel, live cost / context indicators in the status line.</em></sub>
</p>

## Why this exists

Open terminal. `cd` somewhere. Type `claude`. Repeat for every project, every day.

xshell skips that. All your projects, all your past sessions, all the costs — one screen, one click.

## How it works

xshell reads the files Claude Code writes to `~/.claude/` and spawns the `claude` CLI when you start a session. No API proxy, no telemetry, no replacement implementation. If Claude Code works on your machine, xshell works.

## What you see

Every project on your machine that Claude Code has touched. Every session, sorted by what you opened last. Cost per session, per project, per day.

The data is all in `~/.claude/` already. xshell just shows it in one place.

## Features

- 🗂️ **Sidebar with every project** Claude Code has touched. Pin, group, drag-and-drop.
- 📜 **One-click session resume** with full history per project.
- 💻 **Real terminals**, splittable side-by-side. [xterm.js](https://xtermjs.org) + native PTYs.
- 🌿 **Live branch and worktree awareness** in the sidebar.
- 🧩 **Context tree** for skills, agents, plugins, MCP servers, hooks, slash commands, and CLAUDE.md.
- 📊 **Cost, context, and rate-limit tracking** per session and across your account.
- 🪶 **Inline git panel** with diff counts and staging.

Built with Tauri 2 and Rust. Native on Windows, macOS, and Linux.

## Install

The fastest way — works on Windows, macOS, and Linux:

```bash
npm install -g xshell-app
xshell
```

The `npm install` step downloads the right binary for your platform from the [latest GitHub release](https://github.com/MertPROJ/xshell/releases/latest) into `~/.xshell/bin/`. The `xshell` command then launches the app.

### Or download an installer directly

| Platform | File |
| --- | --- |
| Windows | `xshell_<version>_x64_en-US.msi` or `xshell_<version>_x64-setup.exe` |
| macOS | `xshell_<version>_universal.dmg` |
| Linux | `xshell_<version>_amd64.deb`, `xshell-<version>-1.x86_64.rpm`, or `xshell_<version>_amd64.AppImage` |

The `claude` CLI must be installed and on `PATH`.

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, project structure, and PR guidelines.

## License

[MIT](./LICENSE) © 2026 xshell Contributors

xshell is independent software. It reads files written by Anthropic's `claude` CLI and runs `claude` as a subprocess. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.
