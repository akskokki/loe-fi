// Minimal connection test: two or more peers find each other over UDP and exchange messages.
//
//   npm run peer                              start a session on port 7051
//   npm run peer -- --join 192.168.1.10:7051  join a peer at that address
//   npm run peer -- --port 7052 --join 127.0.0.1:7051   second peer on the same machine
//
// Messages are JSON in single UDP datagrams:
//   JOIN  - "I want in"; answered with a STATE.
//   STATE - sent to every known peer once a second. Carries a heartbeat counter and the members
//           the sender knows, so a third peer that joins one member learns about the others.
import dgram from 'node:dgram';
import os from 'node:os';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '7051' },
    join: { type: 'string' },
  },
});

const PORT = Number(args.port);
const SEND_INTERVAL_MS = 1000;
const PEER_TIMEOUT_MS = 5000;
const ID = Math.floor(Math.random() * 2 ** 32); // random node ID, chosen at startup

type Member = { id: number; address: string; port: number };
type Msg =
  | { type: 'JOIN'; from: number }
  | { type: 'STATE'; from: number; beat: number; members: Member[] };

// Known peers by node ID. The address is the one their packets arrive from, not self-reported.
const peers = new Map<number, Member & { lastSeen: number }>();
let beat = 0;

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 23)} [${ID}] ${s}`);

const sock = dgram.createSocket('udp4');

function send(msg: Msg, address: string, port: number) {
  sock.send(JSON.stringify(msg), port, address);
}

function stateMsg(): Msg {
  const members = [...peers.values()].map(({ id, address, port }) => ({ id, address, port }));
  return { type: 'STATE', from: ID, beat, members };
}

sock.on('message', (buf, rinfo) => {
  let msg: Msg;
  try {
    msg = JSON.parse(buf.toString());
  } catch {
    log(`ignored a non-JSON packet from ${rinfo.address}:${rinfo.port}`);
    return;
  }
  if (msg.from === ID) return;

  const from = `${msg.from} (${rinfo.address}:${rinfo.port})`;
  if (!peers.has(msg.from)) log(`+ peer ${from} connected`);
  peers.set(msg.from, { id: msg.from, address: rinfo.address, port: rinfo.port, lastSeen: Date.now() });

  if (msg.type === 'JOIN') {
    log(`<- JOIN from ${from}`);
    send(stateMsg(), rinfo.address, rinfo.port);
  } else if (msg.type === 'STATE') {
    log(`<- STATE from ${from} beat=${msg.beat} members=[${msg.members.map((m) => m.id).join(', ')}]`);
    // Introduce ourselves to members we have not heard from yet.
    for (const m of msg.members) {
      if (m.id !== ID && !peers.has(m.id)) {
        log(`-> JOIN to ${m.id} (${m.address}:${m.port}), learned from ${msg.from}`);
        send({ type: 'JOIN', from: ID }, m.address, m.port);
      }
    }
  }
});

sock.on('error', (err) => {
  log(`socket error: ${err.message}`);
  process.exit(1);
});

sock.bind(PORT, '0.0.0.0', () => {
  log(`listening on UDP port ${PORT}. Others can join with one of:`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4') console.log(`    --join ${a.address}:${PORT}`);
    }
  }

  // Keep sending JOIN until someone answers, in case the other peer starts later or a packet is lost.
  if (args.join) {
    const [address, port] = args.join.split(':');
    const sendJoin = () => {
      if (peers.size > 0) return clearInterval(joinTimer);
      log(`-> JOIN to ${address}:${port}`);
      send({ type: 'JOIN', from: ID }, address, Number(port ?? 7051));
    };
    const joinTimer = setInterval(sendJoin, SEND_INTERVAL_MS);
    sendJoin();
  }

  // Heartbeat: send STATE to every peer, and drop peers we have not heard from in a while.
  setInterval(() => {
    beat++;
    const now = Date.now();
    for (const p of peers.values()) {
      if (now - p.lastSeen > PEER_TIMEOUT_MS) {
        peers.delete(p.id);
        log(`- peer ${p.id} (${p.address}:${p.port}) timed out`);
      } else {
        send(stateMsg(), p.address, p.port);
      }
    }
  }, SEND_INTERVAL_MS);
});
