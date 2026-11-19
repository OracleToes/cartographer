import type { ProjectView } from "../runtime/project.js";
import type { Tab } from "./frame.js";

/**
 * One table for every key Carto binds. This is Posting's `actions()` idea:
 * the footer, the `?` reference and the `a` reference all read one list, so a
 * key cannot drift from its description, and a key that cannot act now is
 * never shown.
 *
 * A hint is a key plus its words by mode. `when` decides whether it is
 * available for the current view and selection; the footer drops what does
 * not fit, and the references list everything that is available right now.
 */

export type Mode = "navigate" | "insert";

export interface ActionContext {
  mode: Mode;
  tab: Tab;
  view: ProjectView;
  /** The selected row is a Chat record. */
  chatSelected: boolean;
  /** The selected row is a live disclosure item. */
  activitySelected: boolean;
  /** The selected row is a pin in the Context tab. */
  pinSelected: boolean;
  /** The selected row is a Brain record. */
  brainSelected: boolean;
  /** A reference or the edit hint is open over the list. */
  detailOpen: boolean;
  /** A record page has replaced the body, so the list is not the thing on screen. */
  recordOpen: boolean;
  /** The agent or a local action is working. */
  busy: boolean;
  /** A turn is paused. */
  paused: boolean;
  /** A turn is running. */
  running: boolean;
}

export interface Action {
  /** A stable identity, so a test can name an action. */
  id: string;
  /** The keys, first one shown in the footer. */
  keys: readonly string[];
  /** The words in the footer. */
  label: string;
  /** The line in the `?` reference. */
  help: string;
  /** The group in the `?` reference. */
  group: "move" | "chat" | "context" | "turn" | "view" | "commands";
  /** A key that only a tooltip names, such as a reference line. */
  hidden?: boolean;
  /** True when the key can act now. */
  when?: (context: ActionContext) => boolean;
  /** A short note for the reference, such as the short form of a command. */
  note?: string;
}

const navigating = (context: ActionContext): boolean => context.mode === "navigate";
/**
 * Navigate mode with the list visible.
 *
 * A record page replaces the body, so the keys that move the list are not the
 * keys that work while it is open. Gating the *actions* rather than the footer
 * is what keeps one list of keys in one place: `?`, the footer, and the key
 * handler all read the same `available(context)`.
 */
const listing = (context: ActionContext): boolean => navigating(context) && !context.recordOpen;
const chatting = (context: ActionContext): boolean => navigating(context) && context.tab === "chat";
const onContext = (context: ActionContext): boolean => navigating(context) && context.tab === "context";

export const ACTIONS: readonly Action[] = [
  { id: "move", keys: ["j", "k"], label: "move", help: "Move the selection down or up. The arrow keys do the same.", group: "move", when: listing },
  { id: "ends", keys: ["g", "G"], label: "ends", help: "Move the selection to the first or the last row.", group: "move", when: listing },
  { id: "tabs", keys: ["1", "2", "3"], label: "tabs", help: "Show Chat, Brain, or Context.", group: "view", when: (context) => context.mode === "navigate" && !context.detailOpen && !context.recordOpen },
  { id: "input", keys: ["i"], label: "input", help: "Open the input. In Chat edit detail it replaces the selected Chat text.", group: "turn", when: (context) => listing(context) && !context.busy },
  // A reference describes the list, and a record page covers the list, so both
  // references belong to the list view only.
  { id: "actions", keys: ["a"], label: "actions", help: "Show the compact command reference. Esc closes it.", group: "view", when: listing },
  { id: "help", keys: ["?"], label: "help", help: "Show every key that works now. Esc closes it.", group: "view", when: listing },
  { id: "fold", keys: ["f"], label: "fold", help: "Fold or unfold the selected Chat item. A folded item stays in agent context.", group: "chat", when: (context) => chatting(context) && context.chatSelected },
  { id: "edit", keys: ["e"], label: "edit", help: "Open edit detail for the selected Chat item.", group: "chat", when: (context) => chatting(context) && context.chatSelected },
  { id: "disclosure", keys: ["o"], label: "open", help: "Expand or fold the selected live disclosure.", group: "chat", when: (context) => chatting(context) && context.activitySelected },
  { id: "agent-chat", keys: ["A"], label: "agent chat", help: "Open the input to add person-authored Agent Chat.", group: "chat", when: (context) => chatting(context) && !context.busy },
  { id: "delete", keys: ["d"], label: "delete at collapse", help: "Mark the selected Chat item for removal at the next collapse.", group: "chat", when: (context) => chatting(context) && context.chatSelected && !context.busy },
  { id: "delete-now", keys: ["D"], label: "delete now", help: "Remove the selected Chat item now. This starts a fresh live context.", group: "chat", when: (context) => chatting(context) && context.chatSelected && !context.busy },
  { id: "unpin", keys: ["u"], label: "remove at collapse", help: "Remove the selected pin at the next collapse.", group: "context", when: (context) => onContext(context) && context.pinSelected && !context.busy },
  { id: "unpin-now", keys: ["U"], label: "remove now", help: "Remove the selected pin now and restart from a fresh context.", group: "context", when: (context) => onContext(context) && context.pinSelected && !context.busy },
  { id: "pause", keys: ["p"], label: "pause", help: "Stop at a durable boundary and keep an editable draft.", group: "turn", when: (context) => navigating(context) && context.running },
  { id: "resume", keys: ["r"], label: "resume", help: "Edit the paused draft, or start the next useful task when idle.", group: "turn", when: (context) => listing(context) && (context.paused || !context.busy) },
  { id: "cancel", keys: ["x"], label: "cancel", help: "Cancel the running or paused turn.", group: "turn", when: (context) => navigating(context) && (context.running || context.paused) },
  { id: "interrupt", keys: ["I"], label: "interrupt", help: "Stop the active stream and send now.", group: "turn", when: (context) => navigating(context) && !context.busy, hidden: true },
  { id: "steer", keys: ["S"], label: "steer", help: "Queue a message for the next durable boundary.", group: "turn", when: (context) => navigating(context) && !context.busy, hidden: true },
  { id: "follow-up", keys: ["F"], label: "follow-up", help: "Queue a message to start after the active run.", group: "turn", when: (context) => navigating(context) && !context.busy, hidden: true },
  { id: "escape", keys: ["Esc"], label: "back", help: "Return to Navigate mode and close a detail.", group: "view", when: (context) => context.mode === "insert" || context.detailOpen },
  { id: "close-detail", keys: ["Backspace"], label: "close", help: "Close a detail, or clear the selection.", group: "view", when: (context) => context.detailOpen, hidden: true },
  { id: "page-scroll", keys: ["j k"], label: "scroll", help: "Move the record page one line. g and G jump to the ends.", group: "move", when: (context) => context.recordOpen },
  { id: "page-back", keys: ["Esc"], label: "back", help: "Return to the list; the record stays selected.", group: "view", when: (context) => context.recordOpen },
  { id: "page-ends", keys: ["g", "G"], label: "ends", help: "Jump the record page to its first or last line.", group: "move", when: (context) => context.recordOpen },
  { id: "open", keys: ["Enter"], label: "open", help: "Open the selected record whole. In the input box, Enter sends instead.", group: "view", when: (context) => context.mode === "navigate" && !context.detailOpen && !context.recordOpen },
  { id: "send", keys: ["Enter"], label: "send", help: "Send with the chosen mode, or run a command that starts with `/`.", group: "turn", when: (context) => context.mode === "insert" },
  { id: "quit", keys: ["Ctrl+C"], label: "quit", help: "Close Carto.", group: "view", when: () => true, hidden: true },
];

export function available(context: ActionContext): Action[] {
  return ACTIONS.filter((action) => action.when === undefined || action.when(context));
}

/**
 * The hints for the footer, written as `j k move · i input`. A double key
 * such as `j k move` is one hint, because both keys do one thing.
 */
export function hintText(action: Action): string {
  return `${action.keys.join(" ")} ${action.label}`;
}

/** The footer: the available hints, in order, that fit, and nothing cut in half. */
export function footerHints(context: ActionContext, cells: number, widthOf: (text: string) => number, separator = " · "): string {
  const hints = available(context)
    .filter((action) => action.hidden !== true)
    .map(hintText);
  const kept: string[] = [];
  let used = 0;
  for (const hint of hints) {
    const cost = (kept.length === 0 ? 0 : widthOf(separator)) + widthOf(hint);
    if (used + cost > cells) break;
    kept.push(hint);
    used += cost;
  }
  return kept.join(separator);
}
