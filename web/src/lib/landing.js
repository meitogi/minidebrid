// What the page does on load, decided before mount (main.js) : no DOM here, `node --test`.
// Setup link : <webapp>#t=<token>[&r=<relay>]. `#setup` shows the form. No token saved and no
// link → the GitHub repo. This hides the app from casual visitors ; it is not a security boundary.

export const REPO_URL = 'https://github.com/meitogi/minidebrid';
export const DEFAULT_RELAY = 'wss://signal.du.ranchchoco.boo';
export const KEY_TOKEN = 'debrid-remote:token';
export const KEY_RELAY = 'debrid-remote:relay';

const LOCAL_HOSTS = { localhost: true, '127.0.0.1': true };

/** The relay URL when a link may set it : wss:, or ws: on this machine (local stack) ; else null. */
export function validRelay(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const protocol = url.protocol;
  if (!url.hostname) return null;
  if (protocol === 'wss:' || (protocol === 'ws:' && LOCAL_HOSTS[url.hostname])) return value;
  return null;
}

/** '#t=…&r=…' → {token, relay} ; '#setup' or an empty token → {setup: true} ; anything else → null. */
export function parseHash(hash) {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  const params = {};
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (Object.hasOwn(params, key)) continue;
    let value = '';
    try { value = decodeURIComponent(eq < 0 ? '' : part.slice(eq + 1)); } catch { /* malformed : empty */ }
    params[key] = value;
  }
  if (Object.hasOwn(params, 't')) {
    const token = params.t.trim();
    return token ? { token, relay: validRelay(params.r) } : { setup: true };
  }
  return Object.hasOwn(params, 'setup') ? { setup: true } : null;
}

/** 'link' | 'setup' | 'app' | 'redirect'. */
export function landing({ hash, savedToken }) {
  const parsed = parseHash(hash);
  if (parsed?.token) return 'link';
  if (parsed?.setup) return 'setup';
  return savedToken?.trim() ? 'app' : 'redirect';
}
