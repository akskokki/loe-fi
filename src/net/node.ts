// A peer node: holds a copy of the session state and keeps it in sync with the other members over
// UDP. Used by both the headless peer (app/peer.ts) and the terminal UI (app/ui).
//
// Protocol (see messages.ts): a joining node sends JOIN to one member, which answers with STATE.
// Every node sends its whole state to all live members after each local change and once a second.
// Each send bumps the version of the node's own member entry, which is its heartbeat; membership.ts
// decides from those who is alive. This class wires the parts together: the UDP socket, joining,
// the time reference election and clock sync (sync/), and sample files (samples/).
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { wellFormed, type Address, type Msg } from './messages.js';
import { Membership, type MemberView } from './membership.js';
import { addTrack, emptyState, heartbeat, memberName, merge, type NodeId, type State } from '../state/state.js';
import { describeChanges } from '../state/describe.js';
import { Clock } from '../sync/clock.js';
import { Election } from '../sync/election.js';
import { SampleStore } from '../samples/store.js';
import { SampleFetcher } from '../samples/fetcher.js';
import { serveSamples } from '../samples/transfer.js';
import { sampleKey, soundOf } from '../samples/keys.js';

export type { MemberStatus, MemberView } from './membership.js';

const SEND_INTERVAL_MS = 1000;
const RETRY_GONE_EVERY = 5; // also send to gone members on every 5th tick, so a healed network split reconnects
const SYNC_EVERY_MS = 1000; // clock sync requests to the reference; faster until the first few samples
const SYNC_FAST_MS = 250;

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
  /** Folder for this node's sample files (default: samples). */
  sampleDir?: string;
  log: (line: string) => void;
};

const isLoopback = (a: string) => a.startsWith('127.') || a === 'localhost';

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
  /** This node's address as others see it, learned from the `to` field of incoming messages. */
  myAddress: string | null = null;
  /** Packet counts since start. `dropped` counts packets thrown away by the `drop` option. */
  readonly stats = { sent: 0, received: 0, dropped: 0 };
  readonly clock: Clock;
  readonly store: SampleStore;

  private sock = dgram.createSocket('udp4');
  private membership: Membership;
  private election: Election;
  private fetcher: SampleFetcher;
  private sampleServer: net.Server | undefined;
  /** The --join address, resolved, and whether it has answered yet. */
  private joinTarget: Address | undefined;
  private joined = false;
  /** Until this time, drop all packets in both directions (for testing failures). */
  private offlineUntil = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private lastSyncRequest = 0;
  private stopped = false;

  constructor(readonly opts: NodeOptions) {
    super();
    const log = (line: string) => this.opts.log(line);
    this.sock.on('message', (buf, rinfo) => this.receive(buf, rinfo));
    this.clock = new Clock(opts.clockSkewMs ?? 0);
    this.store = new SampleStore(opts.sampleDir ?? 'samples');
    this.membership = new Membership(this.id, log);
    this.election = new Election({
      me: this.id,
      liveMembers: () => this.membership.live(),
      send: (to, type) => this.sendTo(to, { type, from: this.id }),
      // May take over unless a live reference exists that we have not synced to yet.
      canLead: () => {
        const ref = this.election.reference;
        return ref === null || ref === this.id || this.clock.synced || !this.membership.live().includes(ref);
      },
      log,
      nameOf: (id) => `${memberName(this.state, id)} (${id})`,
      onChange: () => {
        this.clock.resetSamples(); // samples from the old reference no longer apply
        this.emit('change');
      },
    });
    this.fetcher = new SampleFetcher(this.store, {
      liveMembers: () => this.membership.live(),
      addressOf: (id) => this.membership.addressOf(this.state, id),
      log,
      onFetched: () => this.emit('change'),
    });
  }

  /** Session time in ms: this machine's clock corrected to the time reference's (see sync/clock.ts). */
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

  members(): MemberView[] {
    return this.membership.view(this.state);
  }

  /** Bind the sockets and start the heartbeat. Rejects if the port is taken or the join host is unknown. */
  async start(): Promise<void> {
    if (this.opts.join) {
      // Resolve a host name once, so replies from it can be recognised by their address.
      const { address } = await dns.lookup(this.opts.join.address, { family: 4 });
      this.joinTarget = { address, port: this.opts.join.port };
    }
    // Sample transfers use TCP on the same port number as the UDP messages.
    this.sampleServer = await serveSamples(this.store, this.opts.port, (line) => this.opts.log(line));
    return new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(this.opts.port, '0.0.0.0', () => {
        this.sock.off('error', reject);
        this.sock.on('error', (err) => this.opts.log(`socket error: ${err.message}`));
        this.state = heartbeat(this.state, this.id, this.memberInfo());
        this.sendJoin();
        let tick = 0;
        this.timer = setInterval(() => {
          this.updateLiveness();
          this.sendJoin();
          this.broadcast(++tick % RETRY_GONE_EVERY === 0);
          this.election.tick();
          this.fetcher.fetchMissing(this.state);
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
    this.sampleServer?.close();
    this.sock.close();
  }

  /**
   * Make a local change with one of the edit functions from state.ts, e.g.
   * `node.edit((state, me) => toggleCell(state, me, 'preset:kick', 0))`. Logs and sends the change right
   * away. Returns the change descriptions; empty if nothing changed.
   */
  edit(change: (state: State, me: NodeId) => State): string[] {
    const before = this.state;
    this.state = change(this.state, this.id);
    const changes = describeChanges(before, this.state);
    if (changes.length === 0) return changes;
    for (const line of changes) this.opts.log(`-> ${line}`);
    this.broadcast();
    this.emit('change');
    return changes;
  }

  goOffline(seconds: number) {
    this.offlineUntil = Date.now() + seconds * 1000;
    this.opts.log(`offline for ${seconds} s`);
    setTimeout(() => this.opts.log('back online'), seconds * 1000);
  }

  /**
   * Store a sample file's bytes and add a track for it, named `name` (e.g. the file name). The
   * caller checks that the bytes are audio. Returns the track key; throws if the file is too big.
   */
  addSample(bytes: Uint8Array, name: string): string {
    const key = sampleKey(this.store.put(bytes));
    this.edit((state, me) => addTrack(state, me, key, name));
    return key;
  }

  /** Whether this node can play a track's sound: presets always, samples once they are stored. */
  hasSound(key: string): boolean {
    const sound = soundOf(key);
    return sound?.kind === 'preset' || (sound?.kind === 'sample' && this.store.has(sound.hash));
  }

  private memberInfo() {
    return { name: this.opts.name, address: this.myAddress, port: this.opts.port, samples: this.store.list() };
  }

  private updateLiveness(heardFrom?: NodeId) {
    if (this.membership.update(this.state, Date.now(), heardFrom)) this.emit('change');
  }

  // --- Sending ---

  private send(msg: Msg, to: Address) {
    if (Date.now() < this.offlineUntil) return;
    const data = JSON.stringify(msg);
    if (this.opts.verbose) this.opts.log(`-> ${msg.type} to ${to.address}:${to.port} (${data.length} bytes)`);
    this.stats.sent++;
    this.sock.send(data, to.port, to.address, (err) => {
      if (err) this.opts.log(`send to ${to.address}:${to.port} failed: ${err.message}`);
    });
  }

  /** Send to a member by node ID. */
  private sendTo(id: NodeId, msg: Msg) {
    const addr = this.membership.addressOf(this.state, id);
    if (addr) this.send(msg, addr);
  }

  private sendState(to: Address) {
    this.send({ type: 'STATE', from: this.id, to, state: this.state }, to);
  }

  // Keep sending JOIN until the node we join has answered, in case it starts later or a packet is lost.
  // Other live members don't count: they may have joined through us before we reached the session.
  private sendJoin() {
    const target = this.joinTarget;
    if (!target || this.joined) return;
    this.opts.log(`-> JOIN to ${target.address}:${target.port}`);
    this.send({ type: 'JOIN', from: this.id, to: target }, target);
  }

  /** Bump our heartbeat and send the state to everyone; to the join target while we know nobody else. */
  private broadcast(includeGone = false) {
    this.state = heartbeat(this.state, this.id, this.memberInfo());
    const targets = this.membership.targets(this.state, includeGone);
    if (targets.length === 0 && this.joinTarget) targets.push(this.joinTarget);
    for (const to of targets) this.sendState(to);
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

  // --- Receiving ---

  private receive(buf: Buffer, rinfo: dgram.RemoteInfo) {
    if (Date.now() < this.offlineUntil) return;
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
      this.opts.log(`ignored a non-JSON packet from ${where}`);
      return;
    }
    if (!wellFormed(msg)) {
      this.opts.log(
        `ignored a message in an unknown format from ${where} (is it running an older version? git pull there)`,
      );
      return;
    }
    try {
      this.handle(msg, { address: rinfo.address, port: rinfo.port }, buf.length);
    } catch (err) {
      this.opts.log(`error handling ${msg.type} from ${msg.from} (${where}): ${(err as Error).stack}`);
    }
  }

  private handle(msg: Msg, from: Address, bytes: number) {
    if (msg.from === this.id) return;
    this.membership.observe(msg.from, from);
    const log = this.opts.log;

    if (msg.type === 'JOIN') {
      log(`<- JOIN from ${msg.from} (${from.address}:${from.port})`);
      this.learnAddress(msg.to);
      this.sendState(from);
    } else if (msg.type === 'STATE') {
      if (this.opts.verbose) log(`<- STATE from ${msg.from} (${from.address}:${from.port}, ${bytes} bytes)`);
      if (!this.joined && this.joinTarget?.address === from.address && this.joinTarget.port === from.port)
        this.joined = true;
      this.learnAddress(msg.to);
      const before = this.state;
      this.state = merge(this.state, msg.state);
      const changes = describeChanges(before, this.state);
      for (const line of changes) log(`<- ${line}`);
      if (changes.length > 0) this.emit('change');
      this.updateLiveness(msg.from);
      if (changes.length > 0) this.fetcher.fetchMissing(this.state);
    } else if (msg.type === 'ELECTION' || msg.type === 'ANSWER' || msg.type === 'COORDINATOR') {
      const repeat = msg.type === 'COORDINATOR' && msg.from === this.election.reference; // re-sent every few seconds
      if (!repeat || this.opts.verbose) log(`<- ${msg.type} from ${memberName(this.state, msg.from)} (${msg.from})`);
      this.election.receive(msg.type, msg.from);
    } else if (msg.type === 'TIME_REQUEST') {
      const t1 = this.now();
      this.send({ type: 'TIME_REPLY', from: this.id, t0: msg.t0, t1, t2: this.now() }, from);
    } else if (msg.type === 'TIME_REPLY') {
      if (msg.from !== this.election.reference) return; // a late reply from a previous reference
      const wasSynced = this.clock.synced;
      const sample = this.clock.addSample(msg.t0, msg.t1, msg.t2, this.clock.local());
      if (this.opts.verbose)
        log(`<- TIME_REPLY offset ${sample.offset.toFixed(2)} ms, delay ${sample.delay.toFixed(2)} ms`);
      if (!wasSynced && this.clock.synced) {
        log(
          `clock synced to ${memberName(this.state, msg.from)}: offset ${this.clock.offset.toFixed(1)} ms, delay ${this.clock.delay?.toFixed(1)} ms`,
        );
        this.emit('change');
      }
    }
  }

  /** Take our address from a message's `to`, but don't let a loopback address replace a real one. */
  private learnAddress(to: Address) {
    if (to.address === this.myAddress || (this.myAddress && !isLoopback(this.myAddress) && isLoopback(to.address)))
      return;
    this.opts.log(`others reach me at ${to.address}:${this.opts.port}`);
    this.myAddress = to.address;
    this.state = heartbeat(this.state, this.id, this.memberInfo()); // so the next message carries it
  }
}
