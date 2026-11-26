// The panels under the grid: who is in the session (with the clock and audio status), and the log.
import { Box, Text } from 'ink';
import type { AudioEngine } from '../../audio/engine.js';
import type { MemberView, SyncView } from '../../net/node.js';
import { labels } from './components.js';
import type { LogEntry } from './log.js';

export type MembersPanelProps = {
  /** Members to list, already sorted and cut to what fits. */
  shown: MemberView[];
  /** Members left out for lack of room. */
  hidden: MemberView[];
  sync: SyncView;
  audio: AudioEngine | null;
  /** Why there is no audio, when `audio` is null. */
  audioOff: string;
};

export function MembersPanel({ shown, hidden, sync, audio, audioOff }: MembersPanelProps) {
  const label = labels([...shown, ...hidden]);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Members</Text>
      {shown.map((member) => {
        const gone = member.status === 'gone';
        return (
          <Text key={member.id} wrap="truncate-end">
            <Text color={gone ? 'red' : 'green'}>{gone ? '○' : '●'}</Text> {label.get(member.id)}{' '}
            <Text dimColor>{member.status === 'me' ? '(me)' : gone ? '(gone)' : ''}</Text>
            {member.id === sync.reference && <Text color="yellow"> time reference</Text>}
          </Text>
        );
      })}
      {hidden.length > 0 && (
        <Text dimColor>
          … and {hidden.length} more ({hidden.filter((member) => member.status === 'alive').length} alive)
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {clockStatus(sync)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {audio
          ? `Audio: on, volume ${Math.round(audio.volume * 100)}%, output latency ${audio.latencyMs.toFixed(0)} ms (corrected for)`
          : `Audio: off (${audioOff})`}
      </Text>
    </Box>
  );
}

function clockStatus(sync: SyncView): string {
  if (sync.iAmReference) return 'Clock: this node is the time reference';
  if (sync.reference === null) return 'Clock: no time reference yet';
  const roundTrip = sync.delayMs === null ? '' : `, round trip ${sync.delayMs.toFixed(1)} ms`;
  return `Clock: ${sync.synced ? 'synced' : 'syncing'} to ${sync.referenceName}, offset ${sync.offsetMs.toFixed(1)} ms${roundTrip}`;
}

export function LogPanel({ entries, path }: { entries: LogEntry[]; path: string }) {
  if (entries.length === 0) return null;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold wrap="truncate-end">
        Log <Text dimColor>({path})</Text>
      </Text>
      {entries.map((entry) => (
        <Text key={entry.id} dimColor wrap="truncate-end">
          {entry.text}
        </Text>
      ))}
    </Box>
  );
}
