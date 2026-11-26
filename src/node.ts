// A peer node: holds a copy of the session state and keeps it in sync with the other members over
// UDP. Used by both the headless peer (peer.ts) and the terminal UI (ui.tsx).
//
// Protocol (see messages.ts): a joining node sends JOIN to one member, which answers with STATE.
// Every node sends its whole state to all live members after each local change and once a second.
// Each send bumps the version of the node's own member entry, which is its heartbeat. A member
// whose heartbeat has not increased for PEER_TIMEOUT_MS is considered gone.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { Address, Msg } from './messages.js';
import { emptyState, heartbeat, isState, merge, type NodeId, type State } from './state.js';
import { describeChanges } from './describe.js';

const SEND_INTERVAL_MS = 1000;
const PEER_TIMEOUT_MS = 5000;
const RETRY_GONE_EVERY = 5; // also send to gone members on every 5th tick, so a healed network split reconnects

export type MemberStatus = 'me' | 'alive' | 'gone' | 'not heard from';
export type MemberView = { id: NodeId; address: string | null; port: number; heartbeat: number; status: MemberStatus; seenMsAgo?: number };

export type NodeOptions = {
  port: number;
  join?: Address;
  verbose?: boolean;
  log: (line: string) => void;
};

/** Parses "host:port" (port defaults to 7051). */
export function parseAddress(s: string): Address {
  const [address, port] = s.split(':');
  return { address, port: Number(port ?? 7051) };
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
  if (m.type === 'JOIN') return true;
  return m.type === 'STATE' && typeof m.to?.address === 'string' && Number.isInteger(m.to.port) && isState(m.state);
}

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

  constructor(readonly opts: NodeOptions) {
    super();
    this.sock.on('message', (buf, rinfo) => this.receive(buf, rinfo));
  }

  /** Session time in ms. Stands in for the synchronized session clock until clock sync exists. */
  now(): number {
    return Date.now();
  }

  /** Bind the socket and start the heartbeat. Rejects if the port is taken. */
  start(): Promise<void> {
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
        }, SEND_INTERVAL_MS);
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.timer);
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
        id, address: entry.value.address, port: entry.value.port, heartbeat: entry.stamp.ver, status,
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
    return { address: this.myAddress, port: this.opts.port, samples: [] };
  }

  // --- Sending ---

  private send(msg: Msg, to: Address) {
    if (this.offline()) return;
    const data = JSON.stringify(msg);
    if (this.opts.verbose) this.log(`-> ${msg.type} to ${to.address}:${to.port} (${data.length} bytes)`);
    this.sock.send(data, to.port, to.address, (err) => {
      if (err) this.log(`send to ${to.address}:${to.port} failed: ${err.message}`);
    });
  }

  private sendState(to: Address) {
    this.send({ type: 'STATE', from: this.id, to, state: this.state }, to);
  }

  // Keep sending JOIN until some member is alive, in case the other side starts later or a packet is lost.
  private sendJoin() {
    const target = this.opts.join;
    if (!target || [...this.liveness.values()].some((l) => l.alive)) return;
    this.log(`-> JOIN to ${target.address}:${target.port}`);
    this.send({ type: 'JOIN', from: this.id }, target);
  }

  /** Addresses of the live members (and the gone ones too if asked), plus the join target until we know any member. */
  private targets(includeGone: boolean): Address[] {
    const out = new Map<string, Address>();
    for (const [key, entry] of Object.entries(this.state.members)) {
      const id = Number(key);
      if (id === this.id || !(includeGone || this.liveness.get(id)?.alive)) continue;
      const addr = this.observed.get(id) ?? (entry.value.address ? { address: entry.value.address, port: entry.value.port } : null);
      if (addr) out.set(`${addr.address}:${addr.port}`, addr);
    }
    if (out.size === 0 && this.opts.join) out.set('join', this.opts.join);
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
      this.sendState(from);
    } else if (msg.type === 'STATE') {
      if (this.opts.verbose) this.log(`<- STATE from ${msg.from} (${from.address}:${from.port}, ${bytes} bytes)`);
      this.learnAddress(msg.to);
      const before = this.state;
      this.state = merge(this.state, msg.state);
      const changes = describeChanges(before, this.state);
      for (const line of changes) this.log(`<- ${line}`);
      if (changes.length > 0) this.emit('change');
      this.updateLiveness(Date.now());
    }
  }

  /** Take our address from a STATE, but don't let a loopback address replace a real one. */
  private learnAddress(to: Address) {
    if (to.address === this.myAddress || (this.myAddress && !isLoopback(this.myAddress) && isLoopback(to.address))) return;
    this.log(`others reach me at ${to.address}:${this.opts.port}`);
    this.myAddress = to.address;
  }

  private updateLiveness(now: number) {
    let changed = false;
    for (const [key, entry] of Object.entries(this.state.members)) {
      const id = Number(key);
      if (id === this.id) continue;
      const ver = entry.stamp.ver;
      const known = this.liveness.get(id);
      const where = `${entry.value.address ?? '?'}:${entry.value.port}`;
      if (!known) {
        // Seeing an entry proves nothing: member entries are never removed, so this may be a peer
        // that quit long ago, e.g. our own previous run on this machine. Wait for its heartbeat to move.
        this.liveness.set(id, { ver, changedAt: now, alive: false, everAlive: false });
      } else if (ver > known.ver) {
        if (!known.alive) {
          this.log(`+ member ${id} (${where})${known.everAlive ? ' is back' : ''}`);
          changed = true;
        }
        this.liveness.set(id, { ver, changedAt: now, alive: true, everAlive: true });
      } else if (known.alive && now - known.changedAt > PEER_TIMEOUT_MS) {
        known.alive = false;
        changed = true;
        this.log(`- member ${id} (${where}) timed out`);
      }
    }
    if (changed) this.emit('change');
  }
}
