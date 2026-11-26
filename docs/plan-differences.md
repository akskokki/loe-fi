# Differences from the design plan

Where the implementation does something other than [the design plan](design-plan.tex) describes. Keep this updated as the code changes, so the final report can explain what changed and why.

Only deliberate departures are listed here.

Status: **proposed** means it's in the code but the group hasn't confirmed it yet. **Agreed** means the group has accepted it (update the plan text then too).

## Global state

### Tempo, play/stop and playhead position are one value · proposed

- **Plan:** *Settings* has Tempo and Steps, each with its own version stamp. *Playback* has Playing and Playhead ("step 8 at 2500 ms"), also each with its own stamp. That is four separately merged values.
- **Code:** *Settings* has only `steps`. `playback` is one value `{playing, bpm, step, at}` with a single stamp (`src/state/state.ts`), so play/stop, tempo and playhead position always change together.
- **Why:** the plan says a tempo change or play/stop also moves the playhead position. With separate stamps, two nodes acting at the same moment (A presses play while B changes the tempo) can merge into A's position combined with B's tempo, which makes the playhead jump.
- **Cost:** when two nodes change playback at the same moment, one change is lost completely. Either A's play or B's tempo change survives, not both.

### Every track has 32 cells · proposed

- **Plan:** one cell per step.
- **Code:** every track always has `MAX_STEPS` = 32 cells. `settings.steps` (1–32) says how many are used.
- **Why:** if the step count changes while copies are in flight, there is no rule for merging copies with different numbers of cells. Fixed-length arrays merge cell by cell.
- **Side effects:** 32 steps is the maximum. Cells beyond the step count keep their values, so going from 16 steps to 8 and back to 16 brings back steps 9–16 as they were.

### A member entry is one value, written only by the member · proposed

- **Plan:** a member has Node ID, Address, Samples held and a Heartbeat. Only the heartbeat is shown with a stamp, and the text says a node "increases the version of its own member entry".
- **Code:** the whole entry `{name, address, port}` is one value with one stamp, written only by the member itself. Its version is the heartbeat. (There is no samples list: see Preset sounds.)
- **Why:** only the member knows its own name and address, so nobody else needs to write the entry, and a single stamp is enough.

### Member entries carry a display name · proposed

- **Plan:** a member entry has Node ID, Address, Samples held and Heartbeat.
- **Code:** the entry also has `name`, chosen with `--name` (default: the OS user name). It is 1–16 printable characters (`isValidName` in `src/state/state.ts`), and a STATE with an invalid name is ignored. Names don't have to be unique. The UI, `show` and the log display names instead of node IDs.
- **Why:** node IDs are random numbers, so people can't tell who is who.
- **Note:** names come from the network and get printed to the terminal, so control characters are refused to keep escape sequences out.

### Member entries are never removed · proposed

- **Plan:** "the other nodes consider that member gone". The plan doesn't say what happens to the entry.
- **Code:** entries stay in the state forever. Each node decides locally that a member is gone when its heartbeat has not increased for 5 s (`src/net/membership.ts`). A member counts as alive only after its heartbeat has been seen increasing, so entries of peers that quit long ago, such as a restarted node's previous run, stay silent.
- **Why:** if a node deleted an entry, the next STATE from any node that still had it would bring it back. Real removal would need tombstones or every node remembering which IDs it dropped.
- **Cost:** the members list grows with every restart.

### Track names have their own stamp · proposed

- **Plan:** the figure shows the sample file name next to the hash, with no stamp.
- **Code:** `name` is a stamped value like everything else, so two nodes adding the same sample under different names converge on one name.

## Messages

### STATE and JOIN carry a `to` field, and nodes learn their own address from it · proposed

- **Plan:** the STATE header is the sender's node ID. The member entry holds the node's address, but the plan doesn't say how a node knows it.
- **Code:** STATE is `{type, from, to, state}` and JOIN is `{type, from, to}` (`src/net/messages.ts`). `to` is the address the sender sent the message to, so a node learns its address from the first JOIN or STATE it gets. The receiver writes it into its own member entry, preferring a non-loopback address once it has seen one. The address is `null` until the node has learned it.
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

## File sharing

### Built-in preset sounds next to file sharing · agreed

- **Plan:** members add their own sample files. A track is identified by the hash of its sample, each member lists the samples it holds, and a node missing a sample pulls it from another member over TCP.
- **Decision:** file sharing stays as planned, and the program also comes with a few preset sounds, so someone starting it for the first time has sounds without any files. Presets need no transfer, since every node has them.
- **Code:** a track key is either `preset:<name>` (`src/audio/presets.ts`: kick, snare, hat, clap, tom) or `sha256:<hash>` for a sample file (`src/samples/keys.ts`). Presets are synthesized on each machine, with some random noise in them, so they can't be identified by a hash; they never need transferring anyway.

The file sharing itself follows the plan: samples are stored under their SHA-256 hash (`src/samples/store.ts`), each member lists the hashes it holds in its member entry, and a node pulls a missing sample over TCP from a member that lists it, checks it against the hash, and asks another member if the transfer fails (`src/samples/transfer.ts`). The details the plan leaves open:

### Transfer details · proposed

- **TCP port:** the same number as the node's UDP port, so a member's address in the state is enough to reach both. Firewalls need 7051/tcp open as well.
- **Protocol:** one request per connection: `GET <hash>`, answered with `OK <length>` and the bytes, `NO` (doesn't have it) or `BUSY`.
- **Upload limit:** at most 2 uploads at a time, and `BUSY` beyond that, as the plan suggests. A busy holder is asked again after 1 s; one that failed otherwise (timeout, wrong bytes) only after 10 s, other holders first. A random holder is picked each time to spread the uploads.
- **Downloads:** at most 2 at a time. Samples of deleted tracks are not fetched.
- **Limits:** 5 MB per file ("a few megabytes" in the plan), any format the audio library decodes. A file is checked to decode as audio when it's added; on a machine where the audio library can't load, it is added with a warning instead.

### Track names are limited to 16 printable characters · proposed

- **Plan:** the figure shows the sample's file name.
- **Code:** a track's name comes from its file name, without folder and extension, with spaces turned into dashes (so commands can name it) and cut to 16 characters. Like member names, a track name from the network must be 1–16 printable characters, or the STATE is ignored, because names are printed to the terminal and must not carry escape sequences.

### Not done yet

- Sample files are never removed from a node's store, even when no track uses them any more.

## Playhead synchronization

The plan's approach is built: the live node with the highest ID is elected time reference with the bully algorithm (`src/sync/election.ts`), the others sync to it with NTP-style round trips (`src/sync/clock.ts`), and `PeerNode.now()` returns session time. The departures:

### Session time is a local monotonic clock plus an offset · proposed

- **Plan:** nodes "regularly ask it for the time and correct the answer for the network delay".
- **Code:** each node keeps `session time = local clock + offset`. The local clock is `performance.timeOrigin + performance.now()`, which is not affected by system clock adjustments. A request carries t0, the reply t1 and t2 (the reference's session time on arrival and departure), and the requester notes t3: `offset = ((t1 - t0) + (t2 - t3)) / 2`, `delay = (t3 - t0) - (t2 - t1)`. A node asks 4 times a second until it has 3 samples and once a second after that, and uses the offset of the sample with the smallest delay out of the last 8, since that one was least distorted by queueing.
- **Why:** the smallest-delay filter is what NTP does to cut the error from asymmetric delays.

### The reference keeps its offset, so session time doesn't jump at a handover · proposed

- **Plan:** doesn't say what session time is when the reference changes.
- **Code:** the reference doesn't sync to anyone and leaves its offset as it was. A node that becomes the reference keeps the offset it had from syncing to the previous one, so session time continues smoothly. In the harness, killing the reference moved session time by under 0.1 ms on every node.
- **Cost:** when two nodes become references without having synced to each other (at startup, or both sides of a network split), the followers of the one that loses jump by the difference between the two clocks once.

### A node only takes over as reference once its clock is synced · proposed

- **Plan:** bully algorithm: the live node with the highest ID wins.
- **Code:** a node with a higher ID than the current reference waits until it has synced to that reference before it holds the election that makes it the new one. Until then it follows the lower reference.
- **Why:** otherwise a node that has just joined, with a higher random ID, would become the reference with an unsynced clock, and every other node's playhead would jump by the difference between the clocks.

### Election messages are repeated · proposed

- **Plan:** "Election messages … bully algorithm, not designed yet".
- **Code:** ELECTION, ANSWER and COORDINATOR as in the textbook bully algorithm, over UDP. Because UDP can lose them: ELECTION is sent twice; the reference repeats COORDINATOR every 2 s, which also tells nodes that joined later; a node that got an ANSWER but no COORDINATOR within 4 s starts over. A new node waits 3 s to hear of an existing reference before it holds an election itself.
- **Known effect:** nodes that start together may elect themselves before they know of the higher nodes. The extra references disappear within a few seconds once the higher nodes are known (see the cost under the previous entry).

