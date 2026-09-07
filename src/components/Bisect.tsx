import { useState } from "react";
import type { ScanResult } from "../lib/types";
import type { Modpack } from "../lib/modpacks";
import { toModsConfigXml } from "../lib/modpacks";
import { configDir } from "../lib/repair/repairs";
import { applyModsConfig, inShell, launchGame } from "../lib/shell";
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
  const { confirm, dialog } = useConfirm();
  const shell = inShell();
  const config = configDir(scan);

  function commit(next: BisectSession | null) {
    setSession(next);
    saveBisect(next);
  }

  /** Write a load order and hand the player the game to judge it with. */
  async function runTrial(order: string[], label: string) {
    if (!config || !scan.paths.game) return;
    setBusy(true);
    setStatus(null);
    try {
      await applyModsConfig(`${config}/ModsConfig.xml`, toModsConfigXml(order, scan.gameVersion));
      await launchGame(scan.paths.game);
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
      detail: "Halving the load order to find what is causing a fault",
    });
    await runTrial(trialOrder(next, scan.mods), "Trial 1");
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
      <section className="bisect">
        {dialog}
        <header className="panel-head">
          <h3>Nothing here explains it?</h3>
        </header>
        <p className="muted">
          Triage repairs what the rules can name. When the game crashes or drags and nothing on disk says why,
          the way to find it is to halve the list, run the game, and halve again.
        </p>
        <div className="repair-actions">
          <button
            className="btn primary"
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
