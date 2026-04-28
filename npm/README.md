# xshell-app

A native home for your Claude Code sessions.

```bash
npm install -g xshell-app
xshell
```

`xshell-app` is a thin npm wrapper around the [xshell desktop app](https://github.com/MertPROJ/xshell). On install it downloads the right platform binary from the matching GitHub release. The `xshell` command then launches the app.

## Platform support

| Platform | Status |
| --- | --- |
| macOS (Intel + Apple Silicon) | ✅ via universal `.app` bundle |
| Linux x64 | ✅ via AppImage |
| Windows x64 | ✅ via portable `.exe` (requires WebView2, built into Windows 10 1803+ / all Windows 11) |

## Requirements

The `claude` CLI must be installed and on `PATH`. xshell wraps it.

## Source

The full project, including issues, contributing guide, and release history, lives at **[github.com/MertPROJ/xshell](https://github.com/MertPROJ/xshell)**.

## License

[MIT](https://github.com/MertPROJ/xshell/blob/main/LICENSE) © xshell Contributors
