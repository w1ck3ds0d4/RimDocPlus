import type { Finding, ScanResult, WorkshopCache } from "../types";
import { DEFAULT_OVERSIZE_PX, DOWNSCALE_TARGET_PX, oversizedAt } from "../analysis/performance.ts";
import { sortLoadOrder, toggleMod, toModsConfigXml, type Modpack } from "../modpacks.ts";
import { rankDuplicates, rankKeepPreference } from "../analysis/duplicates.ts";

/**
 * A change to a file on disk.
 *
 * These are described as intentions rather than raw writes, so the same plan can be
 * carried out by the Tauri shell or rendered as a script the player runs. Nothing here
 * ever touches a mod folder's payload; the only edits are metadata and config.
 */
export type FileAction =
  | { op: "add-supported-version"; path: string; cycle: string; reason: string }
  | { op: "write"; path: string; contents: string; reason: string }
  | { op: "delete-matching"; directory: string; pattern: string; reason: string }
  | { op: "downscale-png"; path: string; maxPx: number; fromPx: number; reason: string }
  | { op: "forget-workshop-item"; path: string; steamId: string; reason: string };

export interface RepairChoice {
  label: string;
  detail?: string;
  /** Set when the repair can defend this option over the others. */
  recommended?: boolean;
  /** Why this one, and what argues against it. Caveats mean the signals disagree. */
  rationale?: { reasons: string[]; caveats: string[]; arbitrary: boolean };
  plan: () => RepairPlan;
}

/**
 * What carrying out a repair actually involves. The split matters: a pack repair is
 * app state and applies instantly, a file repair needs the shell or a script, and an
 * external repair is something only the player can do.
 */
export type RepairPlan =
  | { kind: "modpack"; modpack: Modpack; summary: string }
  | { kind: "files"; actions: FileAction[]; summary: string }
  | { kind: "external"; summary: string; url?: string }
  | { kind: "choice"; summary: string; choices: RepairChoice[] };

export interface RepairContext {
  scan: ScanResult;
  modpack: Modpack;
  finding: Finding;
  /** Optional: lets a repair reason about popularity and maintenance, not just files. */
  workshop?: WorkshopCache | null;
}

type RepairFn = (ctx: RepairContext) => RepairPlan | null;

function str(ctx: RepairContext, key: string): string | undefined {
  const value = ctx.finding.fix?.params?.[key];
  return typeof value === "string" ? value : undefined;
}

function list(ctx: RepairContext, key: string): string[] {
  const value = ctx.finding.fix?.params?.[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

function modsById(scan: ScanResult) {
  return new Map(scan.mods.map((m) => [m.packageId, m]));
}

/** How many enabled mods depend on each mod, for repairs that weigh what breaking costs. */
function dependentsOf(ctx: RepairContext): Map<string, number> {
  const active = new Set(ctx.modpack.activeOrder);
  const counts = new Map<string, number>();
  for (const mod of ctx.scan.mods) {
    if (!active.has(mod.packageId)) continue;
    for (const dep of mod.dependencies) {
      const id = dep.packageId.toLowerCase();
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Steam's record of which Workshop items it has downloaded for RimWorld.
 *
 * Derived from the content folder the scan already found, which sits two levels below it, so
 * a non-standard Steam library works without being configured anywhere.
 */
export function workshopManifest(scan: ScanResult): string | null {
  const content = scan.paths.workshop;
  if (!content) return null;
  // Both separators, because the scan reports whatever the platform handed it and on Windows
  // that is backslashes throughout.
  const root = content.replace(/[\\/]+content[\\/]+\d+[\\/]*$/, "");
  if (root === content) return null;
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root}${sep}appworkshop_294100.acf`;
}

/** Config folder holding ModsConfig.xml and per-mod settings files. */
export function configDir(scan: ScanResult): string | null {
  return scan.paths.saveData ? `${scan.paths.saveData}/Config` : null;
}

/**
 * Ordering repairs all reduce to the same well-tested primitive. The sort is stable, so
 * fixing one violation moves only what the constraints actually require and the diff
 * stays reviewable rather than reshuffling 224 entries.
 */
const applySort: RepairFn = ({ modpack, scan }) => {
  const activeOrder = sortLoadOrder(modpack.activeOrder, scan.mods);
  const moved = activeOrder.filter((id, i) => modpack.activeOrder[i] !== id).length;
  if (!moved) return null;
  return {
    kind: "modpack",
    modpack: { ...modpack, activeOrder, updatedAt: modpack.updatedAt },
    summary: `Reorders ${moved} of ${activeOrder.length} entries to satisfy the declared constraints.`,
  };
};

const REPAIRS: Record<string, RepairFn> = {
  "remove-orphan-entries": (ctx) => {
    const ids = new Set(list(ctx, "ids"));
    if (!ids.size) return null;
    return {
      kind: "modpack",
      modpack: {
        ...ctx.modpack,
        activeOrder: ctx.modpack.activeOrder.filter((id) => !ids.has(id)),
      },
      summary: `Drops ${ids.size} entry(s) that no folder provides. Nothing on disk changes.`,
    };
  },

  "hoist-official-content": applySort,
  "hoist-bootstrap": applySort,
  reorder: applySort,

  "enable-dependency": (ctx) => {
    const dependency = str(ctx, "dependency");
    if (!dependency || ctx.modpack.activeOrder.includes(dependency)) return null;
    const modpack = toggleMod(ctx.modpack, dependency, ctx.scan.mods);
    const name = modsById(ctx.scan).get(dependency)?.name ?? dependency;
    return {
      kind: "modpack",
      modpack,
      summary: `Enables ${name} at position ${modpack.activeOrder.indexOf(dependency)}, ahead of what needs it.`,
    };
  },

  "disable-one-of": (ctx) => {
    const candidates = list(ctx, "candidates");
    if (candidates.length < 2) return null;
    const byId = modsById(ctx.scan);

    const mods = candidates.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
    const ranking = rankKeepPreference(mods, dependentsOf(ctx), ctx.workshop ?? null);
    // The ranking names what to keep; the choices are about what to disable.
    const disable = ranking ? candidates.find((id) => id !== ranking.recommended.packageId) : undefined;

    return {
      kind: "choice",
      summary:
        "These two declare they cannot coexist." +
        (ranking && disable
          ? ` Keeping ${ranking.recommended.name} costs less: ${ranking.reasons.join(". ")}.` +
            (ranking.caveats.length ? ` Against that: ${ranking.caveats.join(". ")}.` : "")
          : " Nothing measurable separates them."),
      choices: candidates.map((id) => ({
        label: `Disable ${byId.get(id)?.name ?? id}`,
        detail: id,
        recommended: id === disable,
        rationale: ranking && id === disable ? ranking : undefined,
        plan: (): RepairPlan => ({
          kind: "modpack",
          modpack: {
            ...ctx.modpack,
            activeOrder: ctx.modpack.activeOrder.filter((other) => other !== id),
          },
          summary: `Removes ${byId.get(id)?.name ?? id} from the modpack.`,
        }),
      })),
    };
  },

  "pick-duplicate-winner": (ctx) => {
    const packageId = str(ctx, "packageId");
    if (!packageId) return null;

    const copies = ctx.scan.mods.filter((m) => m.packageId === packageId);
    // The static rule names the folders it found; a rule reading them out of a log cannot,
    // because a log knows the mod and not where it lives. Falling back to the scan lets one
    // repair serve both, and the scan is the better source in either case since it is
    // current while the log is a record of a run that already ended.
    const folders = list(ctx, "folders").length ? list(ctx, "folders") : copies.map((m) => m.folder);
    if (folders.length < 2) return null;
    const ranking = rankDuplicates(copies, ctx.scan.gameCycle, ctx.workshop ?? null);
    const byFolder = new Map(copies.map((m) => [m.folder, m]));

    const advice = ranking
      ? `\n\nSuggested: keep ${ranking.recommended.name}. ${ranking.reasons.join(". ")}.` +
        (ranking.caveats.length
          ? `\n\nAgainst that: ${ranking.caveats.join(". ")}. The evidence points both ways, so this is a ` +
            "judgement rather than an answer."
          : "")
      : "";

    return {
      kind: "choice",
      summary:
        "Two folders provide this mod and RimWorld silently picks one. Keep the copy you want and " +
        "remove the other. A Workshop copy comes back on the next Steam sync, so a local copy is " +
        "usually the one to keep." +
        advice,
      choices: folders.map((keep) => ({
        label: `Keep ${byFolder.get(keep)?.name ?? keep.split(/[\\/]/).pop()}`,
        detail: keep,
        recommended: ranking?.recommended.folder === keep,
        rationale: ranking?.recommended.folder === keep ? ranking : undefined,
        plan: (): RepairPlan => ({
          kind: "files",
          summary: `Removes the other ${folders.length - 1} copy(s) of ${packageId}.`,
          actions: folders
            .filter((folder) => folder !== keep)
            .map((folder) => ({
              op: "delete-matching" as const,
              directory: folder,
              pattern: "*",
              reason: `Duplicate copy of ${packageId}; keeping ${keep}`,
            })),
        }),
      })),
    };
  },

  "install-dependency": (ctx) => {
    const dependency = str(ctx, "dependency");
    if (!dependency) return null;
    const name = str(ctx, "name") ?? dependency;
    return {
      kind: "external",
      summary: `${name} is not installed. Subscribe to it on the Workshop, then rescan.`,
      url: `https://steamcommunity.com/workshop/browse/?appid=294100&searchtext=${encodeURIComponent(name)}`,
    };
  },

  "stamp-supported-version": (ctx) => {
    const cycle = str(ctx, "cycle");
    const ids = list(ctx, "ids");
    const byId = modsById(ctx.scan);
    if (!cycle || !ids.length) return null;
    const actions = ids
      .map((id) => byId.get(id))
      .filter((mod): mod is NonNullable<typeof mod> => !!mod)
      .map((mod) => ({
        op: "add-supported-version" as const,
        path: `${mod.folder}/About/About.xml`,
        cycle,
        reason: `${mod.name} does not advertise ${cycle}`,
      }));
    if (!actions.length) return null;
    return {
      kind: "files",
      actions,
      summary:
        `Adds <li>${cycle}</li> to supportedVersions in ${actions.length} About.xml file(s). This ` +
        `only changes what a mod advertises, never its content, and every file is backed up first.`,
    };
  },

  "downscale-textures": (ctx) => {
    const target = Number(str(ctx, "target") ?? DOWNSCALE_TARGET_PX);
    // Taken from the finding rather than re-derived. The scan records every texture above
    // the downscale target, so without this the plan would cover files the finding that
    // proposed it never counted.
    const threshold = Number(str(ctx, "threshold") ?? DEFAULT_OVERSIZE_PX);
    const byId = modsById(ctx.scan);
    const actions = list(ctx, "ids")
      .map((id) => byId.get(id))
      .filter((mod): mod is NonNullable<typeof mod> => !!mod)
      .flatMap((mod) =>
        oversizedAt(mod, threshold).map((texture) => ({
          op: "downscale-png" as const,
          path: texture.path,
          maxPx: target,
          // Carried so the duration estimate can be per file rather than a flat average.
          fromPx: texture.width * texture.height,
          reason: `${mod.name}: ${texture.width}x${texture.height}`,
        })),
      );
    if (!actions.length) return null;

    // Real before/after, computed per texture from its own dimensions rather than a
    // flat guess, so the saving quoted is the one the resize actually produces.
    let before = 0;
    let after = 0;
    for (const id of list(ctx, "ids")) {
      const mod = byId.get(id);
      for (const t of mod ? oversizedAt(mod, threshold) : []) {
        const scale = Math.min(target / t.width, target / t.height, 1);
        before += t.width * t.height * 4;
        after += Math.round(t.width * scale) * Math.round(t.height * scale) * 4;
      }
    }
    const savedMb = (before - after) / 1024 ** 2;

    return {
      kind: "files",
      actions,
      summary:
        `Resizes ${actions.length} texture(s) so neither side exceeds ${target}px, keeping aspect ratio. ` +
        `Frees an estimated ${savedMb >= 1024 ? `${(savedMb / 1024).toFixed(1)} GB` : `${savedMb.toFixed(0)} MB`} ` +
        `of decoded texture data, down from ${(before / 1024 ** 3).toFixed(2)} GB to ` +
        `${(after / 1024 ** 3).toFixed(2)} GB. Every file is copied to .rimdocbak first, so it is ` +
        "reversible. Tier 3: it changes mod content, so nothing here runs automatically.",
    };
  },

  /**
   * Make Steam fetch a Workshop item again.
   *
   * Steam's manifest keeps two lists: what it believes is downloaded, and what the account
   * subscribes to. Dropping the installed record while leaving the subscription is what
   * makes it fetch the item afresh, and is why this is not the same as unsubscribing.
   *
   * The folder goes too. Steam treats a present folder as proof of a good copy, so leaving
   * a half-downloaded one behind is how an item stays broken through several retries.
   */
  "retry-workshop-download": (ctx) => {
    const steamId = str(ctx, "steamId");
    if (!steamId) return null;

    const mod = ctx.scan.mods.find((m) => m.steamId === steamId);
    const name = mod?.name ?? `item ${steamId}`;
    const manifest = workshopManifest(ctx.scan);
    const actions: FileAction[] = [];

    if (mod) {
      actions.push({
        op: "delete-matching",
        directory: mod.folder,
        pattern: "*",
        reason: `${name}: remove the copy on disk so Steam replaces it`,
      });
    }
    if (manifest) {
      actions.push({
        op: "forget-workshop-item",
        path: manifest,
        steamId,
        reason: `${name}: drop Steam's record of having downloaded it`,
      });
    }
    if (!actions.length) return null;

    return {
      kind: "files",
      actions,
      summary:
        `Removes ${name} and Steam's record of having downloaded it, leaving the subscription ` +
        "intact, so Steam fetches it again on its next check. Close Steam first: it holds this " +
        "record in memory and rewrites the file on exit, which would undo the change. Everything " +
        "is backed up, so undoing puts the current copy back.",
    };
  },

  "reset-mod-settings": (ctx) => {
    const dir = configDir(ctx.scan);
    const packageId = ctx.finding.packageIds[0];
    if (!dir || !packageId) return null;
    return {
      kind: "files",
      summary:
        "Deletes this mod's saved settings so it rebuilds them from defaults on the next launch. " +
        "Your colony is untouched; only that mod's own options are lost.",
      actions: [
        {
          op: "delete-matching",
          directory: dir,
          pattern: `Mod_${packageId}_*.xml`,
          reason: "Corrupt or unreadable mod settings",
        },
      ],
    };
  },

  "restore-mods-config": (ctx) => {
    const dir = configDir(ctx.scan);
    if (!dir) return null;
    return {
      kind: "files",
      summary:
        `Writes this pack's ${ctx.modpack.activeOrder.length} entries back into ModsConfig.xml, ` +
        "undoing the reset to Core only.",
      actions: [
        {
          op: "write",
          path: `${dir}/ModsConfig.xml`,
          contents: toModsConfigXml(ctx.modpack.activeOrder, ctx.scan.gameVersion),
          reason: "RimWorld reset the load order after a failed load",
        },
      ],
    };
  },

  "resubscribe-workshop-item": (ctx) => {
    const ids = list(ctx, "steamIds");
    return {
      kind: "external",
      summary:
        ids.length > 0
          ? `Unsubscribe and resubscribe to Workshop item ${ids.join(", ")}, then rescan.`
          : "Unsubscribe and resubscribe to the affected Workshop items, then rescan.",
      url: ids[0] ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${ids[0]}` : undefined,
    };
  },

  "cap-frame-rate": () => ({
    kind: "external",
    summary:
      "VSync is not throttling the render loop. Cap the frame rate outside the game (the driver " +
      "control panel, or a limiter) so the render thread stops taking headroom the simulation needs.",
  }),

  "force-dgpu": () => ({
    kind: "external",
    summary:
      "Force RimWorld onto the discrete GPU in Windows graphics settings and disable fullscreen " +
      "optimisations for the executable. Hybrid graphics is the usual cause of refresh-rate drift.",
  }),
};

/**
 * Every repair kind that exists. Exported so a self-check can catch a rule proposing a
 * fix nobody implemented, which otherwise renders as a button that can never do anything.
 */
export const REPAIR_KINDS: ReadonlySet<string> = new Set(Object.keys(REPAIRS));

/** Build the plan for a finding, or null when nothing can be carried out yet. */
export function planRepair(ctx: RepairContext): RepairPlan | null {
  const kind = ctx.finding.fix?.kind;
  if (!kind) return null;
  const repair = REPAIRS[kind];
  if (!repair) return null;
  try {
    return repair(ctx);
  } catch {
    // A repair that cannot describe itself must not take the findings list down with it.
    return null;
  }
}

/**
 * Findings whose repair is deterministic and applies to the pack alone. These are the
 * ones "Fix all" is allowed to touch: no disk writes, no judgement calls, fully undoable.
 */
export function autoPackRepairs(
  findings: Finding[],
  base: Omit<RepairContext, "finding">,
): { finding: Finding; plan: Extract<RepairPlan, { kind: "modpack" }> }[] {
  const out: { finding: Finding; plan: Extract<RepairPlan, { kind: "modpack" }> }[] = [];
  let modpack = base.modpack;

  for (const finding of findings) {
    if (!finding.fix?.auto) continue;
    const plan = planRepair({ ...base, modpack, finding });
    if (plan?.kind !== "modpack") continue;
    // Each repair is planned against the result of the previous one, so a batch cannot
    // apply two conflicting edits to the same load order.
    modpack = plan.modpack;
    out.push({ finding, plan });
  }
  return out;
}

/**
 * Render a file plan as a PowerShell script.
 *
 * The shell will carry these out directly once it exists. Until then this is how a repair
 * actually reaches disk, so it backs every file up before touching it and prints what it
 * did rather than working silently.
 */
export function toPowerShell(actions: FileAction[], configDir?: string | null): string {
  const lines = [
    "# Generated by RimDoc+. Review before running.",
    "#",
    "# Nothing is changed until the backup below has completed. Every file is also copied",
    "# to <name>.rimdocbak individually, so a single change can be reverted on its own.",
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "",
    "$RimDocBackup = Join-Path $env:USERPROFILE 'RimDoc-Backups'",
    "$Original = Join-Path $RimDocBackup 'original-version'",
    "",
    "function Backup-Once($path) {",
    '  $bak = "$path.rimdocbak"',
    "  if (-not (Test-Path $path)) { return }",
    "  if (Test-Path $bak) { return }",
    "  # Copy-Item on a directory without -Recurse creates an empty one, which would make",
    "  # removing a duplicate mod folder unrecoverable while looking backed up.",
    "  if (Test-Path $path -PathType Container) { Copy-Item $path $bak -Recurse -Force }",
    "  else { Copy-Item $path $bak -Force }",
    "}",
    "",
    "# The original version: taken once and never overwritten, so it keeps the install as",
    "# it was before RimDoc+ first touched it rather than as it was before this run.",
    "#",
    "# Completion is marked by a file written only once the copy has finished. Gating on the",
    "# folder alone would let a copy that failed halfway mark itself done for good, and the",
    "# one backup that can never be retaken is the one from before anything was touched.",
    "$OriginalDone = Join-Path $Original '.complete'",
    "if (-not (Test-Path $OriginalDone)) {",
    "  New-Item -ItemType Directory -Force -Path $Original | Out-Null",
  ];

  if (configDir) {
    lines.push(
      `  $cfg = ${ps(configDir)}`,
      "  if (Test-Path $cfg) {",
      "    Copy-Item $cfg (Join-Path $Original 'Config') -Recurse -Force",
      '    Write-Host "backed up config to $Original"',
      "  }",
    );
  }

  lines.push(
    "  Set-Content $OriginalDone (Get-Date -Format 'o') -Encoding UTF8",
    "} else {",
    '  Write-Host "original version already saved at $Original"',
    "}",
    "",
    "# A per-run copy of every file this script is about to change, so a run can be undone",
    "# as a unit without disturbing the original.",
    "$RunBackup = Join-Path $RimDocBackup ('run-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))",
    "New-Item -ItemType Directory -Force -Path $RunBackup | Out-Null",
    "",
    "function Save-ToRun($path) {",
    "  if (-not (Test-Path $path)) { return }",
    "  $name = (Split-Path $path -Leaf)",
    "  if (Test-Path $path -PathType Container) {",
    "    # Get-FileHash cannot hash a directory, so folders are keyed by name instead.",
    "    Copy-Item $path (Join-Path $RunBackup $name) -Recurse -Force",
    "    return",
    "  }",
    "  $dest = Join-Path $RunBackup ((Get-FileHash $path -Algorithm MD5).Hash + '-' + $name)",
    "  Copy-Item $path $dest -Force",
    "}",
    "",
  );

  for (const action of actions) {
    lines.push(`# ${action.reason}`);
    if (action.op === "add-supported-version") {
      lines.push(
        `$p = ${ps(action.path)}`,
        "if (Test-Path $p) {",
        "  Backup-Once $p",
        "  Save-ToRun $p",
        "  $xml = Get-Content $p -Raw",
        `  if ($xml -notmatch '<li>${action.cycle}</li>') {`,
        // String.Replace rather than -replace: no capture groups, so no backtick escapes
        // to get wrong, and the inserted newline comes from the platform.
        `    $ins = '<supportedVersions>' + [Environment]::NewLine + '    <li>${action.cycle}</li>'`,
        "    $xml = $xml.Replace('<supportedVersions>', $ins)",
        "    Set-Content $p $xml -Encoding UTF8",
        `    Write-Host "stamped ${action.cycle}: $p"`,
        "  }",
        '} else { Write-Host "missing: $p" }',
      );
    } else if (action.op === "write") {
      lines.push(
        `$p = ${ps(action.path)}`,
        "Backup-Once $p",
        "Save-ToRun $p",
        `Set-Content $p ${ps(action.contents)} -Encoding UTF8`,
        'Write-Host "wrote: $p"',
      );
    } else if (action.op === "downscale-png") {
      lines.push(
        `$p = ${ps(action.path)}`,
        "if (Test-Path $p) {",
        "  Backup-Once $p",
        "  Save-ToRun $p",
        "  $img = [System.Drawing.Image]::FromFile($p)",
        `  $max = ${action.maxPx}`,
        "  if ($img.Width -gt $max -or $img.Height -gt $max) {",
        "    $scale = [Math]::Min($max / $img.Width, $max / $img.Height)",
        "    $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)",
        "    $bmp = New-Object System.Drawing.Bitmap $w, $h",
        "    $g = [System.Drawing.Graphics]::FromImage($bmp)",
        "    $g.InterpolationMode = 'HighQualityBicubic'",
        "    $g.DrawImage($img, 0, 0, $w, $h)",
        "    $g.Dispose(); $img.Dispose()",
        "    $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)",
        "    $bmp.Dispose()",
        '    Write-Host "resized to $($w)x$($h): $p"',
        "  } else { $img.Dispose() }",
        "}",
      );
    } else if (action.op === "forget-workshop-item") {
      lines.push(
        `$m = ${ps(action.path)}`,
        `$id = ${ps(action.steamId)}`,
        "if (Get-Process steam -ErrorAction SilentlyContinue) {",
        '  Write-Host "Steam is running; close it or this edit is undone on exit: $m"',
        "} elseif (Test-Path $m) {",
        "  Backup-Once $m",
        "  Save-ToRun $m",
        "  $text = Get-Content $m -Raw",
        // Bounded to the installed list. The same id sits in the subscription list below,
        // and removing that one would unsubscribe rather than re-fetch.
        "  $from = $text.IndexOf('\"WorkshopItemsInstalled\"')",
        "  $to = $text.IndexOf('\"WorkshopItemDetails\"')",
        "  if ($to -lt 0) { $to = $text.Length }",
        '  $key = "`t`t""$id""`n"',
        "  $at = $text.IndexOf($key, $from)",
        "  if ($at -ge 0 -and $at -lt $to) {",
        '    $close = $text.IndexOf("`n`t`t}", $at) + 4',
        '    if ($close -lt $text.Length -and $text[$close] -eq "`n") { $close++ }',
        "    Set-Content $m ($text.Substring(0, $at) + $text.Substring($close)) -NoNewline -Encoding UTF8",
        '    Write-Host "Steam will fetch $id again"',
        '  } else { Write-Host "$id was not recorded as installed" }',
        "}",
      );
    } else if (action.pattern === "*") {
      // "*" means the folder itself, which is how a duplicate mod is removed. Emptying it
      // instead would leave each backup inside the folder being emptied, while the rollback
      // looks for <folder>.rimdocbak beside it, so the undo would find nothing to restore.
      lines.push(
        `$d = ${ps(action.directory)}`,
        "if (Test-Path $d) {",
        "  Backup-Once $d",
        "  Save-ToRun $d",
        "  Remove-Item $d -Recurse -Force",
        '  Write-Host "removed folder: $d"',
        '} else { Write-Host "already gone: $d" }',
      );
    } else {
      lines.push(
        `Get-ChildItem -Path ${ps(action.directory)} -Filter ${ps(action.pattern)} -ErrorAction SilentlyContinue |`,
        // Get-ChildItem streams, so without this a backup written by the first iteration can
        // be picked up by a later one and deleted as though it were an original.
        "  Where-Object { -not $_.Name.EndsWith('.rimdocbak') } |",
        '  ForEach-Object { Backup-Once $_.FullName; Remove-Item $_.FullName -Recurse -Force; Write-Host "removed: $($_.FullName)" }',
      );
    }
    lines.push("");
  }

  lines.push(
    'Write-Host ""',
    'Write-Host "Original version: $Original"',
    'Write-Host "This run backed up to: $RunBackup"',
    "Write-Host 'Done. Rescan in RimDoc+ to confirm.'",
    "Write-Host 'To undo this, run the rollback script from the same triage report.'",
  );
  return lines.join("\n");
}

/**
 * Decode, resize and re-encode cost, calibrated against two runs on a real install: the
 * twelve largest textures (2963 ms for ~200 megapixels) and a 30-file spread across the
 * whole set (1661 ms for 49.7 megapixels).
 *
 * The two costs add rather than one dominating: every file pays fixed open, decode-setup
 * and encode overhead, and then pays again per pixel. Modelling it as a floor instead
 * underestimated the spread run by 1.6x, because most textures are small enough that the
 * fixed cost is the larger half.
 */
const MS_PER_FILE = 30;
const MS_PER_MEGAPIXEL = 15;

/** Rough wall-clock for a file plan, so the console can say how long it will take. */
export function estimateDurationMs(actions: FileAction[]): number {
  return actions.reduce((total, action) => {
    if (action.op !== "downscale-png") return total + 10;
    return total + MS_PER_FILE + (action.fromPx / 1_000_000) * MS_PER_MEGAPIXEL;
  }, 0);
}

/** "3m 02s", "12s", "instant". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "instant";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Single-quoted PowerShell literal; the only escape inside one is a doubled quote. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Undo a repair run.
 *
 * Restores from the .rimdocbak copies the repair script leaves beside each file, which
 * is why the paths are listed explicitly rather than searched for: the script knows
 * exactly what it touched, so rollback does not have to walk a 253-mod install guessing.
 */
export function toRollbackPowerShell(actions: FileAction[]): string {
  const targets = [...new Set(actions.map((a) => ("path" in a ? a.path : a.directory)))];

  const lines = [
    "# Generated by RimDoc+. Undoes one repair run.",
    "#",
    "# Restores every file the repair script backed up, then removes the backup copy.",
    "# Safe to run twice: a path with no backup beside it is left alone.",
    "$ErrorActionPreference = 'Stop'",
    "$restored = 0",
    "$skipped = 0",
    "",
    "function Restore-One($path) {",
    '  $bak = "$path.rimdocbak"',
    "  if (-not (Test-Path $bak)) { $script:skipped++; return }",
    "  if (Test-Path $path) { Remove-Item $path -Recurse -Force }",
    "  Move-Item $bak $path -Force",
    "  $script:restored++",
    '  Write-Host "restored: $path"',
    "}",
    "",
  ];

  for (const target of targets) lines.push(`Restore-One ${ps(target)}`);

  lines.push(
    "",
    'Write-Host ""',
    'Write-Host "Restored $restored, skipped $skipped with no backup."',
    "Write-Host 'Rescan in RimDoc+ to confirm.'",
  );
  return lines.join("\n");
}
