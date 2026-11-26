// Which steps play when, in session time. Pure, so it can be tested without audio.
import { stepDurationMs, type State } from '../state/state.js';

export type Hit = {
  /** Steps since the playback anchor (the step that was playing at `playback.at`). */
  k: number;
  /** Session time at which this step starts, in ms. */
  time: number;
  /** Grid column, 0-based. */
  step: number;
  /** Track keys (preset names) with this step on, active tracks only. */
  tracks: string[];
};

/**
 * The steps that start in the session time range [from, to), with the active tracks that have a
 * hit on each. Uses the same anchor arithmetic as playheadAt(), so sound and playhead agree.
 */
export function stepsBetween(s: State, from: number, to: number): Hit[] {
  const p = s.playback.value;
  if (!p.playing) return [];
  const dur = stepDurationMs(p.bpm);
  const steps = s.settings.steps.value;
  const tracks = Object.entries(s.tracks).filter(([, t]) => t.status.value === 'active');
  const hits: Hit[] = [];
  for (let k = Math.max(0, Math.ceil((from - p.at) / dur)); p.at + k * dur < to; k++) {
    const step = (((p.step + k) % steps) + steps) % steps;
    hits.push({ k, time: p.at + k * dur, step, tracks: tracks.filter(([, t]) => t.cells[step].value).map(([key]) => key) });
  }
  return hits;
}
