import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Membership, PEER_TIMEOUT_MS } from './membership.js';
import { wellFormed } from './messages.js';
import { emptyState, heartbeat, type NodeId, type State } from '../state/state.js';

const ME = 1,
  A = 2,
  B = 3;
const info = (port: number) => ({ name: `n${port}`, address: '10.0.0.9', port, samples: [] });
/** A state where member `id` has sent `beats` heartbeats. */
const withBeats = (s: State, id: NodeId, beats: number) => {
  for (let i = 0; i < beats; i++) s = heartbeat(s, id, info(7050 + id));
  return s;
};

test('an entry seen for the first time is not alive until its heartbeat moves', () => {
  const m = new Membership(ME, () => {});
  let s = withBeats(emptyState(), A, 3);
  assert.equal(m.update(s, 0), false);
  assert.deepEqual(m.live(), []);
  assert.equal(m.view(s).find((v) => v.id === A)?.status, 'not heard from');
  s = withBeats(s, A, 1);
  assert.equal(m.update(s, 1000), true);
  assert.deepEqual(m.live(), [A]);
});

test('a STATE straight from a node proves it is alive at once', () => {
  const m = new Membership(ME, () => {});
  const s = withBeats(emptyState(), A, 1);
  assert.equal(m.update(s, 0, A), true);
  assert.deepEqual(m.live(), [A]);
});

test('a member whose heartbeat stops is gone after the timeout, and back when it moves again', () => {
  const lines: string[] = [];
  const m = new Membership(ME, (l) => lines.push(l));
  let s = withBeats(emptyState(), A, 1);
  m.update(s, 0, A);
  assert.equal(m.update(s, PEER_TIMEOUT_MS), false); // not yet
  assert.equal(m.update(s, PEER_TIMEOUT_MS + 1), true);
  assert.deepEqual(m.live(), []);
  assert.equal(m.view(s, PEER_TIMEOUT_MS + 2001).find((v) => v.id === A)?.goneForMs, 2000);
  s = withBeats(s, A, 1);
  m.update(s, PEER_TIMEOUT_MS + 3000);
  assert.deepEqual(m.live(), [A]);
  assert.ok(lines.some((l) => l.includes('timed out')) && lines.some((l) => l.includes('is back')));
});

test('addresses: where packets came from beats the address in the entry', () => {
  const m = new Membership(ME, () => {});
  const s = withBeats(emptyState(), A, 1);
  assert.deepEqual(m.addressOf(s, A), { address: '10.0.0.9', port: 7052 });
  m.observe(A, { address: '192.168.1.5', port: 7052 });
  assert.deepEqual(m.addressOf(s, A), { address: '192.168.1.5', port: 7052 });
  assert.equal(m.addressOf(s, B), null);
});

test('targets: live and just-learned members, gone ones only when asked', () => {
  const m = new Membership(ME, () => {});
  let s = withBeats(withBeats(emptyState(), A, 1), B, 1);
  m.update(s, 0, A); // A alive; B only just learned about
  assert.equal(m.targets(s, false, 0).length, 2);
  assert.equal(m.targets(s, false, PEER_TIMEOUT_MS + 1).length, 1); // B: no longer "just learned"
  m.update(s, PEER_TIMEOUT_MS + 1); // A times out
  assert.equal(m.targets(s, false, PEER_TIMEOUT_MS + 1).length, 0);
  assert.equal(m.targets(s, true, PEER_TIMEOUT_MS + 1).length, 2); // with includeGone: everyone else
  s = withBeats(s, ME, 1);
  assert.ok(m.targets(s, true).every((t) => t.port !== 7051)); // never ourselves
});

test('message shape check', () => {
  assert.ok(wellFormed({ type: 'JOIN', from: 1, to: { address: 'x', port: 1 } }));
  assert.ok(wellFormed({ type: 'TIME_REPLY', from: 1, t0: 1, t1: 2, t2: 3 }));
  assert.ok(!wellFormed({ type: 'TIME_REPLY', from: 1, t0: 1, t1: 'soon', t2: 3 }));
  assert.ok(!wellFormed({ type: 'STATE', from: 1, to: { address: 'x', port: 1 }, state: {} }));
  assert.ok(!wellFormed({ type: 'HELLO', from: 1 }));
  assert.ok(!wellFormed({ type: 'JOIN', from: '1', to: { address: 'x', port: 1 } }));
});
