import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from './engine.js';
import { addTrack, emptyState, toggleCell, updatePlayback } from '../state/state.js';

/** Just enough of an AudioContext for the engine; records when each sound would start. */
function fakeContext(outputLatency: number) {
  const origin = performance.now();
  const starts: number[] = [];
  const ctx = {
    sampleRate: 8000,
    get currentTime() {
      return (performance.now() - origin) / 1000;
    },
    outputLatency,
    destination: {},
    createGain: () => ({ gain: { value: 0, setTargetAtTime() {} }, connect() {} }),
    createBuffer: (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start: (t: number) => starts.push(t) }),
    close: async () => {},
  };
  return { ctx, starts, origin };
}

test("every hit is heard exactly at its step's session time, once", async () => {
  const latency = 0.03;
  const { ctx, starts, origin } = fakeContext(latency);
  // Session time runs 12 345 ms ahead of this machine's clock, as after syncing to a reference.
  const now = () => performance.timeOrigin + performance.now() + 12_345;
  let s = addTrack(emptyState(), 1, 'preset:kick', 'kick');
  for (const step of [0, 2, 4, 6]) s = toggleCell(s, 1, 'preset:kick', step);
  const at = now() + 200; // start a little in the future
  s = updatePlayback(s, 1, at, { playing: true });
  s = { ...s, playback: { ...s.playback, value: { ...s.playback.value, at } } };

  const engine = AudioEngine.withContext(ctx as any);
  engine.start(() => s, now);
  await new Promise((r) => setTimeout(r, 1200));
  await engine.close();

  // Audio time 0 is `origin` on the performance clock, so session time = audio time + this.
  const sessionAtAudioZero = performance.timeOrigin + origin + 12_345;
  const heard = starts.map((t) => sessionAtAudioZero + (t + latency) * 1000);
  const expected = [0, 2, 4, 6].map((step) => at + step * 125).filter((t) => t < now());
  assert.ok(expected.length >= 4);
  assert.equal(heard.length, expected.length, `heard ${heard.length} hits, expected ${expected.length}`);
  heard.forEach((t, i) =>
    assert.ok(Math.abs(t - expected[i]) < 1, `hit ${i} off by ${(t - expected[i]).toFixed(3)} ms`),
  );
});
