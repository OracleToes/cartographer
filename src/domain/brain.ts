/**
 * Brain writes as pure transformations over an explicit value (MINI.md §12).
 *
 * `applyWrite(brain, write, now)` returns the next Brain, or throws a
 * `BrainError` with a person-readable message. Unknown handles and unknown
 * IDs are explicit errors; a partially applied write never escapes — the
 * store applies it inside one transaction or not at all.
 *
 * Deletion is a single step with no pending state and no undo
 * (MINI.md §2.1, confirmed).
 */
import { reconcileHandles } from "./handles.js";
import type {
  CartoBrain,
  LedgerEntry,
  RecordId,
  AtlasNode,
  ChatRecord,
} from "./records.js";

export class BrainError extends Error {}

export type BrainWrite =
  | { kind: "chat.record"; record: ChatRecord }
  | { kind: "evidence.refresh"; marks: Array<{ record: "atlas"; id: RecordId; index: number | null; freshness: "fresh" | "stale" }> }
  | { kind: "chat.update"; id: RecordId; text: string; updatedAt: number }
  | { kind: "ledger.upsert"; entry: LedgerEntry }
  | { kind: "atlas.upsert"; node: AtlasNode }
  | { kind: "pin.set"; target: "chat" | "ledger" | "atlas"; id: RecordId; pinned: "user" | "agent" | null }
  | { kind: "delete"; target: "chat" | "ledger" | "atlas"; id: RecordId };

export function applyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  const next = doApplyWrite(brain, write, now);
  return reconcileHandles(next);
}

function doApplyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  switch (write.kind) {
    case "evidence.refresh": {
      // Written only at a rebuild (MINI.md §28: digest drift is marked stale
      // at rebuild). Blocks nothing, deletes nothing, and never renumbers
      // handles.
      let next = brain;
      for (const mark of write.marks) {
        if (mark.record !== "atlas") throw new BrainError("An evidence mark names a record that does not exist.");
        const node = next.atlas.find((candidate) => candidate.id === mark.id);
        if (node === undefined) throw new BrainError("An evidence mark names an Atlas node that does not exist.");
        if (mark.index === null || node.evidence[mark.index] === undefined) {
          throw new BrainError("An evidence mark names evidence that does not exist.");
        }
        const evidence = node.evidence.map((ref, index) =>
          index === mark.index ? { ...ref, freshness: mark.freshness } : ref,
        );
        next = {
          ...next,
          atlas: next.atlas.map((candidate) => (candidate.id === mark.id ? { ...candidate, evidence } : candidate)),
        };
      }
      return next;
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
      // Edges are stored as written (MINI.md §2.1, confirmed): the graph is
      // the agent's garden and permissive by intent — a flood of unconnected
      // nodes or an edge to a vanished target is the agent's to tend, not
      // the runtime's to validate away.
      const exists = brain.atlas.some((node) => node.id === write.node.id);
      const atlas = exists
        ? brain.atlas.map((node) => (node.id === write.node.id ? write.node : node))
        : [...brain.atlas, write.node];
      return { ...brain, atlas };
    }

    case "pin.set": {
      // A pin means "keep it here" (MINI.md §4.1). A marker on the entry; no
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
          // Evidence IDs pointing at the deleted entry are the agent's to clean up;
          // the Brain does not cascade a delete across the graph.
          return { ...brain, ledger };
        }
        case "atlas": {
          const atlas = brain.atlas.filter((node) => node.id !== write.id);
          if (atlas.length === brain.atlas.length) throw new BrainError("No Atlas node is named by that handle.");
          // No cascade: edges naming the deleted node stay as they are. The
          // agent tends its own graph (§2.1, §2.3); a dead reference is
          // something it can see and repair, not something to hide.
          return { ...brain, atlas };
        }
      }
    }
  }
}

/** Places or clears the pin marker on one record; a cleared pin removes the key, never leaves `pinned: undefined` lying around. */
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
