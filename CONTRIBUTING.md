# Contributing to xshell

Thanks for your interest in contributing — issues, pull requests, and discussion are all welcome.

xshell is an independent open-source project that drives the official `claude` CLI as a subprocess. It is not affiliated with, endorsed by, or a product of Anthropic.

## Right to contribute

By submitting a contribution you confirm that:

- You are legally entitled to contribute the code you contribute.
- Each of your contributions is your original creation.
- To your knowledge, your contributions do not infringe, violate, or misappropriate any third-party intellectual property or other proprietary rights.

Contributions are accepted under the [MIT License](./LICENSE).

## Getting started

1. Fork the repository on GitHub.
2. Clone your fork and install dependencies:
   ```bash
   git clone https://github.com/<your-username>/xshell.git
   cd xshell
   npm install
   ```
3. Create a branch for your change:
   ```bash
   git checkout -b feature/your-feature-name
   ```

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://rustup.rs/) stable
- Tauri 2 system dependencies — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
- The `claude` CLI on `PATH` to exercise Claude-mode terminal tabs end-to-end

## Development

### Run in dev mode

```bash
npm run tauri dev
```

Hot-reloads the React UI; the Rust side rebuilds on save.

### Production build

```bash
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/`.

## Project structure

```
xshell/
├── src/                       # React frontend
│   ├── components/            # UI components
│   ├── hooks/                 # Custom React hooks
│   ├── App.tsx                # Tab shell + main app state
│   ├── shells.ts              # Shell preset detection
│   ├── layout.ts              # Pane split / drag layout
│   └── types.ts               # Shared TypeScript types
├── src-tauri/                 # Rust backend
│   ├── src/lib.rs             # Tauri commands (PTY, stats, projects, skills, git)
│   ├── src/main.rs            # Entry point
│   └── tauri.conf.json        # Tauri 2 configuration
├── docs/screenshots/          # README screenshots
└── .github/workflows/         # CI / release automation
```

## Making changes

### Before you start

- Check existing issues to avoid duplicates.
- For significant changes, open an issue first to discuss the approach.
- Keep your branch up to date with `main`.

### Commit guidelines

- Use present-tense, imperative style ("Add cost chart" not "Added cost chart").
- Keep commits focused and atomic.
- Reference issues when applicable: `Fixes #42`.

### Pull request process

1. Update the README or in-code docs when user-facing behavior changes.
2. Make sure the project still builds: `npm run tauri build`.
3. Open a PR with a clear title, a short description of what changed and why, and screenshots for UI changes.
4. Be open to feedback — most PRs will have some back-and-forth.

## Testing

xshell does not yet have an automated test suite. Contributions to set one up — Vitest for the React side, `cargo test` for Rust — are very welcome.

In the meantime, please manually test your changes against a **packaged build**, not just `tauri dev`. Packaging often reveals issues that don't show up in dev mode.

Manual checklist:

- [ ] App launches without errors on your platform
- [ ] Project sidebar lists projects and sessions correctly
- [ ] Terminal tabs open and accept input (both Claude and Raw modes)
- [ ] Settings persist across restarts
- [ ] For UI changes: both light and dark themes still look right

## Reporting issues

When opening an issue, please include:

- xshell version (or commit SHA if building from source)
- OS and version
- Steps to reproduce
- Expected vs. actual behavior
- Screenshots or logs if applicable

## Feature requests

When proposing a feature:

- Describe the use case in plain terms.
- Sketch the expected behavior.
- Be open to alternative shapes — the simplest version that solves the problem usually wins.

## Code of conduct

Be kind, be respectful, focus on the work. Harassment, personal attacks, or discriminatory behavior of any kind will not be tolerated. If something feels off, flag it via an issue or directly to the maintainers.

## Questions?

- Open an issue.
- Join the discussion on existing issues.
- Or reach out to the maintainers directly.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

Thanks for helping make xshell better.
