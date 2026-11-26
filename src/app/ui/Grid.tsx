// The sequencer grid: step numbers, one row per track, and the playhead marker under it. Cells are
// drawn with StepRow, whose spacing layout.ts's hitTest() mirrors, so clicks land on the right cell.
import { Box, Text } from 'ink';
import type { Track } from '../../state/state.js';
import { StepRow } from './components.js';
import { CELL_WIDTH, LABEL_WIDTH } from './layout.js';

export type GridProps = {
  /** The tracks to show, as [track key, track], in display order. */
  tracks: [string, Track][];
  steps: number;
  cursor: { track: number; step: number };
  playing: boolean;
  playhead: number;
  /** Whether this node has the track's sound (sample files may still be on their way). */
  hasSound: (trackKey: string) => boolean;
};

export function Grid({ tracks, steps, cursor, playing, playhead, hasSound }: GridProps) {
  return (
    <>
      <Box marginTop={1}>
        <Box width={LABEL_WIDTH} />
        <StepRow
          steps={steps}
          cell={(step) => <Text dimColor>{step % 4 === 0 ? String(step + 1).padEnd(CELL_WIDTH) : '   '}</Text>}
        />
      </Box>
      {tracks.length === 0 && <Text dimColor>(no tracks yet: press a or click Add track)</Text>}
      {tracks.map(([trackKey, track], row) => {
        const muted = track.status.value === 'muted';
        // After the name: M for muted, ↓ while the sample file hasn't arrived.
        const marker = muted ? 'M' : hasSound(trackKey) ? ' ' : '↓';
        return (
          <Box key={trackKey}>
            <Box width={LABEL_WIDTH}>
              <Text bold={row === cursor.track} dimColor={muted} wrap="truncate-end">
                {track.name.value.slice(0, 9).padEnd(9)}
                {marker}
              </Text>
            </Box>
            <StepRow
              steps={steps}
              cell={(step) => {
                const on = track.cells[step].value;
                const color = playing && playhead === step ? 'yellow' : on ? (muted ? 'gray' : 'green') : 'gray';
                return (
                  <Text inverse={row === cursor.track && step === cursor.step} color={color}>
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
        <StepRow
          steps={steps}
          cell={(step) => <Text color="yellow">{playing && playhead === step ? ' ▲ ' : '   '}</Text>}
        />
      </Box>
    </>
  );
}
