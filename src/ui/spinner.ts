/**
 * The spinner is the frame clock, not decoration.
 *
 * Pi TUI draws a frame only when something asks for one, and the agent's work
 * happens in storage, not in the key handler. A timer that advances one frame
 * every 100 ms is therefore the thing that keeps the screen alive while the
 * agent runs; the fact that it also shows motion is a useful side effect: the
 * person learns that the program is not frozen.
 *
 * Pi TUI also ships `Loader`, which animates itself with a `TUI` and a frame
 * list. The status row here is a wider layout (a mark, a percentage, a rate, a
 * duration) so it composes a frame from this list instead; the frames and the
 * interval are exported so `Loader` can be given the identical indicator and
 * the two can never drift.
 */

/** Braille dots, the quietest spinner that most terminals draw at one cell. */
export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** One frame per 100 ms: about six frames a second, well under Pi's 16 ms floor. */
export const SPINNER_INTERVAL_MS = 100;

/** The frame at an elapsed time. Deterministic, so a snapshot can name it. */
export function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) % FRAMES.length;
  return FRAMES[index] ?? FRAMES[0];
}

/** True when a redraw is due only because the spinner moved. */
export function spinnerChanged(previousElapsedMs: number, elapsedMs: number): boolean {
  return spinnerFrame(previousElapsedMs) !== spinnerFrame(elapsedMs);
}
