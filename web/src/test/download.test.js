import { test } from 'node:test';
import assert from 'node:assert/strict';
import { save } from '../lib/download.js';

const saveToDisk = (session, file) => save(session, file, 'picker');

// The picker creates the file on disk as soon as a location is chosen ; the writable only buffers
// into a swap file until close(). The double keeps to the surface Chromium exposes and download.js
// uses : showSaveFilePicker → handle { createWritable, remove } → writable { write, abort, close }.
function fakeDisk({ failWrite = false } = {}) {
  const disk = { exists: false, bytes: 0, closed: false, aborted: false };
  globalThis.window = {
    async showSaveFilePicker() {
      disk.exists = true;
      let swap = 0;
      return {
        async createWritable() {
          return {
            async write(buffer) {
              if (failWrite) throw new Error('disque plein');
              swap += buffer.byteLength;
            },
            async abort() { disk.aborted = true; },
            async close() { disk.bytes = swap; disk.closed = true; },
          };
        },
        async remove() { disk.exists = false; },
      };
    },
  };
  return disk;
}

// session.download(link, sink) feeds `chunks` then settles with `outcome` (or throws `error`).
const fakeSession = ({ chunks = 2, outcome = 'end', error = null } = {}) => ({
  cancelled: false,
  cancel() { this.cancelled = true; },
  async download(_link, sink) {
    sink.start(chunks * 4);
    for (let i = 0; i < chunks; i++) sink.chunk(new ArrayBuffer(4));
    await new Promise((r) => setTimeout(r, 0));
    if (error) throw error;
    return this.cancelled ? 'cancelled' : outcome;
  },
});

const file = { link: 'https://alldebrid/l/1', name: 'ep01.mkv' };

test('end : the file stays, closed with every byte', async () => {
  const disk = fakeDisk();
  assert.equal(await saveToDisk(fakeSession(), file), 'end');
  assert.deepEqual(disk, { exists: true, bytes: 8, closed: true, aborted: false });
});

test('picker closed : aborted, nothing asked of the server, no file', async () => {
  globalThis.window = {
    async showSaveFilePicker() {
      throw Object.assign(new Error('closed'), { name: 'AbortError' });
    },
  };
  let calls = 0;
  const session = { cancel() { calls++; }, async download() { calls++; return 'end'; } };
  assert.equal(await saveToDisk(session, file), 'aborted');
  assert.equal(calls, 0);
});

test('cancelled : no file left on disk, not even an empty one', async () => {
  const disk = fakeDisk();
  assert.equal(await saveToDisk(fakeSession({ outcome: 'cancelled' }), file), 'cancelled');
  assert.equal(disk.aborted, true);
  assert.equal(disk.closed, false);
  assert.equal(disk.exists, false);
});

test('transfer error : rethrown, no file left', async () => {
  const disk = fakeDisk();
  await assert.rejects(saveToDisk(fakeSession({ error: new Error('closed') }), file), /closed/);
  assert.equal(disk.exists, false);
});

test('write error : server transfer cancelled, error named, no file left', async () => {
  const disk = fakeDisk({ failWrite: true });
  const session = fakeSession();
  await assert.rejects(saveToDisk(session, file), /écriture impossible : disque plein/);
  assert.equal(session.cancelled, true);
  assert.equal(disk.exists, false);
});
