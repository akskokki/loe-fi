// The UI's log: every line goes to a file, and the last few are kept for the screen.
import fs from 'node:fs';

export class LogBuffer {
  /** The last lines, newest last. */
  readonly lines: string[] = [];
  private listeners = new Set<() => void>();
  private file: fs.WriteStream | undefined;

  /** `path` is only opened when the first line is written. */
  constructor(
    readonly path: string,
    private readonly keep: number,
  ) {}

  log(line: string) {
    const stamped = `${new Date().toISOString().slice(11, 23)} ${line}`;
    if (!this.file) {
      fs.mkdirSync('logs', { recursive: true });
      this.file = fs.createWriteStream(this.path, { flags: 'a' });
    }
    this.file.write(`${stamped}\n`);
    this.lines.push(stamped);
    if (this.lines.length > this.keep) this.lines.shift();
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
