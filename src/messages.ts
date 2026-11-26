// Messages between peer nodes. Each message is one JSON-encoded UDP datagram.
// Only JOIN and STATE exist so far; time sync, election and file request messages come later.
import type { NodeId, State } from './state.js';

export type Address = { address: string; port: number };

export type Msg =
  /** Sent by a node that wants to join a session, to one member. Answered with a STATE. */
  | { type: 'JOIN'; from: NodeId }
  /**
   * The sender's whole state. Sent to every member after each local change and at a fixed
   * interval, and in reply to a JOIN.
   *
   * `to` is the address the sender sent this message to. A node cannot reliably know its own
   * address (several interfaces, VMs, NAT), so it learns it from here and writes it into its own
   * member entry. A node reached as 127.0.0.1 by a peer on the same machine should keep a
   * non-loopback address once it has seen one, or remote peers would be told to use 127.0.0.1.
   */
  | { type: 'STATE'; from: NodeId; to: Address; state: State };
