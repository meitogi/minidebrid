#!/usr/bin/env node
// Access tokens of the home server : add <name> | list | revoke <name>.
// Writes the store the server watches (src/tokens.js) ; a running server applies changes within a
// second. Prints setup links : each one IS a credential, send it over a channel you trust.
//   TOKENS_FILE (default server/data/tokens.json), ENV_FILE (default server/.env),
//   WEBAPP_URL (default the Pages webapp), RELAY_URL (added to the link when not the default relay).

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPLICIT, NAME, newToken, readStore, writeStore } from '../src/tokens.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
try { process.loadEnvFile(env.ENV_FILE || join(ROOT, '.env')); } catch { /* no .env : container env or none */ }

const FILE = env.TOKENS_FILE || join(ROOT, 'data', 'tokens.json');
const WEBAPP_URL = (env.WEBAPP_URL || 'https://minidebrid.du.ranchchoco.boo').replace(/\/+$/, '') + '/';
const DEFAULT_RELAY = 'wss://signal.du.ranchchoco.boo'; // the webapp's default (web/src/App.svelte)
const relay = env.RELAY_URL && env.RELAY_URL !== DEFAULT_RELAY ? `&r=${encodeURIComponent(env.RELAY_URL)}` : '';
const appToken = env.APP_TOKEN;

const link = (token) => `${WEBAPP_URL}#t=${token}${relay}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function load() {
  try { return readStore(FILE, appToken); } catch (e) {
    return fail(`${FILE} is malformed (${e.message}) : fix it by hand, nothing was written`);
  }
}

function save(entries) {
  try {
    mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
    writeStore(FILE, entries);
  } catch (e) {
    fail(`cannot write ${FILE} (${e.code ?? e.message}) : its directory must be writable by this user — in the Linux container, uid 1000 (GUIDE § 7)`);
  }
}

function checkName(name) {
  if (name === IMPLICIT) fail(`"${IMPLICIT}" is APP_TOKEN from .env : pick another name`);
  if (!NAME.test(name ?? '')) fail(`bad name "${name ?? ''}" : letters, digits, . _ - (40 max), starting with a letter or digit`);
}

const [action, name] = process.argv.slice(2);

if (action === 'add') {
  checkName(name);
  const entries = load();
  if (Object.hasOwn(entries, name)) fail(`"${name}" already exists : revoke it first, or pick another name`);
  const token = newToken();
  entries[name] = { token, created: new Date().toISOString() };
  save(entries);
  console.log(`"${name}" added. Setup link — it is the credential itself, send it over a channel you trust :`);
  console.log(link(token));
} else if (action === 'list') {
  const entries = load();
  const rows = [];
  for (const n in entries) {
    const entry = entries[n];
    rows.push([n, entry.created.slice(0, 16).replace('T', ' '), link(entry.token)]);
  }
  if (appToken) rows.push([IMPLICIT, 'APP_TOKEN (.env)', link(appToken)]);
  if (!rows.length) console.log('no token yet : wtf debrid token add <name>');
  let width = 0;
  for (const row of rows) width = Math.max(width, row[0].length);
  for (const row of rows) console.log(`${row[0].padEnd(width)}  ${row[1].padEnd(16)}  ${row[2]}`);
} else if (action === 'revoke') {
  if (name === IMPLICIT) fail(`"${IMPLICIT}" is APP_TOKEN : remove it from .env and restart the server`);
  checkName(name);
  const entries = load();
  if (!Object.hasOwn(entries, name)) fail(`no token named "${name}" (wtf debrid token list)`);
  delete entries[name];
  save(entries);
  console.log(`"${name}" revoked : a running server closes its sessions and refuses it within a second.`);
} else {
  fail('usage : token.js add <name> | list | revoke <name>');
}
