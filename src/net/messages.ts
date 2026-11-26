// Messages between peer nodes over UDP. Each message is one JSON-encoded datagram. (Sample files
// travel over TCP instead, with their own small protocol: samples/transfer.ts.)
import type { NodeId, State } from '../state/state.js';
import { isObject, isState } from '../state/validate.js';

export type Address = { address: string; port: number };

export type Msg =
  /**
   * Sent by a node that wants to join a session, to one member. Answered with a STATE. `to` works
   * as in STATE, so the member learns its own address from the first JOIN it gets.
   */
  | { type: 'JOIN'; from: NodeId; to: Address }
  /**
   * The sender's whole state. Sent to every member after each local change and at a fixed
   * interval, and in reply to a JOIN.
   *
   * `to` is the address the sender sent this message to. A node cannot reliably know its own
   * address (several interfaces, VMs, NAT), so it learns it from here and writes it into its own
   * member entry. A node reached as 127.0.0.1 by a peer on the same machine should keep a
   * non-loopback address once it has seen one, or remote peers would be told to use 127.0.0.1.
   */
  | { type: 'STATE'; from: NodeId; to: Address; state: State }
  /** Bully election of the time reference (see sync/election.ts). */
  | { type: 'ELECTION' | 'ANSWER' | 'COORDINATOR'; from: NodeId }
  /** Clock sync request to the time reference. `t0` is the sender's local time when it was sent. */
  | { type: 'TIME_REQUEST'; from: NodeId; t0: number }
  /** Reply from the reference: `t1` and `t2` are its session time when the request arrived and when this left. */
  | { type: 'TIME_REPLY'; from: NodeId; t0: number; t1: number; t2: number };

/**
 * Checks the shape of a parsed message, so a packet from an older version of this program (or
 * anything else) is reported instead of crashing the receiver or spreading through merge().
 */
export function wellFormed(m: unknown): m is Msg {
  if (!isObject(m) || typeof m.from !== 'number') return false;
  const isTime = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const hasTo = isObject(m.to) && typeof m.to.address === 'string' && Number.isInteger(m.to.port);
  switch (m.type) {
    case 'JOIN':
      return hasTo;
    case 'STATE':
      return hasTo && isState(m.state);
    case 'ELECTION':
    case 'ANSWER':
    case 'COORDINATOR':
      return true;
    case 'TIME_REQUEST':
      return isTime(m.t0);
    case 'TIME_REPLY':
      return isTime(m.t0) && isTime(m.t1) && isTime(m.t2);
    default:
      return false;
  }
}
