<p align="center">
  <img src="assets/banner.svg" alt="RimDoc - diagnose, repair, supervise" />
</p>

**Diagnose, repair, and supervise a modded RimWorld install**

RimDoc is a desktop companion for large RimWorld mod lists. It reads your install, proves what will break before you press Play, supervises the game while it runs with a structured live log, and turns the wreckage of a crash into a ranked list of causes with repairs attached. Where a mod manager answers "what order do these load in", RimDoc answers "why is my colony throwing 40,000 red errors and which of my 253 mods did it".

Built as a Tauri v2 desktop app (Rust + React + TypeScript), with a .NET sidecar for assembly inspection. The parsing and diagnostic layers are pure TypeScript, so the whole rules engine runs headless under `vitest` against fixtures captured from a real install.

> **Design rule:** RimDoc never edits a mod in place. Every repair is either an overlay mod that loads after the target or a derived copy in the vault with a diff attached, so the original stays pristine and every change is one click from reverted. Fixes are distributed as recipes applied to your own copy, never as redistributed mod files.

---

## Features (Built)

### Install scan

- Walks the official `Data` folder, local `Mods`, and the Steam Workshop content folder
- Tolerant `About.xml` reader that survives the malformed files a strict XML parser rejects: stray ampersands, mid-file BOMs, unclosed tags, inconsistent casing
- Resolves each mod's own `packageId` correctly even when the file declares `<modDependencies>` above its own identity, which otherwise collapses every Harmony-dependent mod into one entry
- Detects compiled assemblies and XML patch folders, including payloads nested under a version folder such as `1.6/Assemblies`
- Cross-references `ModsConfig.xml` to mark active mods and their load position

### Doctor (L1 static analysis)

Nine independent rules, each provable without launching the game:

- **orphan-active**: enabled package ids with no folder on disk
- **duplicate-package-id**: the same id in two folders, where RimWorld silently picks one
- **dlc-after-mods**: official expansions loading behind third-party content, so mods patched defs that did not exist yet
- **bootstrap-position**: Prepatcher or Harmony loading after a mod that ships C#
- **missing-dependency** and **inactive-dependency**: separated, because one needs an install and the other needs a click
- **incompatible-pair**: both mods enabled where one declares the conflict
- **load-order-violation**: `loadAfter` and `loadBefore` constraints the current order breaks
- **version-mismatch**: mods not advertising the running game cycle, collapsed into one counted finding

Every finding carries a proposed repair tagged with its tier and whether it can be applied automatically.

### Session report (log intelligence)

- Filters Unity's fallback-handler noise, which is most of what makes a RimWorld log unreadable
- Clusters identical faults by fingerprint so 40,000 repeats of one NullReference become one row with a count
- Attributes each fault to a mod by matching stack-frame namespace roots and inline tokens against the scanned mod list
- Explains recognised conditions in plain language instead of echoing the raw line: ghost Workshop subscriptions, duplicate loads, settings-constructor failures, failed XML patches, unresolved cross-references, broken vsync, refresh-rate drift
- Scrapes the environment header: game build, Unity version, GPU, VRAM, driver
- Ranks startup phase costs, so a slow launch points at the phase responsible

### Mod browser

Load-order view across all installed mods, filterable by name or package id, tagged by source, whether the mod ships C#, whether it ships XML patches, and on-disk size.

## Tech Stack

| Layer               | Choice                                | Why                                                                                      |
| ------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Shell               | Tauri v2 (Rust)                       | Native filesystem access, process supervision, small binary                              |
| UI                  | React 19 + TypeScript + Vite          | Same stack as the rest of the toolkit                                                    |
| Analysis            | Pure TypeScript                       | Runs in the browser preview and headless under vitest, no Rust round trip to test a rule |
| Assembly inspection | .NET sidecar (Mono.Cecil)             | Harmony target resolution and IL rewriting need the real .NET metadata reader            |
| Telemetry           | Companion RimWorld mod (C# + Harmony) | The only way to get per-mod tick attribution from inside the running game                |

The split is deliberate: Rust does IO, hashing, and process control; TypeScript does parsing and rules; C# does anything that has to understand a .NET assembly.

## Prerequisites

- Node 20+ and pnpm
- Rust stable (for the desktop shell)
- .NET 8+ (for the assembly sidecar)
- A RimWorld install to point it at

## Getting Started

```bash
pnpm install
pnpm scan          # read the local install, write dev fixtures
pnpm dev           # browser preview at http://localhost:1420
pnpm test          # rules and parsers, headless
```

`pnpm scan` auto-detects common Steam install locations and the platform save-data folder. Pass a specific log with `pnpm scan --log path/to/Player.log`. The fixtures it writes to `src/dev-data/` are gitignored, since they describe one machine's install.

Without fixtures the UI renders an empty state telling you to run the scan, so a fresh clone starts cleanly.

## How the repair tiers work

Repairs are graded by how much machinery they need and how much can go wrong. See [docs/SPEC.md](docs/SPEC.md) for the full model.

| Tier | Scope                                                                                                 | Risk                                                           |
| ---- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | Metadata and load order: version stamps, ordering, enabling a dependency                              | Near zero, fully reversible                                    |
| 2    | XML patch repair: rewriting a stale xpath, quieting a failed operation, resolving a def collision     | Low, diffed before apply                                       |
| 3    | Missing content: stub defs for absent dependencies, texture path and casing fixes                     | Moderate, changes what loads                                   |
| 4    | Assembly level: neutralising a dead Harmony patch, retargeting an assembly reference, emitting a shim | High, never silent, always explained and reverted in one click |

## What's Not Yet Built

- The Tauri shell itself. The analysis engine, scanner, and UI are real; the desktop packaging is the next slice.
- **Mod vault**: content-addressed local store so Steam updates land as new versions instead of overwriting a working setup
- **Supervised launch**: child-process control, live structured log stream, crash and hang detection, case-file capture
- **Auto-bisect**: binary search across the mod list to isolate a minimal breaking set unattended
- **Repair engine**: Tiers 1 through 4 are specified and surfaced in the UI as disabled buttons, not yet applied
- **L2 and L3 testing**: headless boot check and scripted soak run with TPS attribution
- **A/B benchmarking**: same save, two profiles, measured locally
- **Fix registry**: shared, signed repair recipes keyed on package id, mod version, and game version, with mod-author consent and an upstream export path
- **Texture and def audits**: oversized texture detection with batch downscaling, unreachable def pruning

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

RimDoc is an unofficial community tool. It is not affiliated with or endorsed by Ludeon Studios.
