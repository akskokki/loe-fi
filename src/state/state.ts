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
// - A track's key is `preset:<name>` for a built-in sound or `sha256:<hash>` for a sample file
//   (samples/keys.ts), so each sound can be used by one track at most.
//
// All functions are pure: they return a new state and never modify their arguments.

import { createHash } from 'node:crypto';

export type NodeId = number;

/** Version stamp <version, node ID>. Version 0 means the value was never set. */
export type Stamp = { ver: number; node: NodeId };

/** A value with its own stamp: the unit that last-writer-wins applies to. */
export type Register<T> = { value: T; stamp: Stamp };

export const MAX_STEPS = 32;
export const NO_STAMP: Stamp = { ver: 0, node: 0 };

export type Settings = {
  steps: Register<number>; // 1..MAX_STEPS
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
  name: Register<string>; // shown in the UI: the preset's name, or the sample's file name
  status: Register<TrackStatus>; // 'deleted' is a tombstone: the track stays so older copies can't bring it back
  cells: Register<boolean>[]; // always MAX_STEPS long
};

export type MemberInfo = {
  /** Display name chosen by the member (see isValidName). Not unique: two members may pick the same one. */
  name: string;
  /** Address other nodes can reach this member at; null until the member has learned it (see messages.ts). */
  address: string | null;
  port: number;
  /** Hashes of the sample files this member holds (see store.ts); others pull missing ones from it. */
  samples: string[];
};

export type State = {
  settings: Settings;
  playback: Register<Playback>;
  tracks: Record<string, Track>; // key: the track key, `preset:<name>` or `sha256:<hash>`
  members: Record<string, Register<MemberInfo>>; // key: node ID
};

// --- Merge ---

/** True if stamp a wins over stamp b. */
export function newer(a: Stamp, b: Stamp): boolean {
  return a.ver !== b.ver ? a.ver > b.ver : a.node > b.node;
}

function pick<T>(local: Register<T>, incoming: Register<T> | undefined): Register<T> {
  return incoming && newer(incoming.stamp, local.stamp) ? incoming : local;
}

function mergeTrack(local: Track, incoming: Track): Track {
  return {
    name: pick(local.name, incoming.name),
    status: pick(local.status, incoming.status),
    cells: local.cells.map((cell, i) => pick(cell, incoming.cells[i])),
  };
}

function mergeRecord<V>(
  local: Record<string, V>,
  incoming: Record<string, V>,
  mergeValue: (local: V, incoming: V) => V,
) {
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

// --- Local changes ---

/** A new version of `register` holding `value`, stamped by this node. */
function write<T>(register: Register<T>, value: T, me: NodeId): Register<T> {
  return { value, stamp: { ver: register.stamp.ver + 1, node: me } };
}

const unset = <T>(value: T): Register<T> => ({ value, stamp: NO_STAMP });

/** Own-property lookup, so a key like "constructor" is not found on Object.prototype. */
const getTrack = (state: State, trackKey: string): Track | undefined =>
  Object.hasOwn(state.tracks, trackKey) ? state.tracks[trackKey] : undefined;

export function emptyState(): State {
  return {
    settings: { steps: unset(16) },
    playback: unset({ playing: false, bpm: 120, step: 0, at: 0 }),
    tracks: {},
    members: {},
  };
}

/**
 * Add a track. `me` is this node's ID, as in all the functions below. Adding a sound whose track
 * was deleted brings that track back with its old cells.
 */
export function addTrack(state: State, me: NodeId, trackKey: string, name: string): State {
  if (getTrack(state, trackKey)) return setTrackStatus(state, me, trackKey, 'active');
  const track: Track = {
    name: write(unset(name), name, me),
    status: write(unset<TrackStatus>('active'), 'active', me),
    cells: Array.from({ length: MAX_STEPS }, () => unset(false)),
  };
  return { ...state, tracks: { ...state.tracks, [trackKey]: track } };
}

export function setTrackStatus(state: State, me: NodeId, trackKey: string, status: TrackStatus): State {
  const track = getTrack(state, trackKey);
  if (!track || track.status.value === status) return state;
  return { ...state, tracks: { ...state.tracks, [trackKey]: { ...track, status: write(track.status, status, me) } } };
}

/** Turn a step on or off. `step` counts from 0. */
export function toggleCell(state: State, me: NodeId, trackKey: string, step: number): State {
  const track = getTrack(state, trackKey);
  if (!track || !Number.isInteger(step) || step < 0 || step >= MAX_STEPS) return state;
  const cells = track.cells.slice();
  cells[step] = write(cells[step], !cells[step].value, me);
  return { ...state, tracks: { ...state.tracks, [trackKey]: { ...track, cells } } };
}

/** Set how many steps the pattern has, clamped to 1..MAX_STEPS. */
export function setSteps(state: State, me: NodeId, steps: number): State {
  const clamped = Math.min(MAX_STEPS, Math.max(1, Math.round(steps)));
  if (clamped === state.settings.steps.value) return state;
  return { ...state, settings: { ...state.settings, steps: write(state.settings.steps, clamped, me) } };
}

/**
 * Play, stop or change the tempo at session time `now` (ms). The playhead keeps its current
 * position: stopping freezes it, playing continues from it, and a tempo change continues from it
 * at the new speed.
 */
export function updatePlayback(
  state: State,
  me: NodeId,
  now: number,
  change: { playing?: boolean; bpm?: number },
): State {
  const current = state.playback.value;
  const next: Playback = {
    playing: change.playing ?? current.playing,
    bpm: change.bpm ?? current.bpm,
    step: playheadAt(state, now),
    at: now,
  };
  return { ...state, playback: write(state.playback, next, me) };
}

/** Bump this node's own member entry. Called before every STATE send; the version is the heartbeat. */
export function heartbeat(state: State, me: NodeId, info: MemberInfo): State {
  const own = state.members[me] ?? unset(info);
  return { ...state, members: { ...state.members, [me]: write(own, info, me) } };
}

// --- Derived values ---

/** JSON with object keys sorted, so equal values always give the same text. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (typeof x === 'object' && x !== null) {
    const keys = Object.keys(x).sort();
    const fields = keys.map((key) => `${JSON.stringify(key)}:${canonical((x as Record<string, unknown>)[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(x);
}

/**
 * A short hash of everything in the state that must converge: settings, playback, tracks, and the
 * set of members with their names. Member heartbeats are left out because they keep changing while
 * nodes run. Two nodes with the same fingerprint have the same sequencer state.
 */
export function fingerprint(state: State): string {
  const members = Object.entries(state.members)
    .map(([id, member]) => [id, member.value.name])
    .sort();
  const shared = { settings: state.settings, playback: state.playback, tracks: state.tracks, members };
  return createHash('sha256').update(canonical(shared)).digest('hex').slice(0, 12);
}

/** A member's display name, or its node ID if it has no entry (yet). */
export function memberName(state: State, id: NodeId): string {
  return Object.hasOwn(state.members, id) ? state.members[id].value.name : String(id);
}

export const stepDurationMs = (bpm: number) => 60_000 / bpm / 4; // one step is a 16th note

/** The step the playhead is on at session time `now` (ms). */
export function playheadAt(state: State, now: number): number {
  const playback = state.playback.value;
  const steps = state.settings.steps.value;
  const elapsed = playback.playing ? Math.floor((now - playback.at) / stepDurationMs(playback.bpm)) : 0;
  return (((playback.step + elapsed) % steps) + steps) % steps;
}
