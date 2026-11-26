# Lö-Fi

Real-time multiplayer drum sequencer. Design: [docs/design-plan.tex](docs/design-plan.tex). Where the code departs from it: [docs/plan-differences.md](docs/plan-differences.md).

## Code

| File | What |
|---|---|
| `src/state.ts` | The global state (every value has a version stamp), `merge()`, and the functions that change the state |
| `src/messages.ts` | The JOIN and STATE messages |
| `src/node.ts` | A peer node: keeps its copy of the state in sync with the other members over UDP |
| `src/ui.tsx` | Terminal UI with a live grid (`npm run ui`) |
| `src/peer.ts` | Headless peer that takes typed commands (`npm run peer`), for VMs and scripted tests |
| `src/describe.ts` | Log lines for what changed, and the grid as text |
| `src/state.test.ts` | Tests for the merge rule (`npm test`) |
| `src/election.ts` | Bully election of the time reference |
| `src/clock.ts` | Session time, synced to the time reference NTP-style |
| `src/presets.ts` | The preset sounds (synthesized): kick, snare, hat, clap, tom |
| `src/tracks.ts` | Track keys: `preset:<name>` or `sha256:<hash of a sample file>` |
| `src/store.ts`, `src/transfer.ts`, `src/addfile.ts` | Sample files: stored by hash, pulled from other members over TCP, added from disk |
| `src/schedule.ts`, `src/audio.ts` | Which steps sound when, and the audio engine that plays them in session time |
| `src/harness.ts` | Convergence test over the network code (`npm run harness`) |

`npm test` runs the tests, `npm run check` type-checks.

## Convergence test harness

```bash
npm run harness                                              # 5 peers, 10 s of edits, 30% packet loss
npm run harness -- --peers 8 --seconds 20 --drop 0.5 --outage 6
```

Starts several peers on this machine, each joining a random earlier peer and with its clock shifted by up to `--skew` ms (500 by default), and lets every peer make random edits (mostly toggling the same few cells, so edits conflict) while each throws away the given share of the packets it receives. With `--outage`, one peer goes offline for that many seconds in the middle. When the edits stop, the harness waits until every peer has the same state fingerprint, sees all the others alive, follows the highest node as time reference and has a session clock within 10 ms of the others; then it prints a table and exits with 0. With `--kill-reference` it then stops the time reference and checks that the others elect a new one and that session time doesn't jump. With `--samples N` (3 by default), random peers add generated WAV files during the run, and converging also requires every peer to have fetched every file. If that doesn't happen within 30 s, it prints FAILED and exits with 1. Every peer's log goes to `logs/harness-<time>.log`. `--seed` repeats the same edits; packet loss stays random.

The headless peer and the UI also take `--drop 0.3`, and `show` prints the state fingerprint, so you can compare peers on different machines.

## Terminal UI

```bash
npm run ui                                   # start a session
npm run ui -- --join 192.168.1.10:7051       # join any member of a session
npm run ui -- --name alice --join 192.168.1.10:7051   # pick the name the others see
```

Members are shown by name. The name defaults to your OS user name and can be up to 16 characters. Both `npm run ui` and `npm run peer` take `--name`. If two members use the same name, the UI adds their node ID to tell them apart.

The UI and the headless peer can be in the same session. Setup on each machine is the same as below. The UI needs a terminal with mouse reporting (most Linux and macOS terminals) and at least about 75 columns for 16 steps, or 120 for 32. The log goes to `logs/<node id>.log`, and its last lines are shown at the bottom of the screen.

| Mouse | Keyboard | Action |
|---|---|---|
| Click a cell | Arrows, then Space or Enter | Toggle a step |
| Click a track name | Up and Down | Select a track |
| Play / Stop | `p` | Start or stop playback |
| BPM `-` `+` | `-` `+` | Tempo down or up by 5 |
| Steps `-` `+` | `[` `]` | Fewer or more steps |
| Add track | `a`, then a number | Add a track with one of the preset sounds |
| | `<` `>` | Volume down or up |
| Mute | `m` | Mute or unmute the selected track |
| Delete | `d` | Delete the selected track (adding the same name brings it back) |
| Quit | `q` or Esc | Quit |

The UI plays the grid. Playback follows session time: the peers elect the one with the highest node ID as time reference (bully algorithm) and the others sync their clocks to it, so every machine plays the same step at the same moment. Each machine's audio output latency is measured and corrected for. The Members panel shows the reference, this peer's clock offset and the audio status; `show` in the headless peer prints the clock part.

Sounds are either presets that come with the program (synthesized, so every peer has them) or your own sample files: Add track (`a`), then `f`, then the file's path. Any audio file up to 5 MB works (WAV, MP3, OGG, FLAC). It is stored under its SHA-256 hash in `samples/`, and the other peers fetch it from a member that has it over TCP and check it against the hash. A track whose file hasn't arrived yet shows `↓` after its name and stays silent until it has. Start with `--no-audio` to run silently. To run several peers on one machine, give each its own folder with `--samples <folder>`, or they share one and never need to fetch anything.

**Linux:** `node-web-audio-api` uses JACK. On a distro running PipeWire, install its JACK layer (`sudo apt install pipewire-jack`; Fedora usually has it). If audio still fails with `libjack.so.0: cannot open shared object file`, start through the wrapper: `pw-jack npm run ui`. The UI says `Audio: off (…)` and keeps working without sound if audio can't start. **macOS** needs no setup.

## Headless peer

Silent unless started with `--audio`, so it runs on VMs without a sound setup. Every peer holds a copy of the session state and sends it to all live members after each change and once a second. Every peer merges what it receives using the version stamps. A peer that joins one member learns the others from the members in the state and connects to them too. A member whose heartbeat has not increased for 5 seconds is shown as gone.

### On every machine

1. Install Node 22 or newer (`node --version`). On macOS: `brew install node`, or the installer from nodejs.org.
2. Clone the repo and install:
   ```bash
   git clone git@github.com:akskokki/loe-fi.git && cd loe-fi
   npm install
   ```
3. Let port 7051 through the firewall, both UDP (sequencer messages) and TCP (sample files):
   ```bash
   sudo ufw allow 7051/udp && sudo ufw allow 7051/tcp        # Ubuntu/Debian with ufw
   sudo firewall-cmd --add-port=7051/udp --add-port=7051/tcp # Fedora/RHEL (until reboot)
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
| `add kick` | Add a track with a preset sound: kick, snare, hat, clap or tom |
| `add ~/sounds/my cowbell.wav` | Add a track with a sample file; it is named after the file (`my-cowbell`) and the others fetch it |
| `t kick 1` | Toggle step 1 of kick (steps are counted from 1). If two tracks have the same name, use the start of the key instead, e.g. `t sha256:3f2a 1` |
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
6. **Playhead.** After `play`, `show` on different machines should print the same step, and `show` names the same time reference everywhere. Quit the reference: after about 5 seconds the others elect a new one and keep playing in step.
7. **Sample files.** Run `add <some audio file>` on one machine. The others log `<- fetching sample …` and `<- got sample …`, and `show` counts it under `sample files held`. Port 7051/tcp has to be open for this (step 3 above).

Known limits:

- The message grows by about 1.5 KB per track. macOS refuses to send UDP datagrams over 9 KB by default, so with more than about 5 tracks a Mac peer logs `send … failed`. A more compact message format will fix this.
- Two peers on the same machine plus one on another machine don't mix well, because the local ones know each other as `127.0.0.1`.

### If nothing connects

The joining peer keeps printing `-> JOIN to …` and never logs `+ member`.

- **Check that packets arrive at all.** With the first peer running, send it junk from the other machine: `echo hi | nc -u -w1 192.168.1.10 7051`. If the peer logs `ignored a non-JSON packet`, the network path works and the problem is the reply direction, i.e. the joining machine's firewall. If it logs nothing, the packet is blocked on the way in.
- **Firewall.** Step 3 above, on *both* machines. Replies go to the joiner's port, so that port needs to be open as well.
- **Network.** Eduroam and many guest Wi-Fi networks block traffic between clients. Use a phone hotspot, a home router or wired university machines instead.
- **VMs.** A VM on NAT networking (the VirtualBox/UTM default) can reach out but cannot be reached. Switch it to bridged networking, or forward UDP 7051 to it.
