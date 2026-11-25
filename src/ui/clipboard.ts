/**
 * Every copy path shares this backend, including pi-tui's mouse selection.
 * Native clipboard tools can reach a local display; inside tmux we also load
 * the tmux paste buffer and ask tmux to forward it to the attached terminal.
 * A successful tmux command cannot verify the terminal's clipboard, so its
 * status must distinguish the buffer from the forwarding request.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOLS: ReadonlyArray<{ name: string; command: string; args: string[] }> = [
  { name: "wl-copy", command: "wl-copy", args: [] },
  { name: "xclip", command: "xclip", args: ["-selection", "clipboard"] },
  { name: "xsel", command: "xsel", args: ["--clipboard", "--input"] },
  { name: "pbcopy", command: "pbcopy", args: [] },
  { name: "clip.exe", command: "clip.exe", args: [] },
];

export interface ClipboardOutcome {
  /** A successfully invoked native clipboard tool, if any. */
  native?: string;
  /** `forward` means tmux accepted -w, not that the terminal accepted OSC 52. */
  tmux?: "forward" | "buffer";
  error?: string;
}

/** Injection keeps the actual program and its stdin testable without a desktop or tmux server. */
export interface ClipboardOptions {
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], text: string) => void;
}

const runProgram = (command: string, args: string[], text: string): void => {
  execFileSync(command, args, { input: text, timeout: 2_000, stdio: ["pipe", "ignore", "ignore"] });
};

/** Try tmux and the native clipboard independently; neither implies the other. */
export function writeClipboard(text: string, options: ClipboardOptions = {}): ClipboardOutcome {
  const run = options.run ?? runProgram;
  const env = options.env ?? process.env;
  const outcome: ClipboardOutcome = {};
  if (env.TMUX) {
    // tmux's load-buffer silently ignores an empty stdin, even with -w. Do not
    // claim the old buffer was replaced in that case.
    if (text.length === 0) outcome.error = "tmux cannot store an empty buffer";
    else {
      try {
        run("tmux", ["load-buffer", "-w", "-"], text);
        outcome.tmux = "forward";
      } catch {
        // -w arrived in tmux 3.2. Older versions can still paste the buffer.
        try {
          run("tmux", ["load-buffer", "-"], text);
          outcome.tmux = "buffer";
        } catch {
          outcome.error = "tmux buffer unavailable";
        }
      }
    }
  }
  for (const tool of TOOLS) {
    try {
      run(tool.command, tool.args, text);
      outcome.native = tool.name;
      break;
    } catch { /* Try the next platform tool. */ }
  }
  if (outcome.native === undefined && outcome.tmux === undefined && outcome.error === undefined) {
    outcome.error = "no clipboard tool available";
  }
  return outcome;
}

/** Describe only what is known: tmux's terminal clipboard has no acknowledgement. */
export function describeClipboard(result: ClipboardOutcome): string {
  const parts: string[] = [];
  if (result.native !== undefined) parts.push(`system clipboard via ${result.native}`);
  if (result.tmux === "forward") parts.push("tmux buffer saved; terminal clipboard forwarding requested (not verified)");
  if (result.tmux === "buffer") parts.push("tmux buffer saved; terminal clipboard not forwarded (tmux -w unavailable)");
  if (result.error !== undefined) parts.push(result.error);
  return parts.join("; ");
}

export interface CopyOutcome {
  where: string;
  fallbackPath: string | undefined;
  fallbackError: string | undefined;
  bytes: number;
  clipboard: ClipboardOutcome;
}

async function saveFallback(text: string, stem: string): Promise<string> {
  const path = join(tmpdir(), `carto-${stem}-${randomUUID()}.txt`);
  await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

/** Copy even if the temporary fallback cannot be written. */
export async function copyWithFallback(text: string, stem: string, options: ClipboardOptions = {}): Promise<CopyOutcome> {
  const clipboard = writeClipboard(text, options);
  let fallbackPath: string | undefined;
  let fallbackError: string | undefined;
  try { fallbackPath = await saveFallback(text, stem); }
  catch (error) { fallbackError = error instanceof Error ? error.message : String(error); }
  return { where: describeClipboard(clipboard), fallbackPath, fallbackError, bytes: Buffer.byteLength(text, "utf8"), clipboard };
}

export function describeFallback(result: Pick<CopyOutcome, "fallbackPath" | "fallbackError">): string {
  return result.fallbackPath === undefined ? `fallback unavailable (${result.fallbackError ?? "unknown error"})` : `saved to ${result.fallbackPath}`;
}

/** pi-tui uses true for a confirmed native copy; a message can describe a tmux-only result honestly. */
export function createSelectionCopier(options: ClipboardOptions = {}): (text: string) => Promise<true | string> {
  return async (text: string) => {
    const clipboard = writeClipboard(text, options);
    if (clipboard.native !== undefined) return true;
    try {
      const path = await saveFallback(text, "selection");
      return `${describeClipboard(clipboard)}; saved to ${path}`;
    } catch (error) {
      return `${describeClipboard(clipboard)}; fallback unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
  };
}
