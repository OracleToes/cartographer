/**
 * Brain writes as pure transformations over an explicit value (§2).
 *
 * `applyWrite(brain, write, now)` returns the next Brain, or throws a
 * `BrainError` with a person-readable message. Unknown handles and unknown
 * IDs are explicit errors; a partially applied write never escapes — the
 * store applies it inside one transaction or not at all.
 *
 * Deletion is a single step with no pending state and no undo
 * (§3.3, §4.1).
 */
import { reconcileHandles } from "./handles.js";
import type {
  Author,
  CartoBrain,
  LedgerEntry,
  Mark,
  MarkAction,
  RecordId,
  AtlasNode,
  ChatRecord,
  PinnedEphemeral,
  PinnedFile,
} from "./records.js";

export class BrainError extends Error {}

export type BrainWrite =
  | { kind: "chat.record"; record: ChatRecord }
  | { kind: "atlas.stale"; id: RecordId; stale: boolean }
  | { kind: "chat.update"; id: RecordId; text: string; updatedAt: number }
  | { kind: "ledger.upsert"; entry: LedgerEntry }
  | { kind: "atlas.upsert"; node: AtlasNode }
  | { kind: "mark.set"; target: "chat" | "ledger" | "atlas"; id: RecordId; action: MarkAction; author: Author }
  | { kind: "mark.clear"; target: "chat" | "ledger" | "atlas"; id: RecordId; author?: Author }
  | { kind: "delete"; target: "chat" | "ledger" | "atlas"; id: RecordId }
  /** Pin or unpin a file: the head holds the file, not a quotation of a read of it (§5.1, §5.5). */
  | { kind: "file.pin"; path: string; pinned: Author | null }
  /** The collapse-time staleness of a pinned file, like an Atlas node's (§5.5). */
  | { kind: "file.stale"; path: string; stale: boolean }
  /** Pin, unpin, or re-pin one ephemeral item held in the live context (§3.2). Not `pin.set`: ephemera are not Brain records. */
  | { kind: "ephemeral.pin"; item: PinnedEphemeral }
  | { kind: "ephemeral.unpin"; id: RecordId; author?: Author }
  | { kind: "ephemeral.delete-mark"; id: RecordId; marked: boolean };

export function applyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  const next = doApplyWrite(brain, write, now);
  return reconcileHandles(next);
}

function doApplyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  switch (write.kind) {
    case "ephemeral.delete-mark": {
      const ids = new Set(brain.ephemeralDeletes ?? []);
      if (write.marked) ids.add(write.id);
      else ids.delete(write.id);
      return { ...brain, ephemeralDeletes: [...ids] };
    }
    case "ephemeral.pin": {
      // One entry per item. Pinning again replaces the pin and its author,
      // which is what a pin being "a boolean on an entry" means (§3.2).
      const existing = brain.ephemera.find((item) => item.id === write.item.id);
      if (write.item.pinned === "agent" && brain.ephemeralDeletes?.includes(write.item.id)) throw new BrainError("The person marked this item for deletion");
      if (existing?.pinned === "user" && write.item.pinned === "agent") throw new BrainError("Only the person can remove or replace their pin");
      const exists = existing !== undefined;
      const ephemera = exists
        ? brain.ephemera.map((item) => (item.id === write.item.id ? write.item : item))
        : [...brain.ephemera, write.item];
      return { ...brain, ephemera };
    }

    case "file.pin": {
      // A pin is a boolean on the thing it marks (§3.2), so pinning again
      // replaces the pin and its author, and unpinning takes the entry away.
      const exists = brain.files.find((file) => file.path === write.path);
      if (write.pinned === null) return { ...brain, files: brain.files.filter((file) => file.path !== write.path) };
      const pinned: Author = write.pinned;
      const files: PinnedFile[] =
        exists === undefined
          ? [...brain.files, { path: write.path, pinned, createdAt: now }]
          : brain.files.map((file) => (file.path === write.path ? { ...file, pinned } : file));
      return { ...brain, files };
    }

    case "file.stale": {
      return {
        ...brain,
        files: brain.files.map((file) => {
          if (file.path !== write.path) return file;
          if (!write.stale) {
            const copy: Record<string, unknown> = { ...file };
            delete copy.stale;
            return copy as unknown as PinnedFile;
          }
          return { ...file, stale: true };
        }),
      };
    }

    case "ephemeral.unpin": {
      if (write.author === "agent" && brain.ephemera.find((item) => item.id === write.id)?.pinned === "user") {
        throw new BrainError("Only the person can remove their pin");
      }
      return { ...brain, ephemera: brain.ephemera.filter((item) => item.id !== write.id) };
    }

    case "atlas.stale": {
      // Written only at a rebuild (§5.5). The
      // mark is a marker on the entry, like a pin — and clearing is a delete,
      // never a phantom undefined. Blocks nothing, deletes nothing.
      const node = brain.atlas.find((candidate) => candidate.id === write.id);
      if (node === undefined) throw new BrainError("An Atlas stale mark names a node that does not exist.");
      const atlas = brain.atlas.map((candidate) => {
        if (candidate.id !== write.id) return candidate;
        if (write.stale === true) return { ...candidate, stale: true };
        const { stale: _stale, ...cleared } = candidate;
        void _stale;
        return cleared;
      });
      return { ...brain, atlas };
    }

    case "chat.record":
      return { ...brain, chat: [...brain.chat, write.record] };

    case "chat.update": {
      const record = brain.chat.find((candidate) => candidate.id === write.id);
      if (record === undefined) throw new BrainError("No Chat record is named by that handle.");
      const chat = brain.chat.map((candidate) =>
        candidate.id === write.id ? { ...candidate, text: write.text, updatedAt: write.updatedAt } : candidate,
      );
      return { ...brain, chat };
    }

    case "ledger.upsert": {
      const exists = brain.ledger.some((entry) => entry.id === write.entry.id);
      const ledger = exists
        ? brain.ledger.map((entry) => (entry.id === write.entry.id ? write.entry : entry))
        : [...brain.ledger, write.entry];
      return { ...brain, ledger };
    }

    case "atlas.upsert": {
      // Links and attachments are stored as written (§2.1):
      // the Atlas is the agent's garden and permissive by intent — a node
      // floating unconnected, or one linking a vanished target, is the
      // agent's to tend, not the runtime's to validate away.
      // An update re-asserts the entry and clears the stale marker, like an
      // update would re-assert any other promise: the marker is collapse-time
      // truth, and the live check re-detects drift from updatedAt.
      const exists = brain.atlas.some((node) => node.id === write.node.id);
      const node: AtlasNode = exists ? clearStale(write.node) : write.node;
      const atlas = exists
        ? brain.atlas.map((candidate) => (candidate.id === node.id ? node : candidate))
        : [...brain.atlas, node];
      return { ...brain, atlas };
    }

    case "mark.set": {
      // A mark is a marker on the entry, like a pin (§4.1): it says what the
      // next collapse does, and the collapse is what does it. Absent = not
      // marked for this; archive and delete are the two marks a Brain record
      // carries, and `restore` belongs to an entry in the archive, so it is
      // refused here rather than stored against a record that is in the Brain.
      if (write.action === "restore") {
        throw new BrainError("Restore is for an entry in the archive; a Brain record is not in the archive.");
      }
      const marked = setMark(brain, write.target, write.id, { action: write.action, author: write.author });
      return marked;
    }

    case "mark.clear": {
      // Only the person withdraws a mark the person placed; the agent withdraws
      // its own. An author left off is the collapse clearing a mark it is
      // applying, which is not a withdrawal by either party (§4.1).
      const marked = findMarked(brain, write.target, write.id);
      if (write.author === "agent" && marked?.mark?.author === "user") {
        throw new BrainError("That mark was placed by the person at the keyboard, and only they withdraw it.");
      }
      return clearMark(brain, write.target, write.id);
    }

    case "delete": {
      switch (write.target) {
        case "chat": {
          const chat = brain.chat.filter((record) => record.id !== write.id);
          if (chat.length === brain.chat.length) throw new BrainError("No Chat record is named by that handle.");
          return { ...brain, chat };
        }
        case "ledger": {
          const ledger = brain.ledger.filter((entry) => entry.id !== write.id);
          if (ledger.length === brain.ledger.length) throw new BrainError("No Ledger record is named by that handle.");
          return { ...brain, ledger };
        }
        case "atlas": {
          const atlas = brain.atlas.filter((node) => node.id !== write.id);
          if (atlas.length === brain.atlas.length) throw new BrainError("No Atlas node is named by that handle.");
          // No cascade: links and attachments naming the deleted node stay as they are. The
          // agent tends its own graph (§2.1, §2.3); a dead reference is
          // something it can see and repair, not something to hide.
          return { ...brain, atlas };
        }
      }
    }
  }
}

/** The record a mark write names, or undefined. */
function findMarked(
  brain: CartoBrain,
  target: "chat" | "ledger" | "atlas",
  id: RecordId,
): { mark?: Mark } | undefined {
  switch (target) {
    case "chat":
      return brain.chat.find((record) => record.id === id);
    case "ledger":
      return brain.ledger.find((entry) => entry.id === id);
    case "atlas":
      return brain.atlas.find((node) => node.id === id);
  }
}

/** Sets the mark on one record; the author rides with it (§4.1). */
function setMark(brain: CartoBrain, target: MarkTarget, id: RecordId, mark: Mark): CartoBrain {
  const withMark = <T extends { mark?: Mark }>(record: T): T => ({ ...record, mark });
  switch (target) {
    case "chat": {
      if (!brain.chat.some((record) => record.id === id)) throw new BrainError("No Chat record is named by that handle.");
      return { ...brain, chat: brain.chat.map((record) => (record.id === id ? withMark(record) : record)) };
    }
    case "ledger": {
      if (!brain.ledger.some((entry) => entry.id === id)) throw new BrainError("No Ledger record is named by that handle.");
      return { ...brain, ledger: brain.ledger.map((entry) => (entry.id === id ? withMark(entry) : entry)) };
    }
    case "atlas": {
      if (!brain.atlas.some((node) => node.id === id)) throw new BrainError("No Atlas node is named by that handle.");
      return { ...brain, atlas: brain.atlas.map((node) => (node.id === id ? withMark(node) : node)) };
    }
  }
}

/** Clears the mark; the key goes, never `mark: undefined` lying around. */
function clearMark(brain: CartoBrain, target: MarkTarget, id: RecordId): CartoBrain {
  const without = <T extends { mark?: Mark }>(record: T): T => {
    const copy: Record<string, unknown> = { ...record };
    delete copy.mark;
    return copy as T;
  };
  switch (target) {
    case "chat":
      return { ...brain, chat: brain.chat.map((record) => (record.id === id ? without(record) : record)) };
    case "ledger":
      return { ...brain, ledger: brain.ledger.map((entry) => (entry.id === id ? without(entry) : entry)) };
    case "atlas":
      return { ...brain, atlas: brain.atlas.map((node) => (node.id === id ? without(node) : node)) };
  }
}

type MarkTarget = "chat" | "ledger" | "atlas";

/** A re-written node re-asserts its text and attachments; the stale marker is collapse-time truth and is cleared. */
function clearStale(node: AtlasNode): AtlasNode {
  if (node.stale === undefined) return node;
  const { stale: _stale, ...cleared } = node;
  void _stale;
  return cleared;
}
