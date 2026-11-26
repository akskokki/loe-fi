import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOG_LINES, MAX_MEMBERS_SHOWN, fitToHeight } from './fit.js';

/**
 * Rows the UI draws for a fit: everything down to the member panel and the bottom padding
 * (`needed` minus its spare row), plus the log panel (blank line, title, lines) when it is shown.
 */
const drawn = (fit: ReturnType<typeof fitToHeight>) => fit.needed - 1 + (fit.logLines > 0 ? fit.logLines + 2 : 0);

test('a tall terminal shows every member up to the cap, and the whole log', () => {
  const fit = fitToHeight(60, 3, 4);
  assert.equal(fit.members, 4);
  assert.equal(fit.logLines, LOG_LINES);
  assert.equal(fit.tooSmall, false);
  assert.equal(fitToHeight(60, 3, 10).members, MAX_MEMBERS_SHOWN);
});

test('as the terminal shrinks, the log goes first, then members, then the grid gives way to a message', () => {
  let previous = fitToHeight(60, 3, 10);
  for (let rows = 59; rows >= 10; rows--) {
    const fit = fitToHeight(rows, 3, 10);
    assert.ok(fit.logLines <= previous.logLines && fit.members <= previous.members, `rows ${rows}`);
    if (fit.members < previous.members)
      assert.equal(fit.logLines, 0, `members shrank while log lines remain (rows ${rows})`);
    assert.ok(fit.members >= 1, 'this node is always listed');
    previous = fit;
  }
  assert.equal(fitToHeight(10, 3, 10).tooSmall, true);
});

test('whatever fits never needs more rows than the terminal has', () => {
  for (let rows = 10; rows <= 60; rows++) {
    for (const tracks of [0, 1, 5, 12]) {
      for (const members of [1, 3, 10]) {
        const fit = fitToHeight(rows, tracks, members);
        // One row stays spare, so the last line never scrolls the screen.
        if (!fit.tooSmall) assert.ok(drawn(fit) <= rows - 1, `rows ${rows}, tracks ${tracks}, members ${members}`);
      }
    }
  }
});

test('more tracks need a taller window', () => {
  assert.ok(fitToHeight(30, 8, 1).needed > fitToHeight(30, 1, 1).needed);
  assert.equal(fitToHeight(30, 8, 1).needed - fitToHeight(30, 1, 1).needed, 7);
});
