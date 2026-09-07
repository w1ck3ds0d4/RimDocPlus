using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;

namespace RimDocProbe
{
    /// <summary>
    /// How long each mod's code spends being ticked.
    /// </summary>
    /// <remarks>
    /// Bucketed by assembly rather than by type, because the question is what a mod costs and
    /// a mod is an assembly. One entry per assembly, looked up once per patched method and
    /// then held, so the hot path is an array index and two adds.
    ///
    /// Timestamps rather than a Stopwatch instance: <see cref="Stopwatch.GetTimestamp"/> is a
    /// single counter read, and this runs on every tick of every modded thing on the map. A
    /// measurement that costs more than what it measures is not a measurement.
    /// </remarks>
    internal static class Meter
    {
        /// <summary>One bucket per assembly. Never removed, so an index stays valid forever.</summary>
        private static readonly List<Bucket> Buckets = new List<Bucket>();

        private static readonly Dictionary<Assembly, int> Index = new Dictionary<Assembly, int>();

        private static readonly object Gate = new object();

        internal sealed class Bucket
        {
            internal string Assembly;

            /// <summary>
            /// The mod that owns the assembly, as the game itself reports it.
            /// </summary>
            /// <remarks>
            /// Recorded here rather than worked out afterwards. Inside the game the mapping
            /// is a fact the loader already holds; outside it, it is a guess from a file
            /// name, and two mods can ship assemblies named the same.
            /// </remarks>
            internal string PackageId;
            internal string Mod;
            internal long Calls;
            internal long Ticks;
        }

        /// <summary>
        /// The bucket for an assembly, created once.
        /// </summary>
        /// <remarks>
        /// Called while patches are being applied, not while they run: a patch closes over
        /// the index it is given, so the dictionary is never touched on the hot path.
        /// </remarks>
        internal static int BucketFor(Assembly assembly, string packageId, string mod)
        {
            lock (Gate)
            {
                if (Index.TryGetValue(assembly, out var found))
                {
                    return found;
                }

                Buckets.Add(
                    new Bucket
                    {
                        Assembly = assembly.GetName().Name,
                        PackageId = packageId,
                        Mod = mod,
                    }
                );
                var at = Buckets.Count - 1;
                Index[assembly] = at;
                return at;
            }
        }

        /// <summary>
        /// Record one call. The hot path, and deliberately the whole of it.
        /// </summary>
        /// <remarks>
        /// Unlocked. Two longs accumulating across threads can lose an update, and losing one
        /// tick out of millions changes no answer this reports. Locking here would cost more
        /// than the thing being measured and would serialise the game's own ticking.
        /// </remarks>
        internal static void Add(int bucket, long elapsed)
        {
            var it = Buckets[bucket];
            it.Calls++;
            it.Ticks += elapsed;
        }

        internal static long Now()
        {
            return Stopwatch.GetTimestamp();
        }

        /// <summary>What has been measured so far, newest numbers, most expensive first.</summary>
        internal static List<Bucket> Snapshot()
        {
            lock (Gate)
            {
                var copy = new List<Bucket>(Buckets.Count);
                foreach (var bucket in Buckets)
                {
                    if (bucket.Calls == 0)
                    {
                        continue;
                    }
                    copy.Add(
                        new Bucket
                        {
                            Assembly = bucket.Assembly,
                            PackageId = bucket.PackageId,
                            Mod = bucket.Mod,
                            Calls = bucket.Calls,
                            Ticks = bucket.Ticks,
                        }
                    );
                }
                copy.Sort((a, b) => b.Ticks.CompareTo(a.Ticks));
                return copy;
            }
        }

        /// <summary>Counter ticks as milliseconds, which is what a reader wants.</summary>
        internal static double Milliseconds(long ticks)
        {
            return ticks * 1000.0 / Stopwatch.Frequency;
        }
    }
}
