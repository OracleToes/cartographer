/**
 * The product tools (MINI.md §10a).
 *
 * Plain model text is not Chat. Every tool is scoped and unique; the tool
 * descriptions are the authority on what each does. A Brain write appears
 * here as the tool's result and as a pending-change line in the state
 * block — never as a projection patch (MINI.md §6).
 */
import { arr, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";

import type { CartoBrain, Attachment } from "../domain/records.js";
import { findByHandle, handleOf } from "../domain/handles.js";
import { projectTreeBlock } from "./project-tree.js";
import type { BrainStore } from "./brain-store.js";
import { applyAtomicEdit, lexicalProjectPath, readRange, WorkspaceError } from "./workspace.js";
import type { PendingWrite } from "../domain/state-block.js";

export interface ToolSession {
  /** Pending Brain writes since the last rebuild; ephemeral, cleared at collapse. */
  pending: PendingWrite[];
  /** Where the state block renders the tree. */
  tree: { anchor: string; depth: number };
  /** Set by the collapse tool; the host ends the generation and rebuilds when the run settles. */
  collapseRequested: string | null;
  /** The generation this context belongs to; recorded on context-sourced pins. */
  generation: string;
}

export interface ToolDeps {
  root: string;
  brain: BrainStore;
  session: ToolSession;
}

const Text = str({ minLength: 1 });
const HandleRef = str({ minLength: 1 });

const normalizeHandle = (handle: string): string => handle.trim().toUpperCase();

function resolveKnown(brain: CartoBrain, handle: string, kinds: readonly string[], what: string): { kind: string; id: string } {
  const found = findByHandle(brain.handles, normalizeHandle(handle));
  if (found === undefined || !kinds.includes(found.kind)) {
    throw new Error(`The handle ${normalizeHandle(handle)} does not name ${what}. Use a handle from the current context.`);
  }
  return { kind: found.kind, id: found.id };
}

const pendingWrite = (session: ToolSession, write: PendingWrite): void => {
  session.pending.push(write);
};

/**
 * Resolve one attachment: a file path that stays inside the project root
 * (scoped, never required to exist — the stale mark is what notices it), or
 * a handle naming any other record. The caller carries the resolved value.
 */
function resolveAttachment(
  current: CartoBrain,
  root: string,
  attachment: { kind: "file"; path: string } | { kind: "record"; handle: string },
): Attachment {
  if (attachment.kind === "file") {
    lexicalProjectPath(root, attachment.path);
    return { kind: "file", path: attachment.path };
  }
  const found = findByHandle(current.handles, normalizeHandle(attachment.handle));
  if (found === undefined) {
    throw new Error(`The handle ${normalizeHandle(attachment.handle)} does not name a record. Use a handle from the current context.`);
  }
  return { kind: "record", id: found.id };
}

const textOutput = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });
const errorOutput = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

export function createTools(deps: ToolDeps): ToolRegistration[] {
  const { root, brain, session } = deps;

  return [
    defineTool({
      name: "chat",
      description: "Declare something person-facing. Plain model text is not Chat; this tool is the only channel that reaches the person.",
      parameters: obj({ text: Text }),
      replay: "safe",
      execute: async (args, api) => {
        const id = `chat:${api.callId}`;
        await brain.apply({ kind: "chat.record", record: { id, author: "agent", text: args.text, createdAt: api.now(), updatedAt: api.now() } }, api.now());
        pendingWrite(session, { kind: "chat", action: "record", id });
        return textOutput("Chat message saved.");
      },
    }),

    defineTool({
      name: "atlas",
      description:
        "Create or update one Atlas node: a name and a text entry. A node may be linked to other Atlas nodes, or attached to any other reference in Carto — a file by path, or a record by handle. Pass the handle of an existing node to update it; links and attachments are re-written wholesale. Omit the handle to create a new node.",
      parameters: obj({
        handle: opt(HandleRef),
        title: str({ minLength: 1 }),
        text: Text,
        links: opt(arr(HandleRef)),
        attachments: opt(
          arr(
            union([
              obj({ kind: lit("file"), path: str({ minLength: 1 }) }),
              obj({ kind: lit("record"), handle: HandleRef }),
            ]),
          ),
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = await brain.read();
        const handleArg = args.handle;
        const updateTarget = handleArg === undefined ? undefined : resolveKnown(current, handleArg, ["atlas"], "an Atlas record");
        const previous = updateTarget === undefined ? undefined : current.atlas.find((node) => node.id === updateTarget.id);
        if (updateTarget !== undefined && previous === undefined) {
          throw new Error(`The handle ${normalizeHandle(handleArg ?? "")} does not name an Atlas record.`);
        }
        const id = previous?.id ?? `atlas:${api.callId}`;
        const links = (args.links ?? []).map((link) => resolveKnown(current, link, ["atlas"], "an Atlas record").id);
        const attachments = (args.attachments ?? []).map((attachment) => resolveAttachment(current, root, attachment));
        const next = await brain.apply(
          {
            kind: "atlas.upsert",
            node: {
              id,
              title: args.title,
              text: args.text,
              links,
              attachments,
              createdAt: previous?.createdAt ?? api.now(),
              updatedAt: api.now(),
            },
          },
          api.now(),
        );
        pendingWrite(session, { kind: "atlas", action: previous === undefined ? "create" : "update", id });
        return textOutput(`Atlas ${handleOf(next.handles, "atlas", id) ?? "record"} saved.`);
      },
    }),

    defineTool({
      name: "ledger",
      description:
        "Create or update one durable Ledger record: a goal, a note, a question, an instruction, or progress. Pass the handle to update, or leave it out to create.",
      parameters: obj({
        handle: opt(HandleRef),
        kind: oneOf(["goal", "note", "question", "instruction", "progress"] as const),
        text: Text,
        status: oneOf(["open", "answered", "closed"] as const),
        answer: opt(Text),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = await brain.read();
        const handleArg = args.handle;
        const updateTarget = handleArg === undefined ? undefined : resolveKnown(current, handleArg, ["ledger"], "a Ledger record");
        const previous = updateTarget === undefined ? undefined : current.ledger.find((entry) => entry.id === updateTarget.id);
        if (updateTarget !== undefined && previous === undefined) {
          throw new Error(`The handle ${normalizeHandle(handleArg ?? "")} does not name a Ledger record.`);
        }
        const id = previous?.id ?? `ledger:${api.callId}`;
        const next = await brain.apply(
          {
            kind: "ledger.upsert",
            entry: {
              id,
              kind: args.kind,
              text: args.text,
              status: args.status,
              answer: args.answer === undefined ? null : { text: args.answer },
              createdAt: previous?.createdAt ?? api.now(),
              updatedAt: api.now(),
            },
          },
          api.now(),
        );
        pendingWrite(session, { kind: "ledger", action: previous === undefined ? "create" : "update", id });
        return textOutput(`Ledger ${handleOf(next.handles, "ledger", id) ?? "record"} saved.`);
      },
    }),

    defineTool({
      name: "pin",
      description:
        "Pin or remove one Brain record — “keep it here”. A pin is a marker on the entry; no reason or source. Pinned records stay close at collapse. A pin placed by the agent is the agent's; the person may remove any pin, but the agent may not remove a pin the person placed. Unpin by handle.",
      parameters: obj({
        action: oneOf(["pin", "unpin"] as const),
        handle: HandleRef,
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = await brain.read();
        const target = resolveKnown(current, args.handle, ["ledger", "chat", "atlas"], "a Brain record");
        const kind = target.kind as "ledger" | "chat" | "atlas";
        const record =
          kind === "ledger"
            ? current.ledger.find((entry) => entry.id === target.id)
            : kind === "atlas"
              ? current.atlas.find((node) => node.id === target.id)
              : current.chat.find((entry) => entry.id === target.id);
        if (args.action === "pin" && record?.pinned === "user") {
          throw new Error(`${normalizeHandle(args.handle)} is pinned by the person — the agent may not take the person's pin.`);
        }
        if (args.action === "unpin" && record?.pinned === "user") {
          throw new Error(`${normalizeHandle(args.handle)} is pinned by the person — only the person may remove it; leave it alone.`);
        }
        await brain.apply(
          { kind: "pin.set", target: kind, id: target.id, pinned: args.action === "pin" ? "agent" : null },
          api.now(),
        );
        pendingWrite(session, { kind, action: args.action, id: target.id });
        const placed = args.action === "pin";
        const note =
          placed && record?.pinned === "agent"
            ? `${normalizeHandle(args.handle)} was already pinned by you.`
            : placed
              ? `Pinned ${normalizeHandle(args.handle)}.`
              : record?.pinned === "agent"
                ? `Unpinned ${normalizeHandle(args.handle)}.`
                : `${normalizeHandle(args.handle)} was not pinned.`;
        return textOutput(note);
      },
    }),

    defineTool({
      name: "read",
      description: "Read a file inside the project root. Omit both startLine and endLine to read the whole file; pass startLine only to read from that line to the end of the file; pass endLine only to read from line 1 through that line; pass both to read a line range. Returns the path, the range, the total lines, and the excerpt.",
      parameters: obj({
        path: str({ minLength: 1 }),
        startLine: opt(int({ minimum: 1 })),
        endLine: opt(int({ minimum: 1 })),
      }),
      replay: "safe",
      execute: async (args) => {
        const range = await readRange(root, args.path, args.startLine, args.endLine);
        return textOutput(
          `${range.path}:${range.startLine}-${range.endLine} (of ${range.totalLines} lines)\n\n${range.excerpt}`,
        );
      },
    }),

    defineTool({
      name: "edit",
      description:
        "Apply one atomic edit to a path inside the project. To create a file, pass oldText \"\" (its parent directory must exist). To change one, pass the exact text to replace — it must appear exactly once.",
      parameters: obj({
        path: str({ minLength: 1 }),
        oldText: str(),
        newText: str(),
      }),
      replay: "unsafe",
      execute: async (args) => {
        const result = await applyAtomicEdit(root, args.path, args.oldText, args.newText);
        return textOutput(result.outcome === "created" ? `Created ${result.path} (${result.bytes} bytes).` : `Edited ${result.path} (${result.bytes} bytes).`);
      },
    }),

    defineTool({
      name: "tree",
      description:
        "Set the anchor and depth of the project tree in your state block. The anchor stays inside the project and never inside `.brain` or `.git`; `.brain` and `.git` are never listed. Move it where your attention is. Depth 0 shows only the anchor line. The tree marks files an Atlas node links.",
      parameters: obj({
        anchor: opt(str({ minLength: 1 })),
        depth: opt(int({ minimum: 0 })),
      }),
      replay: "safe",
      execute: async (args) => {
        const anchor = args.anchor ?? session.tree.anchor;
        const depth = args.depth ?? session.tree.depth;
        const block = projectTreeBlock(root, anchor, depth, await brain.read());
        session.tree = { anchor: block.root, depth: block.depth };
        return textOutput(`tree: ${block.root} (depth ${block.depth})`);
      },
    }),

    defineTool({
      name: "collapse",
      description:
        "End this context and rebuild it from the Brain. Rare, and never for ordinary work: call this when the map and the books have diverged past what the context can work with. No approval is involved, from either side. Chat anything the person must see first.",
      parameters: obj({ reason: str({ minLength: 1 }) }),
      replay: "safe",
      execute: async (args) => {
        session.collapseRequested = args.reason.trim();
        return { output: [{ type: "text" as const, text: `Collapse noted: ${args.reason.trim()}. This run ends; the context rebuilds from the Brain.` }], control: { terminate: true } };
      },
    }),

    defineTool({
      name: "sleep",
      description: "End the run. There is nothing left to do until the person says otherwise.",
      parameters: obj({}),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text" as const, text: "Carto is asleep." }], control: { terminate: true } }),
    }),
  ];
}
