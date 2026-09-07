import { useState } from "react";
import { inShell, steamSubscribe } from "../lib/shell";
import { record } from "../lib/history";

/**
 * The Workshop item id a Steam link points at, or null if it points at something else.
 *
 * Read from the link the repair already carries rather than threaded through the plan,
 * because the plan's job is to say what to do and the id is already in what it says.
 */
export function workshopIdOf(url: string | undefined): string | null {
  if (!url) return null;
  const found = /[?&]id=(\d+)\b/.exec(url);
  return found ? found[1] : null;
}

/**
 * Subscribe to a Workshop item without leaving the app.
 *
 * The only thing here that presents itself to Steam as RimWorld. Subscribing goes through
 * the Steamworks API, that API authenticates by app id, and no `steam://` URL will do it:
 * the protocol can open a Workshop page and nothing more. So while the call runs, Steam
 * counts the app id as in use and shows the player as playing RimWorld.
 *
 * That is said on the button rather than buried in a document, because it is visible to
 * their friends and nothing else this app does is.
 */
export function Subscribe({
  gameDir,
  workshopId,
  onDone,
}: {
  /** The RimWorld install, which is where Valve's library is read from. */
  gameDir: string;
  workshopId: string;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      setSaid(await steamSubscribe(gameDir, workshopId));
      record({ kind: "modpack", summary: `Subscribed to Workshop item ${workshopId}` });
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!inShell()) return null;

  return (
    <>
      <button
        className="btn go"
        type="button"
        disabled={busy || said !== null}
        title="Steam shows you as playing RimWorld while this runs, because it is the only way to ask"
        onClick={() => void subscribe()}
      >
        {busy ? "Asking Steam..." : said ? "Asked" : "Subscribe"}
      </button>
      {said && <span className="repair-note">{said}</span>}
      {error && <span className="prompt-error">{error}</span>}
    </>
  );
}
