import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsBetween } from './schedule.js';
import { addTrack, emptyState, playheadAt, setTrackStatus, toggleCell, updatePlayback, type State } from '../state/state.js';

const ME = 1;

/** kick on steps 1 and 5, snare on 5, playing from step 0 at session time 1000 (120 BPM: 125 ms steps). */
function beat(): State {
  let s = addTrack(addTrack(emptyState(), ME, 'kick', 'kick'), ME, 'snare', 'snare');
  s = toggleCell(toggleCell(s, ME, 'kick', 0), ME, 'kick', 4);
  s = toggleCell(s, ME, 'snare', 4);
  return updatePlayback(s, ME, 1000, { playing: true });
}

test('steps in a range, with the tracks that hit on each', () => {
  const hits = stepsBetween(beat(), 1000, 1000 + 5 * 125);
  assert.deepEqual(hits.map((h) => [h.k, h.time, h.step, h.tracks]), [
    [0, 1000, 0, ['kick']],
    [1, 1125, 1, []],
    [2, 1250, 2, []],
    [3, 1375, 3, []],
    [4, 1500, 4, ['kick', 'snare']],
  ]);
});

test('the range is start-inclusive and end-exclusive, and steps wrap at the step count', () => {
  const s = beat();
  assert.deepEqual(stepsBetween(s, 1001, 1125).map((h) => h.k), []);
  assert.deepEqual(stepsBetween(s, 1125, 1126).map((h) => h.k), [1]);
  const lap = stepsBetween(s, 1000 + 16 * 125, 1000 + 17 * 125); // 16 steps by default
  assert.deepEqual(lap.map((h) => [h.step, h.tracks]), [[0, ['kick']]]);
});

test('muted tracks and stopped playback make no sound', () => {
  assert.deepEqual(stepsBetween(setTrackStatus(beat(), ME, 'snare', 'muted'), 1500, 1501)[0].tracks, ['kick']);
  assert.deepEqual(stepsBetween(updatePlayback(beat(), ME, 1200, { playing: false }), 0, 5000), []);
});

test('the sound and the playhead agree on the step', () => {
  const s = beat();
  for (const h of stepsBetween(s, 1000, 4000)) assert.equal(playheadAt(s, h.time), h.step);
});
