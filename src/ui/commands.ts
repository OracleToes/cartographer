/**
 * The command registry (§8, Posting's idiom).
 *
 * Posting has one list of actions per screen; every binding, the footer bar,
 * the `f1` help panel and the `^p` palette are all projections of that one
 * list. That is why a key you learn in the palette is the key that works, and
 * why the panel cannot drift from the app. Carto does the same:
 *
 * - a key declared here is matched here, in declaration order;
 * - the footer is drawn from the commands that are `available` where the cursor
 *   is, most useful first;
 * - `f1` lists *every* command, grouped, with its key — including the ones the
 *   footer has no room for;
 * - the palette lists the same commands, optionally renamed at the moment it
 *   opens (`Layout: stacked` ↔ `side by side`).
 *
 * Commands whose key is `undefined` are palette-only (a layout or a mode that
 * has no keypress of its own). A command's `label` is written as a verb phrase
 * so a footer reads like a sentence when skimmed.
 */
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export interface Command {
  /** Stable id, used by the palette and by tests; never shown. */
  id: string;
  /** The group its `f1` row and palette row sit under. */
  group: string;
  /** What the command does, worded to read under a key in the footer. */
  label: string;
  /** `undefined` for a palette-only command. */
  key?: KeyId;
  /** Shown in `f1` and the palette between the key and the label when it is not obvious. */
  hint?: string;
  /** Not drawn in the footer even when available (help travels in the palette). */
  quiet?: boolean;
  /** Whether the command does anything where the cursor is now. */
  available(): boolean;
  run(): void;
}

/**
 * Every key a command claims. `matchesKey` is the only matcher used, so the
 * footer, `f1` and the input router cannot disagree about what a key is.
 */
export class Registry {
  constructor(private readonly commands: Command[]) {}

  all(): readonly Command[] {
    return this.commands;
  }

  /** Commands that would do something right now, in declaration order. */
  active(): Command[] {
    return this.commands.filter((command) => {
      try {
        return command.available();
      } catch {
        return false;
      }
    });
  }

  /** The footer: the active commands that want to be in it. */
  footer(): Command[] {
    return this.active().filter((command) => command.quiet !== true && command.key !== undefined);
  }

  /** Match a keystroke. Returns true when a command consumed it. */
  dispatch(data: string): boolean {
    for (const command of this.commands) {
      if (command.key === undefined) continue;
      if (!matchesKey(data, command.key)) continue;
      let available = false;
      try {
        available = command.available();
      } catch {
        available = false;
      }
      if (!available) continue; // another command on this key may be available in the active view
      command.run();
      return true;
    }
    return false;
  }
}

/** The label a command carries right now, for the palette: a toggling command says what pressing it does. */
export const commandLabel = (command: Command): string => command.label;
