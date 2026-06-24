import { getIconUrlForFilePath, getIconForDirectoryPath, getIconUrlByName, isMaterialIconName, type MaterialIcon } from "vscode-material-icons";

// Static base path the Material Icon SVGs are copied to by vite-plugin-static-copy
// (see vite.config.ts). Resolves against the app origin in both dev and the packaged build.
// Shared by the file explorer and the git changes tree so both render identical icons.
export const FILE_ICONS_URL = "/assets/material-icons";

export function fileIconUrl(name: string): string { return getIconUrlForFilePath(name, FILE_ICONS_URL); }

export function folderIconUrl(name: string, open: boolean): string {
  const base = getIconForDirectoryPath(name);
  const candidate = `${base}-open` as MaterialIcon;
  const icon: MaterialIcon = open && isMaterialIconName(candidate) ? candidate : base;
  return getIconUrlByName(icon, FILE_ICONS_URL);
}

// Generic folder icon (no per-name theming) — used by the git changes tree, where one
// consistent folder glyph reads cleaner than a different icon for every directory name.
export function plainFolderIconUrl(open: boolean): string {
  return getIconUrlByName(open ? "folder-open" : "folder", FILE_ICONS_URL);
}
