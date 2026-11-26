import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTrack, emptyState, heartbeat, isState, merge, playheadAt, setSteps, setTrackStatus, stepDurationMs,
  toggleCell, updatePlayback, type NodeId, type State, type TrackStatus,
} from './state.js';

const A = 1, B = 2, C = 3;
const member = (port: number) => ({ address: '10.0.0.1', port, samples: [] });

test('the higher version wins, whichever node wrote it', () => {
  let a = addTrack(emptyState(), A, 'kick', 'kick.wav');
  a = toggleCell(a, A, 'kick', 0); // version 1 by A
  let b = merge(emptyState(), a);
  b = toggleCell(b, B, 'kick', 0); // version 2 by B: off again
  b = toggleCell(b, B, 'kick', 0); // version 3 by B: on
  b = toggleCell(b, B, 'kick', 0); // version 4 by B: off
  assert.equal(merge(a, b).tracks.kick.cells[0].value, false);
  assert.equal(merge(b, a).tracks.kick.cells[0].value, false);
});

test('equal versions: the higher node ID wins', () => {
  const base = addTrack(emptyState(), A, 'kick', 'kick.wav');
  const a = setTrackStatus(base, A, 'kick', 'muted'); // version 2 by A
  const c = setTrackStatus(base, C, 'kick', 'deleted'); // version 2 by C
  assert.equal(merge(a, c).tracks.kick.status.value, 'deleted');
  assert.equal(merge(c, a).tracks.kick.status.value, 'deleted');
});

test('an older copy cannot bring back a deleted track', () => {
  const old = toggleCell(addTrack(emptyState(), A, 'kick', 'kick.wav'), A, 'kick', 3);
  const deleted = setTrackStatus(merge(emptyState(), old), B, 'kick', 'deleted');
  assert.equal(merge(deleted, old).tracks.kick.status.value, 'deleted');
  assert.equal(merge(old, deleted).tracks.kick.status.value, 'deleted');
});

test('a member heartbeat never goes backwards', () => {
  let a = emptyState();
  for (let i = 0; i < 5; i++) a = heartbeat(a, A, member(7051));
  const stale = heartbeat(emptyState(), A, member(7051)); // version 1
  assert.equal(merge(a, stale).members[A].stamp.ver, 5);
  assert.equal(merge(stale, a).members[A].stamp.ver, 5);
});

test('merge does not modify its arguments', () => {
  const a = toggleCell(addTrack(emptyState(), A, 'kick', 'kick.wav'), A, 'kick', 1);
  const b = heartbeat(toggleCell(addTrack(emptyState(), B, 'kick', 'kick.wav'), B, 'kick', 2), B, member(7052));
  const [aCopy, bCopy] = [structuredClone(a), structuredClone(b)];
  merge(a, b);
  merge(b, a);
  assert.deepEqual(a, aCopy);
  assert.deepEqual(b, bCopy);
});

test('a network key "__proto__" does not change the prototype', () => {
  const evil = JSON.parse('{"settings":{},"playback":{"value":{},"stamp":{"ver":0,"node":0}},"tracks":{"__proto__":{"x":1}},"members":{}}');
  const merged = merge(emptyState(), evil);
  assert.equal(Object.getPrototypeOf(merged.tracks), Object.prototype);
});

test('isState accepts real states and rejects broken ones', () => {
  const good = heartbeat(toggleCell(addTrack(emptyState(), A, 'kick', 'kick.wav'), A, 'kick', 1), A, member(7051));
  assert.ok(isState(JSON.parse(JSON.stringify(good))));
  const broken = (edit: (s: any) => void) => {
    const s = JSON.parse(JSON.stringify(good));
    edit(s);
    return s;
  };
  assert.ok(!isState(broken((s) => { s.tracks.kick = {}; })));
  assert.ok(!isState(broken((s) => { s.tracks.kick.cells.pop(); })));
  assert.ok(!isState(broken((s) => { s.tracks.kick.status.value = 'gone'; })));
  assert.ok(!isState(broken((s) => { s.settings.steps.value = 0; })));
  assert.ok(!isState(broken((s) => { delete s.playback.value.bpm; })));
  assert.ok(!isState(broken((s) => { s.members[A].stamp = null; })));
  assert.ok(!isState({ type: 'STATE', from: 42, beat: 3, members: [] })); // the old connection-test message
});

// --- Convergence: merge must be commutative, associative and idempotent ---

// Small seeded random generator, so a failure can be reproduced.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const HASHES = ['kick', 'snare', 'hat'];
const STATUSES: TrackStatus[] = ['active', 'muted', 'deleted'];

function randomEdit(s: State, me: NodeId, r: () => number): State {
  const any = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const now = Math.floor(r() * 10_000);
  switch (Math.floor(r() * 6)) {
    case 0: return addTrack(s, me, any(HASHES), `${any(HASHES)}.wav`);
    case 1: return setTrackStatus(s, me, any(HASHES), any(STATUSES));
    case 2: return setSteps(s, me, 1 + Math.floor(r() * 32));
    case 3: return updatePlayback(s, me, now, { playing: r() < 0.5, bpm: 60 + Math.floor(r() * 120) });
    case 4: return heartbeat(s, me, member(7050 + me));
    default: return toggleCell(s, me, any(HASHES), Math.floor(r() * 32));
  }
}

// Three nodes edit their own copies and now and then receive another node's copy.
function randomReplicas(r: () => number): State[] {
  const ids = [A, B, C];
  const copies = ids.map(() => emptyState());
  for (let i = 0; i < 60; i++) {
    const n = Math.floor(r() * 3);
    if (r() < 0.2) copies[n] = merge(copies[n], copies[Math.floor(r() * 3)]);
    else copies[n] = randomEdit(copies[n], ids[n], r);
  }
  return copies;
}

test('merge is commutative, associative and idempotent', () => {
  const r = rng(42);
  for (let round = 0; round < 500; round++) {
    const [a, b, c] = randomReplicas(r);
    assert.deepEqual(merge(a, b), merge(b, a), `commutative, round ${round}`);
    assert.deepEqual(merge(merge(a, b), c), merge(a, merge(b, c)), `associative, round ${round}`);
    assert.deepEqual(merge(a, a), a, `idempotent, round ${round}`);
  }
});

test('copies converge whatever order the messages arrive in', () => {
  const r = rng(7);
  for (let round = 0; round < 200; round++) {
    const copies = randomReplicas(r);
    // Every node receives every other copy, each in its own random order.
    const results = copies.map((own) => {
      const others = copies.slice().sort(() => r() - 0.5);
      return others.reduce(merge, own);
    });
    assert.deepEqual(results[1], results[0], `round ${round}`);
    assert.deepEqual(results[2], results[0], `round ${round}`);
  }
});

// --- Playhead ---

test('the playhead advances with session time and wraps at the step count', () => {
  const step = stepDurationMs(120); // 125 ms
  let s = updatePlayback(emptyState(), A, 1000, { playing: true });
  assert.equal(playheadAt(s, 1000), 0);
  assert.equal(playheadAt(s, 1000 + 3 * step), 3);
  assert.equal(playheadAt(s, 1000 + 17 * step), 1); // 16 steps by default
  s = updatePlayback(s, A, 1000 + 5 * step, { playing: false });
  assert.equal(playheadAt(s, 99_999), 5); // stopped: stays put
});

test('a tempo change keeps the playhead where it is', () => {
  let s = updatePlayback(emptyState(), A, 0, { playing: true });
  const before = playheadAt(s, 1000);
  s = updatePlayback(s, A, 1000, { bpm: 60 });
  assert.equal(playheadAt(s, 1000), before);
  assert.equal(playheadAt(s, 1000 + stepDurationMs(60)), (before + 1) % 16);
});
