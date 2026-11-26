// Who is in the session and how to reach them, as one node sees it. Member entries in the state
// are never removed (another copy would bring them back), so whether a member is alive is decided
// here, locally: a member is alive while its heartbeat (the version of its member entry) keeps
// increasing, and gone once it hasn't for PEER_TIMEOUT_MS.
import { memberName, type NodeId, type State } from '../state/state.js';
import type { Address } from './messages.js';

export const PEER_TIMEOUT_MS = 5000;

export type MemberStatus = 'me' | 'alive' | 'gone' | 'not heard from';
export type MemberView = {
  id: NodeId;
  name: string;
  address: string | null;
  port: number;
  heartbeat: number;
  status: MemberStatus;
  /** For live members: how long ago their heartbeat last increased. */
  seenMsAgo?: number;
  /** For gone members: how long ago they timed out. */
  goneForMs?: number;
};

type Liveness = { ver: number; changedAt: number; alive: boolean; everAlive: boolean; goneAt?: number };

export class Membership {
  /** Where packets from each node actually came from. Preferred over the address in its member entry. */
  private observed = new Map<NodeId, Address>();
  /** When each member's heartbeat last increased, decided locally. */
  private liveness = new Map<NodeId, Liveness>();

  constructor(
    private readonly me: NodeId,
    private readonly log: (line: string) => void,
  ) {}

  /** Note the address a packet from `id` came from. */
  observe(id: NodeId, from: Address) {
    this.observed.set(id, from);
  }

  /** IDs of the other members that are currently alive. */
  live(): NodeId[] {
    return [...this.liveness].filter(([, l]) => l.alive).map(([id]) => id);
  }

  /** Where to reach a member: the address its packets come from, or else the one in its entry. */
  addressOf(state: State, id: NodeId): Address | null {
    const entry = Object.hasOwn(state.members, id) ? state.members[id] : undefined;
    return (
      this.observed.get(id) ?? (entry?.value.address ? { address: entry.value.address, port: entry.value.port } : null)
    );
  }

  /**
   * Addresses to send STATE to: live members, members only just learned about from someone else,
   * and with `includeGone` also gone ones (retried now and then, so a healed network split reconnects).
   */
  targets(state: State, includeGone: boolean, now = Date.now()): Address[] {
    const out = new Map<string, Address>();
    for (const key of Object.keys(state.members)) {
      const id = Number(key);
      const l = this.liveness.get(id);
      // A member we only just learned about from someone else gets our STATE for a few seconds, so
      // it can answer directly instead of us waiting for its heartbeat to move in gossip.
      const justLearned = l !== undefined && !l.everAlive && now - l.changedAt < PEER_TIMEOUT_MS;
      if (id === this.me || !(includeGone || l?.alive || justLearned)) continue;
      const addr = this.addressOf(state, id);
      if (addr) out.set(`${addr.address}:${addr.port}`, addr);
    }
    return [...out.values()];
  }

  /**
   * Re-decides who is alive after the state changed or time passed. `heardFrom` is a node whose
   * STATE just arrived directly: that alone proves it is alive. Returns true if anyone came or went.
   */
  update(state: State, now: number, heardFrom?: NodeId): boolean {
    let changed = false;
    for (const [key, entry] of Object.entries(state.members)) {
      const id = Number(key);
      if (id === this.me) continue;
      const ver = entry.stamp.ver;
      const known = this.liveness.get(id);
      const where = `${memberName(state, id)} (${id}, ${entry.value.address ?? '?'}:${entry.value.port})`;
      if (id === heardFrom && !(known?.alive && ver <= known.ver)) {
        if (!known?.alive) {
          this.log(`+ member ${where}${known?.everAlive ? ' is back' : ''}`);
          changed = true;
        }
        this.liveness.set(id, { ver, changedAt: now, alive: true, everAlive: true });
      } else if (!known) {
        // Seeing an entry proves nothing: member entries are never removed, so this may be a peer
        // that quit long ago, e.g. our own previous run on this machine. Wait for its heartbeat to move.
        this.liveness.set(id, { ver, changedAt: now, alive: false, everAlive: false });
      } else if (ver > known.ver) {
        if (!known.alive) {
          this.log(`+ member ${where}${known.everAlive ? ' is back' : ''}`);
          changed = true;
        }
        this.liveness.set(id, { ver, changedAt: now, alive: true, everAlive: true });
      } else if (known.alive && now - known.changedAt > PEER_TIMEOUT_MS) {
        known.alive = false;
        known.goneAt = now;
        changed = true;
        this.log(`- member ${where} timed out`);
      }
    }
    return changed;
  }

  /** Every member entry in the state, with what this node knows about it. */
  view(state: State, now = Date.now()): MemberView[] {
    return Object.entries(state.members).map(([key, entry]) => {
      const id = Number(key);
      const l = this.liveness.get(id);
      const status: MemberStatus =
        id === this.me ? 'me' : l?.alive ? 'alive' : l?.everAlive ? 'gone' : 'not heard from';
      return {
        id,
        name: entry.value.name,
        address: entry.value.address,
        port: entry.value.port,
        heartbeat: entry.stamp.ver,
        status,
        seenMsAgo: l && status === 'alive' ? now - l.changedAt : undefined,
        goneForMs: l?.goneAt !== undefined && status === 'gone' ? now - l.goneAt : undefined,
      };
    });
  }
}
