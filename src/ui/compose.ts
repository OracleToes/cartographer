/**
 * The message composer's two escape hatches: an external editor, and Ctrl-C.
 *
 * pi-tui names Ctrl-G as "the external editor shortcut" (see
 * `stdin-buffer.ts`) and leaves the invocation to the host, and its `Editor`
 * offers `getExpandedText()` "when you need the full content (e.g., for external
 * editor)". What is left is the part that talks to a program outside this
 * process, which is what this file is.
 *
 * **The editor.** `$VISUAL`, then `$EDITOR`, then `vi` — the conventional order,
 * because `VISUAL` is the one meant for a full-screen editor and `EDITOR` for a
 * line editor. The command is parsed the way a shell would split it, so
 * `EDITOR="code --wait"` and `EDITOR="nvim -f"` work, and no shell is involved:
 * nothing in the person's message can be mistaken for shell syntax. The buffer
 * is written to a temporary file, the program is run on it with the terminal in
 * its normal state, and the file's text comes back as the prompt.
 *
 * **Ctrl-C.** Bash's behaviour, which is what the person asked for: with text on
 * the line it clears the line and does not leave; with the line already empty it
 * arms leaving, and a second press inside the window leaves. A press that is not
 * followed by another lets the arming lapse, so a stray Ctrl-C an hour ago does
 * not make the next one quit.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long a lone Ctrl-C on an empty line stays armed, as bash waits for a second one. */
export const CTRL_C_ARM_WINDOW_MS = 3_000;

/**
 * The program `$VISUAL` or `$EDITOR` names, split into a command and its
 * arguments. Empty means the variable is unset or blank, which is not a command.
 */
const splitCommand = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  // Whitespace splitting that respects single and double quotes, so a path with
  // spaces survives: EDITOR="'/Applications/Sublime Text/subl' -w".
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started || current !== "") {
        parts.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
  }
  if (started || current !== "") parts.push(current);
  return parts;
};

/**
 * What to run: `$VISUAL`, else `$EDITOR`, else `vi`. `undefined` when the person
 * set one of them to something that is only whitespace — the honest answer is
 * "there is no editor to run", not a silent fallback they did not ask for.
 */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | undefined {
  for (const name of ["VISUAL", "EDITOR"] as const) {
    const value = env[name];
    if (value === undefined) continue;
    const parts = splitCommand(value);
    if (parts.length === 0) return undefined;
    const [command, ...args] = parts;
    return command === undefined ? undefined : { command, args };
  }
  return { command: "vi", args: [] };
}

export type EditorOutcome =
  | { ok: true; text: string; command: string }
  | { ok: false; error: string; command?: string };

/**
 * Run the person's editor on `text` with the terminal handed over.
 *
 * `stdio: "inherit"` is the point: the child owns the tty while it runs, which
 * is only correct because the caller has already taken the TUI down (`tui.stop`).
 * A non-zero exit keeps whatever was saved to the file — an editor that exits
 * non-zero after writing is still a person who wrote something, and throwing
 * their words away because of the exit code would be worse than keeping them.
 */
export async function composeInEditor(
  text: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<EditorOutcome> {
  const editor = editorCommand(options.env);
  if (editor === undefined) {
    return { ok: false, error: "no editor set — $VISUAL and $EDITOR are empty, and no fallback was asked for" };
  }
  const directory = await mkdtemp(join(tmpdir(), "carto-edit-"));
  const file = join(directory, "message.md");
  try {
    await writeFile(file, text, "utf8");
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn(editor.command, [...editor.args, file], { stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, receivedSignal) => resolve(code ?? (receivedSignal === null ? 1 : 0)));
      options.signal?.addEventListener("abort", () => child.kill(), { once: true });
    });
    const written = await readFile(file, "utf8");
    if (status !== 0 && written === text) {
      return { ok: false, error: `${editor.command} exited ${status} and nothing was written`, command: editor.command };
    }
    return { ok: true, text: written, command: editor.command };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      command: editor.command,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Open an actual source file; the editor writes the source itself. */
export async function editSourceFile(file: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true } | { ok: false; error: string }> {
  const editor = editorCommand(env);
  if (editor === undefined) return { ok: false, error: "no editor is configured" };
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn(editor.command, [...editor.args, file], { stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    return status === 0 ? { ok: true } : { ok: false, error: `${editor.command} exited ${status}; the source may have been changed` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type CtrlCOutcome =
  /** Text was on the line: it was cleared, nothing else happened. */
  | { action: "cleared" }
  /** The line was empty: leaving is armed, and a second press within the window leaves. */
  | { action: "armed"; windowMs: number }
  /** The line was empty and this is the second press inside the window: leave. */
  | { action: "quit" };

/**
 * What one Ctrl-C means right now, as bash decides it (§ the person's request).
 *
 * `armedAt` is the time of the previous Ctrl-C on an empty line, if any; the
 * returned `armedAt` is what the caller should remember. A clear never arms
 * anything and disarms nothing: bash's `Ctrl-C` on a line with text is only a
 * line edit.
 */
export function ctrlC(input: { typed: string; armedAt: number | undefined; now: number }): { outcome: CtrlCOutcome; armedAt: number | undefined } {
  if (input.typed.trim() !== "") {
    return { outcome: { action: "cleared" }, armedAt: input.armedAt };
  }
  if (input.armedAt !== undefined && input.now - input.armedAt <= CTRL_C_ARM_WINDOW_MS) {
    return { outcome: { action: "quit" }, armedAt: undefined };
  }
  return { outcome: { action: "armed", windowMs: CTRL_C_ARM_WINDOW_MS }, armedAt: input.now };
}
