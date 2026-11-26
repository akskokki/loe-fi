// Small pieces of the UI.
import type { ReactNode } from 'react';
import { Text } from 'ink';
import type { MemberView } from '../../net/node.js';

/** One help line: each [key, description] pair, with the key highlighted. */
export function HelpLine({ items }: { items: [string, string][] }) {
  return (
    <Text wrap="truncate-end">
      {items.map(([key, desc], i) => (
        <Text key={key}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text color="yellow" bold>
            {key}
          </Text>
          <Text dimColor> {desc}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** Members' names, with the node ID added to any name that more than one member uses. */
export function labels(members: MemberView[]): Map<number, string> {
  const count = new Map<string, number>();
  for (const m of members) count.set(m.name, (count.get(m.name) ?? 0) + 1);
  return new Map(members.map((m) => [m.id, count.get(m.name)! > 1 ? `${m.name} #${m.id}` : m.name]));
}

/** A row of per-step cells with a space after every fourth, matching stepAt(). */
export function StepRow({ steps, cell }: { steps: number; cell: (s: number) => ReactNode }) {
  return (
    <>
      {Array.from({ length: steps }, (_, s) => (
        <Text key={s}>
          {cell(s)}
          {s % 4 === 3 ? ' ' : ''}
        </Text>
      ))}
    </>
  );
}
