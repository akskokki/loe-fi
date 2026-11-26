// React hooks for the UI: things that make it redraw.
import { useEffect, useReducer, useState } from 'react';
import { playheadAt } from '../../state/state.js';
import type { PeerNode } from '../../net/node.js';
import type { LogBuffer } from './log.js';

/** The terminal's height in rows, updated when the window is resized. */
export function useTerminalRows(clearScreen: () => void): number {
  const [rows, setRows] = useState(process.stdout.rows || 24); // Ink draws to process.stdout
  useEffect(() => {
    const onResize = () => {
      // After a resize, Ink's in-place redraw would erase the wrong lines (it counts lines of the
      // previous frame), so forget that frame, wipe the screen and draw the next frame from the top.
      clearScreen();
      process.stdout.write('\x1b[2J\x1b[H');
      setRows(process.stdout.rows || 24);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, [clearScreen]);
  return rows;
}

/**
 * Redraws when the state, a member's liveness or the log changes, and once a second anyway (so
 * gone members drop off the list on time). Returns a function to request a redraw by hand.
 */
export function useRedraw(node: PeerNode, logs: LogBuffer): () => void {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    node.on('change', redraw);
    const unsubscribe = logs.subscribe(redraw);
    const timer = setInterval(redraw, 1000);
    return () => {
      node.off('change', redraw);
      unsubscribe();
      clearInterval(timer);
    };
  }, [node, logs]);
  return redraw;
}

/** The step the playhead is on, recomputed ~30 times a second from session time. */
export function usePlayhead(node: PeerNode): number {
  const [playhead, setPlayhead] = useState(0);
  useEffect(() => {
    // React skips the redraw when the step hasn't changed.
    const timer = setInterval(() => setPlayhead(playheadAt(node.state, node.now())), 33);
    return () => clearInterval(timer);
  }, [node]);
  return playhead;
}
