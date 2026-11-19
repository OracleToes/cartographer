import type { ProjectView } from "../runtime/project.js";
import type { LiveSessionView } from "../runtime/live-session.js";
import type { PrefillState } from "../runtime/prefill.js";
import { duration, rate } from "./text.js";
import { token } from "./tokens.js";

/**
 * The one line next to the tabs: what the agent is doing, in the person's
 * words, with the number that matters most right now.
 *
 * The order of the tests is the order of priority. A failure outranks a run,
 * because a run cannot continue past it; a paused turn outranks a run for the
 * same reason. A recent reading outlives the run by a few seconds only, so the
 * person can see how long the server took to read the prompt.
 */

export interface StatusInput {
  view: Pick<ProjectView, "turn" | "brain" | "activity">;
  /** The live documents, when a frame read them; absent while cached. */
  live?: Pick<LiveSessionView, "busy">;
  prefill?: PrefillState;
  now: number;
  /** When the current run started, from the first frame that saw it. */
  runStartedAt?: number | undefined;
  /** The last finished prefill, kept for a short while. */
  lastReading?: { fresh: number; ms: number; at: number } | undefined;
  /** A local action is in flight (a person command, a pause, a resume). */
  applying: boolean;
  /** A frame could not read the project. */
  error?: string | undefined;
  /** How long the last reading stays visible after it ends. */
  recentMs?: number;
}

export interface StatusText {
  /** `⠹`, `○`, `⏸`, `?`, `!`, or a bullet for a local action. */
  mark: string;
  /** The words after the mark. */
  text: string;
  /** True when the spinner must advance, which is also when a frame is due. */
  spinning: boolean;
  /** The style for the whole line. */
  style: (text: string) => string;
}

const RECENT_MS = 20_000;

export function statusLine(input: StatusInput): StatusText {
  const { view, prefill } = input;
  const turn = view.turn.state;
  if (input.error !== undefined) return { mark: "!", text: input.error, spinning: false, style: token.danger };
  if (view.brain.activity.kind === "error") {
    return { mark: "!", text: view.brain.activity.detail ?? "The last run failed.", spinning: false, style: token.danger };
  }
  if (turn === "paused") {
    return { mark: "⏸", text: "paused · r edits the draft · x cancels", spinning: false, style: token.warning };
  }
  if (view.brain.activity.kind === "waiting-for-collapse") {
    return {
      mark: "●",
      text: "collapse requested · a shows the commands · Esc closes",
      spinning: false,
      style: token.warning,
    };
  }
  if (input.applying) {
    // A person command commits to the Brain; the run, if any, is not moving.
    return { mark: "●", text: "applying", spinning: false, style: token.warning };
  }
  if (prefill !== undefined && prefill.phase === "reading") {
    const reading = readProgressStatus(prefill);
    if (reading !== undefined) return reading;
  }
  if (turn === "running" || input.live?.busy === true) {
    const elapsed = input.runStartedAt === undefined ? "" : ` · ${duration(input.now - input.runStartedAt)}`;
    if (prefill !== undefined && prefill.phase === "sent") {
      return { mark: "⠋", text: `waiting for the model${elapsed}`, spinning: true, style: token.busy };
    }
    if (prefill !== undefined && prefill.phase === "writing") {
      return { mark: "⠸", text: `writing${elapsed}`, spinning: true, style: token.busy };
    }
    const tool = latestToolPhase(view);
    if (tool !== undefined) {
      return { mark: "⠼", text: `${tool}${elapsed}`, spinning: true, style: token.busy };
    }
    return { mark: "⠹", text: `reading${elapsed}`, spinning: true, style: token.busy };
  }
  if (turn === "cancelling") return { mark: "⠹", text: "stopping", spinning: true, style: token.busy };
  const recent = input.lastReading;
  if (recent !== undefined && input.now - recent.at < (input.recentMs ?? RECENT_MS)) {
    return {
      mark: "·",
      text: `read ${Math.round(recent.fresh)} new in ${duration(recent.ms)}`,
      spinning: false,
      style: token.muted,
    };
  }
  return { mark: "○", text: "idle", spinning: false, style: token.muted };
}

function readProgressStatus(prefill: PrefillState): StatusText | undefined {
  const fresh = prefill.total - prefill.cache;
  if (fresh <= 0) return undefined;
  const done = Math.max(0, Math.min(prefill.processed - prefill.cache, fresh));
  const percent = Math.round((done / fresh) * 100);
  const speed = prefill.ms !== undefined && prefill.ms > 0 ? ` · ${rate(done, prefill.ms)}` : "";
  return { mark: "⠹", text: `reading ${percent}%${speed}`, spinning: true, style: token.busy };
}

/**
 * The newest tool activity, as `tool inspect src/retry.ts`. A tool that is
 * still running is more informative than "reading", because the model has
 * already answered and the server is not reading anything.
 */
function latestToolPhase(view: Pick<ProjectView, "activity">): string | undefined {
  for (let index = view.activity.length - 1; index >= 0; index -= 1) {
    const item = view.activity[index];
    if (item === undefined) continue;
    if (item.kind !== "tool-call" && item.kind !== "tool-output") continue;
    if (!item.streaming) return undefined;
    const label = item.label.replace(/^Tool call: /, "tool ");
    return label;
  }
  return undefined;
}
