/** Dormant source-head capture for prospective return reconciliation. */
import { readFileSync } from "node:fs";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { PinnedEphemeral } from "../domain/records.js";
import { generationPaths } from "./collapse.js";
import { projectionBytesDigest } from "./projection-files.js";
import type { ReturnSweepView } from "./delegate-sweep-view.js";

export type ReturnSweepHead = { chatIds: string[]; pins: PinnedEphemeral[]; digest: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const kinds = new Set(["toolCall", "reasoning", "plainText", "readResult", "toolResult", "personMessage"]);

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
