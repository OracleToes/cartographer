/**
 * The clipboard path (the person's `/copy` work, 2026-11-20).
 *
 * pi-tui already has the mechanism: TuiAltScreen takes an injectable
 * `copySelection` — its own built-in fallback is a bare OSC 52 write, which
 * "can show 'Copied!' while leaving the system clipboard untouched" (tmux
 * without `set-clipboard on`, macOS Terminal.app). Carto injects a verified
 * native path into the TUI — mouse selection copies get it too — and uses
 * the same path for `/copy` and `/copy-session`. Platform tools, fixed
 * order, first success wins. If none succeeds the honest result is an error
 * string; the caller still writes the /tmp fallback file and names it.
 */
import { execFileSync } from "node:child_process";
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

export type ClipboardOutcome = { ok: true; tool: string } | { ok: false; error: string };

/** Write `text` to the system clipboard via the first tool that works. */
export function writeClipboard(text: string): ClipboardOutcome {
  let last = "no clipboard tool found (tried wl-copy, xclip, xsel, pbcopy, clip.exe)";
  for (const tool of TOOLS) {
    try {
      execFileSync(tool.command, tool.args, { input: text, timeout: 2_000, stdio: ["pipe", "ignore", "ignore"] });
      return { ok: true, tool: tool.name };
    } catch (error) {
      last = `${tool.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { ok: false, error: last };
}

export interface CopyOutcome {
  /** Human phrase for a status line, e.g. "copied via xclip" or "clipboard unavailable (…)". */
  where: string;
  fallbackPath: string;
  bytes: number;
}

/** Copy + always leave a /tmp fallback; used by /copy and /copy-session. */
export async function copyWithFallback(text: string, stem: string): Promise<CopyOutcome> {
  const fallbackPath = join(tmpdir(), `carto-${stem}-${Date.now()}.txt`);
  await writeFile(fallbackPath, text, "utf8");
  const result = writeClipboard(text);
  return {
    where: result.ok ? `copied via ${result.tool}` : `clipboard unavailable (${result.error})`,
    fallbackPath,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

/** The injectable shape TuiAltScreenOptions.copySelection wants: true on verified success, a flash-able error otherwise. */
export function createSelectionCopier(): (text: string) => Promise<true | string> {
  return async (text: string) => {
    const result = writeClipboard(text);
    return result.ok ? true : `clipboard unavailable (${result.error})`;
  };
}
