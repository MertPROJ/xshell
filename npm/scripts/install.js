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

  if (asset.kind === 'appimage') {
    const target = path.join(INSTALL_DIR, 'xshell');
    fs.renameSync(downloadPath, target);
    fs.chmodSync(target, 0o755);
  } else if (asset.kind === 'targz') {
    // macOS has tar built-in; extract xshell.app into INSTALL_DIR.
    execSync(`tar -xzf "${downloadPath}" -C "${INSTALL_DIR}"`);
    fs.unlinkSync(downloadPath);
  } else if (asset.kind === 'exe') {
    fs.renameSync(downloadPath, path.join(INSTALL_DIR, 'xshell.exe'));
  }

  console.log(`xshell-app: installed to ${INSTALL_DIR}`);
  console.log('Run with:  xshell');
}

main().catch((err) => {
  console.warn(`xshell-app: install step failed (${err.message}).`);
  console.warn(`Download manually: https://github.com/${REPO}/releases/latest`);
  // Exit 0 so npm install does not fail — the wrapper handles missing-binary case at launch.
  process.exit(0);
});
