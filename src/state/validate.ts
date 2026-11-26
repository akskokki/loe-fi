// Checks for state that comes from the network. This is the trust boundary: merge() assumes its
// input has exactly the shape of State, so every incoming copy goes through isState() first, and
// names that end up on the terminal must not carry control characters (escape sequences).
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

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStamp = (x: any) => isObj(x) && Number.isInteger(x.ver) && x.ver >= 0 && typeof x.node === 'number';
const isReg = (x: any, isValue: (v: any) => boolean) => isObj(x) && isStamp(x.stamp) && isValue(x.value);
const STATUSES = ['active', 'muted', 'deleted'];

const isTrack = (t: any) =>
  isObj(t) &&
  isReg(t.name, isValidName) &&
  isReg(t.status, (v) => STATUSES.includes(v)) &&
  Array.isArray(t.cells) &&
  t.cells.length === MAX_STEPS &&
  t.cells.every((c: any) => isReg(c, (v) => typeof v === 'boolean'));

const isMember = (m: any) =>
  isReg(
    m,
    (v) =>
      isObj(v) &&
      isValidName(v.name) &&
      (v.address === null || typeof v.address === 'string') &&
      Number.isInteger(v.port) &&
      Array.isArray(v.samples) &&
      v.samples.every(isHash),
  );

const isPlayback = (p: any) =>
  isObj(p) &&
  typeof p.playing === 'boolean' &&
  typeof p.bpm === 'number' &&
  p.bpm > 0 &&
  Number.isInteger(p.step) &&
  p.step >= 0 &&
  typeof p.at === 'number';

/** True if x (e.g. parsed from a message) has exactly the shape merge() expects. Check before merging. */
export function isState(x: unknown): x is State {
  return (
    isObj(x) &&
    isObj(x.settings) &&
    isReg(x.settings.steps, (v) => Number.isInteger(v) && v >= 1 && v <= MAX_STEPS) &&
    isReg(x.playback, isPlayback) &&
    isObj(x.tracks) &&
    Object.values(x.tracks).every(isTrack) &&
    isObj(x.members) &&
    Object.values(x.members).every(isMember)
  );
}
