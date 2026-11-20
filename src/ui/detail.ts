import type { ProjectView } from "../runtime/project.js";
import { handleOf } from "../domain/handles.js";
import { token } from "./tokens.js";
import { clock, short, wrap } from "./text.js";
import type { Tab } from "./frame.js";

/**
 * The full content of the selected record.
 *
 * A row on Brain or Context is a summary by design: one row per record keeps a
 * list scannable. The defect that made this file necessary is that the summary
 * was the *only* view, so a `…` on screen was the end of the record. A long
 * claim or a long wake reason is many lines of prose; on one row it read as a
 * stub and pressing Enter answered with a footer message instead of the text.
 *
 * A detail is therefore a page, not a wider row: it is the body's own scrolling
 * region swapped for a record view, so the token bar, the status row, and the
 * footer stay exactly where they are, and a record of any length scrolls with
 * the keys the person already uses for the transcript.
 */
export interface RecordDetail {
  /** The handle, so the page names the same thing the list does. */
  handle: string;
  /** What kind of record this is, in the list's own words. */
  kind: string;
  /** The record's own text, one entry per line, before wrapping. */
  lines: readonly string[];
}

/**
 * The detail for the selected row, or `undefined` when the tab has no selection.
 *
 * Nothing here invents content. Every line comes from a durable record or from
 * the context projection that is sent to the model, which is the point: the
 * person is reading the same thing the agent is given.
 */
export function recordDetail(tab: Tab, view: ProjectView, selected: number): RecordDetail | undefined {
  if (tab === "brain") return brainDetail(view, selected);
  if (tab === "context") return contextDetail(view, selected);
  const chat = view.brain.chat;
  const entry = chat[selected];
  if (entry === undefined) return undefined;
  return {
    handle: handleOf(view.brain.handles, "chat", entry.id) ?? "C?",
    kind: `Chat · ${entry.author === "user" ? "Person" : "Agent"} · ${clock(entry.createdAt)}`,
    lines: entry.text.split("\n"),
  };
}

/** The Brain list's own order, so the index means the same row in both views. */
function brainDetail(view: ProjectView, selected: number): RecordDetail | undefined {
  let index = 0;
  for (const entry of view.brain.ledger) {
    if (index++ !== selected) continue;
    const answer = entry.answer === null ? [] : ["", `Answer: ${entry.answer.text}`];
    return {
      handle: handleOf(view.brain.handles, "ledger", entry.id) ?? "L?",
      kind: `Ledger · ${entry.kind} · ${entry.status} · ${clock(entry.updatedAt)}`,
      lines: [...entry.text.split("\n"), ...answer],
    };
  }
  for (const node of view.brain.atlas) {
    if (index++ !== selected) continue;
    const evidence = node.evidence.map((source) =>
      source.kind === "file" ? `  ${source.path}:${source.startLine}-${source.endLine}` : "  selected context",
    );
    const edges = node.edges.map((edge) => {
      const target = handleOf(view.brain.handles, "atlas", edge.target) ?? "(missing)";
      return `  ${edge.kind} ${target}`;
    });
    return {
      handle: handleOf(view.brain.handles, "atlas", node.id) ?? "A?",
      kind: `Atlas · ${clock(node.updatedAt)}`,
      lines: [
        node.title,
        "",
        node.claim,
        ...(evidence.length === 0 ? [] : ["", "Evidence", ...evidence]),
        ...(edges.length === 0 ? [] : ["", "Edges", ...edges]),
      ],
    };
  }
  for (const wake of view.brain.wakes) {
    if (index++ !== selected) continue;
    return {
      handle: handleOf(view.brain.handles, "wake", wake.id) ?? "W?",
      kind: `Wake · ${wake.status} · ${clock(wake.createdAt)}`,
      lines: [wake.condition, "", `Reason: ${wake.reason}`],
    };
  }
  return undefined;
}

/**
 * A Context block, whole.
 *
 * This is the case the person hit: the block text is what the model is sent, so a
 * detail must show it unsummarised and unwrapped by the row that usually holds
 * it. The cost and the section stay on the first line, because they are what the
 * person judges the block by.
 */
function contextDetail(view: ProjectView, selected: number): RecordDetail | undefined {
  const block = view.context.blocks[selected];
  if (block === undefined) return undefined;
  return {
    handle: block.handle,
    kind: `${sectionName(block.section)} · ${short(block.estimatedTokens)} tok`,
    lines: block.text.split("\n"),
  };
}

function sectionName(section: string): string {
  const names: Record<string, string> = {
    ledger: "Ledger",
    atlas: "Atlas",
    pin: "Pin",
    wake: "Wake",
  };
  return names[section] ?? section;
}

/**
 * A detail as body rows: a title, a rule, the wrapped text, then the keys that
 * leave the page.
 *
 * The rows are `BodyRow`s, not strings, so the detail scrolls in the body's own
 * `ScrollView` and gets its scrollbar, its paging, and its `ctrl+home` for free.
 * A separate overlay would have needed its own scrolling, written by hand, which
 * is exactly the mistake `docs/reference-overlay.md` records.
 */
export function recordDetailRows(detail: RecordDetail, columns: number): string[] {
  const inner = Math.max(20, columns - 4);
  const rows: string[] = [`  ${token.accent(detail.handle)}  ${token.muted(detail.kind)}`, ""];
  for (const line of detail.lines) {
    if (line === "") {
      rows.push("");
      continue;
    }
    for (const wrapped of wrap(line, inner)) rows.push(`  ${wrapped}`);
  }
  // No key hint here. The footer under the body already lists the keys that
  // work, and two copies of one list is how one of them becomes a lie.
  return rows;
}
