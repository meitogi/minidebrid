// P2P download to disk : File System Access API (Chromium) as a streamed writable, never a Blob
// of the whole file. Without the API the caller offers the stream link with ?dl=1 instead.

export const canSaveToDisk = () => typeof window.showSaveFilePicker === 'function';

/**
 * Asks where to save `name`, then streams `session.download(link)` into it.
 * onProgress(received, size) after each chunk. Resolves 'end' | 'cancelled' | 'aborted'
 * ('aborted' = the user closed the picker, nothing was requested from the server).
 */
export async function saveToDisk(session, { link, name }, onProgress = () => {}) {
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: name });
  } catch (e) {
    if (e.name === 'AbortError') return 'aborted';
    throw e;
  }
  const writable = await handle.createWritable();
  let size = 0;
  let received = 0;
  // Writes queue in order inside the WritableStream ; close() waits for the queue.
  let writeError = null;
  const sink = {
    start(total) {
      size = total;
      onProgress(0, size);
    },
    chunk(buffer) {
      received += buffer.byteLength;
      writable.write(buffer).catch((e) => {
        if (writeError) return;
        writeError = e;
        session.cancel();
      });
      onProgress(received, size);
    },
  };
  let outcome;
  try {
    outcome = await session.download(link, sink);
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
  if (writeError) {
    await writable.abort().catch(() => {});
    throw new Error(`écriture impossible : ${writeError.message}`);
  }
  if (outcome === 'cancelled') {
    await writable.abort().catch(() => {});
    return outcome;
  }
  await writable.close();
  return outcome;
}

/** The stream link as an attachment, for browsers without showSaveFilePicker. */
export const attachmentUrl = (url) => url + (url.includes('?') ? '&' : '?') + 'dl=1';
