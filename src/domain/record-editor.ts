/** Validation for user-edited structured Brain records. */
import { compile } from "@earendil-works/pi-schema";
import type { AtlasNode, ChatRecord, LedgerEntry } from "./records.js";

export type EditableBookRecord =
  | { kind: "atlas"; value: AtlasNode }
  | { kind: "ledger"; value: LedgerEntry };
export type EditableRecord = EditableBookRecord | { kind: "chat"; value: ChatRecord };

const mark = {
  type: "object", additionalProperties: false, required: ["action", "author"],
  properties: { action: { enum: ["archive", "delete", "restore"] }, author: { enum: ["user", "agent"] } },
} as const;
const common = {
  id: { type: "string" }, text: { type: "string" },
  createdAt: { type: "number" }, updatedAt: { type: "number" }, mark,
} as const;
const atlasValidator = compile({
  type: "object", additionalProperties: false,
  required: ["id", "title", "text", "links", "attachments", "createdAt", "updatedAt"],
  properties: {
    ...common, title: { type: "string" }, stale: { type: "boolean" },
    links: { type: "array", items: { type: "string" } },
    attachments: { type: "array", items: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "path"], properties: { kind: { const: "file" }, path: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "record" }, id: { type: "string" } } },
    ] } },
  },
} as const);
const ledgerValidator = compile({
  type: "object", additionalProperties: false,
  required: ["id", "kind", "text", "status", "answer", "createdAt", "updatedAt"],
  properties: {
    ...common,
    kind: { enum: ["goal", "note", "question", "instruction", "progress"] },
    status: { enum: ["open", "answered", "closed"] },
    answer: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } }] },
  },
} as const);

const chatValidator = compile({
  type: "object", additionalProperties: false,
  required: ["id", "author", "text", "createdAt", "updatedAt"],
  properties: { ...common, author: { enum: ["user", "agent", "system"] } },
} as const);

/** Parse before touching storage; identity and bookkeeping stay with the entry. */
export function parseEditedRecord(original: EditableRecord, text: string, now: number): EditableRecord {
  const value: unknown = JSON.parse(text);
  const validator = original.kind === "atlas" ? atlasValidator : original.kind === "ledger" ? ledgerValidator : chatValidator;
  if (!validator.check(value)) throw new Error(`Invalid ${original.kind} record: ${JSON.stringify(validator.errors(value))}`);
  const record = value as AtlasNode | LedgerEntry | ChatRecord;
  if (record.id !== original.value.id || record.createdAt !== original.value.createdAt) throw new Error("The record's id and createdAt cannot be changed.");
  if (JSON.stringify(record.mark ?? null) !== JSON.stringify(original.value.mark ?? null)) throw new Error("Use the mark controls to change a pending action.");
  if (original.kind === "atlas") return { kind: "atlas", value: { ...(record as AtlasNode), updatedAt: now } };
  if (original.kind === "ledger") return { kind: "ledger", value: { ...(record as LedgerEntry), updatedAt: now } };
  if ((record as ChatRecord).author !== original.value.author) throw new Error("The Chat record's author cannot be changed.");
  return { kind: "chat", value: { ...(record as ChatRecord), updatedAt: now } };
}
