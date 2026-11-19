import type { ProviderMessage, ProviderPayload } from "../runtime/prompt-store.js";

/**
 * What the model is about to be sent, as a tree.
 *
 * The person's requirement is exact: Context is a fully accurate representation
 * of everything the agent sees, in the order it sees it. So this file does not
 * re-project the Brain and hope the result matches the prompt. It walks the
 * payload Pi built for the next request, in the provider's own order, and turns
 * each part into a node. If a part is not in the payload, it is not in the tree,
 * and the reverse.
 *
 * Three shapes are worth knowing before reading this:
 *
 * 1. **The payload is provider-shaped, not Carto-shaped.** OpenAI-compatible
 *    APIs take `{ model, messages, tools }`; Anthropic takes a top-level
 *    `system` plus `messages`. Both are walked here. An unrecognised field is
 *    still shown in the real view, because the real view is the payload's own
 *    JSON and not a re-serialisation of this tree.
 * 2. **Tool schemas are often a sibling of the messages, not inside them.** When
 *    they are, they get their own root, in the position the provider puts them.
 *    When a provider attaches tools to a message instead, they nest there.
 * 3. **A node's raw text is its own JSON.** That is what the real view shows, so
 *    the real view cannot drift from what was sent.
 */

export interface TreeNode {
  /** Stable within one payload, so a fold survives a refresh. */
  id: string;
  /** What this node is, in as few words as fit. */
  label: string;
  /** The human-readable rows. Wrapped to the caller's width when drawn. */
  lines: readonly string[];
  /** The provider's own representation of this node. */
  raw: string;
  /** Shown when expanded; a leaf has none. */
  children: readonly TreeNode[];
  /** Estimated tokens for this node and its children, for sharing out a total. */
  weight: number;
  /**
   * The node's text no longer matches the record it came from.
   *
   * A sent message is history: editing the Chat record behind it does not
   * rewrite what was sent. The node keeps the record so the person can see which
   * record it was, but it is marked `stale` so the screen does not offer an
   * edit that would silently do nothing to this row.
   */
  stale?: boolean;
  /**
   * The durable record this node came from, when there is one.
   *
   * A prompt is built from records, but a prompt part is not a record: the
   * instructions block has no record, and a tool schema is code. Only a node
   * with a `record` can be edited through the record layer, and the UI says so
   * rather than offering an edit that has nowhere to go.
   */
  record?: PromptRecordRef;
}

export interface PromptRecordRef {
  kind: "chat" | "ledger" | "atlas";
  /** The generation-local handle, which is the only name the person sees. */
  handle: string;
  /** The durable id, resolved below the presentation layer. */
  id: string;
}

/** A record the prompt might contain, with the names the screen can show. */
export interface RecordHint {
  kind: "chat" | "ledger" | "atlas";
  handle: string;
  id: string;
  /** The record's own text, used to match a Person message exactly. */
  text: string;
}

export interface ContextTree {
  /** The nodes, in the order the provider receives them. */
  roots: readonly TreeNode[];
  /** The payload's own JSON, for the whole-prompt real view. */
  raw: string;
  /** Total tokens: the provider's own count when it has reported one. */
  total?: number;
  /** True when `total` came from a provider's usage report. */
  exact: boolean;
  /** When this tree was taken. */
  at: number;
}

/**
 * Build the tree from a provider payload.
 *
 * `usage` is the provider's own count for this request, when the response has
 * arrived. Until it does, the tree is structural and `exact` is false, which is
 * the one case where the screen is allowed to show an estimate.
 */
export function contextTree(
  payload: ProviderPayload,
  at: number,
  usage?: number,
  /**
   * The handle table and record ids, so a prompt node can name the record it came
   * from. The system message carries Carto's whole projection as text, so this
   * cannot be recovered from the payload alone; the caller passes it and a node
   * without a match simply has no record.
   */
  records?: readonly RecordHint[],
): ContextTree {
  const roots: TreeNode[] = [];
  let index = 0;

  if (payload.system !== undefined) {
    const text = typeof payload.system === "string" ? payload.system : JSON.stringify(payload.system, null, 2);
    roots.push({ ...node(`system-${index++}`, "System prompt", text.split("\n"), text), children: [] });
  }
  // A Person message consumes one Chat record, in order: the prompt carries one
  // message per Chat, so pairing them by position is exact and survives an edit.
  let chatCursor = 0;
  const chats = (records ?? []).filter((record) => record.kind === "chat");
  for (const message of payload.messages ?? []) {
    if (message.role === "user") {
      // One record per Person message, in order. The cursor advances after the
      // slice is taken, not inside the call.
      const mine = chats[chatCursor] === undefined ? [] : [chats[chatCursor]!];
      chatCursor += 1;
      roots.push(messageNode(message, index++, mine));
    } else {
      roots.push(messageNode(message, index++, records));
    }
  }
  if (payload.tools !== undefined && payload.tools.length > 0) {
    roots.push(toolsNode(payload.tools, `tools-${index++}`));
  }
  // Anything else the provider was given belongs in the list too: it is part of
  // the request even though Carto does not model it. Scalars are summarised on
  // one row because a parameter is not a prompt part: `stream`, `max_tokens`,
  // and `temperature` would otherwise outnumber the messages and bury them.
  const settings: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "model" || key === "system" || key === "messages" || key === "tools") continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      const text = JSON.stringify(value, null, 2);
      roots.push({ ...node(`extra-${key}`, key, text.split("\n"), text), children: [] });
    } else {
      settings.push(`${key}: ${String(value)}`);
    }
  }
  if (settings.length > 0) {
    roots.push({ ...node("settings", "Request settings", settings, JSON.stringify(settings, null, 2)), children: [] });
  }

  // A zero is not a measurement. A provider that does not report usage, or a
  // response that has not arrived, gives `0` here, and treating that as an exact
  // total would make every share zero while the screen claimed precision. The
  // tree is exact only when the provider reported a positive count.
  const measured = usage !== undefined && usage > 0;
  return {
    roots,
    raw: JSON.stringify(payload, null, 2),
    ...(measured ? { total: usage } : {}),
    exact: measured,
    at,
  };
}

/** The tree's nodes as a flat list, for a caller that wants to walk or draw it. */
export function flatten(nodes: readonly TreeNode[], depth = 0): Array<{ node: TreeNode; depth: number }> {
  const out: Array<{ node: TreeNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

/** A node and all of its descendants, by id. */
export function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Share `total` across the tree in proportion to each node's text.
 *
 * Called only when the provider has reported a real total. The shares are
 * proportional, so they are marked inexact wherever they are drawn; the total
 * itself is the provider's, and that is the number the bar shows.
 */
export function distribute(nodes: readonly TreeNode[], total: number): Map<string, number> {
  const weights = new Map<string, number>();
  for (const node of nodes) weigh(node, weights);
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  const shares = new Map<string, number>();
  if (sum === 0) return shares;
  for (const [id, weight] of weights) shares.set(id, Math.round((weight / sum) * total));
  return shares;
}

function weigh(node: TreeNode, weights: Map<string, number>): number {
  const own = Math.max(1, Math.ceil(node.raw.length / 4));
  const children = node.children.reduce((sum, child) => sum + weigh(child, weights), 0);
  const weight = own + children;
  weights.set(node.id, weight);
  return weight;
}

function messageNode(message: ProviderMessage, index: number, records?: readonly RecordHint[]): TreeNode {
  const role = typeof message.role === "string" ? message.role : "unknown";
  const id = `message-${index}`;
  const label = labelFor(role, message);
  const children: TreeNode[] = [];

  const record = records?.find((hint) => matches(role, message, hint));
  // A matched Chat record whose text has since changed no longer describes this
  // node. Only a Chat record has its own text in the prompt as a message body;
  // a Ledger or Atlas record appears inside the projection, whose surrounding
  // lines make an exact comparison meaningless.
  const stale =
    record !== undefined &&
    record.kind === "chat" &&
    typeof message.content === "string" &&
    message.content !== record.text;

  // A message's content is a string, or a list of parts. Both are walked so the
  // real order inside one message is preserved.
  if (typeof message.content === "string") {
    if (message.content.trim() !== "") {
      children.push({
        ...textNode(`${id}-content`, "Text", message.content),
        ...(record === undefined ? {} : { record }),
        ...(stale ? { stale: true } : {}),
      });
    }
  } else if (Array.isArray(message.content)) {
    message.content.forEach((part, partIndex) => {
      const child = partNode(part, `${id}-part-${partIndex}`);
      if (child !== undefined) children.push(child);
    });
  }
  if (message.tool_calls !== undefined) {
    message.tool_calls.forEach((call, callIndex) => {
      const record = call as { function?: { name?: unknown; arguments?: unknown }; id?: unknown };
      const name = typeof record.function?.name === "string" ? record.function.name : "tool";
      const args = typeof record.function?.arguments === "string" ? record.function.arguments : JSON.stringify(record.function?.arguments ?? {});
      children.push({
        ...node(`${id}-call-${callIndex}`, `Call → ${name}`, prettyJson(args).split("\n"), JSON.stringify(call, null, 2)),
        children: [],
      });
    });
  }
  if (message.tools !== undefined && message.tools.length > 0) {
    children.push(toolsNode(message.tools, `${id}-tools`));
  }

  return {
    ...node(id, label, children.length === 0 ? ["(empty)"] : [`${children.length} ${children.length === 1 ? "part" : "parts"}`], JSON.stringify(message, null, 2)),
    children,
    ...(record === undefined ? {} : { record }),
    ...(stale ? { stale: true } : {}),
  };
}

/**
 * Does this message carry this record's text?
 *
 * A Person message is the Chat record itself. The system message carries the
 * whole projection, so a record is matched by its handle line, which the
 * projection writes as `L1 Ledger · ...`. Matching the handle line rather than
 * the record's body keeps a record whose text is also quoted elsewhere from
 * claiming the wrong node.
 */
function matches(role: string, message: ProviderMessage, hint: RecordHint): boolean {
  // A Person message is its Chat record whether or not the record still reads
  // the same; a text comparison would detach the node the moment it was edited,
  // which is exactly when the person needs to see the connection.
  if (hint.kind === "chat" && role === "user") return true;
  if (role !== "system" && role !== "developer") return false;
  if (typeof message.content !== "string") return false;
  return message.content.includes(`${hint.handle} `) || message.content.includes(`${hint.handle}\n`);
}

function partNode(part: unknown, id: string): TreeNode | undefined {
  if (part === null || typeof part !== "object") return undefined;
  const record = part as { type?: unknown; text?: unknown; image_url?: unknown; source?: unknown };
  if (record.type === "text" && typeof record.text === "string") return textNode(id, "Text", record.text);
  if (record.type === "image_url" || record.type === "image" || record.source !== undefined) {
    return { ...node(id, "Image", ["(an image part)"], JSON.stringify(part, null, 2)), children: [] };
  }
  const raw = JSON.stringify(part, null, 2);
  return { ...node(id, String(record.type ?? "part"), raw.split("\n"), raw), children: [] };
}

function textNode(id: string, label: string, text: string): TreeNode {
  return { ...node(id, label, text.split("\n"), JSON.stringify(text)), children: [] };
}

function toolsNode(tools: readonly unknown[], id: string): TreeNode {
  const children = tools.map((tool, index) => {
    const record = tool as { function?: { name?: unknown; description?: unknown; parameters?: unknown }; name?: unknown };
    const name = typeof record.function?.name === "string" ? record.function.name : typeof record.name === "string" ? record.name : `tool ${index + 1}`;
    const description = typeof record.function?.description === "string" ? record.function.description : undefined;
    const parameters = record.function?.parameters ?? (tool as { parameters?: unknown }).parameters;
    const lines = [...(description === undefined ? [] : [description, ""]), ...schemaLines(parameters)];
    if (lines.length === 0) lines.push("(no parameters)");
    return { ...node(`${id}-${index}-${name}`, name, lines, JSON.stringify(tool, null, 2)), children: [] };
  });
  return {
    ...node(id, "Tools", [`${tools.length} available`], JSON.stringify(tools, null, 2)),
    children,
  };
}

function node(id: string, label: string, lines: readonly string[], raw: string): TreeNode {
  return { id, label, lines, raw, children: [], weight: 0 };
}

function labelFor(role: string, message: ProviderMessage): string {
  if (role === "system" || role === "developer") return "System prompt";
  if (role === "user") return "Person · you";
  if (role === "assistant") {
    return message.tool_calls !== undefined && message.tool_calls.length > 0 ? "Model · tool calls" : "Model";
  }
  if (role === "tool") {
    const name = typeof message.name === "string" ? message.name : typeof message.tool_call_id === "string" ? message.tool_call_id : "tool";
    return `Tool result · ${name}`;
  }
  return role;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** A schema as short `name: type` rows, for the human view. */
function schemaLines(parameters: unknown): string[] {
  if (parameters === null || typeof parameters !== "object") return [];
  const schema = parameters as { properties?: Record<string, { type?: unknown; description?: unknown }>; required?: string[] };
  if (schema.properties === undefined) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, value]) => {
    const type = typeof value.type === "string" ? value.type : "any";
    const description = typeof value.description === "string" ? ` — ${value.description}` : "";
    return `  ${name}${required.has(name) ? "" : "?"}: ${type}${description}`;
  });
}
