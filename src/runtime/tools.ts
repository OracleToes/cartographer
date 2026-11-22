/**
 * The product tools (§7).
 *
 * Plain model text is not Chat. Every tool is scoped and unique; the tool
 * descriptions are the authority on what each does. A Brain write appears
 * here as the tool's result and as a pending-change line in the state
 * block — never as a projection patch (§5.6).
 */
import { arr, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
// The file tools are the package's, not a layer beside them (§7): scoping is
// the env's cwd, and the two things Carto adds are the `.brain` wall and the
// existence check on `create` that the package's `write` does not offer.
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { getOrThrow } from "@earendil-works/pi-durable/env";

import type { CartoBrain, Attachment } from "../domain/records.js";
import { findByHandle, handleOf } from "../domain/handles.js";
import { projectTreeBlock } from "./project-tree.js";
import type { BrainStore } from "./brain-store.js";
import { lexicalProjectPath, refuseBrainPath } from "./workspace.js";
import type { PendingWrite } from "../domain/state-block.js";

export interface ToolSession {
  /** Pending Brain writes since the last rebuild; ephemeral, cleared at collapse. */
  pending: PendingWrite[];
  /** Where the state block renders the tree. */
  tree: { anchor: string; depth: number };
  /** Set by the collapse tool; the host ends the generation and rebuilds when the run settles. */
  collapseRequested: string | null;
  /** Set by a timed `sleep`: whole seconds to rest before the host starts the next run. Cleared when read. */
  sleepSeconds: number | undefined;
  /** Edit mode or read only mode (§6.1). The person sets it; `create` and `edit` refuse in read only mode. */
  readOnly: boolean;
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

/** One Brain record by handle, and the kind it lives under. */
function resolveRecord(
  brain: CartoBrain,
  handle: string,
): { kind: "ledger" | "chat" | "atlas"; id: string; mark?: { action: string; author: "user" | "agent" }; pinned?: "user" | "agent" } {
  const target = resolveKnown(brain, handle, ["ledger", "chat", "atlas"], "a Brain record");
  const kind = target.kind as "ledger" | "chat" | "atlas";
  const record =
    kind === "ledger"
      ? brain.ledger.find((entry) => entry.id === target.id)
      : kind === "atlas"
        ? brain.atlas.find((node) => node.id === target.id)
        : brain.chat.find((entry) => entry.id === target.id);
  if (record === undefined) throw new Error(`The handle ${normalizeHandle(handle)} does not name a Brain record.`);
  return {
    kind,
    id: target.id,
    ...(record.mark === undefined ? {} : { mark: record.mark }),
    ...(record.pinned === undefined ? {} : { pinned: record.pinned }),
  };
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

/**
 * The path a file tool is about to touch, resolved against the project root:
 * `.brain` is refused here, before the package's tool sees it. Paths outside
 * the root are the env's business — its cwd is the root, and its own
 * `absolutePath` refuses what escapes it.
 */
function guardedPath(root: string, path: string): void {
  const absolute = lexicalProjectPath(root, path);
  refuseBrainPath(root, absolute);
}

/**
 * `read`, from the package, with Carto's `.brain` wall in front of it. The
 * arguments are the package's — a path, an offset, and a limit — and the
 * package's own bounds are the tool's bounds (§1). `wrapTool` keeps the
 * package tool's types, so nothing here restates its schema.
 */
function scopedRead(root: string): ToolRegistration {
  const base = createReadTool();
  return defineTool({
    ...base,
    async execute(args, api, context) {
      guardedPath(root, pathOf(args));
      return base.execute(args, api, context);
    },
  });
}

/**
 * `edit`, from the package: ordered replacements matched against the original
 * file, all or nothing, and a path that must be an existing file. Creating is
 * `create`'s job, so the package tool's behaviour is the spec's (§7).
 */
const scopedEdit = (root: string, readOnly: () => boolean) =>
  defineTool({
    ...createEditTool(),
    async execute(args, api, context) {
      refuseWhenReadOnly(readOnly());
      guardedPath(root, pathOf(args));
      const base = createEditTool();
      return base.execute(args, api, context);
    },
  });

/**
 * `create`: a file that must not exist. The package's `write` creates or
 * overwrites; refusing the overwrite is the one check Carto adds (§7).
 */
function createFile(envRoot: string, readOnly: () => boolean): ToolRegistration {
  const write = createWriteTool();
  return defineTool({
    ...write,
    name: "create",
    description:
      "Create a new file. The path must not already exist — overwriting a file is not a step toward a goal and discards text you never read; to change an existing file, use `edit`. Refused in read only mode.",
    async execute(args, api, context) {
      refuseWhenReadOnly(readOnly());
      const path = pathOf(args);
      const env = api.env;
      if (env === undefined) throw new Error("create needs the project environment");
      guardedPath(envRoot, path);
      const absolute = getOrThrow(await env.absolutePath(path, context));
      if (getOrThrow(await env.exists(absolute, context))) {
        throw new Error(`${path} already exists; change it with 'edit', or choose a new path.`);
      }
      return write.execute(args, api, context);
    },
  });
}

/** The `path` argument of a file tool, as a string. */
const pathOf = (args: object): string => String((args as { path?: unknown }).path ?? "");

/**
 * Read only mode is enforced at `create` and `edit` and nowhere else (§6.1).
 * The tools stay offered — withholding them would re-define the schema, and
 * the head is frozen — so the refusal is what the agent meets.
 */
function refuseWhenReadOnly(readOnly: boolean): void {
  if (readOnly) {
    throw new Error(
      "The project is in read only mode: you may not make edits or any other destructive change. Read, answer, and say what you would change if you were asked.",
    );
  }
}

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
      name: "mark",
      description:
        "Mark one Brain record for archive or delete, or withdraw a mark. A mark applies at the next collapse: a marked entry stays in the context until then, and marking again with a different action replaces it. Pass action \"none\" to withdraw a mark you placed. You may not withdraw a mark the person placed, only your own.",
      parameters: obj({
        handle: HandleRef,
        action: oneOf(["archive", "delete", "none"] as const),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = await brain.read();
        const target = resolveRecord(current, args.handle);
        if (target.mark?.author === "user" && args.action === "none") {
          throw new Error(`${normalizeHandle(args.handle)} is marked by the person — only the person may withdraw that mark; leave it alone.`);
        }
        if (args.action === "none") {
          await brain.apply({ kind: "mark.clear", target: target.kind, id: target.id }, api.now());
          pendingWrite(session, { kind: target.kind, action: "unmark", id: target.id });
          return textOutput(`Withdrew the mark on ${normalizeHandle(args.handle)}.`);
        }
        await brain.apply({ kind: "mark.set", target: target.kind, id: target.id, action: args.action, author: "agent" }, api.now());
        pendingWrite(session, { kind: target.kind, action: `mark ${args.action}`, id: target.id });
        return textOutput(`Marked ${normalizeHandle(args.handle)} for ${args.action}. It applies at the next collapse.`);
      },
    }),

    scopedRead(root),

    scopedEdit(root, () => session.readOnly),

    createFile(root, () => session.readOnly),

    defineTool({
      name: "tree",
      description:
        "Set the anchor and depth of the project tree in your state block. Both are optional: the anchor defaults to the project root, the depth to 2. A depth of 1 is the anchor and its immediate contents; anything below 1 renders the same as 1. The anchor stays inside the project and never inside `.brain` or `.git`; `.brain` and `.git` are never listed. Move it where your attention is. The tree marks the Atlas nodes attached to each file.",
      parameters: obj({
        anchor: opt(str({ minLength: 1 })),
        depth: opt(int({ description: "How many levels below the anchor to render. Defaults to 2." })),
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
        "End this context and rebuild it from the Brain. Collapse at a task boundary: when the work is done and the Brain is current, or before a long piece of work, after pinning what you will need so you start inside a context built for the problem. No approval is involved, from either side. Chat anything the person must see first.",
      parameters: obj({}),
      replay: "safe",
      execute: async () => {
        session.collapseRequested = "the agent collapsed";
        return { output: [{ type: "text" as const, text: "Collapse noted. This run ends; the context rebuilds from the Brain." }], control: { terminate: true } };
      },
    }),

    defineTool({
      name: "sleep",
      description:
        "Rest. With no argument the run ends and stays ended until the person sends you a message. With a whole number of seconds, you rest that long and then start again on your own, reading the state block as your next turn. A message from the person ends a rest early either way.",
      parameters: obj({ seconds: opt(int({ minimum: 1, description: "Whole seconds to rest before starting again. Omit to rest until the person messages you." })) }),
      replay: "safe",
      execute: async (args) => {
        if (args.seconds === undefined) {
          return { output: [{ type: "text" as const, text: "Carto is asleep." }], control: { terminate: true } };
        }
        session.sleepSeconds = args.seconds;
        return {
          output: [{ type: "text" as const, text: `Carto is asleep for ${args.seconds} second${args.seconds === 1 ? "" : "s"}.` }],
          control: { terminate: true },
        };
      },
    }),
  ];
}
