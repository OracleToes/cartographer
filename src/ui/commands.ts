import type { CartoProject } from "../runtime/project.js";

/**
 * Person commands: the compact way to do what the agent's tools do.
 *
 * A command names a record by its short generation-local handle and never by a
 * private storage ID, so a person types what the screen shows. The parser is
 * pure and strict: an unknown or incomplete command is an error, never a
 * fallback.
 */

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

export async function runCommand(project: CartoProject, command: UiCommand): Promise<void> {
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

