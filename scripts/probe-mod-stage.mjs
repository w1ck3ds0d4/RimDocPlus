/**
 * Assemble the companion mod where Tauri will bundle it from.
 *
 * The mod is two files: an About.xml and the assembly built from sidecar/CompanionMod. They
 * are laid out here exactly as they must appear inside the game's Mods folder, so installing
 * is a copy and nothing has to know the layout twice.
 *
 * Staged rather than committed, for the same reason as the patch probe: it is a build output.
 * Unlike the probe it is 13 KB, but a binary that is rebuilt whenever the game version moves
 * does not belong in a history either.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FROM = join(ROOT, "sidecar", "CompanionMod");
const INTO = join(ROOT, "src-tauri", "resources", "probe-mod");

const files = [
  ["About/About.xml", "About/About.xml"],
  // RimWorld draws this beside the mod in its own list, and every one of the 248 Workshop
  // mods on the reference install ships one. Without it the companion mod was the only
  // entry with a hole where the others have a picture, in the game and in this app.
  ["About/Preview.png", "About/Preview.png"],
  ["bin/Release/RimDocProbe.dll", "Assemblies/RimDocProbe.dll"],
];

for (const [from, to] of files) {
  const source = join(FROM, from);
  if (!existsSync(source)) {
    console.error(`Missing ${source}\nRun: pnpm probe-mod:build`);
    process.exit(1);
  }
  const target = join(INTO, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`  ${to.padEnd(28)} ${statSync(target).size} bytes`);
}

console.log(`Staged the companion mod to ${INTO}`);
