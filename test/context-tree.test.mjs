import assert from "node:assert/strict";
import test from "node:test";

const { contextTree, flatten } = await import("../dist/domain/prompt-tree.js");
const { treeRows, selectableOf } = await import("../dist/ui/context-tree.js");

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** A payload shaped like the one the OpenAI-compatible adapter builds. */
function payload() {
  return {
    model: "llama-swap/Flint",
    messages: [
      { role: "system", content: "# Carto context\n\n## Rules\nR1 Carto rules\nUse only Carto records." },
      { role: "user", content: "What is the retry policy?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "chat", arguments: '{"text":"hello"}' } }] },
      { role: "tool", tool_call_id: "c1", name: "chat", content: "Chat message saved." },
    ],
    tools: [
      { type: "function", function: { name: "chat", description: "Send one message.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
      { type: "function", function: { name: "ledger", description: "Record a goal.", parameters: { type: "object", properties: { text: { type: "string" } } } } },
    ],
    stream: true,
    max_tokens: 4096,
  };
}

test("the tree is the payload, in the provider's order", () => {
  const tree = contextTree(payload(), 1_000);
  assert.deepEqual(
    tree.roots.map((root) => root.label),
    ["System prompt", "Person · you", "Model · tool calls", "Tool result · chat", "Tools", "Request settings"],
  );
  // The message order is not re-sorted, and the tool result follows its call.
  assert.match(tree.roots[0].raw, /Carto context/);
  assert.match(tree.roots[3].raw, /Chat message saved/);
});

test("tools are their own sub-tree, one node per tool, with a schema in the human view", () => {
  const tree = contextTree(payload(), 1_000);
  const tools = tree.roots.find((root) => root.label === "Tools");
  assert.ok(tools !== undefined);
  assert.deepEqual(tools.children.map((child) => child.label), ["chat", "ledger"]);
  const chat = tools.children[0];
  assert.match(chat.lines.join("\n"), /Send one message\./);
  assert.match(chat.lines.join("\n"), /text: string/);
});

test("the real view is the node's own JSON, so it cannot disagree with what was sent", () => {
  const tree = contextTree(payload(), 1_000);
  const person = tree.roots[1];
  assert.deepEqual(JSON.parse(person.raw), { role: "user", content: "What is the retry policy?" });
});

test("a leaf shows its content without folding; a parent shows only its row until opened", () => {
  const tree = contextTree(payload(), 1_000);
  const closed = treeRows(tree, new Set(), new Set(), 0, 100);
  const closedText = closed.map((row) => plain(row.text)).join("\n");
  assert.match(closedText, /System prompt/);
  assert.doesNotMatch(closedText, /Carto context/, "a closed parent leaks its content");

  const opened = treeRows(tree, new Set(["message-0"]), new Set(), 0, 100);
  assert.match(opened.map((row) => plain(row.text)).join("\n"), /Carto context/);
});

test("folding and unfolding a node keeps the selected row on a node", () => {
  const tree = contextTree(payload(), 1_000);
  const before = treeRows(tree, new Set(), new Set(), 0, 100);
  // The first selectable row is the system prompt, whichever state it is in.
  assert.equal(selectableOf(before)[0], "message-0");
  const after = treeRows(tree, new Set(["message-0"]), new Set(), 0, 100);
  assert.equal(selectableOf(after)[0], "message-0");
  assert.ok(after.length > before.length, "unfolding adds rows");
});

test("a zero usage count is not treated as an exact measurement", () => {
  const zero = contextTree(payload(), 1_000, 0);
  assert.equal(zero.exact, false);
  assert.equal(zero.total, undefined);
  const real = contextTree(payload(), 1_000, 6_800);
  assert.equal(real.exact, true);
  assert.equal(real.total, 6_800);
  // Every node is reachable and numbered, so the selection cannot point at
  // nothing.
  assert.ok(flatten(real.roots).length >= real.roots.length);
});

test("every root in the tree is reachable and shows its content once unfolded", () => {
  // The defect: the render clamped the selection with the durable block count,
  // so `j` moved and the next paint undid it. Everything below row one — Tools
  // included — was unreachable, and the schemas that ARE in the payload looked
  // absent.
  const tree = contextTree(payload(), 1_000);
  const folds = new Set(tree.roots.map((root) => root.id).filter((id) => id.startsWith("tools-")));
  const rows = treeRows(tree, folds, new Set(), 0, 100);
  const ids = selectableOf(rows);
  // An open Tools node contributes itself and one selectable row per tool.
  assert.deepEqual(ids, ["message-0", "message-1", "message-2", "message-3", "tools-4", "tools-4-0-chat", "tools-4-1-ledger", "settings"]);
  // Tools is reachable by index, and unfolding it lists one row per tool.
  const toolsIndex = ids.indexOf("tools-4");
  const marked = treeRows(tree, folds, new Set(), toolsIndex, 100);
  assert.match(plain(marked.find((row) => row.text.includes("Tools")).text), /▌/);
  const text = marked.map((row) => plain(row.text)).join("\n");
  assert.match(text, /chat$/m);
  assert.match(text, /ledger$/m);
  // Unfolding one tool shows its description and its schema.
  const toolRows = treeRows(tree, new Set([...folds, "tools-4-0-chat"]), new Set(), toolsIndex, 100);
  const shown = toolRows.map((row) => plain(row.text)).join("\n");
  assert.match(shown, /Send one message\./);
  assert.match(shown, /text: string/);
});
