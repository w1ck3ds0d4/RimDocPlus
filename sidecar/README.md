# The patch probe

A small .NET program that answers one question RimDoc+ cannot answer on its own:

> This mod patches `Verse.PawnRenderer.DrawEquipmentAiming`. Does that still exist?

When RimWorld updates, methods get renamed, moved, or deleted. A Harmony patch aimed at one
that has gone cannot apply, and nothing on disk says so. You find out when the game throws
at startup, or when a feature silently stops working. This reads the answer straight out of
the assemblies.

## Why a separate program, in another language

The question is about .NET metadata, and the mature way to read .NET metadata is
[Mono.Cecil](https://github.com/jbevain/cecil). There is no comparable Rust or TypeScript
option, and this is not the place to find out.

It **reads** metadata and never loads an assembly. Loading would run static constructors,
which means running mod code, and would need the exact runtime the game uses. Nothing in
any mod executes here.

It knows nothing about RimDoc+. It reads a request on stdin, writes a report on stdout, and
can be run by hand against any install.

## Running it

```bash
echo '{"managed":"C:/.../RimWorldWin64_Data/Managed","assemblies":["C:/.../Some.dll"]}' \
  | rimdoc-patchprobe.exe
```

Paths are given, never discovered: this program has no opinion about where RimWorld lives,
which keeps that knowledge in one place and makes the probe runnable against a copied
folder.

## What it reports

One entry per patch class, with a verdict:

| Verdict                  | Means                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`                     | The target type and method exist in this build.                                                                                                                    |
| `missing-method`         | The type exists, the method does not. **This patch cannot apply.**                                                                                                 |
| `missing-method-guarded` | The same, but the class has a Harmony `Prepare()`, so the mod decides at runtime whether to apply it. Often a patch deliberately carried for another game version. |
| `foreign-type`           | The target is not a game type. Usually another mod's, which is ordinary.                                                                                           |
| `runtime-only`           | The target is computed at runtime, by `TargetMethod()` or an imperative `harmony.Patch(...)`. Cannot be checked without launching the game.                        |

For `missing-method` it also reports where the name went, but **only when that means
something**. A method found on one or two other types is a relocation worth naming. A
method found on twenty is a name everything has, and listing a few would dress noise up as
a lead, so it says the name is common instead.

## What it cannot see

Stated plainly, because a coverage number that quietly excludes things is worse than no
number:

- **Patches registered imperatively.** `harmony.Patch(AccessTools.Method(...))` decides its
  target while the game runs. Reading it would mean interpreting IL and folding constants,
  and the answer would still be a guess wherever the argument is not a literal.
- **`TargetMethod()`.** Same reason: it is code, not metadata.
- **Overloads.** The check is on the method _name_. A patch aimed at a specific overload
  whose signature changed still reads as `ok`.

On a real 253-mod install those come to 523 of 2,427 patch classes. They are reported as
`runtime-only` rather than folded into the total, so the number that resolved is honest.

## Building

```bash
dotnet build   -c Release                    # for development
dotnet publish -c Release -r win-x64         # what ships: single file, self contained
pnpm probe:verify                            # from the repo root
```

Published trimmed, which takes it from 70 MB to 13 MB. Cecil warns that it uses reflection
the trimmer cannot follow; those paths write assemblies and read PDBs, and this program does
neither. That is a claim rather than a proof, so `pnpm probe:verify` runs the trimmed build
and the untrimmed one over the same install and fails if their reports differ by a byte.

## What it found

Run against the 253-mod install this was developed against, RimWorld 1.6.4871:

```
1,169 assemblies read, 0 unreadable
2,427 patch classes

  1,782  ok
    523  runtime-only
     70  foreign-type
     52  missing-method     <- across 16 mods
```

Of the 52, none were in a `1.4/` or `1.5/` folder the game never loads, and none were
guarded by `Prepare()`. They are live patches aimed at methods that are not there. Six of
them had moved somewhere findable, all real 1.6 refactors:

| Patch target                                      | Now on                      |
| ------------------------------------------------- | --------------------------- |
| `FloatMenuMakerMap.CanTakeOrder`                  | `Verse.Pawn`                |
| `PawnRenderer.DrawEquipmentAiming`                | `Verse.PawnRenderUtility`   |
| `PawnRenderer.CarryWeaponOpenly`                  | `Verse.PawnRenderUtility`   |
| `FloatMenuMakerMap.ValidateTakeToBedOption`       | `RimWorld.FloatMenuUtility` |
| `Designator_PlantsCut.IconReverseDesignating`     | `Verse.Designator`          |
| `Designator_PlantsCut.LabelCapReverseDesignating` | `Verse.Designator`          |

The rest, including `FloatMenuMakerMap.AddHumanlikeOrders`, are gone from the game entirely.
