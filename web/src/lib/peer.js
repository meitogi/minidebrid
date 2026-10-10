// Browser side of the debrid-remote link : relay WebSocket client, WebRTC offerer, token
// handshake and RPC client over the DataChannel. Derived from the proto's webrtc-probe/test-ws.html.
// The server (server/src/rpc.js, peer.js) is the contract :
//   offer → answer, both non-trickle (gathering complete before sending), sdp = JSON string ;
//   first message {t:'auth', token} → {t:'auth', ok:true}, wrong token → channel closed ;
//   {id, m, p} → {id, r} | {id, e} ; download → {id, r:{size}}, binary chunks, then one
//   id-less {t:'end'} | {t:'cancelled'} | {t:'error', e} ; messages over 60 KB arrive as
//   {frag} frames, the last one {frag, last:true}.

const STUN = 'stun:stun.l.google.com:19302';
const GATHER_CAP_MS = 3000;
const CONNECT_CAP_MS = 20_000;
const PING_MS = 5000;
const SERVER_NAME = 'debrid-remote'; // server/src/peer.js hello : {name, kind: 'server'}, random id

/** Error with a `code` the UI maps to a message : relay | absent | timeout | ice | refused | closed. */
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function waitGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, GATHER_CAP_MS);
  });
}

function isPrivateAddr(a) {
  if (!a) return false;
  a = a.toLowerCase();
  if (a.endsWith('.local')) return true;
  if (a.includes(':')) return a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd') || a === '::1';
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^127\./.test(a) || /^169\.254\./.test(a);
}

/** ICE candidate address by priority, read from an SDP (getStats may hide addresses). */
function sdpAddrByPriority(sdp) {
  const byPriority = {};
  for (const line of sdp?.match(/a=candidate:[^\r\n]+/g) ?? []) {
    const m = line.match(/a=candidate:\S+ \d+ \S+ (\d+) (\S+) \d+ typ \S+/i);
    if (m) byPriority[m[1]] = m[2];
  }
  return byPriority;
}

/** Selected candidate pair → {local, remote, laddr, raddr, label}, or null. Ported from the probe. */
async function icePath(pc) {
  const stats = await pc.getStats();
  const pairs = {};
  const cands = {};
  let selectedId = null;
  stats.forEach((r) => {
    if (r.type === 'candidate-pair') pairs[r.id] = r;
    else if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
    else if (r.type === 'transport' && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId;
  });
  let pair = selectedId ? pairs[selectedId] : null;
  if (!pair) {
    for (const id in pairs) {
      const p = pairs[id];
      if (p.selected || (p.nominated && p.state === 'succeeded')) { pair = p; break; }
    }
  }
  if (!pair) return null;
  const l = cands[pair.localCandidateId];
  const r = cands[pair.remoteCandidateId];
  const local = l?.candidateType;
  const remote = r?.candidateType;
  const laddr = l?.address || l?.ip || sdpAddrByPriority(pc.localDescription?.sdp)[l?.priority] || null;
  const raddr = r?.address || r?.ip || sdpAddrByPriority(pc.remoteDescription?.sdp)[r?.priority] || null;
  let label;
  if (local === 'relay' || remote === 'relay') label = 'TURN (relay)';
  else if (local === 'host' && remote === 'host') label = isPrivateAddr(raddr) ? 'LAN direct' : 'P2P direct (IPv6/public)';
  else label = `P2P direct (${local}/${remote})`;
  return { local, remote, laddr, raddr, label };
}

/**
 * Connects through the relay to the first `debrid-remote` server it lists, then authenticates
 * with `token`. Resolves once the token is accepted
 * with a session : {peerId, path, call(m, p), ad(path, fields), streamUrl(link, name, fresh),
 * download(link, sink), cancel(), close()}. Rejects with an Error carrying `code`.
 * onStatus(text) reports progress ; onClose(error) fires once if an open session drops.
 */
export async function connect({ relayUrl, token, stun = STUN, onStatus = () => {}, onClose = () => {} }) {
  let peerId = null; // the server's relay id, read from the relay's welcome list
  const myId = 'web-' + crypto.randomUUID();

  let ws = null;
  let pc = null;
  let dc = null;
  let ping = null;
  let timer = null;
  let authed = false;
  let closed = false;

  const pending = {}; // id → {resolve, reject, download?: sink}
  let nextId = 1;
  let active = null; // running download : {sink, resolve, reject}
  let frags = null; // pieces of a fragmented message

  function sendWs(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function stopRelay() {
    clearInterval(ping);
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }

  function teardown() {
    closed = true;
    clearTimeout(timer);
    stopRelay();
    try { dc?.close(); } catch { /* already closed */ }
    try { pc?.close(); } catch { /* already closed */ }
  }

  function dropAll(error) {
    for (const id in pending) {
      pending[id].reject(error);
      delete pending[id];
    }
    if (active) {
      active.reject(error);
      active = null;
    }
  }

  function handle(msg) {
    const id = msg.id;
    if (id !== undefined) {
      const call = pending[id];
      if (!call) return;
      delete pending[id];
      if (msg.e !== undefined) return call.reject(new Error(msg.e));
      if (call.download) {
        active = { sink: call.download, resolve: call.resolve, reject: call.reject };
        return call.download.start(msg.r?.size ?? 0);
      }
      return call.resolve(msg.r);
    }
    const t = msg.t;
    if (!active || (t !== 'end' && t !== 'cancelled' && t !== 'error')) return;
    const done = active;
    active = null;
    if (t === 'error') done.reject(new Error(msg.e));
    else done.resolve(t);
  }

  function onData(data) {
    if (typeof data !== 'string') {
      active?.sink.chunk(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg?.frag === 'string') {
      (frags ??= []).push(msg.frag);
      if (!msg.last) return;
      const text = frags.join('');
      frags = null;
      try { msg = JSON.parse(text); } catch { return; }
    }
    handle(msg);
  }

  function call(m, p, download) {
    if (closed || dc?.readyState !== 'open') return Promise.reject(fail('closed', 'connexion fermée'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending[id] = { resolve, reject, download };
      dc.send(JSON.stringify({ id, m, p }));
    });
  }

  /** An open session dropped (channel closed, ICE failed) : reject everything, tell the UI once. */
  function lost() {
    if (closed) return;
    teardown();
    const error = fail('closed', 'connexion au serveur perdue');
    dropAll(error);
    onClose(error);
  }

  const session = {
    get peerId() { return peerId; },
    path: null,
    call: (m, p) => call(m, p),
    ad: (path, fields = {}) => call('ad', { path, fields }),
    /** fresh : a new Alldebrid unlock on the server too (« Regénérer le lien »). */
    streamUrl: (link, name, fresh = false) => call('streamUrl', { link, name, fresh }),
    /** sink : {start(size), chunk(ArrayBuffer)} ; resolves 'end' | 'cancelled'. */
    download: (link, sink) => {
      if (active) return Promise.reject(new Error('un téléchargement est déjà en cours'));
      return call('download', { link }, sink);
    },
    cancel: () => {
      if (dc?.readyState === 'open') dc.send(JSON.stringify({ t: 'cancel' }));
    },
    close: () => {
      if (closed) return;
      teardown();
      dropAll(fail('closed', 'connexion fermée'));
    },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (error) => {
      if (settled) return;
      settled = true;
      teardown();
      reject(error);
    };

    timer = setTimeout(() => abort(fail('timeout', 'pas de connexion après 20 s (serveur muet ou ICE bloqué)')), CONNECT_CAP_MS);

    async function offer() {
      onStatus('négociation WebRTC…');
      pc = new RTCPeerConnection({ iceServers: stun ? [{ urls: stun }] : [] });
      pc.addEventListener('connectionstatechange', () => {
        const state = pc.connectionState;
        if (state !== 'failed') return;
        if (!settled) abort(fail('ice', 'ICE échoué : aucun chemin réseau vers le serveur'));
        else lost();
      });
      dc = pc.createDataChannel('rpc');
      dc.binaryType = 'arraybuffer';
      dc.addEventListener('open', () => {
        onStatus('vérification du jeton…');
        dc.send(JSON.stringify({ t: 'auth', token }));
      });
      dc.addEventListener('message', (event) => {
        if (authed) return onData(event.data);
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg?.t !== 'auth' || !msg.ok) return;
        authed = true;
        clearTimeout(timer);
        stopRelay(); // signaling done ; the relay is idle from here
        icePath(pc).catch(() => null).then((path) => {
          session.path = path;
          settled = true;
          resolve(session);
        });
      });
      dc.addEventListener('close', () => {
        if (!authed) return abort(fail('refused', 'jeton refusé par le serveur'));
        lost();
      });
      await pc.setLocalDescription(await pc.createOffer());
      await waitGathering(pc);
      if (settled) return;
      const local = pc.localDescription;
      sendWs({ type: 'signal', from: myId, to: peerId, kind: 'offer', sdp: JSON.stringify({ type: local.type, sdp: local.sdp }), ts: Date.now() });
      onStatus('offre envoyée, attente de la réponse…');
    }

    onStatus('connexion au relay…');
    try {
      ws = new WebSocket(relayUrl);
    } catch (e) {
      return abort(fail('relay', `URL du relay invalide : ${e.message}`));
    }
    ws.addEventListener('open', () => {
      sendWs({ type: 'hello', id: myId, name: 'debrid-remote-web', kind: 'client', ts: Date.now() });
      ping = setInterval(() => sendWs({ type: 'ping', ts: Date.now() }), PING_MS);
    });
    ws.addEventListener('error', () => abort(fail('relay', `relay injoignable : ${relayUrl}`)));
    ws.addEventListener('close', () => {
      if (!authed) abort(fail('relay', 'relay fermé avant la connexion'));
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const type = msg.type;
      if (type === 'welcome') {
        for (const p of msg.peers ?? []) {
          if (p.kind === 'server' && p.name === SERVER_NAME) { peerId = p.id; break; }
        }
        if (!peerId) return abort(fail('absent', 'aucun serveur debrid-remote sur le relay'));
        offer().catch((e) => abort(fail('ice', `négociation impossible : ${e.message}`)));
      } else if (type === 'signal' && msg.to === myId && msg.from === peerId && msg.kind === 'answer') {
        onStatus('réponse reçue, connexion ICE…');
        pc.setRemoteDescription(JSON.parse(msg.sdp)).catch((e) => abort(fail('ice', `réponse invalide : ${e.message}`)));
      }
    });
  });
}
