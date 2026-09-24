# RimDoc+

Diagnose, repair and supervise a modded RimWorld install. Tauri v2 (Rust + React + TypeScript)
desktop app with a .NET sidecar (PatchProbe) for assembly inspection. The analysis and repair
layers are pure TypeScript, so the rules engine runs headless under vitest against fixtures.
Public, AGPL-3.0-or-later, with a commercial license offered (see COMMERCIAL.md).

## Commands

```bash
pnpm install
pnpm dev              # vite dev server, against a fixture in src/dev-data/
pnpm tauri:dev        # the desktop app, against a real install
pnpm build            # tsc && vite build
pnpm test             # vitest run
pnpm verify           # tsc --noEmit && vitest run && prettier --check .
pnpm format           # prettier --write .
pnpm format:check     # prettier --check .
pnpm scan             # node scripts/scan.mjs (reference scanner)
pnpm workshop         # refresh the Workshop metadata cache
```

Rust shell (`src-tauri/`):

```bash
cargo test    --manifest-path src-tauri/Cargo.toml
cargo clippy  --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt     --manifest-path src-tauri/Cargo.toml
```

Patch probe (.NET sidecar, needed for the Harmony check):

```bash
pnpm probe:build   # dotnet publish, trimmed and self-contained
pnpm probe:stage   # copies it where Tauri expects a sidecar
pnpm probe:verify  # trimmed and untrimmed must report the same thing
```

CI (`.github/workflows/ci.yml`): a `web` job (ubuntu, `pnpm build`, `pnpm test`,
`pnpm format:check`) and a `shell` job (windows, `cargo fmt --check`, `cargo clippy -D
warnings`, `cargo test`, then `pnpm tauri build`, since only a full build catches a broken
resource path or a missing sidecar).

## Layout

| Path                                         | What it is                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/analysis/`                          | Pure rule functions over a scan; registered in `rules.ts`                                                                                              |
| `src/lib/repair/`                            | Repair plans (`REPAIRS` map in `repairs.ts`); return a `RepairPlan`, never write directly                                                              |
| `src/components/`                            | React UI (Home, Library, Findings, Repair, Saves, Benchmark, Settings, ...)                                                                            |
| `src-tauri/src/`                             | Rust shell: `lib.rs` (Tauri commands), `scan.rs` (live install scan), `vault.rs` (content-addressed mod store), `files.rs` (shared filesystem helpers) |
| `sidecar/PatchProbe`, `sidecar/CompanionMod` | .NET assembly-inspection sidecar and its test project                                                                                                  |
| `scripts/`                                   | `scan.mjs` (reference scanner), `workshop.mjs` (Workshop metadata cache), `release.ps1`                                                                |
| `docs/`                                      | `ARCHITECTURE.md`, `HOW-IT-WORKS.md`, `SECURITY-MODEL.md`, `SMOKE-TEST.md`, `SPEC.md`                                                                  |

## Conventions

- Commits: `(type) what changed, in lower case` (feat, fix, docs, refactor, test, chore).
- No em dashes or en dashes anywhere: prose, comments, docs, UI copy, commit messages.
- A new rule goes in `src/lib/analysis/`, registered in `rules.ts`, pure over the scan.
- A new repair goes in `repairs.ts`'s `REPAIRS` map; anything that writes must back up first
  through `backup_once`.
- Design rule: RimDoc+ never edits a mod in place; every repair is an overlay or a vault copy.
- See CONTRIBUTING.md for the full house style (comments explain why, tests named after the
  failure they prevent) and the release process (`scripts/release.ps1`).

## Do not read

`node_modules/`, `dist/`, `src-tauri/target/`, `pnpm-lock.yaml`, `src/dev-data/` (gitignored
fixture, not always present).
