#!/usr/bin/env node
// Preuninstall: remove the Start Menu shortcut (Windows) or .desktop entry (Linux) that
// install.js created. Failures here are non-fatal — npm uninstall must still succeed.

const fs = require('fs');
const os = require('os');
const path = require('path');

function removeWindowsShortcut() {
  if (!process.env.APPDATA) return;
  const link = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'xshell.lnk');
  try { fs.unlinkSync(link); console.log(`xshell-app: removed Start Menu shortcut at ${link}`); } catch (_) {}
}

function removeLinuxDesktop() {
  const file = path.join(os.homedir(), '.local', 'share', 'applications', 'xshell.desktop');
  try { fs.unlinkSync(file); console.log(`xshell-app: removed ${file}`); } catch (_) {}
}

function main() {
  if (process.platform === 'win32') removeWindowsShortcut();
  else if (process.platform === 'linux') removeLinuxDesktop();
}

try { main(); } catch (e) {
  console.warn(`xshell-app: cleanup step failed (${e.message}).`);
  process.exit(0);
}
