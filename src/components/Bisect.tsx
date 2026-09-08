import { useEffect, useRef, useState } from "react";
import type { ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { toModsConfigXml } from "../lib/modpacks";
import { configDir } from "../lib/repair/repairs";
import { applyModsConfig, inShell, launchSupervised, stopGame, watchGame } from "../lib/shell";
import {
  bootVerdict,
  describeVerdict,
  isBootFailure,
  isDecided,
  type BootResult,
  type FaultShape,
} from "../lib/bootCheck";
import { record } from "../lib/history";
import { useConfirm } from "./Confirm";
import {
  applyVerdict,
  isSettled,
  loadBisect,
  nameOf,
  pulledIn,
  saveBisect,
  startBisect,
  trialOrder,
  trialsLeft,
  type BisectSession,
} from "../lib/bisect";

/**
 * Find the mod responsible for a fault nothing else can name.
 *
 * Triage repairs what the rules can identify. This is for the rest: the game crashes, or
 * runs badly, and nothing on disk says why. Half the mods are switched off, the game is run,
 * and the answer to "is it still happening" halves the list again. About eight launches
 * settles a 224-mod list.
 *
 * The player supplies every verdict. Nothing here decides whether a fault is present, since
 * that would mean claiming to know what a fault looks like from outside the game.
 */
export function Bisect({ scan, modpack }: { scan: ScanResult; modpack: Modpack }) {
  const [session, setSession] = useState<BisectSession | null>(loadBisect);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  /**
   * What the search is looking for, which decides when a trial is over.
   *
   * A fault that stops the mod list loading is settled the moment the list loads. One that
   * needs a colony is not, so those trials are watched until the game closes and judged on
   * whether it died on the way.
   */
  const [lookingFor, setLookingFor] = useState<FaultShape>("load");
  const [boot, setBoot] = useState<BootResult | null>(null);
  const watching = useRef<(() => void) | null>(null);
  const transcript = useRef<string[]>([]);
  const { confirm, dialog } = useConfirm();
  const shell = inShell();
  const config = configDir(scan);

  function commit(next: BisectSession | null) {
    setSession(next);
    saveBisect(next);
  }

  useEffect(() => () => watching.current?.(), []);

  /**
   * Run a trial and judge it from the log, without asking.
   *
   * Only sound for a fault that stops the mod list loading, because that is the only thing
   * the log states plainly: the game either reaches mod construction or writes its own
   * admission that it gave up. Anything that goes wrong after the main menu looks identical
   * to a healthy boot from out here, which is why this is offered rather than assumed.
   *
   * The game is stopped as soon as the verdict lands. A trial has answered its question by
   * then, and sitting at the main menu answers nothing more.
   */
  async function runTrialAuto(order: string[], label: string): Promise<boolean> {
    if (!config || !scan.paths.game || !scan.paths.playerLog) return false;
    setBusy(true);
    setBoot(null);
    setStatus(`${label}: writing ${order.length} mods`);
    transcript.current = [];

    await applyModsConfig(`${config}/ModsConfig.xml`, toModsConfigXml(order, scan.gameVersion));

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (failed: boolean) => {
        if (settled) return;
        settled = true;
        watching.current?.();
        watching.current = null;
        setBusy(false);
        void stopGame();
        resolve(failed);
      };

      void watchGame({
        onLines: (batch) => {
          transcript.current.push(...batch);
          const result = bootVerdict(transcript.current);
          setStatus(`${label}: ${transcript.current.length} lines`);
          if (isDecided(result.verdict, lookingFor)) {
            setBoot(result);
            finish(isBootFailure(result.verdict));
          }
        },
        // The process going first is its own answer: gone without loading is a failure.
        onExited: (exit) => {
          const result = bootVerdict(transcript.current, exit.code);
          setBoot(result);
          finish(isBootFailure(result.verdict));
        },
      }).then((off) => {
        watching.current = off;
        void launchSupervised(scan.paths.game!, scan.paths.playerLog!).catch((e) => {
          setStatus(e instanceof Error ? e.message : String(e));
          finish(false);
        });
      });
    });
  }

  /** Drive the whole search, one trial at a time, until a single suspect is left. */
  async function runUnattended(from: BisectSession) {
    let current = from;
    while (!isSettled(current)) {
      const failed = await runTrialAuto(trialOrder(current, scan.mods), `Trial ${current.step}`);
      current = applyVerdict(current, failed ? "still-there" : "gone");
      commit(current);
    }
    record({
      kind: "order",
      summary: current.suspects.length
        ? `Narrowed a load failure to ${nameOf(current.suspects[0], scan)}`
        : "Narrowed a load failure to nothing in the mod list",
      detail: `${current.trials.length} trials, judged from the log`,
    });
  }

  /** Write a load order and hand the player the game to judge it with. */
  async function runTrial(order: string[], label: string) {
    if (!config || !scan.paths.game) return;
    setBusy(true);
    setStatus(null);
    try {
      await applyModsConfig(`${config}/ModsConfig.xml`, toModsConfigXml(order, scan.gameVersion));

      // Supervised even when a person is doing the judging. The trial is played either way,
      // and reading the log costs nothing on top of that: what it buys is the app being able
      // to say "this one crashed" instead of only asking whether it did.
      transcript.current = [];
      setBoot(null);
      watching.current?.();
      watching.current = await watchGame({
        onLines: (chunk) => {
          transcript.current.push(...chunk);
          const seen = bootVerdict(transcript.current);
          if (isBootFailure(seen.verdict)) setBoot(seen);
        },
        onExited: (exit) => setBoot(bootVerdict(transcript.current, exit.code)),
      });
      await launchSupervised(scan.paths.game, scan.paths.playerLog!);
      setStatus(`${label}: ${order.length} mods written, RimWorld starting`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    const ok = await confirm({
      title: "Start halving the mod list?",
      body: (
        <>
          <p>
            Each round switches off half the mods, writes that order into the game and starts it. You say
            whether the problem is still there, and the list halves again.
          </p>
          <p className="muted">
            About {trialsLeft(startBisect(modpack.activeOrder))} launches for {modpack.activeOrder.length}{" "}
            mods. Your load order is kept and put back when the search ends, however it ends. Only look for
            one thing at a time: halving cannot find a fault that needs two particular mods together.
          </p>
        </>
      ),
      confirmLabel: "Start the search",
    });
    if (!ok) return;

    const next = startBisect(modpack.activeOrder);
    commit(next);
    record({
      kind: "order",
      summary: `Started narrowing ${next.suspects.length} mods`,
      detail: auto
        ? "Halving the load order, judging each trial from the log"
        : "Halving the load order to find what is causing a fault",
    });
    if (auto) await runUnattended(next);
    else await runTrial(trialOrder(next, scan.mods), "Trial 1");
  }

  async function answer(verdict: "still-there" | "gone") {
    if (!session) return;
    const next = applyVerdict(session, verdict);
    commit(next);
    if (isSettled(next)) {
      record({
        kind: "order",
        summary: next.suspects.length
          ? `Narrowed the fault to ${nameOf(next.suspects[0], scan)}`
          : "Narrowed the fault to nothing in the mod list",
        detail: `After ${next.trials.length} trials`,
      });
      return;
    }
    await runTrial(trialOrder(next, scan.mods), `Trial ${next.step}`);
  }

  async function finish() {
    if (!session) return;
    const ok = await confirm({
      title: "Put your load order back?",
      body: <p>Restores the {session.original.length} mods the search started from and ends it.</p>,
      confirmLabel: "Restore and finish",
    });
    if (!ok) return;
    await runTrial(session.original, "Restored");
    record({ kind: "order", summary: "Restored the load order the search began from" });
    commit(null);
  }

  if (!session) {
    return (
      <section className="bisect offer">
        {dialog}
        {/*
          Louder than a section label. This is the way out when the rules have named nothing,
          and it sat at the bottom of the tab styled like every other heading.
        */}
        <header className="panel-head">
          <h3 className="call">Nothing here explains it?</h3>
        </header>
        <p className="muted">
          Triage repairs what the rules can name. When the game crashes or drags and nothing on disk says why,
          the way to find it is to halve the list, run the game, and halve again.
        </p>

        {/*
          Asked before the search starts, because it decides when a trial is over. A load
          fault is settled the moment the list loads; a fault that needs a colony is not, and
          treating the two the same is what made every post-menu trial pass.
        */}
        <fieldset className="fault-shape">
          <legend>What are you chasing?</legend>
          {(
            [
              ["load", "It stops the game loading", "The mod list fails, or the game dies before the menu"],
              ["play", "It happens once I am playing", "Loads fine, then crashes or drags in a colony"],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className={lookingFor === value ? "picked" : ""}>
              <input
                type="radio"
                name="fault-shape"
                checked={lookingFor === value}
                onChange={() => setLookingFor(value)}
              />
              <span>
                <b>{label}</b>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="repair-actions">
          <button
            className="btn warn"
            type="button"
            disabled={!shell || !config || modpack.activeOrder.length < 4}
            title={
              !shell
                ? "Needs the desktop app"
                : modpack.activeOrder.length < 4
                  ? "Too few mods for halving to tell you anything"
                  : "Halve the list and run the game"
            }
            onClick={() => void begin()}
          >
            Find the culprit
          </button>
          <span className="repair-note">
            Roughly {Math.max(1, Math.ceil(Math.log2(Math.max(2, modpack.activeOrder.length))))} launches.
            Your order is restored when the search ends.
          </span>
        </div>
        <label
          className="setting-toggle bisect-auto"
          title={
            "The log says plainly whether the game reached mod construction or gave up, which is what " +
            "makes an unattended verdict trustworthy. Anything that goes wrong after the main menu looks " +
            "the same as a healthy boot from out here, so leave this off for those."
          }
        >
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span className="switch" aria-hidden="true">
            <i />
          </span>
          <span className="setting-text">
            <b>Judge it for me</b>
            <small>
              Runs each trial and reads the log itself, without waiting for you to say what happened.
            </small>
          </span>
        </label>
      </section>
    );
  }

  const settled = isSettled(session);
  const culprit = session.suspects[0];
  const extra = pulledIn(session, scan.mods);

  return (
    <section className="bisect running">
      {dialog}
      <header className="panel-head">
        <h3>
          {settled ? "Search finished" : `Trial ${session.step}`}
          {!settled && <span className="count">{trialsLeft(session)} or so to go</span>}
        </h3>
        <button className="btn small" type="button" onClick={() => void finish()} disabled={busy}>
          {settled ? "Restore and finish" : "Stop and restore"}
        </button>
      </header>

      {settled ? (
        <div className="bisect-verdict">
          {culprit ? (
            <>
              <p>
                <b>{nameOf(culprit, scan)}</b> is the only mod left that was enabled every time the problem
                appeared, and absent every time it did not.
              </p>
              <p className="muted">
                Found in {session.trials.length} trials. That makes it responsible for what you were looking
                for, not faulty in general, and it may well be a clash with something else rather than the mod
                itself.
              </p>
            </>
          ) : (
            <p>
              No mod survived. The problem was present with the whole list and absent from every half, which
              usually means it needs two mods together, or that it is not in the mod list at all.
            </p>
          )}
        </div>
      ) : (
        <>
          <p>
            {session.testing.length} of {session.suspects.length} suspects are enabled, plus{" "}
            {session.pinned.length} that are never switched off.
            {extra.length > 0 && ` ${extra.length} more came along as dependencies.`}
          </p>
          <p className="muted">
            Run the game, then answer for the problem you started with. If the game will not start at all,
            that counts as still there.
          </p>
          <div className="repair-actions">
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => void answer("still-there")}
            >
              Still happening
            </button>
            <button className="btn primary" type="button" disabled={busy} onClick={() => void answer("gone")}>
              Gone
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void runTrial(trialOrder(session, scan.mods), `Trial ${session.step}`)}
            >
              {busy ? "Writing..." : "Run it again"}
            </button>
          </div>
        </>
      )}

      {boot && (
        <p className={isBootFailure(boot.verdict) ? "warn-line" : ""}>
          {describeVerdict(boot)}
          {boot.evidence && <span className="muted"> {boot.evidence}</span>}
        </p>
      )}

      {status && <p className="repair-note">{status}</p>}

      {session.trials.length > 0 && (
        <ol className="bisect-trials">
          {session.trials.map((t) => (
            <li key={t.step}>
              <span className="muted">Trial {t.step}</span>
              <span>{t.tested} suspects</span>
              <span className={t.verdict === "still-there" ? "bad" : "good"}>
                {t.verdict === "still-there" ? "still happening" : "gone"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
