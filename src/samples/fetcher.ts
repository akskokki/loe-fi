// Pulls missing sample files, as in the design plan: a node that lacks the sample of a track asks a
// live member that lists it in its member entry, and asks another one if that fails.
import type { Address } from '../net/messages.js';
import { memberName, type NodeId, type State } from '../state/state.js';
import { soundOf } from './keys.js';
import type { SampleStore } from './store.js';
import { fetchSample } from './transfer.js';

const MAX_DOWNLOADS = 2; // samples fetched at the same time
const RETRY_HOLDER_MS = 10_000; // after a failed fetch, ask other holders before this one again
const RETRY_BUSY_MS = 1000; // ... but a holder that was only busy uploading can be asked again soon

export type FetcherDeps = {
  /** IDs of the other members that are currently alive. */
  liveMembers(): NodeId[];
  addressOf(id: NodeId): Address | null;
  log(line: string): void;
  /** Called when a sample has arrived and been stored. */
  onFetched(): void;
};

export class SampleFetcher {
  /** Samples being fetched, and per sample the holders that failed and when they may be asked again. */
  private downloading = new Set<string>();
  private failedHolders = new Map<string, Map<NodeId, number>>();

  constructor(private readonly store: SampleStore, private readonly d: FetcherDeps) {}

  /** Starts fetching the samples of tracks that aren't deleted and that aren't stored here yet. */
  fetchMissing(state: State, now = Date.now()) {
    for (const [key, track] of Object.entries(state.tracks)) {
      const sound = soundOf(key);
      if (track.status.value === 'deleted' || sound?.kind !== 'sample') continue;
      const { hash } = sound;
      if (this.store.has(hash) || this.downloading.has(hash) || this.downloading.size >= MAX_DOWNLOADS) continue;
      const failed = this.failedHolders.get(hash) ?? new Map<NodeId, number>();
      const holders = this.d.liveMembers().filter((id) =>
        Object.hasOwn(state.members, id) && state.members[id].value.samples.includes(hash)
        && now >= (failed.get(id) ?? 0));
      if (holders.length === 0) continue; // nobody has it, or all holders failed recently: try again later
      const holder = holders[Math.floor(Math.random() * holders.length)]; // spreads the uploads
      const addr = this.d.addressOf(holder);
      if (!addr) continue;
      const what = `sample ${track.name.value} (${hash.slice(0, 12)}…)`;
      const who = memberName(state, holder);
      this.downloading.add(hash);
      this.d.log(`<- fetching ${what} from ${who}`);
      fetchSample(addr.address, addr.port, hash)
        .then((bytes) => {
          this.store.put(bytes, hash); // throws if the bytes don't match the hash
          this.d.log(`<- got ${what} from ${who}, ${bytes.length} bytes`);
          this.d.onFetched();
        })
        .catch((err: Error) => {
          failed.set(holder, Date.now() + (err.message === 'busy' ? RETRY_BUSY_MS : RETRY_HOLDER_MS));
          this.failedHolders.set(hash, failed);
          this.d.log(`fetching ${what} from ${who} failed: ${err.message}; will ask another member`);
        })
        .finally(() => this.downloading.delete(hash));
    }
  }
}
