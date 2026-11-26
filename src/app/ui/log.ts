// The UI's log: every line goes to a file, and the last few are kept for the screen.
import fs from 'node:fs';

export type LogEntry = { id: number; text: string };

export class LogBuffer {
  /** The last entries, newest last. Each has an id that never repeats, for use as a React key. */
  readonly entries: LogEntry[] = [];
  private nextId = 0;
  private listeners = new Set<() => void>();
  private file: fs.WriteStream | undefined;

  /** `path` is only opened when the first line is written. */
  constructor(
    readonly path: string,
    private readonly keep: number,
  ) {}

  log(line: string) {
    const text = `${new Date().toISOString().slice(11, 23)} ${line}`;
    if (!this.file) {
      fs.mkdirSync('logs', { recursive: true });
      this.file = fs.createWriteStream(this.path, { flags: 'a' });
    }
    this.file.write(`${text}\n`);
    this.entries.push({ id: this.nextId++, text });
    if (this.entries.length > this.keep) this.entries.shift();
    for (const listener of this.listeners) listener();
  }

  /** Calls `listener` after every new line; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.file?.end();
  }
}
