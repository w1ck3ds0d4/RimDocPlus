/**
 * Fetches public Workshop metadata for the mods the scan found, and caches it.
 *
 * This is the only part of RimDoc+ that touches the network, so it is a separate opt-in
 * command rather than part of `pnpm scan`. What leaves the machine is a list of Workshop
 * file ids, which are public identifiers for public mods. No Steam account, no key, no
 * credential of any kind is involved: GetPublishedFileDetails is an anonymous endpoint.
 *
 * It has to run here rather than in the browser because Steam sends no CORS headers. The
 * shipped app performs the same request from Rust.
 *
 *   pnpm workshop           fetch anything missing or older than the cache TTL
 *   pnpm workshop --force   refetch everything
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "src", "dev-data");
const CACHE = join(OUT, "workshop.json");

const ENDPOINT = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const BATCH = 50;
/** Subscriber counts barely move day to day, so a week-old answer is still a good one. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAUSE_MS = 400;

function loadCache() {
  if (!existsSync(CACHE)) return { fetchedAt: null, items: {} };
  try {
    const parsed = JSON.parse(readFileSync(CACHE, "utf8"));
    return { fetchedAt: parsed.fetchedAt ?? null, items: parsed.items ?? {} };
  } catch {
    return { fetchedAt: null, items: {} };
  }
}

async function fetchBatch(ids) {
  const body = new URLSearchParams();
  body.set("itemcount", String(ids.length));
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Steam returned ${response.status}`);

  const json = await response.json();
  const details = json?.response?.publishedfiledetails ?? [];
  const out = {};
  for (const item of details) {
    // result 1 is success; anything else means the item is gone or private.
    if (item.result !== 1) continue;
    out[item.publishedfileid] = {
      id: item.publishedfileid,
      title: item.title ?? "",
      subscriptions: item.subscriptions ?? 0,
      favorited: item.favorited ?? 0,
      views: item.views ?? 0,
      timeUpdated: item.time_updated ?? 0,
      timeCreated: item.time_created ?? 0,
      fileSize: Number(item.file_size ?? 0),
      tags: (item.tags ?? []).map((t) => t.tag).filter(Boolean),
    };
  }
  return out;
}

async function main() {
  const scanPath = join(OUT, "scan.json");
  if (!existsSync(scanPath)) {
    console.error("No scan.json. Run `pnpm scan` first.");
    process.exit(1);
  }

  const scan = JSON.parse(readFileSync(scanPath, "utf8"));
  const ids = [...new Set(scan.mods.map((m) => m.steamId).filter(Boolean))];
  if (!ids.length) {
    console.error("No Workshop mods in the scan.");
    process.exit(1);
  }

  const force = process.argv.includes("--force");
  const cache = loadCache();
  const fresh = cache.fetchedAt && Date.now() - Date.parse(cache.fetchedAt) < TTL_MS;
  const wanted = force || !fresh ? ids : ids.filter((id) => !cache.items[id]);

  if (!wanted.length) {
    console.log(`cache   ${Object.keys(cache.items).length} items, still fresh. Use --force to refetch.`);
    return;
  }

  console.log(`fetch   ${wanted.length} of ${ids.length} Workshop ids from Steam`);
  console.log("sending only public Workshop file ids, no account or key");

  const items = { ...cache.items };
  let failed = 0;
  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH);
    try {
      Object.assign(items, await fetchBatch(chunk));
      process.stdout.write(`  ${Math.min(i + BATCH, wanted.length)}/${wanted.length}\r`);
    } catch (error) {
      failed += chunk.length;
      console.warn(`\n  batch failed: ${error.message}`);
    }
    // Steam is being generous by not requiring a key here; do not hammer it.
    if (i + BATCH < wanted.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), items }, null, 2));

  const resolved = Object.keys(items).length;
  console.log(`\nresolved ${resolved} items${failed ? `, ${failed} failed` : ""}`);
  console.log(`wrote    ${CACHE}`);
}

main();
