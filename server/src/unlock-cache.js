// Unlocked-URL cache shared by the stream server (http.js) and the RPC (rpc.js) : a regenerated
// stream link must not keep serving the previous Alldebrid URL.

const UNLOCK_TTL_MS = 6 * 3600 * 1000;

/** `unlock(link)` resolves a locked link into a direct URL. */
export function createUnlockCache(unlock, ttlMs = UNLOCK_TTL_MS) {
  const cache = {}; // locked link → {url, at}

  async function refresh(link) {
    const url = await unlock(link);
    cache[link] = { url, at: Date.now() };
    return url;
  }

  return {
    /** The cached direct URL, unlocked again once older than the TTL. */
    async get(link) {
      const hit = cache[link];
      return hit && Date.now() - hit.at < ttlMs ? hit.url : refresh(link);
    },
    /** A new Alldebrid unlock now, replacing the cached URL. */
    refresh,
    forget(link) {
      delete cache[link];
    },
  };
}
