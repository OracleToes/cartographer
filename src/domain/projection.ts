/**
 * The frozen projection (§5.1).
 *
 * Rebuilt only at collapse; never patched between collapses. It carries
 * structure, handles, and state, and every Chat record the Brain holds, the
 * person's and the agent's (§3.2 step 4, §5.1). While a generation lives, a
 * Chat record is in the body where it was said; a collapse ends that body, so
 * the record reaches the head here, once, and the conversation goes on across
 * the collapse. There is no context budget and no omission list: the person
 * never confirmed one, and a limit the agent cannot measure is worse than no
 * limit (§2.3's logic, applied to the projection).
 *
 * Every durable ID line carries an ISO 8601 UTC timestamp (§6). Links and
 * attachments that name a record which no longer exists render as `(gone)` —
 * the agent tends its graph; the projection never hides a dead reference
 * (§2.1, §2.3).
 */
import { handleOf } from "./handles.js";
import { personName } from "./person.js";
import { estimateTokens } from "./estimate.js";
import type { CartoBrain } from "./records.js";

export type ProjectionPartId = "atlas" | "ledger" | "chat" | "files" | "ephemera";

export interface ProjectionPart {
  id: ProjectionPartId;
  label: string;
  text: string;
  tokens: number;
}

export interface Projection {
  /** Stable, human-readable snapshot of the Brain at the freeze. */
  text: string;
  parts: ProjectionPart[];
  /** Sum of the parts' estimated tokens; informational, never enforced. */
  total: number;
  /** Sizes by part, for the state block's space accounting (§5.3). */
  sizes: Record<ProjectionPartId, number>;
  /**
   * The Chat records this head holds, by id. A head is frozen, so a record
   * written after it is not in it, and the host needs the list to rebuild the
   * head without gathering in what the live body already shows (§2.3).
   */
  chatIds: string[];
}

/** What a caller may choose about the head it is building. */
export interface ProjectionChoices {
  /** Only these Chat records go in: the rest are in the body, said since the freeze. Absent: all of them. */
  chat?: ReadonlySet<string>;
}

const tokens = estimateTokens;

const iso = (ms: number): string => new Date(ms).toISOString();

function resolveHandle(brain: CartoBrain, id: string): string {
  const hit = brain.handles.entries.find((entry) => entry.id === id);
  return hit === undefined ? "(gone)" : hit.handle;
}

/** A file's text, indented under its line so the head reads as one document. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function makePart(id: ProjectionPartId, label: string, lines: string[]): ProjectionPart {
  const text = lines.join("\n");
  return { id, label, text, tokens: tokens(text) };
}

/**
 * The read text of a pinned file, supplied by the caller.
 *
 * The projection is a pure transformation (§11) and cannot read a file, so the
 * collapse reads each pinned file and hands the bytes in. `undefined` means the
 * file could not be read, and the head says so in its place rather than quietly
 * dropping the pin: a pin that vanishes looks like the file did.
 */
export type PinnedFileText = ReadonlyMap<string, string | undefined>;

export function projectContext(
  brain: CartoBrain,
  fileTexts: PinnedFileText = new Map(),
  /**
   * The name the agent calls the person: the session's resolved name. Absent
   * when a caller renders a head outside a session (a test, a preview), where
   * the launching account is still the honest answer.
   */
  person: string = personName(),
  choices: ProjectionChoices = {},
): Projection {
  const handles = brain.handles;
  const partOf = (kind: Parameters<typeof handleOf>[1], id: string) =>
    handleOf(handles, kind, id) ?? "?";

  const atlas: string[] = [];
  if (brain.atlas.length > 0) {
    atlas.push("Atlas — what you understand about the project");
    for (const node of brain.atlas) {
      atlas.push(
        `${partOf("atlas", node.id)} ${node.title} — ${iso(node.updatedAt)}${node.stale ? " · [stale: the file changed after this note]" : ""}`,
      );
      atlas.push(`  ${node.text}`);
      for (const link of node.links) atlas.push(`  link: ${resolveHandle(brain, link)}`);
      for (const attachment of node.attachments) {
        atlas.push(
          attachment.kind === "file"
            ? `  attach: ${attachment.path}`
            : `  attach: ${resolveHandle(brain, attachment.id)}`,
        );
      }
    }
  }

  const ledger: string[] = [];
  if (brain.ledger.length > 0) {
    ledger.push("Ledger — what you are working on");
    for (const entry of brain.ledger) {
      ledger.push(
        `${partOf("ledger", entry.id)} [${entry.kind} · ${entry.status}] ${entry.text} — ${iso(entry.updatedAt)}`,
      );
      if (entry.answer !== null) {
        ledger.push(`  → answered: ${entry.answer.text}`);
      }
    }
  }

  // Chat is the conversation (§2.3), and the head holds all of it (§5.1): the
  // person's words and the agent's own, in the order they were said, each under
  // its handle. A record the person or the agent deleted is not here, and one
  // marked for archive left the Brain before this was built.
  const chat: string[] = [];
  const held = brain.chat.filter((record) => choices.chat === undefined || choices.chat.has(record.id));
  if (held.length > 0) {
    chat.push(`Chat — what you and ${person} have said to each other`);
    for (const record of held) {
      const speaker = record.author === "user" ? person : record.author === "system" ? "system" : "you";
      chat.push(`${partOf("chat", record.id)} [${speaker}] — ${iso(record.createdAt)}`);
      chat.push(indent(record.text));
    }
  }

  // Pinned ephemera come after Chat in the head (§5.1): what the person kept in
  // front of the agent, each item under its own handle. They are not Brain
  // records, so they are not part of the Atlas or the Ledger part; they are the
  // whole content of their own part, and their size is reported as `ephemera`.
  const ephemera: string[] = [];
  const pinned = brain.ephemera.filter((item) => item.pinned !== undefined);
  if (pinned.length > 0) {
    ephemera.push(`Pinned — what ${person} kept in front of you`);
    pinned.forEach((item, index) => {
      ephemera.push(`${partOf("ephemera", item.id) ?? `E${index + 1}`} [${item.kind}] ${item.text}`);
    });
  }

  // Pinned files sit between Chat and pinned ephemera (§5.1), each under the
  // handle the tree gave it: a pin does not rename a file (§5.4). The text is
  // what the file held when the collapse read it, which is why this region
  // changes at a collapse and never in between (§5.5).
  const files: string[] = [];
  if (brain.files.length > 0) {
    files.push("Pinned files — read again at this collapse");
    for (const file of brain.files) {
      const text = fileTexts.get(file.path);
      const name = file.path === "" ? "." : file.path;
      const stale = file.stale === true ? " · [stale: the file is gone or has changed since this pin]" : "";
      files.push(`${name} · pinned by ${file.pinned === "user" ? person : "you"}${stale}`);
      files.push(text === undefined ? "  (this file could not be read at the collapse)" : indent(text));
    }
  }

  const parts: ProjectionPart[] = [];
  if (atlas.length > 0) parts.push(makePart("atlas", "Atlas", atlas));
  if (ledger.length > 0) parts.push(makePart("ledger", "Ledger", ledger));
  if (chat.length > 0) parts.push(makePart("chat", "Chat", chat));
  if (files.length > 0) parts.push(makePart("files", "Pinned files", files));
  if (ephemera.length > 0) parts.push(makePart("ephemera", "Pinned", ephemera));

  const text =
    parts.length === 0
      ? "(the Brain is empty: nothing recorded yet. Write what you learn about the project, and the plan you are working to.)"
      : parts.map((part) => part.text).join("\n\n");
  const sizes: Record<ProjectionPartId, number> = { atlas: 0, ledger: 0, chat: 0, files: 0, ephemera: 0 };
  for (const part of parts) sizes[part.id] = part.tokens;
  return { text, parts, total: parts.reduce((sum, part) => sum + part.tokens, 0), sizes, chatIds: held.map((record) => record.id) };
}
