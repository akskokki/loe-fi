// Tests for sample files: track keys, the store and the TCP transfer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SampleStore, MAX_SAMPLE_BYTES, sha256 } from './store.js';
import { fetchSample, serveSamples } from './transfer.js';
import { findTrack, soundOf } from './tracks.js';
import { trackNameFor } from './addfile.js';
import { addTrack, emptyState, setTrackStatus } from './state.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lofi-test-'));
const HASH = 'a'.repeat(64);

test('track keys name a preset or a sample hash; anything else has no sound', () => {
  assert.deepEqual(soundOf('preset:kick'), { kind: 'preset', preset: 'kick' });
  assert.deepEqual(soundOf(`sha256:${HASH}`), { kind: 'sample', hash: HASH });
  assert.equal(soundOf('preset:cowbell'), null);
  assert.equal(soundOf('sha256:../../etc/passwd'), null);
  assert.equal(soundOf('kick'), null);
});

test('findTrack goes by key, then unique name, then unique key prefix', () => {
  let s = addTrack(emptyState(), 1, 'preset:kick', 'kick');
  s = addTrack(s, 1, `sha256:${HASH}`, 'boom');
  s = addTrack(s, 1, `sha256:${'b'.repeat(64)}`, 'boom');
  assert.deepEqual(findTrack(s, 'preset:kick'), { key: 'preset:kick' });
  assert.deepEqual(findTrack(s, 'kick'), { key: 'preset:kick' });
  assert.ok('error' in findTrack(s, 'boom')); // two tracks are called boom
  assert.deepEqual(findTrack(s, 'sha256:aaaa'), { key: `sha256:${HASH}` });
  assert.ok('error' in findTrack(s, 'snare'));
  const deleted = setTrackStatus(s, 1, `sha256:${'b'.repeat(64)}`, 'deleted');
  assert.deepEqual(findTrack(deleted, 'boom'), { key: `sha256:${HASH}` }); // deleted tracks don't count
});

test('track names from file names are printable, dashed and short', () => {
  assert.equal(trackNameFor('/some/folder/my cowbell.wav'), 'my-cowbell');
  assert.equal(trackNameFor('a-really-long-sample-name.flac'), 'a-really-long-sa');
  assert.equal(trackNameFor('\u001b[31m.wav'), '[31m');
  assert.equal(trackNameFor('\u0007\u0007.wav'), 'sample'); // nothing printable left
});

test('the store keeps files under their own hash only', () => {
  const dir = tempDir();
  const store = new SampleStore(dir);
  const bytes = Buffer.from('some sound');
  const hash = store.put(bytes);
  assert.equal(hash, sha256(bytes));
  assert.ok(store.has(hash));
  assert.deepEqual(store.read(hash), bytes);
  assert.throws(() => store.put(Buffer.from('other sound'), hash), /does not match/);
  assert.throws(() => store.put(Buffer.alloc(MAX_SAMPLE_BYTES + 1)), /MB/);
  assert.deepEqual(store.list(), [hash]);
  fs.writeFileSync(path.join(dir, 'not-a-hash.wav'), 'x');
  assert.deepEqual(new SampleStore(dir).list(), [hash]); // found again on restart; other files ignored
});

test('a sample travels over TCP, and missing ones are refused', async () => {
  const holder = new SampleStore(tempDir());
  const bytes = Buffer.alloc(200_000, 7); // bigger than one TCP packet
  const hash = holder.put(bytes);
  const server = await serveSamples(holder, 0, () => {});
  const { port } = server.address() as AddressInfo;
  try {
    const got = await fetchSample('127.0.0.1', port, hash);
    assert.deepEqual(got, bytes);
    await assert.rejects(fetchSample('127.0.0.1', port, HASH), /doesn't have it/);
  } finally {
    server.close();
  }
});

test('fetching fails cleanly when nobody listens or the reply is cut short', async () => {
  await assert.rejects(fetchSample('127.0.0.1', 1, HASH, 2000));
  const net = await import('node:net');
  const liar = net.createServer((sock) => sock.end('OK 1000\nonly a few bytes'));
  await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(fetchSample('127.0.0.1', (liar.address() as AddressInfo).port, HASH), /got \d+ of 1000 bytes/);
  } finally {
    liar.close();
  }
});
