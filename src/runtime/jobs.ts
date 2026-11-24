/**
 * Persistent piped processes (`J` handles, `proc` tool, `jobs` view).
 *
 * Ephemeral runtime state (§2, §3.1): lives in host RAM for the Carto host's
 * lifetime, survives context collapse (§4), and is torn down cleanly on host
 * exit. Never stored in `.brain/`, and never dumps scrollback into
 * `<carto-state>` (§5.3).
 *
 * Procedural (§11): one explicit `JobTable` value; behaviour is functions over it.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export const DEFAULT_WAIT_MS = 1_000;
export const QUIET_SETTLE_MS = 150;
const MAX_BUFFER_LINES = 2_000;
const STOP_GRACE_MS = 250;

export type JobLineKind = "stdout" | "stderr" | "stdin" | "system";

export interface JobLine {
  readonly seq: number;
  readonly kind: JobLineKind;
  readonly text: string;
  readonly at: number;
}

export interface JobSummary {
  readonly handle: string;
  readonly label: string;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly unreadLines: number;
  readonly quietMs: number;
  readonly active: boolean;
}

export interface JobSnapshot {
  readonly handle: string;
  readonly label: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly startedAt: number;
  readonly exitedAt: number | undefined;
  readonly unreadLines: number;
  readonly lines: readonly JobLine[];
  readonly pendingPartial: string;
}

interface JobRecord {
  readonly handle: string;
  readonly label: string;
  readonly command: string;
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly startedAt: number;
  status: "running" | "exited";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exitedAt: number | undefined;
  lines: JobLine[];
  nextSeq: number;
  stdoutPartial: string;
  stderrPartial: string;
  lastOutputAt: number;
  /** Highest committed `seq` already returned to the agent. */
  agentReadSeq: number;
  /** Last trailing partial text already returned to the agent (avoids repeating an unchanged prompt). */
  agentReadPartial: string;
  readonly waiters: Set<() => void>;
}

export interface JobTable {
  readonly root: string;
  readonly now: () => number;
  nextNumber: number;
  readonly entries: Map<string, JobRecord>;
  readonly listeners: Set<() => void>;
}

const activeTables = new Set<JobTable>();
let exitHookRegistered = false;

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    for (const table of activeTables) {
      for (const record of table.entries.values()) {
        if (record.status === "running") {
          sendGroupSignal(record.child, "SIGTERM");
        }
      }
    }
    activeTables.clear();
  });
}

export interface JobTableOptions {
  root: string;
  now?: () => number;
}

export interface JobActionResult {
  readonly handle: string;
  readonly label: string;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly settled: boolean;
  readonly output: string;
  readonly omittedLines: number;
}

const normalizeHandle = (handle: string): string => handle.trim().toUpperCase();

function defaultLabel(command: string): string {
  const compact = command.trim().replace(/\s+/g, " ");
  return compact.length <= 28 ? compact : `${compact.slice(0, 27)}…`;
}

function notify(table: JobTable): void {
  for (const listener of table.listeners) {
    try {
      listener();
    } catch {
      // A UI listener failing never breaks process tracking.
    }
  }
}

function wakeWaiters(record: JobRecord): void {
  for (const wake of record.waiters) wake();
}

function pushLine(table: JobTable, record: JobRecord, kind: JobLineKind, text: string): void {
  const at = table.now();
  const seq = record.nextSeq;
  record.nextSeq += 1;
  record.lines.push({ seq, kind, text, at });
  if (record.lines.length > MAX_BUFFER_LINES) {
    record.lines.splice(0, record.lines.length - MAX_BUFFER_LINES);
  }
  if (kind === "stdout" || kind === "stderr") {
    record.lastOutputAt = at;
  }
}

function ingestChunk(table: JobTable, record: JobRecord, kind: "stdout" | "stderr", chunk: string): void {
  const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const prior = kind === "stdout" ? record.stdoutPartial : record.stderrPartial;
  const combined = prior + normalized;
  const parts = combined.split("\n");
  const tail = parts.pop() ?? "";
  if (kind === "stdout") record.stdoutPartial = tail;
  else record.stderrPartial = tail;
  for (const line of parts) {
    pushLine(table, record, kind, line);
  }
  if (tail.length > 0) {
    record.lastOutputAt = table.now();
  }
  wakeWaiters(record);
  notify(table);
}

function flushPartials(table: JobTable, record: JobRecord): void {
  if (record.stdoutPartial.length > 0) {
    pushLine(table, record, "stdout", record.stdoutPartial);
    record.stdoutPartial = "";
  }
  if (record.stderrPartial.length > 0) {
    pushLine(table, record, "stderr", record.stderrPartial);
    record.stderrPartial = "";
  }
}

function pendingPartialOf(record: JobRecord): string {
  const parts: string[] = [];
  if (record.stdoutPartial.length > 0) parts.push(record.stdoutPartial);
  if (record.stderrPartial.length > 0) parts.push(`[stderr] ${record.stderrPartial}`);
  return parts.join("\n");
}

function formatLine(line: JobLine): string {
  if (line.kind === "stderr") return `[stderr] ${line.text}`;
  if (line.kind === "stdin") return `> ${line.text}`;
  return line.text;
}

function unreadCountOf(record: JobRecord): number {
  let count = 0;
  for (const line of record.lines) {
    if (line.seq > record.agentReadSeq) count += 1;
  }
  const partial = pendingPartialOf(record);
  if (partial.length > 0 && partial !== record.agentReadPartial) count += 1;
  return count;
}

function readAgentDelta(record: JobRecord, tailLines?: number): { output: string; omittedLines: number } {
  if (tailLines !== undefined) {
    const slice = record.lines.slice(-tailLines);
    const out = slice.map(formatLine);
    const partial = pendingPartialOf(record);
    if (partial.length > 0) out.push(partial);
    record.agentReadSeq = record.nextSeq - 1;
    record.agentReadPartial = partial;
    return { output: out.join("\n"), omittedLines: 0 };
  }

  const oldestSeq = record.lines[0]?.seq;
  const omittedLines =
    oldestSeq !== undefined && record.agentReadSeq + 1 < oldestSeq
      ? oldestSeq - (record.agentReadSeq + 1)
      : 0;
  const fresh = record.lines.filter((line) => line.seq > record.agentReadSeq);
  const out = fresh.map(formatLine);
  const partial = pendingPartialOf(record);
  if (partial.length > 0 && (fresh.length > 0 || partial !== record.agentReadPartial)) {
    out.push(partial);
  }
  record.agentReadSeq = record.nextSeq - 1;
  record.agentReadPartial = partial;
  return { output: out.join("\n"), omittedLines };
}

function sendGroupSignal(child: ChildProcessByStdio<Writable, Readable, Readable>, signal: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

/**
 * Wait briefly for output to arrive and settle (quiet for `QUIET_SETTLE_MS`),
 * bounded by `waitMs`. Respects `signal` without killing the process (§9).
 * Returns `true` when the output settled or the process exited; `false` when
 * `waitMs` elapsed while still active/waiting.
 */
async function waitForSettle(
  record: JobRecord,
  waitMs: number,
  initialSeq: number,
  initialPartial: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (record.status === "exited") return true;
  if (waitMs <= 0 || signal?.aborted === true) return false;

  const hasNewOutput = (): boolean =>
    record.nextSeq > initialSeq || pendingPartialOf(record) !== initialPartial;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = setTimeout(() => finish(false), waitMs);

    const finish = (didSettle: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      record.waiters.delete(onActivity);
      signal?.removeEventListener("abort", onAbort);
      resolve(didSettle);
    };

    const onAbort = (): void => finish(false);

    const armQuiet = (): void => {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), QUIET_SETTLE_MS);
    };

    const onActivity = (): void => {
      if (record.status === "exited") {
        finish(true);
        return;
      }
      if (hasNewOutput()) armQuiet();
    };

    record.waiters.add(onActivity);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (record.status === "exited") {
      finish(true);
    } else if (hasNewOutput()) {
      armQuiet();
    }
  });
}

function getRecord(table: JobTable, handle: string): JobRecord {
  const normalized = normalizeHandle(handle);
  const record = table.entries.get(normalized);
  if (record === undefined) {
    const active = [...table.entries.keys()].join(", ");
    throw new Error(
      `No job has the handle ${normalized}.${active.length > 0 ? ` Active jobs: ${active}.` : " No jobs are running."}`,
    );
  }
  return record;
}

/** Create one explicit process table owned by the Carto host (shared across collapses). */
export function createJobTable(options: JobTableOptions): JobTable {
  return {
    root: options.root,
    now: options.now ?? Date.now,
    nextNumber: 1,
    entries: new Map(),
    listeners: new Set(),
  };
}

export function onJobsChange(table: JobTable, listener: () => void): () => void {
  table.listeners.add(listener);
  return () => {
    table.listeners.delete(listener);
  };
}

export async function startJob(
  table: JobTable,
  options: { command: string; label?: string; waitMs?: number; signal?: AbortSignal },
): Promise<JobActionResult> {
  const command = options.command.trim();
  if (command.length === 0) {
    throw new Error("Command must not be empty.");
  }
  const handle = `J${table.nextNumber}`;
  table.nextNumber += 1;
  const label = options.label?.trim() ? options.label.trim() : defaultLabel(command);
  const startedAt = table.now();
  const child = spawn(command, {
    cwd: table.root,
    shell: true,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // Prevent unhandled EPIPE errors if the child closes stdin early.
  child.stdin.on("error", () => undefined);

  const record: JobRecord = {
    handle,
    label,
    command,
    child,
    startedAt,
    status: "running",
    exitCode: null,
    exitSignal: null,
    exitedAt: undefined,
    lines: [],
    nextSeq: 1,
    stdoutPartial: "",
    stderrPartial: "",
    lastOutputAt: startedAt,
    agentReadSeq: 0,
    agentReadPartial: "",
    waiters: new Set(),
  };
  table.entries.set(handle, record);
  activeTables.add(table);
  registerExitHook();

  child.stdout.on("data", (chunk: string) => ingestChunk(table, record, "stdout", chunk));
  child.stderr.on("data", (chunk: string) => ingestChunk(table, record, "stderr", chunk));
  child.on("error", (error: Error) => {
    pushLine(table, record, "system", `spawn error: ${error.message}`);
    record.status = "exited";
    record.exitCode = 1;
    record.exitedAt = table.now();
    wakeWaiters(record);
    notify(table);
  });
  child.on("close", (code, sig) => {
    flushPartials(table, record);
    record.status = "exited";
    record.exitCode = code;
    record.exitSignal = sig;
    record.exitedAt = table.now();
    wakeWaiters(record);
    notify(table);
  });

  notify(table);

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const settled = await waitForSettle(record, waitMs, 1, "", options.signal);
  const { output, omittedLines } = readAgentDelta(record);
  notify(table);

  return {
    handle,
    label,
    status: record.status,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
    settled,
    output,
    omittedLines,
  };
}

export async function sendJob(
  table: JobTable,
  options: {
    handle: string;
    input?: string;
    raw?: boolean;
    signal?: "SIGINT" | "SIGTERM";
    waitMs?: number;
    abortSignal?: AbortSignal;
    /** `"agent"` advances the agent cursor past its own echoed input; `"user"` leaves it unread for the agent. */
    source?: "agent" | "user";
  },
): Promise<JobActionResult> {
  const record = getRecord(table, options.handle);
  if (record.status !== "running") {
    throw new Error(`${record.handle} has already exited (${formatExit(record.exitCode, record.exitSignal)}).`);
  }
  const source = options.source ?? "agent";
  const initialPartial = pendingPartialOf(record);

  if (options.signal !== undefined) {
    sendGroupSignal(record.child, options.signal);
    pushLine(table, record, "system", `sent ${options.signal}`);
    if (source === "agent") record.agentReadSeq = record.nextSeq - 1;
  }

  if (options.input !== undefined) {
    const payload = options.raw === true ? options.input : options.input.endsWith("\n") ? options.input : `${options.input}\n`;
    const echoed = options.input.replace(/\r\n/g, "\n").replace(/\n$/, "");
    for (const line of echoed.split("\n")) {
      pushLine(table, record, "stdin", line);
    }
    if (source === "agent") {
      // Agent does not need its own echoed input parroted back; any prior
      // unread output before this call stays visible only if read first, or
      // include prior unread lines before advancing? Keep prior unread lines!
      // Actually record the seq of the stdin lines we just wrote below.
    }
    if (!record.child.stdin.destroyed && record.child.stdin.writable) {
      record.child.stdin.write(payload);
    }
  }

  // Remember seq right after writing our input so waitForSettle detects new output.
  const seqAfterSend = record.nextSeq;
  const stdinSeqStart = source === "agent" && options.input !== undefined ? seqAfterSend : undefined;
  if (source === "agent" && stdinSeqStart !== undefined) {
    // Only skip the stdin line(s) we just echoed if there was nothing unread before them.
    const priorUnread = record.lines.some((line) => line.seq > record.agentReadSeq && line.kind !== "stdin");
    if (!priorUnread) {
      record.agentReadSeq = seqAfterSend - 1;
    }
  }

  notify(table);

  const waitMs = options.waitMs ?? (source === "user" ? 0 : DEFAULT_WAIT_MS);
  const settled = await waitForSettle(record, waitMs, seqAfterSend, initialPartial, options.abortSignal);
  const { output, omittedLines } = source === "agent" ? readAgentDelta(record) : { output: "", omittedLines: 0 };
  notify(table);

  return {
    handle: record.handle,
    label: record.label,
    status: record.status,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
    settled,
    output,
    omittedLines,
  };
}

export async function readJob(
  table: JobTable,
  options: { handle: string; waitMs?: number; tailLines?: number; abortSignal?: AbortSignal },
): Promise<JobActionResult> {
  const record = getRecord(table, options.handle);
  const waitMs = options.waitMs ?? 0;
  let settled = true;
  if (waitMs > 0 && record.status === "running") {
    const unread = unreadCountOf(record);
    const lastLine = record.lines[record.lines.length - 1];
    const quietEnough = table.now() - record.lastOutputAt >= QUIET_SETTLE_MS;
    const alreadySettled = unread > 0 && quietEnough && lastLine?.kind !== "stdin";
    if (!alreadySettled) {
      settled = await waitForSettle(record, waitMs, record.nextSeq, pendingPartialOf(record), options.abortSignal);
    }
  }
  const { output, omittedLines } = readAgentDelta(record, options.tailLines);
  notify(table);

  return {
    handle: record.handle,
    label: record.label,
    status: record.status,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
    settled,
    output,
    omittedLines,
  };
}

export async function stopJob(table: JobTable, handle: string): Promise<JobActionResult> {
  const record = getRecord(table, handle);
  if (record.status === "running") {
    sendGroupSignal(record.child, "SIGTERM");
    await new Promise<void>((resolve) => {
      if (record.status === "exited") {
        resolve();
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
        record.waiters.delete(onWake);
        resolve();
      };
      const onWake = (): void => {
        if (record.status === "exited") finish();
      };
      record.waiters.add(onWake);
      const killTimer = setTimeout(() => {
        if (record.status === "running") sendGroupSignal(record.child, "SIGKILL");
      }, STOP_GRACE_MS);
      const hardTimer = setTimeout(finish, STOP_GRACE_MS * 2);
    });
  }
  const { output, omittedLines } = readAgentDelta(record);
  table.entries.delete(record.handle);
  notify(table);
  return {
    handle: record.handle,
    label: record.label,
    status: "exited",
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
    settled: true,
    output,
    omittedLines,
  };
}

/** Tear down every job owned by the host (called on Carto shutdown, never on collapse). */
export async function stopAllJobs(table: JobTable): Promise<void> {
  activeTables.delete(table);
  const handles = [...table.entries.keys()];
  await Promise.all(handles.map((handle) => stopJob(table, handle).catch(() => undefined)));
}

/** Compact per-job summary for `<carto-state>` (§5.3): never carries scrollback buffers. */
export function summarizeJobs(table: JobTable): JobSummary[] {
  const now = table.now();
  const out: JobSummary[] = [];
  for (const record of table.entries.values()) {
    const unreadLines = unreadCountOf(record);
    const quietMs = Math.max(0, now - record.lastOutputAt);
    out.push({
      handle: record.handle,
      label: record.label,
      status: record.status,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      unreadLines,
      quietMs,
      active: record.status === "running" && unreadLines > 0 && quietMs < 500,
    });
  }
  return out;
}

/** Full read-only snapshots for the TUI `jobs` view. */
export function snapshotJobs(table: JobTable): JobSnapshot[] {
  const out: JobSnapshot[] = [];
  for (const record of table.entries.values()) {
    out.push({
      handle: record.handle,
      label: record.label,
      command: record.command,
      pid: record.child.pid,
      status: record.status,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      startedAt: record.startedAt,
      exitedAt: record.exitedAt,
      unreadLines: unreadCountOf(record),
      lines: [...record.lines],
      pendingPartial: pendingPartialOf(record),
    });
  }
  return out;
}

export function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `signal ${signal}`;
  return code === null ? "?" : String(code);
}
