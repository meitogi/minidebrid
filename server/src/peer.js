// Relay WebSocket client + werift answerer. Derived from the proto's media-peer-ws-client.js :
// announces itself as kind=server under a peer id derived from APP_TOKEN, answers routed offers.

import { createHash } from 'node:crypto';
import { RTCPeerConnection } from 'werift';

const GATHER_CAP_MS = 4000;
const CONNECT_CAP_MS = 30_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/** `srv-` + 16 hex chars of sha256(token) ; the webapp derives the same id with WebCrypto. */
export function peerIdFromToken(token) {
  return 'srv-' + createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** '50000-50019' → [50000, 50019] ; anything else → undefined (werift picks ephemeral ports). */
export function parsePortRange(value) {
  const m = /^(\d+)-(\d+)$/.exec(value ?? '');
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

function waitGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.iceGatheringStateChange.subscribe((s) => { if (s === 'complete') resolve(); });
    setTimeout(resolve, GATHER_CAP_MS);
  });
}

/** Connects to the relay forever ; `onChannel(channel)` gets each opened DataChannel. */
export function startPeer({ relayUrl, peerId, stun, icePortRange, onChannel }) {
  const iceServers = stun ? [{ urls: stun }] : [];
  let ws = null;
  let backoff = BACKOFF_MIN_MS;

  const send = (obj) => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  };

  async function handleOffer(fromId, offerSdp) {
    const tag = fromId.slice(0, 10);
    const pc = new RTCPeerConnection({ iceServers, icePortRange });
    const giveUp = setTimeout(() => { if (pc.connectionState !== 'connected') pc.close(); }, CONNECT_CAP_MS);
    pc.connectionStateChange.subscribe((s) => {
      console.log(`peer ${tag}: ${s}`);
      if (s === 'failed') pc.close();
      if (s === 'connected' || s === 'closed') clearTimeout(giveUp);
    });
    pc.onDataChannel.subscribe((channel) => {
      const opened = () => onChannel(channel);
      if (channel.readyState === 'open') opened();
      channel.stateChanged.subscribe((s) => {
        if (s === 'open') opened();
        else if (s === 'closed') pc.close();
      });
    });
    await pc.setRemoteDescription(JSON.parse(offerSdp));
    await pc.setLocalDescription(await pc.createAnswer());
    await waitGathering(pc);
    const local = pc.localDescription;
    const sdp = JSON.stringify({ type: local.type, sdp: local.sdp });
    const ok = send({ type: 'signal', from: peerId, to: fromId, kind: 'answer', sdp, ts: Date.now() });
    console.log(`peer ${tag}: answer ${ok ? 'sent' : 'lost (relay closed)'}`);
  }

  function connect() {
    ws = new WebSocket(relayUrl);
    ws.addEventListener('open', () => {
      backoff = BACKOFF_MIN_MS;
      send({ type: 'hello', id: peerId, name: 'debrid-remote', kind: 'server', ts: Date.now() });
      console.log(`relay: connected, peerId=${peerId}`);
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type !== 'signal' || msg.to !== peerId || msg.kind !== 'offer') return;
      handleOffer(msg.from, msg.sdp).catch((e) => console.log(`peer: offer from ${msg.from} failed: ${e.message}`));
    });
    ws.addEventListener('error', () => console.log(`relay: error on ${relayUrl}`));
    ws.addEventListener('close', (event) => {
      console.log(`relay: closed (code ${event.code}), retry in ${backoff} ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    });
  }

  connect();
}
