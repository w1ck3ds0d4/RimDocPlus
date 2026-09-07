using System;
using System.Collections.Generic;
using System.Reflection;
using HarmonyLib;
using Verse;

namespace RimDocProbe
{
    /// <summary>
    /// Times the ticking that mods do, and writes what it saw where RimDoc+ can read it.
    /// </summary>
    /// <remarks>
    /// Only mod code is timed. The game's own ticking is not what anyone is deciding about,
    /// and patching it would double the number of patched methods to measure something
    /// nobody can act on.
    /// </remarks>
    public class Probe : Mod
    {
        public Probe(ModContentPack content)
            : base(content)
        {
            try
            {
                Start();
            }
            catch (Exception e)
            {
                // A profiler that stops someone's game is worse than no profiler. Anything
                // that goes wrong here is reported and then left alone.
                Log.Warning($"[RimDoc] probe did not start: {e.Message}");
            }
        }

        /// <summary>
        /// Everything that touches Harmony, behind its own method.
        /// </summary>
        /// <remarks>
        /// Not inlined into the constructor. A method's types are resolved when it is entered,
        /// so a constructor that mentions Harmony directly would fail before its own
        /// try/catch could run on an install where Harmony is not loaded. Here the failure
        /// happens entering this method, which the caller is already guarding.
        ///
        /// The mod declares brrainz.harmony as a dependency, so this should not happen. It is
        /// guarded anyway, because the cost of being wrong is someone's game not starting.
        /// </remarks>
        private static void Start()
        {
            var harmony = new Harmony("rimdoc.probe");
            var patched = PatchModTicks(harmony);
            Report.Start(patched);
            Log.Message($"[RimDoc] probe watching {patched} ticking methods");
        }

        /// <summary>Methods this can usefully time, by the name the game calls them by.</summary>
        private static readonly string[] TickNames =
        {
            "Tick",
            "TickRare",
            "TickLong",
            "GameComponentTick",
            "MapComponentTick",
            "WorldComponentTick",
            "CompTick",
            "CompTickRare",
        };

        /// <summary>
        /// Patch every tick method a mod declares.
        /// </summary>
        /// <remarks>
        /// Every override, not just the base. `Thing.Tick` is virtual and a mod's thing
        /// overrides it, so patching the base would catch the calls the game makes into its
        /// own types and none of the ones worth timing.
        ///
        /// Declared methods only, so a subclass that does not override Tick is not counted
        /// twice through its parent. Abstract and generic definitions are skipped: there is
        /// nothing to time in the first and nothing concrete to patch in the second.
        /// </remarks>
        private static int PatchModTicks(Harmony harmony)
        {
            var prefix = new HarmonyMethod(
                typeof(Probe).GetMethod(nameof(Before), BindingFlags.NonPublic | BindingFlags.Static)
            );
            var postfix = new HarmonyMethod(
                typeof(Probe).GetMethod(nameof(After), BindingFlags.NonPublic | BindingFlags.Static)
            );

            var game = typeof(Thing).Assembly;
            var patched = 0;

            foreach (var owned in ModAssemblies(game))
            {
                var assembly = owned.Assembly;
                var bucket = Meter.BucketFor(assembly, owned.PackageId, owned.Name);
                foreach (var type in Types(assembly))
                {
                    foreach (var name in TickNames)
                    {
                        var method = type.GetMethod(
                            name,
                            BindingFlags.Instance
                                | BindingFlags.Public
                                | BindingFlags.NonPublic
                                | BindingFlags.DeclaredOnly,
                            null,
                            Type.EmptyTypes,
                            null
                        );
                        if (method == null || method.IsAbstract || method.ContainsGenericParameters)
                        {
                            continue;
                        }

                        try
                        {
                            harmony.Patch(method, prefix, postfix);
                            Buckets[method] = bucket;
                            patched++;
                        }
                        catch (Exception)
                        {
                            // A method another mod has already transpiled, or one Harmony
                            // will not touch. Skipping it loses one row, and refusing to
                            // start would lose the whole report.
                        }
                    }
                }
            }

            return patched;
        }

        /// <summary>Which bucket each patched method belongs to, decided before anything runs.</summary>
        private static readonly Dictionary<MethodBase, int> Buckets = new Dictionary<MethodBase, int>();

        /// <summary>An assembly, and the mod the loader says it belongs to.</summary>
        private readonly struct Owned
        {
            internal Owned(Assembly assembly, string packageId, string name)
            {
                Assembly = assembly;
                PackageId = packageId;
                Name = name;
            }

            internal Assembly Assembly { get; }
            internal string PackageId { get; }
            internal string Name { get; }
        }

        private static IEnumerable<Owned> ModAssemblies(Assembly game)
        {
            var seen = new HashSet<Assembly>();
            foreach (var pack in LoadedModManager.RunningMods)
            {
                foreach (var assembly in pack.assemblies.loadedAssemblies)
                {
                    // The game's own, and this probe: timing itself would be noise measuring
                    // the instrument.
                    if (assembly == game || assembly == typeof(Probe).Assembly)
                    {
                        continue;
                    }
                    if (seen.Add(assembly))
                    {
                        yield return new Owned(assembly, pack.PackageId, pack.Name);
                    }
                }
            }
        }

        private static IEnumerable<Type> Types(Assembly assembly)
        {
            try
            {
                return assembly.GetTypes();
            }
            catch (ReflectionTypeLoadException e)
            {
                // A mod referencing something absent still has types worth reading. What
                // loaded is returned and the rest dropped, rather than the assembly being
                // skipped whole.
                var loaded = new List<Type>();
                foreach (var type in e.Types)
                {
                    if (type != null)
                    {
                        loaded.Add(type);
                    }
                }
                return loaded;
            }
            catch (Exception)
            {
                return Array.Empty<Type>();
            }
        }

        private static void Before(out long __state)
        {
            __state = Meter.Now();
        }

        private static void After(MethodBase __originalMethod, long __state)
        {
            if (Buckets.TryGetValue(__originalMethod, out var bucket))
            {
                Meter.Add(bucket, Meter.Now() - __state);
            }
        }
    }
}
