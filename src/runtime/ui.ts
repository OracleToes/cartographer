import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  styleText,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";

import { visibleAtlas, visibleChat, visibleLedger } from "../domain/brain.js";
import { mergeCarryPins } from "../domain/context.js";
import type { ProjectView, MiniProject } from "./project.js";

const colorMode = "truecolor" as const;
const accent = (text: string) => styleText(text, { fg: { kind: "rgb", r: 106, g: 227, b: 183 }, bold: true }, colorMode);
const muted = (text: string) => styleText(text, { fg: { kind: "rgb", r: 142, g: 153, b: 172 } }, colorMode);
const warning = (text: string) => styleText(text, { fg: { kind: "rgb", r: 246, g: 185, b: 92 }, bold: true }, colorMode);
const danger = (text: string) => styleText(text, { fg: { kind: "rgb", r: 245, g: 126, b: 126 }, bold: true }, colorMode);

export async function runMiniUi(project: MiniProject): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("carto needs an interactive terminal for the Shared Brain UI.");
  }

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });
  const header = new Text();
  const status = new Text();
  const brain = new Text();
  const editor = new Editor(tui, editorTheme());
  const scroll = new ScrollView(brain, { primary: true, follow: "end", scrollbar: "auto" });
  tui.setLayoutRoot(new VStack([header, status, { component: scroll, grow: 1 }, editor], { gap: 1 }));

  let busy = false;
  let refreshing = false;
  let quitting = false;
  let resolveExit: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let view = await project.view();

  const redraw = async (): Promise<void> => {
    view = await project.view();
    header.setText(renderHeader(project.root, view));
    status.setText(renderStatus(view, busy));
    brain.setText(renderBrain(view));
    tui.requestRender();
  };

  const quit = (): void => {
    if (quitting) return;
    quitting = true;
    tui.stop();
    resolveExit?.();
  };

  const withBusy = async (work: () => Promise<void>): Promise<void> => {
    if (busy) {
      tui.flash("Mini is still working.");
      return;
    }
    busy = true;
    editor.disableSubmit = true;
    try {
      await redraw();
      await work();
    } catch (error) {
      tui.flash(error instanceof Error ? error.message : String(error), 5_000);
    } finally {
      busy = false;
      editor.disableSubmit = false;
      await redraw();
    }
  };

  const submit = async (text: string): Promise<void> => {
    const value = text.trim();
    if (value === "") return;
    editor.setText("");
    editor.addToHistory(value);
    const command = parseCommand(value);
    if (command === undefined) {
      await withBusy(async () => {
        await project.sendUserMessage(value);
      });
      return;
    }
    if (command.kind === "quit") {
      quit();
      return;
    }
    if (command.kind === "help") {
      tui.flash(helpText(), 7_000);
      return;
    }
    await withBusy(async () => {
      switch (command.kind) {
        case "collapse":
          await project.requestCollapse();
          return;
        case "confirm-collapse":
          await project.confirmCollapse();
          return;
        case "cancel-collapse":
          await project.cancelCollapse();
          return;
        case "refresh":
          await project.refreshEvidence();
          return;
        case "pin":
          await project.addUserContextPin(command.item, command.reason);
          return;
        case "pin-file":
          await project.addUserFilePin(command.item, command.reason, command.path, command.startLine, command.endLine);
          return;
        case "unpin":
          await project.removeUserPin(command.id);
          return;
        case "delete":
          await project.markForDeletion(command.target, command.id);
          return;
        case "undo-delete":
          await project.cancelDeletion(command.target, command.id);
          return;
        case "approve":
          await project.approveChange(command.id);
          return;
        case "reject":
          await project.rejectChange(command.id);
          return;
        default:
          return assertNever(command);
      }
    });
  };

  editor.onSubmit = (text) => {
    void submit(text).catch((error: unknown) => {
      tui.flash(error instanceof Error ? error.message : String(error), 5_000);
    });
  };

  const signalHandler = (): void => quit();
  process.once("SIGINT", signalHandler);
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      quit();
      return { consume: true };
    }
    return undefined;
  });

  const refreshTimer = setInterval(() => {
    if (busy || refreshing || quitting) return;
    refreshing = true;
    void project
      .refreshEvidence()
      .then(async () => {
        if (!quitting) await redraw();
      })
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }, 2_000);
  refreshTimer.unref();

  await redraw();
  tui.setFocus(editor);
  tui.start();
  await exit;
  clearInterval(refreshTimer);
  process.off("SIGINT", signalHandler);
}

type UiCommand =
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "collapse" }
  | { kind: "confirm-collapse" }
  | { kind: "cancel-collapse" }
  | { kind: "refresh" }
  | { kind: "pin"; item: string; reason: string }
  | { kind: "pin-file"; path: string; startLine: number; endLine: number; item: string; reason: string }
  | { kind: "unpin"; id: string }
  | { kind: "delete"; target: "chat" | "atlas" | "ledger"; id: string }
  | { kind: "undo-delete"; target: "chat" | "atlas" | "ledger"; id: string }
  | { kind: "approve"; id: string }
  | { kind: "reject"; id: string };

function parseCommand(text: string): UiCommand | undefined {
  if (!text.startsWith("/")) return undefined;
  const [name, rest = ""] = splitFirst(text.slice(1).trim());
  if (name === "quit" || name === "exit") return { kind: "quit" };
  if (name === "help") return { kind: "help" };
  if (name === "collapse") return { kind: "collapse" };
  if (name === "confirm-collapse") return { kind: "confirm-collapse" };
  if (name === "cancel-collapse") return { kind: "cancel-collapse" };
  if (name === "refresh") return { kind: "refresh" };
  if (name === "unpin" && rest !== "") return { kind: "unpin", id: rest };
  if ((name === "approve" || name === "reject") && rest !== "") return { kind: name, id: rest };
  if ((name === "delete" || name === "undo-delete") && rest !== "") {
    const [target, id] = splitFirst(rest);
    if ((target === "chat" || target === "atlas" || target === "ledger") && id !== "") {
      return { kind: name, target, id };
    }
  }
  if (name === "pin") {
    const parts = splitBars(rest, 2);
    const [item, reason] = parts ?? [];
    if (item !== undefined && reason !== undefined) return { kind: "pin", item, reason };
  }
  if (name === "pin-file") {
    const parts = splitBars(rest, 3);
    const [range, item, reason] = parts ?? [];
    if (range !== undefined && item !== undefined && reason !== undefined) {
      const source = parseLineRange(range);
      if (source !== undefined) {
        return { kind: "pin-file", ...source, item, reason };
      }
    }
  }
  throw new Error(`Unknown or incomplete command: /${name}. Run /help.`);
}

function splitFirst(text: string): [string, string] {
  const index = text.search(/\s/);
  return index === -1 ? [text, ""] : [text.slice(0, index), text.slice(index).trim()];
}

function splitBars(text: string, count: number): string[] | undefined {
  const parts = text.split("|").map((part) => part.trim());
  return parts.length === count && parts.every((part) => part !== "") ? parts : undefined;
}

function parseLineRange(value: string): { path: string; startLine: number; endLine: number } | undefined {
  const match = /^(.*):(\d+)-(\d+)$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined;
  const startLine = Number(match[2]);
  const endLine = Number(match[3]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) return undefined;
  return { path: match[1], startLine, endLine };
}

function helpText(): string {
  return [
    "/collapse, /confirm-collapse, /cancel-collapse, /refresh, /quit",
    "/pin item | reason",
    "/pin-file path:start-end | item | reason",
    "/unpin id, /delete chat|atlas|ledger id, /undo-delete chat|atlas|ledger id",
    "/approve change-id, /reject change-id",
  ].join("\n");
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

function renderHeader(root: string, view: ProjectView): string {
  const mode = view.brain.activity.kind === "waiting-for-collapse" ? warning("collapse requested") : muted("Shared Brain");
  return `${accent("Cartographer Mini")}  ${mode}\n${muted(root)}`;
}

function renderStatus(view: ProjectView, busy: boolean): string {
  if (busy || view.brain.activity.kind === "thinking") return warning("● Working. The agent writes deliberate records through tools.");
  if (view.brain.activity.kind === "waiting-for-collapse") {
    return warning("● Collapse requested. Run /confirm-collapse to rotate, or /cancel-collapse to continue.");
  }
  if (view.brain.activity.kind === "applying-change") return warning(`● Applying ${view.brain.activity.detail ?? "approved change"}.`);
  if (view.brain.activity.kind === "woken") return warning(`● Wake ready: ${view.brain.activity.detail ?? "wake"}.`);
  if (view.brain.activity.kind === "sleeping") return muted("● Sleeping. A message or wake can resume work.");
  if (view.brain.activity.kind === "error") return danger(`● ${view.brain.activity.detail ?? "Unknown error"}`);
  return muted("● Ready  ·  /help for commands  ·  Ctrl-C to exit");
}

function renderBrain(view: ProjectView): string {
  const { brain } = view;
  const lines: string[] = [];
  lines.push(accent("Chat"));
  const chat = visibleChat(brain).slice(-8);
  if (chat.length === 0) lines.push(muted("No chat yet."));
  for (const entry of chat) {
    const who = entry.author === "user" ? "You" : "Mini";
    lines.push(`${accent(`${who}:`)} ${entry.text}`);
  }

  lines.push("");
  lines.push(accent("Atlas"));
  const atlas = visibleAtlas(brain);
  if (atlas.length === 0) lines.push(muted("No Atlas records."));
  for (const entry of atlas.slice(-6)) lines.push(`• ${entry.id}  ${entry.title}: ${entry.claim}`);

  lines.push("");
  lines.push(accent("Ledger"));
  const ledger = visibleLedger(brain);
  if (ledger.length === 0) lines.push(muted("No Ledger records."));
  for (const entry of ledger.slice(-6)) lines.push(`• ${entry.id}  ${entry.kind}: ${entry.text} (${entry.status})`);

  lines.push("");
  lines.push(accent("Context engineering"));
  lines.push(`Live: ${shortGeneration(brain.context.liveGeneration)}  Archive: ${shortGeneration(brain.context.archiveGeneration)}`);
  if (brain.context.archiveGeneration !== null) lines.push(warning("This archive will be deleted at the next collapse unless you pin an item."));
  const carryPins = mergeCarryPins(view.liveCarryPins, brain.carryPins);
  if (brain.userPins.length === 0 && carryPins.length === 0) lines.push(muted("No pins."));
  for (const pin of [...brain.userPins, ...carryPins]) {
    lines.push(`• ${pin.id}  ${pin.item} — ${pin.reason} (${pin.source.freshness})`);
  }
  if (brain.handoff !== null) lines.push(`Handoff: ${brain.handoff.intent} → ${brain.handoff.nextAction}`);

  lines.push("");
  lines.push(accent("Context plan"));
  lines.push(`Budget: ${view.context.estimatedTokens}/${view.context.budget} tokens`);
  for (const block of view.context.blocks.slice(0, 8)) {
    lines.push(`• ${block.section} · ${block.reason} · ~${block.estimatedTokens} tokens${block.required ? " · required" : ""}`);
    lines.push(muted(`  ${preview(block.text)}`));
  }
  if (view.context.blocks.length > 8) lines.push(muted(`… ${view.context.blocks.length - 8} more included block(s).`));
  for (const omission of view.context.omissions.slice(0, 6)) lines.push(warning(`Omitted ${omission.id}: ${omission.reason}`));

  lines.push("");
  lines.push(accent("Changes and wakes"));
  if (brain.changes.length === 0 && brain.wakes.length === 0) lines.push(muted("No change review or wake."));
  for (const change of brain.changes.slice(-5)) {
    lines.push(`• ${change.id}  ${change.status}: ${change.rationale}`);
    if (change.status === "proposed") {
      lines.push(muted(change.patch));
      lines.push(muted(`  /approve ${change.id} or /reject ${change.id}`));
    }
  }
  for (const wake of brain.wakes.slice(-5)) lines.push(`• Wake ${wake.id}: ${wake.status}; ${wake.reason}`);

  const deleted = brain.deletionMarks.length;
  if (deleted > 0) {
    lines.push(warning(`${deleted} record(s) will be permanently deleted at the next confirmed collapse.`));
    for (const mark of brain.deletionMarks) lines.push(muted(`• Marked ${mark.target}:${mark.id}  /undo-delete ${mark.target} ${mark.id}`));
  }
  return lines.join("\n");
}

function shortGeneration(generation: string | null): string {
  return generation === null ? "none" : generation.slice(0, 8);
}

function preview(text: string): string {
  const compact = text.replaceAll(/\s+/g, " ").trim();
  return compact.length <= 150 ? compact : `${compact.slice(0, 147)}…`;
}

function assertNever(value: never): never {
  throw new Error(`Unknown UI command: ${JSON.stringify(value)}`);
}
