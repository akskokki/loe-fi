// Headless peer: holds a copy of the session state, keeps it in sync with the other members over
// UDP, and takes typed commands to change it.
//
//   npm run peer                              start a session on port 7051
//   npm run peer -- --join 192.168.1.10:7051  join a member at that address
//   npm run peer -- --port 7052 --join 127.0.0.1:7051   second peer on the same machine
//   add --verbose to log every STATE message sent and received
//
// Protocol (see messages.ts): a joining node sends JOIN to one member, which answers with STATE.
// Every node sends its whole state to all live members after each local change and once a second.
// Each send bumps the version of the node's own member entry, which is its heartbeat. A member
// whose heartbeat has not increased for PEER_TIMEOUT_MS is considered gone.
import dgram from 'node:dgram';
import os from 'node:os';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import type { Address, Msg } from './messages.js';
import {
  addTrack, emptyState, heartbeat, isState, merge, setSteps, setTrackStatus, toggleCell, updatePlayback,
  type NodeId, type State,
} from './state.js';
import { describeChanges, renderGrid } from './describe.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '7051' },
    join: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

const PORT = Number(args.port);
const SEND_INTERVAL_MS = 1000;
const PEER_TIMEOUT_MS = 5000;
const RETRY_GONE_EVERY = 5; // also send to gone members on every 5th tick, so a healed network split reconnects
const LARGE_MESSAGE_BYTES = 8000; // macOS refuses to send UDP datagrams over 9216 bytes by default
const ME: NodeId = Math.floor(Math.random() * 2 ** 32);

let state: State = emptyState();
/** This node's address as others see it, learned from the `to` field of incoming STATE messages. */
let myAddress: string | null = null;
/** Where packets from each node actually came from. Preferred over the address in its member entry. */
const observed = new Map<NodeId, Address>();
/** When each member's heartbeat last increased, decided locally. */
const liveness = new Map<NodeId, { ver: number; changedAt: number; alive: boolean; everAlive: boolean }>();
const joinTarget: Address | undefined = args.join
  ? { address: args.join.split(':')[0], port: Number(args.join.split(':')[1] ?? 7051) }
  : undefined;

/** Until this time, drop all packets in both directions (the `offline` command, for testing failures). */
let offlineUntil = 0;
const offline = () => Date.now() < offlineUntil;

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 23)} [${ME}] ${s}`);
const sock = dgram.createSocket('udp4');

// --- Sending ---

function send(msg: Msg, to: Address) {
  if (offline()) return;
  const data = JSON.stringify(msg);
  if (data.length > LARGE_MESSAGE_BYTES) log(`warning: ${msg.type} is ${data.length} bytes, may not fit in one datagram`);
  if (args.verbose) log(`-> ${msg.type} to ${to.address}:${to.port} (${data.length} bytes)`);
  sock.send(data, to.port, to.address, (err) => {
    if (err) log(`send to ${to.address}:${to.port} failed: ${err.message}`);
  });
}

const sendState = (to: Address) => send({ type: 'STATE', from: ME, to, state }, to);

/** Addresses of the live members (and the gone ones too if asked), plus the join target until we know any member. */
function targets(includeGone = false): Address[] {
  const out = new Map<string, Address>();
  for (const [key, entry] of Object.entries(state.members)) {
    const id = Number(key);
    if (id === ME || !(includeGone || liveness.get(id)?.alive)) continue;
    const addr = observed.get(id) ?? (entry.value.address ? { address: entry.value.address, port: entry.value.port } : null);
    if (addr) out.set(`${addr.address}:${addr.port}`, addr);
  }
  if (out.size === 0 && joinTarget) out.set('join', joinTarget);
  return [...out.values()];
}

/** Bump our heartbeat and send the state to everyone. */
function broadcast(includeGone = false) {
  state = heartbeat(state, ME, { address: myAddress, port: PORT, samples: [] });
  for (const to of targets(includeGone)) sendState(to);
}

// --- Receiving ---

const isLoopback = (a: string) => a.startsWith('127.') || a === 'localhost';

/** Take our address from a STATE, but don't let a loopback address replace a real one. */
function learnAddress(to: Address) {
  if (to.address === myAddress || (myAddress && !isLoopback(myAddress) && isLoopback(to.address))) return;
  log(`others reach me at ${to.address}:${PORT}`);
  myAddress = to.address;
}

function updateLiveness(now: number) {
  for (const [key, entry] of Object.entries(state.members)) {
    const id = Number(key);
    if (id === ME) continue;
    const ver = entry.stamp.ver;
    const known = liveness.get(id);
    const where = `${entry.value.address ?? '?'}:${entry.value.port}`;
    if (!known) {
      // Seeing an entry proves nothing: member entries are never removed, so this may be a peer
      // that quit long ago, e.g. our own previous run on this machine. Wait for its heartbeat to move.
      liveness.set(id, { ver, changedAt: now, alive: false, everAlive: false });
    } else if (ver > known.ver) {
      if (!known.alive) log(`+ member ${id} (${where})${known.everAlive ? ' is back' : ''}`);
      liveness.set(id, { ver, changedAt: now, alive: true, everAlive: true });
    } else if (known.alive && now - known.changedAt > PEER_TIMEOUT_MS) {
      known.alive = false;
      log(`- member ${id} (${where}) timed out`);
    }
  }
}

/** Shape check, so a packet from an older version of this program is reported instead of crashing us or spreading. */
function wellFormed(m: any): m is Msg {
  if (typeof m !== 'object' || m === null || typeof m.from !== 'number') return false;
  if (m.type === 'JOIN') return true;
  return m.type === 'STATE' && typeof m.to?.address === 'string' && Number.isInteger(m.to.port) && isState(m.state);
}

sock.on('message', (buf, rinfo) => {
  if (offline()) return;
  const where = `${rinfo.address}:${rinfo.port}`;
  let msg: unknown;
  try {
    msg = JSON.parse(buf.toString());
  } catch {
    log(`ignored a non-JSON packet from ${where}`);
    return;
  }
  if (!wellFormed(msg)) {
    log(`ignored a message in an unknown format from ${where} (is it running an older version? git pull there)`);
    return;
  }
  try {
    handle(msg, { address: rinfo.address, port: rinfo.port }, buf.length);
  } catch (err) {
    log(`error handling ${msg.type} from ${msg.from} (${where}): ${(err as Error).stack}`);
  }
});

function handle(msg: Msg, from: Address, bytes: number) {
  if (msg.from === ME) return;
  observed.set(msg.from, from);

  if (msg.type === 'JOIN') {
    log(`<- JOIN from ${msg.from} (${from.address}:${from.port})`);
    sendState(from);
  } else if (msg.type === 'STATE') {
    if (args.verbose) log(`<- STATE from ${msg.from} (${from.address}:${from.port}, ${bytes} bytes)`);
    learnAddress(msg.to);
    const before = state;
    state = merge(state, msg.state);
    for (const line of describeChanges(before, state)) log(`<- ${line}`);
    updateLiveness(Date.now());
  }
}

sock.on('error', (err) => {
  log(`socket error: ${err.message}`);
  process.exit(1);
});

// --- Commands ---

const HELP = `commands:
  add <name>           add a track (e.g. add kick)
  t <track> <step>     toggle a step, counted from 1 (e.g. t kick 1)
  mute|unmute|del <track>
  play | stop | bpm <n> | steps <n>
  show                 print the grid and the members
  offline <seconds>    drop all packets for a while, to test failures
  help | quit`;

function showMembers(now: number) {
  for (const [key, entry] of Object.entries(state.members)) {
    const id = Number(key);
    const where = `${entry.value.address ?? '?'}:${entry.value.port}`;
    const l = liveness.get(id);
    const status = id === ME ? 'me' : l?.alive ? `alive, seen ${now - l.changedAt} ms ago` : l?.everAlive ? 'gone' : 'not heard from';
    console.log(`  member ${id} ${where} heartbeat ${entry.stamp.ver} (${status})`);
  }
}

function run(line: string) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const now = Date.now(); // stands in for session time until clock sync exists
  const before = state;
  switch (cmd) {
    case '': return;
    case 'add': if (rest[0]) state = addTrack(state, ME, rest[0], rest[0]); break;
    case 't': state = toggleCell(state, ME, rest[0], Number(rest[1]) - 1); break;
    case 'mute': state = setTrackStatus(state, ME, rest[0], 'muted'); break;
    case 'unmute': state = setTrackStatus(state, ME, rest[0], 'active'); break;
    case 'del': state = setTrackStatus(state, ME, rest[0], 'deleted'); break;
    case 'play': state = updatePlayback(state, ME, now, { playing: true }); break;
    case 'stop': state = updatePlayback(state, ME, now, { playing: false }); break;
    case 'bpm': if (Number(rest[0]) > 0) state = updatePlayback(state, ME, now, { bpm: Number(rest[0]) }); break;
    case 'steps': if (Number(rest[0]) > 0) state = setSteps(state, ME, Number(rest[0])); break;
    case 'show':
      for (const l of renderGrid(state, now)) console.log(`  ${l}`);
      showMembers(now);
      return;
    case 'offline':
      offlineUntil = now + Number(rest[0] || 10) * 1000;
      log(`offline for ${Number(rest[0] || 10)} s`);
      setTimeout(() => log('back online'), offlineUntil - now);
      return;
    case 'help': console.log(HELP); return;
    case 'quit': process.exit(0);
    default: console.log(`unknown command "${cmd}", try help`); return;
  }
  const changes = describeChanges(before, state);
  if (changes.length === 0) return console.log('nothing changed (unknown track or step?)');
  for (const l of changes) log(`-> ${l}`);
  broadcast();
}

// --- Start ---

sock.bind(PORT, '0.0.0.0', () => {
  log(`listening on UDP port ${PORT}. Others can join with one of:`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4') console.log(`    --join ${a.address}:${PORT}`);
  }
  console.log('type "help" for commands');

  state = heartbeat(state, ME, { address: myAddress, port: PORT, samples: [] });

  // Keep sending JOIN until some member is alive, in case the other side starts later or a packet is lost.
  const sendJoin = () => {
    if (!joinTarget || [...liveness.values()].some((l) => l.alive)) return;
    log(`-> JOIN to ${joinTarget.address}:${joinTarget.port}`);
    send({ type: 'JOIN', from: ME }, joinTarget);
  };
  sendJoin();

  let tick = 0;
  setInterval(() => {
    updateLiveness(Date.now());
    sendJoin();
    broadcast(++tick % RETRY_GONE_EVERY === 0);
  }, SEND_INTERVAL_MS);

  readline.createInterface({ input: process.stdin }).on('line', run).on('close', () => process.exit(0));
});
