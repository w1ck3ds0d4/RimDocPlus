# How each analysis works

What RimDoc+ reads, what it infers, and where each inference stops being reliable. Every
figure quoted comes from the 253-mod RimWorld 1.6 install this was built against.

The bias throughout is towards saying where a number comes from. A tool that reports
problems has to be auditable, or its output is just a different thing to take on faith.

---

## 1. The scan

`pnpm scan` walks three roots: the game's `Data` folder, local `Mods`, and the Steam
Workshop content folder beside `steamapps/common`. Everything downstream reads the JSON it
writes; nothing else touches the filesystem.

### Reading About.xml

Deliberately tolerant. A meaningful share of Workshop metadata is malformed: stray
ampersands, a BOM mid-file, unclosed tags, inconsistent casing. A strict `DOMParser`
rejects the whole document and the mod disappears from the list, so the readers pull the
few fields that matter and ignore the rest.

Three things that look like details and are not:

**Identity is read with the dependency blocks stripped out.** A dependency entry nests its
own `<packageId>`, so a mod declaring `<modDependencies>` above its own identity reports
its dependency's id as its own. Before this was fixed, 24 unrelated mods collapsed into
`brrainz.harmony`.

**Ludeon's own About.xml has no `<name>`**, and the game falls back to the folder name.
Without matching that, Core and every DLC display as raw package ids. A Workshop folder is
named after its numeric file id, so that case falls through to the package id instead.

**`forceLoadBefore` and `forceLoadAfter` are the hard form of the ordering constraint** and
Core uses them. Reading only `loadBefore`/`loadAfter` sorts official content wrong.

### Textures

Every PNG's first 24 bytes are read: signature, IHDR length, the IHDR tag, then width and
height as big-endian uint32. Reading whole files would be thousands of times more IO for
the two numbers that matter.

VRAM is computed from dimensions, never from file size, because Unity uploads textures
decoded. A 2048px texture costs 16 MB resident whether it compresses to 4 KB or 4 MB.

The texture pass runs inside the same directory walk as the size measurement, so a 253-mod
install is traversed once. That scan takes about 46 seconds and reads 33,718 textures.

### Patches

Every mod's `Patches` folder, including the versioned `1.6/Patches` layout. Reading only
the top level found 32 mods out of 130 and 1,471 operations instead of 9,809.

Extraction anchors on the `<xpath>` element and walks backwards to the nearest `Class`
attribute. Anchoring on `<Operation>` instead does not work: operations nest inside
`PatchOperationSequence` and `PatchOperationConditional`, and `Class` also appears on def
elements inside a `<value>` block, so matching it directly picks up things that are not
operations at all.

**Limits:** 400 patch files and 1,500 operations per mod, 25 named oversized textures per
mod, 6,000 directory entries per mod for the size walk. A mod that hits a cap is marked
truncated rather than silently reported as smaller than it is.

---

## 2. Static rules

Nine rules over the modpack and the scan, each an independent function returning zero or
more findings. They run isolated and timed: a rule that throws is recorded and skipped
rather than taking the whole analysis with it.

| Rule                   | Catches                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `orphan-active`        | Enabled package ids with no folder on disk                                       |
| `duplicate-package-id` | One id in two folders, where RimWorld silently picks one                         |
| `dlc-after-mods`       | Official content behind third-party mods, so patches ran before the defs existed |
| `bootstrap-position`   | Prepatcher or Harmony loading after a mod that ships C#                          |
| `missing-dependency`   | Declared dependency neither installed nor enabled                                |
| `inactive-dependency`  | Dependency installed but switched off                                            |
| `incompatible-pair`    | Both enabled where one declares the conflict                                     |
| `load-order-violation` | `loadAfter`/`loadBefore` constraints the order breaks                            |
| `version-mismatch`     | Mods not advertising the running game cycle                                      |

### Dependency alternatives

Authors list several ids for one dependency, because a mod gets reuploaded under a new
prefix and both versions are in the wild. They signal it by giving the entries the same
`displayName`.

MultiFloors declares `zetrith.prepatcher` and `jikulopo.prepatcher`, both named
"Prepatcher". Treating each as separately mandatory reported a missing dependency for a mod
that was installed and working. Dependencies are grouped by display name, and any one
option satisfies the group. Entries without a display name stay separate.

---

## 3. Log intelligence

Pipeline: filter noise, cluster by fingerprint, attribute to a mod, explain, rank.

**Noise filtering** removes Unity's fallback-handler probes and similar per-launch spam.
This is most of what makes a RimWorld log readable at all.

**Trace capture** reads across the `[Ref 707A92AF]` tag RimWorld puts between a message and
its stack. A naive "is the next line a frame" check finds nothing and loses every trace.

**Trace lines are consumed with their entry.** A native wrapper frame carries
`System.Exception&` in its own signature and matches a generic exception pattern, so
without this the trace produces phantom "Unhandled exception" findings with no detail.

**Fingerprinting** is category plus the message with digits normalised out plus the top
three frames, so one fault reported from one place collapses to a single counted row
regardless of ids, coordinates or tick counts.

**Attribution** matches namespace roots from frames, and tokens in the message, against an
index built from mod names and package ids. Harmony patch annotations
(`- POSTFIX ModName: ...`) are read first, because they name the patching mod outright
rather than leaving it to be inferred.

Engine namespaces (`System`, `Verse`, `RimWorld`, `HarmonyLib`, `UnityEngine`, `Mono`,
`Prepatcher`) are excluded from attribution, since blaming Verse for a crash is true and
useless.

---

## 4. Patch overrides

RimWorld applies patches in load order and reports nothing when two fight: the later
operation wins. That makes the conflict invisible from inside the game.

Overriding is also how content layers. An expansion, a retexture or a patch mod exists
precisely to change what an earlier mod set, so every override is reported as a note, and
what varies is how directly the intent can be evidenced:

- **declared** - the later mod lists `loadAfter` or depends on what it overrides
- **documented** - its description says where to load it, quoted back
- **content** - description or name reads as layered content, quoted back
- **assumed** - nothing says either way

On the reference install: 12 overrides, 8 declared and 4 evidenced from the author's own
description. None unexplained.

**Nothing here proposes a reorder, on purpose.** The obvious heuristic is "the more
specialised mod should win". Checked against the real install it was already satisfied in
most cases and would have been actively wrong in the rest: Combat Extended overriding
Vanilla Weapons Expanded is not a bug, it is what a combat overhaul is for, and "fixing" it
would break the mod.

---

## 5. Performance

Two measurements, no estimates of frame rate. Attributing frame time needs the in-game
companion mod, which does not exist yet, and a number invented in its absence would be
worse than none.

**Texture footprint** sums width x height x 4 across every texture. This is an upper bound
if everything were resident at once, not live usage, since RimWorld atlases and unloads.
It is the number that decides how much work the atlas builder does at load. The reference
install reads 20.4 GB across 225 active mods, on a card with 8 GB.

**Oversized textures**: named per mod. RimWorld draws at roughly 64px per tile, so past
512px is detail the camera never resolves, and halving a dimension quarters the cost.

The scan records every texture above the 512px downscale target, and a setting decides which
of them count as oversized, defaulting to 1024px. Splitting it that way means moving the
setting re-decides the answer with no second walk of the disk.

**The footprint carries no repair, on purpose.** It once offered the oversize rule's own
downscale, which was the same plan over the same files listed twice, and it promised
something it could not deliver. Measured on the reference install: resizing every texture at
1024px or larger moved the total from 16.8 GB to 15.5 GB, and capping _every_ texture at
512px would only reach 13.4 GB. The remaining 8.46 GB sits in 10,432 textures already at or
under the target. A large mod list is expensive because it is large, and that comes down by
running fewer mods rather than by resizing.

### The duration estimate

Calibrated against two timed runs, not guessed. Twelve of the largest textures took 2,963
ms for roughly 200 megapixels; a 30-file spread across the whole set took 1,661 ms for 49.7
megapixels.

The first run alone suggested a flat per-file cost, which **underestimated the spread run
by 1.6x**, because most textures are small enough that fixed overhead is the larger half.
Modelling it additively at 30 ms per file plus 15 ms per megapixel predicts the sample run
within 1%.

---

## 6. Workshop data

The only thing RimDoc+ sends off the machine, so it is a separate opt-in command.

`pnpm workshop` POSTs Workshop file ids to Steam's anonymous
`ISteamRemoteStorage/GetPublishedFileDetails` endpoint in batches of 50, with a pause
between. No account, no key, no credential. It runs in node rather than the browser because
Steam sends no CORS headers. Results cache with a one-week TTL, and the app works fully
without ever running it.

Local signals answer "what does this cost me and what breaks without it". Workshop signals
answer "is this maintained and does anyone else use it". Neither is a verdict alone, which
is why the Library shows them side by side rather than reducing them to a score.

---

## 7. Repairs

A repair produces a **plan**, never an edit. The plan is always shown before it can run.

| Kind       | Means                  | Applied                  |
| ---------- | ---------------------- | ------------------------ |
| `modpack`  | App state              | Instantly, undoably      |
| `choice`   | Needs a human decision | After you pick           |
| `files`    | Touches disk           | Via the generated script |
| `external` | Only you can do it     | By you                   |

The same plan is what the Tauri shell will execute directly, so nothing about the repair
layer changes when the shell lands; only its executor does.

### Ranking a duplicate

Ordered by how much it costs to be wrong: declaring the running cycle is a hard filter,
then a local copy (a deliberate pin against Steam replacing it), then update recency, then
subscribers.

It stops short of choosing, because the signals genuinely conflict. For
`orion.hospitality` the original has 787,940 subscribers and the continuation 195,340, but
the continuation was updated 398 days more recently. Recency and popularity point at
different copies and neither answer is wrong, so the suggestion is labelled and the
counter-evidence printed beside it.

### Backups

Four layers, because the one destructive action has to be recoverable:

1. An **original-version** copy of the save-data `Config` folder, taken once and never
   overwritten, so it stays the install as first found rather than as it was before the
   most recent run.
2. A per-run folder holding every file that run will change.
3. A `.rimdocbak` beside each individual file.
4. A **rollback script** that restores from those and reports what it restored and skipped.

Directories are copied with `-Recurse`. Without it `Copy-Item` creates an empty folder, so
removing a duplicate mod folder was unrecoverable while reporting that it had been backed
up.

---

## 8. Triage

One pass that sorts every finding into what can be done about it, and applies what is
provably safe. Automatic repairs are chained, each planned against the result of the
previous one, so a batch cannot contain two conflicting edits to one load order.

The "resolved" count comes from **re-running the rules against the repaired modpack**, not
from counting what was attempted, so it cannot overstate itself.

Every finding lands in a bucket, including those proposing no repair because none is
wanted. Without that, twelve of fifteen findings fell through every branch and the summary
described a fifth of the list while sounding like it described all of it.

**Auto** takes any option a repair can defend. A file plan is still only staged: it becomes
a script you read and run, so the download is the confirmation step rather than the toggle.

---

## What none of this can tell you

Everything above reasons about files on disk. It cannot tell you the game starts.

Faults that only appear once the game is executing need the supervised launch and the
headless boot check, and neither is built. The Doctor saying a load order is structurally
sound is a different claim from "this boots", and the reports are worded to keep those
apart.
