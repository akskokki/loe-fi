// The preset sounds that come with the program. A track is identified by its preset's name, and
// every node can render every preset, so no sound is ever sent over the network.
//
// The sounds are synthesized (from the tui-sequencer prototype) rather than loaded from files.
// This module only computes samples; engine.ts turns them into buffers and plays them.

export const PRESETS = ['kick', 'snare', 'hat', 'clap', 'tom'] as const;
export type Preset = (typeof PRESETS)[number];

export const isPreset = (x: string): x is Preset => (PRESETS as readonly string[]).includes(x);

/** Renders `seconds` of sound by calling `f` with the time of each sample. */
function render(seconds: number, sampleRate: number, f: (t: number) => number): Float32Array {
  const data = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < data.length; i++) data[i] = f(i / sampleRate);
  return data;
}

const noise = () => Math.random() * 2 - 1;

/** A preset's sound as mono samples in -1..1. */
export function renderPreset(preset: Preset, sampleRate: number): Float32Array {
  switch (preset) {
    case 'kick': {
      let phase = 0;
      return render(0.35, sampleRate, (t) => {
        const freq = 45 + 110 * Math.exp(-t * 25); // pitch drops fast
        phase += (2 * Math.PI * freq) / sampleRate;
        return Math.sin(phase) * Math.exp(-t * 9) * 0.9;
      });
    }
    case 'snare':
      return render(
        0.25,
        sampleRate,
        (t) => noise() * Math.exp(-t * 22) * 0.5 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.3,
      );
    case 'hat': {
      let prev = 0;
      return render(0.08, sampleRate, (t) => {
        const n = noise();
        const highPassed = n - prev; // crude high-pass
        prev = n;
        return highPassed * Math.exp(-t * 70) * 0.3;
      });
    }
    case 'clap':
      // A few quick noise bursts and a short tail, like several hands not quite together.
      return render(0.3, sampleRate, (t) => {
        const burst = [0, 0.011, 0.022].some((start) => t >= start && t < start + 0.008) ? 1 : 0;
        return noise() * (burst * 0.6 + Math.exp(-(t - 0.022) * 25) * (t > 0.022 ? 0.35 : 0));
      });
    case 'tom': {
      let phase = 0;
      return render(0.4, sampleRate, (t) => {
        const freq = 110 + 60 * Math.exp(-t * 12);
        phase += (2 * Math.PI * freq) / sampleRate;
        return Math.sin(phase) * Math.exp(-t * 7) * 0.7;
      });
    }
  }
}
