// Headless peer: a PeerNode (node.ts) that prints its log to the terminal and takes typed commands.
//
//   npm run peer                              start a session on port 7051
//   npm run peer -- --join 192.168.1.10:7051  join a member at that address
//   npm run peer -- --port 7052 --join 127.0.0.1:7051   second peer on the same machine
//   add --name alice to show a name to the others (default: your OS user name)
//   add --verbose to log every STATE message sent and received
//   add --drop 0.3 to throw away 30% of received packets (a lossy network)
//   add --audio to play the grid (the UI plays it by default)
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { PeerNode, chooseName, localAddresses, parseAddress } from './node.js';
import { MAX_STEPS, addTrack, fingerprint, setSteps, setTrackStatus, toggleCell, updatePlayback, type NodeId, type State } from './state.js';
import { renderGrid } from './describe.js';
import { PRESETS, isPreset } from './presets.js';
import { AudioEngine } from './audio.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '7051' },
    join: { type: 'string' },
    name: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    drop: { type: 'string', default: '0' }, // share of received packets to throw away, e.g. 0.3
    audio: { type: 'boolean', default: false }, // play the grid; off by default so peers on VMs need no sound setup
  },
});

const chosen = chooseName(args.name);
if ('error' in chosen) {
  console.error(chosen.error);
  process.exit(1);
}

const node: PeerNode = new PeerNode({
  name: chosen.name,
  port: Number(args.port),
  join: args.join ? parseAddress(args.join) : undefined,
  verbose: args.verbose,
  drop: Number(args.drop),
  log: (s) => console.log(`${new Date().toISOString().slice(11, 23)} [${node.id}] ${s}`),
});

const HELP = `commands:
  add <sound>          add a track: ${PRESETS.join(', ')}
  t <track> <steps>    toggle steps, counted from 1 (e.g. t kick 1, t hihat 1 5 14, t snare 1-4)
  mute|unmute|del <track>
  play | stop | bpm <n> | steps <n>
  show                 print the grid and the members
  offline <seconds>    drop all packets for a while, to test failures
  help | quit`;

// Turns step arguments like ["1", "5-8"] into 0-based indexes, each at most once.
function parseSteps(args: string[]): number[] {
  const steps = new Set<number>();
  for (const arg of args) {
    const range = arg.match(/^(\d+)-(\d+)$/);
    if (!range) { steps.add(Number(arg) - 1); continue; }
    const lo = Number(range[1]), hi = Math.min(Number(range[2]), MAX_STEPS);
    for (let s = lo; s <= hi; s++) steps.add(s - 1);
  }
  return [...steps];
}

function show() {
  for (const l of renderGrid(node.state, node.now())) console.log(`  ${l}`);
  for (const m of node.members()) {
    const seen = m.seenMsAgo === undefined ? '' : `, seen ${m.seenMsAgo} ms ago`;
    console.log(`  member ${m.name} (${m.id}) ${m.address ?? '?'}:${m.port} heartbeat ${m.heartbeat} (${m.status}${seen})`);
  }
  // Same fingerprint on two peers = same sequencer state. Packet counts include the --drop losses.
  const { sent, received, dropped } = node.stats;
  console.log(`  state fingerprint ${fingerprint(node.state)} · packets sent ${sent}, received ${received}, dropped ${dropped}`);
  const sync = node.sync();
  if (sync.iAmReference) console.log('  clock: this node is the time reference');
  else if (sync.reference === null) console.log('  clock: no time reference yet');
  else {
    const delay = sync.delayMs === null ? '' : `, round trip ${sync.delayMs.toFixed(1)} ms`;
    console.log(`  clock: ${sync.synced ? 'synced' : 'syncing'} to ${sync.referenceName}, offset ${sync.offsetMs.toFixed(1)} ms${delay}`);
  }
}

function run(line: string) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const now = node.now();
  let change: ((s: State, me: NodeId) => State) | undefined;
  switch (cmd) {
    case '': return;
    case 'add':
      if (!isPreset(rest[0] ?? '')) return console.log(`no sound called "${rest[0] ?? ''}"; choose one of: ${PRESETS.join(', ')}`);
      change = (s, me) => addTrack(s, me, rest[0], rest[0]);
      break;
    case 't': change = (s, me) => parseSteps(rest.slice(1)).reduce((acc, step) => toggleCell(acc, me, rest[0], step), s); break;
    case 'mute': change = (s, me) => setTrackStatus(s, me, rest[0], 'muted'); break;
    case 'unmute': change = (s, me) => setTrackStatus(s, me, rest[0], 'active'); break;
    case 'del': change = (s, me) => setTrackStatus(s, me, rest[0], 'deleted'); break;
    case 'play': change = (s, me) => updatePlayback(s, me, now, { playing: true }); break;
    case 'stop': change = (s, me) => updatePlayback(s, me, now, { playing: false }); break;
    case 'bpm': if (Number(rest[0]) > 0) change = (s, me) => updatePlayback(s, me, now, { bpm: Number(rest[0]) }); break;
    case 'steps': if (Number(rest[0]) > 0) change = (s, me) => setSteps(s, me, Number(rest[0])); break;
    case 'show': return show();
    case 'offline': return node.goOffline(Number(rest[0] || 10));
    case 'help': return console.log(HELP);
    case 'quit': process.exit(0);
    default: return console.log(`unknown command "${cmd}", try help`);
  }
  if (!change || node.edit(change).length === 0) console.log('nothing changed (unknown track or step?)');
}

try {
  await node.start();
} catch (err) {
  console.error(`could not listen on UDP port ${args.port}: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`${node.opts.name} listening on UDP port ${args.port}. Others can join with one of:`);
for (const a of localAddresses()) console.log(`    --join ${a}:${args.port}`);
console.log('type "help" for commands');
if (args.audio) {
  try {
    const audio = await AudioEngine.open();
    audio.start(() => node.state, () => node.now());
    console.log(`audio on, output latency ${audio.latencyMs.toFixed(0)} ms`);
  } catch (err) {
    console.log(`audio off: ${(err as Error).message}`);
  }
}
readline.createInterface({ input: process.stdin }).on('line', run).on('close', () => process.exit(0));
