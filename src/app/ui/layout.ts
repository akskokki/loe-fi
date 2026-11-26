// The UI's fixed layout, shared by drawing (App.tsx) and mouse hit-testing, so a click lands on
// the cell or button drawn there. Pure functions only, so it can be tested without a terminal.

export const PAD = 1; // <Box padding={1}>
export const BANNER = [
  '             ▄▄  ▄▄',
  ' ██        ▄██████▄          ████████  ▄▄',
  ' ██        ██    ██  ▄▄▄▄▄▄  ██▄▄▄▄',
  ' ██        ██    ██          ██        ██',
  ' ██▄▄▄▄▄▄  ▀██████▀          ██        ██  ♪ ♫',
];
export const BANNER_COLORS = ['magenta', 'magenta', 'magentaBright', 'cyan', 'cyanBright'];
export const CONTROLS_ROW = BANNER.length + 2; // banner, title, blank, then the control rows
export const CONTROL_ROW_STEP = 2; // each control row is followed by a blank line
export const CONTROL_ROWS = 2;
// control rows with blank lines between, blank, step numbers, then one row per track
export const TRACKS_ROW = CONTROLS_ROW + (CONTROL_ROWS - 1) * CONTROL_ROW_STEP + 3;
export const CONTROL_LABEL_WIDTH = 10; // "Playback" / "Tracks" in front of each control row
export const LABEL_WIDTH = 11; // track name (9) + mute marker + space
export const CELL_WIDTH = 3; // "[■]"
export const GROUP_WIDTH = 4 * CELL_WIDTH + 1; // four cells and a space

/** The step at a column measured from the start of the cells, or null on a gap. */
export function stepAt(x: number): number | null {
  const group = Math.floor(x / GROUP_WIDTH);
  const inGroup = x % GROUP_WIDTH;
  return inGroup >= 4 * CELL_WIDTH ? null : group * 4 + Math.floor(inGroup / CELL_WIDTH);
}

export type Action = 'play' | 'bpmDown' | 'bpmUp' | 'stepsDown' | 'stepsUp' | 'add' | 'mute' | 'delete' | 'quit';
export type Segment = { text: string; action?: Action; color?: string };

/**
 * The control buttons, one array per row, each starting with a label: the session's playback
 * settings (and leaving the session) first, then the actions on tracks.
 */
export function controlRows(playing: boolean, bpm: number, steps: number): Segment[][] {
  return [
    [
      { text: 'Playback'.padEnd(CONTROL_LABEL_WIDTH) },
      { text: playing ? ' Stop ' : ' Play ', action: 'play', color: playing ? 'red' : 'green' },
      { text: '   BPM ' },
      { text: ' - ', action: 'bpmDown', color: 'blue' },
      { text: ` ${String(bpm).padStart(3)} ` },
      { text: ' + ', action: 'bpmUp', color: 'blue' },
      { text: '   Steps ' },
      { text: ' - ', action: 'stepsDown', color: 'yellow' },
      { text: ` ${String(steps).padStart(2)} ` },
      { text: ' + ', action: 'stepsUp', color: 'yellow' },
      { text: '   ' },
      { text: ' Quit ', action: 'quit', color: 'gray' },
    ],
    [
      { text: 'Tracks'.padEnd(CONTROL_LABEL_WIDTH) },
      { text: ' Add track ', action: 'add', color: 'cyan' },
      { text: ' ' },
      { text: ' Mute ', action: 'mute', color: 'magenta' },
      { text: ' ' },
      { text: ' Delete ', action: 'delete', color: 'red' },
    ],
  ];
}

export type Target =
  | { kind: 'action'; action: Action }
  | { kind: 'cell'; track: number; step: number }
  | { kind: 'track'; track: number };

// x, y are the terminal's 1-based mouse coordinates.
export function hitTest(x: number, y: number, rows: Segment[][], trackCount: number, steps: number): Target | null {
  const cx = x - 1 - PAD;
  const cy = y - 1 - PAD;
  const offset = cy - CONTROLS_ROW;
  const row = offset % CONTROL_ROW_STEP === 0 ? rows[offset / CONTROL_ROW_STEP] : undefined;
  if (offset >= 0 && row) {
    let start = 0;
    for (const seg of row) {
      if (seg.action && cx >= start && cx < start + seg.text.length) return { kind: 'action', action: seg.action };
      start += seg.text.length;
    }
    return null;
  }
  const track = cy - TRACKS_ROW;
  if (track < 0 || track >= trackCount || cx < 0) return null;
  if (cx < LABEL_WIDTH) return { kind: 'track', track };
  const step = stepAt(cx - LABEL_WIDTH);
  return step !== null && step < steps ? { kind: 'cell', track, step } : null;
}
