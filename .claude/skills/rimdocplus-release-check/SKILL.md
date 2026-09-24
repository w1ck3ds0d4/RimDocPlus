---
name: rimdocplus-release-check
description: Run the pre-tag checks and the release.ps1 dry run before cutting a RimDoc+ release, and walk the manual smoke test first. Use when Daniel says "release RimDoc+", "cut a RimDoc+ version", "is RimDoc+ ready to tag", or before pushing a v* tag on this repo.
---

# RimDoc+ release check

RimDoc+ ships from a `v*` tag (`.github/workflows/release.yml`), and cutting one
already broke once: commit `546ba82` added `scripts/release.ps1` as a pre-tag
check, `87b1c3f` then had to fix it because it reported "no finished run for this
commit yet" while a green CI run for that exact commit sat first in the list (a
`Select-Object -First 1` on a piped `ConvertFrom-Json` was throwing inside a
`try` and getting swallowed by the `catch`), and `a80366e` documented the one
path that actually works after the script was first handed over as a relative
path that only resolves from inside the repo. This skill locks in that corrected
path.

## 1. Walk the manual smoke test first

`docs/SMOKE-TEST.md` exists because nothing in CI drives the app against a real
modded install, and the bugs found there were sentences that had quietly stopped
being true, a shape no automated test catches. Work down it before anything else.
This needs Daniel at the keyboard against his own RimWorld install; report back
what it covers rather than skipping it.

## 2. Run the same checks CI and the release workflow run

```bash
pnpm verify                                              # tsc --noEmit, vitest run, prettier --check
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
```

Clippy is `-D warnings` in CI, so a warning here is a release blocker, not a note.

## 3. Dry-run the release script, with the full path

```powershell
& 'C:\Users\danie\Documents\Claude\Projects\Development and Research\RimDocPlus\scripts\release.ps1' -DryRun
```

Always the absolute path. `.\scripts\release.ps1` only resolves if the shell is
already inside the repo, which is the exact bug `a80366e` documents; the script
re-locates itself (`Split-Path -Parent $PSScriptRoot`) once it starts, so where it
is invoked from otherwise does not matter, but the invocation itself needs the
real path.

The dry run checks, and reports pass/fail on each:

- `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` all carry
  the same version.
- the branch is `main`, the tree is clean, and it is level with `origin/main`.
- the target tag (`v<version>`) does not already exist.
- CI has a `success` run for this exact commit SHA (checked via `gh run list
  --branch main --limit 10 --json headSha,conclusion,status`, indexed rather than
  piped into `Select-Object -First 1` so a thrown pipeline error can't be
  swallowed and misreported as "no run yet").

Never run this on Daniel's behalf without `-DryRun`: dropping it prompts to type
the tag and then pushes it, which starts a ~12-minute build and opens a draft
GitHub release. That step is his to take.

## 4. If the fixture matters to this change

The 253-mod install referenced throughout `docs/ARCHITECTURE.md`,
`docs/HOW-IT-WORKS.md`, and `README.md` (load performance, texture-pass timing,
mod-count-dependent bugs) is Daniel's real local RimWorld install, not a checked-in
fixture; `src/dev-data/` is gitignored and absent in a fresh clone. If the change
touches scan performance or mod-count-sensitive logic, ask him to run `pnpm scan`
against that install and compare, rather than assuming CI's fixture-free run
covers it.

## What proves it worked

- `pnpm verify`, the three `cargo` commands, and the release script's dry run all
  report all-green.
- `docs/SMOKE-TEST.md` has been walked, not skipped.
- The commit about to be tagged has a `success` CI run against its exact SHA
  (`gh run list --branch main --limit 10 --json headSha,conclusion,status`).

## Traps

- A relative `.\scripts\release.ps1` fails on the path before it says anything
  about the release itself. Always the absolute path (see step 3).
- "Main is green" is not the same check as "this commit is green": main moves
  between when CI ran and when someone goes to tag. The script checks the exact
  SHA being tagged, not the branch in general; do not substitute a green main for
  that.
- `gaps`-style non-zero exits do not apply here, but a caught-and-swallowed
  PowerShell pipeline error can silently report "no run yet" for a run that is
  actually sitting there green (`87b1c3f`); if the dry run reports that, check
  `gh run list --branch main --limit 10 --json headSha,conclusion,status` by hand
  before assuming CI has not finished.
- Never drop `-DryRun` yourself; tagging and pushing is Daniel's call to make and
  confirm interactively.
