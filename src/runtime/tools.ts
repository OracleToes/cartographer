/**
 * The product tools (§7).
 *
 * Plain model text is not Chat. Every tool is scoped and unique; a tool's own
 * description is the authority on what it does and on any bound it carries
 * (§1, §7). A Brain write appears here as the tool's result and as a line in
 * the state block's record of writes since the rebuild — never as a patch to
 * the frozen projection (§5.6).
 */
import { existsSync, statSync } from "node:fs";

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
    throw new Error(
      `No ${what} here has the handle ${normalizeHandle(handle)}. Handles are minted from what is in your context; take one from there, or leave the handle out to create a new record.`,
    );
  }
  return { kind: found.kind, id: found.id };
}

/** One Brain record by handle, and the kind it lives under. */
function resolveRecord(
  brain: CartoBrain,
  handle: string,
): { kind: "ledger" | "chat" | "atlas"; id: string; mark?: { action: string; author: "user" | "agent" }; pinned?: "user" | "agent" } {
  const target = resolveKnown(brain, handle, ["ledger", "chat", "atlas"], "Brain record");
  const kind = target.kind as "ledger" | "chat" | "atlas";
  const record =
    kind === "ledger"
      ? brain.ledger.find((entry) => entry.id === target.id)
      : kind === "atlas"
        ? brain.atlas.find((node) => node.id === target.id)
        : brain.chat.find((entry) => entry.id === target.id);
  if (record === undefined) {
    throw new Error(`${normalizeHandle(handle)} is not in the Brain any more, so no tool can reach it. Nothing to do: it is gone.`);
  }
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
    throw new Error(
      `No record has the handle ${normalizeHandle(attachment.handle)}. Attach by the handle of a record in your context, or give a file path with \`kind: "file"\`.`,
    );
  }
  return { kind: "record", id: found.id };
}

const textOutput = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });
const errorOutput = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

/**
 * The path a tree handle names, or `undefined` when the handle is not a file's.
 *
 * Files are handled by the tree (§5.4), and the tree is the only place their
 * handles come from, so this walks the same rendering the state block shows. A
 * handle from a different anchor or depth may not be in the map: then it is not
 * a file the agent can see, and nothing here will pretend it is.
 */
function treePathOf(root: string, brain: CartoBrain, session: ToolSession, handle: string): string | undefined {
  const block = projectTreeBlock(root, session.tree.anchor, session.tree.depth, brain);
  for (const [path, named] of block.handles) if (named === handle) return path;
  return undefined;
}

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
    // The package's sentence states the tool's own bounds (§1) and stays; what
    // Carto adds is how the file is named and what the result becomes.
    description: `${base.description ?? ""} The file is named by a handle the tree shows, or by a path inside the project. The result is an item in the context with a handle of its own, and pinning it keeps that reading rather than the file. Read before you write about a file.`,
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
function scopedEdit(root: string, readOnly: () => boolean): ToolRegistration {
  const base = createEditTool();
  return defineTool({
    ...base,
    // The package's sentence states the tool's own bounds (§1) and stays; what
    // Carto adds is how the file is named and what the mode means here.
    description: `${base.description ?? ""} The file is named by a handle the tree shows, or by a path inside the project, and it must already exist: making one is \`create\`'s job. Every replacement is matched against the file as it is now, and the call lands all of them or none. Read the part you are changing first. Read only mode refuses this call.`,
    async execute(args, api, context) {
      refuseWhenReadOnly(readOnly());
      guardedPath(root, pathOf(args));
      return base.execute(args, api, context);
    },
  });
}

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
      "Create a file at a path that is free. It never overwrites: a path that already exists is an error, because changing a file is `edit`'s job and an overwrite would discard text you may never have read. Parent directories are made as needed. Read only mode refuses this call.",
    async execute(args, api, context) {
      refuseWhenReadOnly(readOnly());
      const path = pathOf(args);
      const env = api.env;
      if (env === undefined) throw new Error("create needs the project environment");
      guardedPath(envRoot, path);
      const absolute = getOrThrow(await env.absolutePath(path, context));
      if (getOrThrow(await env.exists(absolute, context))) {
        throw new Error(`${path} already exists, and creating a file never overwrites one. Change it with \`edit\`, or choose a path that is free.`);
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
      "The project is in read only mode: you make no edit and no other destructive change while it is on. Read, answer, and say what you would change when you are asked for it — there is nothing to queue or to ask permission for.",
    );
  }
}

export function createTools(deps: ToolDeps): ToolRegistration[] {
  const { root, brain, session } = deps;

  return [
    defineTool({
      name: "chat",
      description:
        "Say something to the person. This is the only channel that reaches them: your plain text is your own reasoning and they never see it. One thought per call, in your own words, without reporting the call. An empty turn needs no call at all.",
      parameters: obj({ text: Text }),
      replay: "safe",
      execute: async (args, api) => {
        const id = `chat:${api.callId}`;
        await brain.apply({ kind: "chat.record", record: { id, author: "agent", text: args.text, createdAt: api.now(), updatedAt: api.now() } }, api.now());
        pendingWrite(session, { kind: "chat", action: "record", id });
        return textOutput("Said to the person.");
      },
    }),

    defineTool({
      name: "atlas",
      description:
        "Write what you understand about the project: one node, a name and the understanding itself. A node may link to other nodes and may attach to what it is about — a file by path, or a record by handle. Pass a handle to rewrite that node; links and attachments are replaced wholesale, so send the whole set you want. Without a handle it is a new node. Nothing requires a node to connect to anything.",
      parameters: obj({
        handle: opt(HandleRef),
        title: str({ minLength: 1, description: "The node's name: what this understanding is about." }),
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
        const updateTarget = handleArg === undefined ? undefined : resolveKnown(current, handleArg, ["atlas"], "Atlas record");
        const previous = updateTarget === undefined ? undefined : current.atlas.find((node) => node.id === updateTarget.id);
        const id = previous?.id ?? `atlas:${api.callId}`;
        const links = (args.links ?? []).map((link) => resolveKnown(current, link, ["atlas"], "Atlas record").id);
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
        return textOutput(`Atlas node ${handleOf(next.handles, "atlas", id) ?? "(unnamed)"} is written.`);
      },
    }),

    defineTool({
      name: "ledger",
      description:
        "Write one Ledger record: a goal, a note, a question, an instruction, or progress — what you are working on, kept. Pass a handle to rewrite that record; without one it is a new record. A question takes an answer and a status, so answering one the person asked is the same call as writing it. A plan is made of these records: the goal, then one record per step in the order you will take them, with progress naming the step it moved. A plan written here reaches the person in their Ledger, and is in your head at the next collapse without your reading it again.",
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
        const updateTarget = handleArg === undefined ? undefined : resolveKnown(current, handleArg, ["ledger"], "Ledger record");
        const previous = updateTarget === undefined ? undefined : current.ledger.find((entry) => entry.id === updateTarget.id);
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
        return textOutput(`Ledger record ${handleOf(next.handles, "ledger", id) ?? "(unnamed)"} is written.`);
      },
    }),

    defineTool({
      name: "pin",
      description:
        "Pin one entry, or take your pin off it: \"keep this here\". The entry is a Brain record named by its handle, or a file named by the handle the tree gives it; a pinned record goes on into the rebuilt context, and a pinned file is read again at every collapse so the head holds the file as it now stands rather than a reading of it. A pin carries no reason. A pin you place is yours to remove; a pin the person placed is theirs alone, and the state block says who placed each one.",
      parameters: obj({
        action: oneOf(["pin", "unpin"] as const),
        handle: HandleRef,
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = await brain.read();
        // A file is pinned by the handle the tree gave it (§5.1, §5.4): pinning
        // a file means "read it again every collapse", which is how the head
        // holds the file rather than a quotation of a read of it.
        const named = normalizeHandle(args.handle);
        const filePath = treePathOf(root, current, session, named);
        if (filePath !== undefined) {
          const held = current.files.find((file) => file.path === filePath);
          if (held?.pinned === "user") {
            throw new Error(
              `${named} carries the person's pin, and a pin the person placed is theirs to remove. Leave it where it is.`,
            );
          }
          await brain.apply(
            { kind: "file.pin", path: filePath, pinned: args.action === "pin" ? "agent" : null },
            api.now(),
          );
          // A pin is not a Brain write, so it has no pending line: the state
          // block lists pins separately, by handle, and a second line would be
          // the same fact twice.
          return textOutput(
            args.action === "pin"
              ? `${named} is pinned: the head holds this file, read again at every collapse, so you always see it as it is.`
              : `${named} is unpinned: the head stops holding a copy of that file.`,
          );
        }
        const target = resolveKnown(current, args.handle, ["ledger", "chat", "atlas"], "Brain record");
        const kind = target.kind as "ledger" | "chat" | "atlas";
        const record =
          kind === "ledger"
            ? current.ledger.find((entry) => entry.id === target.id)
            : kind === "atlas"
              ? current.atlas.find((node) => node.id === target.id)
              : current.chat.find((entry) => entry.id === target.id);
        if (record?.pinned === "user") {
          throw new Error(
            `${normalizeHandle(args.handle)} carries the person's pin, and a pin the person placed is theirs to remove. Leave it where it is.`,
          );
        }
        await brain.apply(
          { kind: "pin.set", target: kind, id: target.id, pinned: args.action === "pin" ? "agent" : null },
          api.now(),
        );
        pendingWrite(session, { kind, action: args.action, id: target.id });
        const placed = args.action === "pin";
        const was = record?.pinned === "agent";
        const note = placed
          ? was
            ? `${normalizeHandle(args.handle)} was already pinned by you.`
            : `${normalizeHandle(args.handle)} is pinned.`
          : was
            ? `${normalizeHandle(args.handle)} is unpinned.`
            : `${normalizeHandle(args.handle)} carried no pin of yours, so nothing changed.`;
        return textOutput(note);
      },
    }),

    defineTool({
      name: "mark",
      description:
        "Decide what one record is for, or withdraw the decision: `archive` retires it from the Brain, `delete` removes it for good and leaves nothing behind, `none` withdraws a mark of your own. Nothing happens yet — the record stays in the context until the next collapse, and a later mark replaces an earlier one. An archived record leaves the context for good: it is not in your view afterwards and there is nothing to ask for. `delete` is the heavier of the two, so when you mark for delete, tell the person what you are letting go of first. A mark the person placed is theirs to withdraw, so leave it.",
      parameters: obj({
        handle: HandleRef,
        action: oneOf(["archive", "delete", "none"] as const),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = await brain.read();
        const target = resolveRecord(current, args.handle);
        // Withdrawing a mark the person placed is refused by the Brain (§4.1),
        // which is the same rule the person's own operations go through. The
        // refusal is turned into a sentence here, because a tool's error is
        // something the agent reads and acts on.
        if (args.action === "none") {
          try {
            await brain.apply({ kind: "mark.clear", target: target.kind, id: target.id, author: "agent" }, api.now());
          } catch {
            throw new Error(
              `${normalizeHandle(args.handle)} is marked by the person, and only the person withdraws that mark. Leave it; it is applied at the next collapse.`,
            );
          }
          pendingWrite(session, { kind: target.kind, action: "unmark", id: target.id });
          return textOutput(`The mark on ${normalizeHandle(args.handle)} is withdrawn.`);
        }
        await brain.apply({ kind: "mark.set", target: target.kind, id: target.id, action: args.action, author: "agent" }, api.now());
        pendingWrite(session, { kind: target.kind, action: `mark ${args.action}`, id: target.id });
        return textOutput(
          `${normalizeHandle(args.handle)} is marked for ${args.action}. It stays in the context until the next collapse, and another mark before then replaces this one.`,
        );
      },
    }),

    scopedRead(root),

    scopedEdit(root, () => session.readOnly),

    createFile(root, () => session.readOnly),

    defineTool({
      name: "tree",
      description:
        "Move the project tree in your state block to where your attention is. The arguments are optional and stick: an anchor by path, or a directory by the handle the tree gave it, and how many levels below it to render. Every file and directory the tree shows carries its own handle, and a file also carries the handles of the Atlas nodes attached to it. The tree is not returned here; the state block carries it, as `T1`, from your next request on, so set the anchor and read it there.",
      parameters: obj({
        handle: opt(str({ description: "A directory's handle from the tree, such as D2. The tree anchors there." })),
        anchor: opt(str({ minLength: 1 })),
        depth: opt(int({ description: "How many levels below the anchor to render. One is the anchor's own contents, and less than one renders the same as one." })),
      }),
      replay: "safe",
      execute: async (args) => {
        // A directory is addressable by the handle the tree gave it (§5.4), the
        // same way a file is: the tree is one place, and a handle reaches it.
        const named = args.handle === undefined ? undefined : treePathOf(root, await brain.read(), session, normalizeHandle(args.handle));
        // Only a directory can anchor the tree; a file handle is not an anchor.
        const anchoredByHandle =
          named === undefined || !existsSync(named) || !statSync(named).isDirectory() ? undefined : named;
        if (args.handle !== undefined && anchoredByHandle === undefined) {
          throw new Error(
            `${normalizeHandle(args.handle)} is not a directory the tree shows, so there is nothing to anchor there. Take a \`D\` handle from the tree, or name an anchor by path.`,
          );
        }
        const anchor = anchoredByHandle ?? args.anchor ?? session.tree.anchor;
        const depth = args.depth ?? session.tree.depth;
        const block = projectTreeBlock(root, anchor, depth, await brain.read());
        session.tree = { anchor: block.root, depth: block.depth };
        // The tree itself is not the result (§6.3): the state block carries it,
        // rendered at this anchor from the next request on.
        return textOutput(`Anchored at ${block.root}, depth ${block.depth}. The tree is in your state block from the next request on.`);
      },
    }),

    defineTool({
      name: "collapse",
      description:
        "End this context and rebuild it from the Brain. Collapse at a task boundary: the work is finished and the Brain holds it, or a long piece of work is about to start and you have pinned what you will need to begin inside a context built for it. Nothing needs approval from either side. Say anything the person must see first, because this context is about to be gone and whatever you did not write down goes with it.",
      parameters: obj({}),
      replay: "safe",
      execute: async () => {
        session.collapseRequested = "the agent collapsed";
        return {
          output: [{ type: "text" as const, text: "This run ends here. The context rebuilds from the Brain, and the state block is your next turn." }],
          control: { terminate: true },
        };
      },
    }),

    defineTool({
      name: "sleep",
      description:
        "End the turn and rest — the honest way to stop. With no argument you stay stopped until the person messages you. With whole seconds you rest that long, then start again on your own from the state block. Either way a message from the person brings you back sooner. Nothing is said to the person by this call.",
      parameters: obj({ seconds: opt(int({ minimum: 1, description: "Whole seconds to rest before starting again. Omit to rest until the person messages you." })) }),
      replay: "safe",
      execute: async (args) => {
        if (args.seconds === undefined) {
          return { output: [{ type: "text" as const, text: "Resting until the person messages you." }], control: { terminate: true } };
        }
        session.sleepSeconds = args.seconds;
        return {
          output: [{ type: "text" as const, text: `Resting ${args.seconds} second${args.seconds === 1 ? "" : "s"}, then starting again from the state block.` }],
          control: { terminate: true },
        };
      },
    }),
  ];
}
