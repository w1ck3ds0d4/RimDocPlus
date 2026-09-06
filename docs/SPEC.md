# RimDoc+ specification

Working spec for the product. Sections marked BUILT exist in the repo today; everything
else is design intent and can still change.

## 1. Problem

RimWorld mod lists routinely pass 200 entries. At that size the failure modes are not
"which order do these load in", which existing managers solve well. They are:

1. A Workshop update lands silently and breaks a colony that worked yesterday. The
   community workaround is copying mods into `/Mods` by hand to pin them.
2. The error log names a stack frame, not a mod. Finding the culprit means disabling
   mods one at a time for hours.
3. Removing a mod corrupts a save that referenced its content.
4. XML overwrites, xpath patches, and Harmony C# patches resolve in different orders, so
   a "correct" load order still loses.
5. Late-colony TPS collapse with no attribution of which mod is responsible.
6. A mod targeting an older cycle loads fine and dies three hours later.

RimDoc+ targets 1, 2, 3, 5, and 6. Load-order sorting is table stakes and is treated as
a supporting feature, not the product.

## 2. Architecture

```
Tauri shell (React + TypeScript)
  |
  +-- Rust core        filesystem walk, content hashing, vault, process supervision,
  |                    log tailing, launch flags
  +-- C# sidecar       Mono.Cecil assembly inspection, Harmony target resolution,
  |                    IL neutralisation and shim emission
  +-- Companion mod    in-game Harmony mod streaming tick attribution and exceptions
                       back to the app over a local socket
```

Parsing and rules live in TypeScript rather than Rust. They are pure functions over
strings, which means the entire diagnostic engine is testable headless and runs
unchanged in a browser preview against captured fixtures. Rust supplies bytes; it does
not interpret them.

## 3. The vault

Content-addressed store under the app data directory. Every mod version ever seen is
retained and deduplicated by content hash.

- The game loads from the vault, never from the Workshop folder directly
- A Steam update is ingested as a new version rather than replacing the previous one
- Snapshots hardlink into the store, so a 300-mod profile does not cost 30 GB per snapshot
- Provenance recorded per entry: `official`, `steam`, `local`, `derived`

A **profile** is a named, immutable snapshot: mod versions, load order, mod config XMLs,
DLC set, game build, and the hash of the save it belongs to. Rollback is restoring a
profile, which is cheap because the content is already on disk.

### Packs (BUILT, partially)

A **pack** is the profile's editable half, and it exists today: a named list of package
ids in load order, with enable/disable, reordering, a stable topological auto-sort, drift
against the game's current setup, and export to `ModsConfig.xml`.

Two things separate a pack from a full profile, and both wait on the vault:

- A pack records ids, not mod versions, so it is repeatable but not reproducible. Two
  people running the same pack can be running different builds of the same mod.
- Applying a pack means exporting the file by hand. Writing it into the save-data folder
  and launching the game is the shell's job.

The doctor runs against the pack being edited rather than the game's own load order, so
findings update as mods are toggled. That turns rule output into a live constraint solver
the player edits against, instead of a report they read once.

## 4. Diagnostics

### L1 static (BUILT)

Runs in well under a second, launches nothing. Rules are independent functions returning
zero or more findings. Current rules: `orphan-active`, `duplicate-package-id`,
`dlc-after-mods`, `bootstrap-position`, `missing-dependency`, `inactive-dependency`,
`incompatible-pair`, `load-order-violation`, `version-mismatch`.

Planned additions:

- XML patch simulation: run every `PatchOperation` against the merged def database and
  report which xpaths will miss, without launching the game
- Harmony target resolution via the sidecar: report patches whose target method no longer
  exists in the running game version
- Two mods patching the same method, with prefix and postfix collision detection
- Dangling def and texture references

### L2 headless boot

Launch the game with `-quicktest` and a redirected log, stream and classify errors as
they arrive, terminate on the loaded marker or a timeout. Reports boot time, per-mod
error attribution, def count, and the patch failure list. Roughly one to three minutes.

The exact launch flag set is verified during implementation rather than assumed.

### L3 soak

Companion mod runs a scripted scenario for N ticks, reports the TPS curve and any
exceptions, then exits. This is what certifies a mod pack and what produces per-mod tick
attribution.

### Auto-bisect

On an L2 failure, binary-search the active list to isolate the minimal breaking set.
Roughly nine boot cycles for a 340-mod list, unattended. This replaces the manual
disable-one-at-a-time ritual, which is the most tedious thing in RimWorld modding.

## 5. Log intelligence (BUILT)

Pipeline: filter noise, cluster by fingerprint, attribute to a mod, explain, rank.

- **Noise filter** removes Unity's fallback-handler probes and similar per-launch spam
- **Fingerprint** is category plus the message with numbers normalised out plus the top
  three stack frames, so the same fault from the same place collapses to one row
  regardless of ids, coordinates, or tick counts
- **Attribution** matches namespace roots from stack frames, and tokens in the message
  itself, against an index built from mod names and package ids
- **Explanations** are keyed on recognised categories and say what the condition means
  and what to do, rather than repeating the raw line

### Session capture (planned)

On any abnormal exit, bundle a case file: full log, mod list with versions, profile hash,
save file, system specs, GPU driver, and any Unity crash dump. Crash detection uses three
signals, because RimWorld freezes more often than it hard-crashes: exit code, absence of a
clean-shutdown marker, and the dump folder. A hang detector covers no-log-output plus an
unresponsive window.

Same crash fingerprint three times in a row offers a safe-mode launch with the suspect
disabled.

## 6. Repair engine

Tier 1 is BUILT. A repair produces a _plan_ rather than performing an edit, and the plan
is always shown before it can be run. Plans come in four shapes, split by what the repair
has to touch: `pack` (app state, instant, undoable), `choice` (needs a human decision),
`files` (a list of paths plus a script that backs each one up), and `external` (only the
player can do it). The same plan is what the shell will execute directly once it exists,
so nothing about the repair layer changes when the shell lands, only its executor.

Every repair is graded by tier. Nothing above Tier 1 is ever silent.

**Tier 1, metadata.** Stamp a missing `supportedVersions` entry, fix a malformed
`packageId`, add a missing `loadAfter` hint, enable an installed dependency, reorder the
load list, drop an orphan entry. Deterministic and fully reversible. The version stamp
alone covers a large share of "the mod is red in my list" reports.

**Tier 2, XML patch repair.** Rewrite a stale xpath against the merged def database,
quiet a failed operation so a miss degrades instead of spamming, resolve a duplicate
defName collision by generating an override, fix path casing (which breaks on Linux and
not on Windows).

**Tier 3, missing content.** Generate a stub def so an absent dependency produces a gap
rather than a load failure. Repair broken texture and sound references.

**Tier 4, assembly level.** Via the sidecar: neutralise a dead Harmony patch by stripping
the patch class from a derived copy of the DLL, retarget an assembly reference built
against an older Harmony or HugsLib, or emit a shim assembly whose finalizer swallows a
known-bad patch's exception so the mod degrades instead of crashing.

### Safety model

- The original mod folder is never modified. A repair is an overlay mod that loads after
  the target, or a derived copy in the vault with a full diff attached.
- Every profile records which repairs are active. Revert is one click.
- Tier 4 always explains, then proposes, then applies. Never silent.
- On mod update, previously active repairs are re-applied if they still apply cleanly and
  flagged loudly if they do not.

### Fix registry (planned)

Repairs are shareable as **recipes**, not as mod files: a signed patch keyed on
`packageId + modVersion + gameVersion`, applied locally to the user's own copy. RimDoc+
never hosts modified mod files, which keeps redistribution off the table entirely.

Every recipe can be exported as a diff addressed to the mod author, and authors can opt
out. Repairs should flow upstream, not fragment the ecosystem into private forks.

## 7. Performance

FPS and TPS are separate numbers and are always reported separately. FPS is the render
loop; TPS is the single-threaded simulation, and a dying late colony is a TPS problem.

Measurement, via the companion mod: per-mod and per-def tick cost attributed by assembly,
GC pause frequency, and the classic hot paths (pathfinding, region and room recalculation,
job-giver scans).

Levers, roughly in order of payoff:

1. Texture pipeline: find oversized textures, batch-downscale into a derived mod
2. Def pruning: strip content unreachable in this configuration
3. Performance mod stack advisor, including conflicts between performance mods
4. Autosave interval tuning, a large and widely ignored stutter source
5. Visual sink audit, quantifying what weather, filth, and particle effects cost
6. Save-aware diagnosis: map size and colony wealth are often the real bottleneck, not mods
7. OS-level launch flags: process priority, CPU affinity pinned to performance cores,
   forcing the discrete GPU on laptops, disabling fullscreen optimisations
8. Hardware-aware profiles from measured peak memory

**A/B benchmarking** is the one that matters: run the same save under two profiles with
the L3 harness and compare. It makes every recommendation measured on the user's machine
rather than folklore.

## 8. Automation

- Nightly maintenance: check updates, run L1 against the new set, stay silent when healthy
- Update quarantine: new versions land inactive until they pass; green adopts, red holds
- Auto-snapshot before every mod change, every game update, and every N colony days
- Save ladder: last 5 hourly, last 7 daily, one per quadrum
- Live watchdog: alert when exceptions start spamming mid-session, before a bad save writes
- Profile health score with an auto-changelog of what changed since last session
- Headless daemon and CLI, so multiplayer hosts can gate joins on a profile hash

## 9. Non-goals

- Hosting or redistributing mod files
- Replacing the Steam Workshop as a distribution channel
- Competing on load-order sorting alone
- Anything that modifies a mod folder in place
