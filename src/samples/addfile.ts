// Adding a sample file from disk as a new track, shared by the UI and the headless peer.
import fs from 'node:fs';
import path from 'node:path';
import { AudioEngine } from '../audio/engine.js';
import type { PeerNode } from '../net/node.js';
import { MAX_NAME_LENGTH, isValidName } from '../state/validate.js';
import { MAX_SAMPLE_BYTES } from './store.js';

/**
 * A track name from a file name: without folder and extension, printable, spaces turned into
 * dashes (so commands like `t my-cowbell 1` can name it), at most MAX_NAME_LENGTH.
 */
export function trackNameFor(file: string): string {
  const base = path.basename(file, path.extname(file)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim().replace(/\s+/g, '-');
  const name = base.slice(0, MAX_NAME_LENGTH).trim();
  return isValidName(name) ? name : 'sample';
}

/**
 * Reads `file`, checks that it is at most MAX_SAMPLE_BYTES and decodes as audio, stores it and
 * adds a track for it. Returns the track key and, if the audio check couldn't run on this machine,
 * a note saying so. Throws with a readable message otherwise.
 */
export async function addSampleFile(node: PeerNode, file: string): Promise<{ key: string; note?: string }> {
  let bytes: Buffer;
  try {
    if (fs.statSync(file).size > MAX_SAMPLE_BYTES) throw new Error(`larger than ${MAX_SAMPLE_BYTES / 1024 / 1024} MB`);
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cannot use ${file}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message}`);
  }
  let note: string | undefined;
  try {
    await AudioEngine.decodeCheck(bytes);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.startsWith('cannot check')) throw new Error(`cannot use ${file}: ${msg}`);
    note = `could not check that it is audio (${msg.slice('cannot check: '.length)})`;
  }
  return { key: node.addSample(bytes, trackNameFor(file)), note };
}
