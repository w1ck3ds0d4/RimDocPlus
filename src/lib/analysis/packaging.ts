import type { Finding, ModEntry, WorkshopCache } from "../types";

/**
 * Libraries a mod is expected to carry, because they are the mod.
 *
 * Harmony's own package ships 0Harmony.dll, and every framework ships its own assembly. The
 * rule is about a mod bundling somebody else's library, not about a library existing.
 */
const OWN_LIBRARY: Record<string, string> = {
  "0harmony.dll": "brrainz.harmony",
  "prepatcher.dll": "zetrith.prepatcher",
  "hugslib.dll": "unlimitedhugs.hugslib",
};

/**
 * Two mods shipping the same assembly.
 *
 * RimWorld loads assemblies into one process, so the first copy of a given library wins and
 * every later one is ignored. When the copies differ in version, whichever mod loads second
 * gets silently bound to the first mod's build of the library, which fails in ways that look
 * like a bug in the wrong mod entirely.
 *
 * Reported, not repaired: removing a bundled DLL is the author's call, and the mod may not
 * run without it. The value is knowing which pair to look at when one of them misbehaves.
 */
export function ruleBundledAssemblies(active: ModEntry[]): Finding[] {
  const byFile = new Map<string, ModEntry[]>();
  for (const mod of active) {
    for (const dll of mod.assemblies ?? []) {
      const owners = byFile.get(dll) ?? [];
      owners.push(mod);
      byFile.set(dll, owners);
    }
  }

  const shared = [...byFile.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  if (!shared.length) return [];

  const lines = shared.map(([dll, owners]) => {
    const owner = OWN_LIBRARY[dll];
    const rightful = owner ? active.find((m) => m.packageId === owner) : undefined;
    const note = rightful ? `  (belongs to ${rightful.name})` : "";
    return `  ${dll}${note}\n${owners.map((m) => `      ${m.name}`).join("\n")}`;
  });

  const worst = shared[0];
  return [
    {
      id: "bundled-assemblies",
      rule: "bundled-assemblies",
      severity: "warning",
      title:
        shared.length === 1
          ? `${worst[1].length} mods ship the same assembly: ${worst[0]}`
          : `${shared.length} assemblies are shipped by more than one mod`,
      detail:
        "RimWorld loads every assembly into one process, so the first copy of a library wins and " +
        "the rest are ignored. Where the copies are different versions, whichever mod loads " +
        "second is silently bound to the other mod's build, which then fails in a way that looks " +
        "like a fault in the wrong mod.\n\n" +
        "Nothing here is repaired automatically: whether a bundled library can be removed is the " +
        "author's call, and some mods will not run without theirs. This is here so you know which " +
        "pair to look at when one of them misbehaves.\n\n" +
        lines.join("\n"),
      packageIds: [...new Set(shared.flatMap(([, owners]) => owners.map((m) => m.packageId)))],
      count: shared.length,
    },
  ];
}

/** Days between a Workshop update and the folder's own modification time. */
const STALE_DAYS = 2;

/**
 * Mods the Workshop has updated more recently than the copy on disk.
 *
 * Steam normally keeps subscriptions current, so this is not routine housekeeping: it means
 * a download did not land. That happens quietly, and the usual symptom is a mod behaving
 * like an older version of itself against a game that has moved on.
 *
 * Only reported where both dates are known and the gap is wide enough to be real. Folder
 * modification time is a proxy, and a couple of days of slack keeps timezone and
 * touched-on-copy noise out of it.
 */
export function ruleWorkshopUpdates(active: ModEntry[], workshop: WorkshopCache | null): Finding[] {
  if (!workshop) return [];

  const stale = active
    .flatMap((mod) => {
      if (!mod.steamId || !mod.updatedAt) return [];
      const details = workshop.items[mod.steamId];
      if (!details?.timeUpdated) return [];
      const published = details.timeUpdated * 1000;
      const local = new Date(mod.updatedAt).getTime();
      if (Number.isNaN(local)) return [];
      const behindDays = (published - local) / 86_400_000;
      return behindDays >= STALE_DAYS ? [{ mod, behindDays: Math.round(behindDays) }] : [];
    })
    .sort((a, b) => b.behindDays - a.behindDays);

  if (!stale.length) return [];

  return [
    {
      id: "workshop-updates",
      rule: "workshop-updates",
      severity: "info",
      title: `${stale.length} mod${stale.length === 1 ? "" : "s"} newer on the Workshop than on disk`,
      detail:
        "Steam normally keeps subscriptions current, so a gap here usually means a download did " +
        "not land rather than that an update is merely pending. The symptom is a mod behaving " +
        "like an older version of itself.\n\n" +
        `Compared against each folder's modification time, which is a proxy rather than a ` +
        `version, so anything under ${STALE_DAYS} days is ignored as noise. Retry download on a ` +
        "mod's page makes Steam fetch it again.\n\n" +
        stale
          .slice(0, 12)
          .map((s) => `  ${s.behindDays}d behind  ${s.mod.name}`)
          .join("\n") +
        (stale.length > 12 ? `\n  and ${stale.length - 12} more` : ""),
      packageIds: stale.map((s) => s.mod.packageId),
      count: stale.length,
    },
  ];
}
