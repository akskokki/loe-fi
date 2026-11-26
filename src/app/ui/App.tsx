// The terminal UI's screen, on top of a PeerNode: the controls, the grid, the members and the log.
// This component holds the UI's own state (cursor, prompts), turns mouse clicks and keys into
// actions, and lays the parts out within the terminal's height (fit.ts).
import { useRef } from 'react';
import { Box, Text, useApp, useInput, type Key } from 'ink';
import type { AudioEngine } from '../../audio/engine.js';
import { PRESETS } from '../../audio/presets.js';
import type { MemberStatus, PeerNode } from '../../net/node.js';
import { addSampleFile } from '../../samples/addfile.js';
import { presetKey } from '../../samples/keys.js';
import {
  addTrack,
  setSteps,
  setTrackStatus,
  toggleCell,
  updatePlayback,
  type State,
  type Track,
} from '../../state/state.js';
import { localAddresses } from '../cli.js';
import { fitToHeight } from './fit.js';
import { Grid } from './Grid.js';
import { Header } from './Header.js';
import { usePlayhead, useRedraw, useTerminalRows } from './hooks.js';
import { PAD, controlRows, hitTest, type Action } from './layout.js';
import type { LogBuffer } from './log.js';
import { useMouseClicks } from './mouse.js';
import { LogPanel, MembersPanel } from './Panels.js';
import { Prompt, type PromptState } from './Prompt.js';

const GONE_SHOWN_MS = 5000; // a member that timed out is listed as gone this long, then left out
const MEMBER_ORDER: Record<MemberStatus, number> = { me: 0, alive: 1, gone: 2, 'not heard from': 3 };

export type AppProps = {
  node: PeerNode;
  logs: LogBuffer;
  /** The audio engine, or null with the reason in `audioOff`. */
  audio: AudioEngine | null;
  audioOff: string;
  port: string;
  /** Forget Ink's last frame (see useTerminalRows). */
  clearScreen: () => void;
};

/** Tracks that aren't deleted, as [track key, track], sorted by name so every node shows the same order. */
function visibleTracks(state: State): [string, Track][] {
  return Object.entries(state.tracks)
    .filter(([, track]) => track.status.value !== 'deleted')
    .sort(([, a], [, b]) => a.name.value.localeCompare(b.name.value));
}

/** What the keyboard is driving: the grid, or one of the prompts under it. */
type Mode =
  | { kind: 'grid' }
  | { kind: 'pickSound' }
  | { kind: 'filePath'; path: string }
  | { kind: 'confirmDelete'; trackKey: string };

/**
 * The UI's own state. It lives in a ref, not in React state, because keys can arrive faster than
 * the UI redraws (fast typing, a held arrow key): each key's handler must see what the key before
 * it did, not the state as of the last redraw. Handlers change it and then ask for a redraw.
 */
type UiState = { cursor: { track: number; step: number }; mode: Mode };

export function App({ node, logs, audio, audioOff, port, clearScreen }: AppProps) {
  const { exit } = useApp();
  const rows = useTerminalRows(clearScreen);
  const redraw = useRedraw(node, logs);
  const playhead = usePlayhead(node);
  const ui = useRef<UiState>({ cursor: { track: 0, step: 0 }, mode: { kind: 'grid' } }).current;
  const tooSmall = useRef(false); // while the window is too short, the grid isn't drawn and clicks are ignored

  /** The grid as it is right now, with the cursor kept inside it when tracks or steps disappear. */
  const current = () => {
    const state = node.state;
    const steps = state.settings.steps.value;
    const tracks = visibleTracks(state);
    ui.cursor = {
      track: Math.min(ui.cursor.track, Math.max(0, tracks.length - 1)),
      step: Math.min(ui.cursor.step, steps - 1),
    };
    const { playing, bpm } = state.playback.value;
    return { state, steps, tracks, playing, bpm, controls: controlRows(playing, bpm, steps) };
  };

  const setMode = (mode: Mode) => {
    ui.mode = mode;
    redraw();
  };

  const moveCursor = (track: number, step: number) => {
    ui.cursor = { track, step };
    redraw();
  };

  // --- Actions ---

  const toggle = (row: number, step: number) => {
    const trackKey = current().tracks[row]?.[0];
    if (trackKey) node.edit((state, me) => toggleCell(state, me, trackKey, step));
  };

  const run = (action: Action) => {
    const { tracks, steps, playing, bpm } = current();
    const selected = tracks[ui.cursor.track]; // [track key, track], or undefined without tracks
    const now = node.now();
    switch (action) {
      case 'play':
        node.edit((state, me) => updatePlayback(state, me, now, { playing: !playing }));
        break;
      case 'bpmDown':
        node.edit((state, me) => updatePlayback(state, me, now, { bpm: Math.max(20, bpm - 5) }));
        break;
      case 'bpmUp':
        node.edit((state, me) => updatePlayback(state, me, now, { bpm: Math.min(300, bpm + 5) }));
        break;
      case 'stepsDown':
        node.edit((state, me) => setSteps(state, me, steps - 1));
        break;
      case 'stepsUp':
        node.edit((state, me) => setSteps(state, me, steps + 1));
        break;
      case 'add':
        setMode({ kind: 'pickSound' });
        break;
      case 'mute':
        if (selected) {
          const [trackKey, track] = selected;
          const status = track.status.value === 'muted' ? 'active' : 'muted';
          node.edit((state, me) => setTrackStatus(state, me, trackKey, status));
        }
        break;
      case 'delete':
        if (selected) setMode({ kind: 'confirmDelete', trackKey: selected[0] });
        break;
      case 'quit':
        exit();
        break;
    }
  };

  const addFile = (path: string) => {
    const file = path.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
    if (!file) return;
    logs.log(`adding ${file}…`);
    addSampleFile(node, file).then(
      ({ note }) => note && logs.log(`added, but ${note}`),
      (err: Error) => logs.log(err.message),
    );
  };

  // --- Input ---

  useMouseClicks((x, y) => {
    if (ui.mode.kind !== 'grid' || tooSmall.current) return; // answer the prompt first
    const { controls, tracks, steps } = current();
    const target = hitTest(x, y, controls, tracks.length, steps);
    if (target?.kind === 'action') run(target.action);
    else if (target?.kind === 'track') moveCursor(target.track, ui.cursor.step);
    else if (target?.kind === 'cell') {
      moveCursor(target.track, target.step);
      toggle(target.track, target.step);
    }
  });

  /** y deletes the track, any other key cancels. */
  const answerDelete = (trackKey: string, input: string) => {
    if (input === 'y' || input === 'Y') node.edit((state, me) => setTrackStatus(state, me, trackKey, 'deleted'));
    setMode({ kind: 'grid' });
  };

  /** Typing (or pasting) the path; Enter adds the file, Esc cancels. */
  const typePath = (path: string, input: string, key: Key) => {
    if (key.escape) setMode({ kind: 'grid' });
    else if (key.return) {
      addFile(path);
      setMode({ kind: 'grid' });
    } else if (key.backspace || key.delete) setMode({ kind: 'filePath', path: path.slice(0, -1) });
    else if (input && !key.ctrl && !key.meta && !/[\p{Cc}]/u.test(input)) {
      setMode({ kind: 'filePath', path: path + input });
    }
  };

  /** A number picks a preset, f asks for a file, any other key cancels. */
  const pickSound = (input: string) => {
    const preset = PRESETS[Number(input) - 1];
    if (input === 'f') return setMode({ kind: 'filePath', path: '' });
    if (preset) node.edit((state, me) => addTrack(state, me, presetKey(preset), preset));
    setMode({ kind: 'grid' });
  };

  /** Keys on the grid itself. */
  const gridKey = (input: string, key: Key) => {
    const { tracks, steps } = current();
    const { track, step } = ui.cursor;
    const trackCount = Math.max(1, tracks.length);
    if (key.leftArrow) moveCursor(track, (step + steps - 1) % steps);
    else if (key.rightArrow) moveCursor(track, (step + 1) % steps);
    else if (key.upArrow) moveCursor((track + trackCount - 1) % trackCount, step);
    else if (key.downArrow) moveCursor((track + 1) % trackCount, step);
    else if (input === ' ' || key.return) toggle(track, step);
    else if (input === 'p') run('play');
    else if (input === '+' || input === '=') run('bpmUp');
    else if (input === '-') run('bpmDown');
    else if (input === ']') run('stepsUp');
    else if (input === '[') run('stepsDown');
    else if (input === 'a') run('add');
    else if (input === 'm') run('mute');
    else if (input === 'd') run('delete');
    else if ((input === '<' || input === '>') && audio) {
      audio.setVolume(audio.volume + (input === '>' ? 0.1 : -0.1));
      redraw();
    } else if (input === 'q' || key.escape) run('quit');
  };

  useInput((input, key) => {
    const mode = ui.mode;
    if (mode.kind === 'confirmDelete') answerDelete(mode.trackKey, input);
    else if (mode.kind === 'filePath') typePath(mode.path, input, key);
    else if (mode.kind === 'pickSound') pickSound(input);
    else gridKey(input, key);
  });

  // --- Layout ---

  const { state, steps, tracks, playing, controls } = current();

  const members = node
    .members()
    .filter(
      (member) =>
        member.status !== 'not heard from' && !(member.status === 'gone' && (member.goneForMs ?? 0) > GONE_SHOWN_MS),
    )
    .sort((a, b) => MEMBER_ORDER[a.status] - MEMBER_ORDER[b.status] || a.name.localeCompare(b.name));
  const fit = fitToHeight(rows, tracks.length, members.length);
  tooSmall.current = fit.tooSmall;
  if (fit.tooSmall) {
    return (
      <Box padding={PAD}>
        <Text color="yellow" wrap="truncate-end">
          The window is too short for Lö-Fi: make it at least {fit.needed} rows tall (now {rows}).
        </Text>
      </Box>
    );
  }

  const reachable = node.myAddress ?? localAddresses().find((address) => !address.startsWith('127.')) ?? '127.0.0.1';
  const presetsInUse = new Set(PRESETS.filter((preset) => tracks.some(([trackKey]) => trackKey === presetKey(preset))));
  const mode = ui.mode;
  const prompt: PromptState =
    mode.kind === 'confirmDelete'
      ? { kind: 'confirmDelete', trackName: state.tracks[mode.trackKey]?.name.value ?? '?' }
      : mode.kind === 'filePath'
        ? { kind: 'filePath', path: mode.path }
        : mode.kind === 'pickSound'
          ? { kind: 'pickSound', presetsInUse }
          : { kind: 'help' };

  return (
    <Box flexDirection="column" padding={PAD} height={rows - 1} overflow="hidden">
      <Header title={`Lö-Fi · ${node.opts.name} · others join with --join ${reachable}:${port}`} controls={controls} />
      <Grid
        tracks={tracks}
        steps={steps}
        cursor={ui.cursor}
        playing={playing}
        playhead={playhead}
        hasSound={(trackKey) => node.hasSound(trackKey)}
      />
      <Prompt prompt={prompt} />
      <MembersPanel
        shown={members.slice(0, fit.members)}
        hidden={members.slice(fit.members)}
        sync={node.sync()}
        audio={audio}
        audioOff={audioOff}
      />
      <LogPanel entries={fit.logLines > 0 ? logs.entries.slice(-fit.logLines) : []} path={logs.path} />
    </Box>
  );
}
