// Messages between peer nodes. Each message is one JSON-encoded UDP datagram.
// File request messages come later.
import type { NodeId, State } from './state.js';

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
  /** Bully election of the time reference (see election.ts). */
  | { type: 'ELECTION' | 'ANSWER' | 'COORDINATOR'; from: NodeId }
  /** Clock sync request to the time reference. `t0` is the sender's local time when it was sent. */
  | { type: 'TIME_REQUEST'; from: NodeId; t0: number }
  /** Reply from the reference: `t1` and `t2` are its session time when the request arrived and when this left. */
  | { type: 'TIME_REPLY'; from: NodeId; t0: number; t1: number; t2: number };
