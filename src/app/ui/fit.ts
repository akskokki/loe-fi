// How much of the UI fits in the terminal. Ink can only redraw in place while the whole UI fits,
// so the parts below the grid get the space that is left: the log shrinks and disappears first,
// then the member list (down to this node plus an "… and N more" line). If even that doesn't fit,
// the UI asks for a taller window instead of drawing (drawing anyway would garble the terminal).
import { PAD, TRACKS_ROW } from './layout.js';

/** Log lines shown at most; fewer when the terminal is short. */
export const LOG_LINES = 8;
/** Members listed at most; the rest are summed up in one line. */
export const MAX_MEMBERS_SHOWN = 6;

const HELP_LINES = 3; // blank line and two lines of help (or a prompt)
const MEMBER_PANEL_EXTRA = 4; // blank line, "Members" title, clock line, audio line
const LOG_PANEL_EXTRA = 2; // blank line, "Log" title

export type Fit = {
  /** Members to list (the rest are summed up in one line). */
  members: number;
  /** Log lines to show; 0 hides the log. */
  logLines: number;
  /** Rows the UI needs at least, and whether the terminal has fewer. */
  needed: number;
  tooSmall: boolean;
};

/** What fits in a terminal `rows` tall with this many tracks and members. */
export function fitToHeight(rows: number, trackCount: number, memberCount: number): Fit {
  const usable = rows - 1; // one row spare, so the last line never scrolls the screen
  // Everything down to the help lines: the fixed layout, one row per track (or the "no tracks"
  // line), and the playhead row.
  const top = PAD + TRACKS_ROW + Math.max(1, trackCount) + 1 + HELP_LINES;
  const memberRoom = usable - top - PAD - MEMBER_PANEL_EXTRA;
  let members = Math.min(memberCount, MAX_MEMBERS_SHOWN, Math.max(1, memberRoom));
  if (members < memberCount) members = Math.max(1, Math.min(members, memberRoom - 1)); // room for "… and N more"
  const summaryLine = members < memberCount ? 1 : 0;
  const linesAboveLog = top + MEMBER_PANEL_EXTRA + members + summaryLine;
  const logLines = Math.max(0, Math.min(LOG_LINES, usable - linesAboveLog - LOG_PANEL_EXTRA - PAD));
  const needed = linesAboveLog + PAD + 1;
  return { members, logLines, needed, tooSmall: rows < needed };
}
