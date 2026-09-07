/** What kind of change an entry records, which is also how it is labelled and coloured. */
export type HistoryKind = "modpack" | "repair" | "order" | "rollback" | "launch";

export interface HistoryEntry {
  id: string;
  /** ISO timestamp. */
  at: string;
  kind: HistoryKind;
  /** One line, written for someone reading it a week later. */
  summary: string;
  detail?: string;
  /**
   * Paths a rollback would restore, for entries that touched disk. Recorded so the journal
   * can say what an undo would reach rather than only that something happened.
   */
  targets?: string[];
}

const KEY = "rimdoc.history.v1";

/**
 * How many entries are kept.
 *
 * A triage run can add several entries at once, so this is a few months of ordinary use.
 * The journal is a record of what was done to the install, not an audit log, and an
 * unbounded one would eventually be the largest thing in local storage.
 */
const LIMIT = 200;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append one entry and return the new journal, newest first.
 *
 * Reads through to storage rather than taking the caller's copy, because entries are
 * recorded from several places and a stale in-memory list would drop whichever change
 * happened to be written by the other one.
 */
export function record(entry: Omit<HistoryEntry, "id" | "at">): HistoryEntry[] {
  const next = [
    { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() },
    ...loadHistory(),
  ].slice(0, LIMIT);

  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a full or blocked store must not take the change with it */
  }
  return next;
}

export function clearHistory(): HistoryEntry[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
  return [];
}
