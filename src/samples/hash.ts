// SHA-256 hashes, which identify sample files. No imports from the rest of the program, so the
// state checks (state/validate.ts) and the sample code can both use them without an import cycle.
import { createHash } from 'node:crypto';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A SHA-256 hash as 64 lowercase hex characters. Anything else from the network is refused. */
export const isHash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
