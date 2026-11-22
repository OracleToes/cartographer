/**
 * The headless driver — a placeholder, not the designed interface
 * (MINI.md §8 is the person's to mark). A bare line-based stdin/stdout loop
 * so the agent can be driven and tested without a screen.
 *
 * Line semantics (placeholders, to be replaced by §8):
 *   /collapse  — the person collapses the context on the spot: run the
 *                ceremony, print the plain report, keep going.
 *   /quit      — end the session (also on stdin EOF).
 *   anything else — a person message to the agent.
 *
 * The only words the person sees are the agent's `chat` tool calls: plain
 * model text never reaches the person (MINI.md §10a). A run that ends
 * without a chat message prints one quiet parenthetical saying so. When the
 * agent asks to collapse (the collapse tool), the driver performs the
 * ceremony at once and says what happened.
 *
 * If `capacity` is given, the window is re-discovered after every settled run;
 * the active window follows the provider's catalog — the configured pin
 * always wins; without one, the advertised capacity (unknown until the
 * server has loaded and is telling the truth).
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import {
  closeLiveSession,
  collapseLiveSession,
  openLiveSession,
  restThenResume,
  submitInput,
  type LiveSession,
  type LiveSessionOptions,
} from "./live-session.js";

export interface HeadlessOptions extends LiveSessionOptions {
  input: Readable;
  output: Writable;
  error?: Writable;
  /**
   * When true, Pi's provider-catalog refresh runs before the session opens
   * and after every settled run (llama-swap advertises a model's capacity
   * only once it has loaded). The active window then follows the provider's
   * catalog: a configured pin always wins; without one, the advertised
   * capacity is used. Refresh failures are silent by design — the last
   * known window stands.
   */
  refreshCapacity?: boolean;
}

const HELP = [
  "Lines go to the agent. Placeholder commands:",
  "  /collapse  collapse the context now (the Brain rebuilds it)",
  "  /quit      end the session",
].join("\n");

function writeLine(stream: Writable, line: string): void {
  stream.write(`${line}\n`);
}

/** New agent-authored chat records since `seen`; adds them to `seen`. */
async function drainAgentChat(brain: LiveSessionOptions["brain"], seen: Set<string>): Promise<string[]> {
  const lines: string[] = [];
  for (const record of (await brain.read()).chat) {
    if (record.author !== "agent" || seen.has(record.id)) continue;
    seen.add(record.id);
    lines.push(record.text);
  }
  return lines;
}

/** Exported for the tests. The provider's catalog is the single source of the active window: the configured pin, else the advertised capacity, else 0 (unknown). */
export async function applyCapacityRefresh(
  session: LiveSession,
  refresh: () => Promise<void>,
  models: LiveSessionOptions["models"],
  providerId: string,
  modelId: string,
  output: Writable,
): Promise<void> {
  await refresh();
  const next = models.getModel(providerId, modelId)?.contextWindow;
  if (next === undefined || next === session.state.contextWindow) return;
  const from = session.state.contextWindow > 0 ? session.state.contextWindow.toLocaleString() : "unknown";
  if (next > 0) {
    writeLine(output, `context window ${from} → ${next.toLocaleString()} (advertised by the server)`);
  } else {
    writeLine(output, `context window ${from} → unknown (the server stopped advertising one)`);
  }
  session.state.contextWindow = next;
}

async function runCollapse(session: LiveSession, options: HeadlessOptions, output: Writable, reason: string): Promise<LiveSession> {
  const previousGeneration = session.generation;
  const outcome = await collapseLiveSession(session, options, reason);
  writeLine(output, `context collapsed and rebuilt from the Brain (${previousGeneration} → ${outcome.report.generation}; sealed ${outcome.report.sealed ?? "nothing"}${outcome.report.purged === undefined ? "" : `; purged ${outcome.report.purged}`}).`);
  return outcome.session;
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const output = options.output;
  const error = options.error ?? options.output;
  const refresh = async () => {
    // Silent on failure: an unreachable server leaves the last known window standing.
    await options.models.refresh({ providers: [options.model.provider] }).catch(() => undefined);
  };
  if (options.refreshCapacity === true) await refresh();
  let session = await openLiveSession(options);
  const seenChat = new Set<string>((await options.brain.read()).chat.filter((record) => record.author === "agent").map((record) => record.id));

  writeLine(output, `carto · headless · ${options.model.provider}/${options.model.modelId} · project ${options.root}`);
  writeLine(output, HELP);

  const inputIsTTY = (options.input as Readable & { isTTY?: boolean }).isTTY === true;
  // Interactive mode on a TTY: readline manages the terminal (echo, line
  // editing); without it a person may reach a promptless screen with no way
  // to type. Piped use stays non-terminal.
  const rl = createInterface({ input: options.input, terminal: inputIsTTY });
  let linesSeen = 0;
  try {
    for await (const raw of rl) {
      linesSeen += 1;
      const line = raw.trim();
      if (line === "") continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        writeLine(output, HELP);
        continue;
      }
      if (line === "/collapse") {
        session = await runCollapse(session, options, output, "person requested (/collapse)");
        for (const text of await drainAgentChat(options.brain, seenChat)) writeLine(output, `carto: ${text}`);
        continue;
      }

      try {
        const submission = await submitInput(session, line);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.status !== "done") {
          writeLine(error, `(the run ended with status "${settled.status}")`);
        }
      } catch (err) {
        writeLine(error, `(the run failed: ${err instanceof Error ? err.message : String(err)})`);
      }
      const said = await drainAgentChat(options.brain, seenChat);
      if (said.length === 0) writeLine(output, "(no chat message)");
      else for (const text of said) writeLine(output, `carto: ${text}`);

      const reason = session.takeCollapseRequest();
      if (reason !== null) {
        session = await runCollapse(session, options, output, reason);
      }
      // A timed sleep: the agent rests, then starts again on its own (§10).
      await restThenResume(session);
      if (options.refreshCapacity === true) {
        await applyCapacityRefresh(session, refresh, options.models, options.model.provider, options.model.modelId, output);
      }
    }
  } finally {
    await closeLiveSession(session);
  }
  if (linesSeen === 0 && !inputIsTTY) {
    writeLine(error, "(stdin is not a terminal and carried no lines; there was nothing to type into. Pipe input on stdin, or run carto interactively.)");
  }
  return 0;
}
