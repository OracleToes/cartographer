/** Dormant source-head capture for prospective return reconciliation. */
import { readFileSync } from "node:fs";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { defineDoc, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import type { Projection } from "../domain/projection.js";
import type { PinnedEphemeral } from "../domain/records.js";
import { generationPaths } from "./collapse.js";
import { projectionBytesDigest, snapshotBytes } from "./projection-files.js";
import type { ReturnSweepView } from "./delegate-sweep-view.js";

export type ReturnSweepHead = { chatIds: string[]; pins: PinnedEphemeral[]; digest: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const kinds = new Set(["toolCall", "reasoning", "plainText", "readResult", "toolResult", "personMessage"]);

/** The projection creator's immutable receipt; absence never authorizes a sweep. */
export const DelegateHeadReceiptDoc = defineDoc<{ generation: string | null; digest: string | null }>({
  kind: "carto.delegate-head-receipt", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ generation: null, digest: null }), checkpointWhen: () => true,
});

/**
 * The trusted snapshot creator calls this with the projection it just rendered,
 * never with values reconstructed from existing files. It verifies both files
 * against the normal serializer and records their digest in Pi. A crash before
 * the receipt, later snapshot rewrite, or legacy generation remains unproven.
 * Writers and path replacement must be sealed by the host; this is not a lock.
 */
export async function recordDelegateHeadReceipt(tx: Tx, root: string, generation: string, projection: Projection, createdAt: number): Promise<void> {
  if (!/^gen-[\w-]+$/.test(generation) || !Number.isFinite(createdAt) || await tx.conversation(ROOT_CONVERSATION_ID) === undefined) {
    throw new Error("Invalid source head receipt; the source was preserved.");
  }
  const expected = snapshotBytes(generation, projection, createdAt);
  const paths = generationPaths(root, generation);
  let markdown: Buffer, sidecar: Buffer;
  try { markdown = readFileSync(paths.markdown); sidecar = readFileSync(paths.sidecar); }
  catch { throw new Error("Source projection is unavailable; the source was preserved."); }
  if (!markdown.equals(expected.markdown) || !sidecar.equals(expected.sidecar)) {
    throw new Error("Source projection conflicts with its creator's snapshot; the source was preserved.");
  }
  await recordDelegateHeadDigest(tx, root, generation, projectionBytesDigest(expected.markdown, expected.sidecar));
}

/** Install a digest committed by the trusted snapshot creator, never one derived from untrusted files. */
export async function recordDelegateHeadDigest(tx: Tx, root: string, generation: string, digest: string): Promise<void> {
  if (!/^gen-[\w-]+$/.test(generation) || !/^[0-9a-f]{64}$/.test(digest) || await tx.conversation(ROOT_CONVERSATION_ID) === undefined) {
    throw new Error("Invalid source head receipt; the source was preserved.");
  }
  const paths = generationPaths(root, generation);
  let actual: string;
  try { actual = projectionBytesDigest(readFileSync(paths.markdown), readFileSync(paths.sidecar)); }
  catch { throw new Error("Source projection is unavailable; the source was preserved."); }
  if (actual !== digest) throw new Error("Source projection conflicts with its creator's snapshot; the source was preserved.");
  const receipt = await tx.doc(DelegateHeadReceiptDoc, ROOT_CONVERSATION_ID);
  if (Object.keys(receipt).length !== 2 ||
      !((receipt.generation === null && receipt.digest === null) || (receipt.generation === generation && receipt.digest === digest))) {
    throw new Error("Source head receipt conflicts; the source was preserved.");
  }
  receipt.generation = generation;
  receipt.digest = digest;
}

/**
 * Capture the actual source projection files and compare its markdown with
 * Pi's replayed main system section. The sidecar's visible pin rows must match
 * the markdown. Its IDs, entity metadata and Chat IDs are not present in that
 * text, so consistency is not proof those hidden fields were authentic when
 * originally written. Caller must seal all source, Brain and projection writers.
 * The digest detects later byte changes but is not a lock, journal or deletion
 * authorization. A source with no visible main projection is refused.
 */
export function captureReturnSweepHead(root: string, generation: string, views: readonly ReturnSweepView[]): ReturnSweepHead {
  if (!/^gen-[\w-]+$/.test(generation)) throw new Error("Invalid return-sweep generation; the source was preserved.");
  const mains = views.filter(({ conversation }) => conversation.id === ROOT_CONVERSATION_ID);
  if (mains.length !== 1) throw new Error("Return sweep needs one main head; the source was preserved.");
  const paths = generationPaths(root, generation);
  let markdownBytes: Buffer, sidecarBytes: Buffer;
  try {
    markdownBytes = readFileSync(paths.markdown);
    sidecarBytes = readFileSync(paths.sidecar);
  } catch {
    throw new Error("The return-sweep projection files are unavailable; the source was preserved.");
  }
  const utf8 = (bytes: Buffer): string => {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Invalid return-sweep projection encoding; the source was preserved.");
    return text;
  };
  const markdown = utf8(markdownBytes);
  let sidecar: unknown;
  try { sidecar = JSON.parse(utf8(sidecarBytes)); }
  catch { throw new Error("Invalid return-sweep projection sidecar; the source was preserved."); }
  if (!object(sidecar) || sidecar.generation !== generation || !Array.isArray(sidecar.chat) || !Array.isArray(sidecar.parts) || !Array.isArray(sidecar.ephemeralItems)) {
    throw new Error("Invalid return-sweep projection sidecar; the source was preserved.");
  }
  const main = mains[0]!.view;
  const section = getCurrentSystemMessage(main.messages)?.sections?.["carto-context"];
  if (section !== markdown) throw new Error("The frozen projection conflicts with the main context; the source was preserved.");
  const chatIds = new Set<string>();
  for (const id of sidecar.chat) {
    if (typeof id !== "string" || id.length === 0 || chatIds.has(id)) throw new Error("Invalid frozen Chat identities; the source was preserved.");
    chatIds.add(id);
  }
  const pins: PinnedEphemeral[] = [];
  const ids = new Set<string>();
  const handles = new Set<string>();
  const lines: string[] = [];
  for (const row of sidecar.ephemeralItems) {
    const item = object(row) ? row.item : undefined;
    if (!object(row) || typeof row.handle !== "string" || !/^X[1-9][0-9]*$/.test(row.handle) || handles.has(row.handle) ||
        !object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
        typeof item.kind !== "string" || !kinds.has(item.kind) || typeof item.text !== "string" ||
        typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) || (item.pinned !== "user" && item.pinned !== "agent") ||
        (item.containsImage !== undefined && typeof item.containsImage !== "boolean")) {
      throw new Error("Invalid frozen pin metadata; the source was preserved.");
    }
    if (item.entity !== undefined && (!object(item.entity) || typeof item.entity.callId !== "string" || !item.entity.callId ||
        (item.entity.tool !== undefined && typeof item.entity.tool !== "string") ||
        (item.entity.path !== undefined && typeof item.entity.path !== "string"))) {
      throw new Error("Invalid frozen pin entity; the source was preserved.");
    }
    handles.add(row.handle);
    ids.add(item.id);
    lines.push(`${row.handle} [${item.kind}] ${item.text}`);
    pins.push(item as unknown as PinnedEphemeral);
  }
  const pinnedParts = sidecar.parts.filter((part: unknown) => object(part) && part.id === "ephemera").length;
  if (pinnedParts !== (pins.length === 0 ? 0 : 1)) throw new Error("Frozen pin section metadata conflicts; the source was preserved.");
  if (pins.length > 0) {
    const suffix = `\n${lines.join("\n")}`;
    const prefix = markdown.endsWith(suffix) ? markdown.slice(0, -suffix.length) : "";
    const heading = prefix.slice(prefix.lastIndexOf("\n") + 1);
    if (!/^Pinned — what .+ kept in front of you$/.test(heading)) {
      throw new Error("Frozen pin rows conflict with the projection; the source was preserved.");
    }
  } else if (markdown.split("\n").some((line) => /^Pinned — what .+ kept in front of you$/.test(line))) {
    throw new Error("Frozen pin rows are missing; the source was preserved.");
  }
  const digest = projectionBytesDigest(markdownBytes, sidecarBytes);
  return { chatIds: [...chatIds], pins: structuredClone(pins), digest };
}
