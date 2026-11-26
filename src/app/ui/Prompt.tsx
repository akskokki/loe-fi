// The two lines under the grid: a question or input the UI is waiting for, or else the key help.
import { Box, Text } from 'ink';
import { PRESETS } from '../../audio/presets.js';
import { HelpLine } from './components.js';

/** What the two lines under the grid show. */
export type PromptState =
  | { kind: 'help' }
  | { kind: 'confirmDelete'; trackName: string }
  | { kind: 'pickSound'; presetsInUse: Set<string> }
  | { kind: 'filePath'; path: string };

export function Prompt({ prompt }: { prompt: PromptState }) {
  return (
    <Box marginTop={1} flexDirection="column" height={2}>
      {prompt.kind === 'confirmDelete' && (
        <Text>
          Delete track <Text color="red">{prompt.trackName}</Text>? <Text dimColor>(y/n)</Text>
        </Text>
      )}
      {prompt.kind === 'filePath' && (
        <>
          <Box>
            <Text>Sample file: </Text>
            {/* a long path loses its start, so the end being typed stays visible */}
            <Text wrap="truncate-start" color="cyan">
              {prompt.path}
            </Text>
            <Text inverse> </Text>
          </Box>
          <Text dimColor>any audio file up to 5 MB · Enter adds · Esc cancels</Text>
        </>
      )}
      {prompt.kind === 'pickSound' && (
        <Text wrap="truncate-end">
          Add a sound:{' '}
          {PRESETS.map((preset, i) => (
            <Text key={preset}>
              <Text color="yellow" bold>
                {i + 1}
              </Text>{' '}
              <Text dimColor={prompt.presetsInUse.has(preset)}>{preset}</Text>
              {'  '}
            </Text>
          ))}
          <Text color="yellow" bold>
            f
          </Text>{' '}
          file…{'  '}
          <Text dimColor>(any other key cancels)</Text>
        </Text>
      )}
      {prompt.kind === 'help' && (
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
  );
}
