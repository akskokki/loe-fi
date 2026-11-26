// A peer node: holds a copy of the session state and keeps it in sync with the other members over
// UDP. Used by both the headless peer (peer.ts) and the terminal UI (ui.tsx).
//
// Protocol (see messages.ts): a joining node sends JOIN to one member, which answers with STATE.
// Every node sends its whole state to all live members after each local change and once a second.
// Each send bumps the version of the node's own member entry, which is its heartbeat. A member
// whose heartbeat has not increased for PEER_TIMEOUT_MS is considered gone.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { Address, Msg } from './messages.js';
import { MAX_NAME_LENGTH, emptyState, heartbeat, isState, isValidName, memberName, merge, type NodeId, type State } from './state.js';
import { describeChanges } from './describe.js';
import { Clock } from './clock.js';
import { Election } from './election.js';

const SEND_INTERVAL_MS = 1000;
const PEER_TIMEOUT_MS = 5000;
const SYNC_EVERY_MS = 1000; // clock sync requests to the reference; faster until the first few samples
const SYNC_FAST_MS = 250;
const RETRY_GONE_EVERY = 5; // also send to gone members on every 5th tick, so a healed network split reconnects

export type MemberStatus = 'me' | 'alive' | 'gone' | 'not heard from';
export type MemberView = { id: NodeId; name: string; address: string | null; port: number; heartbeat: number; status: MemberStatus; seenMsAgo?: number };

export type NodeOptions = {
  /** Display name shown to the other members. Must pass isValidName(). */
  name: string;
  port: number;
  join?: Address;
  verbose?: boolean;
  /** Share of received packets to throw away (0..1), to simulate a lossy network. */
  drop?: number;
  /** Shift this node's local clock by this many ms, to test clock sync with nodes on one machine. */
  clockSkewMs?: number;
  log: (line: string) => void;
};

/** Parses "host:port" (port defaults to 7051). */
export function parseAddress(s: string): Address {
  const [address, port] = s.split(':');
  return { address, port: Number(port ?? 7051) };
}

/**
 * The --name argument, or the OS user name when it is missing. Returns an error message instead if
 * the given name is not allowed.
 */
export function chooseName(arg: string | undefined): { name: string } | { error: string } {
  if (arg !== undefined) {
    const name = arg.trim();
    return isValidName(name) ? { name } : { error: `--name must be 1 to ${MAX_NAME_LENGTH} printable characters` };
  }
  let user = '';
  try {
    user = os.userInfo().username.trim().slice(0, MAX_NAME_LENGTH).trim();
  } catch {} // no user name on some systems; fall back below
  return { name: isValidName(user) ? user : 'peer' };
}

/** This machine's IPv4 addresses, for telling others what to join. */
export function localAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((addrs) =>
    (addrs ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address));
}

const isLoopback = (a: string) => a.startsWith('127.') || a === 'localhost';

/** Shape check, so a packet from an older version of this program is reported instead of crashing us or spreading. */
function wellFormed(m: any): m is Msg {
  if (typeof m !== 'object' || m === null || typeof m.from !== 'number') return false;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const hasTo = typeof m.to?.address === 'string' && Number.isInteger(m.to.port);
  switch (m.type) {
    case 'JOIN': return hasTo;
    case 'STATE': return hasTo && isState(m.state);
    case 'ELECTION': case 'ANSWER': case 'COORDINATOR': return true;
    case 'TIME_REQUEST': return num(m.t0);
    case 'TIME_REPLY': return num(m.t0) && num(m.t1) && num(m.t2);
    default: return false;
  }
}

export type SyncView = {
  /** Node ID of the time reference, or null while there is none. */
  reference: NodeId | null;
  referenceName: string | null;
  iAmReference: boolean;
  /** True when this node is the reference or has enough samples from it. */
  synced: boolean;
  /** Session time minus this machine's clock, in ms. */
  offsetMs: number;
  /** Round-trip delay of the sample the offset comes from. */
  delayMs: number | null;
};

/** Emits 'change' whenever the state or a member's liveness changes. */
export class PeerNode extends EventEmitter<{ change: [] }> {
  readonly id: NodeId = Math.floor(Math.random() * 2 ** 32);
  state: State = emptyState();
  /** This node's address as others see it, learned from the `to` field of incoming STATE messages. */
  myAddress: string | null = null;

  private sock = dgram.createSocket('udp4');
  /** Where packets from each node actually came from. Preferred over the address in its member entry. */
  private observed = new Map<NodeId, Address>();
  /** When each member's heartbeat last increased, decided locally. */
  private liveness = new Map<NodeId, { ver: number; changedAt: number; alive: boolean; everAlive: boolean }>();
  /** Until this time, drop all packets in both directions (for testing failures). */
  private offlineUntil = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The --join address, resolved, and whether it has answered yet. */
  private joinTarget: Address | undefined;
  private joined = false;
  /** Packet counts since start. `dropped` counts packets thrown away by the `drop` option. */
  readonly stats = { sent: 0, received: 0, dropped: 0 };
  readonly clock: Clock;
  private election: Election;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private lastSyncRequest = 0;
  private stopped = false;

  constructor(readonly opts: NodeOptions) {
    super();
    this.sock.on('message', (buf, rinfo) => this.receive(buf, rinfo));
    this.clock = new Clock(opts.clockSkewMs ?? 0);
    this.election = new Election({
      me: this.id,
      liveMembers: () => this.liveMembers(),
      send: (to, type) => this.sendTo(to, { type, from: this.id }),
      // May take over unless a live reference exists that we have not synced to yet.
      canLead: () => {
        const ref = this.election.reference;
        return ref === null || ref === this.id || this.clock.synced || !this.liveMembers().includes(ref);
      },
      log: (line) => this.log(line),
      nameOf: (id) => `${memberName(this.state, id)} (${id})`,
      onChange: () => {
        this.clock.resetSamples(); // samples from the old reference no longer apply
        this.emit('change');
      },
    });
  }

  /** Session time in ms: this machine's clock corrected to the time reference's (see clock.ts). */
  now(): number {
    return this.clock.now();
  }

  sync(): SyncView {
    const reference = this.election.reference;
    return {
      reference,
      referenceName: reference === null ? null : memberName(this.state, reference),
      iAmReference: reference === this.id,
      synced: reference === this.id || this.clock.synced,
      offsetMs: this.clock.offset,
      delayMs: this.clock.delay,
    };
  }

  /** Bind the socket and start the heartbeat. Rejects if the port is taken or the join host is unknown. */
  async start(): Promise<void> {
    if (this.opts.join) {
      // Resolve a host name once, so replies from it can be recognised by their address.
      const { address } = await dns.lookup(this.opts.join.address, { family: 4 });
      this.joinTarget = { address, port: this.opts.join.port };
    }
    return new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(this.opts.port, '0.0.0.0', () => {
        this.sock.off('error', reject);
        this.sock.on('error', (err) => this.log(`socket error: ${err.message}`));
        this.state = heartbeat(this.state, this.id, this.memberInfo());
        this.sendJoin();
        let tick = 0;
        this.timer = setInterval(() => {
          this.updateLiveness(Date.now());
          this.sendJoin();
          this.broadcast(++tick % RETRY_GONE_EVERY === 0);
          this.election.tick();
        }, SEND_INTERVAL_MS);
        this.syncTimer = setInterval(() => this.requestTime(), SYNC_FAST_MS);
        resolve();
      });
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.syncTimer);
    this.election.stop();
    this.sock.close();
  }

  /**
   * Make a local change with one of the edit functions from state.ts, e.g.
   * `node.edit((s, me) => toggleCell(s, me, 'kick', 0))`. Logs and sends the change right away.
   * Returns the change descriptions; empty if nothing changed.
   */
  edit(change: (s: State, me: NodeId) => State): string[] {
    const before = this.state;
    this.state = change(this.state, this.id);
    const changes = describeChanges(before, this.state);
    if (changes.length === 0) return changes;
    for (const line of changes) this.log(`-> ${line}`);
    this.broadcast();
    this.emit('change');
    return changes;
  }

  goOffline(seconds: number) {
    this.offlineUntil = Date.now() + seconds * 1000;
    this.log(`offline for ${seconds} s`);
    setTimeout(() => this.log('back online'), seconds * 1000);
  }

  members(): MemberView[] {
    const now = Date.now();
    return Object.entries(this.state.members).map(([key, entry]) => {
      const id = Number(key);
      const l = this.liveness.get(id);
      const status: MemberStatus = id === this.id ? 'me' : l?.alive ? 'alive' : l?.everAlive ? 'gone' : 'not heard from';
      return {
        id, name: entry.value.name, address: entry.value.address, port: entry.value.port, heartbeat: entry.stamp.ver, status,
        seenMsAgo: l && status === 'alive' ? now - l.changedAt : undefined,
      };
    });
  }

  private log(line: string) {
    this.opts.log(line);
  }

  private offline() {
    return Date.now() < this.offlineUntil;
  }

  private memberInfo() {
    return { name: this.opts.name, address: this.myAddress, port: this.opts.port, samples: [] };
  }

  // --- Sending ---

  private send(msg: Msg, to: Address) {
    if (this.offline()) return;
    const data = JSON.stringify(msg);
    if (this.opts.verbose) this.log(`-> ${msg.type} to ${to.address}:${to.port} (${data.length} bytes)`);
    this.stats.sent++;
    this.sock.send(data, to.port, to.address, (err) => {
      if (err) this.log(`send to ${to.address}:${to.port} failed: ${err.message}`);
    });
  }

  /** Send to a member by node ID, at the address its packets come from or else the one in its entry. */
  private sendTo(id: NodeId, msg: Msg) {
    const addr = this.addressOf(id);
    if (addr) this.send(msg, addr);
  }

  private addressOf(id: NodeId): Address | null {
    const entry = Object.hasOwn(this.state.members, id) ? this.state.members[id] : undefined;
    return this.observed.get(id) ?? (entry?.value.address ? { address: entry.value.address, port: entry.value.port } : null);
  }

  private liveMembers(): NodeId[] {
    return [...this.liveness].filter(([, l]) => l.alive).map(([id]) => id);
  }

  /** Ask the reference for the time: every SYNC_EVERY_MS, or every SYNC_FAST_MS until synced. */
  private requestTime() {
    const ref = this.election.reference;
    if (ref === null || ref === this.id) return;
    const now = Date.now();
    if (this.clock.synced && now - this.lastSyncRequest < SYNC_EVERY_MS) return;
    this.lastSyncRequest = now;
    this.sendTo(ref, { type: 'TIME_REQUEST', from: this.id, t0: this.clock.local() });
  }

  private sendState(to: Address) {
    this.send({ type: 'STATE', from: this.id, to, state: this.state }, to);
  }

  // Keep sending JOIN until the node we join has answered, in case it starts later or a packet is lost.
  // Other live members don't count: they may have joined through us before we reached the session.
  private sendJoin() {
    const target = this.joinTarget;
    if (!target || this.joined) return;
    this.log(`-> JOIN to ${target.address}:${target.port}`);
    this.send({ type: 'JOIN', from: this.id, to: target }, target);
  }

  /** Addresses of the live and just-learned members (and the gone ones too if asked), plus the join target until we know any member. */
  private targets(includeGone: boolean): Address[] {
    const out = new Map<string, Address>();
    for (const key of Object.keys(this.state.members)) {
      const id = Number(key);
      const l = this.liveness.get(id);
      // A member we only just learned about from someone else gets our STATE for a few seconds, so
      // it can answer directly instead of us waiting for its heartbeat to move in gossip.
      const justLearned = l !== undefined && !l.everAlive && Date.now() - l.changedAt < PEER_TIMEOUT_MS;
      if (id === this.id || !(includeGone || l?.alive || justLearned)) continue;
      const addr = this.addressOf(id);
      if (addr) out.set(`${addr.address}:${addr.port}`, addr);
    }
    if (out.size === 0 && this.joinTarget) out.set('join', this.joinTarget);
    return [...out.values()];
  }

  /** Bump our heartbeat and send the state to everyone. */
  private broadcast(includeGone = false) {
    this.state = heartbeat(this.state, this.id, this.memberInfo());
    for (const to of this.targets(includeGone)) this.sendState(to);
  }

  // --- Receiving ---

  private receive(buf: Buffer, rinfo: dgram.RemoteInfo) {
    if (this.offline()) return;
    if (this.opts.drop && Math.random() < this.opts.drop) {
      this.stats.dropped++;
      return;
    }
    this.stats.received++;
    const where = `${rinfo.address}:${rinfo.port}`;
    let msg: unknown;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      this.log(`ignored a non-JSON packet from ${where}`);
      return;
    }
    if (!wellFormed(msg)) {
      this.log(`ignored a message in an unknown format from ${where} (is it running an older version? git pull there)`);
      return;
    }
    try {
      this.handle(msg, { address: rinfo.address, port: rinfo.port }, buf.length);
    } catch (err) {
      this.log(`error handling ${msg.type} from ${msg.from} (${where}): ${(err as Error).stack}`);
    }
  }

  private handle(msg: Msg, from: Address, bytes: number) {
    if (msg.from === this.id) return;
    this.observed.set(msg.from, from);

    if (msg.type === 'JOIN') {
      this.log(`<- JOIN from ${msg.from} (${from.address}:${from.port})`);
      this.learnAddress(msg.to);
      this.sendState(from);
    } else if (msg.type === 'STATE') {
      if (this.opts.verbose) this.log(`<- STATE from ${msg.from} (${from.address}:${from.port}, ${bytes} bytes)`);
      if (!this.joined && this.joinTarget?.address === from.address && this.joinTarget.port === from.port) this.joined = true;
      this.learnAddress(msg.to);
      const before = this.state;
      this.state = merge(this.state, msg.state);
      const changes = describeChanges(before, this.state);
      for (const line of changes) this.log(`<- ${line}`);
      if (changes.length > 0) this.emit('change');
      this.updateLiveness(Date.now(), msg.from);
    } else if (msg.type === 'ELECTION' || msg.type === 'ANSWER' || msg.type === 'COORDINATOR') {
      const repeat = msg.type === 'COORDINATOR' && msg.from === this.election.reference; // re-sent every few seconds
      if (!repeat || this.opts.verbose) this.log(`<- ${msg.type} from ${memberName(this.state, msg.from)} (${msg.from})`);
      this.election.receive(msg.type, msg.from);
    } else if (msg.type === 'TIME_REQUEST') {
      const t1 = this.now();
      this.send({ type: 'TIME_REPLY', from: this.id, t0: msg.t0, t1, t2: this.now() }, from);
    } else if (msg.type === 'TIME_REPLY') {
      if (msg.from !== this.election.reference) return; // a late reply from a previous reference
      const wasSynced = this.clock.synced;
      const sample = this.clock.addSample(msg.t0, msg.t1, msg.t2, this.clock.local());
      if (this.opts.verbose) this.log(`<- TIME_REPLY offset ${sample.offset.toFixed(2)} ms, delay ${sample.delay.toFixed(2)} ms`);
      if (!wasSynced && this.clock.synced) {
        this.log(`clock synced to ${memberName(this.state, msg.from)}: offset ${this.clock.offset.toFixed(1)} ms, delay ${this.clock.delay?.toFixed(1)} ms`);
        this.emit('change');
      }
    }
  }

  /** Take our address from a STATE, but don't let a loopback address replace a real one. */
  private learnAddress(to: Address) {
    if (to.address === this.myAddress || (this.myAddress && !isLoopback(this.myAddress) && isLoopback(to.address))) return;
    this.log(`others reach me at ${to.address}:${this.opts.port}`);
    this.myAddress = to.address;
    this.state = heartbeat(this.state, this.id, this.memberInfo()); // so the next message carries it
  }

  /** `heardFrom` is a node whose STATE just arrived directly: that alone proves it is alive. */
  private updateLiveness(now: number, heardFrom?: NodeId) {
    let changed = false;
    for (const [key, entry] of Object.entries(this.state.members)) {
      const id = Number(key);
      if (id === this.id) continue;
      const ver = entry.stamp.ver;
      const known = this.liveness.get(id);
      const where = `${memberName(this.state, id)} (${id}, ${entry.value.address ?? '?'}:${entry.value.port})`;
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
        changed = true;
        this.log(`- member ${where} timed out`);
      }
    }
    if (changed) this.emit('change');
  }
}
