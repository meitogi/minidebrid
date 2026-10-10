<script>
  import { onMount } from 'svelte';
  import { DEFAULT_RELAY, KEY_RELAY, KEY_TOKEN, magnetFromHash, parseHash } from './lib/landing.js';
  import { connect } from './lib/peer.js';
  import { attachmentUrl, probe, save } from './lib/download.js';
  import { chooseMode } from './lib/save-mode.js';
  import { episodeLabel } from './lib/release.js';
  import { flattenFiles, formatSize, isExtra, matches, matchesEpisode, sortMagnets } from './lib/util.js';

  /** main.js : 'link' | 'setup' | 'app' (lib/landing.js) */
  let { start: landingKind } = $props();

  function load(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode : settings live for this page only */ }
  }

  const ERRORS = {
    relay: 'Relay injoignable.',
    absent: 'Aucun serveur sur le relay : serveur maison arrêté, ou pas encore reconnecté au relay.',
    timeout: 'Pas de connexion après 20 s : serveur muet ou réseau bloqué.',
    ice: 'Aucun chemin réseau direct vers le serveur (ICE échoué).',
    refused: 'Jeton refusé par le serveur : inconnu ou révoqué.',
    closed: 'Connexion au serveur perdue.',
  };

  let token = $state(load(KEY_TOKEN, ''));
  let relay = $state(load(KEY_RELAY, DEFAULT_RELAY));
  let view = $state('settings'); // settings | connecting | magnets | files
  let status = $state('');
  let error = $state('');
  let session = $state(null);
  let magnets = $state([]);
  let magnet = $state(null);
  let files = $state([]);
  let loading = $state(false);
  let transfers = $state({}); // link → {received, size, state, error}
  let links = $state({}); // link → {url, expires, copied}
  let downloading = $state(null); // link of the running P2P download
  let notice = $state(null); // {text, kind} : end-of-transfer banner, every mode
  let caps = $state(null); // what this browser can do for a P2P save (lib/download.js probe)
  let showToken = $state(false);
  const KEY_SHOW_ALL = 'debrid-remote:show-all';
  let showAll = $state(load(KEY_SHOW_ALL, '') === '1'); // side files (.nfo, samples…) shown too
  let magnetQuery = $state('');
  let fileQuery = $state('');
  let pushed = false; // the open magnet's #m= entry was pushed by this page : « ← Magnets » goes back to it

  const shownMagnets = $derived(magnetQuery.trim() ? magnets.filter((m) => matches(m.filename, magnetQuery)) : magnets);
  const extraCount = $derived(files.filter((f) => f.extra).length);
  const shownFiles = $derived(files.filter((f) => (showAll || !f.extra) && matchesEpisode(f.search, f.label, fileQuery)));
  let noticeTimer = null;

  function notify(text, kind = 'ok') {
    clearTimeout(noticeTimer);
    notice = { text, kind };
    noticeTimer = setTimeout(() => (notice = null), 6000);
  }

  // Before the probe answers, nothing qualifies : the link mode.
  const NO_CAPS = { picker: false, android: false, sw: false, opfs: false, webkit: null };
  probe().then((p) => {
    caps = p;
    console.log('debrid-remote : capacités de téléchargement', p);
  }, () => (caps = NO_CAPS));
  const modeFor = (size) => chooseMode(caps ?? NO_CAPS, size).mode;
  const usualMode = $derived(modeFor(1)); // a file of known size : what this browser mostly uses
  const HINTS = {
    picker: 'Téléchargement P2P : enregistrement direct, vous choisissez l’emplacement.',
    sw: 'Téléchargement P2P : via le gestionnaire de téléchargements du navigateur.',
    opfs: 'Téléchargement P2P : copie temporaire dans le navigateur, puis téléchargement.',
    link: 'Ce navigateur ne sait pas écrire un fichier en flux : le téléchargement passe par le lien direct (via le tunnel).',
  };

  $effect(() => store(KEY_TOKEN, token));
  $effect(() => store(KEY_RELAY, relay));
  $effect(() => store(KEY_SHOW_ALL, showAll ? '1' : ''));

  // Connects once at load, never again by itself : after a failure or Déconnecter, the form stays.
  onMount(() => {
    if (landingKind === 'link') {
      const link = parseHash(location.hash);
      history.replaceState(history.state, '', location.pathname + location.search); // the token leaves the address bar
      const saved = token.trim();
      if (!saved || saved === link.token || confirm('Remplacer le jeton enregistré par celui du lien ?')) {
        token = link.token;
        if (link.relay) relay = link.relay;
      }
    }
    if (landingKind !== 'setup' && token.trim()) start();
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  });

  // Back / forward between the list (no #m=) and an open magnet (#m=<id>).
  function onPopState() {
    if (!session) return;
    const id = magnetFromHash(location.hash);
    const m = id === null ? null : magnets.find((x) => String(x.id) === id);
    if (m?.statusCode === 4) {
      pushed = true;
      openMagnet(m, false);
    } else {
      pushed = false;
      view = 'magnets';
    }
  }

  const bareUrl = () => location.pathname + location.search;

  /** After a (re)connection : the magnet named by #m= in the URL, if it is listed and ready. */
  function openFromHash() {
    const id = magnetFromHash(location.hash);
    if (id === null) return;
    const m = magnets.find((x) => String(x.id) === id);
    if (m?.statusCode === 4) return openMagnet(m, false);
    history.replaceState(history.state, '', bareUrl());
    notify(`Magnet ${id} introuvable ou pas encore prêt`, 'error');
  }

  function backToMagnets() {
    if (pushed) {
      pushed = false;
      history.back(); // popstate shows the list
      return;
    }
    history.replaceState(history.state, '', bareUrl());
    view = 'magnets';
  }

  function describe(e) {
    const known = ERRORS[e.code];
    return known ? `${known} (${e.message})` : e.message;
  }

  async function start() {
    error = '';
    view = 'connecting';
    try {
      session = await connect({
        relayUrl: relay.trim(),
        token: token.trim(),
        onStatus: (text) => (status = text),
        onClose: (e) => disconnect(describe(e)),
      });
    } catch (e) {
      error = describe(e);
      view = 'settings';
      return;
    }
    await refreshMagnets();
    openFromHash();
  }

  function disconnect(message = '') {
    session?.close();
    session = null;
    downloading = null;
    magnet = null;
    files = [];
    magnets = [];
    error = message;
    view = 'settings';
  }

  async function refreshMagnets() {
    loading = true;
    error = '';
    try {
      const data = await session.ad('/v4.1/magnet/status');
      magnets = sortMagnets(data?.magnets);
      view = 'magnets';
    } catch (e) {
      error = describe(e);
    } finally {
      loading = false;
    }
  }

  /** `push` : record #m=<id> as a new history entry (false : from the URL or the back button). */
  async function openMagnet(m, push = true) {
    loading = true;
    error = '';
    try {
      const data = await session.ad('/v4/magnet/files', { 'id[]': m.id });
      const list = data?.magnets ?? [];
      const found = list.find((x) => String(x.id) === String(m.id)) ?? list[0];
      if (!found) throw new Error(`magnet ${m.id} introuvable`);
      if (found.error) throw new Error(`${found.error.code} — ${found.error.message}`);
      if (magnet?.id !== m.id) fileQuery = '';
      magnet = m;
      files = flattenFiles(found.files).map((f) => {
        const label = episodeLabel(f, m.filename);
        return { ...f, label, extra: isExtra(f.path), search: `${f.path} ${label?.series ?? ''} ${label?.title ?? ''}` };
      });
      view = 'files';
      if (push) {
        history.pushState(null, '', `${bareUrl()}#m=${m.id}`);
        pushed = true;
      }
    } catch (e) {
      error = describe(e);
    } finally {
      loading = false;
    }
  }

  async function streamLink(file) {
    const link = file.link;
    const cached = links[link];
    if (cached && cached.expires - Date.now() > 60_000) return cached;
    const r = await session.streamUrl(link, file.name);
    links[link] = { url: r.url, expires: r.expires, copied: false, shown: false };
    return links[link];
  }

  async function copyLink(file) {
    error = '';
    try {
      const entry = await streamLink(file);
      try {
        await navigator.clipboard.writeText(entry.url);
        entry.copied = true;
        setTimeout(() => (entry.copied = false), 2000);
      } catch {
        entry.shown = true; // clipboard refused : show the URL, selectable by hand
      }
    } catch (e) {
      error = describe(e);
    }
  }

  /** No streamed write to disk here : the stream link with ?dl=1, started right away. */
  async function toggleLink(file) {
    error = '';
    try {
      const entry = await streamLink(file);
      entry.shown = !entry.shown;
    } catch (e) {
      error = describe(e);
    }
  }

  async function downloadDirect(file) {
    error = '';
    try {
      const entry = await streamLink(file);
      const a = document.createElement('a');
      a.href = attachmentUrl(entry.url);
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) {
      error = describe(e);
    }
  }

  async function downloadP2P(file, mode) {
    const link = file.link;
    console.log('debrid-remote : téléchargement P2P', file.name, chooseMode(caps ?? NO_CAPS, file.size));
    error = '';
    downloading = link;
    delete transfers[link]; // the bar shows once the download really began (first progress)
    try {
      const outcome = await save(session, file, mode, (received, size, phase) => {
        transfers[link] ??= { received: 0, size: file.size, state: 'en cours' };
        const t = transfers[link]; // the $state proxy, not the object just assigned
        t.received = received;
        t.size = size || file.size;
        if (phase === 'handoff') t.state = 'préparation du téléchargement';
      });
      if (outcome === 'aborted') delete transfers[link];
      else if (outcome === 'end') {
        transfers[link] ??= { received: 0, size: file.size };
        transfers[link].state = 'terminé';
        notify(`« ${file.name} » enregistré`);
      } else {
        transfers[link] ??= { received: 0, size: file.size };
        transfers[link].state = 'annulé';
        notify(`« ${file.name} » annulé`, 'muted');
      }
    } catch (e) {
      transfers[link] ??= { received: 0, size: file.size };
      const t = transfers[link];
      t.state = 'erreur';
      t.error = describe(e);
      notify(`« ${file.name} » : échec du téléchargement`, 'error');
    } finally {
      downloading = null;
    }
  }

  const percent = (t) => (t.size ? Math.min(100, Math.floor((t.received / t.size) * 100)) : 0);
  const formatDate = (ms) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
</script>

<main data-save-mode={caps ? usualMode : ''}>
  <header>
    <h1>Debrid Remote</h1>
    {#if session}
      <div class="conn">
        <span class="ice-path" title={session.path ? `${session.path.local} ${session.path.laddr ?? '?'} ↔ ${session.path.remote} ${session.path.raddr ?? '?'}` : ''}>
          {session.path?.label ?? 'connecté (chemin inconnu)'}
        </span>
        <button class="small secondary" onclick={() => disconnect()}>Déconnecter</button>
      </div>
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if view === 'settings'}
    <section class="settings">
      <label for="token">Jeton d’accès</label>
      <div class="secret">
        <input id="token" type={showToken ? 'text' : 'password'} autocomplete="off" spellcheck="false" bind:value={token} />
        <button type="button" id="show-token" class="secondary eye" aria-label={showToken ? 'Masquer le jeton' : 'Afficher le jeton'} aria-pressed={showToken} onclick={() => (showToken = !showToken)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
            {#if showToken}<line x1="3" y1="3" x2="21" y2="21" />{/if}
          </svg>
        </button>
      </div>
      <label for="relay">Relay de signalisation</label>
      <input id="relay" type="url" bind:value={relay} />
      <button id="connect" onclick={start} disabled={!token.trim() || !relay.trim()}>Se connecter</button>
    </section>
  {:else if view === 'connecting'}
    <section>
      <p class="status">{status}</p>
    </section>
  {:else if view === 'magnets'}
    <section>
      <div class="bar">
        <h2>Magnets ({shownMagnets.length === magnets.length ? magnets.length : `${shownMagnets.length} / ${magnets.length}`})</h2>
        <button class="small" onclick={refreshMagnets} disabled={loading}>Actualiser</button>
      </div>
      <input id="search" class="search" type="search" placeholder="Rechercher un magnet…" autocomplete="off" bind:value={magnetQuery} />
      {#if magnets.length === 0}
        <p class="muted">Aucun magnet sur le compte.</p>
      {:else if shownMagnets.length === 0}
        <p class="muted">Aucun résultat.</p>
      {/if}
      <ul class="list">
        {#each shownMagnets as m (m.id)}
          <li class="magnet">
            <button class="row" onclick={() => openMagnet(m)} disabled={loading || m.statusCode !== 4}>
              <span class="name">{m.filename}</span>
              <span class="meta">
                {formatSize(m.size)} · <span class:ready={m.statusCode === 4}>{m.status}</span>
                {#if m.uploadDate} · {formatDate(m.uploadDate * 1000)}{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {:else if view === 'files'}
    <section>
      <div class="bar">
        <button class="small secondary" onclick={backToMagnets} disabled={!!downloading}>← Magnets</button>
        <h2 class="magnet-name">{magnet.filename}</h2>
      </div>
      <p class="muted save-mode" data-mode={usualMode}>{HINTS[usualMode]}</p>
      <input id="search" class="search" type="search" placeholder="Rechercher : nom, s2e5, e5, s2…" autocomplete="off" bind:value={fileQuery} />
      {#if extraCount}
        <button id="show-all" class="small secondary" onclick={() => (showAll = !showAll)}>
          {showAll ? 'Masquer les fichiers annexes' : `Afficher tous les fichiers (${extraCount} masqué${extraCount > 1 ? 's' : ''})`}
        </button>
      {/if}
      {#if shownFiles.length === 0}
        <p class="muted">{fileQuery.trim() ? 'Aucun résultat.' : 'Seulement des fichiers annexes.'}</p>
      {/if}
      <ul class="list">
        {#each shownFiles as f (f.link)}
          {@const t = transfers[f.link]}
          {@const l = links[f.link]}
          {@const mode = modeFor(f.size)}
          <li class="file">
            {#if f.label}
              <div class="episode">{f.label.series ? `${f.label.series} · ` : ''}{f.label.code}{f.label.title ? ` — ${f.label.title}` : ''}</div>
            {/if}
            <div class="name" class:sub={!!f.label}>{f.path}</div>
            <div class="meta">{formatSize(f.size)}</div>
            <div class="actions">
              {#if mode !== 'link'}
                <button class="small dl-p2p" data-mode={mode} onclick={() => downloadP2P(f, mode)} disabled={!!downloading}>Télécharger</button>
              {:else}
                <button class="small dl-direct" onclick={() => downloadDirect(f)}>Télécharger</button>
              {/if}
              <button class="small secondary copy-link" onclick={() => copyLink(f)}>{l?.copied ? 'Copié ✓' : 'Copier le lien'}</button>
              <button class="small secondary show-link" onclick={() => toggleLink(f)}>{l?.shown ? 'Masquer le lien' : 'Voir le lien'}</button>
              {#if downloading === f.link}
                <button class="small danger" onclick={() => session.cancel()}>Annuler</button>
              {/if}
            </div>
            {#if t}
              <div class="progress">
                <progress max="100" value={percent(t)}></progress>
                <span>{formatSize(t.received)} / {formatSize(t.size)} · {t.state}</span>
                {#if t.error}<span class="error-inline">{t.error}</span>{/if}
              </div>
            {/if}
            {#if l?.shown}
              <div class="link">
                <span class="hint">expire le {formatDate(l.expires)}</span>
                <input class="url" readonly value={l.url} onfocus={(e) => e.currentTarget.select()} />
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if notice}
    <div class="notice {notice.kind}" role="status">{notice.text}</div>
  {/if}
</main>

<style>
  :global(:root) { color-scheme: dark; }
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #0f1115; color: #e6e6e6; }
  main { max-width: 820px; margin: 0 auto; padding: 16px 16px 64px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 0; color: #9ec5ff; overflow-wrap: anywhere; }
  .conn { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .ice-path { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #0e2f3a; color: #7fd8f0; }
  section { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 16px; margin-top: 12px; }
  label { display: block; font-size: 12px; color: #9aa0aa; margin: 8px 0 2px; }
  input { width: 100%; background: #0f1115; border: 1px solid #2a2f3a; color: #e6e6e6; border-radius: 6px; padding: 8px; font: 13px/1.4 ui-monospace, monospace; }
  button, .button { background: #2a6df4; color: #fff; border: 0; border-radius: 6px; padding: 8px 13px; font: 600 13px system-ui; cursor: pointer; text-decoration: none; display: inline-block; }
  #connect { margin-top: 14px; }
  .secret { display: flex; gap: 6px; }
  .eye { padding: 0 10px; line-height: 0; }
  .small { padding: 5px 11px; font-size: 12px; }
  .secondary { background: #2a2f3a; }
  .danger { background: #8a2b2b; }
  button:disabled { opacity: .45; cursor: default; }
  .bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar button:last-child { margin-left: auto; }
  .error { background: #3a0e0e; color: #f08f8f; border-radius: 8px; padding: 10px 12px; margin: 12px 0 0; }
  .error-inline { color: #f08f8f; }
  .status, .muted { color: #9aa0aa; font-size: 13px; }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { border-top: 1px solid #232833; padding: 10px 0; }
  .list li:first-child { border-top: 0; }
  .row { width: 100%; text-align: left; background: none; padding: 0; font: inherit; color: inherit; display: block; }
  .row:disabled { opacity: .6; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .name.sub { font-weight: 400; font-size: 12px; color: #9aa0aa; }
  .episode { font-weight: 600; overflow-wrap: anywhere; }
  .search { margin: 4px 0 8px; font-family: system-ui, sans-serif; }
  #show-all { margin-bottom: 8px; }
  .meta { color: #9aa0aa; font-size: 12px; display: block; }
  .ready { color: #7ff0b0; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .progress { margin-top: 6px; font-size: 12px; color: #9aa0aa; font-variant-numeric: tabular-nums; }
  progress { display: block; width: 100%; margin-bottom: 2px; }
  .notice { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: calc(100% - 32px); padding: 10px 14px; border-radius: 8px; background: #0e3a24; color: #7ff0b0; font-size: 14px; box-shadow: 0 4px 16px rgba(0, 0, 0, .4); overflow-wrap: anywhere; }
  .notice.muted { background: #2a2f3a; color: #e6e6e6; }
  .notice.error { background: #3a0e0e; color: #f08f8f; }
  .link { margin-top: 6px; }
  .hint { font-size: 12px; color: #9aa0aa; }
</style>
