using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using RimWorld;
using Verse;

namespace RimDocProbe
{
    /// <summary>
    /// Writes what the meter saw to a file, on a timer, while the game runs.
    /// </summary>
    /// <remarks>
    /// A file rather than a socket, because the app is already reading files out of this
    /// folder and a listening port is a thing to explain and secure for no gain.
    ///
    /// Written repeatedly rather than once at exit, so a run that never exits cleanly still
    /// leaves an answer. That is also what makes it a heartbeat: a report whose timestamp is
    /// advancing is a game that is still ticking, which is the one thing that could not be
    /// known from outside. A crash an hour into a colony looks exactly like a healthy boot
    /// from out there, and this is the difference.
    /// </remarks>
    internal static class Report
    {
        private const int WriteEverySeconds = 5;

        private static readonly Stopwatch Uptime = Stopwatch.StartNew();

        internal static void Start(int patchedMethods)
        {
            var thread = new Thread(() => Loop(patchedMethods))
            {
                IsBackground = true,
                Name = "RimDoc probe",
                // Below everything the game does. This exists to report on the simulation,
                // not to compete with it.
                Priority = ThreadPriority.Lowest,
            };
            thread.Start();
        }

        private static void Loop(int patchedMethods)
        {
            while (true)
            {
                try
                {
                    Thread.Sleep(WriteEverySeconds * 1000);
                    Write(patchedMethods);
                }
                catch (Exception)
                {
                    // Never take the game down over a report. A write that fails is retried
                    // on the next pass, and a folder that cannot be written is simply never
                    // written to.
                }
            }
        }

        /// <summary>Beside the game's own logs, which is where the app already looks.</summary>
        internal static string Path()
        {
            return System.IO.Path.Combine(GenFilePaths.SaveDataFolderPath, "RimDoc", "probe.json");
        }

        private static void Write(int patchedMethods)
        {
            var path = Path();
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path));

            var json = new StringBuilder();
            json.Append("{\"schema\":1");
            json.Append(",\"gameVersion\":").Append(Quote(VersionControl.CurrentVersionStringWithRev));
            json.Append(",\"uptimeSeconds\":").Append(Number(Uptime.Elapsed.TotalSeconds));
            json.Append(",\"patchedMethods\":").Append(patchedMethods);
            json.Append(",\"ticksPlayed\":").Append(TicksPlayed());
            json.Append(",\"mods\":[");

            var first = true;
            foreach (var bucket in Meter.Snapshot())
            {
                if (!first)
                {
                    json.Append(',');
                }
                first = false;
                json.Append("{\"assembly\":").Append(Quote(bucket.Assembly));
                json.Append(",\"packageId\":").Append(Quote(bucket.PackageId));
                json.Append(",\"mod\":").Append(Quote(bucket.Mod));
                json.Append(",\"calls\":").Append(bucket.Calls);
                json.Append(",\"ms\":").Append(Number(Meter.Milliseconds(bucket.Ticks)));
                json.Append('}');
            }

            json.Append("]}");

            // Written beside and moved into place, so the app never reads half a document.
            var temp = path + ".writing";
            File.WriteAllText(temp, json.ToString());
            if (File.Exists(path))
            {
                File.Delete(path);
            }
            File.Move(temp, path);
        }

        /// <summary>
        /// How many ticks the colony has run, or zero outside a game.
        /// </summary>
        /// <remarks>
        /// Guarded because this runs on its own thread from the moment the mod loads, which
        /// is long before there is a game to ask, and stays running through the main menu
        /// between colonies.
        /// </remarks>
        private static int TicksPlayed()
        {
            try
            {
                return Find.TickManager?.TicksGame ?? 0;
            }
            catch (Exception)
            {
                return 0;
            }
        }

        private static string Number(double value)
        {
            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        private static string Quote(string text)
        {
            var quoted = new StringBuilder("\"");
            foreach (var c in text ?? string.Empty)
            {
                switch (c)
                {
                    case '"':
                        quoted.Append("\\\"");
                        break;
                    case '\\':
                        quoted.Append("\\\\");
                        break;
                    case '\n':
                        quoted.Append("\\n");
                        break;
                    case '\r':
                        quoted.Append("\\r");
                        break;
                    case '\t':
                        quoted.Append("\\t");
                        break;
                    default:
                        if (c < ' ')
                        {
                            quoted.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            quoted.Append(c);
                        }
                        break;
                }
            }
            return quoted.Append('"').ToString();
        }
    }
}
