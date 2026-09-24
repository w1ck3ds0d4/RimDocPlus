# Roadmap

**Status:** continue. **Last reviewed:** 2026-09-24.

RimDoc+ diagnoses, repairs and supervises a modded RimWorld install. It is public, has real
stargazers, and has kept receiving sustained feature work through September. "Done" for this
status is not a fixed release: the L1 static rule set, session capture and the fix registry in
`docs/SPEC.md` are the open surface, and the app keeps getting more useful the more of that
built-out spec ships.

> How this file is used: Claude Project threads build the first unticked item under **Now**, one item per branch and pull request, and tick it in that same PR as `- [x] ... (#PR)`. Daniel owns the order and the lists; threads never add to Now, Next or Later themselves, they propose under **Ideas**.

## Now

- [ ] **Add CHANGELOG.md**: a Keep a Changelog file built from tags and merged PRs, since v0.1.0
      shipped 2026-09-08 with no changelog in tree. Done when: the file exists and covers v0.1.0.
- [ ] **Decide on the v1 acceptance bar**: the app has no ROADMAP.md today despite being the
      most actively developed repo in the fleet; this file starts that, but Daniel should confirm
      whether "continue" or an explicit "release: v1" framing fits better given it is already
      public with users. Done when: the status line above is confirmed or changed.
- [ ] **XML patch simulation** (`docs/SPEC.md` L1 planned): run every `PatchOperation` against
      the merged def database and report which xpaths will miss, without launching the game. Done
      when: a new rule ships in `src/lib/analysis/` with tests and is registered in `rules.ts`.
- [ ] **Harmony target resolution via the sidecar**: report patches whose target method no
      longer exists in the running game version. Done when: the rule ships with a fixture-backed
      test and the sidecar's PatchProbe supports the lookup.
- [ ] **Clear the one open Dependabot alert**. Done when: the alert closes with a green CI run.

## Next

- [ ] **Session capture on abnormal exit**: bundle a case file (log, mod list, profile hash,
      save, system specs, crash dump) using the three-signal crash/hang detection already
      specified in `docs/SPEC.md`. Done when: the bundle is produced on a real crash and attached
      to the Session tab.
- [ ] **Fix registry (recipes)**: repairs shareable as signed, keyed diffs rather than mod
      files, exportable to the mod author. Done when: one recipe can be exported and re-applied on
      a second machine.

## Later

- Two-mods-patching-the-same-method collision detection, dangling def/texture references
- L2 headless boot (launch with `-quicktest`, classify errors as they arrive)
- L3 soak via the companion mod, TPS curve and per-mod tick attribution
- Auto-bisect on an L2 failure

## Ideas

(empty to start; threads add proposals here)

## Done

- [x] v0.1.0 tagged and released (2026-09-08)
- [x] Repair scale capped at three tiers; advising/recommending mods explicitly out of scope
      (#36, `docs/SPEC.md`)
- [x] `release.ps1` that checks version consistency and CI before tagging (#48, #49, #50)
- [x] Steam-close-and-reopen flow for Workshop repairs, gated on RunningAppID (#42, #44)
- [x] Session tracking, Play menu describing what Play does, search that stops when told to
      (#40, #41, #46)
