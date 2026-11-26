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
export function stepsBetween(state: State, from: number, to: number): Hit[] {
  const playback = state.playback.value;
  if (!playback.playing) return [];
  const stepMs = stepDurationMs(playback.bpm);
  const steps = state.settings.steps.value;
  const activeTracks = Object.entries(state.tracks).filter(([, track]) => track.status.value === 'active');
  const hits: Hit[] = [];
  // k counts steps from the anchor; start at the first one at or after `from`.
  for (let k = Math.max(0, Math.ceil((from - playback.at) / stepMs)); playback.at + k * stepMs < to; k++) {
    const step = (((playback.step + k) % steps) + steps) % steps;
    hits.push({
      k,
      time: playback.at + k * stepMs,
      step,
      tracks: activeTracks.filter(([, track]) => track.cells[step].value).map(([key]) => key),
    });
  }
  return hits;
}
