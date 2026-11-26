# Lö-Fi

Real-time multiplayer drum sequencer. Design: [docs/design-plan.tex](docs/design-plan.tex).

## Code

| File | What |
|---|---|
| `src/state.ts` | The global state (every value has a version stamp), `merge()`, and the functions that change the state |
| `src/messages.ts` | The JOIN and STATE messages |
| `src/peer.ts` | Headless peer: keeps its state in sync with the other members over UDP and takes typed commands |
| `src/describe.ts` | Log lines for what changed, and the grid as text |
| `src/state.test.ts` | Tests for the merge rule (`npm test`) |

`npm test` runs the tests, `npm run check` type-checks.

## Headless peer

There is no UI or audio yet. Every peer holds a copy of the session state and sends it to all live members after each change and once a second. Every peer merges what it receives using the version stamps. A peer that joins one member learns the others from the members in the state and connects to them too. A member whose heartbeat has not increased for 5 seconds is shown as gone.

### On every machine

1. Install Node 22 or newer (`node --version`). On macOS: `brew install node`, or the installer from nodejs.org.
2. Clone the repo and install:
   ```bash
   git clone git@github.com:akskokki/loe-fi.git && cd loe-fi
   npm install
   ```
3. Let UDP port 7051 through the firewall:
   ```bash
   sudo ufw allow 7051/udp                                   # Ubuntu/Debian with ufw
   sudo firewall-cmd --add-port=7051/udp                     # Fedora/RHEL (until reboot)
   ```
   On macOS, allow `node` to accept incoming connections if the firewall asks. On macOS 15 and later, also allow your terminal app to access the local network when asked. If you missed the prompt, enable it in System Settings → Privacy & Security → Local Network.

### Running

On the first machine:

```bash
npm run peer
```

It prints the addresses it can be reached at, e.g. `--join 192.168.1.10:7051`. Pick the one on the shared network. Skip `127.0.0.1`, and skip `172.17.x.x` (Docker) or other virtual interfaces.

On each other machine:

```bash
npm run peer -- --join 192.168.1.10:7051
```

To try it on one machine, use a different port for each peer, e.g. `npm run peer -- --port 7052 --join 127.0.0.1:7051`. Add `--verbose` to log every message sent and received.

### Commands

Type these into a running peer:

| Command | What it does |
|---|---|
| `add kick` | Add a track called kick |
| `t kick 1` | Toggle step 1 of kick (steps are counted from 1) |
| `mute kick`, `unmute kick`, `del kick` | Change a track's status |
| `play`, `stop`, `bpm 90`, `steps 8` | Playback and settings |
| `show` | Print the grid, the playhead and the members |
| `offline 10` | Drop all packets for 10 seconds, to test failures |
| `help`, `quit` | |

### What to try between machines

1. **Changes spread.** Run `add kick` and `t kick 1` on one machine. The others should log `<- track kick added` and `<- kick step 1 on (by …)` almost immediately. Run `show` everywhere and compare.
2. **A third member.** Join a third machine to any of the first two. It should get the whole grid at once and list every member in `show`.
3. **Concurrent edits.** Toggle the same step on two machines at the same moment, or as close as you can. After a second, `show` must print the same grid everywhere.
4. **Failure.** Quit one peer (`quit` or Ctrl+C). The others print `- member … timed out` after about 5 seconds, and the rest keep syncing.
5. **Network split.** Run `offline 10` on one peer, which drops all its packets for 10 seconds, and make changes on both sides while it is offline. Both sides time each other out. Within about 5 seconds of it coming back, the members are logged as `back` and every peer has both sides' changes. Turning Wi-Fi off works too.
6. **Playhead.** After `play`, `show` on different machines should print about the same step. This works only because the computers' clocks are already synced by the OS. The session-time clock sync from the design plan comes later.

Known limits:

- The message grows by about 1.5 KB per track. macOS refuses to send UDP datagrams over 9 KB by default, so with more than about 5 tracks a Mac peer logs `send … failed`. A more compact message format will fix this.
- Two peers on the same machine plus one on another machine don't mix well, because the local ones know each other as `127.0.0.1`.

### If nothing connects

The joining peer keeps printing `-> JOIN to …` and never logs `+ member`.

- **Check that packets arrive at all.** With the first peer running, send it junk from the other machine: `echo hi | nc -u -w1 192.168.1.10 7051`. If the peer logs `ignored a non-JSON packet`, the network path works and the problem is the reply direction, i.e. the joining machine's firewall. If it logs nothing, the packet is blocked on the way in.
- **Firewall.** Step 3 above, on *both* machines. Replies go to the joiner's port, so that port needs to be open as well.
- **Network.** Eduroam and many guest Wi-Fi networks block traffic between clients. Use a phone hotspot, a home router or wired university machines instead.
- **VMs.** A VM on NAT networking (the VirtualBox/UTM default) can reach out but cannot be reached. Switch it to bridged networking, or forward UDP 7051 to it.
