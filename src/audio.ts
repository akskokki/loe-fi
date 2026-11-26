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
import type { State } from './state.js';

const TICK_MS = 25;
const LOOKAHEAD_MS = 100;
/** A sound that would start more than this late is skipped rather than played out of time. */
const MAX_LATE_MS = 20;

export class AudioEngine {
  private buffers = new Map<string, Buf>();
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
      this.buffers.set(preset, buf);
    }
  }

  /** Opens the audio output. Rejects with a readable message if this machine can't play sound. */
  static async open(): Promise<AudioEngine> {
    let mod: typeof import('node-web-audio-api');
    try {
      mod = await import('node-web-audio-api');
    } catch (err) {
      const msg = (err as Error).message;
      throw new Error(msg.includes('libjack') ? 'libjack not found (install pipewire-jack, or start with pw-jack)' : msg);
    }
    return new AudioEngine(new mod.AudioContext({ latencyHint: 'interactive' }));
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
  start(getState: () => State, now: () => number) {
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

  private schedule(s: State, sessionNow: number) {
    // Play, stop and tempo changes write a new playback value with a new stamp, and its steps are
    // counted from the new anchor, so start counting again.
    const anchor = `${s.playback.stamp.ver}:${s.playback.stamp.node}`;
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      this.nextK = 0;
    }
    const audioNow = this.ctx.currentTime;
    const latency = this.latencyMs;
    // Steps to be heard between "just now" and the end of the lookahead window.
    for (const hit of stepsBetween(s, sessionNow - MAX_LATE_MS, sessionNow + latency + LOOKAHEAD_MS)) {
      if (hit.k < this.nextK) continue; // already scheduled
      this.nextK = hit.k + 1;
      const startAt = audioNow + (hit.time - sessionNow - latency) / 1000;
      if (startAt < audioNow - MAX_LATE_MS / 1000) continue; // too late to be in time; skip
      for (const track of hit.tracks) this.play(track, Math.max(startAt, audioNow));
    }
  }

  private play(track: string, time: number) {
    const buffer = this.buffers.get(track);
    if (!buffer) return; // a track this version has no sound for
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    src.start(time);
  }
}
