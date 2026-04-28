#!/usr/bin/env node
// Wrapper that launches the platform-specific xshell binary downloaded by postinstall.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

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

const child = spawn(binPath, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', (err) => {
  console.error('Failed to launch xshell:', err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
