// Text output for the headless peer: log lines for what a merge changed, and a text view of the grid.
import { memberName, playheadAt, type Stamp, type State } from './state.js';

/**
 * What changed between two versions of the state, one line per change. Relies on merge() and the
 * edit functions keeping the same object for every value that did not change.
 */
export function describeChanges(before: State, after: State): string[] {
  const out: string[] = [];
  const by = (s: Stamp) => `(by ${memberName(after, s.node)})`;
  const steps = after.settings.steps;
  if (steps !== before.settings.steps) out.push(`step count set to ${steps.value} ${by(steps.stamp)}`);
  const pb = after.playback;
  if (pb !== before.playback) out.push(`${pb.value.playing ? 'playing' : 'stopped'} at ${pb.value.bpm} BPM ${by(pb.stamp)}`);

  for (const [hash, track] of Object.entries(after.tracks)) {
    const name = track.name.value;
    const old = Object.hasOwn(before.tracks, hash) ? before.tracks[hash] : undefined;
    if (!old) {
      const on = track.cells.filter((c) => c.value).length;
      out.push(`track ${name} added (${track.status.value}, ${on} steps on)`);
      continue;
    }
    if (track.status !== old.status) out.push(`track ${name} ${track.status.value} ${by(track.status.stamp)}`);
    // One line per (on/off, author) instead of one per step, e.g. `kick steps 1-4, 9 on (by 2)`.
    const groups = new Map<string, number[]>();
    track.cells.forEach((cell, i) => {
      if (cell === old.cells[i]) return;
      const key = `${cell.value ? 'on' : 'off'} ${by(cell.stamp)}`;
      groups.set(key, [...(groups.get(key) ?? []), i + 1]);
    });
    for (const [key, nums] of groups) {
      out.push(`${name} ${nums.length === 1 ? 'step' : 'steps'} ${ranges(nums)} ${key}`);
    }
  }
  return out;
}

/** Sorted step numbers as text with consecutive runs collapsed, e.g. [1, 2, 3, 5] -> `1-3, 5`. */
function ranges(nums: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    const start = nums[i];
    while (nums[i + 1] === nums[i] + 1) i++;
    parts.push(nums[i] === start ? `${start}` : `${start}-${nums[i]}`);
  }
  return parts.join(', ');
}

/** The grid as text, e.g. `kick   active  x... x... x... x...`, with a ^ under the playhead. */
export function renderGrid(s: State, now: number): string[] {
  const steps = s.settings.steps.value;
  const p = s.playback.value;
  const head = playheadAt(s, now);
  const lines = [`${p.playing ? 'playing' : 'stopped'} · ${p.bpm} BPM · ${steps} steps · playhead on step ${head + 1}`];

  const tracks = Object.values(s.tracks)
    .filter((t) => t.status.value !== 'deleted')
    .sort((a, b) => a.name.value.localeCompare(b.name.value));
  if (tracks.length === 0) return [...lines, '(no tracks yet: add one with "add <name>")'];

  const row = (cell: (i: number) => string) =>
    Array.from({ length: steps }, (_, i) => cell(i) + (i % 4 === 3 ? ' ' : '')).join('');
  for (const t of tracks) {
    lines.push(`${t.name.value.padEnd(8)} ${t.status.value.padEnd(7)} ${row((i) => (t.cells[i].value ? 'x' : '.'))}`);
  }
  lines.push(`${''.padEnd(17)}${row((i) => (i === head ? '^' : ' '))}`);
  return lines;
}
