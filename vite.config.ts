/// <reference types="vitest/config" />
import { createReadStream, statSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Serves mod banner images to the browser build during development.
 *
 * The allowlist is the exact set of preview paths the scan recorded, so this cannot be
 * pointed at an arbitrary file by editing a query string. It exists only under `vite dev`;
 * the desktop build reads previews through the shell's own narrow command instead, and a
 * production browser build simply has no banner to show.
 */
function modPreviews(): Plugin {
  const SCAN = "src/dev-data/scan.json";
  let allowed = new Set<string>();
  let readAt = 0;

  const refresh = () => {
    let mtime = 0;
    try {
      mtime = statSync(SCAN).mtimeMs;
    } catch {
      return allowed;
    }
    // Rescanning rewrites scan.json, and a cache held for the life of the dev server would
    // then reject every newly installed mod's banner until a restart.
    if (mtime === readAt) return allowed;
    try {
      const scan = JSON.parse(readFileSync(SCAN, "utf8")) as { mods?: { previewPath?: string }[] };
      allowed = new Set((scan.mods ?? []).flatMap((m) => (m.previewPath ? [m.previewPath] : [])));
      readAt = mtime;
    } catch {
      /* a half-written scan is retried on the next request */
    }
    return allowed;
  };

  return {
    name: "rimdoc-mod-previews",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__modfile", (req, res) => {
        const path = new URL(req.url ?? "", "http://x").searchParams.get("p") ?? "";
        if (!refresh().has(path)) {
          res.statusCode = 403;
          res.end("Not a scanned mod preview");
          return;
        }
        res.setHeader("Content-Type", path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
        res.setHeader("Cache-Control", "max-age=3600");
        createReadStream(path)
          .on("error", () => {
            res.statusCode = 404;
            res.end("Gone from disk");
          })
          .pipe(res);
      });
    },
  };
}

// Tauri expects a fixed dev port; @see https://v2.tauri.app
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), modPreviews()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Parsing and rule logic is pure TS so it runs headless; `pnpm test`.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
