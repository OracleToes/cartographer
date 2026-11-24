/**
 * Diagnostic collapse history for `/copy-session`.
 *
 * Host-owned and strictly outside the Brain and model context: lives alongside
 * `.brain/brain.sqlite` as a bounded JSONL file (`.brain/collapse-log.jsonl`)
 * so multi-collapse sessions remain diagnosable after old generation stores
 * have been swept and deleted, including across restarts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Archive } from "../domain/archive.js";
import { flattenEntry, truncateDumpText, type ContextDumpEntry } from "../domain/dump.js";
import type { CartoBrain } from "../domain/records.js";
import { STATE_BLOCK_MARKER } from "../domain/state-block.js";

export type CollapseTrigger = "agent" | "automatic" | "person";

export interface CollapseBrainCounts {
  atlas: number;
  ledger: number;
  chat: number;
  files: number;
  ephemera: number;
}

export interface CollapseLogEntry {
  at: string;
  fromGeneration: string;
  toGeneration: string;
  trigger: CollapseTrigger;
  reason: string;
  model: string;
  contextWindow: number;
  lastReportedInput: number | null;
  toolWorkAtLastReport: number;
  fillPercent: number | null;
  work: {
    requests: number;
    steps: number;
    startFill: number | null;
  };
  pendingWrites: number;
  brainBefore: CollapseBrainCounts;
  brainAfter: CollapseBrainCounts;
  swept: string | null;
  archivedCount: number;
  droppedCount: number;
  carried: number;
  resumed: boolean;
  lastStateBlock: string | null;
  bodyEntries: ContextDumpEntry[];
}

const DEFAULT_MAX_LOG_ENTRIES = 20;
const MAX_TOOL_RESULT_CHARS = 2_500;
const MAX_GENERIC_ENTRY_CHARS = 6_000;

export const collapseLogPath = (root: string): string => resolve(root, ".brain", "collapse-log.jsonl");

export function brainCountsOf(brain: CartoBrain): CollapseBrainCounts {
  return {
    atlas: brain.atlas.length,
    ledger: brain.ledger.length,
    chat: brain.chat.length,
    files: brain.files.length,
    ephemera: brain.ephemera.filter((item) => item.pinned !== undefined).length,
  };
}

/**
 * Flatten a generation's body entries (excluding the frozen system head and
 * transient state-block markers) for archival in the collapse diagnostic log.
 */
export function collectCollapseBodyEntries(entries: readonly unknown[]): ContextDumpEntry[] {
  const out: ContextDumpEntry[] = [];
  for (const raw of entries) {
    const flat = flattenEntry(raw as { kind?: string; id?: number; model?: unknown });
    if (flat === undefined) continue;
    if (flat.role === "system") continue;
    if (flat.body.trim() === STATE_BLOCK_MARKER) continue;
    const cap = flat.role === "toolResult" || flat.role === "tool" ? MAX_TOOL_RESULT_CHARS : MAX_GENERIC_ENTRY_CHARS;
    out.push({ ...flat, body: truncateDumpText(flat.body, cap) });
  }
  return out;
}

/** Read valid entries from `.brain/collapse-log.jsonl`; empty array if absent or unreadable. */
export function readCollapseLog(root: string): CollapseLogEntry[] {
  const path = collapseLogPath(root);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const entries: CollapseLogEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as CollapseLogEntry;
        if (typeof parsed === "object" && parsed !== null && typeof parsed.fromGeneration === "string") {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed lines; never block a diagnostic dump.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Best-effort append to `.brain/collapse-log.jsonl`, keeping at most `maxEntries`
 * recent collapses so disk usage stays bounded. Never throws: diagnostic logging
 * must never interfere with a real collapse.
 */
export function appendCollapseLog(root: string, entry: CollapseLogEntry, maxEntries = DEFAULT_MAX_LOG_ENTRIES): void {
  const path = collapseLogPath(root);
  if (!existsSync(dirname(path))) return;
  try {
    const existing = readCollapseLog(root);
    const next = [...existing, entry].slice(-Math.max(1, maxEntries));
    writeFileSync(path, `${next.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  } catch {
    // Diagnostic log is strictly best-effort.
  }
}

const fmtDelta = (before: number, after: number): string => (before === after ? String(after) : `${before}→${after}`);

/** Render prior collapses into a readable section for `/copy-session`. */
export function formatCollapseHistory(entries: readonly CollapseLogEntry[]): string {
  if (entries.length === 0) return "(no collapses recorded yet)";
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const fill =
      entry.fillPercent !== null
        ? `${entry.fillPercent}% (${(entry.lastReportedInput ?? 0).toLocaleString("en-US")} +${entry.toolWorkAtLastReport.toLocaleString("en-US")} / ${entry.contextWindow.toLocaleString("en-US")})`
        : entry.lastReportedInput !== null
          ? `${entry.lastReportedInput.toLocaleString("en-US")} +${entry.toolWorkAtLastReport.toLocaleString("en-US")} (window unknown)`
          : "no provider report";
    const startFill = entry.work.startFill === null ? "?" : `${entry.work.startFill}%`;
    lines.push(
      `### collapse #${index + 1} · ${entry.at}`,
      `${entry.fromGeneration} → ${entry.toGeneration} · trigger: ${entry.trigger} · reason: ${entry.reason}`,
      `model: ${entry.model} · fill: ${fill} · work: ${entry.work.steps} step(s), ${entry.work.requests} req(s) (start ${startFill}) · pending writes: ${entry.pendingWrites}`,
      `brain: atlas ${fmtDelta(entry.brainBefore.atlas, entry.brainAfter.atlas)} · ledger ${fmtDelta(entry.brainBefore.ledger, entry.brainAfter.ledger)} · chat ${fmtDelta(entry.brainBefore.chat, entry.brainAfter.chat)} · pinned files ${fmtDelta(entry.brainBefore.files, entry.brainAfter.files)} · pinned ephemera ${fmtDelta(entry.brainBefore.ephemera, entry.brainAfter.ephemera)}`,
      `sweep: ${entry.swept ?? "none"} · archived ${entry.archivedCount} · dropped ${entry.droppedCount} · carried ${entry.carried} · resumed ${entry.resumed}`,
    );
    if (entry.lastStateBlock !== null && entry.lastStateBlock.trim().length > 0) {
      lines.push("", "#### last <carto-state> before collapse", entry.lastStateBlock);
    }
    if (entry.bodyEntries.length > 0) {
      lines.push("", `#### collapsed generation body (${entry.bodyEntries.length} entries)`);
      for (const item of entry.bodyEntries) {
        const ts = item.timestamp === undefined ? "?" : new Date(item.timestamp).toISOString();
        lines.push("", `#${item.id} ${item.kind} · role ${item.role} · ${ts}`, item.body);
      }
    }
    if (index < entries.length - 1) lines.push("");
  });
  return lines.join("\n");
}

/** Compact summary of items currently sitting in `.brain/archive` for `/copy-session`. */
export function formatArchiveSummary(archive: Archive): string {
  if (archive.items.length === 0) return "(archive is empty)";
  const lines: string[] = [`${archive.items.length} item(s) in archive:`];
  for (const item of archive.items) {
    const kind =
      item.layer === "record"
        ? `record:${item.record?.kind ?? "?"}`
        : `ephemeral:${item.ephemeral?.kind ?? "?"}`;
    const flags: string[] = [];
    if (item.pinned !== undefined) flags.push(`pinned(${item.pinned})`);
    if (item.mark !== undefined) flags.push(`mark:${item.mark.action}(${item.mark.author})`);
    if (item.restorePending === true) flags.push("restore-pending");
    const rawPreview =
      item.layer === "record"
        ? item.record?.kind === "atlas"
          ? `${(item.record.value as { title?: string }).title ?? ""}: ${(item.record.value as { text?: string }).text ?? ""}`
          : String((item.record?.value as { text?: string } | undefined)?.text ?? "")
        : String(item.ephemeral?.text ?? "");
    const preview = rawPreview.replace(/\s+/g, " ").trim().slice(0, 120);
    const meta = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    lines.push(`- ${kind} (gen ${item.sweptAtGeneration}, collapse #${item.sweptAtCollapse})${meta}: ${preview}`);
  }
  return lines.join("\n");
}
