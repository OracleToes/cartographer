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
 * If `capacity` is given, advertised capacity is re-discovered after every
 * settled run; the active window drops to min(ceiling, advertised) when the
 * server has loaded and is telling the truth. The ceiling never rises here.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { activeContextWindow, discoverAdvertisedCapacity } from "./capacity.js";
import {
  closeLiveSession,
  collapseLiveSession,
  openLiveSession,
  submitInput,
  type LiveSession,
  type LiveSessionOptions,
} from "./live-session.js";

export interface HeadlessOptions extends LiveSessionOptions {
  input: Readable;
  output: Writable;
  error?: Writable;
  /** Pre-flight discovery and post-run refresh; omit to run with the configured ceiling only. `fetchImpl` exists for the tests. */
  capacity?: { endpoint: string; configured: number; modelId: string; fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }> };
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
function drainAgentChat(brain: LiveSessionOptions["brain"], seen: Set<string>): string[] {
  const lines: string[] = [];
  for (const record of brain.read().chat) {
    if (record.author !== "agent" || seen.has(record.id)) continue;
    seen.add(record.id);
    lines.push(record.text);
  }
  return lines;
}

async function applyCapacityRefresh(session: LiveSession, capacity: NonNullable<HeadlessOptions["capacity"]>, output: Writable): Promise<void> {
  const advertised = await discoverAdvertisedCapacity(capacity.endpoint, capacity.modelId, capacity.fetchImpl);
  if (advertised === undefined) return;
  const next = activeContextWindow(capacity.configured, advertised.capacity);
  if (next === session.state.contextWindow) return;
  writeLine(output, `context limit ${session.state.contextWindow.toLocaleString()} → ${next.toLocaleString()} (advertised as ${advertised.source} = ${advertised.capacity.toLocaleString()})`);
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
  let session = await openLiveSession(options);
  if (options.capacity !== undefined) {
    const advertised = await discoverAdvertisedCapacity(options.capacity.endpoint, options.capacity.modelId, options.capacity.fetchImpl);
    const next = activeContextWindow(options.capacity.configured, advertised?.capacity);
    if (next !== session.state.contextWindow) {
      writeLine(output, `context limit ${session.state.contextWindow.toLocaleString()} → ${next.toLocaleString()} (advertised as ${advertised?.source} = ${advertised?.capacity.toLocaleString()})`);
      session.state.contextWindow = next;
    }
  }
  const seenChat = new Set<string>(options.brain.read().chat.filter((record) => record.author === "agent").map((record) => record.id));

  writeLine(output, `carto · headless · ${options.model.provider}/${options.model.modelId} · project ${options.root}`);
  writeLine(output, HELP);

  const rl = createInterface({ input: options.input, terminal: false });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === "") continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        writeLine(output, HELP);
        continue;
      }
      if (line === "/collapse") {
        session = await runCollapse(session, options, output, "person requested (/collapse)");
        for (const text of drainAgentChat(options.brain, seenChat)) writeLine(output, `carto: ${text}`);
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
      const said = drainAgentChat(options.brain, seenChat);
      if (said.length === 0) writeLine(output, "(no chat message)");
      else for (const text of said) writeLine(output, `carto: ${text}`);

      const reason = session.takeCollapseRequest();
      if (reason !== null) {
        session = await runCollapse(session, options, output, reason);
      }
      if (options.capacity !== undefined) {
        await applyCapacityRefresh(session, options.capacity, output);
      }
    }
  } finally {
    await closeLiveSession(session);
  }
  return 0;
}
