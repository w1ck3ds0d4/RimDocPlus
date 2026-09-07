import { useEffect, useRef, useState } from "react";
import type { FileAction } from "../lib/repair/repairs";
import { targetsOf } from "../lib/repair/repairs";
import {
  inShell,
  isGameRunning,
  isSteamRunning,
  rollback,
  runFileActions,
  startSteam,
  stopSteam,
  watchRepair,
  type RunReport,
} from "../lib/shell";
import { record } from "../lib/history";
import { RepairConsole, lineOf, type ConsoleLine } from "./RepairConsole";

/**
 * Run a repair plan, with the transcript on screen while it happens.
 *
 * Events arrive one per action and a texture pass is 730 of them, so they are buffered and
 * flushed on a timer. Setting state per event would re-render the list 730 times and make
 * the console the slowest part of the run it is reporting.
 */
export function ApplyActions({
  actions,
  now,
  deferred,
  deferredFor,
  config,
  workshop,
  onApplied,
}: {
  /** Everything the run would do, which is what a rollback has to cover. */
  actions: FileAction[];
  /** The part that can run whatever Steam is doing. */
  now: FileAction[];
  /** The part Steam has to be closed for, held back as whole repairs. */
  deferred: FileAction[];
  deferredFor: string[];
  config: string | null;
  /** Steam's workshop content folder, which is how the shell finds steam.exe. */
  workshop: string | null;
  onApplied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "undone">("idle");
  const [report, setReport] = useState<RunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [deferredNote, setDeferredNote] = useState<string | null>(null);
  const [steamUp, setSteamUp] = useState(false);

  const pending = useRef<ConsoleLine[]>([]);
  const busy = useRef(false);
  const flusher = useRef<number | null>(null);

  const startFlushing = () => {
    if (flusher.current !== null) return;
    flusher.current = window.setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLines((current) => [...current, ...batch]);
    }, 90);
  };

  const stopFlushing = () => {
    if (flusher.current !== null) {
      clearInterval(flusher.current);
      flusher.current = null;
    }
    if (pending.current.length > 0) {
      const batch = pending.current;
      pending.current = [];
      setLines((current) => [...current, ...batch]);
    }
  };

  useEffect(() => stopFlushing, []);

  // Whether to offer closing Steam at all. Asked only when something in the plan would be
  // undone by it, since otherwise the answer changes nothing.
  useEffect(() => {
    if (!inShell() || deferred.length === 0) return;
    let live = true;
    void isSteamRunning()
      .then((up) => live && setSteamUp(up))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [deferred.length, state]);

  const push = (line: ConsoleLine) => pending.current.push(line);

  async function run(kind: "apply" | "undo" | "restart-steam") {
    const applying = kind !== "undo";
    // Steam is closed for the duration, so nothing has to be held back from this one.
    const closing = kind === "restart-steam";

    // A second click before React has disabled the button would run the whole sequence
    // twice over the same files and the same single backup. Held in a ref because state
    // does not settle until the next render, which is later than the second click.
    if (busy.current) return;
    busy.current = true;
    try {
      await carryOut(applying, closing);
    } finally {
      busy.current = false;
    }
  }

  /**
   * One run, start to finish: what it may do, doing it, and what it says about it.
   *
   * Split from `run` only so the guard against a second click has somewhere to stand.
   */
  async function carryOut(applying: boolean, closing: boolean) {
    // Repairs Steam would undo are held back; the rest of the run goes ahead. Steam keeps its
    // download record in memory and rewrites it on exit, so editing that record while it runs
    // achieves nothing. Held back as whole repairs rather than as single actions, because such
    // an edit is paired with deleting the mod folder: doing half would leave the mod gone and
    // Steam still believing it had it. Refusing the whole run instead would hold back repairs
    // that have nothing to do with Steam, which is what made this look like it did nothing.
    if (closing && (await isGameRunning())) {
      setError(
        "Steam is running a game. Closing Steam would take it down with no warning and no " +
          "save, so nothing has been changed. Quit the game and try again.",
      );
      return;
    }

    let running = actions;
    let held: string | null = null;
    if (applying && !closing && deferred.length > 0 && (await isSteamRunning())) {
      running = now;
      const one = deferredFor.length === 1;
      held =
        `Steam is running, so ${deferredFor.length} repair${one ? "" : "s"} needing it closed ` +
        `${one ? "was" : "were"} held back: ${deferredFor.join(", ")}. Close Steam and apply ` +
        `again to finish ${one ? "it" : "them"}.`;
      if (running.length === 0) {
        // Nothing to hold back against, so the note would only repeat the error beside it.
        setDeferredNote(null);
        setError(
          "Everything in this plan needs Steam closed, or it would be undone the moment Steam " +
            "exits. Close Steam and apply again. Nothing has been changed.",
        );
        return;
      }
      setDeferredNote(held);
    } else {
      setDeferredNote(null);
    }

    setState("running");
    setError(null);
    setReport(null);
    setLines([
      {
        tone: "cmd",
        text: applying
          ? `rimdoc apply --actions ${running.length}${closing ? " --restart-steam" : ""}`
          : `rimdoc rollback --targets ${targetsOf(actions).length}`,
      },
    ]);
    setProgress({ done: 0, total: applying ? running.length : targetsOf(actions).length });
    setConsoleOpen(true);
    startFlushing();

    // Said in the transcript as well as beside the button, because the transcript is what is
    // on screen while the run happens and is the only place the reason would be looked for.
    if (held) push({ tone: "warn", label: "held", text: held });

    const off = await watchRepair({
      onBackup: (dir) =>
        push({
          tone: "info",
          label: "backup",
          text: dir ? `saving original version of ${dir}` : "saving original version",
        }),
      onStart: (total) => {
        push({ tone: "info", label: "start", text: `${total} action${total === 1 ? "" : "s"} to carry out` });
        setProgress((p) => ({ ...p, total }));
      },
      onProgress: (p) => {
        push(lineOf(p));
        setProgress({ done: p.index, total: p.total });
      },
    });

    // Whether Steam was closed by this run, and so is this run's job to start again.
    // A Steam that was already down stays down: the player put it there.
    let closedSteam = false;
    let result: RunReport | null = null;
    let failure: string | null = null;

    try {
      if (closing) {
        push({
          tone: "work",
          label: "steam",
          text: "asking Steam to close, so it cannot undo this when it exits",
        });
        const shutdown = await stopSteam(workshop);
        closedSteam = shutdown.closed;
        push({ tone: "ok", label: "steam", text: shutdown.detail });
      }
      result = applying ? await runFileActions(running, config) : await rollback(targetsOf(actions));
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }

    // Started again whatever happened above, including when the repair threw. Leaving
    // someone's Steam closed because a file edit failed is a worse state than the one this
    // found, and it is the state they would be left staring at.
    if (closedSteam) {
      push({ tone: "work", label: "steam", text: "starting Steam again" });
      try {
        await startSteam(workshop);
        push({ tone: "ok", label: "steam", text: "Steam is back up" });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        push({ tone: "warn", label: "steam", text: `Could not start Steam again: ${why}` });
      }
    }

    if (result) {
      off();
      stopFlushing();
      setReport(result);
      setState(applying ? "done" : "undone");
      setLines((current) => [
        ...current,
        {
          tone: result.failed > 0 ? "warn" : "done",
          label: "done",
          text: `${result.applied} ${applying ? "applied" : "restored"}, ${result.skipped} skipped${
            result.failed > 0 ? `, ${result.failed} failed` : ""
          }`,
        },
      ]);
      record(
        applying
          ? {
              kind: "repair",
              summary: `Applied ${result.applied} file change${result.applied === 1 ? "" : "s"}`,
              detail: `${result.skipped} skipped${result.failed > 0 ? `, ${result.failed} failed` : ""}. Backups in ${result.backup_dir}.`,
              targets: targetsOf(running),
            }
          : {
              kind: "rollback",
              summary: `Restored ${result.applied} file${result.applied === 1 ? "" : "s"}`,
              detail: result.skipped > 0 ? `${result.skipped} had no backup to restore` : undefined,
              targets: targetsOf(actions),
            },
      );
      // A half-applied Steam repair is the one case worth spelling out: the record can be
      // edited while the folder delete is refused, and Steam then comes back believing it
      // never had a mod whose folder is still sitting there.
      if (closing && result.failed > 0) {
        setError(
          `${result.failed} of ${result.applied + result.failed} changes failed. Steam has been ` +
            "started again, but check the transcript: this repair is two halves and one of them " +
            "may be left over.",
        );
      }
      // The install on disk is no longer what the app was told it was, so whoever owns the
      // scan is asked to take it again rather than the numbers quietly going stale.
      onApplied?.();
    } else {
      off();
      stopFlushing();
      const message = failure ?? "The run ended without saying why.";
      setError(message);
      setState(applying ? "idle" : "done");
      setLines((current) => [...current, { tone: "warn", label: "error", text: message }]);
    }
  }

  if (!inShell()) {
    return (
      <button className="btn" type="button" disabled title="Needs the desktop app">
        Apply {actions.length} directly
      </button>
    );
  }

  return (
    <>
      {state !== "done" && state !== "undone" && (
        <button
          className="btn primary"
          type="button"
          disabled={state === "running"}
          onClick={() => void run("apply")}
        >
          {state === "running" ? "Applying..." : `Apply ${actions.length} directly`}
        </button>
      )}
      {state !== "done" && state !== "undone" && deferred.length > 0 && steamUp && (
        <button
          className="btn go"
          type="button"
          disabled={state === "running"}
          title={
            "Steam holds its download record in memory and rewrites it on exit, so it has to be " +
            "closed for this. Closing and starting it again is all this does; your subscriptions " +
            "and downloads are untouched."
          }
          onClick={() => void run("restart-steam")}
        >
          {state === "running" ? "Working..." : `Close Steam, apply ${actions.length}, start it again`}
        </button>
      )}
      {(state === "done" || state === "undone") && (
        <button className="btn" type="button" onClick={() => void run("undo")} disabled={state === "undone"}>
          {state === "undone" ? "Undone" : "Undo this run"}
        </button>
      )}
      {report && !consoleOpen && (
        <button className="btn" type="button" onClick={() => setConsoleOpen(true)}>
          Show transcript
        </button>
      )}
      {report && (
        <span className="repair-note">
          {report.applied} applied, {report.skipped} skipped
          {report.failed > 0 ? `, ${report.failed} failed` : ""}. Backups in {report.backup_dir}.
        </span>
      )}
      {deferredNote && <span className="repair-note warn-line">{deferredNote}</span>}
      {error && !consoleOpen && <span className="prompt-error">{error}</span>}
      {consoleOpen && (
        <RepairConsole
          lines={lines}
          done={progress.done}
          total={progress.total}
          report={report}
          error={error}
          onClose={() => setConsoleOpen(false)}
        />
      )}
    </>
  );
}
