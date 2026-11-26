// Audio playback: plays the shared grid in step with session time, so every node in the session
// sounds the same step at the same moment.
//
// Same lookahead scheduling as the tui-sequencer prototype: every TICK_MS, every step whose sound
// should be heard within the next LOOKAHEAD_MS is scheduled with AudioBufferSourceNode.start(time),
// which plays it at an exact time on the audio clock. What's new is the mapping from session time
// (synced across nodes, see clock.ts) to the audio clock, and the output latency correction: a
// sound started at audio time a is heard at a + outputLatency, so it is started that much earlier.
//
// node-web-audio-api is loaded only when audio is turned on, so peers without a sound setup (VMs,
// a missing JACK library on Linux) still run.
import type { AudioContext as Ctx, AudioBuffer as Buf, GainNode } from 'node-web-audio-api';
import { PRESETS, renderPreset } from './presets.js';
import { stepsBetween } from './schedule.js';
import type { State } from '../state/state.js';
import { presetKey, soundOf } from '../samples/keys.js';

const TICK_MS = 25;
const LOOKAHEAD_MS = 100;
/** A sound that would start more than this late is skipped rather than played out of time. */
const MAX_LATE_MS = 20;

/** Loads node-web-audio-api, with a readable message if this machine can't (e.g. no libjack). */
async function loadAudio(): Promise<typeof import('node-web-audio-api')> {
  try {
    return await import('node-web-audio-api');
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(msg.includes('libjack') ? 'libjack not found (install pipewire-jack, or start with pw-jack)' : msg);
  }
}

/** An ArrayBuffer holding exactly these bytes, as decodeAudioData wants. */
const arrayBufferOf = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export class AudioEngine {
  /** Decoded sounds by track key. Samples are decoded the first time they are needed. */
  private buffers = new Map<string, Buf>();
  /** Samples being decoded, or that failed to decode (not tried again). */
  private decoding = new Map<string, 'pending' | 'failed'>();
  private readSample: (hash: string) => Uint8Array | null = () => null;
  private log: (line: string) => void = () => {};
  private out: GainNode;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Which playback anchor the scheduled steps belong to, and the next step (k) not yet scheduled. */
  private anchor = '';
  private nextK = 0;
  volume = 0.8;

  private constructor(private readonly ctx: Ctx) {
    this.out = ctx.createGain();
    this.out.gain.value = this.volume;
    this.out.connect(ctx.destination);
    for (const preset of PRESETS) {
      const data = renderPreset(preset, ctx.sampleRate);
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
      this.buffers.set(presetKey(preset), buf);
    }
  }

  /** Opens the audio output. Rejects with a readable message if this machine can't play sound. */
  static async open(): Promise<AudioEngine> {
    const mod = await loadAudio();
    return new AudioEngine(new mod.AudioContext({ latencyHint: 'interactive' }));
  }

  /**
   * Checks that a file is audio this program can play, without opening the audio output.
   * Returns its length in seconds, or throws with the reason. Throws "cannot check: …" if the
   * audio library can't be loaded on this machine.
   */
  static async decodeCheck(bytes: Uint8Array): Promise<number> {
    let mod: typeof import('node-web-audio-api');
    try {
      mod = await loadAudio();
    } catch (err) {
      throw new Error(`cannot check: ${(err as Error).message}`);
    }
    try {
      const buf = await new mod.OfflineAudioContext(1, 1, 48_000).decodeAudioData(arrayBufferOf(bytes));
      return buf.duration;
    } catch (err) {
      throw new Error(`not an audio file this program can decode (${(err as Error).message})`);
    }
  }

  /** For tests: an engine on a given (possibly fake) audio context. */
  static withContext(ctx: Ctx): AudioEngine {
    return new AudioEngine(ctx);
  }

  /** Output latency in ms: how long after its start time a sound comes out of the speakers. */
  get latencyMs(): number {
    return (this.ctx.outputLatency || 0) * 1000;
  }

  /** Start following the state; `now` gives session time in ms. */
  /**
   * Start following the state; `now` gives session time in ms, and `readSample` a stored sample's
   * bytes (or null while it hasn't arrived yet).
   */
  start(
    getState: () => State,
    now: () => number,
    readSample: (hash: string) => Uint8Array | null = () => null,
    log: (line: string) => void = () => {},
  ) {
    this.readSample = readSample;
    this.log = log;
    this.timer = setInterval(() => this.schedule(getState(), now()), TICK_MS);
  }

  setVolume(v: number) {
    this.volume = Math.round(Math.min(1, Math.max(0, v)) * 10) / 10;
    this.out.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01); // ramp, so it doesn't click
  }

  async close() {
    clearInterval(this.timer);
    await this.ctx.close();
  }

  private schedule(state: State, sessionNow: number) {
    // Play, stop and tempo changes write a new playback value with a new stamp, and its steps are
    // counted from the new anchor, so start counting again.
    const anchor = `${state.playback.stamp.ver}:${state.playback.stamp.node}`;
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      this.nextK = 0;
    }
    // Decode samples as soon as they are stored, so their first hit isn't lost to decoding.
    for (const key of Object.keys(state.tracks)) if (!this.buffers.has(key)) this.loadSample(key);
    const audioNow = this.ctx.currentTime;
    const latency = this.latencyMs;
    // Steps to be heard between "just now" and the end of the lookahead window.
    for (const hit of stepsBetween(state, sessionNow - MAX_LATE_MS, sessionNow + latency + LOOKAHEAD_MS)) {
      if (hit.k < this.nextK) continue; // already scheduled
      this.nextK = hit.k + 1;
      const startAt = audioNow + (hit.time - sessionNow - latency) / 1000;
      if (startAt < audioNow - MAX_LATE_MS / 1000) continue; // too late to be in time; skip
      for (const track of hit.tracks) this.play(track, Math.max(startAt, audioNow));
    }
  }

  /** Starts decoding a stored sample the first time it's needed; returns null until it's ready. */
  private loadSample(key: string): Buf | null {
    const sound = soundOf(key);
    if (sound?.kind !== 'sample' || this.decoding.has(key)) return null;
    const bytes = this.readSample(sound.hash);
    if (!bytes) return null; // not fetched yet
    this.decoding.set(key, 'pending');
    this.ctx.decodeAudioData(arrayBufferOf(bytes)).then(
      (buf) => {
        this.buffers.set(key, buf);
        this.decoding.delete(key);
      },
      (err: Error) => {
        this.decoding.set(key, 'failed');
        this.log(`cannot play sample ${sound.hash.slice(0, 12)}…: ${err.message}`);
      },
    );
    return null;
  }

  private play(track: string, time: number) {
    const buffer = this.buffers.get(track) ?? this.loadSample(track);
    if (!buffer) return; // not here yet, still decoding, or a key this version has no sound for
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    src.start(time);
  }
}
