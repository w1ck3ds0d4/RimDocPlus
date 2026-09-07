import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanResult } from "../lib/types";
import { analyzeLog } from "../lib/analysis/logParser";
import { inShell, launchSupervised, stopGame, watchGame, type GameExit } from "../lib/shell";
import { record } from "../lib/history";
import { download } from "../lib/download";
import type { Modpack } from "../lib/modpacks";
import { loadRuns, measureRun, recordRun, type RunMeasurement } from "../lib/benchmark";
import { Benchmark } from "./Benchmark";

type Phase = "idle" | "running" | "done";

/**
 * Run the game and watch it.
 *
 * Launching used to hand the game over and forget about it, so anything that happened next
 * was only visible by reading a log afterwards. This follows the run: the log streams in as
 * it is written, a run that stops writing while still alive is called out, and the exit is
 * reported with what it was.
 *
 * Nothing here decides the game is broken. A non-zero exit and a quiet stretch are facts
 * about the run; what they mean is for the player and the rules to say.
 */
export function GameWatch({
  scan,
  modpack,
  startSignal = 0,
}: {
  scan: ScanResult;
  modpack: Modpack;
  /**
   * Bumped when something elsewhere asks for a watched run.
   *
   * A counter rather than a boolean, because asking twice is a real thing to want and a
   * boolean that is already true says nothing the second time.
   */
  startSignal?: number;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [exit, setExit] = useState<GameExit | null>(null);
  const [quiet, setQuiet] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [runs, setRuns] = useState<RunMeasurement[]>(loadRuns);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pending = useRef<string[]>([]);
  // Everything the run wrote, kept whole for the measurement even though the console shows
  // only the tail of it.
  const pendingAll = useRef<string[]>([]);
  const flusher = useRef<number | null>(null);
  const stop = useRef<(() => void) | null>(null);

  // Buffered and flushed on a timer. A modded load writes thousands of lines in bursts, and
  // a state update per line would make the console the slowest thing in the run.
  useEffect(() => {
    flusher.current = window.setInterval(() => {
      if (!pending.current.length) return;
      const batch = pending.current;
      pending.current = [];
      // Bounded: a long session is megabytes of log, and nobody scrolls back past a few
      // thousand lines. The full file is on disk either way.
      setLines((current) => [...current, ...batch].slice(-4000));
    }, 150);
    return () => {
      if (flusher.current !== null) clearInterval(flusher.current);
      stop.current?.();
    };
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && pinned) body.scrollTop = body.scrollHeight;
  }, [lines, pinned]);

  const log = scan.paths.playerLog;
  const blocked = !inShell()
    ? "Needs the desktop app"
    : !scan.paths.game
      ? "No RimWorld install found"
      : !log
        ? "No Player.log yet: run the game once first"
        : null;

  /**
   * Start when the header asks, and only then.
   *
   * The signal is compared with the last one acted on rather than merely being non-zero.
   * Reading "greater than zero" meant every mount was a request, so leaving the tab and
   * coming back launched the game again. This component is kept mounted now, which is the
   * real fix, but the guard is what makes a second mount harmless whatever causes it.
   */
  const handledSignal = useRef(startSignal);
  useEffect(() => {
    if (startSignal === handledSignal.current) return;
    handledSignal.current = startSignal;
    if (phase === "idle" && !blocked) void play();
    // Only the signal: re-running because the phase settled would start an unasked run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignal]);

  /**
   * End the run this app started.
   *
   * There was no way to. A watched run could be started from here and from the header's
   * menu, and then only ended by finding the game and closing it, which is a poor answer
   * from a window that is already following the process.
   */
  async function stopRun() {
    setStopping(true);
    try {
      await stopGame();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  }

  async function play() {
    if (!scan.paths.game || !log) return;
    setPhase("running");
    setLines([]);
    pendingAll.current = [];
    setExit(null);
    setQuiet(null);
    setError(null);

    stop.current = await watchGame({
      onLines: (batch) => {
        pending.current.push(...batch);
        pendingAll.current.push(...batch);
      },
      onQuiet: setQuiet,
      onExited: (finished) => {
        setExit(finished);
        setPhase("done");
        // Measured from the run's own transcript rather than a second read of the file,
        // so what is recorded is exactly what was watched.
        const analysis = analyzeLog(pendingAll.current.join("\n"));
        setRuns(recordRun(measureRun(modpack.name, modpack.activeOrder.length, finished, analysis)));
        record({
          kind: "launch",
          summary:
            finished.code === 0
              ? `Played for ${Math.round(finished.durationMs / 60000)} minutes`
              : `RimWorld exited with code ${finished.code ?? "unknown"}`,
          detail: `${finished.lines.toLocaleString()} log lines${finished.wentQuiet ? ", went quiet before exiting" : ""}`,
        });
      },
    });

    try {
      await launchSupervised(scan.paths.game, log);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
      stop.current?.();
    }
  }

  // Read out of what the run actually wrote, so the summary is the same analysis the
  // Session tab does rather than a second opinion about the same lines.
  //
  // Memoised because the console re-renders on every scroll tick to keep its follow-the-tail
  // state, and re-parsing four thousand lines of log through the whole rule set on each of
  // those made the finished transcript stutter under the reader's own scrolling.
  const faults = useMemo(
    () => (phase === "done" && lines.length ? analyzeLog(lines.join("\n")).events.length : 0),
    [phase, lines],
  );

  return (
    <section className="gamewatch">
      <header className="panel-head">
        <h3>Run the game and watch it</h3>
        {phase === "running" && <span className="muted">{lines.length.toLocaleString()} lines</span>}
      </header>

      {phase === "idle" && (
        <>
          <p className="muted">
            Starts RimWorld and follows its log as it is written, so a crash on load is in front of you rather
            than something to go looking for afterwards.
          </p>
          <div className="repair-actions">
            <button
              className="btn play"
              type="button"
              disabled={!!blocked}
              title={blocked ?? "Start RimWorld and follow the log"}
              onClick={() => void play()}
            >
              <span aria-hidden="true">&#9654;</span> Play and watch
            </button>
            {blocked && <span className="repair-note">{blocked}</span>}
            {error && <span className="prompt-error">{error}</span>}
          </div>
        </>
      )}

      {phase !== "idle" && (
        <>
          {phase === "running" && (
            <div className="repair-actions">
              <button
                className="btn danger"
                type="button"
                disabled={stopping}
                title="Ends the run this app started. Nothing else is touched."
                onClick={() => void stopRun()}
              >
                {stopping ? "Stopping..." : "Stop the game"}
              </button>
              <span className="repair-note">
                Only the run this app started, by the id it kept. A copy of the game it did not launch is left
                alone.
              </span>
            </div>
          )}

          {quiet !== null && phase === "running" && (
            <p className="warn-line">
              Nothing written for {quiet} seconds. A big load has quiet stretches, so this is not proof of a
              hang, only that the game has gone silent.
            </p>
          )}

          {exit && (
            <p className={exit.code === 0 ? "" : "warn-line"}>
              {exit.code === 0
                ? `Closed normally after ${Math.round(exit.durationMs / 60000)} minutes.`
                : `Exited with code ${exit.code ?? "unknown"} after ${Math.round(exit.durationMs / 1000)}s.`}{" "}
              {exit.lines.toLocaleString()} lines
              {faults > 0 && `, ${faults} distinct fault${faults === 1 ? "" : "s"} in them`}.
              {exit.wentQuiet && " It stopped writing well before it stopped running."}
            </p>
          )}

          <div className="console">
            <div className="console-bar">
              <span className="dot r" />
              <span className="dot y" />
              <span className="dot g" />
              <span className="console-title">Player.log</span>
              <span className="console-status">{phase === "running" ? "running" : "ended"}</span>
            </div>
            <div
              className="console-body"
              ref={bodyRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
              }}
            >
              {lines.map((line, i) => (
                <div className={`line ${lineTone(line)}`} key={i}>
                  <span className="text">{line}</span>
                </div>
              ))}
              {phase === "running" && (
                <div className="line work">
                  <span className="text caret">watching</span>
                </div>
              )}
            </div>
          </div>

          <div className="repair-actions">
            {phase === "done" && (
              <button className="btn" type="button" onClick={() => void play()}>
                Run again
              </button>
            )}
            <button
              className="btn"
              type="button"
              disabled={!lines.length}
              onClick={() => download("rimdoc-run.log", lines.join("\n"))}
            >
              Save this run
            </button>
            {phase === "done" && (
              <button className="btn" type="button" onClick={() => setPhase("idle")}>
                Clear
              </button>
            )}
          </div>
        </>
      )}

      {runs.length > 0 && <Benchmark runs={runs} onClear={() => setRuns([])} />}
    </section>
  );
}

/** Enough to pick a fault out of a wall of load messages, without parsing every line. */
function lineTone(line: string): string {
  if (/exception|error|failed|could not/i.test(line)) return "warn";
  if (/^\s*at\s|^-\s+(PREFIX|POSTFIX|TRANSPILER|FINALIZER)/.test(line)) return "info";
  return "";
}
