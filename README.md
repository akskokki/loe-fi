# Lö-Fi

Real-time multiplayer drum sequencer. Design: [docs/design-plan.tex](docs/design-plan.tex).

## Connection test (`src/peer.ts`)

A minimal peer with no UI or audio. Peers find each other over UDP and log every message they send and receive.

- `JOIN` asks to join a session. The receiver answers with a `STATE`.
- `STATE` goes to every known peer once a second. It carries a heartbeat counter and the list of members the sender knows. A peer that joins one member therefore learns about the others and connects to them too (full mesh).
- A peer that has not been heard from for 5 seconds is dropped.

### On every machine

1. Install Node 22 or newer (`node --version`).
2. Clone the repo and install:
   ```bash
   git clone <repo-url> && cd loe-fi
   npm install
   ```
3. Let UDP port 7051 through the firewall:
   ```bash
   sudo ufw allow 7051/udp                                   # Ubuntu/Debian with ufw
   sudo firewall-cmd --add-port=7051/udp                     # Fedora/RHEL (until reboot)
   ```
   macOS asks to allow incoming connections the first time Node listens. Click Allow.

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

It works when both sides print `+ peer … connected` followed by a `<- STATE` line every second. A third machine can join any of the peers. Within a second or two, all of them should list each other in `members=[…]`. Stop one with Ctrl+C, and the others print `timed out` after about 5 seconds.

To try it on one machine, use a different port for each peer:

```bash
npm run peer                                          # terminal 1
npm run peer -- --port 7052 --join 127.0.0.1:7051     # terminal 2
```

### If nothing connects

The joining peer keeps printing `-> JOIN to …` and never sees a reply.

- **Check that packets arrive at all.** With the first peer running, send it junk from the other machine: `echo hi | nc -u -w1 192.168.1.10 7051`. If the peer logs `ignored a non-JSON packet`, the network path works and the problem is the reply direction, i.e. the joining machine's firewall. If it logs nothing, the packet is blocked on the way in.
- **Firewall.** Step 3 above, on *both* machines. Replies go to the joiner's port, so that port needs to be open as well.
- **Network.** Eduroam and many guest Wi-Fi networks block traffic between clients. Use a phone hotspot, a home router or wired university machines instead.
- **VMs.** A VM on NAT networking (the VirtualBox/UTM default) can reach out but cannot be reached. Switch it to bridged networking, or forward UDP 7051 to it.
