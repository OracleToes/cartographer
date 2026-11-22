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
} from "./records.js";

export class BrainError extends Error {}

export type BrainWrite =
  | { kind: "chat.record"; record: ChatRecord }
  | { kind: "atlas.stale"; id: RecordId; stale: boolean }
  | { kind: "chat.update"; id: RecordId; text: string; updatedAt: number }
  | { kind: "ledger.upsert"; entry: LedgerEntry }
  | { kind: "atlas.upsert"; node: AtlasNode }
  | { kind: "pin.set"; target: "chat" | "ledger" | "atlas"; id: RecordId; pinned: "user" | "agent" | null }
  | { kind: "mark.set"; target: "chat" | "ledger" | "atlas"; id: RecordId; action: MarkAction; author: Author }
  | { kind: "mark.clear"; target: "chat" | "ledger" | "atlas"; id: RecordId }
  | { kind: "delete"; target: "chat" | "ledger" | "atlas"; id: RecordId };

export function applyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  const next = doApplyWrite(brain, write, now);
  return reconcileHandles(next);
}

function doApplyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  switch (write.kind) {
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

    case "mark.clear":
      return clearMark(brain, write.target, write.id);

    case "pin.set": {
      // A pin means "keep it here" (§3.2). A marker on the entry; no
      // reason, no source, no bookkeeping. The marker records who placed it:
      // "user" | "agent" — the person may remove either kind of pin, the agent
      // may remove only its own.
      return setPin(brain, write.target, write.id, write.pinned);
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

/** Places or clears the pin marker on one record; a cleared pin removes the key, never leaves `pinned: undefined` lying around. */
/** A re-written node re-asserts its text and attachments; the stale marker is collapse-time truth and is cleared. */
function clearStale(node: AtlasNode): AtlasNode {
  if (node.stale === undefined) return node;
  const { stale: _stale, ...cleared } = node;
  void _stale;
  return cleared;
}

function setPinRecord<T extends { pinned?: "user" | "agent" }>(record: T, pinned: "user" | "agent" | null): T {
  if (pinned === null) {
    // Deleting the key is what "unpinned" means; a cleared pin must not
    // leave `pinned: undefined` lying around in the persisted document.
    const copy: Record<string, unknown> = { ...record };
    delete copy.pinned;
    return copy as T;
  }
  return { ...record, pinned };
}

function setPin(brain: CartoBrain, target: "chat" | "ledger" | "atlas", id: RecordId, pinned: "user" | "agent" | null): CartoBrain {
  switch (target) {
    case "chat": {
      if (!brain.chat.some((record) => record.id === id)) throw new BrainError("No Chat record is named by that handle.");
      return { ...brain, chat: brain.chat.map((record) => (record.id === id ? setPinRecord(record, pinned) : record)) };
    }
    case "ledger": {
      if (!brain.ledger.some((entry) => entry.id === id)) throw new BrainError("No Ledger record is named by that handle.");
      return { ...brain, ledger: brain.ledger.map((entry) => (entry.id === id ? setPinRecord(entry, pinned) : entry)) };
    }
    case "atlas": {
      if (!brain.atlas.some((node) => node.id === id)) throw new BrainError("No Atlas node is named by that handle.");
      return { ...brain, atlas: brain.atlas.map((node) => (node.id === id ? setPinRecord(node, pinned) : node)) };
    }
  }
}
