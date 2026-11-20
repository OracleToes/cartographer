import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AtlasNode, LedgerEntry } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import { brainDirectory } from "./paths.js";

const MAX_LEGACY_RECORDS = 1_000;
const MAX_LEDGER_TEXT = 24_000;
const MAX_ATLAS_TITLE = 240;
const MAX_ATLAS_CLAIM = 24_000;

export class LegacyImportError extends Error {}

export interface LegacyImport {
  ledger: LedgerEntry[];
  atlas: AtlasNode[];
  warnings: string[];
}

export interface LegacyImportSummary {
  ledger: number;
  atlas: number;
  warnings: readonly string[];
}

/**
 * Read the small, plain JSON Atlas and Ledger files written by older Cartographer versions.
 * This is a one-way conversion. It neither starts nor imports an old runtime or transcript.
 */
export async function readLegacyBrain(projectRoot: string, now = Date.now()): Promise<LegacyImport> {
  const directory = brainDirectory(projectRoot);
  const [ledgerValue, atlasValue] = await Promise.all([
    readOptionalJson(join(directory, "carto-ledger.json")),
    readOptionalJson(join(directory, "carto-atlas.json")),
  ]);
  if (ledgerValue === undefined && atlasValue === undefined) {
    throw new LegacyImportError(`No legacy Atlas or Ledger JSON exists in ${directory}.`);
  }

  const warnings: string[] = [];
  const ledger = ledgerValue === undefined ? [] : parseLegacyLedger(ledgerValue, now, warnings);
  const atlas = atlasValue === undefined ? [] : parseLegacyAtlas(atlasValue, now, warnings);
  return { ledger, atlas, warnings };
}

/** Store a parsed legacy import in one current-only Brain commit. Re-running is idempotent. */
export async function importLegacyBrain(store: BrainStore, legacy: LegacyImport): Promise<LegacyImportSummary> {
  await store.apply({ kind: "legacy.import", ledger: legacy.ledger, atlas: legacy.atlas });
  return { ledger: legacy.ledger.length, atlas: legacy.atlas.length, warnings: legacy.warnings };
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new LegacyImportError(`Carto cannot read ${path}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new LegacyImportError(`Carto cannot read ${path}: it is not valid JSON (${messageOf(error)}).`);
  }
}

function parseLegacyLedger(value: unknown, now: number, warnings: string[]): LedgerEntry[] {
  const input = objectValue(value, "The legacy Ledger");
  if (!Array.isArray(input.items)) throw new LegacyImportError("The legacy Ledger needs an items list.");
  if (input.items.length > MAX_LEGACY_RECORDS) {
    throw new LegacyImportError(`The legacy Ledger has more than ${MAX_LEGACY_RECORDS} entries.`);
  }

  const entries: LedgerEntry[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of input.items.entries()) {
    const item = objectValueOrUndefined(raw);
    const text = item === undefined ? undefined : shortText(item.text, MAX_LEDGER_TEXT);
    const kind = item?.kind;
    if (item === undefined || text === undefined || !isLedgerKind(kind)) {
      warnings.push(`Skipped legacy Ledger entry ${index + 1}: it needs a supported kind and short text.`);
      continue;
    }
    const id = legacyId("ledger", item.id, index);
    if (ids.has(id)) {
      warnings.push(`Skipped legacy Ledger entry ${index + 1}: it repeats an earlier id.`);
      continue;
    }
    ids.add(id);
    const createdAt = legacyTime(item.added, now);
    const outcome = shortText(item.outcome, MAX_LEDGER_TEXT);
    entries.push({
      id,
      kind,
      text,
      status: legacyLedgerStatus(item.status),
      answer: outcome === undefined ? null : { text: outcome, evidenceIds: [] },
      createdAt,
      updatedAt: legacyTime(item.updated ?? item.added, createdAt),
    });
  }
  return entries;
}

function parseLegacyAtlas(value: unknown, now: number, warnings: string[]): AtlasNode[] {
  const input = objectValue(value, "The legacy Atlas");
  if (!Array.isArray(input.nodes)) throw new LegacyImportError("The legacy Atlas needs a nodes list.");
  if (input.nodes.length > MAX_LEGACY_RECORDS) {
    throw new LegacyImportError(`The legacy Atlas has more than ${MAX_LEGACY_RECORDS} nodes.`);
  }

  const candidates: Array<{ id: string; name: string; title: string; claim: string; detail: string; createdAt: number; updatedAt: number; links: string[] }> = [];
  const names = new Set<string>();
  for (const [index, raw] of input.nodes.entries()) {
    const item = objectValueOrUndefined(raw);
    const title = item === undefined ? undefined : shortText(item.name, MAX_ATLAS_TITLE);
    const claim = item === undefined ? undefined : shortText(item.gist, MAX_ATLAS_CLAIM);
    if (item === undefined || title === undefined || claim === undefined) {
      warnings.push(`Skipped legacy Atlas node ${index + 1}: it needs a short name and gist.`);
      continue;
    }
    const name = normalizedName(title);
    if (name === "" || names.has(name)) {
      warnings.push(`Skipped legacy Atlas node ${index + 1}: its name repeats an earlier node.`);
      continue;
    }
    names.add(name);
    candidates.push({
      id: legacyId("atlas", item.id ?? name, index),
      name,
      title,
      claim,
      detail: shortText(item.detail, MAX_ATLAS_CLAIM) ?? "",
      createdAt: legacyTime(item.written, now),
      updatedAt: legacyTime(item.updated ?? item.written, now),
      links: stringList(item.links),
    });
  }

  const idByName = new Map(candidates.map((candidate) => [candidate.name, candidate.id]));
  const linked = candidates.some((candidate) => candidate.links.length > 0);
  if (linked) {
    warnings.push("Imported legacy Atlas links as depends-on edges. Atlas edges are typed now; review them.");
  }
  return candidates.map((candidate) => {
    const excerpt = [
      "Imported legacy Atlas record. It is stale until Carto checks current project evidence.",
      `Title: ${candidate.title}`,
      `Claim: ${candidate.claim}`,
      candidate.detail === "" ? "" : `Legacy detail: ${candidate.detail}`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      id: candidate.id,
      title: candidate.title,
      claim: candidate.claim,
      evidence: [{ kind: "context", contextId: "legacy-import", excerpt, freshness: "stale" }],
      edges: [
        ...new Set(candidate.links.map(normalizedName).map((name) => idByName.get(name)).filter(isString)),
      ].map((target) => ({ kind: "depends-on" as const, target })),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    };
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  const item = objectValueOrUndefined(value);
  if (item === undefined) throw new LegacyImportError(`${label} must be a JSON object.`);
  return item;
}

function objectValueOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function shortText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result === "" || result.length > maximum ? undefined : result;
}

function isLedgerKind(value: unknown): value is LedgerEntry["kind"] {
  return value === "goal" || value === "note" || value === "question";
}

function legacyLedgerStatus(value: unknown): LedgerEntry["status"] {
  if (value === "answered") return "answered";
  return value === "done" || value === "closed" ? "closed" : "open";
}

function legacyId(kind: "ledger" | "atlas", value: unknown, index: number): string {
  const original = typeof value === "string" && value.trim() !== "" ? value.trim() : `record-${index + 1}`;
  const readable = original.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "record";
  const suffix = createHash("sha256").update(`${kind}\u0000${original}`).digest("hex").slice(0, 16);
  return `legacy:${kind}:${readable}-${suffix}`;
}

function normalizedName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function legacyTime(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
