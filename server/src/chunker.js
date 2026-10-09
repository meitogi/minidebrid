// Sends a ReadableStream over a DataChannel in 16 KB binary chunks with backpressure.
// Values from the proto's media layer : pause above 1 MB buffered, resume at 256 KB.

export const CHUNK = 16 * 1024;
export const BP_HIGH = 1024 * 1024;
export const BP_LOW = 256 * 1024;

function waitDrain(channel, signal) {
  return new Promise((resolve) => {
    if (channel.bufferedAmount <= BP_LOW || signal?.aborted) return resolve();
    const done = () => {
      sub.unSubscribe();
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const sub = channel.bufferedAmountLow.subscribe(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Resolves true once every byte is handed to the channel, false if aborted or the channel closed. */
export async function sendStream(channel, readable, signal) {
  channel.bufferedAmountLowThreshold = BP_LOW;
  const reader = readable.getReader();
  const stop = () => reader.cancel().catch(() => {}); // a stalled read() must not outlive an abort
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return !signal?.aborted;
      const length = value.byteLength;
      const buf = Buffer.from(value.buffer, value.byteOffset, length);
      for (let off = 0; off < length; off += CHUNK) {
        if (signal?.aborted || channel.readyState !== 'open') return false;
        channel.send(buf.subarray(off, Math.min(off + CHUNK, length)));
        if (channel.bufferedAmount > BP_HIGH) await waitDrain(channel, signal);
      }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
  }
}
