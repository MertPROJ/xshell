#!/usr/bin/env node
// Wrapper that launches the platform-specific xshell binary downloaded by postinstall.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const pkg = require('../package.json');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
xshell — a native home for your Claude Code sessions

Usage:
  xshell                Launch the desktop app

Flags:
  -h, --help            Show this message
  -v, --version         Show the installed version

Reinstall / update:
  npm install -g xshell-app

Docs:
  https://github.com/MertPROJ/xshell
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(`xshell-app v${pkg.version}`);
  process.exit(0);
}

const installDir = path.join(os.homedir(), '.xshell', 'bin');

function getBinaryPath() {
  switch (process.platform) {
    case 'win32':
      return path.join(installDir, 'xshell.exe');
    case 'darwin':
      return path.join(installDir, 'xshell.app', 'Contents', 'MacOS', 'xshell');
    case 'linux':
      return path.join(installDir, 'xshell');
    default:
      return null;
  }
}

const binPath = getBinaryPath();

if (!binPath || !fs.existsSync(binPath)) {
  console.error('xshell binary is not installed at the expected location.');
  console.error('Try reinstalling:  npm install -g xshell-app');
  console.error('Or download manually:  https://github.com/MertPROJ/xshell/releases/latest');
  process.exit(1);
}

// Tell the desktop app where the npm-side update helper lives + which Node binary to run
// it with. The Tauri side reads these to decide whether to show the "Install update" button.
const helperPath = path.join(__dirname, '..', 'scripts', 'update.js');
const childEnv = { ...process.env };
if (fs.existsSync(helperPath)) {
  childEnv.XSHELL_UPDATE_HELPER = helperPath;
  childEnv.XSHELL_NODE_PATH = process.execPath;
}

const child = spawn(binPath, args, { stdio: 'inherit', env: childEnv });
child.on('error', (err) => {
  console.error('Failed to launch xshell:', err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
