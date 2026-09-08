# Contributing

Thanks for looking. This is a small project with strong opinions, and most of them are
written down so you do not have to guess at them.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. It is short, and it explains the one
rule everything else follows.

## Getting it running

```bash
pnpm install
pnpm dev          # the browser build, on a fixture
pnpm tauri:dev    # the desktop app, against your real install
```

You need Node 20+, pnpm 10, and for the desktop build a Rust toolchain (1.77 or newer) plus
the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

The browser build runs without a RimWorld install. It reads a fixture from `src/dev-data/`,
which is gitignored and absent in a fresh clone; without it the app starts with an empty
scan, which is a supported state and worth checking your change survives. Generate your own
with `pnpm scan` if you have RimWorld installed.

The Harmony check needs its probe built and staged. The app runs without it and says so
rather than reporting nothing found:

```bash
pnpm probe:build     # dotnet publish, trimmed and self contained
pnpm probe:stage     # copies it where Tauri expects a sidecar
pnpm probe:verify    # trimmed and untrimmed must report the same thing
```

## Before you open a pull request

```bash
pnpm verify                                              # types, tests, formatting
cargo test  --manifest-path src-tauri/Cargo.toml         # the shell
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt   --manifest-path src-tauri/Cargo.toml
```

CI runs all of it, the Rust half on Windows, and clippy is `-D warnings` there. The lint list
is clean today and the only way it stays clean is if letting it slip fails the build.

## What the tests are for

The analysis layer is pure, so its tests need no mocks, no filesystem and no browser. If you
find yourself wanting to stub something out, that is usually the code telling you a decision
has leaked into the IO layer or an IO call has leaked into the analysis.

Test the behaviour that was wrong, not the function that was changed. Most tests here are
named after the failure they prevent, which is why you will find
`a_refused_manifest_edit_cancels_its_own_folder_delete` rather than `test_delete_matching`.

## House style

**Comments explain why, not what.** This is the thing most likely to surprise you. The
codebase comments heavily, and they are long. A comment that restates the code earns nothing;
a comment that records the bug a line exists to prevent, or the alternative that was tried and
did not work, is worth more than the line it sits above. Several of the comments here name a
specific past failure. Please keep writing those.

If you delete a comment, make sure you are deleting a wrong one and not an inconvenient one.

**Prose is verbose; code is not.** Collapse a needless branch, drop a variable used once,
prefer a `find` to a loop. But never trade a readable block for a clever one-liner.

**No em dashes.** Anywhere: prose, comments, docs, UI copy, commit messages. Commas, periods
and parentheses do the job.

**UI copy is short.** A card gets a sentence. The reasoning goes in a tooltip, a comment or
the pull request body, not on the screen.

**Say what you do not know.** If an analysis cannot prove something, it must not claim it.
`settledSince` only marks a finding settled where the current scan is genuinely decisive, and
that restraint is the feature. The same goes for the docs: an honest "not built yet" beats an
optimistic present tense.

## Adding things

**A new rule** goes in `src/lib/analysis/`, is registered in the array in `rules.ts`, and
returns `Finding[]`. It must be a pure function of the scan. Add it to the table in
`docs/HOW-IT-WORKS.md` and the list in `README.md`, both of which have been wrong about the
rule count before.

**A new repair** goes in `src/lib/repair/repairs.ts` as an entry in the `REPAIRS` map. It
returns a `RepairPlan` and does nothing else. If it needs a new kind of write, add a variant
to `FileAction` and implement it in all three executors: the shell, the PowerShell renderer,
and the rollback. A repair that only one executor understands is a bug waiting to happen.

**A new Tauri command** is `#[tauri::command(async)]` unless you can show it is instantaneous.
A synchronous command runs on the thread that pumps the webview, so a slow one freezes the
window and an `emit` from inside one deadlocks. That has happened here, and it cost a day.

Anything that writes must back up first, through `backup_once`.

## Commits

Subject lines are `(type) what changed, in lower case`, where type is `feat`, `fix`, `docs`,
`refactor`, `test` or `chore`. Write the body for someone reading `git log` in a year: what
was wrong, what you changed, and how you know it works.

No AI attribution trailers.

## Releasing

Work down [docs/SMOKE-TEST.md](docs/SMOKE-TEST.md) first. Nothing in CI uses the app against
a real modded install, and the two defects a person found in it were both sentences that had
quietly stopped being true, which is a shape no test catches.

Then, from anywhere:

```powershell
& 'C:\path\to\RimDocPlus\scripts\release.ps1' -DryRun
```

The full path matters. `.\scripts\release.ps1` only resolves if the prompt is already inside
the repo, and a PowerShell window usually opens somewhere else. The script re-locates itself
once it starts, so where it runs from does not otherwise matter, but starting it needs the
real path.

It refuses unless the version agrees across `package.json`, `tauri.conf.json` and
`Cargo.toml`, the tree is clean and level with origin, the tag is free, and CI passed on the
exact commit being tagged. Drop `-DryRun` to cut it, and it asks you to type the tag first.

The tag opens a **draft** release with the installer attached. Nothing is public until you
publish it.

## Reporting a bug

The Settings tab has a developer mode with a diagnostics panel, and `rimdoc-diagnostics.json`
from there says more than a description will. If it is about a specific install, the Session
tab can share a redacted log.

If the bug is that a repair did the wrong thing to your game, say so first and loudly. That is
the only category of bug in this project that really matters.
