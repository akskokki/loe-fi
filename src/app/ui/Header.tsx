// The top of the screen: the banner, the title line and the control buttons. Their rows are fixed
// (layout.ts), because mouse clicks on the buttons are mapped back with the same layout.
import { Box, Text } from 'ink';
import { BANNER, BANNER_COLORS, CONTROL_ROW_STEP, type Segment } from './layout.js';

export function Header({ title, controls }: { title: string; controls: Segment[][] }) {
  return (
    <>
      {BANNER.map((line, row) => (
        <Text key={line} color={BANNER_COLORS[row]} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text bold wrap="truncate-end">
        {title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {controls.map((segments, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows are fixed and never reorder
          <Box key={row} marginTop={row > 0 ? CONTROL_ROW_STEP - 1 : 0}>
            {segments.map((segment, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a segment is identified by its position in the row
              <Text key={i} inverse={segment.action !== undefined} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    </>
  );
}
