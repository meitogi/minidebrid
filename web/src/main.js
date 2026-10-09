import { mount } from 'svelte';
import App from './App.svelte';
import { KEY_TOKEN, REPO_URL, landing } from './lib/landing.js';

let savedToken = '';
try { savedToken = localStorage.getItem(KEY_TOKEN) ?? ''; } catch { /* storage blocked : nothing saved */ }

// Decided before mount, so a visitor without a token never sees the form flash.
const start = landing({ hash: location.hash, savedToken });
if (start === 'redirect') location.replace(REPO_URL);
else mount(App, { target: document.getElementById('app'), props: { start } });
