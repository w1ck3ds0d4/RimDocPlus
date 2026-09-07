import { inShell, readModPreview } from "./shell";

/**
 * Resolved banners, keyed by path.
 *
 * A miss is cached as null alongside the hits: a mod without a readable banner is a
 * permanent fact for the session, and without this every reopen of the panel would retry a
 * read that has already failed.
 */
const cache = new Map<string, string | null>();

/**
 * Turn a scanned banner path into something an `<img>` can load.
 *
 * The two builds reach the same file by different routes, because neither can use the
 * other's: a browser cannot read the disk, and the desktop webview has no dev server. The
 * caller sees one promise either way.
 */
export async function loadPreview(path: string | undefined): Promise<string | null> {
  if (!path) return null;

  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  const src = await resolve(path);
  cache.set(path, src);
  return src;
}

async function resolve(path: string): Promise<string | null> {
  if (!inShell()) return `/__modfile?p=${encodeURIComponent(path)}`;
  try {
    return await readModPreview(path);
  } catch {
    // A banner is decoration. Losing one should never surface as an error next to the
    // findings, which are the part of this app that has to be trusted.
    return null;
  }
}
