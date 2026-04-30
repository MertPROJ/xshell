#!/usr/bin/env node
// Postinstall: download the platform-specific xshell binary from the matching GitHub release
// and place it under ~/.xshell/bin/. Failures are non-fatal — the bin/xshell.js wrapper
// re-checks at launch time and prints a useful message if the binary is missing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

const pkg = require('../package.json');
const VERSION = pkg.version;
const REPO = 'MertPROJ/xshell';
const INSTALL_DIR = path.join(os.homedir(), '.xshell', 'bin');

// ── Shortcut helpers ─────────────────────────────────────────────────
// On Windows we drop a .lnk in the per-user Start Menu so xshell shows up in the Start search.
// On Linux we write a .desktop file. macOS app bundles need a real Finder alias (symlinks
// don't always behave the same), so we skip it for now — npm-installed mac users keep
// launching via the `xshell` command.
function createWindowsShortcut(targetExe) {
  if (!process.env.APPDATA) return;
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(startMenu, { recursive: true });
  const linkPath = path.join(startMenu, 'xshell.lnk');
  // PowerShell COM is the only built-in way to write a .lnk. We escape single quotes by
  // doubling them, per PowerShell's literal-string rules.
  const esc = (s) => s.replace(/'/g, "''");
  const ps = `$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${esc(linkPath)}')
$Shortcut.TargetPath = '${esc(targetExe)}'
$Shortcut.IconLocation = '${esc(targetExe)},0'
$Shortcut.WorkingDirectory = '${esc(path.dirname(targetExe))}'
$Shortcut.Description = 'A native home for your Claude Code sessions'
$Shortcut.Save()`;
  const tmp = path.join(os.tmpdir(), `xshell-shortcut-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, ps, 'utf8');
  try {
    execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmp}"`, { stdio: 'ignore' });
    console.log(`xshell-app: created Start Menu shortcut at ${linkPath}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function createLinuxDesktop(targetExe) {
  const dir = path.join(os.homedir(), '.local', 'share', 'applications');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'xshell.desktop');
  const contents = `[Desktop Entry]
Type=Application
Name=xshell
GenericName=Claude Code Terminal
Comment=A native home for your Claude Code sessions
Exec=${targetExe}
Icon=${targetExe}
Terminal=false
Categories=Development;TerminalEmulator;
StartupWMClass=xshell
`;
  fs.writeFileSync(file, contents, 'utf8');
  try { fs.chmodSync(file, 0o755); } catch (_) {}
  console.log(`xshell-app: created application entry at ${file}`);
}

function createShortcuts(targetExe) {
  try {
    if (process.platform === 'win32') createWindowsShortcut(targetExe);
    else if (process.platform === 'linux') createLinuxDesktop(targetExe);
  } catch (e) {
    // Shortcut creation is a nice-to-have; a failure shouldn't break the install.
    console.warn(`xshell-app: could not create shortcut (${e.message}).`);
  }
}

function pickAsset() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    // Universal .app.tar.gz works on both Intel and Apple Silicon.
    return { name: 'xshell_universal.app.tar.gz', kind: 'targz' };
  }
  if (platform === 'linux' && arch === 'x64') {
    return { name: `xshell_${VERSION}_amd64.AppImage`, kind: 'appimage' };
  }
  if (platform === 'win32' && arch === 'x64') {
    // Portable .exe uploaded by the release workflow — relies on system WebView2
    // (built into Windows 10 1803+ and all Windows 11).
    return { name: `xshell_${VERSION}_x64.exe`, kind: 'exe' };
  }
  return null;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const fetchOnce = (currentUrl, redirectsLeft) => {
      const file = fs.createWriteStream(dest);
      https.get(currentUrl, { headers: { 'User-Agent': 'xshell-app-installer' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          file.close();
          fs.unlinkSync(dest);
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          return fetchOnce(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} fetching ${currentUrl}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
    };
    fetchOnce(url, 5);
  });
}

async function main() {
  const asset = pickAsset();
  if (!asset) {
    console.warn('xshell-app: no prebuilt binary for this platform yet.');
    console.warn(`Download manually: https://github.com/${REPO}/releases/latest`);
    return;
  }

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${asset.name}`;
  const downloadPath = path.join(INSTALL_DIR, asset.name);

  console.log(`xshell-app: downloading ${asset.name}…`);
  await download(url, downloadPath);

  let installedExe = null;
  if (asset.kind === 'appimage') {
    const target = path.join(INSTALL_DIR, 'xshell');
    fs.renameSync(downloadPath, target);
    fs.chmodSync(target, 0o755);
    installedExe = target;
  } else if (asset.kind === 'targz') {
    // macOS has tar built-in; extract xshell.app into INSTALL_DIR.
    execSync(`tar -xzf "${downloadPath}" -C "${INSTALL_DIR}"`);
    fs.unlinkSync(downloadPath);
    installedExe = path.join(INSTALL_DIR, 'xshell.app');
  } else if (asset.kind === 'exe') {
    installedExe = path.join(INSTALL_DIR, 'xshell.exe');
    fs.renameSync(downloadPath, installedExe);
  }

  console.log(`xshell-app: installed to ${INSTALL_DIR}`);
  if (installedExe) createShortcuts(installedExe);
  console.log('Run with:  xshell');
}

main().catch((err) => {
  console.warn(`xshell-app: install step failed (${err.message}).`);
  console.warn(`Download manually: https://github.com/${REPO}/releases/latest`);
  // Exit 0 so npm install does not fail — the wrapper handles missing-binary case at launch.
  process.exit(0);
});
