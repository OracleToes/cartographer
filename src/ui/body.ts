import type { ChatRecord } from "../domain/types.js";
import type { ContextBlock } from "../domain/context.js";
import { handleOf } from "../domain/handles.js";
import type { ProjectView } from "../runtime/project.js";
import type { LiveActivity } from "../runtime/live-session.js";
import { clock, oneLine, short, width, wrap } from "./text.js";
import { row } from "./chrome.js";
import { token } from "./tokens.js";

/**
 * The body of each tab, as rows.
 *
 * A body renderer is pure: it takes the view, the selection, and the fold
 * state, and it returns strings. That is what makes a snapshot test possible
 * and what keeps the frame clock honest: the only thing that changes between
 * two frames is the value it was given.
 *
 * One mark means one thing everywhere: `▌` is the selection, a handle is
 * always the first thing on a record's row, and a time is always local and
 * short. The full ISO stamp stays in agent context where it belongs.
 */

export interface BodyInput {
  view: ProjectView;
  selected: number;
  folds: ReadonlySet<string>;
  expandedActivity: ReadonlySet<string>;
  columns: number;
  /** The tab whose body this is, so a head can brighten when it holds the selection. */
  tab: "chat" | "brain" | "context";
}

export interface BodyRow {
  text: string;
  /** The selection index this row belongs to, when it can be selected. */
  selectable?: number;
}

export function chatBody(input: BodyInput): BodyRow[] {
  const { view, columns } = input;
  const rows: BodyRow[] = [];
  const chat = view.brain.chat;
  rows.push({ text: head("DURABLE CHAT", String(chat.length), columns, input.tab === "chat") });
  if (chat.length === 0) {
    rows.push(...emptyState(["No deliberate Chat yet.", "Press i to write one."], columns));
  }
  chat.forEach((entry, index) => {
    const selected = index === input.selected;
    rows.push({ text: chatRow(view, entry, selected, input.folds.has(entry.id), columns), selectable: index });
    if (!input.folds.has(entry.id)) {
      // The text aligns under the handle, not under the rail, so a record
      // reads as one block: mark, name, words.
      for (const line of wrap(entry.text, columns - 4)) rows.push({ text: `${rail(selected)}    ${line}`, selectable: index });
    }
  });
  rows.push({ text: "" });
  const live = view.activity.length;
  rows.push({
    text: head(
      "LIVE",
      live === 0 ? "nothing yet" : `${live} ${live === 1 ? "item" : "items"}${view.turn.state === "running" ? " · streaming" : ""}`,
      columns,
      false,
    ),
  });
  if (live === 0) rows.push(...emptyState(["No streamed activity.", "Press i to write, or r to start work."], columns));
  for (const [index, item] of view.activity.entries()) {
    const selected = input.selected === chat.length + index;
    rows.push({ text: activityHead(item, selected, columns), selectable: chat.length + index });
    const expanded = input.expandedActivity.has(item.id);
    const lines = disclosureLines(item, 5, expanded, Math.max(20, columns - 4));
    for (const line of lines) rows.push({ text: `${rail(selected)}    ${styleActivity(item.kind, line)}`, selectable: chat.length + index });
    const hidden = visualRowCount(item.text, Math.max(20, columns - 4)) - lines.length;
    if (!expanded && hidden > 0) {
      rows.push({ text: `${rail(false)}    ${token.faint(`+${hidden} ${hidden === 1 ? "row" : "rows"} · o`)}`, selectable: chat.length + index });
    }
  }
  return rows;
}

export function brainBody(input: BodyInput): BodyRow[] {
  const { view, columns } = input;
  const rows: BodyRow[] = [];
  const records = brainRecords(view);
  rows.push({ text: head("BRAIN", String(records.length), columns, input.tab === "brain") });
  if (records.length === 0) rows.push(...emptyState(["No Ledger, Atlas, or wake records.", "The agent adds them as work agrees."], columns));
  for (const [index, record] of records.entries()) {
    const selected = index === input.selected;
    rows.push({
      text: row(`${rail(selected)} ${token.accent(record.handle)}  ${token.muted(`${record.kind} · ${clock(record.at)}`)}  ${record.title}`, record.detail, columns),
      selectable: index,
    });
    if (record.text !== "") for (const line of wrap(record.text, columns - 4)) rows.push({ text: `${rail(false)}    ${line}`, selectable: index });
  }
  return rows;
}

export function contextBody(input: BodyInput): BodyRow[] {
  const { view, columns } = input;
  const rows: BodyRow[] = [];
  const blocks = view.context.blocks;
  rows.push({ text: head("CONTEXT", `${short(view.context.estimatedTokens)} / ${short(view.context.budget)} tok`, columns, input.tab === "context") });
  for (const [index, block] of blocks.entries()) {
    const selected = index === input.selected;
    // One row per record. The handle is the identity, the text is the value,
    // and the cost sits at the right edge. The handle the agent sees at the
    // start of the text is not printed twice.
    const body = summarizeBlock(view, block, columns);
    // A multi-line block says how much is behind its first line. Without this
    // the `…` is the only cue, and `R1 Carto rules …` reads as a record that
    // happens to be short rather than as eight lines of protocol text.
    const behind = block.text.split("\n").length - 1;
    const more = behind > 0 ? token.faint(` +${behind} ${behind === 1 ? "line" : "lines"}`) : "";
    const cost = token.faint(`${short(block.estimatedTokens)} tok`);
    rows.push({
      text: row(
        `${rail(selected)} ${token.accent(block.handle)}  ${token.muted(sectionLabel(block.section))}  ${body}`,
        more === "" ? cost : `${more} ${cost}`,
        columns,
      ),
      selectable: index,
    });
  }
  if (view.context.omissions.length > 0) {
    rows.push({ text: "" });
    rows.push({ text: head("LEFT OUT", String(view.context.omissions.length), columns, false) });
    for (const omission of view.context.omissions) {
      rows.push({ text: `  ${token.warning(omission.label)}  ${token.muted(omission.reason)}` });
    }
  }
  // Pins are already blocks in the projection, so they are not listed twice.
  const pins = allPins(view);
  if (view.archivePresent) {
    rows.push({ text: "" });
    rows.push({ text: `  ${token.warning("The archive expires at the next collapse unless you pin an item.")}` });
  }
  if (pins.length === 0) {
    rows.push({ text: "" });
    rows.push(...emptyState(["No pins.", "Use /pin or /pin-file in the input."], columns));
  }
  return rows;
}

/** The number of rows a body would have, so the selection can be clamped. */
export function selectableCount(tab: "chat" | "brain" | "context", view: ProjectView): number {
  if (tab === "chat") return view.brain.chat.length + view.activity.length;
  if (tab === "brain") return brainRecords(view).length;
  // Pins are part of the projection, so a pin is selected as a block.
  return view.context.blocks.length;
}

/** A one-line summary of the selected row, for a detail or the header. */
export function selectedLabel(tab: "chat" | "brain" | "context", view: ProjectView, selected: number): string | undefined {
  if (tab === "chat") {
    const chat = view.brain.chat;
    const entry = chat[selected];
    if (entry !== undefined) return `Chat ${handleOf(view.brain.handles, "chat", entry.id) ?? ""}`.trim();
    const activity = view.activity[selected - chat.length];
    return activity === undefined ? undefined : activity.label;
  }
  if (tab === "brain") return brainRecords(view)[selected]?.handle;
  return view.context.blocks[selected]?.handle;
}

function chatRow(view: ProjectView, entry: ChatRecord, selected: boolean, folded: boolean, columns: number): string {
  const handle = handleOf(view.brain.handles, "chat", entry.id) ?? "C?";
  const who = entry.author === "user" ? token.person("Person") : token.agent("Agent");
  const edited = entry.updatedAt !== entry.createdAt ? token.faint(`edited ${clock(entry.updatedAt)}`) : "";
  const foldedMark = folded ? token.faint(" · folded") : "";
  return row(`${rail(selected)}${token.accent(handle)}  ${who} · ${token.muted(clock(entry.createdAt))}${foldedMark}`, edited, columns);
}

function activityHead(item: LiveActivity, selected: boolean, columns: number): string {
  const label = styleActivity(item.kind, item.label);
  const state = item.streaming ? token.busy("streaming") : token.faint("complete");
  return row(`${rail(selected)} ${label}`, state, columns);
}

function brainRecords(view: ProjectView): Array<{ handle: string; kind: string; at: number; title: string; detail: string; text: string }> {
  const records: Array<{ handle: string; kind: string; at: number; title: string; detail: string; text: string }> = [];
  for (const entry of view.brain.ledger) {
    records.push({
      handle: handleOf(view.brain.handles, "ledger", entry.id) ?? "L?",
      kind: `Ledger · ${entry.kind} · ${entry.status}`,
      at: entry.updatedAt,
      title: oneLine(entry.text),
      detail: "",
      text: entry.answer?.text ?? "",
    });
  }
  for (const node of view.brain.atlas) {
    const evidence = node.evidence
      .map((source) => (source.kind === "file" ? `${source.path}:${source.startLine}-${source.endLine}` : "selected context"))
      .join(", ");
    records.push({
      handle: handleOf(view.brain.handles, "atlas", node.id) ?? "A?",
      kind: "Atlas",
      at: node.updatedAt,
      title: node.title,
      detail: node.claim,
      text: evidence === "" ? "" : `Evidence ${evidence}`,
    });
  }
  for (const wake of view.brain.wakes) {
    records.push({
      handle: handleOf(view.brain.handles, "wake", wake.id) ?? "W?",
      kind: `Wake · ${wake.status}`,
      at: wake.createdAt,
      title: oneLine(wake.condition),
      detail: "",
      text: oneLine(wake.reason),
    });
  }
  return records;
}

/** The body's disclosure projection, kept here so a test can call it directly. */
export function disclosureLines(item: LiveActivity, rows = 5, expanded = false, columns = 80): string[] {
  const lines = wrap(item.text, columns).map((line) => line.replace(/^ {0,2}/, ""));
  if (item.completed && !expanded) return [summaryLine(lines)];
  if (expanded || lines.length <= rows) return lines;
  return lines.slice(-rows);
}

function visualRowCount(text: string, columns: number): number {
  return wrap(text, columns).length;
}

function summaryLine(lines: readonly string[]): string {
  const value = lines.find((line) => line.trim() !== "") ?? "";
  return value.length <= 160 ? value : `${value.slice(0, 157)}…`;
}

/** Drop the `L1 ` that agent context puts at the start of a block's text. */
function withoutLeadingHandle(handle: string, text: string): string {
  return text.startsWith(`${handle} `) ? text.slice(handle.length + 1) : text;
}

/**
 * Drop the ` · at 2026-11-19T18:06:31.583Z` that agent context needs and a
 * person does not: the exact second of an edit is noise on a row that has one
 * line of room. The stamp stays in the text the agent reads.
 */
function withoutAgentStamp(text: string): string {
  return text.replace(/ · at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "");
}

/**
 * The words of a block that a person needs on one row.
 *
 * The projection gives the agent a full record (`P1 User pin · at … Reason:
 * … Source: …`) because the agent has no screen. The person has the section
 * name already, the time is noise at this size, and the source is the sentence
 * itself, so the row keeps the record and the reason.
 */
function summarizeBlock(view: ProjectView, block: ContextBlock, columns: number): string {
  const text = withoutAgentStamp(withoutLeadingHandle(block.handle, oneLine(block.text)));
  // The projection writes `Target: <record>. It is removed at collapse.`; the
  // section head and the action already say both of those things.
  // A deferred removal reads as `Deferred removal Target: C1`: the tail is
  // the fact, and the sentence around it is the same on every such row.
  if (block.section !== "pin") return text;
  // A pin block's id is `user-pin:<id>` or `carry-pin:<id>`, and a stale one
  // carries `:stale`, so the record's id is the middle of it.
  const pinId = block.id.replace(/^[a-z]+-pin:/, "").replace(/:stale$/, "");
  const pin = allPins(view).find((candidate) => candidate.id === pinId);
  if (pin === undefined) return text.replace(/^User pin /, "");
  const stale = pin.source.freshness === "stale" ? " · stale" : "";
  const reason = oneLine(pin.reason);
  // `split` cuts this to fit, so it is composed whole and measured once.
  void columns;
  return `${oneLine(pin.item)}  ${token.muted(`· ${reason}`)}${stale === "" ? "" : token.warning(stale)}`;
}

/** A section's name in the person's words, not the projection's key. */
function sectionLabel(section: string): string {
  switch (section) {
    case "ledger":
      return "Ledger";
    case "atlas":
      return "Atlas";
    case "pin":
      return "Pins";
    case "wake":
      return "Wakes";
    default:
      return section;
  }
}

function rail(selected: boolean): string {
  return selected ? token.accent("▌") : " ";
}

/**
 * A section head: two cells of inset (the rail's cell and the gap before the
 * first column), so it lines up with a record's handle rather than with its
 * mark. The head of the section that holds the selection is bright: that is
 * how the person knows where the keys act.
 */
function head(title: string, count: string, columns: number, active: boolean): string {
  const left = `  ${active ? token.sectionActive(title) : token.section(title)}`;
  return row(left, token.faint(count), columns, 1);
}

function emptyState(lines: readonly string[], columns: number): BodyRow[] {
  return lines.map((line) => {
    const left = Math.max(0, Math.floor((columns - width(line)) / 2));
    return { text: `${" ".repeat(left)}${token.faint(line)}` };
  });
}

function allPins(view: ProjectView) {
  return [...view.brain.userPins, ...view.brain.carryPins];
}

function styleActivity(kind: LiveActivity["kind"], text: string): string {
  switch (kind) {
    case "reasoning":
      return token.reasoning(text);
    case "model":
      return token.agent(text);
    case "tool-call":
      return token.tool(text);
    case "tool-output":
      return token.output(text);
    case "warning":
      return token.warning(text);
    case "error":
      return token.danger(text);
  }
}
