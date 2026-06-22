import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    // Bundle the Material Icon Theme SVGs (used by the file-explorer panel) so they're
    // served at /assets/material-icons in dev and embedded in the packaged Tauri build.
    // The file tree builds icon URLs against that base path — keep it in sync with FILE_ICONS_URL.
    viteStaticCopy({ targets: [{ src: "node_modules/vscode-material-icons/generated/icons/*", dest: "assets/material-icons", rename: { stripBase: true } }] }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
