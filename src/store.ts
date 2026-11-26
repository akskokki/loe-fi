// The sample files this node holds, in a folder of files named by their SHA-256 hash. Files are
// only ever stored under the hash of their own contents, so a name from the network can never
// choose a path, and a file that doesn't match its hash is never kept.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isHash } from './tracks.js';

/** The design plan's "maximum of a few megabytes". */
export const MAX_SAMPLE_BYTES = 5 * 1024 * 1024;

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class SampleStore {
  private hashes = new Set<string>();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (isHash(f)) this.hashes.add(f);
  }

  has(hash: string): boolean {
    return this.hashes.has(hash);
  }

  /** Hashes of all samples held, sorted so the member entry doesn't change when nothing did. */
  list(): string[] {
    return [...this.hashes].sort();
  }

  read(hash: string): Buffer {
    if (!this.has(hash)) throw new Error(`no sample ${hash}`);
    return fs.readFileSync(path.join(this.dir, hash));
  }

  /**
   * Stores `bytes` under their hash. With `expected`, refuses bytes whose hash differs (a broken
   * or tampered transfer). Returns the hash.
   */
  put(bytes: Uint8Array, expected?: string): string {
    if (bytes.length === 0 || bytes.length > MAX_SAMPLE_BYTES) {
      throw new Error(`a sample must be 1 byte to ${MAX_SAMPLE_BYTES / 1024 / 1024} MB, this is ${bytes.length} bytes`);
    }
    const hash = sha256(bytes);
    if (expected !== undefined && hash !== expected) throw new Error(`content does not match hash ${expected.slice(0, 12)}…`);
    if (!this.has(hash)) {
      // Write to a temporary name and rename, so a crash never leaves a half-written file under a hash.
      const tmp = path.join(this.dir, `.${hash}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, path.join(this.dir, hash));
      this.hashes.add(hash);
    }
    return hash;
  }
}
