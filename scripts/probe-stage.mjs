/**
 * Put the published patch probe where Tauri expects a sidecar.
 *
 * Tauri copies `src-tauri/binaries/<name>-<target triple>` next to the app executable when
 * it bundles, and that folder is gitignored: a 13 MB binary is built, not committed. This
 * copies the published one in under the name the triple demands.
 *
 * Run after `pnpm probe:build`, and before `pnpm tauri:build` on a fresh clone. The app
 * works without it; the Harmony check is the one thing that reports the probe is missing
 * rather than pretending it found nothing.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** The triple Tauri names a sidecar by, taken from the compiler rather than guessed. */
function targetTriple() {
  const out = execFileSync("rustc", ["-vV"]).toString();
  const host = out.split("\n").find((line) => line.startsWith("host:"));
  if (!host) throw new Error("rustc did not report a host triple.");
  return host.slice("host:".length).trim();
}

const triple = targetTriple();
const windows = triple.includes("windows");
const from = join(
  ROOT,
  "sidecar",
  "PatchProbe",
  "bin",
  "Release",
  "net10.0",
  windows ? "win-x64" : "linux-x64",
  "publish",
  windows ? "rimdoc-patchprobe.exe" : "rimdoc-patchprobe",
);

if (!existsSync(from)) {
  console.error(`No published probe at ${from}\nRun: pnpm probe:build`);
  process.exit(1);
}

const into = join(ROOT, "src-tauri", "binaries");
mkdirSync(into, { recursive: true });
const to = join(into, `rimdoc-patchprobe-${triple}${windows ? ".exe" : ""}`);
copyFileSync(from, to);

console.log(`Staged ${(statSync(to).size / 1048576).toFixed(1)} MB to ${to}`);
