// The session's global state, which every node holds a copy of, and the rule for merging copies.
//
// Every value is a register: the value plus a version stamp <version, node ID>. A node changes a
// value by bumping the version and putting its own ID in the stamp. merge() keeps, for every value
// separately, the copy with the higher stamp (higher version, then higher node ID). merge() is
// commutative, associative and idempotent, so all nodes end up with the same state whatever order
// STATE messages arrive in, and a lost message is covered by the next one.
//
// Differences from the design plan's figure (to agree on in the group):
// - Tempo lives in `playback` together with the playhead position, under one stamp. A tempo change
//   moves the position anchor, so the two must change together; as separate values, concurrent
//   edits could combine one node's tempo with another node's anchor and make the playhead jump.
// - Every track has MAX_STEPS cells. `settings.steps` only says how many are used, so copies with
//   different step counts still merge cell by cell.
// - A member entry is a single register that only the member itself writes. Its version is the
//   heartbeat. Entries are never removed (another copy would bring them back); whether a member is
//   alive is decided locally from whether its version keeps increasing.
// - Tracks are keyed by the sample's hash, so two tracks cannot use the same sample.
//
// All functions are pure: they return a new state and never modify their arguments.

import { createHash } from 'node:crypto';

export type NodeId = number;

/** Version stamp <version, node ID>. Version 0 means the value was never set. */
export type Stamp = { ver: number; node: NodeId };

/** A value with its own stamp: the unit that last-writer-wins applies to. */
export type Reg<T> = { value: T; stamp: Stamp };

export const MAX_STEPS = 32;
export const NO_STAMP: Stamp = { ver: 0, node: 0 };

export type Settings = {
  steps: Reg<number>; // 1..MAX_STEPS
};

export type Playback = {
  playing: boolean;
  bpm: number;
  /** The playhead was on `step` at session time `at` (ms). Changed together by every play, stop and tempo change. */
  step: number;
  at: number;
};

export type TrackStatus = 'active' | 'muted' | 'deleted';

export type Track = {
  name: Reg<string>; // sample file name, for display
  status: Reg<TrackStatus>; // 'deleted' is a tombstone: the track stays so older copies can't bring it back
  cells: Reg<boolean>[]; // always MAX_STEPS long
};

export type MemberInfo = {
  /** Display name chosen by the member (see isValidName). Not unique: two members may pick the same one. */
  name: string;
  /** Address other nodes can reach this member at; null until the member has learned it (see messages.ts). */
  address: string | null;
  port: number;
  samples: string[]; // hashes of the samples this member holds
};

export type State = {
  settings: Settings;
  playback: Reg<Playback>;
  tracks: Record<string, Track>; // key: sample hash
  members: Record<string, Reg<MemberInfo>>; // key: node ID
};

// --- Merge ---

/** True if stamp a wins over stamp b. */
export function newer(a: Stamp, b: Stamp): boolean {
  return a.ver !== b.ver ? a.ver > b.ver : a.node > b.node;
}

function pick<T>(local: Reg<T>, incoming: Reg<T> | undefined): Reg<T> {
  return incoming && newer(incoming.stamp, local.stamp) ? incoming : local;
}

function mergeTrack(local: Track, incoming: Track): Track {
  return {
    name: pick(local.name, incoming.name),
    status: pick(local.status, incoming.status),
    cells: local.cells.map((cell, i) => pick(cell, incoming.cells[i])),
  };
}

function mergeRecord<V>(local: Record<string, V>, incoming: Record<string, V>, mergeValue: (l: V, i: V) => V) {
  const out = { ...local };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === '__proto__') continue; // keys come from the network; assigning this one would replace out's prototype
    out[key] = Object.hasOwn(local, key) ? mergeValue(local[key], value) : value;
  }
  return out;
}

/** Merge an incoming copy of the state into the local one. Check incoming copies with isState() first. */
export function merge(local: State, incoming: State): State {
  return {
    settings: { steps: pick(local.settings.steps, incoming.settings?.steps) },
    playback: pick(local.playback, incoming.playback),
    tracks: mergeRecord(local.tracks, incoming.tracks ?? {}, mergeTrack),
    members: mergeRecord(local.members, incoming.members ?? {}, pick),
  };
}

// --- Checking incoming copies ---

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStamp = (x: any) => isObj(x) && Number.isInteger(x.ver) && x.ver >= 0 && typeof x.node === 'number';
const isReg = (x: any, isValue: (v: any) => boolean) => isObj(x) && isStamp(x.stamp) && isValue(x.value);
const STATUSES = ['active', 'muted', 'deleted'];

const isTrack = (t: any) =>
  isObj(t) && isReg(t.name, (v) => typeof v === 'string') && isReg(t.status, (v) => STATUSES.includes(v))
  && Array.isArray(t.cells) && t.cells.length === MAX_STEPS && t.cells.every((c: any) => isReg(c, (v) => typeof v === 'boolean'));

export const MAX_NAME_LENGTH = 16;

/**
 * 1..MAX_NAME_LENGTH printable characters with no leading or trailing spaces. Names come from the
 * network and are printed to the terminal, so control characters (escape sequences) are refused.
 */
export function isValidName(x: unknown): x is string {
  return typeof x === 'string' && x.length >= 1 && x.length <= MAX_NAME_LENGTH && x === x.trim()
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(x);
}

const isMember = (m: any) =>
  isReg(m, (v) => isObj(v) && isValidName(v.name) && (v.address === null || typeof v.address === 'string') && Number.isInteger(v.port)
    && Array.isArray(v.samples) && v.samples.every((h: unknown) => typeof h === 'string'));

const isPlayback = (p: any) =>
  isObj(p) && typeof p.playing === 'boolean' && typeof p.bpm === 'number' && p.bpm > 0
  && Number.isInteger(p.step) && p.step >= 0 && typeof p.at === 'number';

/** True if x (e.g. parsed from a message) has exactly the shape merge() expects. Check before merging. */
export function isState(x: unknown): x is State {
  return isObj(x)
    && isObj(x.settings) && isReg(x.settings.steps, (v) => Number.isInteger(v) && v >= 1 && v <= MAX_STEPS)
    && isReg(x.playback, isPlayback)
    && isObj(x.tracks) && Object.values(x.tracks).every(isTrack)
    && isObj(x.members) && Object.values(x.members).every(isMember);
}

// --- Local changes ---

function write<T>(reg: Reg<T>, value: T, me: NodeId): Reg<T> {
  return { value, stamp: { ver: reg.stamp.ver + 1, node: me } };
}

const unset = <T>(value: T): Reg<T> => ({ value, stamp: NO_STAMP });

/** Own-property lookup, so a name like "constructor" is not found on Object.prototype. */
const getTrack = (s: State, hash: string): Track | undefined => (Object.hasOwn(s.tracks, hash) ? s.tracks[hash] : undefined);

export function emptyState(): State {
  return {
    settings: { steps: unset(16) },
    playback: unset({ playing: false, bpm: 120, step: 0, at: 0 }),
    tracks: {},
    members: {},
  };
}

/** Add a track for a sample. Adding a sample whose track was deleted brings that track back with its old cells. */
export function addTrack(s: State, me: NodeId, hash: string, name: string): State {
  if (getTrack(s, hash)) return setTrackStatus(s, me, hash, 'active');
  const track: Track = {
    name: write(unset(name), name, me),
    status: write(unset<TrackStatus>('active'), 'active', me),
    cells: Array.from({ length: MAX_STEPS }, () => unset(false)),
  };
  return { ...s, tracks: { ...s.tracks, [hash]: track } };
}

export function setTrackStatus(s: State, me: NodeId, hash: string, status: TrackStatus): State {
  const t = getTrack(s, hash);
  if (!t || t.status.value === status) return s;
  return { ...s, tracks: { ...s.tracks, [hash]: { ...t, status: write(t.status, status, me) } } };
}

export function toggleCell(s: State, me: NodeId, hash: string, step: number): State {
  const t = getTrack(s, hash);
  if (!t || !Number.isInteger(step) || step < 0 || step >= MAX_STEPS) return s;
  const cells = t.cells.slice();
  cells[step] = write(cells[step], !cells[step].value, me);
  return { ...s, tracks: { ...s.tracks, [hash]: { ...t, cells } } };
}

export function setSteps(s: State, me: NodeId, steps: number): State {
  const n = Math.min(MAX_STEPS, Math.max(1, Math.round(steps)));
  if (n === s.settings.steps.value) return s;
  return { ...s, settings: { ...s.settings, steps: write(s.settings.steps, n, me) } };
}

/**
 * Play, stop or change the tempo at session time `now` (ms). The playhead keeps its current
 * position: stopping freezes it, playing continues from it, and a tempo change continues from it
 * at the new speed.
 */
export function updatePlayback(s: State, me: NodeId, now: number, change: { playing?: boolean; bpm?: number }): State {
  const p = s.playback.value;
  const next: Playback = {
    playing: change.playing ?? p.playing,
    bpm: change.bpm ?? p.bpm,
    step: playheadAt(s, now),
    at: now,
  };
  return { ...s, playback: write(s.playback, next, me) };
}

/** Bump this node's own member entry. Called before every STATE send; the version is the heartbeat. */
export function heartbeat(s: State, me: NodeId, info: MemberInfo): State {
  const own = s.members[me] ?? unset(info);
  return { ...s, members: { ...s.members, [me]: write(own, info, me) } };
}

// --- Derived values ---

/** JSON with object keys sorted, so equal values always give the same text. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (typeof x === 'object' && x !== null) {
    const keys = Object.keys(x).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(x);
}

/**
 * A short hash of everything in the state that must converge: settings, playback, tracks, and the
 * set of members with their names. Member heartbeats are left out because they keep changing while
 * nodes run. Two nodes with the same fingerprint have the same sequencer state.
 */
export function fingerprint(s: State): string {
  const members = Object.entries(s.members).map(([id, m]) => [id, m.value.name]).sort();
  const shared = { settings: s.settings, playback: s.playback, tracks: s.tracks, members };
  return createHash('sha256').update(canonical(shared)).digest('hex').slice(0, 12);
}

/** A member's display name, or its node ID if it has no entry (yet). */
export function memberName(s: State, id: NodeId): string {
  return Object.hasOwn(s.members, id) ? s.members[id].value.name : String(id);
}

export const stepDurationMs = (bpm: number) => 60_000 / bpm / 4; // one step is a 16th note

/** The step the playhead is on at session time `now` (ms). */
export function playheadAt(s: State, now: number): number {
  const p = s.playback.value;
  const steps = s.settings.steps.value;
  const elapsed = p.playing ? Math.floor((now - p.at) / stepDurationMs(p.bpm)) : 0;
  return (((p.step + elapsed) % steps) + steps) % steps;
}
