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

import { arr, bool, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool, InboxDoc } from "@earendil-works/pi-durable";
// The file tools are the package's, not a layer beside them (§7): scoping is
// the env's cwd, and the two things Carto adds are the `.brain` wall and the
// existence check on `create` that the package's `write` does not offer.
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { getOrThrow } from "@earendil-works/pi-durable/env";

import type { CartoBrain, Attachment, PinnedEphemeral } from "../domain/records.js";
import type { PromptItem } from "../ui/prompt-handles.js";
import { findByHandle, handleOf } from "../domain/handles.js";
import { projectTreeBlock, type TreeHandles } from "./project-tree.js";
import type { BrainStore } from "./brain-store.js";
import { assertFileScope, lexicalProjectPath, type PathScope } from "./workspace.js";
import { RestCallDoc, RestDoc, SleepTask } from "./sleep-task.js";
import type { PendingWrite } from "../domain/state-block.js";
import {
  createJobTable,
  formatExit,
  readJob,
  sendJob,
  startJob,
  stopJob,
  type JobActionResult,
  type JobTable,
} from "./jobs.js";

export interface ToolSession {
  /**
   * What the agent calls the person: the configured name, or the account that
   * launched Carto. Every string a tool shows the agent names this person.
   */
  person: string;
  /** Pending Brain writes since the last rebuild; ephemeral, cleared at collapse. */
  pending: PendingWrite[];
  /** Where the state block renders the tree. */
  tree: { anchor: string; depth: number; limit?: number; offset?: number };
  /** Handles in the last state block actually sent to the agent. */
  requestTreeHandles?: TreeHandles;
  /** Set by the collapse tool; the host ends the generation and rebuilds when the run settles. */
  collapseRequested: string | null;
  /** Who triggered the pending collapse request (`agent` tool call vs forced `automatic` limit). */
  collapseTrigger?: "agent" | "automatic" | null;

  /** Edit mode or read only mode (§6.1). The person sets it; `create` and `edit` refuse in read only mode. */
  readOnly: boolean;
  /** Strict keeps file tools in the project; relaxed lets read/edit use outside paths. */
  pathScope?: PathScope;
  /** The generation this context belongs to; recorded on context-sourced pins. */
  generation: string;
  /** The frozen head's X namespace, and the items exposed in the last request. */
  headEphemeraCount?: number;
  headEphemera?: Map<string, PinnedEphemeral>;
  liveEphemera?: Map<string, PinnedEphemeral>;
  loadPromptItems?: () => Promise<PromptItem[]>;
  refreshHeadEphemera?: () => Promise<void>;
}

export interface ToolDeps {
  root: string;
  brain: BrainStore;
  session: ToolSession;
  jobs?: JobTable;
}

function formatJobResult(verb: string, result: JobActionResult): string {
  const state =
    result.status === "running"
      ? result.settled
        ? "running"
        : "running (still active)"
      : `exited(${formatExit(result.exitCode, result.exitSignal)})`;
  const header = `${verb} ${result.handle} "${result.label}" [${state}]`;
  const note =
    result.omittedLines > 0
      ? `\n(${result.omittedLines} older buffered line${result.omittedLines === 1 ? "" : "s"} dropped)`
      : "";
  if (result.output.length === 0) return `${header}${note}`;
  return `${header}${note}\n${result.output}`;
}

// §1 and §2.5: no length limit the person did not set. An empty entry is the
// agent's own business — the prompt asks it to size what it writes — so these
// are plain strings and nothing here refuses on a count of characters.
const Text = str();
const HandleRef = str();
/** A handle is what a handle-taking tool acts on, so it cannot be empty (§1). */
const ExistingHandle = str({ minLength: 1, description: "A handle from your context, such as A3, L1, C2, F4." });

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
  const handles = session.requestTreeHandles ?? projectTreeBlock(root, session.tree.anchor, session.tree.depth, brain, session.tree).handles;
  for (const [path, named] of handles) if (named === handle) return path;
  return undefined;
}

/** Wrap the package environment at the actual filesystem operations, after Pi
 * has normalized paths and selected read-path variants. Shell is unaffected. */
function fileToolApi<T extends ToolExecutionApi>(api: T, root: string, scope: PathScope): T {
  const env = api.env;
  if (env === undefined) return api;
  const operations = new Set(["exists", "openBinaryReader", "fileInfo", "readTextFile", "writeFile"]);
  const scoped = new Proxy(env, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "absolutePath") {
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args) as { ok: boolean; value?: string };
          if (result.ok && result.value !== undefined) assertFileScope(root, result.value, scope);
          return result;
        };
      }
      if (typeof key === "string" && operations.has(key)) {
        return (path: string, ...args: unknown[]) => {
          assertFileScope(root, path, scope);
          return Reflect.apply(value, target, [path, ...args]);
        };
      }
      return value.bind(target);
    },
  });
  return new Proxy(api, {
    get(target, key) {
      if (key === "env") return scoped;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Resolve against what was sent, not a new scan whose numbering may have changed. */
function fileToolPath(path: string, session: ToolSession): string {
  if (!/^F\d+$/i.test(path) || session.requestTreeHandles === undefined) return path;
  for (const [candidate, handle] of session.requestTreeHandles) {
    if (handle === path.toUpperCase()) return candidate;
  }
  throw new Error(`${path} is not a file handle in the last state block.`);
}

/**
 * `read`, from the package, with Carto's `.brain` wall in front of it. The
 * arguments are the package's — a path, an offset, and a limit — and the
 * package's own bounds are the tool's bounds (§1). `wrapTool` keeps the
 * package tool's types, so nothing here restates its schema.
 */
function scopedRead(root: string, session: ToolSession): ToolRegistration {
  const base = createReadTool();
  return defineTool({
    ...base,
    // The package's sentence states the tool's own bounds (§1) and stays; what
    // Carto adds is how the file is named and how to keep reads slim.
    description: `${base.description ?? ""} Name the file by its tree handle or a path; strict scope stays in the project, relaxed scope permits outside paths. Use \`offset\` and \`limit\` to read only the slice you need. Read before writing about or editing a file.`,
    async execute(args, api, context) {
      const path = fileToolPath(pathOf(args), session);
      return base.execute({ ...args, path }, fileToolApi(api, root, session.pathScope ?? "strict"), context);
    },
  });
}

/**
 * `edit`, from the package: ordered replacements matched against the original
 * file, all or nothing, and a path that must be an existing file. Creating is
 * `create`'s job, so the package tool's behaviour is the spec's (§7).
 */
function scopedEdit(root: string, session: ToolSession, readOnly: () => boolean): ToolRegistration {
  const base = createEditTool();
  return defineTool({
    ...base,
    // The package's sentence states the tool's own bounds (§1) and stays; what
    // Carto adds is how the file is named, atomic pacing, and read-only mode.
    description: `${base.description ?? ""} Name the file by its tree handle or a path; strict scope stays in the project, relaxed scope permits outside paths (must already exist; use \`create\` for a new file). Aim for one atomic change per step (a function, a value, or a small block) after reading the part you are changing. All replacements match the current file and apply all-or-nothing. Refused in read only mode.`,
    async execute(args, api, context) {
      refuseWhenReadOnly(readOnly());
      const path = fileToolPath(pathOf(args), session);
      return base.execute({ ...args, path }, fileToolApi(api, root, session.pathScope ?? "strict"), context);
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
      "Create a new file at a path that is free, starting with minimal boilerplate or a clean skeleton (types, signatures, stubs) so you can grow it incrementally with `edit`. Never overwrites an existing path; parent directories are made as needed. Refused in read only mode.",
    async execute(args, api, context) {
      refuseWhenReadOnly(readOnly());
      const path = pathOf(args);
      const scoped = fileToolApi(api, envRoot, "strict");
      const env = scoped.env;
      if (env === undefined) throw new Error("create needs the project environment");
      // Match the package's path normalization before checking for overwrite.
      const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
      const absolute = getOrThrow(await env.absolutePath(normalized, context));
      if (getOrThrow(await env.exists(absolute, context))) {
        throw new Error(`${path} already exists, and creating a file never overwrites one. Change it with \`edit\`, or choose a path that is free.`);
      }
      return write.execute({ ...args, path: absolute }, scoped, context);
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
      "The project is in read only mode: you make no edit and no other destructive change while it is on. Read, answer, and say what you would change when you are asked for it. There is nothing to queue or to ask permission for.",
    );
  }
}

export function createTools(deps: ToolDeps): ToolRegistration[] {
  const { root, brain, session } = deps;
  const jobs = deps.jobs ?? createJobTable({ root });
  // Said once, then read from here: a tool description is something the agent
  // reads, so it names the person it works for rather than a role.
  const them = session.person;

  return [
    defineTool({
      name: "chat",
      description:
        `Say something to ${them}. This is the only channel ${them} sees; your plain text is private reasoning. Speak plainly when you have a result, question, or decision. No call is needed on quiet working turns.`,
      parameters: obj({ text: Text }),
      replay: "safe",
      execute: async (args, api) => {
        const id = `chat:${api.callId}`;
        await brain.apply({ kind: "chat.record", record: { id, author: "agent", text: args.text, createdAt: api.now(), updatedAt: api.now() } }, api.now());
        pendingWrite(session, { kind: "chat", action: "record", id });
        return textOutput(`Said to ${them}.`);
      },
    }),

    defineTool({
      name: "atlas",
      description:
        "Create or update an Atlas node: either lasting project understanding or a node in your task/plan graph (goals linked to steps down to atomic leaves, worked leaves-before-stems, attached to the files they touch). Pass `handle` to update an existing node in place as work progresses; omit `handle` for a new node. Links and attachments replace the existing set on update, and nodes need not connect to anything.",
      parameters: obj({
        handle: opt(HandleRef),
        title: str({ description: "The node's name: what this understanding or task node is about." }),
        text: Text,
        links: opt(arr(HandleRef)),
        attachments: opt(
          arr(
            union([
              obj({ kind: lit("file"), path: str() }),
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
        `Create or update a lightweight Ledger record (goal, note, question, instruction, or progress) holding your active working state: current leaf, what is solved, open questions, and live progress. Pass \`handle\` to update an existing record in place as you go so a collapse at any moment preserves where you are; omit \`handle\` for a new record. A question takes \`answer\` and \`status\` so answering one ${them} asked uses the same call.`,
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
        `Pin or unpin a file or an ephemeral item by its handle (at least 1 character). Use F for files, X for working, U for messages, and R or S for results. Pinned files and read results are re-read at collapse; other pinned items retain their text. Only ${them} can remove a pin ${them} placed.`,
      parameters: obj({
        action: oneOf(["pin", "unpin"] as const),
        handle: ExistingHandle,
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = await brain.read();
        // A file is pinned by the handle the tree gave it (§5.1, §5.4): pinning
        // a file means "read it again every collapse", which is how the head
        // holds the file rather than a quotation of a read of it.
        const named = normalizeHandle(args.handle);
        const item = session.headEphemera?.get(named) ?? session.liveEphemera?.get(named);
        if (item !== undefined) {
          // A request's handle names the exact item shown in that request, not
          // whatever happens to take its number after a later edit.
          if (!session.headEphemera?.has(named) && session.loadPromptItems !== undefined) {
            const stillVisible = (await session.loadPromptItems()).some((candidate) => candidate.item?.id === item.id);
            if (!stillVisible) throw new Error(`${named} is no longer in the live context.`);
          }
          const held = current.ephemera.find((candidate) => candidate.id === item.id);
          if (args.action === "pin" && current.ephemeralDeletes?.includes(item.id)) throw new Error(`${named} is marked for deletion; the person must withdraw that mark before it can be kept.`);
          if (held?.pinned === "user") throw new Error(`${named} carries ${them}'s pin, and only ${them} can remove it.`);
          if (args.action === "unpin") {
            if (held !== undefined) await brain.apply({ kind: "ephemeral.unpin", id: item.id, author: "agent" }, api.now());
            return textOutput(`${named} is unpinned; it will not be carried through the next collapse.`);
          }
          // Resolve a read by F handle while the tree still identifies that
          // path; collapse must reread the file, not a transient F number.
          const path = item.kind === "readResult" ? item.entity?.path : undefined;
          const resolved = path === undefined ? undefined : treePathOf(root, current, session, normalizeHandle(path)) ?? path;
          const pinned: PinnedEphemeral = { ...item, pinned: "agent", ...(item.entity === undefined ? {} : { entity: { ...item.entity, ...(resolved === undefined ? {} : { path: resolved }) } }) };
          await brain.apply({ kind: "ephemeral.pin", item: pinned }, api.now());
          return textOutput(`${named} is pinned; it will be carried into the next context.`);
        }
        const filePath = treePathOf(root, current, session, named);
        if (filePath !== undefined) {
          const held = current.files.find((file) => file.path === filePath);
          if (held?.pinned === "user") {
            throw new Error(
              `${named} carries ${them}'s pin, and a pin ${them} placed is theirs to remove. Leave it where it is.`,
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
        throw new Error(
          `${named} is not a file in the tree or a visible ephemeral item. Brain records stay until marked for archive or deletion.`,
        );
      },
    }),

    defineTool({
      name: "mark",
      description:
        `Mark a Brain record by handle (at least 1 character) for \`archive\` or \`delete\` at the next collapse, or \`none\` to withdraw your own mark. Use this to retire finished task-leaves and obsolete notes so the Brain stays sharp; when marking for \`delete\`, tell ${them} in \`chat\` first. Only ${them} can withdraw a mark ${them} placed.`,
      parameters: obj({
        handle: ExistingHandle,
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
              `${normalizeHandle(args.handle)} is marked by ${them}, and only ${them} withdraws that mark. Leave it; it is applied at the next collapse.`,
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

    scopedRead(root, session),

    scopedEdit(root, session, () => session.readOnly),

    createFile(root, () => session.readOnly),

    defineTool({
      name: "tree",
      description:
        "Move the `<carto-state>` project tree to a directory (by `D` handle or path) and optional `depth`, ending this turn so the refreshed tree arrives immediately as your next turn. The scan stops at depth 64 or 2000 encountered entries; >= sizes are partial. The state block pages the scanned entries: use offset from its next-page notice, or anchor at a directory. Pages may change as the filesystem changes. Files in the tree carry handles you can pass to `read`, `edit`, and `pin`, alongside attached Atlas handles.",
      parameters: obj({
        handle: opt(str({ description: "A directory's handle from the tree, such as D2. The tree anchors there." })),
        anchor: opt(str()),
        depth: opt(int({ description: "How many levels below the anchor to render. One is the anchor's own contents, and less than one renders the same as one." })),
        offset: opt(int({ description: "A non-negative, zero-based offset into the scanned entries; use the next offset in the state block to see another page." })),
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
        const offset = args.offset ?? (args.handle !== undefined || args.anchor !== undefined || args.depth !== undefined ? 0 : (session.tree.offset ?? 0));
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("tree offset must be a non-negative integer.");
        const block = projectTreeBlock(root, anchor, depth, await brain.read(), { ...session.tree, offset });
        session.tree = { anchor: block.root, depth: block.depth, offset: block.page.offset,
          ...(session.tree.limit === undefined ? {} : { limit: session.tree.limit }) };
        // The tree itself is not the result (§6.3): it ends the turn, and the
        // state block — rendered at this anchor — is the next turn. So the agent
        // sees the tree it just asked for instead of acting on the last one.
        // Pi's after-run task queues that next turn, including when this run
        // was itself a continuation or came from a timed rest.
        return {
          output: [
            {
              type: "text" as const,
              text: `Anchored at ${block.root}, depth ${block.depth}, offset ${block.page.offset}. This turn ends here, and the tree is in your state block as your next turn.`,
            },
          ],
          control: { terminate: true },
        };
      },
    }),

    defineTool({
      name: "collapse",
      description:
        `End this context and rebuild cleanly from the Brain and pinned files. Use naturally at boundaries (after mapping a plan into Atlas and pinning active files, after finishing a leaf, or before starting new work) as well as when context fills. Always include \`message\` (at least 1 character): a brief Chat update to ${them} explaining why you are collapsing and what comes next. Update Atlas/Ledger before calling; everything unpinned outside the Brain is swept.`,
      parameters: obj({
        message: str({
          minLength: 1,
          description: `Brief Chat message to ${them} explaining why you are collapsing and what comes next (at least 1 character).`,
        }),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const message = args.message.trim();
        if (message.length === 0) {
          throw new Error(`\`collapse\` requires a non-empty \`message\` for ${them} explaining why you are collapsing and what comes next.`);
        }
        const id = `chat:${api.callId}`;
        const existing = await brain.read();
        if (!existing.chat.some((record) => record.id === id)) {
          await brain.apply(
            { kind: "chat.record", record: { id, author: "agent", text: message, createdAt: api.now(), updatedAt: api.now() } },
            api.now(),
          );
          pendingWrite(session, { kind: "chat", action: "record", id });
        }
        session.collapseRequested = "the agent collapsed";
        session.collapseTrigger = "agent";
        return {
          output: [{ type: "text" as const, text: `Said to ${them}. This run ends here. The context rebuilds from the Brain, and the state block is your next turn.` }],
          control: { terminate: true },
        };
      },
    }),

    defineTool({
      name: "sleep",
      description:
        `Last resort: end the turn and rest only after you have thoroughly exercised and verified your work and can find nothing else to fix, probe, or improve. Omit \`seconds\` to rest until ${them} messages you, or pass whole seconds (at least 1) to wake on your own from \`<carto-state>\`. A message from ${them} wakes you early.`,
      parameters: obj({ seconds: opt(int({ minimum: 1, description: `Whole seconds to rest before starting again. Omit to rest until ${them} messages you.` })) }),
      replay: "safe",
      execute: async (args, api, context) => {
        if (args.seconds === undefined) {
          // No time: stop, and stay stopped until the person says something. A
          // turn from the person is the only thing that starts the next run, so
          // nothing is stored and nothing is pending (§10).
          return { output: [{ type: "text" as const, text: `Resting until ${them} messages you.` }], control: { terminate: true } };
        }
        // The receipt and the conversation-owned task are committed together.
        // A replay after a crash cannot create a second timed rest. If a person
        // already queued a line for this boundary, it ends this rest instead.
        const seconds = args.seconds;
        await api.commit(async (tx) => {
          const receipt = await tx.doc(RestCallDoc, api.taskId);
          if (receipt.handled) return;
          const rest = await tx.doc(RestDoc, api.conversationId);
          const inbox = await tx.doc(InboxDoc, api.conversationId);
          // Any queued input already starts or continues a turn. Do not
          // distinguish by content: a person's text may equal the marker.
          const hasInput = inbox.items.some((item) => item.mode !== "write");
          rest.legacyAllowed = false;
          if (!hasInput) {
            rest.active = await tx.createTask(SleepTask, { seconds, tracked: true }, { ownership: { kind: "conversation" }, background: true });
          } else {
            rest.active = null;
          }
          receipt.handled = true;
        }, context);
        return {
          output: [{ type: "text" as const, text: `Resting ${args.seconds} second${args.seconds === 1 ? "" : "s"}, then starting again from the state block.` }],
          control: { terminate: true },
        };
      },
    }),

    defineTool({
      name: "proc",
      description:
        `Run and drive persistent piped processes (REPLs, dev servers, interactive testing harnesses) in the project root that stay alive across turns and context collapse until stopped or Carto exits. Actions: "start" spawns \`command\` (optional \`label\`, \`waitMs\` default 1000, max 30000, pass 0 to return immediately) and returns a J handle; "send" writes \`input\` to stdin (newline appended unless \`raw\` is true) or sends \`signal\` ("SIGINT" or "SIGTERM") to \`handle\`; "read" returns unread output since the last read (or the last \`tailLines\` lines, from 1 up to 2000, optional \`waitMs\` default 0, max 30000); "stop" terminates \`handle\` and removes it. \`start\` and \`send\` settle after 150ms of quiet output (capped at \`waitMs\`) and return without killing the process if it stays active. Output is buffered up to 2000 lines per job and shared live with ${them} in the jobs view. Not sandboxed in read only mode, where what stops a command that writes is you.`,
      parameters: obj({
        action: oneOf(["start", "send", "read", "stop"], {
          description: 'Operation to perform: "start", "send", "read", or "stop".',
        }),
        handle: opt(str({ description: 'Job handle such as "J1". Required for "send", "read", and "stop".' })),
        command: opt(str({ description: 'Shell command to start in the project root. Required for "start".' })),
        label: opt(str({ description: 'Short display label for the job shown in the state block and jobs view. Optional for "start".' })),
        input: opt(str({ description: 'Text to write to stdin for "send". A trailing newline is added unless `raw` is true.' })),
        raw: opt(bool({ description: 'When true, send `input` verbatim without adding a trailing newline.' })),
        signal: opt(oneOf(["SIGINT", "SIGTERM"], { description: 'Signal to send to the job process group during "send".' })),
        waitMs: opt(int({
          maximum: 30000,
          description: 'Max milliseconds to wait for quiet output (150ms idle settle, max 30000). Defaults to 1000 for "start"/"send" and 0 for "read". Pass 0 or less to return immediately.',
        })),
        tailLines: opt(int({
          minimum: 1,
          maximum: 2000,
          description: 'For "read", return the last N buffered lines (1 to 2000) instead of only unread output.',
        })),
      }),
      replay: "unsafe",
      execute: async (args, _api, context) => {
        const waitMs = args.waitMs === undefined ? undefined : Math.max(0, args.waitMs);
        if (args.action === "start") {
          if (args.command === undefined || args.command.trim().length === 0) {
            throw new Error('`proc` with action "start" requires a non-empty `command`.');
          }
          const result = await startJob(jobs, {
            command: args.command,
            ...(args.label === undefined ? {} : { label: args.label }),
            ...(waitMs === undefined ? {} : { waitMs }),
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          });
          return { output: [{ type: "text" as const, text: formatJobResult("Started", result) }] };
        }
        if (args.handle === undefined || args.handle.trim().length === 0) {
          throw new Error(`\`proc\` with action "${args.action}" requires \`handle\`.`);
        }
        if (args.action === "send") {
          if (args.input === undefined && args.signal === undefined) {
            throw new Error('`proc` with action "send" requires `input` or `signal`.');
          }
          const result = await sendJob(jobs, {
            handle: args.handle,
            ...(args.input === undefined ? {} : { input: args.input }),
            ...(args.raw === undefined ? {} : { raw: args.raw }),
            ...(args.signal === undefined ? {} : { signal: args.signal }),
            ...(waitMs === undefined ? {} : { waitMs }),
            ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
            source: "agent",
          });
          return { output: [{ type: "text" as const, text: formatJobResult("Sent to", result) }] };
        }
        if (args.action === "read") {
          const result = await readJob(jobs, {
            handle: args.handle,
            ...(waitMs === undefined ? {} : { waitMs }),
            ...(args.tailLines === undefined ? {} : { tailLines: args.tailLines }),
            ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
          });
          return { output: [{ type: "text" as const, text: formatJobResult("Read", result) }] };
        }
        const result = await stopJob(jobs, args.handle);
        return { output: [{ type: "text" as const, text: formatJobResult("Stopped", result) }] };
      },
    }),
  ];
}
