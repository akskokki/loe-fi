// The terminal UI's screen: the grid, the controls, the members and the log, on top of a PeerNode.
import { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { PeerNode } from '../../net/node.js';
import {
  addTrack,
  playheadAt,
  setSteps,
  setTrackStatus,
  toggleCell,
  updatePlayback,
  type State,
  type Track,
} from '../../state/state.js';
import { PRESETS } from '../../audio/presets.js';
import type { AudioEngine } from '../../audio/engine.js';
import { presetKey } from '../../samples/keys.js';
import { addSampleFile } from '../../samples/addfile.js';
import { localAddresses } from '../cli.js';
import {
  BANNER,
  BANNER_COLORS,
  CELL_WIDTH,
  CONTROL_ROW_STEP,
  LABEL_WIDTH,
  PAD,
  TRACKS_ROW,
  controlRows,
  hitTest,
  type Action,
} from './layout.js';
import { useMouseClicks } from './mouse.js';
import { HelpLine, StepRow, labels } from './components.js';
import type { LogBuffer } from './log.js';

export const LOG_LINES = 8; // at most; fewer when the terminal is short
const MAX_MEMBERS_SHOWN = 6; // the rest are summed up in one line
const GONE_SHOWN_MS = 5000; // a member that timed out is listed as gone this long, then left out

export type AppProps = {
  node: PeerNode;
  logs: LogBuffer;
  /** The audio engine, or null with the reason in `audioOff`. */
  audio: AudioEngine | null;
  audioOff: string;
  port: string;
  /** Forget Ink's last frame (see the resize handler). */
  clearScreen: () => void;
};

/** Visible tracks as [hash, track], in the same order on every node. */
function visibleTracks(state: State): [string, Track][] {
  return Object.entries(state.tracks)
    .filter(([, t]) => t.status.value !== 'deleted')
    .sort(([, a], [, b]) => a.name.value.localeCompare(b.name.value));
}

export function App({ node, logs, audio, audioOff, port, clearScreen }: AppProps) {
  const { exit } = useApp();
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Terminal height (Ink draws to process.stdout), kept up to date when the window is resized.
  const [rows, setRows] = useState(process.stdout.rows || 24);
  const tooSmall = useRef(false); // while the window is too short, the grid isn't drawn and clicks are ignored
  useEffect(() => {
    const onResize = () => {
      // After a resize, Ink's in-place redraw would erase the wrong lines (it counts lines of the
      // previous frame), so forget that frame, wipe the screen and draw the next frame from the top.
      clearScreen();
      process.stdout.write('\x1b[2J\x1b[H');
      setRows(process.stdout.rows || 24);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  const [cursor, setCursor] = useState({ track: 0, step: 0 });
  const [playhead, setPlayhead] = useState(0);
  const [adding, setAdding] = useState(false); // picking a preset for a new track
  const [filePath, setFilePath] = useState<string | null>(null); // sample file path being typed, or null
  const [deleting, setDeleting] = useState<string | null>(null); // hash of the track awaiting y/n, or null

  // Redraw when the state, a member's liveness or the log changes.
  useEffect(() => {
    const update = () => rerender();
    node.on('change', update);
    const unsubscribe = logs.subscribe(update);
    return () => {
      node.off('change', update);
      unsubscribe();
    };
  }, []);

  // Redraw once a second, so gone members drop off the list on time even when nothing else changes.
  useEffect(() => {
    const id = setInterval(rerender, 1000);
    return () => clearInterval(id);
  }, []);

  // Recompute the playhead ~30x/s from session time; React skips the redraw when it is unchanged.
  useEffect(() => {
    const id = setInterval(() => setPlayhead(playheadAt(node.state, node.now())), 33);
    return () => clearInterval(id);
  }, []);

  const state = node.state;
  const steps = state.settings.steps.value;
  const { playing, bpm } = state.playback.value;
  const tracks = visibleTracks(state);
  const cur = {
    track: Math.min(cursor.track, Math.max(0, tracks.length - 1)),
    step: Math.min(cursor.step, steps - 1),
  };
  const selected = tracks[cur.track];
  const controls = controlRows(playing, bpm, steps);

  const toggle = (track: number, step: number) => {
    const t = tracks[track];
    if (t) node.edit((s, me) => toggleCell(s, me, t[0], step));
  };

  const run = (action: Action) => {
    const now = node.now();
    switch (action) {
      case 'play':
        node.edit((s, me) => updatePlayback(s, me, now, { playing: !playing }));
        break;
      case 'bpmDown':
        node.edit((s, me) => updatePlayback(s, me, now, { bpm: Math.max(20, bpm - 5) }));
        break;
      case 'bpmUp':
        node.edit((s, me) => updatePlayback(s, me, now, { bpm: Math.min(300, bpm + 5) }));
        break;
      case 'stepsDown':
        node.edit((s, me) => setSteps(s, me, steps - 1));
        break;
      case 'stepsUp':
        node.edit((s, me) => setSteps(s, me, steps + 1));
        break;
      case 'add':
        setAdding(true);
        break;
      case 'mute':
        if (selected)
          node.edit((s, me) =>
            setTrackStatus(s, me, selected[0], selected[1].status.value === 'muted' ? 'active' : 'muted'),
          );
        break;
      case 'delete':
        if (selected) setDeleting(selected[0]);
        break;
      case 'quit':
        exit();
        break;
    }
  };

  useMouseClicks((x, y) => {
    if (deleting !== null || filePath !== null || tooSmall.current) return; // answer the question or finish the path first
    const target = hitTest(x, y, controls, tracks.length, steps);
    if (target?.kind === 'action') run(target.action);
    else if (target?.kind === 'track') setCursor((c) => ({ ...c, track: target.track }));
    else if (target?.kind === 'cell') {
      setCursor({ track: target.track, step: target.step });
      toggle(target.track, target.step);
    }
  });

  useInput((input, key) => {
    if (deleting !== null) {
      if (input === 'y' || input === 'Y') node.edit((s, me) => setTrackStatus(s, me, deleting, 'deleted'));
      setDeleting(null); // any other key cancels
      return;
    }
    if (filePath !== null) {
      if (key.escape) setFilePath(null);
      else if (key.return) {
        const file = filePath.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
        if (file) {
          logs.log(`adding ${file}…`);
          addSampleFile(node, file).then(
            ({ note }) => note && logs.log(`added, but ${note}`),
            (err: Error) => logs.log(err.message),
          );
        }
        setFilePath(null);
      } else if (key.backspace || key.delete) setFilePath(filePath.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !/[\p{Cc}]/u.test(input)) setFilePath(filePath + input); // typed or pasted text
      return;
    }
    if (adding) {
      const preset = PRESETS[Number(input) - 1];
      if (preset) node.edit((s, me) => addTrack(s, me, presetKey(preset), preset));
      else if (input === 'f') setFilePath('');
      setAdding(false); // a number picks a sound, f asks for a file, any other key cancels
      return;
    }
    const n = Math.max(1, tracks.length);
    if (key.leftArrow) setCursor({ ...cur, step: (cur.step + steps - 1) % steps });
    else if (key.rightArrow) setCursor({ ...cur, step: (cur.step + 1) % steps });
    else if (key.upArrow) setCursor({ ...cur, track: (cur.track + n - 1) % n });
    else if (key.downArrow) setCursor({ ...cur, track: (cur.track + 1) % n });
    else if (input === ' ' || key.return) toggle(cur.track, cur.step);
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
      rerender();
    } else if (input === 'q' || key.escape) run('quit');
  });

  const reachable = node.myAddress ?? localAddresses().find((a) => !a.startsWith('127.')) ?? '127.0.0.1';
  const sync = node.sync();
  const order = { me: 0, alive: 1, gone: 2, 'not heard from': 3 };
  const members = node
    .members()
    .filter((m) => m.status !== 'not heard from' && !(m.status === 'gone' && (m.goneForMs ?? 0) > GONE_SHOWN_MS))
    .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const label = labels(members);
  // Ink can only redraw in place while the whole UI fits in the terminal, so the parts below the
  // grid get the space that is left: the log shrinks and disappears first, then the member list
  // (down to this node plus an "… and N more" line), and anything else is clipped at the bottom.
  const top = PAD + TRACKS_ROW + Math.max(1, tracks.length) + 1 + 3; // through the grid, playhead row and help
  const memberRoom = rows - 1 - top - PAD - 4; // 4: blank, "Members", clock, audio
  let showCount = Math.min(members.length, MAX_MEMBERS_SHOWN, Math.max(1, memberRoom));
  if (showCount < members.length) showCount = Math.max(1, Math.min(showCount, memberRoom - 1)); // room for "… and N more"
  const shownMembers = members.slice(0, showCount);
  const moreMembers = members.length - shownMembers.length;
  const linesAboveLog = top + 2 + shownMembers.length + (moreMembers > 0 ? 1 : 0) + 2;
  const logRoom = Math.min(LOG_LINES, rows - 1 - linesAboveLog - 2 - PAD); // 2: blank line and "Log" title
  const shownLog = logRoom > 0 ? logs.lines.slice(-logRoom) : [];

  // Too short even for the grid and one member line: drawing anyway would scroll and garble the
  // terminal, so ask for a taller window instead (the grid comes back as soon as it fits).
  const needed = linesAboveLog + PAD + 1;
  tooSmall.current = rows < needed;
  if (tooSmall.current) {
    return (
      <Box padding={PAD}>
        <Text color="yellow" wrap="truncate-end">
          The window is too short for Lö-Fi: make it at least {needed} rows tall (now {rows}).
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={PAD} height={rows - 1} overflow="hidden">
      {BANNER.map((line, i) => (
        <Text key={i} color={BANNER_COLORS[i]} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text bold wrap="truncate-end">
        Lö-Fi · {node.opts.name} · others join with --join {reachable}:{port}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {controls.map((row, r) => (
          <Box key={r} marginTop={r > 0 ? CONTROL_ROW_STEP - 1 : 0}>
            {row.map((seg, i) => (
              <Text key={i} inverse={!!seg.action} color={seg.color}>
                {seg.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Box width={LABEL_WIDTH} />
        <StepRow
          steps={steps}
          cell={(s) => <Text dimColor>{s % 4 === 0 ? String(s + 1).padEnd(CELL_WIDTH) : '   '}</Text>}
        />
      </Box>
      {tracks.length === 0 && <Text dimColor>(no tracks yet: press a or click Add track)</Text>}
      {tracks.map(([hash, t], i) => {
        const muted = t.status.value === 'muted';
        return (
          <Box key={hash}>
            <Box width={LABEL_WIDTH}>
              <Text bold={i === cur.track} dimColor={muted} wrap="truncate-end">
                {t.name.value.slice(0, 9).padEnd(9)}
                {muted ? 'M' : node.hasSound(hash) ? ' ' : '↓'}
              </Text>
            </Box>
            <StepRow
              steps={steps}
              cell={(s) => {
                const on = t.cells[s].value;
                const color = playing && playhead === s ? 'yellow' : on ? (muted ? 'gray' : 'green') : 'gray';
                return (
                  <Text inverse={i === cur.track && s === cur.step} color={color}>
                    {on ? '[■]' : '[ ]'}
                  </Text>
                );
              }}
            />
          </Box>
        );
      })}
      <Box>
        <Box width={LABEL_WIDTH} />
        <StepRow steps={steps} cell={(s) => <Text color="yellow">{playing && playhead === s ? ' ▲ ' : '   '}</Text>} />
      </Box>

      <Box marginTop={1} flexDirection="column" height={2}>
        {deleting !== null ? (
          <Text>
            Delete track <Text color="red">{state.tracks[deleting]?.name.value}</Text>? <Text dimColor>(y/n)</Text>
          </Text>
        ) : filePath !== null ? (
          <Box flexDirection="column">
            <Box>
              <Text>Sample file: </Text>
              {/* a long path loses its start, so the end being typed stays visible */}
              <Text wrap="truncate-start" color="cyan">
                {filePath}
              </Text>
              <Text inverse> </Text>
            </Box>
            <Text dimColor>any audio file up to 5 MB · Enter adds · Esc cancels</Text>
          </Box>
        ) : adding ? (
          <Text wrap="truncate-end">
            Add a sound:{' '}
            {PRESETS.map((p, i) => {
              const k = presetKey(p);
              const present = Object.hasOwn(state.tracks, k) && state.tracks[k].status.value !== 'deleted';
              return (
                <Text key={p}>
                  <Text color="yellow" bold>
                    {i + 1}
                  </Text>{' '}
                  <Text dimColor={present}>{p}</Text>
                  {'  '}
                </Text>
              );
            })}
            <Text color="yellow" bold>
              f
            </Text>{' '}
            file…{'  '}
            <Text dimColor>(any other key cancels)</Text>
          </Text>
        ) : (
          <>
            <HelpLine
              items={[
                ['click', 'cells and buttons'],
                ['arrows', 'move'],
                ['space', 'toggle'],
                ['m', 'mute'],
                ['d', 'delete'],
              ]}
            />
            <HelpLine
              items={[
                ['p', 'play/stop'],
                ['+/-', 'tempo'],
                ['[ ]', 'steps'],
                ['a', 'add track'],
                ['< >', 'volume'],
                ['q', 'quit'],
              ]}
            />
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Members</Text>
        {shownMembers.map((m) => (
          <Text key={m.id} wrap="truncate-end">
            <Text color={m.status === 'gone' ? 'red' : 'green'}>{m.status === 'gone' ? '○' : '●'}</Text>{' '}
            {label.get(m.id)} <Text dimColor>{m.status === 'me' ? '(me)' : m.status === 'gone' ? '(gone)' : ''}</Text>
            {m.id === sync.reference && <Text color="yellow"> time reference</Text>}
          </Text>
        ))}
        {moreMembers > 0 && (
          <Text dimColor>
            … and {moreMembers} more ({members.slice(showCount).filter((m) => m.status === 'alive').length} alive)
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {sync.iAmReference
            ? 'Clock: this node is the time reference'
            : sync.reference === null
              ? 'Clock: no time reference yet'
              : `Clock: ${sync.synced ? 'synced' : 'syncing'} to ${sync.referenceName}, offset ${sync.offsetMs.toFixed(1)} ms` +
                (sync.delayMs === null ? '' : `, round trip ${sync.delayMs.toFixed(1)} ms`)}
        </Text>
        <Text dimColor wrap="truncate-end">
          {audio
            ? `Audio: on, volume ${Math.round(audio.volume * 100)}%, output latency ${audio.latencyMs.toFixed(0)} ms (corrected for)`
            : `Audio: off (${audioOff})`}
        </Text>
      </Box>

      {shownLog.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold wrap="truncate-end">
            Log <Text dimColor>({logs.path})</Text>
          </Text>
          {shownLog.map((l, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {l}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
