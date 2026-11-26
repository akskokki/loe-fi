# Differences from the design plan

Where the implementation does something other than [the design plan](design-plan.tex) describes. Keep this updated as the code changes, so the final report can explain what changed and why.

Parts of the plan that are simply not built yet (clock sync, election, file sharing, audio) are not listed here. Only deliberate departures are.

Status: **proposed** means it's in the code but the group hasn't confirmed it yet. **Agreed** means the group has accepted it (update the plan text then too).

## Global state

### Tempo, play/stop and playhead position are one value · proposed

- **Plan:** *Settings* has Tempo and Steps, each with its own version stamp. *Playback* has Playing and Playhead ("step 8 at 2500 ms"), also each with its own stamp. That is four separately merged values.
- **Code:** *Settings* has only `steps`. `playback` is one value `{playing, bpm, step, at}` with a single stamp (`src/state.ts`), so play/stop, tempo and playhead position always change together.
- **Why:** the plan says a tempo change or play/stop also moves the playhead position. With separate stamps, two nodes acting at the same moment (A presses play while B changes the tempo) can merge into A's position combined with B's tempo, which makes the playhead jump.
- **Cost:** when two nodes change playback at the same moment, one change is lost completely. Either A's play or B's tempo change survives, not both.

### Every track has 32 cells · proposed

- **Plan:** one cell per step.
- **Code:** every track always has `MAX_STEPS` = 32 cells. `settings.steps` (1–32) says how many are used.
- **Why:** if the step count changes while copies are in flight, there is no rule for merging copies with different numbers of cells. Fixed-length arrays merge cell by cell.
- **Side effects:** 32 steps is the maximum. Cells beyond the step count keep their values, so going from 16 steps to 8 and back to 16 brings back steps 9–16 as they were.

### A member entry is one value, written only by the member · proposed

- **Plan:** a member has Node ID, Address, Samples held and a Heartbeat. Only the heartbeat is shown with a stamp, and the text says a node "increases the version of its own member entry".
- **Code:** the whole entry `{address, port, samples}` is one value with one stamp, written only by the member itself. Its version is the heartbeat.
- **Why:** only the member knows its own samples and address, so nobody else needs to write the entry, and a single stamp is enough.

### Member entries carry a display name · proposed

- **Plan:** a member entry has Node ID, Address, Samples held and Heartbeat.
- **Code:** the entry also has `name`, chosen with `--name` (default: the OS user name). It is 1–16 printable characters (`isValidName` in `src/state.ts`), and a STATE with an invalid name is ignored. Names don't have to be unique. The UI, `show` and the log display names instead of node IDs.
- **Why:** node IDs are random numbers, so people can't tell who is who.
- **Note:** names come from the network and get printed to the terminal, so control characters are refused to keep escape sequences out.

### Member entries are never removed · proposed

- **Plan:** "the other nodes consider that member gone". The plan doesn't say what happens to the entry.
- **Code:** entries stay in the state forever. Each node decides locally that a member is gone when its heartbeat has not increased for 5 s (`src/node.ts`). A member counts as alive only after its heartbeat has been seen increasing, so entries of peers that quit long ago, such as a restarted node's previous run, stay silent.
- **Why:** if a node deleted an entry, the next STATE from any node that still had it would bring it back. Real removal would need tombstones or every node remembering which IDs it dropped.
- **Cost:** the members list grows with every restart.

### Track names have their own stamp · proposed

- **Plan:** the figure shows the sample file name next to the hash, with no stamp.
- **Code:** `name` is a stamped value like everything else, so two nodes adding the same sample under different names converge on one name.

## Messages

### STATE carries a `to` field, and nodes learn their own address from it · proposed

- **Plan:** the STATE header is the sender's node ID. The member entry holds the node's address, but the plan doesn't say how a node knows it.
- **Code:** STATE is `{type, from, to, state}` (`src/messages.ts`). `to` is the address the sender sent the message to. The receiver writes it into its own member entry, preferring a non-loopback address once it has seen one. The address is `null` until the node has learned it.
- **Why:** a node often can't tell which of its addresses others can reach it at, because of several network interfaces, VMs or Docker.
- **Also:** for nodes that have sent us packets, we send to the address their packets come from, not the address in their member entry.

## Joining and leaving

### `--join <address>` instead of bootstrap nodes and the DHT · proposed (temporary)

- **Plan:** a new node contacts a bootstrap node, finds the session's peers in a DHT through a magnet link, and sends JOIN to one of them.
- **Code:** the user gives the address of any member with `--join host:port`. The JOIN and STATE exchange after that works as in the plan. There are no session IDs.
- **Why:** the group decided to start with a simple connection over the local network.

### No leave message · proposed

- **Plan:** a leaving node removes its address from the session's DHT entry.
- **Code:** there is no DHT and no leave message. A node that quits is noticed through the heartbeat timeout, as with a crash.

## Fault tolerance

### Gone members are still contacted every 5 seconds · proposed

- **Plan:** doesn't say whether nodes keep sending to members they consider gone.
- **Code:** STATE goes to live members every second, and also to gone members every 5th second.
- **Why:** without this, two sides of a network split that have written each other off never contact each other again, and the session stays split after the network heals.

## Playhead

### Session time is the system clock for now · temporary

- **Plan:** playhead times are in session time, a shared clock synced to the time reference NTP-style.
- **Code:** `PeerNode.now()` returns `Date.now()`. Playheads line up only as well as the computers' clocks already agree. This goes away when clock sync is built; `now()` is the only place that needs to change.
