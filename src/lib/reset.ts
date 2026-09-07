/**
 * Putting the app back to how it arrived.
 *
 * Everything RimDoc+ remembers between runs lives in one place under one prefix: modpacks,
 * pins, run history, the bisect session in progress, benchmark results, the install baseline
 * it compares against, and the settings themselves. Nothing here touches the game, the
 * backups a repair took, or the vault. Those exist to undo real changes to a real install,
 * and a button about forgetting preferences has no business deleting them.
 */
const PREFIX = "rimdoc.";

/** Every key the app has stored, in the order the browser holds them. */
export function storedKeys(): string[] {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith(PREFIX));
  } catch {
    // A private window with storage blocked has nothing stored, which is also nothing to
    // clear. Reporting none is exactly right rather than a failure to report.
    return [];
  }
}

/**
 * Forget all of it, and report what went.
 *
 * Swept by prefix rather than from a list of keys, because those keys are declared across a
 * dozen modules and a list would go stale the first time someone added one. A reset that
 * silently missed a key would leave the app in a state no first run can produce, which is a
 * worse thing to offer than no button at all.
 */
export function resetApp(): string[] {
  const keys = storedKeys();
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* one key that will not go must not abandon the rest */
    }
  }
  return keys;
}
