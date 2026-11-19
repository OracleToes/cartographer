import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  styleTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import { visibleAtlas, visibleChat, visibleLedger } from "../domain/brain.js";
import { mergeCarryPins } from "../domain/context.js";
import { deletionHandleId, handleOf } from "../domain/handles.js";
import type { CartoProject, ProjectView, SendMode } from "./project.js";
import type { LiveActivity } from "./live-session.js";

/** ANSI semantic styles deliberately use the terminal palette, never hard-coded RGB. */
const accent = (text: string) => styleTextWithAnsi(text, "\x1b[36m", undefined, { bold: true });
const muted = (text: string) => styleTextWithAnsi(text, "\x1b[90m", undefined, {});
const warning = (text: string) => styleTextWithAnsi(text, "\x1b[33m", undefined, { bold: true });
const danger = (text: string) => styleTextWithAnsi(text, "\x1b[31m", undefined, { bold: true });
const personStyle = (text: string) => styleTextWithAnsi(text, "\x1b[34m", undefined, { bold: true });
const agentStyle = (text: string) => styleTextWithAnsi(text, "\x1b[32m", undefined, { bold: true });
const reasoningStyle = (text: string) => styleTextWithAnsi(text, "\x1b[35m", undefined, { dim: true });
const toolStyle = (text: string) => styleTextWithAnsi(text, "\x1b[36m", undefined, {});

type Tab = "chat" | "brain" | "context";
type Mode = "navigate" | "insert";
type Detail = "help" | "actions" | "chat" | null;
/** Testable disclosure projection. A long streaming item always opens at its newest lines. */
export function disclosureLines(item: LiveActivity, rows = 5, expanded = false, columns = 80): string[] {
  const lines = visualRows(item.text, columns);
  // Completed transient records deliberately fold to a one-line summary. They
  // remain in the disclosure list and `o` expands them, so no content vanishes.
  if (item.completed && !expanded) return [summaryLine(lines)];
  if (expanded || lines.length <= rows) return lines;
  // Live windows follow the tail. Expanding them therefore grows upward while
  // leaving the newest content visible at the bottom.
  return lines.slice(-rows);
}

export async function runCartoUi(project: CartoProject): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("carto needs an interactive terminal for the Carto UI.");

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });
  const header = new Text();
  const status = new Text();
  const content = new Text();
  const editor = new Editor(tui, editorTheme());
  const scroll = new ScrollView(content, { primary: true, follow: "end", scrollbar: "auto" });
  tui.setLayoutRoot(new VStack([header, status, { component: scroll, grow: 1 }, editor], { gap: 1 }));

  let tab: Tab = "chat";
  let mode: Mode = "navigate";
  let detail: Detail = null;
  let selected = 0;
  let busy = false;
  let refreshing = false;
  let quitting = false;
  let sendMode: SendMode = "follow-up";
  let insertAction: "send" | "edit-chat" | "agent-chat" | "resume" = "send";
  let view = await project.view();
  const folds = new Set<string>();
  const expandedActivity = new Set<string>();
  let resolveExit: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const redraw = async (): Promise<void> => {
    view = await project.view();

    header.setText(renderHeader(project.root, tab, mode, sendMode, detail));
    status.setText(renderStatus(view, busy));
    content.setText(renderTab(view, tab, selected, folds, expandedActivity, detail));
    tui.requestRender();
  };

  const quit = (): void => {
    if (quitting) return;
    quitting = true;
    tui.stop();
    resolveExit?.();
  };

  const work = async (task: () => Promise<void>): Promise<void> => {
    if (busy) {
      tui.flash("Carto is already applying a local action.");
      return;
    }
    busy = true;
    try {
      await task();
    } catch (error) {
      tui.flash(error instanceof Error ? error.message : String(error), 5_000);
    } finally {
      busy = false;
      await redraw();
    }
  };

  const submit = async (text: string): Promise<void> => {
    const value = text.trim();
    if (value === "") return;
    editor.setText("");
    editor.addToHistory(value);
    const action = insertAction;
    insertAction = "send";
    mode = "navigate";
    tui.setFocus(null);
    if (action === "edit-chat") {
      const entry = selectedChat(view, selected);
      if (entry !== undefined) await work(() => project.editChat(entry.id, value));
      detail = null;
      return;
    }
    if (action === "agent-chat") {
      await work(() => project.addAgentChat(value));
      return;
    }
    if (action === "resume") {
      await work(() => project.resumeTurn(value));
      return;
    }
    let command: UiCommand | undefined;
    try {
      command = parseCommand(value);
    } catch (error) {
      tui.flash(error instanceof Error ? error.message : String(error), 5_000);
      return;
    }
    if (command !== undefined) {
      await work(() => runCommand(project, command));
      return;
    }
    await work(() => project.send(value, sendMode));
  };
  editor.onSubmit = (text) => void submit(text);
  const enterInsert = (seed = "", action: "send" | "edit-chat" | "agent-chat" | "resume" = "send"): void => {
    mode = "insert";
    insertAction = action;
    editor.setText(seed);
    tui.setFocus(editor);
    void redraw();
  };
  const navigate = (): void => {
    mode = "navigate";
    tui.setFocus(null);
    void redraw();
  };
  const actions = (): void => {
    detail = detail === "actions" ? null : "actions";
    void redraw();
  };

  const signalHandler = (): void => quit();
  process.once("SIGINT", signalHandler);
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      quit();
      return { consume: true };
    }
    if (mode === "insert") {
      if (matchesKey(data, Key.escape)) {
        navigate();
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, Key.escape)) {
      detail = null;
      navigate();
      return { consume: true };
    }
    if (matchesKey(data, Key.backspace)) {
      if (detail !== null) detail = null;
      else selected = 0;
      void redraw();
      return { consume: true };
    }
    if (data === "1") return switchTab("chat");
    if (data === "2") return switchTab("brain");
    if (data === "3") return switchTab("context");
    if (data === "j" || matchesKey(data, Key.down)) {
      selected += 1;
      void redraw();
      return { consume: true };
    }
    if (data === "k" || matchesKey(data, Key.up)) {
      selected = Math.max(0, selected - 1);
      void redraw();
      return { consume: true };
    }
    if (data === "g" || matchesKey(data, Key.home)) {
      selected = 0;
      void redraw();
      return { consume: true };
    }
    if (data === "G" || matchesKey(data, Key.end)) {
      selected = 9999;
      void redraw();
      return { consume: true };
    }
    if (data === "i" || matchesKey(data, Key.enter)) {
      if (tab === "chat" && selectedChat(view, selected) !== undefined && detail === "chat") {
        enterInsert(selectedChat(view, selected)!.text, "edit-chat");
      } else {
        enterInsert();
      }
      return { consume: true };
    }
    if (data === "a") {
      actions();
      return { consume: true };
    }
    if (data === "?") {
      detail = detail === "help" ? null : "help";
      void redraw();
      return { consume: true };
    }
    if (data === "f" && tab === "chat") {
      const entry = selectedChat(view, selected);
      if (entry !== undefined) {
        if (folds.has(entry.id)) folds.delete(entry.id);
        else folds.add(entry.id);
        void redraw();
      }
      return { consume: true };
    }
    if (data === "e" && tab === "chat") {
      if (selectedChat(view, selected) !== undefined) {
        detail = "chat";
        void redraw();
      }
      return { consume: true };
    }
    if (data === "o" && tab === "chat") {
      const item = selectedActivity(view, selected);
      if (item !== undefined) {
        if (expandedActivity.has(item.id)) expandedActivity.delete(item.id);
        else expandedActivity.add(item.id);
        void redraw();
      }
      return { consume: true };
    }
    if (data === "A" && tab === "chat") {
      enterInsert("", "agent-chat");
      return { consume: true };
    }
    if ((data === "d" || data === "D") && tab === "chat") {
      const entry = selectedChat(view, selected);
      const handle = entry === undefined ? undefined : handleOf(view.brain.handles, "chat", entry.id);
      if (handle !== undefined) {
        void work(() => (data === "D" ? project.deleteHandleNow(handle) : project.markHandleForDeletion(handle)));
      }
      return { consume: true };
    }
    if ((data === "u" || data === "U") && tab === "context") {
      const pin = selectedPin(view, selected);
      const handle = pin === undefined ? undefined : handleOf(view.brain.handles, "pin", pin.id);
      if (handle !== undefined) {
        void work(() => (data === "U" ? project.removePinHandleNow(handle) : project.removePinHandleAtCollapse(handle)));
      }
      return { consume: true };
    }
    if (data === "p") {
      void work(() => project.pauseTurn());
      return { consume: true };
    }
    if (data === "r") {
      if (view.turn.state === "paused") enterInsert(view.turn.pausedDraft ?? "", "resume");
      else void work(() => project.continueTurn());
      return { consume: true };
    }
    if (data === "x") {
      void work(() => project.cancelTurn());
      return { consume: true };
    }
    if (data === "I") {
      sendMode = "interruption";
      enterInsert();
      return { consume: true };
    }
    if (data === "S") {
      sendMode = "steer";
      enterInsert();
      return { consume: true };
    }
    if (data === "F") {
      sendMode = "follow-up";
      enterInsert();
      return { consume: true };
    }
    return undefined;

    function switchTab(next: Tab): { consume: true } {
      tab = next;
      selected = 0;
      detail = null;
      void redraw();
      return { consume: true };
    }
  });

  const refreshTimer = setInterval(() => {
    if (busy || refreshing || quitting) return;
    refreshing = true;
    void project
      .refreshEvidence()
      .then(redraw)
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }, 500);
  refreshTimer.unref();

  await redraw();
  tui.setFocus(null);
  tui.start();
  await exit;
  clearInterval(refreshTimer);
  process.off("SIGINT", signalHandler);
}

function editorTheme() {
  return {
    borderColor: muted,
    selectList: {
      selectedPrefix: accent,
      selectedText: accent,
      description: muted,
      scrollInfo: muted,
      noMatch: muted,
    },
  };
}

function renderHeader(root: string, tab: Tab, mode: Mode, sendMode: SendMode, detail: Detail): string {
  const tabs = (["chat", "brain", "context"] as const)
    .map((item, index) => (item === tab ? accent(`${index + 1} ${title(item)}`) : muted(`${index + 1} ${title(item)}`)))
    .join("  ");
  const side = detail === null ? `${mode} · send ${sendMode}` : `detail: ${detail}`;
  return `${accent("Carto")}  ${tabs}  ${muted(side)}\n${muted(root)}`;
}

function renderStatus(view: ProjectView, busy: boolean): string {
  if (busy || view.turn.state === "cancelling") return warning("● Applying local action.");
  if (view.turn.state === "running") return warning(`● Agent active · ${view.turn.queued.length} queued · p pause · x cancel · I/S/F send mode`);
  if (view.turn.state === "paused") return warning("● Turn paused. r edits/resumes the continuation; x cancels it.");
  if (view.brain.activity.kind === "waiting-for-collapse") return warning("● Collapse requested. Open actions with a, then confirm or cancel.");
  if (view.brain.activity.kind === "error") return danger(`● ${view.brain.activity.detail ?? "Unknown error"}`);
  return muted("● Navigate · i input · a actions · ? help · Esc navigate · Backspace close");
}

function renderTab(view: ProjectView, tab: Tab, selected: number, folds: ReadonlySet<string>, expandedActivity: ReadonlySet<string>, detail: Detail): string {
  const body = tab === "chat" ? renderChat(view, selected, folds, expandedActivity) : tab === "brain" ? renderBrain(view, selected) : renderContext(view, selected);
  if (detail === "help") return `${body}\n\n${renderHelp()}`;
  if (detail === "actions") return `${body}\n\n${renderActions(view)}`;
  if (detail === "chat") return `${body}\n\n${warning("Chat edit selected: press i to replace its text. Use a for Delete at collapse or Delete now.")}`;
  return body;
}

function renderChat(view: ProjectView, selected: number, folds: ReadonlySet<string>, expandedActivity: ReadonlySet<string>): string {
  const lines: string[] = [accent("Chat · durable Person Chat and Agent Chat")];
  const chat = visibleChat(view.brain);
  if (chat.length === 0) lines.push(muted("No deliberate Chat records. Press i to write."));
  chat.forEach((entry, index) => {
    const marker = index === clamp(selected, chat.length) ? accent("›") : " ";
    const who = entry.author === "user" ? personStyle("Person") : agentStyle("Agent");
    const handle = handleOf(view.brain.handles, "chat", entry.id) ?? "C";
    // Chat is expanded by default. The person can fold it with f.
    lines.push(`${marker} ${accent(handle)} ${who} ${muted(stamp(entry.createdAt))}`);
    if (folds.has(entry.id)) lines.push(muted(`  ${preview(entry.text)}`));
    else lines.push(`  ${entry.text}`);
  });
  lines.push("");
  lines.push(accent("Live disclosure"));
  if (view.activity.length === 0) lines.push(muted("No streamed model or tool activity."));
  for (const [activityIndex, item] of view.activity.entries()) {
    const expanded = expandedActivity.has(item.id);
    const selectedActivityRow = selected === chat.length + activityIndex;
    lines.push(`${selectedActivityRow ? accent("›") : " "} ${renderActivity(item)}`);
    for (const line of disclosureLines(item, 5, expanded)) lines.push(`  ${styleActivity(item.kind, line)}`);
    if (!expanded && (item.completed || item.streaming)) {
      lines.push(muted(item.streaming ? "  newest five rows · o expands upward" : "  one-line completed summary · o expands"));
    }
  }
  return lines.join("\n");
}

function renderBrain(view: ProjectView, selected: number): string {
  const lines: string[] = [accent("Brain · safe durable operations")];
  const rows: Array<{ label: string; text: string }> = [];
  for (const entry of visibleLedger(view.brain)) {
    rows.push({ label: `Ledger ${handleOf(view.brain.handles, "ledger", entry.id) ?? ""}`.trim(), text: `${entry.kind} · ${entry.status} · ${entry.text}` });
  }
  for (const entry of visibleAtlas(view.brain)) {
    rows.push({ label: `Atlas ${handleOf(view.brain.handles, "atlas", entry.id) ?? ""}`.trim(), text: `${entry.title}: ${entry.claim}` });
  }
  for (const change of view.brain.changes) {
    rows.push({ label: `Change ${handleOf(view.brain.handles, "change", change.id) ?? ""}`.trim(), text: `${change.status}: ${change.rationale}` });
  }
  for (const wake of view.brain.wakes) {
    rows.push({ label: `Wake ${handleOf(view.brain.handles, "wake", wake.id) ?? ""}`.trim(), text: `${wake.status}: ${wake.reason}` });
  }
  if (rows.length === 0) lines.push(muted("No Ledger, Atlas, change, or wake records."));
  rows.forEach((row, index) => lines.push(`${index === clamp(selected, rows.length) ? accent("›") : " "} ${accent(row.label)}  ${row.text}`));
  lines.push("");
  lines.push(muted("Use a for collapse and change actions. Deletion marks stay visible until collapse."));
  for (const mark of view.brain.deletionMarks) {
    const handle = handleOf(view.brain.handles, "deletion", deletionHandleId(mark)) ?? "D";
    lines.push(warning(`Deferred ${handle}: ${mark.target} · ${stamp(mark.markedAt)}`));
  }
  return lines.join("\n");
}

function renderContext(view: ProjectView, selected: number): string {
  const lines = [accent("Context · fresh generation-local handles"), muted(`Budget ${view.context.estimatedTokens}/${view.context.budget} tokens`)];
  view.context.blocks.forEach((block, index) => {
    lines.push(`${selected === index ? accent("›") : " "} ${accent(block.handle)} ${block.section} · ${block.reason}`);
    lines.push(muted(`  ${preview(block.text)}`));
  });
  for (const omission of view.context.omissions) lines.push(warning(`Omitted ${omission.label}: ${omission.reason}`));
  const pins = allPins(view);
  lines.push("");
  lines.push(accent("Pins and archive"));
  if (view.brain.context.archiveGeneration !== null) lines.push(warning("Archive expires at the next collapse unless the person keeps an item."));
  if (pins.length === 0) lines.push(muted("No pins. Use /pin or /pin-file in input."));
  for (const [index, pin] of pins.entries()) {
    const row = view.context.blocks.length + index;
    const handle = handleOf(view.brain.handles, "pin", pin.id) ?? "P";
    lines.push(`${selected === row ? accent("›") : " "} ${accent(handle)} ${pin.item} · ${pin.reason} · ${pin.source.freshness}`);
  }
  return lines.join("\n");
}

function renderHelp(): string {
  return [
    accent("Controls"),
    "Navigate: Esc, 1/2/3 tabs, j/k move, g/G start/end, Backspace closes detail.",
    "Insert: i opens input. Esc returns to Navigate. Enter sends with the selected mode.",
    "Turns: p pause, r resume or start work, x cancel, I interruption, S steer, F follow-up.",
    "Chat: f folds or unfolds a Chat item; e opens edit detail; i replaces it when edit detail is open; A adds Agent Chat.",
    "Context: select a pin, then u removes it at collapse or U removes it now. o expands a raw activity disclosure.",
    "Commands use short handles only: /delete C2, /delete-now L1, /unpin P3, /approve X1, /cancel-wake W1.",
    "All raw model text, reasoning, tool calls, and tool output stay in Live disclosure. Completed items fold to one line.",
  ].join("\n");
}

function renderActions(view: ProjectView): string {
  const lines = [accent("Actions"), "Collapse: /collapse, /confirm-collapse, or /cancel-collapse."];
  lines.push("Delete: /delete HANDLE, /delete-now HANDLE, /undelete HANDLE. A handle is L#, C#, A#, or P#.");
  lines.push("Pins: /pin ITEM | REASON; /pin-file path:start-end | ITEM | REASON; /unpin P#; /unpin-now P#.");
  lines.push("Brain: /ledger [L#] | goal|note|question | open|answered|closed | TEXT [| ANSWER].");
  lines.push("Atlas: /atlas [A#] | TITLE | CLAIM | path:start-end [| link-handle,link-handle].");
  lines.push("Handoff: /handoff INTENT | NEXT ACTION [| NOTE], or /clear-handoff.");
  lines.push("Wake: /wake [W#] | time|path | CONDITION | REASON; /cancel-wake W# [| REASON].");
  lines.push("Change: /approve X# or /reject X#.");
  if (view.turn.state === "paused") lines.push("Paused draft is ready: press r and edit it.");
  return lines.join("\n");
}

function renderActivity(item: LiveActivity): string {
  return `${styleActivity(item.kind, item.label)} ${item.streaming ? warning("streaming") : muted("complete")}`;
}

function styleActivity(kind: LiveActivity["kind"], text: string): string {
  switch (kind) {
    case "reasoning":
      return reasoningStyle(text);
    case "model":
      return agentStyle(text);
    case "tool-call":
      return toolStyle(text);
    case "tool-output":
      return muted(text);
    case "warning":
      return warning(text);
    case "error":
      return danger(text);
  }
}

export type UiCommand =
  | { kind: "collapse" }
  | { kind: "confirm-collapse" }
  | { kind: "cancel-collapse" }
  | { kind: "refresh" }
  | { kind: "delete"; handle: string; now: boolean }
  | { kind: "undelete"; handle: string }
  | { kind: "unpin"; handle: string; now: boolean }
  | { kind: "pin"; item: string; reason: string }
  | { kind: "pin-file"; path: string; startLine: number; endLine: number; item: string; reason: string }
  | { kind: "agent-chat"; text: string }
  | { kind: "ledger"; handle: string | null; kindName: "goal" | "note" | "question"; status: "open" | "answered" | "closed"; text: string; answer: string | null; evidence: string[] }
  | { kind: "atlas"; handle: string | null; title: string; claim: string; path: string; startLine: number; endLine: number; links: string[] }
  | { kind: "handoff"; intent: string; nextAction: string; note: string }
  | { kind: "clear-handoff" }
  | { kind: "wake"; handle: string | null; wakeKind: "time" | "path"; condition: string; reason: string }
  | { kind: "cancel-wake"; handle: string; reason: string }
  | { kind: "approve" | "reject"; handle: string };

function isHandle(value: string): boolean {
  return /^[LCAPHWXD]\d+$/i.test(value.trim());
}

export function parseCommand(text: string): UiCommand | undefined {
  if (!text.startsWith("/")) return undefined;
  const [name, rest] = splitFirst(text.slice(1).trim());
  if (name === "collapse" && rest === "") return { kind: "collapse" };
  if (name === "confirm-collapse" && rest === "") return { kind: "confirm-collapse" };
  if (name === "cancel-collapse" && rest === "") return { kind: "cancel-collapse" };
  if (name === "refresh" && rest === "") return { kind: "refresh" };
  if (name === "clear-handoff" && rest === "") return { kind: "clear-handoff" };
  if ((name === "approve" || name === "reject") && isHandle(rest)) return { kind: name, handle: rest };
  if ((name === "delete" || name === "delete-now") && isHandle(rest)) return { kind: "delete", handle: rest, now: name === "delete-now" };
  if (name === "undelete" && isHandle(rest)) return { kind: "undelete", handle: rest };
  if ((name === "unpin" || name === "unpin-now") && isHandle(rest)) return { kind: "unpin", handle: rest, now: name === "unpin-now" };
  if (name === "agent-chat" && rest !== "") return { kind: "agent-chat", text: rest };
  if (name === "pin") {
    const [item, reason] = splitBars(rest, 2) ?? [];
    if (item !== undefined && reason !== undefined) return { kind: "pin", item, reason };
  }
  if (name === "pin-file") {
    const [range, item, reason] = splitBars(rest, 3) ?? [];
    const parsed = range === undefined ? undefined : parseLineRange(range);
    if (parsed !== undefined && item !== undefined && reason !== undefined) return { kind: "pin-file", ...parsed, item, reason };
  }
  if (name === "ledger") {
    const parts = splitParts(rest);
    const handle = isHandle(parts[0] ?? "") ? (parts.shift() as string) : null;
    const [kindName, status, value, answer] = parts;
    if (
      (kindName === "goal" || kindName === "note" || kindName === "question") &&
      (status === "open" || status === "answered" || status === "closed") &&
      value !== undefined
    ) {
      return { kind: "ledger", handle, kindName, status, text: value, answer: answer ?? null, evidence: [] };
    }
    throw new Error("Use /ledger [L#] | goal|note|question | open|answered|closed | TEXT [| ANSWER].");
  }
  if (name === "atlas") {
    const parts = splitParts(rest);
    const handle = isHandle(parts[0] ?? "") ? (parts.shift() as string) : null;
    const [title, claim, range, links] = parts;
    const parsed = range === undefined ? undefined : parseLineRange(range);
    if (title !== undefined && claim !== undefined && parsed !== undefined) {
      return { kind: "atlas", handle, title, claim, ...parsed, links: links === undefined ? [] : links.split(",").map((link) => link.trim()).filter(Boolean) };
    }
    throw new Error("Use /atlas [A#] | TITLE | CLAIM | path:start-end [| link-handle,link-handle].");
  }
  if (name === "handoff") {
    const [intent, nextAction, note] = splitBars(rest, 3) ?? [];
    if (intent !== undefined && nextAction !== undefined) return { kind: "handoff", intent, nextAction, note: note ?? "" };
  }
  if (name === "wake") {
    const parts = splitParts(rest);
    const handle = isHandle(parts[0] ?? "") && (parts[0] ?? "") !== "time" && (parts[0] ?? "") !== "path" ? (parts.shift() as string) : null;
    const [wakeKind, condition, reason] = parts;
    if (wakeKind !== "time" && wakeKind !== "path") {
      throw new Error("A wake needs the kind time or path: /wake [W#] | time|path | CONDITION | REASON.");
    }
    if (condition === undefined) {
      throw new Error("A wake needs a condition: /wake [W#] | time|path | CONDITION | REASON.");
    }
    return { kind: "wake", handle, wakeKind, condition, reason: reason ?? "The person armed this wake." };
  }
  if (name === "cancel-wake") {
    const [handle, reason] = splitBars(rest, 2) ?? [];
    if (handle !== undefined && isHandle(handle)) return { kind: "cancel-wake", handle, reason: reason ?? "The person cancelled this wake." };
  }
  throw new Error(`Unknown or incomplete command: /${name}. Press ? for controls.`);
}

async function runCommand(project: CartoProject, command: UiCommand): Promise<void> {
  switch (command.kind) {
    case "collapse":
      return project.requestCollapse();
    case "confirm-collapse":
      return project.confirmCollapse();
    case "cancel-collapse":
      return project.cancelCollapse();
    case "refresh":
      return project.refreshEvidence();
    case "delete":
      if (command.now) return project.deleteHandleNow(command.handle);
      return project.markHandleForDeletion(command.handle);
    case "undelete":
      return project.undeleteHandle(command.handle);
    case "unpin":
      if (command.now) return project.removePinHandleNow(command.handle);
      return project.removePinHandleAtCollapse(command.handle);
    case "pin":
      return project.addUserContextPin(command.item, command.reason);
    case "pin-file":
      return project.addUserFilePin(command.item, command.reason, command.path, command.startLine, command.endLine);
    case "agent-chat":
      return project.addAgentChat(command.text);
    case "ledger": {
      const previous = command.handle === null ? undefined : await project.resolveTarget(command.handle, ["ledger"]);
      return project.upsertLedger({
        id: previous?.id ?? `ledger:person:${globalThis.crypto.randomUUID()}`,
        kind: command.kindName,
        status: command.status,
        text: command.text,
        answer: command.answer === null ? null : { text: command.answer, evidenceIds: await project.resolveIds(command.evidence, "ledger") },
      });
    }
    case "atlas": {
      const previous = command.handle === null ? undefined : await project.resolveTarget(command.handle, ["atlas"]);
      return project.upsertAtlasFromFile({
        id: previous?.id ?? `atlas:person:${globalThis.crypto.randomUUID()}`,
        title: command.title,
        claim: command.claim,
        path: command.path,
        startLine: command.startLine,
        endLine: command.endLine,
        links: await project.resolveIds(command.links, undefined),
      });
    }
    case "handoff":
      return project.setHandoff({
        intent: command.intent,
        activeLedgerIds: [],
        openQuestionIds: [],
        relevantAtlasIds: [],
        nextAction: command.nextAction,
        note: command.note,
      });
    case "clear-handoff":
      return project.setHandoff(null);
    case "wake": {
      const previous = command.handle === null ? undefined : await project.resolveTarget(command.handle, ["wake"]);
      return project.armWake({ id: previous?.id ?? `wake:person:${globalThis.crypto.randomUUID()}`, kind: command.wakeKind, condition: command.condition, reason: command.reason });
    }
    case "cancel-wake": {
      const target = await project.resolveTarget(command.handle, ["wake"]);
      return project.cancelWake(target.id, command.reason);
    }
    case "approve":
    case "reject": {
      const target = await project.resolveTarget(command.handle, ["change"]);
      return command.kind === "approve" ? project.approveChange(target.id) : project.rejectChange(target.id);
    }
  }
}

function splitFirst(text: string): [string, string] {
  const index = text.search(/\s/);
  return index === -1 ? [text, ""] : [text.slice(0, index), text.slice(index).trim()];
}

function splitParts(text: string): string[] {
  return text.split("|").map((part) => part.trim()).filter((part) => part !== "");
}

function splitBars(text: string, minimum: number): string[] | undefined {
  const parts = text.split("|").map((part) => part.trim());
  return parts.length >= minimum - 1 && parts.every((part) => part !== "") ? parts : undefined;
}

function parseLineRange(value: string): { path: string; startLine: number; endLine: number } | undefined {
  const match = /^(.*):(\d+)-(\d+)$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined;
  const startLine = Number(match[2]);
  const endLine = Number(match[3]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) return undefined;
  return { path: match[1], startLine, endLine };
}

function selectedChat(view: ProjectView, selected: number) {
  return visibleChat(view.brain)[selected];
}

function selectedActivity(view: ProjectView, selected: number): LiveActivity | undefined {
  return view.activity[selected - visibleChat(view.brain).length];
}

function allPins(view: ProjectView) {
  return [...view.brain.userPins, ...mergeCarryPins(view.liveCarryPins, view.brain.carryPins)];
}

function selectedPin(view: ProjectView, selected: number) {
  return allPins(view)[selected - view.context.blocks.length];
}

function visualRows(text: string, columns: number): string[] {
  const width = Math.max(12, columns);
  const rows: string[] = [];
  for (const logical of text.split("\n")) {
    if (logical === "") {
      rows.push("");
      continue;
    }
    for (let start = 0; start < logical.length; start += width) rows.push(logical.slice(start, start + width));
  }
  return rows.length === 0 ? [""] : rows;
}

function summaryLine(lines: readonly string[]): string {
  const value = lines.find((line) => line.trim() !== "") ?? "";
  return value.length <= 160 ? value : `${value.slice(0, 157)}…`;
}

function clamp(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}

function title(tab: Tab): string {
  return tab === "chat" ? "Chat" : tab === "brain" ? "Brain" : "Context";
}

function stamp(value: number): string {
  return new Date(value).toISOString();
}

function preview(value: string): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}…`;
}

// Keep Component in the import surface for host extensions that type-check UI adapters.
void (null as Component | null);
