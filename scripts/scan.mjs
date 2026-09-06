/**
 * Reads a local RimWorld install and writes the fixtures the dev UI loads.
 *
 * This is the reference implementation of the scan. The Rust backend performs the same
 * walk in the shipped app; keeping a node version means the parsing and rule layers can
 * be exercised against a real 250-mod install without building the desktop shell.
 *
 *   pnpm scan            scan the auto-detected install
 *   pnpm scan --log path use a specific Player.log
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { parseAbout, parseModsConfig, gameCycleOf } from "../src/lib/analysis/about.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "src", "dev-data");

const GAME_CANDIDATES = [
  "C:/Program Files (x86)/Steam/steamapps/common/RimWorld",
  "C:/Program Files/Steam/steamapps/common/RimWorld",
  "D:/SteamLibrary/steamapps/common/RimWorld",
  "E:/SteamLibrary/steamapps/common/RimWorld",
  join(homedir(), ".steam/steam/steamapps/common/RimWorld"),
];

const SAVE_CANDIDATES = [
  join(homedir(), "AppData/LocalLow/Ludeon Studios/RimWorld by Ludeon Studios"),
  join(homedir(), "Library/Application Support/RimWorld"),
  join(homedir(), ".config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios"),
];

function firstExisting(paths) {
  return paths.find((p) => existsSync(p));
}

function discover() {
  const game = firstExisting(GAME_CANDIDATES);
  const saveData = firstExisting(SAVE_CANDIDATES);
  // The workshop content folder sits beside `common`, not inside the game folder.
  const workshop = game ? resolve(game, "../../workshop/content/294100") : undefined;
  return {
    game,
    workshop: workshop && existsSync(workshop) ? workshop : undefined,
    localMods: game && existsSync(join(game, "Mods")) ? join(game, "Mods") : undefined,
    saveData,
    playerLog:
      saveData && existsSync(join(saveData, "Player.log")) ? join(saveData, "Player.log") : undefined,
  };
}

/** Textures at or above this in either dimension are worth naming individually. */
const OVERSIZE_PX = 1024;

/**
 * Read a PNG's dimensions from its header.
 *
 * Only the first 24 bytes are needed: signature, IHDR length, the IHDR tag, then width
 * and height as big-endian uint32. Reading the whole file would be thousands of times
 * more IO for the two numbers that determine VRAM cost.
 */
function pngSize(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24) return null;
    if (head.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * One pass over a mod folder producing both its on-disk size and its texture footprint.
 * Walking twice would double the IO on a 253-mod install for no extra information.
 */
function measureMod(dir, budget = 6000) {
  let total = 0;
  let seen = 0;
  const textures = { count: 0, estimatedVramBytes: 0, oversized: [], truncated: false };
  const stack = [dir];

  while (stack.length) {
    if (seen >= budget) {
      textures.truncated = true;
      break;
    }
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen++;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += statSync(full).size;
      } catch {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".png")) continue;
      const size = pngSize(full);
      if (!size) continue;
      textures.count++;
      textures.estimatedVramBytes += size.width * size.height * 4;
      if (size.width >= OVERSIZE_PX || size.height >= OVERSIZE_PX) {
        textures.oversized.push({ path: full, width: size.width, height: size.height });
      }
    }
  }

  textures.oversized.sort((a, b) => b.width * b.height - a.width * a.height);
  // A mod with hundreds of oversized textures needs the count, not every path.
  textures.oversized = textures.oversized.slice(0, 25);
  return { sizeBytes: total, textures };
}

/** RimWorld accepts About/About.xml with any casing, and some mods ship it uppercased. */
function readAbout(folder) {
  for (const candidate of ["About/About.xml", "about/about.xml", "About/about.xml"]) {
    const path = join(folder, candidate);
    if (existsSync(path)) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Folder mtime, which Steam bumps on update, so it stands in for "last updated". */
function folderMtime(folder) {
  try {
    return statSync(folder).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function hasSubdir(folder, name) {
  const direct = join(folder, name);
  if (existsSync(direct)) return true;
  // Versioned mods nest their payload under a cycle folder, e.g. `1.6/Assemblies`.
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+$/.test(e.name))
      .some((e) => existsSync(join(folder, e.name, name)));
  } catch {
    return false;
  }
}

function scanModDir(dir, source) {
  const mods = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return mods;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(dir, entry.name);
    const xml = readAbout(folder);
    if (!xml) continue;
    const measured = measureMod(folder);
    const mod = parseAbout({
      xml,
      folder,
      source,
      steamId: source === "steam" ? entry.name : undefined,
      hasAssemblies: hasSubdir(folder, "Assemblies"),
      hasPatches: hasSubdir(folder, "Patches"),
      sizeBytes: measured.sizeBytes,
      updatedAt: folderMtime(folder),
    });
    if (mod) mods.push({ ...mod, textures: measured.textures });
  }
  return mods;
}

function main() {
  const paths = discover();
  if (!paths.game) {
    console.error("No RimWorld install found. Checked:\n  " + GAME_CANDIDATES.join("\n  "));
    process.exit(1);
  }

  const modsConfigPath = paths.saveData && join(paths.saveData, "Config", "ModsConfig.xml");
  if (!modsConfigPath || !existsSync(modsConfigPath)) {
    console.error(`No ModsConfig.xml under ${paths.saveData}`);
    process.exit(1);
  }

  const { gameVersion, activeOrder } = parseModsConfig(readFileSync(modsConfigPath, "utf8"));

  const mods = [
    ...scanModDir(join(paths.game, "Data"), "official"),
    ...(paths.localMods ? scanModDir(paths.localMods, "local") : []),
    ...(paths.workshop ? scanModDir(paths.workshop, "steam") : []),
  ];

  const position = new Map(activeOrder.map((id, i) => [id, i]));
  for (const mod of mods) {
    mod.active = position.has(mod.packageId);
    mod.loadIndex = position.get(mod.packageId) ?? null;
  }

  const scan = {
    scannedAt: new Date().toISOString(),
    gameVersion,
    gameCycle: gameCycleOf(gameVersion),
    paths,
    mods,
    activeOrder,
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "scan.json"), JSON.stringify(scan, null, 2));

  const logArg = process.argv.indexOf("--log");
  const logPath = logArg > -1 ? process.argv[logArg + 1] : paths.playerLog;
  if (logPath && existsSync(logPath)) {
    // Logs carry raw bytes from mods with odd encodings, so read lossily on purpose.
    const text = readFileSync(logPath, "latin1");
    writeFileSync(join(OUT, "session.json"), JSON.stringify({ path: logPath, text }, null, 2));
    console.log(`log      ${logPath} (${text.split("\n").length} lines)`);
  }

  const active = mods.filter((m) => m.active).length;
  const vram = mods
    .filter((m) => m.active)
    .reduce((sum, m) => sum + (m.textures?.estimatedVramBytes ?? 0), 0);
  const oversized = mods
    .filter((m) => m.active)
    .reduce((sum, m) => sum + (m.textures?.oversized.length ?? 0), 0);
  console.log(`game     ${paths.game}`);
  console.log(`version  ${gameVersion} (cycle ${scan.gameCycle})`);
  console.log(`mods     ${mods.length} on disk, ${active} active, ${activeOrder.length} in load order`);
  console.log(`textures ${(vram / 1024 ** 3).toFixed(2)} GB estimated VRAM, ${oversized}+ oversized`);
  console.log(`wrote    ${join(OUT, "scan.json")}`);
}

main();
