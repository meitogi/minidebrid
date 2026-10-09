// Environment rules shared by the server and its tests.

const REQUIRED = ['ALLDEBRID_APIKEY', 'PUBLIC_URL', 'RELAY_URL'];

/** Secret signing the stream links : STREAM_SECRET, else APP_TOKEN (links issued before the split). */
export function streamSecret(env) {
  return env.STREAM_SECRET || env.APP_TOKEN || null;
}

/** Names of the missing settings. Tokens are optional : the store may start empty. */
export function missingEnv(env) {
  const missing = [];
  for (const name of REQUIRED) if (!env[name]) missing.push(name);
  if (!streamSecret(env)) missing.push('STREAM_SECRET (or APP_TOKEN)');
  return missing;
}
