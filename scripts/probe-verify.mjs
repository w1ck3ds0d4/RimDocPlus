/**
 * Check that trimming the patch probe did not change what it reports.
 *
 * The probe is published trimmed, which takes it from 70 MB to 13 MB and makes it small
 * enough to ship beside the app. Trimming works by deleting code the linker believes is
 * unreachable, and Cecil warns that it uses reflection the linker cannot follow. Those
 * paths are the ones that write assemblies and read PDBs, and the probe does neither.
 *
 * That is a claim, and this is what checks it: both builds are run over the same install
 * and their reports compared byte for byte. If trimming ever removes something the probe
 * actually reaches, this fails rather than the app quietly under-reporting.
 *
 * Needs a RimWorld install to read. Skips, rather than fails, when there is not one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(ROOT, "sidecar", "PatchProbe", "bin", "Release", "net10.0", "win-x64");
const TRIMMED = join(OUT, "publish", "rimdoc-patchprobe.exe");
const PLAIN = join(OUT, "rimdoc-patchprobe.exe");

const GAME_CANDIDATES = [
  "C:/Program Files (x86)/Steam/steamapps/common/RimWorld",
  "C:/Program Files/Steam/steamapps/common/RimWorld",
  "D:/SteamLibrary/steamapps/common/RimWorld",
  "E:/SteamLibrary/steamapps/common/RimWorld",
];

/** Every DLL under a folder, since a mod nests them under version folders. */
function dlls(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) dlls(path, found);
    else if (entry.toLowerCase().endsWith(".dll")) found.push(path);
  }
  return found;
}

const game = GAME_CANDIDATES.find((path) => existsSync(join(path, "RimWorldWin64_Data", "Managed")));
if (!game) {
  console.log("No RimWorld install found. Nothing to verify against, so nothing to check.");
  process.exit(0);
}

if (!existsSync(TRIMMED) || !existsSync(PLAIN)) {
  console.error(
    "Build both first:\n  dotnet build   -c Release           (in sidecar/PatchProbe)\n  dotnet publish -c Release -r win-x64",
  );
  process.exit(1);
}

const workshop = join(game, "..", "..", "workshop", "content", "294100");
const request = JSON.stringify({
  managed: join(game, "RimWorldWin64_Data", "Managed"),
  assemblies: [...dlls(workshop), ...dlls(join(game, "Mods"))].sort(),
});

console.log(`Probing ${JSON.parse(request).assemblies.length} assemblies with both builds...`);
const run = (exe) => execFileSync(exe, { input: request, maxBuffer: 256 * 1024 * 1024 }).toString();
const [trimmed, plain] = [run(TRIMMED), run(PLAIN)];

if (trimmed !== plain) {
  console.error("The trimmed build reports something different from the untrimmed one.");
  console.error(`  trimmed:   ${trimmed.length} bytes`);
  console.error(`  untrimmed: ${plain.length} bytes`);
  console.error("Trimming has removed something the probe reaches. Do not ship this build.");
  process.exit(1);
}

const report = JSON.parse(trimmed);
console.log(
  `Identical: ${trimmed.length} bytes, ${report.patches.length} patch classes, ${report.assembliesRead} assemblies read.`,
);
