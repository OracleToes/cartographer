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

import type { SourceRef } from "../domain/records.js";
import { findByHandle, handleOf } from "../domain/handles.js";
import { projectTreeBlock } from "./project-tree.js";
import type { BrainStore } from "./brain-store.js";
import { sha256File } from "./digest.js";
import { applyAtomicEdit, readBoundedRange, resolveProjectPath, runShell, WorkspaceError, MAX_RANGE_LINES } from "./workspace.js";
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

const Text = str({ minLength: 1, maxLength: 24_000 });
const HandleRef = str({ minLength: 1, maxLength: 8 });

const normalizeHandle = (handle: string): string => handle.trim().toUpperCase();

function resolveKnown(brain: ReturnType<BrainStore["read"]>, handle: string, kinds: readonly string[], what: string): { kind: string; id: string } {
  const found = findByHandle(brain.handles, normalizeHandle(handle));
  if (found === undefined || !kinds.includes(found.kind)) {
    throw new Error(`The handle ${normalizeHandle(handle)} does not name ${what}. Use a handle from the current context.`);
  }
  return { kind: found.kind, id: found.id };
}

const pendingWrite = (session: ToolSession, write: PendingWrite): void => {
  session.pending.push(write);
};

const textOutput = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });
const errorOutput = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

export function createTools(deps: ToolDeps): ToolRegistration[] {
  const { root, brain, session } = deps;

  const verifyFileEvidence = async (evidence: { path: string; startLine: number; endLine: number; digest: string; excerpt: string }): Promise<SourceRef> => {
    const real = resolveProjectPath(root, evidence.path);
    const digest = await sha256File(real);
    if (digest === null) throw new WorkspaceError(`cannot read ${evidence.path}`);
    if (digest !== evidence.digest) {
      throw new WorkspaceError(`Evidence for ${evidence.path} changed since it was read. Re-read it with inspect and try again.`);
    }
    return {
      kind: "file",
      path: evidence.path,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      digest,
      excerpt: evidence.excerpt,
      freshness: "fresh",
    };
  };

  return [
    defineTool({
      name: "chat",
      description: "Declare something person-facing. Plain model text is not Chat; this tool is the only channel that reaches the person.",
      parameters: obj({ text: Text }),
      replay: "safe",
      execute: async (args, api) => {
        const id = `chat:${api.callId}`;
        brain.apply({ kind: "chat.record", record: { id, author: "agent", text: args.text, createdAt: api.now(), updatedAt: api.now() } }, api.now());
        pendingWrite(session, { kind: "chat", action: "record", id });
        return textOutput("Chat message saved.");
      },
    }),

    defineTool({
      name: "atlas",
      description:
        "Create or update one source-backed claim about the project, with optional typed edges to other nodes. Pass the handle of an existing node to update it, or leave it out to create one. Evidence is a file range you read with inspect; the digest must still match.",
      parameters: obj({
        handle: opt(HandleRef),
        title: str({ minLength: 1, maxLength: 240 }),
        claim: Text,
        evidence: arr(
          obj({
            path: str({ minLength: 1, maxLength: 4096 }),
            startLine: int({ minimum: 1 }),
            endLine: int({ minimum: 1 }),
            digest: str({ minLength: 1, maxLength: 128 }),
            excerpt: Text,
          }),
          { minItems: 1, maxItems: 12 },
        ),
        edges: opt(
          arr(
            obj({
              kind: oneOf(["replaces", "depends-on", "contradicts"] as const),
              handle: HandleRef,
            }),
            { maxItems: 32 },
          ),
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const evidence = await Promise.all(args.evidence.map(verifyFileEvidence));
        const current = brain.read();
        const handleArg = args.handle;
        const updateTarget = handleArg === undefined ? undefined : resolveKnown(current, handleArg, ["atlas"], "an Atlas record");
        const previous = updateTarget === undefined ? undefined : current.atlas.find((node) => node.id === updateTarget.id);
        if (updateTarget !== undefined && previous === undefined) {
          throw new Error(`The handle ${normalizeHandle(handleArg ?? "")} does not name an Atlas record.`);
        }
        const id = previous?.id ?? `atlas:${api.callId}`;
        const edges = (args.edges ?? []).map((edge) => ({
          kind: edge.kind,
          target: resolveKnown(current, edge.handle, ["atlas"], "an Atlas record").id,
        }));
        const next = brain.apply(
          {
            kind: "atlas.upsert",
            node: {
              id,
              title: args.title,
              claim: args.claim,
              evidence,
              edges,
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
        "Create or update one durable Ledger record: a goal, a note, a question, an instruction, or progress. Pass the handle to update, or leave it out to create. An answer may cite any handles as evidence.",
      parameters: obj({
        handle: opt(HandleRef),
        kind: oneOf(["goal", "note", "question", "instruction", "progress"] as const),
        text: Text,
        status: oneOf(["open", "answered", "closed"] as const),
        answer: opt(Text),
        evidence: opt(arr(HandleRef, { maxItems: 32 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const current = brain.read();
        const handleArg = args.handle;
        const updateTarget = handleArg === undefined ? undefined : resolveKnown(current, handleArg, ["ledger"], "a Ledger record");
        const previous = updateTarget === undefined ? undefined : current.ledger.find((entry) => entry.id === updateTarget.id);
        if (updateTarget !== undefined && previous === undefined) {
          throw new Error(`The handle ${normalizeHandle(handleArg ?? "")} does not name a Ledger record.`);
        }
        const id = previous?.id ?? `ledger:${api.callId}`;
        const resolvedEvidence = (args.evidence ?? []).map((handle) => findByHandle(current.handles, normalizeHandle(handle)));
        const missing = (args.evidence ?? []).filter((_, index) => resolvedEvidence[index] === undefined).map(normalizeHandle);
        if (missing.length > 0) {
          throw new Error(`Unknown handle(s): ${missing.join(", ")}.`);
        }
        const evidenceIds = resolvedEvidence.map((entry) => entry!.id);
        const next = brain.apply(
          {
            kind: "ledger.upsert",
            entry: {
              id,
              kind: args.kind,
              text: args.text,
              status: args.status,
              answer: args.answer === undefined ? null : { text: args.answer, evidenceIds },
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
        "Pin or remove one agent carry pin — “keep this close”. A file source needs exact inspected evidence; a context source keeps a selected current-context item. Pins belong to the layer you pin into: you cannot remove a pin the person set. Remove by handle.",
      parameters: union([
        obj({
          action: lit("add"),
          item: str({ minLength: 1, maxLength: 500 }),
          reason: str({ minLength: 1, maxLength: 1000 }),
          source: union([
            obj({
              kind: lit("file"),
              path: str({ minLength: 1, maxLength: 4096 }),
              startLine: int({ minimum: 1 }),
              endLine: int({ minimum: 1 }),
              digest: str({ minLength: 1, maxLength: 128 }),
              excerpt: Text,
            }),
            obj({ kind: lit("context"), excerpt: Text }),
          ]),
        }),
        obj({ action: lit("remove"), handle: HandleRef }),
      ]),
      replay: "safe",
      execute: async (args, api) => {
        const current = brain.read();
        if (args.action === "remove") {
          const found = findByHandle(current.handles, normalizeHandle(args.handle));
          if (found === undefined || found.kind !== "pin") {
            throw new Error(`The handle ${normalizeHandle(args.handle)} does not name a pin.`);
          }
          if (current.userPins.some((pin) => pin.id === found.id)) {
            throw new Error(`Pin ${normalizeHandle(args.handle)} belongs to the person. Only the person can remove it.`);
          }
          brain.apply({ kind: "pin.remove", id: found.id }, api.now());
          pendingWrite(session, { kind: "pin", action: "remove", id: found.id });
          return textOutput(`Pin ${normalizeHandle(args.handle)} removed.`);
        }
        const source: SourceRef =
          args.source.kind === "file"
            ? await verifyFileEvidence(args.source)
            : { kind: "context", contextId: session.generation, excerpt: args.source.excerpt, freshness: "fresh" };
        const id = `carry:${api.callId}`;
        const next = brain.apply({ kind: "pin.add", layer: "carry", pin: { id, item: args.item, reason: args.reason, source, createdAt: api.now() } }, api.now());
        pendingWrite(session, { kind: "pin", action: "add", id });
        return textOutput(`Carry pin ${handleOf(next.handles, "pin", id) ?? "record"} saved.`);
      },
    }),

    defineTool({
      name: "inspect",
      description: `Read a bounded text range inside the project root. ${MAX_RANGE_LINES} lines at a time at most; returns the path, the range, the total lines, the file's digest, and the excerpt. Digests are what evidence cites.`,
      parameters: obj({
        path: str({ minLength: 1, maxLength: 4096 }),
        startLine: int({ minimum: 1 }),
        endLine: int({ minimum: 1 }),
      }),
      replay: "safe",
      execute: async (args) => {
        const range = await readBoundedRange(root, args.path, args.startLine, args.endLine);
        return textOutput(
          `${range.path}:${range.startLine}-${range.endLine} (of ${range.totalLines} lines)\ndigest: ${range.digest}\n\n${range.excerpt}`,
        );
      },
    }),

    defineTool({
      name: "edit",
      description:
        "Apply one atomic edit to a path inside the project. To create a file, pass oldText \"\" (its parent directory must exist). To change one, pass the exact text to replace — it must appear exactly once. Large newText is rejected; keep edits small.",
      parameters: obj({
        path: str({ minLength: 1, maxLength: 4096 }),
        oldText: str({ maxLength: 100_000 }),
        newText: str({ maxLength: 100_000 }),
      }),
      replay: "unsafe",
      execute: async (args) => {
        const result = await applyAtomicEdit(root, args.path, args.oldText, args.newText);
        return textOutput(result.outcome === "created" ? `Created ${result.path} (${result.bytes} bytes).` : `Edited ${result.path} (${result.bytes} bytes).`);
      },
    }),

    defineTool({
      name: "shell",
      description:
        "Run a command inside the project root. Output is the tail, capped. A non-zero exit code is information, not a failure. Timeouts kill the command.",
      parameters: obj({
        command: str({ minLength: 1, maxLength: 4000 }),
        timeout: opt(int({ minimum: 1000, maximum: 600_000 })),
      }),
      replay: "unsafe",
      execute: async (args) => {
        const result = await runShell(root, args.command, args.timeout ?? 120_000);
        if (result.timedOut) return errorOutput(`Command timed out.\n${result.output}`);
        return textOutput(`${result.exitCode === null ? "[exit unknown]" : `[exit ${result.exitCode}]`}\n${result.output}`);
      },
    }),

    defineTool({
      name: "tree",
      description:
        "Set the anchor and depth of the project tree in your state block and return the rendered tree. The anchor stays inside the project; move it where your attention is. Depth 0 shows only the anchor line. The tree marks files an Atlas node links.",
      parameters: obj({
        anchor: opt(str({ minLength: 1, maxLength: 4096 })),
        depth: opt(int({ minimum: 0, maximum: 12 })),
      }),
      replay: "safe",
      execute: async (args) => {
        const anchor = args.anchor ?? session.tree.anchor;
        const depth = args.depth ?? session.tree.depth;
        const block = projectTreeBlock(root, anchor, depth, brain.read());
        session.tree = { anchor: block.root, depth: block.depth };
        const body = block.lines.length === 0 ? "(nothing below the anchor at depth 0)" : block.lines.join("\n");
        return textOutput(`tree: ${block.root} (depth ${block.depth})\n${body}`);
      },
    }),

    defineTool({
      name: "collapse",
      description:
        "End this context and rebuild it from the Brain. Rare, and never for ordinary work: call this when the map and the books have diverged past what the context can work with. No approval is involved, from either side. Chat anything the person must see first.",
      parameters: obj({ reason: str({ minLength: 1, maxLength: 1000 }) }),
      replay: "safe",
      execute: async (args) => {
        session.collapseRequested = args.reason.trim();
        return { output: [{ type: "text" as const, text: `Collapse noted: ${args.reason.trim()}. This run ends; the context rebuilds from the Brain.` }], control: { terminate: true } };
      },
    }),

    defineTool({
      name: "sleep",
      description: "End the run. There is nothing left to do until the person or a wake says otherwise.",
      parameters: obj({}),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text" as const, text: "Carto is asleep." }], control: { terminate: true } }),
    }),
  ];
}
