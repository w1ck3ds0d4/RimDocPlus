# Architecture

How RimDoc+ is put together, and why. [HOW-IT-WORKS.md](HOW-IT-WORKS.md) covers what each
individual analysis does; this covers the shape they all sit in.

## The one idea

**Nothing that decides is allowed to touch the disk, and nothing that touches the disk is
allowed to decide.**

Every judgement RimDoc+ makes, from "these two mods ship the same packageId" to "here is the
seven-step plan that fixes it", is a pure function of data that was read earlier. Reading and
writing happen somewhere else entirely, behind a command boundary, in a layer that contains no
opinions at all.

That split is not tidiness. This app deletes folders inside somebody's game install. The
reason it can be trusted to is that the part choosing what to delete can be run a thousand
times in a test with no disk anywhere near it, and the part doing the deleting is small enough
to read in one sitting.

## The three layers

```
                       ┌───────────────────────────────┐
   React UI            │  src/components/*.tsx         │   renders, asks, never decides
                       └───────────────┬───────────────┘
                                       │  plain data both ways
                       ┌───────────────┴───────────────┐
   Pure analysis       │  src/lib/analysis/            │   scan  -> findings
   (no IO at all)      │  src/lib/repair/              │   finding -> plan
                       └───────────────┬───────────────┘
                                       │  FileAction[], a plan is data
                       ┌───────────────┴───────────────┐
   IO shell            │  src-tauri/src/               │   carries plans out
                       └───────────────────────────────┘
```

### Pure analysis: `src/lib/`

TypeScript, no `fetch`, no `fs`, no Tauri import. Every module here takes data and returns
data. `runStaticRules(scan)` returns findings. `analyzeLog(text)` returns events.
`planRepair(context)` returns a plan or null. `runTriage(findings, context)` sorts findings
into buckets.

This is why the test suite is 242 tests that run in milliseconds under node with no
filesystem and no browser: there is nothing to mock, because there is nothing to stub out.

The only concession is `localStorage`, which several modules read and write for state that
must survive a restart (modpacks, run history, the install baseline). Every one of those
accesses is wrapped in try/catch that returns a safe default, because a private window or a
blocked store must degrade rather than take a tab down with it.

### IO shell: `src-tauri/src/`

Rust. Four files:

| File       | Responsibility                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan.rs`  | Walk the install and report what is on disk. ~1,650 lines, the largest single thing here, because reading an About.xml correctly is most of the work. |
| `vault.rs` | A content-addressed store of mod folders, so a build that worked can be put back after Steam replaces it.                                             |
| `lib.rs`   | Everything else: the command surface, the repair executor, backups, process control, the Steam client.                                                |
| `files.rs` | The two filesystem helpers the others share: finding the home directory, and copying a tree with a filter.                                            |

The shell has no idea what a duplicate mod is, what a Harmony patch is, or which of two
copies is better. It is handed a list of actions and it carries them out.

### React UI: `src/components/`

Renders what the analysis produced and collects the decisions it could not make on its own.
Components hold view state (which tab, which panel is open, is a run in flight). They do not
hold conclusions: those come from `src/lib/` on every render, derived rather than stored, so
there is no second copy to go stale.

## Repairs are plans, not actions

The most load-bearing decision in the codebase.

A repair never does anything. It **returns a description** of what would be done:

```ts
type RepairPlan =
  | { kind: "modpack"; modpack: Modpack; summary: string } // change the load order
  | { kind: "files"; actions: FileAction[]; summary: string } // change the disk
  | { kind: "external"; summary: string; url?: string } // only you can do this
  | { kind: "choice"; summary: string; choices: RepairChoice[] }; // needs a decision first
```

A `FileAction` is one of five verbs, and the list is deliberately short:

| Op                      | What it does                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `write`                 | Replace a file's contents.                                                                    |
| `add-supported-version` | Stamp a game cycle into an About.xml.                                                         |
| `delete-matching`       | Remove files matching a glob in a directory, or the directory itself when the pattern is `*`. |
| `downscale-png`         | Resize a texture in place, preserving aspect ratio.                                           |
| `forget-workshop-item`  | Drop one item from Steam's record of what it has downloaded, leaving the subscription intact. |

Because a plan is data, it has **three independent executors**, and they must agree:

1. **The desktop shell.** `run_file_actions` in `lib.rs` interprets the actions directly.
2. **A PowerShell script.** `toPowerShell(actions)` renders the same plan as a script you can
   read before running. This is the browser build's only route to disk, and it is also the
   answer to "what is this actually going to do to my game".
3. **A rollback.** `toRollbackPowerShell` and the `rollback` command both work from the same
   list of touched paths.

That the same plan drives all three is what makes the preview honest. If the script and the
shell ever disagree, one of them is a bug, and they have disagreed before: an early
`delete-matching "*"` emptied a folder in the script but removed it in the shell, so a
rollback restored an empty directory and reported success.

## How data flows through one session

```
  scan_install ──────────► ScanResult ──┬──► runStaticRules ──► Finding[]
  (Rust, walks the disk)                │                          │
                                        │                          │
  read_session_log ──► Player.log ──────┴──► analyzeLog ──► LogEvent[]
                                                   │              │
                                                   └──► findingsFromLog ──► Finding[]
                                                                    │
                             ┌──────────────────────────────────────┘
                             ▼
                        runTriage  ──► every finding into exactly one bucket
                             │
                             ├─ applied to the modpack   (done, in memory)
                             ├─ decided automatically    (done, with reasoning shown)
                             ├─ needs your decision      (a choice, not yet planned)
                             ├─ changes to your files    (FileAction[], not yet run)
                             ├─ needs you                (external: Steam, drivers, Windows)
                             ├─ no repair yet            (a fix is proposed, none implemented)
                             └─ informational            (notes, and settled findings)
```

Every finding lands in exactly one bucket. That invariant is enforced by the code and it
matters: an earlier version collapsed "a finding proposing no fix" and "a finding proposing a
fix nothing implements" into one bucket, and the summary silently described three of fifteen
findings while reporting fifteen.

### Findings from the log are about the past

A static finding describes the install as it is right now. A log finding describes a run that
has already finished, and **repairing the files cannot change what the log says happened**.

So `settledSince` asks the current scan whether a logged fault has already been dealt with,
and only where the scan is genuinely decisive:

- a duplicate packageId, when exactly one copy is now installed
- a ghost subscription, when a mod carrying that Workshop id is now on disk
- a mod-list reset, when the load order holds mods again

Anything else stays outstanding, because most faults leave no trace on disk and silence is not
proof. Without this, a repaired finding came back on every triage and read as the repair
having done nothing at all.

## Two scanners, on purpose

`scripts/scan.mjs` (Node) and `src-tauri/src/scan.rs` (Rust) implement the same scan twice.

This is not duplication waiting to be removed. It is a cross-check: both were run over the
same 253-mod install and their outputs diffed field by field until they matched exactly.
That exercise found real bugs in each of them, including a millisecond-precision mtime
difference that made 117 mods look like they had been updated when nothing had changed.

The Node one also gives the browser build a fixture to work from and gives CI something to run
that needs no Windows and no Steam.

## Safety model

Four rules, and every write in the codebase obeys all four.

**1. Back up before touching.** `backup_once` copies a path to `<path>.rimdocbak` before the
first change to it. It never retakes a backup: the copy that matters is the one from before
anything happened, and retaking it on a second run would overwrite the good copy with a
half-repaired one.

**2. Back up the whole Config folder once per run.** Before any action, `save_original` copies
the game's Config directory to `~/RimDoc-Backups/original-version`, guarded by a `.complete`
marker so an interrupted copy is not mistaken for a finished one.

**3. One failing action does not stop the run.** A texture pass is 730 actions and the
seven-hundredth failing must not abandon the other 729. The report carries per-action
outcomes, so a partial run is legible rather than mysterious.

**4. Except where two actions are one repair.** Rule 3 has exactly one exception, and it is
carved out explicitly. The Workshop retry pairs an edit to Steam's download record with
deleting the mod folder. Carrying out only the second leaves the mod gone and Steam still
believing it has it, which is worse than doing nothing: gone, and never re-fetched. So
`paired_with_refused` skips a folder delete whose manifest edit was refused, matching the
folder name to the Workshop id.

The same pairing is enforced a second time, earlier, in the UI: `splitBySteam` partitions a
plan into what can run while Steam is up and what cannot, holding back **whole repairs**
rather than individual actions. That way a Steam-blocked repair no longer refuses an entire
run that also contained unrelated work.

## The command surface

Twenty-one commands, and that is the whole of what the app can do to a machine. Anything not on
this list, it cannot do.

**Writes to disk** (five, and only these):

| Command                                            | Touches                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `run_file_actions`                                 | Carries out a `FileAction[]`. Backs up first. The only general-purpose write. |
| `apply_mods_config`                                | Writes the game's ModsConfig.xml.                                             |
| `rollback`                                         | Restores `.rimdocbak` copies beside the paths a run touched.                  |
| `vault_capture` / `vault_restore` / `vault_forget` | The vault under `~/RimDoc-Vault`.                                             |

**Reads only:** `scan_install`, `read_session_log`, `list_saves`, `read_mod_preview`,
`hash_mod`, `vault_list`, `is_steam_running`, `is_game_running`.

**Reaches the network:** `fetch_shared_log`, and only when a gist link has been pasted and
the button pressed. Two hosts, matched on the whole host segment, https only. It exists
because RimWorld's Share logs uploads to a gist and leaves nothing on disk to read instead.
See [SECURITY-MODEL.md](SECURITY-MODEL.md#network).

**Runs the patch probe:** `probe_patches`. A bundled .NET program that reads mod assemblies
and reports whether each Harmony patch still has something to patch. It reads metadata and
never loads an assembly, so no mod code executes. See [the sidecar](../sidecar/README.md).

**Process control:** `launch_game`, `launch_supervised`, `stop_game` (only ever the process
this app started, by stored pid, never by image name), `stop_steam`, `start_steam`.

Nineteen of the twenty-one are `#[tauri::command(async)]`. That is not decoration. A synchronous
Tauri command runs on the thread that pumps the WebView2 message loop, so a long one freezes
the window and an `emit` from inside it deadlocks outright. That happened: a repair run of 476
texture resizes hung on the very first progress event with the process at zero CPU. Any
command that can take more than a moment, or that emits an event, must be `async`.

`read_mod_preview` is worth singling out. It is the only command that returns file contents to
the webview, and it will only return a file named like a mod banner from inside a known mod
folder. It is allowlist-based rather than sanitised, because a sanitiser is a thing you can be
wrong about.

## Module map

### `src/lib/analysis/` - reading and judging, no IO

| Module           | Responsibility                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `about.ts`       | Normalising an About.xml into a `ModEntry`, and the official/bootstrap package id lists. |
| `rules.ts`       | The static rules. Scan in, findings out.                                                 |
| `logParser.ts`   | Player.log into events, events into findings, and `settledSince`.                        |
| `patches.ts`     | PatchOperation targets, and which mods overwrite each other's.                           |
| `duplicates.ts`  | Same packageId in two folders, and which copy to prefer.                                 |
| `performance.ts` | Texture footprint and the oversize threshold.                                            |
| `packaging.ts`   | Assemblies shipped by more than one mod, and Workshop staleness.                         |
| `xml.ts`         | The tolerant XML reader everything else uses.                                            |

### `src/lib/repair/` - findings into plans, no IO

| Module       | Responsibility                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `repairs.ts` | One planner per repair kind (fifteen of them), the `FileAction` union, and the PowerShell renderers. |
| `triage.ts`  | Sorting every finding into exactly one bucket, and `splitBySteam`.                                   |

### `src/lib/` - state, formatting, and the shell boundary

`shell.ts` is the single place the frontend talks to Tauri; it imports the Tauri API lazily so
a browser build never pulls it into the bundle. `types.ts` is shared shape.
`modpacks.ts`, `pins.ts`, `history.ts`, `installDiff.ts`, `benchmark.ts`, `bisect.ts` and
`reset.ts` own the persisted state. `format.ts` is the single place a byte count, a duration
or a percentage is turned into text, so the same number cannot be written two ways. `bootCheck.ts` classifies whether a run reached the main
menu. `saves.ts`, `library.ts`, `releases.ts`, `shareLog.ts`, `diagnostics.ts`, `download.ts`,
`preview.ts`, `devLog.ts`, `devData.ts` and `selfCheck.ts` are supporting.

### `src/components/` - React

One component per tab, plus `Triage.tsx` (the largest, since it renders every bucket and owns
the apply/rollback flow), `RepairConsole.tsx` (the live transcript), `Confirm.tsx` (a promise
returning dialog, so callers read as `if (await confirm(...))`), and `TabIcon.tsx`/`Logo.tsx`
(inline SVG, because a tab strip should never wait on a network request).

## The browser build

The app runs without the shell, with less capability. `inShell()` gates that, and it gates
**capability**, not a second version of the app: the scan comes from a fixture instead of the
disk, and a plan is downloaded as a script instead of being carried out. The analysis, the
plans and the triage are byte-for-byte identical either way.

This is not a demo mode. It is the reason the analysis layer stays honest, because anything
that quietly needed the disk would fail loudly in the browser build.
