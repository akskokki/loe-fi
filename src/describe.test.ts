import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTrack, emptyState, heartbeat, toggleCell, type NodeId, type State } from './state.js';
import { describeChanges } from './describe.js';

const toggle = (s: State, me: NodeId, steps: number[]) => steps.reduce((acc, i) => toggleCell(acc, me, 'kick', i - 1), s);
const base = addTrack(emptyState(), 1, 'kick', 'kick');

test('a single step change is one line', () => {
  assert.deepEqual(describeChanges(base, toggle(base, 1, [3])), ['kick step 3 on (by 1)']);
});

test('many step changes collapse into one line with ranges', () => {
  const steps = Array.from({ length: 16 }, (_, i) => i + 1);
  assert.deepEqual(describeChanges(base, toggle(base, 1, steps)), ['kick steps 1-16 on (by 1)']);
  assert.deepEqual(describeChanges(base, toggle(base, 1, [1, 3, 4, 5, 10])), ['kick steps 1, 3-5, 10 on (by 1)']);
});

test('steps turned on and off, or by different nodes, get separate lines', () => {
  const before = toggle(base, 1, [1, 2]);
  const after = toggle(toggle(before, 1, [1, 3]), 2, [4]);
  assert.deepEqual(describeChanges(before, after), [
    'kick step 1 off (by 1)',
    'kick step 3 on (by 1)',
    'kick step 4 on (by 2)',
  ]);
});

test('changes name their author once the author has a member entry', () => {
  const named = heartbeat(base, 2, { name: 'alice', address: null, port: 7052 });
  assert.deepEqual(describeChanges(named, toggle(named, 2, [1])), ['kick step 1 on (by alice)']);
});
