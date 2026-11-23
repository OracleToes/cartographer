/**
 * The headless driver: a bare line-based stdin/stdout loop, for driving the
 * agent where there is no screen.
 *
 * Line semantics:
 *   /collapse  — the person collapses the context on the spot: run the
 *                ceremony, print the plain report, keep going.
 *   /pause     — /pause holds the run where it is and /pause off lets it go on
 *                (§9): nothing is committed or discarded, and the agent is not
 *                told. A line typed while the agent is held lets the held reply
 *                go and is the next thing the agent reads.
 *   /help      — the commands.
 *   /quit      — end the session (also on stdin EOF).
 *   anything else — a person message to the agent.
 *
 * The only words the person sees are the agent's `chat` tool calls: plain
 * model text never reaches the person, and a turn with nothing to say ends
 * with nothing to print. When the agent asks to collapse (the collapse tool),
 * or the model's limits force one, the driver performs the ceremony at once,
 * says what happened, carries any unanswered message of the person's into the
 * rebuilt context, and the agent goes on by itself — until the bound on
 * automatic collapse says the rebuild got nowhere, which it reports and stops.
 *
 * If `capacity` is given, the window is re-discovered after every settled run;
 * the active window follows the provider's catalog — the configured pin
 * always wins; without one, the advertised capacity (unknown until the
 * server has loaded and is telling the truth).
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";

import {
  closeLiveSession,
  collapseLiveSession,
  openLiveSession,
  submitInput,
  switchSessionModel,
  togglePause,
  waitForRunEnd,
  type LiveSession,
  type LiveSessionOptions,
} from "./live-session.js";
import type { ModelRef } from "./config.js";
import { formatModelRef, indexModels, resolveIndexedModel } from "./model-catalog.js";

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
  /** Called after `/model` switches models so the host can persist or track the selection. */
  onModelChange?: (model: ModelRef) => Promise<void> | void;
}

const HELP = [
  "Type to the agent; it answers in `chat`, and its plain text stays its own thinking.",
  "  /model     list provider models (/model <name> switches at the next step)",
  "  /collapse  collapse the context now — the Brain rebuilds it",
  "  /pause     hold the run where it is (/pause off lets it go on)",
  "  /help      see this",
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

async function runCollapse(
  session: LiveSession,
  options: HeadlessOptions,
  output: Writable,
  reason: string,
  automatic = false,
): Promise<LiveSession> {
  const previousGeneration = session.generation;
  const outcome = await collapseLiveSession(session, options, reason, {}, { automatic });
  const swept = outcome.report.swept === undefined ? "" : `; swept ${outcome.report.swept}`;
  const archived = outcome.report.archived.length === 0 ? "" : `; archived ${outcome.report.archived.length}`;
  const dropped = outcome.report.dropped.length === 0 ? "" : `; dropped ${outcome.report.dropped.length} past grace`;
  writeLine(output, `context collapsed and rebuilt from the Brain (${previousGeneration} → ${outcome.report.generation}${swept}${archived}${dropped}).`);
  if (automatic) {
    const carried = outcome.carried === 0 ? "" : `; ${outcome.carried} unanswered message(s) carried over`;
    writeLine(output, `(${reason}${carried}${outcome.resumed ? " — the agent goes on" : " — paused, so it waits"})`);
  }
  return outcome.session;
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const output = options.output;
  const error = options.error ?? options.output;
  let activeModel: ModelRef = { ...options.model };
  const sessionOptions = (): HeadlessOptions => ({ ...options, model: activeModel });
  const refresh = async () => {
    // Silent on failure: an unreachable server leaves the last known window standing.
    await options.models.refresh({ providers: [activeModel.provider] }).catch(() => undefined);
  };
  if (options.refreshCapacity === true) await refresh();
  let session = await openLiveSession(sessionOptions());
  let capacityRefreshFlight: Promise<void> | undefined;
  const refreshWindow = async () => {
    if (options.refreshCapacity !== true) return;
    if (capacityRefreshFlight !== undefined) return capacityRefreshFlight;
    const work = applyCapacityRefresh(session, refresh, options.models, activeModel.provider, activeModel.modelId, output);
    capacityRefreshFlight = work;
    try {
      await work;
    } finally {
      if (capacityRefreshFlight === work) capacityRefreshFlight = undefined;
    }
  };
  const bindResponseRefresh = (target: LiveSession) => {
    target.state.onResponse = () => {
      if (options.refreshCapacity === true && target === session && target.state.contextWindow <= 0) {
        void refreshWindow().catch(() => undefined);
      }
    };
  };
  bindResponseRefresh(session);
  const seenChat = new Set<string>((await options.brain.read()).chat.filter((record) => record.author === "agent").map((record) => record.id));

  writeLine(output, `carto · ${options.model.provider}/${options.model.modelId} · ${options.root}`);
  writeLine(output, HELP);

  const inputIsTTY = (options.input as Readable & { isTTY?: boolean }).isTTY === true;
  // Interactive mode on a TTY: readline manages the terminal (echo, line
  // editing); without it a person may reach a promptless screen with no way
  // to type. Piped use stays non-terminal.
  const rl = createInterface({ input: options.input, terminal: inputIsTTY });
  let linesSeen = 0;

  // Everything that touches the session runs one at a time: a line, and the
  // collapse a run ended in. A line that arrives during a collapse waits in the
  // reader and is the next thing the rebuilt agent is given.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  /**
   * Let the current chain of runs end, say what the agent said, and carry out
   * the collapse it ended in — the agent's own, or one forced by the model's
   * limits — then keep going with the run that collapse starts, until nothing
   * more is asked or the bound on automatic collapse says stop.
   */
  const settle = async (): Promise<void> => {
    for (;;) {
      await waitForRunEnd(session);
      // Silence is a real answer: an agent with nothing to say ends its turn
      // without a chat call, and that needs no remark from the driver.
      for (const text of await drainAgentChat(options.brain, seenChat)) writeLine(output, `carto: ${text}`);
      const verdict = session.reviewCollapseRequest();
      if (verdict.kind === "none") break;
      if (verdict.kind === "stop") {
        writeLine(error, `(${verdict.explanation})`);
        break;
      }
      try {
        session = await runCollapse(session, sessionOptions(), output, verdict.reason, true);
      } catch (err) {
        writeLine(error, `(the collapse failed: ${err instanceof Error ? err.message : String(err)})`);
        break;
      }
      await watchSession();
    }
    if (options.refreshCapacity === true) {
      await refreshWindow();
    }
  };

  // The agent also runs without a line: a timed rest wakes it. Watching the
  // live run is how its chat is heard and its collapse is carried out then.
  let watch: { stop(): Promise<unknown> } | undefined;
  const watchSession = async (): Promise<void> => {
    const previous = watch;
    watch = undefined;
    await previous?.stop().catch(() => undefined);
    const mine = session;
    bindResponseRefresh(mine);
    const next = await mine.harness.watchDoc(LiveDoc, mine.conversation.id, BACKGROUND_CONTEXT).catch(() => undefined);
    if (next === undefined) return;
    watch = next;
    next.start(async (call) => {
      if (call.kind !== "value" || call.value.run !== undefined) return;
      // Only an idle moment: a line in progress settles its own runs.
      void exclusive(async () => {
        if (mine === session) await settle();
      }).catch((err: unknown) => writeLine(error, `(the run failed: ${err instanceof Error ? err.message : String(err)})`));
    });
  };
  await watchSession();

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
      if (line === "/pause" || line.startsWith("/pause ")) {
        const argument = line.slice("/pause".length).trim();
        const to = argument === "on" ? true : argument === "off" ? false : argument === "" ? undefined : null;
        if (to === null) {
          writeLine(error, "(/pause, /pause on, or /pause off)");
          continue;
        }
        // Not behind the lock: a pause must land while the agent is working.
        try {
          writeLine(output, (await togglePause(session, to)).line);
        } catch (err) {
          writeLine(error, `(the pause failed: ${err instanceof Error ? err.message : String(err)})`);
        }
        continue;
      }
      if (line === "/model" || line.startsWith("/model ")) {
        const argument = line.slice("/model".length).trim();
        const indexed = await indexModels(options.models, { refresh: true, active: activeModel });
        if (argument === "") {
          if (indexed.errors.length > 0) {
            for (const err of indexed.errors) writeLine(error, `(model refresh ${err.provider}: ${err.message})`);
          }
          for (const entry of indexed.models) {
            const mark = entry.active ? "*" : " ";
            const window = entry.contextWindow > 0 ? entry.contextWindow.toLocaleString() : "window unknown";
            writeLine(output, `${mark} ${entry.provider}/${entry.modelId} (${window})`);
          }
          continue;
        }
        const resolved = resolveIndexedModel(options.models, argument, activeModel.provider);
        if (resolved === undefined) {
          writeLine(error, `(unknown model "${argument}"; run /model to list indexed models)`);
          continue;
        }
        try {
          await switchSessionModel(session, options.models, resolved);
          activeModel = { ...resolved };
          try {
            await options.onModelChange?.(resolved);
          } catch (persistErr) {
            writeLine(error, `(model switched, could not save config: ${persistErr instanceof Error ? persistErr.message : String(persistErr)})`);
          }
          writeLine(output, `model → ${formatModelRef(resolved)}`);
        } catch (err) {
          writeLine(error, `(model switch failed: ${err instanceof Error ? err.message : String(err)})`);
        }
        continue;
      }
      if (line === "/collapse") {
        await exclusive(async () => {
          session = await runCollapse(session, sessionOptions(), output, "person requested (/collapse)");
          await watchSession();
          for (const text of await drainAgentChat(options.brain, seenChat)) writeLine(output, `carto: ${text}`);
        });
        continue;
      }

      await exclusive(async () => {
        // A line written while the agent is held in its stream lets go of that
        // stream first (§9): the held reply ends here, and this line is the next
        // thing the agent reads.
        if (session.freeze.frozen()) {
          session.freeze.abandon();
          writeLine(output, "(the held reply ends here — your line is the next thing)");
        }
        try {
          const submission = await submitInput(session, line);
          const settled = await submission.wait(BACKGROUND_CONTEXT);
          await waitForRunEnd(session);
          // A run that ended because the context ran out is not "nothing left
          // to do": the collapse that follows is the answer.
          if (settled.status !== "done" && session.state.collapseRequested === null) {
            writeLine(error, `(the run ended ${settled.status} — nothing was left to do)`);
          }
        } catch (err) {
          writeLine(error, `(the run failed: ${err instanceof Error ? err.message : String(err)})`);
        }
        await settle();
      });
    }
  } finally {
    await queue;
    await watch?.stop().catch(() => undefined);
    await closeLiveSession(session);
  }
  if (linesSeen === 0 && !inputIsTTY) {
    writeLine(error, "(nothing arrived on stdin and there was no terminal to type into. Pipe the person's messages in, or run carto in a terminal.)");
  }
  return 0;
}
