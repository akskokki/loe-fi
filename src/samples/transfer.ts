// Sample file transfer over TCP, separate from the UDP sequencer messages so a transfer never holds
// them up. Pull-based, as in the design plan: a node that lacks a sample asks a member that lists
// it in its member entry.
//
// Each node listens for TCP on the same port number as its UDP socket. Protocol, one request per
// connection:
//   request:  "GET <sha256 hex>\n"
//   reply:    "OK <length>\n" followed by exactly <length> bytes,
//             or "NO\n" (don't have it) or "BUSY\n" (too many uploads at once; ask someone else)
// The receiver checks the bytes against the hash before keeping them (store.ts).
import net from 'node:net';
import { MAX_SAMPLE_BYTES, type SampleStore } from './store.js';
import { isHash } from './hash.js';

/** The plan: "A node can limit its concurrent uploads so it does not block on sequencer messages." */
export const MAX_UPLOADS = 2;
export const TRANSFER_TIMEOUT_MS = 10_000;
const MAX_HEADER = 100;

/** Serves samples from `store`. Resolves once listening; rejects if the port is taken. */
export function serveSamples(store: SampleStore, port: number, log: (line: string) => void): Promise<net.Server> {
  let uploads = 0;
  const server = net.createServer((sock) => {
    sock.setTimeout(TRANSFER_TIMEOUT_MS, () => sock.destroy());
    sock.on('error', () => {}); // the requester went away; nothing to do
    let header = '';
    const onData = (chunk: Buffer) => {
      header += chunk.toString('latin1');
      const end = header.indexOf('\n');
      if (end < 0) {
        if (header.length > MAX_HEADER) sock.destroy();
        return;
      }
      sock.off('data', onData);
      const [verb, hash] = header.slice(0, end).split(' ');
      if (verb !== 'GET' || !isHash(hash) || !store.has(hash)) return void sock.end('NO\n');
      if (uploads >= MAX_UPLOADS) return void sock.end('BUSY\n');
      uploads++;
      const bytes = store.read(hash);
      log(`-> sample ${hash.slice(0, 12)}… (${bytes.length} bytes) to ${sock.remoteAddress}`);
      sock.write(`OK ${bytes.length}\n`);
      sock.end(bytes);
      sock.on('close', () => uploads--);
    };
    sock.on('data', onData);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      server.on('error', (err) => log(`sample server error: ${err.message}`));
      resolve(server);
    });
  });
}

/** Fetches a sample's bytes from a member. Does not check the hash; SampleStore.put does. */
export function fetchSample(
  address: string,
  port: number,
  hash: string,
  timeoutMs = TRANSFER_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, address);
    const fail = (why: string) => {
      sock.destroy();
      reject(new Error(why));
    };
    sock.setTimeout(timeoutMs, () => fail('timed out'));
    sock.on('error', (err) => fail(err.message));
    sock.on('connect', () => sock.write(`GET ${hash}\n`));

    let buf = Buffer.alloc(0);
    let length: number | null = null;
    sock.on('data', (chunk: Buffer) => {
      // no encoding is set, so chunks are Buffers
      buf = Buffer.concat([buf, chunk]);
      if (length === null) {
        const end = buf.indexOf('\n');
        if (end < 0) return buf.length > MAX_HEADER ? fail('bad reply') : undefined;
        const [status, len] = buf.subarray(0, end).toString('latin1').split(' ');
        if (status !== 'OK')
          return fail(status === 'BUSY' ? 'busy' : status === 'NO' ? "doesn't have it" : 'bad reply');
        length = Number(len);
        if (!Number.isInteger(length) || length <= 0 || length > MAX_SAMPLE_BYTES) return fail('bad length');
        buf = buf.subarray(end + 1);
      }
      if (buf.length > length) return fail('too many bytes');
    });
    sock.on('end', () => {
      if (length !== null && buf.length === length) resolve(buf);
      else fail(length === null ? 'connection closed' : `got ${buf.length} of ${length} bytes`);
    });
  });
}
