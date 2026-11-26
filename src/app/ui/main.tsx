// Terminal UI: a live grid on top of a PeerNode, with audio.
//
//   npm run ui                                start a session on port 7051
//   npm run ui -- --join 192.168.1.10:7051    join a member at that address
//   add --name alice to show a name to the others (default: your OS user name)
//   add --no-audio to run silently; the other options are in ../cli.ts
//
// The log goes to logs/<node id>.log; the last lines are also shown at the bottom.
// Mouse handling works as in the tui-sequencer prototype: the app turns on the terminal's mouse
// reporting, reads click sequences from stdin (mouse.ts) and maps them to cells and buttons with
// the fixed layout (layout.ts).
import { parseArgs } from 'node:util';
import { render } from 'ink';
import type { AudioEngine } from '../../audio/engine.js';
import { COMMON_OPTIONS, nodeFromArgs, startAudio, startOrExit } from '../cli.js';
import { App, LOG_LINES } from './App.js';
import { LogBuffer } from './log.js';

const { values: args } = parseArgs({
  options: {
    ...COMMON_OPTIONS,
    'no-audio': { type: 'boolean', default: false },
  },
});

const node = nodeFromArgs(args, (line) => logs.log(line));
const logs = new LogBuffer(`logs/${node.id}.log`, LOG_LINES);
await startOrExit(node);

// Audio is optional: without it the grid still syncs, it just stays silent.
let audio: AudioEngine | null = null;
let audioOff = 'started with --no-audio';
if (!args['no-audio']) {
  const started = await startAudio(node, (line) => logs.log(line));
  if ('audio' in started) audio = started.audio;
  else audioOff = started.off;
}

// Full-screen mode, entered by hand: switching to the alternate screen (?1049h) keeps the cursor
// where it was, so also move it to the top-left (H) before Ink draws. Then row 1 of the terminal
// is row 1 of the UI and the fixed layout matches the mouse coordinates.
process.stdout.write('\x1b[?1049h\x1b[H');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));

const app = render(
  <App node={node} logs={logs} audio={audio} audioOff={audioOff} port={args.port} clearScreen={() => app.clear()} />,
);
await app.waitUntilExit();
await audio?.close();
node.stop();
logs.close();
process.exit(0);
