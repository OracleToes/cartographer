/**
 * The prompt's ephemeral handles (§5.4), numbered once for both views.
 *
 * Brain records are handled by the Brain's own table (`A`, `L`, `C`). Everything
 * else in the prompt is ephemeral — reasoning, the agent's plain text, tool
 * calls, their results, the person's messages — and has no record to hold a
 * handle, so its number comes from its position in the prompt. `X` is one
 * ephemeral item, `U` is a person's message, and `R` is a tool call's result,
 * with `S` for the shell, because a bash result is quoted far more than it is
 * cited. Every one of them counts in prompt order, so a handle means the same
 * thing in the transcript and in the Context view, which show one prompt two
 * ways.
 *
 * A result is its own item and its own handle: it arrives in the prefill as a
 * message of its own (§5.2), and pinning it pins the result rather than the call
 * that asked for it (§5.5).
 */

/** One item the prompt holds, in prompt order. */
export interface PromptItem {
  kind: "person" | "call" | "result" | "reasoning" | "text";
  /** The view's own row id, which is what a handle is looked up by. */
  key: string;
  /** For a result: the tool that produced it. `bash` takes `S`; everything else `R`. */
  tool?: string | undefined;
}

export interface PromptHandles {
  /** `X1`, `X2`… for one ephemeral item, by its row id. */
  ephemeral: (key: string) => string | undefined;
  /** `U1`, `U2`… for one of the person's messages, by its row id. */
  person: (key: string) => string | undefined;
  /** `R1` for a tool result, `S1` for a shell result, by the result's row id. */
  result: (key: string) => string | undefined;
  /**
   * `P A3` for a pin, by the handle of the entry it marks (§5.4).
   *
   * A pin is named by what it marks, not by a number of its own: it is the same
   * pin whether it is read in the block, in the head, or over an archived item,
   * and `P A3` says which entry without a second table to look it up in.
   */
  pin: (entryHandle: string) => string;
}

/**
 * A pin's handle: the pin's letter and the handle of the entry it marks (§5.4).
 * One function, because the block, the transcript and the Context view all show
 * the same pin and must show the same name for it.
 */
export function pinHandle(entryHandle: string): string {
  return `P ${entryHandle}`;
}

export function promptHandles(items: readonly PromptItem[]): PromptHandles {
  const ephemeral = new Map<string, string>();
  const person = new Map<string, string>();
  const results = new Map<string, string>();
  let nextEphemeral = 0;
  let nextPerson = 0;
  let nextResult = 0;
  let nextShell = 0;
  for (const item of items) {
    if (item.kind === "person") {
      nextPerson += 1;
      person.set(item.key, `U${nextPerson}`);
      continue;
    }
    if (item.kind === "result") {
      const shell = item.tool === "bash";
      if (shell) nextShell += 1;
      else nextResult += 1;
      results.set(item.key, `${shell ? "S" : "R"}${shell ? nextShell : nextResult}`);
      continue;
    }
    nextEphemeral += 1;
    ephemeral.set(item.key, `X${nextEphemeral}`);
  }
  return {
    ephemeral: (key) => ephemeral.get(key),
    person: (key) => person.get(key),
    result: (key) => results.get(key),
    pin: pinHandle,
  };
}
