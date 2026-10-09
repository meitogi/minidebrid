// One test on the real type : two werift peers in-process, real DataChannel, real backpressure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { RTCPeerConnection } from 'werift';
import { sendStream } from '../src/chunker.js';

function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.iceGatheringStateChange.subscribe((s) => { if (s === 'complete') resolve(); });
  });
}

// 300 KB is the ROLLOUT vector ; it never crosses the 1 MB high-water mark, so 4 MB is added
// to drive the drain wait on the real channel (measured : peaks ~1 MB buffered, 4 drain events).
for (const [label, size] of [['300 KB', 300 * 1024], ['4 MB', 4 * 1024 * 1024]]) test(`${label} through a werift DataChannel arrive byte for byte`, { timeout: 30_000 }, async () => {
  const source = randomBytes(size);
  const offerer = new RTCPeerConnection({ iceServers: [] });
  const answerer = new RTCPeerConnection({ iceServers: [] });
  try {
    const received = [];
    let receivedBytes = 0;
    const allReceived = new Promise((resolve) => {
      offerer.createDataChannel('probe').onMessage.subscribe((data) => {
        received.push(data);
        receivedBytes += data.length;
        if (receivedBytes >= source.length) resolve();
      });
    });
    const serverChannel = new Promise((resolve) => {
      answerer.onDataChannel.subscribe((channel) => {
        if (channel.readyState === 'open') resolve(channel);
        else channel.stateChanged.subscribe((s) => { if (s === 'open') resolve(channel); });
      });
    });

    await offerer.setLocalDescription(await offerer.createOffer());
    await gathered(offerer);
    await answerer.setRemoteDescription(offerer.localDescription);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await gathered(answerer);
    await offerer.setRemoteDescription(answerer.localDescription);

    const channel = await serverChannel;
    let drains = 0;
    channel.bufferedAmountLow.subscribe(() => drains++);
    const body = new ReadableStream({
      start(ctrl) {
        for (let off = 0; off < source.length; off += 50_000) ctrl.enqueue(new Uint8Array(source.subarray(off, off + 50_000)));
        ctrl.close();
      },
    });
    assert.equal(await sendStream(channel, body), true);
    await allReceived;
    assert.ok(received.every((c) => Buffer.isBuffer(c)));
    assert.deepEqual(Buffer.concat(received), source);
    if (size > 1024 * 1024) assert.ok(drains > 0, 'backpressure never engaged');
  } finally {
    await offerer.close();
    await answerer.close();
  }
});
