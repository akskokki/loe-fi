import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_TIMEOUT_MS,
  COORDINATOR_TIMEOUT_MS,
  INITIAL_WAIT_MS,
  Election,
  type ElectionMsgType,
} from './election.js';
import type { NodeId } from '../state/state.js';

/** An Election for node `me` with fake members and a record of what it sent. */
function setup(t: TestContext, me: NodeId, live: NodeId[], opts: { canLead?: () => boolean } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent: [NodeId, ElectionMsgType][] = [];
  const members = { live };
  const e = new Election({
    me,
    liveMembers: () => members.live,
    send: (to, type) => sent.push([to, type]),
    canLead: opts.canLead ?? (() => true),
    log: () => {},
    nameOf: (id) => String(id),
    onChange: () => {},
  });
  return { e, sent, members };
}

test('the highest node wins at once and announces itself', (t) => {
  const { e, sent } = setup(t, 3, [1, 2]);
  e.start('test');
  assert.equal(e.reference, 3);
  assert.deepEqual(sent, [
    [1, 'COORDINATOR'],
    [2, 'COORDINATOR'],
  ]);
});

test('a lower node asks the higher ones and follows the COORDINATOR it gets', (t) => {
  const { e, sent } = setup(t, 1, [2, 3]);
  e.start('test');
  assert.deepEqual(sent, [
    [2, 'ELECTION'],
    [3, 'ELECTION'],
  ]);
  t.mock.timers.tick(ANSWER_TIMEOUT_MS / 2);
  assert.equal(sent.length, 4); // ELECTION sent a second time, in case UDP lost it
  e.receive('ANSWER', 3);
  e.receive('COORDINATOR', 3);
  t.mock.timers.tick(COORDINATOR_TIMEOUT_MS * 2);
  assert.equal(e.reference, 3);
  assert.equal(sent.length, 4); // no further election
});

test('no ANSWER means the node wins', (t) => {
  const { e, sent } = setup(t, 1, [2, 3]);
  e.start('test');
  t.mock.timers.tick(ANSWER_TIMEOUT_MS);
  assert.equal(e.reference, 1);
  assert.deepEqual(sent.slice(-2), [
    [2, 'COORDINATOR'],
    [3, 'COORDINATOR'],
  ]);
});

test('an ANSWER without a COORDINATOR leads to a new election', (t) => {
  const { e, sent } = setup(t, 1, [2]);
  e.start('test');
  e.receive('ANSWER', 2);
  sent.length = 0;
  t.mock.timers.tick(COORDINATOR_TIMEOUT_MS);
  assert.deepEqual(sent, [[2, 'ELECTION']]);
});

test('ELECTION from a lower node is answered and starts our own election', (t) => {
  const { e, sent } = setup(t, 2, [1, 3]);
  e.receive('ELECTION', 1);
  assert.deepEqual(sent, [
    [1, 'ANSWER'],
    [3, 'ELECTION'],
  ]);
});

test('a reference that times out triggers an election', (t) => {
  const { e, sent, members } = setup(t, 2, [1, 3]);
  e.receive('COORDINATOR', 3);
  members.live = [1]; // 3 is gone
  e.tick();
  assert.equal(e.reference, 2);
  assert.deepEqual(sent, [[1, 'COORDINATOR']]);
});

test('a higher node takes over from a lower reference only once it may lead', (t) => {
  let synced = false;
  const { e, sent } = setup(t, 5, [1], { canLead: () => synced });
  e.receive('COORDINATOR', 1); // not synced yet: follow 1 for now
  assert.equal(e.reference, 1);
  e.tick();
  assert.equal(e.reference, 1);
  synced = true;
  e.tick();
  assert.equal(e.reference, 5);
  assert.deepEqual(sent, [[1, 'COORDINATOR']]);
});

test('a new node waits for an existing reference before holding an election', (t) => {
  const { e, sent } = setup(t, 1, [2]);
  e.tick();
  assert.equal(sent.length, 0);
  t.mock.timers.tick(INITIAL_WAIT_MS);
  e.tick();
  assert.deepEqual(sent, [[2, 'ELECTION']]);
});

test('a COORDINATOR from a node lower than the live reference is ignored', (t) => {
  const { e } = setup(t, 1, [2, 3]);
  e.receive('COORDINATOR', 3);
  e.receive('COORDINATOR', 2); // e.g. 2 elected itself before it knew about 3
  assert.equal(e.reference, 3);
});

test('the reference answers a lower COORDINATOR by announcing itself again', (t) => {
  const { e, sent } = setup(t, 3, [1, 2]);
  e.start('test');
  sent.length = 0;
  e.receive('COORDINATOR', 2);
  assert.equal(e.reference, 3);
  assert.deepEqual(sent, [
    [1, 'COORDINATOR'],
    [2, 'COORDINATOR'],
  ]);
});
