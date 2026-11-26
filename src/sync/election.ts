// Bully election of the session's time reference: the live node with the highest node ID wins.
//
// A node starts an election when it has no reference, when the reference times out, or when it
// learns of a reference with a lower ID than its own (the "bully" case, e.g. after it joined).
//   1. It sends ELECTION to every live member with a higher ID.
//   2. A higher node that gets ELECTION replies ANSWER and starts its own election.
//   3. No ANSWER within ANSWER_TIMEOUT_MS: the node has won and sends COORDINATOR to everyone.
//      An ANSWER: it waits for a COORDINATOR, and starts over if none comes in COORDINATOR_TIMEOUT_MS.
//
// Additions for an unreliable network and for clock sync (see docs/plan-differences.md):
// - ELECTION is sent twice, since UDP may lose it.
// - The reference repeats COORDINATOR every ANNOUNCE_EVERY_MS, for lost messages and new members.
// - A node only takes over from a lower reference once `canLead()` says so (its clock is synced),
//   so a freshly joined node never becomes the reference with an unsynced clock.
import type { NodeId } from '../state/state.js';

export type ElectionMsgType = 'ELECTION' | 'ANSWER' | 'COORDINATOR';

export const ANSWER_TIMEOUT_MS = 1500;
export const COORDINATOR_TIMEOUT_MS = 4000;
export const ANNOUNCE_EVERY_MS = 2000;
/** How long a new node waits to hear of an existing reference before holding an election itself. */
export const INITIAL_WAIT_MS = 3000;

export type ElectionDeps = {
  me: NodeId;
  /** IDs of the other members that are currently alive. */
  liveMembers(): NodeId[];
  send(to: NodeId, type: ElectionMsgType): void;
  /** Whether this node may become the reference now (false while it is still syncing to a live reference). */
  canLead(): boolean;
  log(line: string): void;
  /** How to show a node in the log. */
  nameOf(id: NodeId): string;
  /** Called whenever the reference changes (null: none known). */
  onChange(reference: NodeId | null): void;
};

export class Election {
  reference: NodeId | null = null;
  private phase: 'idle' | 'waitingForAnswer' | 'waitingForCoordinator' = 'idle';
  private timers: ReturnType<typeof setTimeout>[] = [];
  private startedAt = Date.now();
  private lastAnnounce = 0;

  constructor(private readonly d: ElectionDeps) {}

  /** Call about once a second. */
  tick(now = Date.now()) {
    const { me } = this.d;
    if (this.reference === me) {
      if (now - this.lastAnnounce >= ANNOUNCE_EVERY_MS) this.announce();
      return;
    }
    if (this.phase !== 'idle') return;
    if (this.reference !== null && !this.d.liveMembers().includes(this.reference)) {
      this.d.log(`time reference ${this.d.nameOf(this.reference)} is gone`);
      this.setReference(null);
      this.start('the reference timed out');
    } else if (this.reference === null && now - this.startedAt >= INITIAL_WAIT_MS) {
      this.start('no reference known');
    } else if (this.reference !== null && this.reference < me && this.d.canLead()) {
      this.start(`the reference ${this.d.nameOf(this.reference)} has a lower ID`);
    }
  }

  receive(type: ElectionMsgType, from: NodeId) {
    const { me } = this.d;
    if (type === 'ELECTION') {
      if (from < me) {
        this.d.send(from, 'ANSWER');
        this.start(`ELECTION from lower node ${this.d.nameOf(from)}`);
      }
    } else if (type === 'ANSWER') {
      if (this.phase === 'waitingForAnswer' && from > me) {
        this.clearTimers();
        this.phase = 'waitingForCoordinator';
        this.later(COORDINATOR_TIMEOUT_MS, () => {
          this.phase = 'idle';
          this.start('no COORDINATOR after an ANSWER');
        });
      }
    } else if (type === 'COORDINATOR') {
      const current = this.reference;
      if (current === me && from < me) {
        this.announce(); // e.g. after a network split healed: tell the lower one to step down
      } else if (current !== null && from < current && this.d.liveMembers().includes(current)) {
        // We already follow a live, higher reference. Its own announcements make the lower one
        // step down; switching to the lower one would only make the followers flip back and forth.
      } else if (from > me || !this.d.canLead()) {
        this.clearTimers();
        this.phase = 'idle';
        this.setReference(from);
      } else if (from !== this.reference) {
        // A lower node claims the role while we may lead: accept it for now, then bully it.
        this.setReference(from);
        this.start(`COORDINATOR from lower node ${this.d.nameOf(from)}`);
      }
    }
  }

  stop() {
    this.clearTimers();
  }

  /** Start an election unless one is already running. */
  start(reason: string) {
    if (this.phase !== 'idle' || !this.d.canLead()) return;
    const higher = this.d.liveMembers().filter((id) => id > this.d.me);
    this.d.log(`election started (${reason}); ${higher.length} higher node(s)`);
    if (higher.length === 0) return this.win();
    this.phase = 'waitingForAnswer';
    for (const id of higher) this.d.send(id, 'ELECTION');
    this.later(ANSWER_TIMEOUT_MS / 2, () => {
      if (this.phase === 'waitingForAnswer') for (const id of higher) this.d.send(id, 'ELECTION');
    });
    this.later(ANSWER_TIMEOUT_MS, () => {
      if (this.phase === 'waitingForAnswer') this.win();
    });
  }

  private win() {
    this.clearTimers();
    this.phase = 'idle';
    this.setReference(this.d.me);
    this.announce();
  }

  private announce() {
    this.lastAnnounce = Date.now();
    for (const id of this.d.liveMembers()) this.d.send(id, 'COORDINATOR');
  }

  private setReference(id: NodeId | null) {
    if (id === this.reference) return;
    this.reference = id;
    this.d.log(id === null ? 'no time reference' : id === this.d.me ? 'I am the time reference' : `time reference is ${this.d.nameOf(id)}`);
    this.d.onChange(id);
  }

  private later(ms: number, f: () => void) {
    this.timers.push(setTimeout(f, ms));
  }

  private clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}
