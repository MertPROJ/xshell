#!/usr/bin/env node
// Helper spawned by xshell when the user clicks "Install update" in the auto-updater UI.
// Args: <parent-pid>
//
//  1. Wait for the parent xshell process to exit so the .exe lock is released.
//  2. Run `npm install -g xshell-app@latest` synchronously (user sees progress).
//  3. Relaunch xshell via the global wrapper and exit.
//
// This script lives in the npm package and is invoked through the XSHELL_UPDATE_HELPER env
// var that bin/xshell.js sets when launching the desktop binary. Tauri reads that env var
// to detect that auto-update via npm is available.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const parentPid = parseInt(process.argv[2], 10);
const INSTALL_DIR = path.join(os.homedir(), '.xshell', 'bin');

// Final binary path the npm postinstall puts on disk. Used so the user knows where xshell
// ended up even if no shortcut got created (older xshell-app releases didn't drop a Start
// Menu entry).
function expectedBinaryPath() {
  if (process.platform === 'win32') return path.join(INSTALL_DIR, 'xshell.exe');
  if (process.platform === 'darwin') return path.join(INSTALL_DIR, 'xshell.app');
  return path.join(INSTALL_DIR, 'xshell');
}

function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return false;
}

function pause() {
  // Keep the console window open on Windows so the user can read errors before it closes.
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'pause'], { stdio: 'inherit' });
}

async function main() {
  console.log('xshell: waiting for the running app to exit…');
  await waitForExit(parentPid, 30_000);
  // Extra grace period — Windows holds the .exe handle briefly after the process dies.
  await sleep(500);

  console.log('xshell: installing to ' + INSTALL_DIR);
  console.log('xshell: running `npm install -g xshell-app@latest`…\n');
  // shell:true on Windows is required so cmd.exe dispatches the npm.cmd shim — without it
  // Node's CreateProcess can't execute .cmd batch files directly.
  const isWin = process.platform === 'win32';
  const r = spawnSync('npm', ['install', '-g', 'xshell-app@latest'], { stdio: 'inherit', shell: isWin });
  if (r.error) {
    console.error(`\nxshell: failed to launch npm — ${r.error.message}`);
    console.error('Make sure Node.js + npm are on PATH, then try again.');
    pause();
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\nxshell: update failed (npm exited with status ${r.status}${r.signal ? ", signal " + r.signal : ""}).`);
    console.error('You can close this window and try again later.');
    pause();
    process.exit(r.status || 1);
  }

  const finalPath = expectedBinaryPath();
  console.log('\nxshell: update complete.');
  console.log('xshell: installed at ' + finalPath);
  console.log('xshell: relaunching…');
  const xshellCmd = process.platform === 'win32' ? 'xshell.cmd' : 'xshell';
  const child = spawn(xshellCmd, [], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.unref();
  process.exit(0);
}

main().catch((err) => {
  console.error('xshell-update:', err && err.message ? err.message : err);
  pause();
  process.exit(1);
});
