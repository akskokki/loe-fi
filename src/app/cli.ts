// What the two programs (the UI and the headless peer) share: their command-line options, setting
// up and starting the node, and starting audio.
import os from 'node:os';
import { AudioEngine } from '../audio/engine.js';
import type { Address } from '../net/messages.js';
import { PeerNode } from '../net/node.js';
import { MAX_NAME_LENGTH, isValidName } from '../state/validate.js';

/** Options both programs take; spread into parseArgs({ options }) next to a program's own. */
export const COMMON_OPTIONS = {
  port: { type: 'string', default: '7051' },
  join: { type: 'string' }, // address of any member, e.g. 192.168.1.10:7051
  name: { type: 'string' }, // shown to the others; default: the OS user name
  verbose: { type: 'boolean', default: false }, // log every message sent and received
  drop: { type: 'string', default: '0' }, // share of received packets to throw away, e.g. 0.3
  samples: { type: 'string', default: 'samples' }, // folder for sample files; give each peer on one machine its own
} as const;

export type CommonArgs = {
  port: string;
  join?: string;
  name?: string;
  verbose: boolean;
  drop: string;
  samples: string;
};

/** Parses "host:port" (port defaults to 7051). */
export function parseAddress(s: string): Address {
  const [address, port] = s.split(':');
  return { address, port: Number(port ?? 7051) };
}

/**
 * The --name argument, or the OS user name when it is missing. Returns an error message instead if
 * the given name is not allowed.
 */
export function chooseName(arg: string | undefined): { name: string } | { error: string } {
  if (arg !== undefined) {
    const name = arg.trim();
    return isValidName(name) ? { name } : { error: `--name must be 1 to ${MAX_NAME_LENGTH} printable characters` };
  }
  let user = '';
  try {
    user = os.userInfo().username.trim().slice(0, MAX_NAME_LENGTH).trim();
  } catch {} // no user name on some systems; fall back below
  return { name: isValidName(user) ? user : 'peer' };
}

/** This machine's IPv4 addresses, for telling others what to join. */
export function localAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((addrs) =>
    (addrs ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address),
  );
}

/** A node set up from the common options. Exits with a message if --name isn't allowed. */
export function nodeFromArgs(args: CommonArgs, log: (line: string) => void): PeerNode {
  const chosen = chooseName(args.name);
  if ('error' in chosen) {
    console.error(chosen.error);
    process.exit(1);
  }
  return new PeerNode({
    name: chosen.name,
    port: Number(args.port),
    join: args.join ? parseAddress(args.join) : undefined,
    verbose: args.verbose,
    drop: Number(args.drop),
    sampleDir: args.samples,
    log,
  });
}

/** Starts the node, or exits with a message if its port is taken or the join host is unknown. */
export async function startOrExit(node: PeerNode) {
  try {
    await node.start();
  } catch (err) {
    console.error(`could not start on port ${node.opts.port}: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * Opens the audio output and starts playing the node's grid in session time. Audio is optional:
 * returns the reason instead if this machine can't play sound (the grid still syncs, silently).
 */
export async function startAudio(
  node: PeerNode,
  log: (line: string) => void,
): Promise<{ audio: AudioEngine } | { off: string }> {
  try {
    const audio = await AudioEngine.open();
    audio.start(
      () => node.state,
      () => node.now(),
      (h) => (node.store.has(h) ? node.store.read(h) : null),
      log,
    );
    log(`audio on, output latency ${audio.latencyMs.toFixed(0)} ms`);
    return { audio };
  } catch (err) {
    const off = (err as Error).message;
    log(`audio off: ${off}`);
    return { off };
  }
}
