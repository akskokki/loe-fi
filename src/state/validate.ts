// Checks for state that comes from the network. This is the trust boundary: merge() assumes its
// input has exactly the shape of State, so every incoming copy goes through isState() first, and
// names that end up on the terminal must not carry control characters (escape sequences).
// Everything here takes `unknown`, so the checks themselves are type-checked as they narrow it.
import { isHash } from '../samples/hash.js';
import { MAX_STEPS, type State } from './state.js';

export const MAX_NAME_LENGTH = 16;

/**
 * 1..MAX_NAME_LENGTH printable characters with no leading or trailing spaces. Names come from the
 * network and are printed to the terminal, so control characters (escape sequences) are refused.
 */
export function isValidName(x: unknown): x is string {
  return (
    typeof x === 'string' &&
    x.length >= 1 &&
    x.length <= MAX_NAME_LENGTH &&
    x === x.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(x)
  );
}

/** A plain object (not null, not an array), whose fields are still unchecked. */
export const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const isWholeNumber = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

const isStamp = (x: unknown) => isObject(x) && isWholeNumber(x.ver) && x.ver >= 0 && typeof x.node === 'number';

/** A register: a value that passes `isValue`, with a version stamp. */
const isRegister = (x: unknown, isValue: (value: unknown) => boolean) =>
  isObject(x) && isStamp(x.stamp) && isValue(x.value);

const TRACK_STATUSES: unknown[] = ['active', 'muted', 'deleted'];

const isTrack = (track: unknown) =>
  isObject(track) &&
  isRegister(track.name, isValidName) &&
  isRegister(track.status, (status) => TRACK_STATUSES.includes(status)) &&
  Array.isArray(track.cells) &&
  track.cells.length === MAX_STEPS &&
  track.cells.every((cell: unknown) => isRegister(cell, (on) => typeof on === 'boolean'));

const isMemberInfo = (info: unknown) =>
  isObject(info) &&
  isValidName(info.name) &&
  (info.address === null || typeof info.address === 'string') &&
  isWholeNumber(info.port) &&
  Array.isArray(info.samples) &&
  info.samples.every(isHash);

const isPlayback = (playback: unknown) =>
  isObject(playback) &&
  typeof playback.playing === 'boolean' &&
  typeof playback.bpm === 'number' &&
  playback.bpm > 0 &&
  isWholeNumber(playback.step) &&
  playback.step >= 0 &&
  typeof playback.at === 'number';

const isStepCount = (steps: unknown) => isWholeNumber(steps) && steps >= 1 && steps <= MAX_STEPS;

/** True if x (e.g. parsed from a message) has exactly the shape merge() expects. Check before merging. */
export function isState(x: unknown): x is State {
  return (
    isObject(x) &&
    isObject(x.settings) &&
    isRegister(x.settings.steps, isStepCount) &&
    isRegister(x.playback, isPlayback) &&
    isObject(x.tracks) &&
    Object.values(x.tracks).every(isTrack) &&
    isObject(x.members) &&
    Object.values(x.members).every((member) => isRegister(member, isMemberInfo))
  );
}
