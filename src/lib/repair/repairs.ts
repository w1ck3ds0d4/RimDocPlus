import type { Finding, ScanResult } from "../types";
import { sortLoadOrder, toggleMod, toModsConfigXml, type Profile } from "../profiles.ts";

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
  | { op: "downscale-png"; path: string; maxPx: number; fromPx: number; reason: string };

export interface RepairChoice {
  label: string;
  detail?: string;
  plan: () => RepairPlan;
}

/**
 * What carrying out a repair actually involves. The split matters: a pack repair is
 * app state and applies instantly, a file repair needs the shell or a script, and an
 * external repair is something only the player can do.
 */
export type RepairPlan =
  | { kind: "pack"; profile: Profile; summary: string }
  | { kind: "files"; actions: FileAction[]; summary: string }
  | { kind: "external"; summary: string; url?: string }
  | { kind: "choice"; summary: string; choices: RepairChoice[] };

export interface RepairContext {
  scan: ScanResult;
  profile: Profile;
  finding: Finding;
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

/** Config folder holding ModsConfig.xml and per-mod settings files. */
function configDir(scan: ScanResult): string | null {
  return scan.paths.saveData ? `${scan.paths.saveData}/Config` : null;
}

/**
 * Ordering repairs all reduce to the same well-tested primitive. The sort is stable, so
 * fixing one violation moves only what the constraints actually require and the diff
 * stays reviewable rather than reshuffling 224 entries.
 */
const applySort: RepairFn = ({ profile, scan }) => {
  const activeOrder = sortLoadOrder(profile.activeOrder, scan.mods);
  const moved = activeOrder.filter((id, i) => profile.activeOrder[i] !== id).length;
  if (!moved) return null;
  return {
    kind: "pack",
    profile: { ...profile, activeOrder, updatedAt: profile.updatedAt },
    summary: `Reorders ${moved} of ${activeOrder.length} entries to satisfy the declared constraints.`,
  };
};

const REPAIRS: Record<string, RepairFn> = {
  "remove-orphan-entries": (ctx) => {
    const ids = new Set(list(ctx, "ids"));
    if (!ids.size) return null;
    return {
      kind: "pack",
      profile: {
        ...ctx.profile,
        activeOrder: ctx.profile.activeOrder.filter((id) => !ids.has(id)),
      },
      summary: `Drops ${ids.size} entry(s) that no folder provides. Nothing on disk changes.`,
    };
  },

  "hoist-official-content": applySort,
  "hoist-bootstrap": applySort,
  reorder: applySort,

  "enable-dependency": (ctx) => {
    const dependency = str(ctx, "dependency");
    if (!dependency || ctx.profile.activeOrder.includes(dependency)) return null;
    const profile = toggleMod(ctx.profile, dependency, ctx.scan.mods);
    const name = modsById(ctx.scan).get(dependency)?.name ?? dependency;
    return {
      kind: "pack",
      profile,
      summary: `Enables ${name} at position ${profile.activeOrder.indexOf(dependency)}, ahead of what needs it.`,
    };
  },

  "disable-one-of": (ctx) => {
    const candidates = list(ctx, "candidates");
    if (candidates.length < 2) return null;
    const byId = modsById(ctx.scan);
    return {
      kind: "choice",
      summary: "These two declare they cannot coexist. Only you can decide which to keep.",
      choices: candidates.map((id) => ({
        label: `Disable ${byId.get(id)?.name ?? id}`,
        detail: id,
        plan: (): RepairPlan => ({
          kind: "pack",
          profile: {
            ...ctx.profile,
            activeOrder: ctx.profile.activeOrder.filter((other) => other !== id),
          },
          summary: `Removes ${id} from the pack.`,
        }),
      })),
    };
  },

  "pick-duplicate-winner": (ctx) => {
    const folders = list(ctx, "folders");
    const packageId = str(ctx, "packageId");
    if (folders.length < 2 || !packageId) return null;
    return {
      kind: "choice",
      summary:
        "Two folders provide this mod and RimWorld silently picks one. Keep the copy you want and " +
        "remove the other. A Workshop copy comes back on the next Steam sync, so a local copy is " +
        "usually the one to keep.",
      choices: folders.map((keep) => ({
        label: `Keep ${keep.split(/[\\/]/).pop()}`,
        detail: keep,
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
    const target = Number(str(ctx, "target") ?? 512);
    const byId = modsById(ctx.scan);
    const actions = list(ctx, "ids")
      .map((id) => byId.get(id))
      .filter((mod): mod is NonNullable<typeof mod> => !!mod)
      .flatMap((mod) =>
        (mod.textures?.oversized ?? []).map((texture) => ({
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
      for (const t of byId.get(id)?.textures?.oversized ?? []) {
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
        `Writes this pack's ${ctx.profile.activeOrder.length} entries back into ModsConfig.xml, ` +
        "undoing the reset to Core only.",
      actions: [
        {
          op: "write",
          path: `${dir}/ModsConfig.xml`,
          contents: toModsConfigXml(ctx.profile.activeOrder, ctx.scan.gameVersion),
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
): { finding: Finding; plan: Extract<RepairPlan, { kind: "pack" }> }[] {
  const out: { finding: Finding; plan: Extract<RepairPlan, { kind: "pack" }> }[] = [];
  let profile = base.profile;

  for (const finding of findings) {
    if (!finding.fix?.auto) continue;
    const plan = planRepair({ ...base, profile, finding });
    if (plan?.kind !== "pack") continue;
    // Each repair is planned against the result of the previous one, so a batch cannot
    // apply two conflicting edits to the same load order.
    profile = plan.profile;
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
export function toPowerShell(actions: FileAction[]): string {
  const lines = [
    "# Generated by RimDoc+. Review before running.",
    "# Every file is copied to <name>.rimdocbak before it is changed.",
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "",
    "function Backup-Once($path) {",
    '  $bak = "$path.rimdocbak"',
    "  if ((Test-Path $path) -and -not (Test-Path $bak)) { Copy-Item $path $bak }",
    "}",
    "",
  ];

  for (const action of actions) {
    lines.push(`# ${action.reason}`);
    if (action.op === "add-supported-version") {
      lines.push(
        `$p = ${ps(action.path)}`,
        "if (Test-Path $p) {",
        "  Backup-Once $p",
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
        `Set-Content $p ${ps(action.contents)} -Encoding UTF8`,
        'Write-Host "wrote: $p"',
      );
    } else if (action.op === "downscale-png") {
      lines.push(
        `$p = ${ps(action.path)}`,
        "if (Test-Path $p) {",
        "  Backup-Once $p",
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
    } else {
      lines.push(
        `Get-ChildItem -Path ${ps(action.directory)} -Filter ${ps(action.pattern)} -ErrorAction SilentlyContinue |`,
        '  ForEach-Object { Backup-Once $_.FullName; Remove-Item $_.FullName -Recurse -Force; Write-Host "removed: $($_.FullName)" }',
      );
    }
    lines.push("");
  }

  lines.push("Write-Host 'Done. Rescan in RimDoc+ to confirm.'");
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
