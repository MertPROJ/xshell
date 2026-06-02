// Terminal font selection: prefer an installed Nerd Font
// (best glyph coverage for the Claude Code logo, powerline bits and status-line icons),
// otherwise fall back to the bundled "JetBrains Mono" (see @font-face in App.css) so the
// render never depends on whatever monospace the OS happens to ship.
//
// The previous hardcoded "Consolas, 'Courier New'" was the root of the squeezed-logo look:
// Consolas lacks the special glyphs, so they substituted at the wrong metrics.

const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

// Bundled JetBrains Mono leads the non-Nerd fallback chain; the rest are OS defaults.
const FALLBACK_CHAIN = '"JetBrains Mono", Consolas, "Cascadia Mono", SFMono-Regular, Menlo, monospace';

let detected: string | null = null;
let monoReady: Promise<void> | null = null;

// Wait for the bundled JetBrains Mono faces to load before xterm measures the cell, so the
// first fit() doesn't size against a fallback metric and then jump when the webfont lands.
export function ensureMonoFontsLoaded(): Promise<void> {
  if (monoReady) return monoReady;
  if (typeof document === "undefined" || !document.fonts?.load) {
    monoReady = Promise.resolve();
    return monoReady;
  }
  monoReady = Promise.allSettled([
    document.fonts.load('400 14px "JetBrains Mono"'),
    document.fonts.load('700 14px "JetBrains Mono"'),
  ]).then(() => undefined);
  return monoReady;
}

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  if (typeof document === "undefined" || !document.fonts) {
    detected = FALLBACK_CHAIN;
    return detected;
  }
  for (const f of NERD_FONT_CANDIDATES) {
    try {
      if (document.fonts.check(`12px "${f}"`)) {
        detected = `"${f}", ${FALLBACK_CHAIN}`;
        return detected;
      }
    } catch {
      // Some engines throw on an odd font shorthand; ignore and keep probing.
    }
  }
  detected = FALLBACK_CHAIN;
  return detected;
}
