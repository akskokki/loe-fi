// Mouse clicks in the terminal. Ink has no mouse support, so the app turns on the terminal's own
// mouse reporting (SGR mode) and reads the click sequences, e.g. ESC[<0;12;7M, from stdin itself.
import { useEffect, useRef } from 'react';

export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sequences start with ESC (\x1b)
export const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
process.on('exit', () => process.stdout.write(MOUSE_OFF)); // never leave the terminal in mouse mode

/** Calls `onClick` with the 1-based terminal column and row of each left-button press. */
export function useMouseClicks(onClick: (x: number, y: number) => void) {
  const handler = useRef(onClick);
  handler.current = onClick;
  useEffect(() => {
    let pending = '';
    // Ink reads stdin via 'readable'; a 'data' listener sees the same chunks without stealing them.
    // Ink itself drops these mouse sequences, so they never reach useInput.
    const onData = (chunk: Buffer | string) => {
      pending += chunk.toString();
      for (const m of pending.matchAll(SGR_MOUSE)) {
        if (m[4] === 'M' && Number(m[1]) === 0) handler.current(Number(m[2]), Number(m[3]));
      }
      // Keep a sequence that was split across chunks for the next one.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sequences start with ESC (\x1b)
      pending = pending.match(/\x1b\[<[\d;]*$/)?.[0] ?? '';
    };
    process.stdin.on('data', onData);
    process.stdout.write(MOUSE_ON);
    return () => {
      process.stdout.write(MOUSE_OFF);
      process.stdin.off('data', onData);
    };
  }, []);
}
