// Convergence test over the real network code: starts several PeerNodes on localhost, lets each
// make random edits while packets are lost, then checks that every node ends up with the same
// state and sees every other node as alive.
//
//   npm run harness                                  5 peers, 10 s of edits, 30% packet loss
//   npm run harness -- --peers 8 --seconds 20 --drop 0.5 --outage 6 --seed 3
//
// Options:
//   --peers N      number of nodes (default 5); each joins a random earlier node, not always the first
//   --seconds S    how long the nodes keep editing (default 10)
//   --rate R       edits per second per node (default 4)
//   --drop P       share of received packets each node throws away (default 0.3)
//   --outage S     take one random node offline for S seconds in the middle of the run (default 0)
//   --seed N       seed for the edits and the join order (packet loss and node IDs stay random)
//   --port P       first UDP port (default 17100); nodes use P, P+1, ...
//   --verbose      also print every node's log; it always goes to logs/harness-<time>.log
//
// Exits with code 0 if the nodes converged, 1 if not.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { PeerNode } from './node.js';
import {
  addTrack, fingerprint, setSteps, setTrackStatus, toggleCell, updatePlayback,
  type NodeId, type State, type TrackStatus,
} from './state.js';

const { values: args } = parseArgs({
  options: {
    peers: { type: 'string', default: '5' },
    seconds: { type: 'string', default: '10' },
    rate: { type: 'string', default: '4' },
    drop: { type: 'string', default: '0.3' },
    outage: { type: 'string', default: '0' },
    seed: { type: 'string', default: '1' },
    port: { type: 'string', default: '17100' },
    verbose: { type: 'boolean', default: false },
  },
});

const PEERS = Number(args.peers);
const SECONDS = Number(args.seconds);
const RATE = Number(args.rate);
const DROP = Number(args.drop);
const OUTAGE = Number(args.outage);
const BASE_PORT = Number(args.port);
const CONNECT_TIMEOUT_MS = 20_000;
const CONVERGE_TIMEOUT_MS = 30_000;

// Small seeded random generator (mulberry32), so a run's edits can be repeated.
let seed = Number(args.seed);
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
}
const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];

// --- Log ---

fs.mkdirSync('logs', { recursive: true });
const logPath = `logs/harness-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
const logFile = fs.createWriteStream(logPath);
function log(who: string, line: string) {
  const stamped = `${new Date().toISOString().slice(11, 23)} [${who}] ${line}`;
  logFile.write(`${stamped}\n`);
  if (args.verbose) console.log(stamped);
}
const say = (line: string) => {
  console.log(line);
  log('harness', line);
};

// --- Random edits ---

const TRACKS = ['kick', 'snare', 'hat'];
const STATUSES: TrackStatus[] = ['active', 'muted', 'deleted'];

/** A random change, weighted towards toggling cells, which is what users do most. */
function randomEdit(now: number): (s: State, me: NodeId) => State {
  const r = random();
  const track = pick(TRACKS);
  if (r < 0.7) {
    const step = Math.floor(random() * 32);
    return (s, me) => toggleCell(addTrackIfMissing(s, me, track), me, track, step);
  }
  if (r < 0.8) {
    const status = pick(STATUSES);
    return (s, me) => setTrackStatus(s, me, track, status);
  }
  if (r < 0.9) {
    const playing = random() < 0.5;
    const bpm = 60 + Math.floor(random() * 120);
    return (s, me) => updatePlayback(s, me, now, { playing, bpm });
  }
  const steps = pick([8, 12, 16, 32]);
  return (s, me) => setSteps(s, me, steps);
}

const addTrackIfMissing = (s: State, me: NodeId, track: string) =>
  Object.hasOwn(s.tracks, track) ? s : addTrack(s, me, track, track);

// --- Checks ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when every node sees every other node as alive. */
function allConnected(nodes: PeerNode[]) {
  return nodes.every((n) => n.members().filter((m) => m.status === 'alive').length === nodes.length - 1);
}

function converged(nodes: PeerNode[]) {
  const prints = new Set(nodes.map((n) => fingerprint(n.state)));
  return prints.size === 1 && allConnected(nodes);
}

/** Polls `check` every 100 ms; returns the time it took, or null on timeout. */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return Date.now() - start;
    await sleep(100);
  }
  return null;
}

function printTable(nodes: PeerNode[], edits: number[]) {
  console.log('  node  port   edits  sent  received  dropped  alive  fingerprint');
  nodes.forEach((n, i) => {
    const alive = n.members().filter((m) => m.status === 'alive').length;
    const { sent, received, dropped } = n.stats;
    console.log(
      `  ${`n${i}`.padEnd(5)} ${String(BASE_PORT + i).padEnd(6)} ${String(edits[i]).padStart(5)} ${String(sent).padStart(5)} `
      + `${String(received).padStart(9)} ${String(dropped).padStart(8)} ${`${alive}/${nodes.length - 1}`.padStart(6)}  ${fingerprint(n.state)}`,
    );
  });
}

// --- Run ---

say(`${PEERS} peers, ${SECONDS} s of edits at ${RATE}/s each, ${Math.round(DROP * 100)}% of received packets dropped`
  + `${OUTAGE ? `, one peer offline for ${OUTAGE} s` : ''}, seed ${args.seed}`);
say(`log: ${logPath}`);

const nodes: PeerNode[] = [];
for (let i = 0; i < PEERS; i++) {
  const joinIndex = i === 0 ? undefined : Math.floor(random() * i); // any earlier node, not always n0
  nodes.push(new PeerNode({
    name: `n${i}`,
    port: BASE_PORT + i,
    join: joinIndex === undefined ? undefined : { address: '127.0.0.1', port: BASE_PORT + joinIndex },
    drop: DROP,
    log: (line) => log(`n${i}`, line),
  }));
  if (joinIndex !== undefined) log('harness', `n${i} joins through n${joinIndex}`);
}

let failed = false;
try {
  await Promise.all(nodes.map((n) => n.start()));
} catch (err) {
  say(`could not start the peers: ${(err as Error).message} (try another --port)`);
  process.exit(1);
}

const connectMs = await waitFor(() => allConnected(nodes), CONNECT_TIMEOUT_MS);
if (connectMs === null) {
  say(`FAILED: the peers did not all see each other within ${CONNECT_TIMEOUT_MS / 1000} s`);
  failed = true;
} else {
  say(`all ${PEERS} peers connected after ${connectMs} ms`);

  // Every node edits on its own timer, so edits from different nodes interleave and conflict.
  const edits = nodes.map(() => 0);
  const timers = nodes.map((n, i) => setInterval(() => {
    n.edit(randomEdit(n.now()));
    edits[i]++;
  }, 1000 / RATE));

  if (OUTAGE > 0) {
    setTimeout(() => {
      const i = Math.floor(random() * PEERS);
      say(`n${i} goes offline for ${OUTAGE} s`);
      nodes[i].goOffline(OUTAGE);
    }, (SECONDS * 1000) / 3);
  }

  await sleep(SECONDS * 1000);
  timers.forEach(clearInterval);
  say(`edits stopped: ${edits.reduce((a, b) => a + b, 0)} edits in total; waiting for the copies to converge`);

  const convergeMs = await waitFor(() => converged(nodes), CONVERGE_TIMEOUT_MS);
  printTable(nodes, edits);
  if (convergeMs === null) {
    say(`FAILED: no convergence within ${CONVERGE_TIMEOUT_MS / 1000} s after the edits stopped`);
    failed = true;
  } else {
    say(`CONVERGED ${convergeMs} ms after the edits stopped: every peer has the same state and sees all ${PEERS - 1} others`);
  }
}

nodes.forEach((n) => n.stop());
logFile.end();
process.exit(failed ? 1 : 0);
