// Session time: a clock shared by the whole session, kept close to the time reference's clock with
// the NTP technique (round trip with four timestamps). The reference is chosen by election.ts.
//
// session time = local clock + offset. The reference doesn't sync to anyone; its offset stays where
// it was, so its session time simply continues. A node that becomes the reference keeps its offset
// too, and since it was synced to the previous reference, session time doesn't jump at a handover.

const KEEP_SAMPLES = 8;
/** Samples needed before this node counts as synced (and may take over as the reference). */
const SYNCED_AFTER = 3;

export type SyncSample = { offset: number; delay: number };

export class Clock {
  /** session time - local time, in ms. */
  offset = 0;
  /** Round-trip delay of the sample the offset currently comes from. */
  delay: number | null = null;
  private samples: SyncSample[] = [];

  /** `skewMs` shifts the local clock, so tests can give nodes on one machine different clocks. */
  constructor(private readonly skewMs = 0) {}

  /** This machine's clock in ms: monotonic, sub-millisecond, unaffected by system clock changes. */
  local(): number {
    return performance.timeOrigin + performance.now() + this.skewMs;
  }

  /** Session time in ms. */
  now(): number {
    return this.local() + this.offset;
  }

  get synced(): boolean {
    return this.samples.length >= SYNCED_AFTER;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * One round trip to the reference: t0 = local time when the request left, t1 and t2 = the
   * reference's session time when the request arrived and when the reply left, t3 = local time
   * when the reply arrived. Uses the sample with the smallest delay out of the last few, because
   * its offset is the least distorted by queueing on the way.
   */
  addSample(t0: number, t1: number, t2: number, t3: number): SyncSample {
    const sample = {
      delay: t3 - t0 - (t2 - t1), // time spent on the network, both ways
      offset: (t1 - t0 + (t2 - t3)) / 2, // assumes both directions take equally long
    };
    this.samples.push(sample);
    if (this.samples.length > KEEP_SAMPLES) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.delay < a.delay ? b : a));
    this.offset = best.offset;
    this.delay = best.delay;
    return sample;
  }

  /** Forget the samples (the reference changed) but keep the offset, so session time continues smoothly. */
  resetSamples() {
    this.samples = [];
  }
}
