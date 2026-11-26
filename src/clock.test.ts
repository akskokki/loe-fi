import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from './clock.js';

test('one round trip with symmetric delay gives the exact offset', () => {
  const c = new Clock();
  // The reference is 100 ms ahead; 5 ms each way; it takes 1 ms to answer.
  const t0 = 1000;
  const t1 = t0 + 5 + 100;
  const t2 = t1 + 1;
  const t3 = t0 + 5 + 1 + 5;
  const sample = c.addSample(t0, t1, t2, t3);
  assert.equal(sample.offset, 100);
  assert.equal(sample.delay, 10);
  assert.equal(c.offset, 100);
});

test('the sample with the smallest delay wins', () => {
  const c = new Clock();
  c.addSample(0, 150, 150, 40); // slow and lopsided: offset 130, delay 40
  c.addSample(100, 202, 202, 104); // fast: offset 100, delay 4
  c.addSample(200, 330, 330, 260); // slow again: offset 100, delay 60
  assert.equal(c.offset, 100);
  assert.equal(c.delay, 4);
});

test('synced after three samples; resetting keeps the offset', () => {
  const c = new Clock();
  assert.equal(c.synced, false);
  for (let i = 0; i < 3; i++) c.addSample(i, i + 51, i + 51, i + 2); // offset 50, delay 2
  assert.equal(c.synced, true);
  c.resetSamples();
  assert.equal(c.synced, false);
  assert.equal(c.offset, 50); // session time does not jump when the reference changes
});

test('skew shifts the local clock and session time follows the offset', () => {
  const a = new Clock(0);
  const b = new Clock(500);
  assert.ok(Math.abs(b.local() - a.local() - 500) < 5);
  b.offset = -500;
  assert.ok(Math.abs(b.now() - a.now()) < 5);
});
