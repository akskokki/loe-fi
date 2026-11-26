// Track keys: what a track's key in the state says about its sound.
//
//   preset:<name>    a preset sound that comes with the program (presets.ts); every node has it
//   sha256:<hex>     a sample file, identified by the SHA-256 hash of its contents; nodes that
//                    don't have it pull it from a member that does (transfer.ts)
//
// Two people adding the same file get the same key, and so the same track.
import { isPreset, type Preset } from '../audio/presets.js';
import type { State } from '../state/state.js';
import { isHash } from './hash.js';

export const presetKey = (p: Preset) => `preset:${p}`;
export const sampleKey = (hash: string) => `sha256:${hash}`;


export type Sound = { kind: 'preset'; preset: Preset } | { kind: 'sample'; hash: string };

/** The sound a track key refers to, or null for a key this version doesn't understand. */
export function soundOf(key: string): Sound | null {
  const [kind, rest] = [key.slice(0, 7), key.slice(7)];
  if (kind === 'preset:' && isPreset(rest)) return { kind: 'preset', preset: rest };
  if (kind === 'sha256:' && isHash(rest)) return { kind: 'sample', hash: rest };
  return null;
}

/**
 * Finds a track for a command like `t kick 1`: by its exact key, else by its name if exactly one
 * track that isn't deleted has it, else by a key prefix that matches exactly one track (e.g.
 * `sha256:3f2a`). Returns the key, or an error message.
 */
export function findTrack(s: State, ref: string): { key: string } | { error: string } {
  const keys = Object.keys(s.tracks);
  if (keys.includes(ref)) return { key: ref };
  const live = keys.filter((k) => s.tracks[k].status.value !== 'deleted');
  const byName = live.filter((k) => s.tracks[k].name.value === ref);
  if (byName.length === 1) return { key: byName[0] };
  if (byName.length > 1) return { error: `several tracks are called "${ref}"; use the start of a key: ${byName.join(', ')}` };
  const byPrefix = keys.filter((k) => k.startsWith(ref));
  if (ref.length >= 8 && byPrefix.length === 1) return { key: byPrefix[0] };
  return { error: `no track "${ref}"` };
}
