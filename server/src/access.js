// Who may use the server right now : the token set (tokens.js), reloaded when the store changes,
// and the live DataChannels per token name, closed when their token is revoked.

import { dirname } from 'node:path';
import { authenticator, loadTokens, watchTokens } from './tokens.js';

export function createAccess({ file, appToken, delayMs, log = console.log }) {
  let set;
  try { set = loadTokens(file, appToken); } catch (e) {
    log(`tokens: ${file} ignored (${e.message}), APP_TOKEN only until it is fixed`);
    set = appToken ? { default: appToken } : {};
  }
  let authenticate = authenticator(set);
  const live = {}; // seq → {name, channel}
  let seq = 0;

  function onChange(next, { added, removed }) {
    set = next;
    authenticate = authenticator(next);
    let closed = 0;
    for (const key in live) {
      const entry = live[key];
      if (!Object.hasOwn(removed, entry.name)) continue;
      delete live[key];
      entry.channel.close();
      closed++;
    }
    const names = [];
    for (const name in added) names.push(`+ ${name}`);
    for (const name in removed) names.push(`- ${name}`);
    log(`tokens: ${names.join(', ')} (${closed} sessions closed)`);
  }

  let watcher = null;
  try { watcher = watchTokens(file, appToken, set, onChange, { delayMs, log }); } catch (e) {
    log(`tokens: ${dirname(file)} not watched (${e.message}) : token changes need a restart`);
  }

  return {
    /** Name of the token, and `channel` remembered under it ; null when the token is unknown. */
    admit(token, channel) {
      const name = authenticate(token);
      if (name) live[++seq] = { name, channel };
      return name;
    },
    /** Forget a closed channel. */
    release(channel) {
      for (const key in live) if (live[key].channel === channel) delete live[key];
    },
    tokens: () => set,
    close() { watcher?.close(); },
  };
}
