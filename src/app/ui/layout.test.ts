// The mouse only works if hitTest() agrees with where things are drawn. These tests derive the
// drawn positions the same way App.tsx draws them (StepRow: three-character cells with a space
// after every fourth; control rows: segments one after another) and check every one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_WIDTH,
  CONTROLS_ROW,
  CONTROL_ROW_STEP,
  LABEL_WIDTH,
  PAD,
  TRACKS_ROW,
  controlRows,
  hitTest,
} from './layout.js';

/** Terminal mouse coordinates (1-based) of a content position (0-based, inside the padding). */
const at = (cx: number, cy: number): [number, number] => [cx + PAD + 1, cy + PAD + 1];

/** Column where step `s`'s cell starts, as StepRow draws it. */
const cellStart = (s: number) => LABEL_WIDTH + s * CELL_WIDTH + Math.floor(s / 4);

test('every character of every cell maps to that track and step', () => {
  const rows = controlRows(false, 120, 32);
  for (const track of [0, 1, 4]) {
    for (let step = 0; step < 32; step++) {
      for (let c = 0; c < CELL_WIDTH; c++) {
        const [x, y] = at(cellStart(step) + c, TRACKS_ROW + track);
        assert.deepEqual(
          hitTest(x, y, rows, 5, 32),
          { kind: 'cell', track, step },
          `track ${track} step ${step} char ${c}`,
        );
      }
    }
  }
});

test('the gaps between groups of four, steps past the end and rows past the last track hit nothing', () => {
  const rows = controlRows(false, 120, 16);
  for (const step of [3, 7, 11])
    assert.equal(hitTest(...at(cellStart(step) + CELL_WIDTH, TRACKS_ROW), rows, 2, 16), null);
  assert.equal(hitTest(...at(cellStart(16), TRACKS_ROW), rows, 2, 16), null);
  assert.equal(hitTest(...at(cellStart(0), TRACKS_ROW + 2), rows, 2, 16), null);
});

test('the track name selects the track', () => {
  const rows = controlRows(false, 120, 16);
  assert.deepEqual(hitTest(...at(0, TRACKS_ROW + 1), rows, 2, 16), { kind: 'track', track: 1 });
  assert.deepEqual(hitTest(...at(LABEL_WIDTH - 1, TRACKS_ROW + 1), rows, 2, 16), { kind: 'track', track: 1 });
});

test('every character of every button maps to its action, and nothing else on the control rows does', () => {
  for (const playing of [false, true]) {
    const rows = controlRows(playing, 95, 12);
    rows.forEach((row, r) => {
      const y = CONTROLS_ROW + r * CONTROL_ROW_STEP;
      let x = 0;
      for (const seg of row) {
        for (let c = 0; c < seg.text.length; c++) {
          const hit = hitTest(...at(x + c, y), rows, 2, 12);
          assert.deepEqual(hit, seg.action ? { kind: 'action', action: seg.action } : null, `"${seg.text}" char ${c}`);
        }
        x += seg.text.length;
      }
    });
  }
});

test('the blank lines between control rows hit nothing', () => {
  const rows = controlRows(false, 120, 16);
  for (let x = 0; x < 60; x++) assert.equal(hitTest(...at(x, CONTROLS_ROW + 1), rows, 2, 16), null);
});
