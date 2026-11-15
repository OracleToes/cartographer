// Fast, self-contained unit checks. No model server, no terminal, no sandbox:
// temp brain directories and direct calls to the operations. Runs in seconds.
// Run with: npm test
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { POLICY } from "../src/config.mjs";
import { applyOp, loadLedger } from "../src/ledger.mjs";
import { applyPlanOp, loadPlan } from "../src/plan.mjs";
import { loadBooks } from "../src/books.mjs";
import { loadAtlas, saveAtlas } from "../src/atlas.mjs";
import { archiveRow, dropRow, settleRow, unarchiveRow, applyAdd, addTemplate } from "../src/ops.mjs";
import { ignoredLine, shellTool } from "../src/tools/shell.mjs";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { observeFile, loadCatalog, saveCatalog } from "../src/catalog.mjs";
import { loadPrepend } from "../src/prepend.mjs";
import { shelfItem, updateContext, loadContext, taskState } from "../src/context.mjs";
import { approveRequests } from "../src/requests.mjs";
import { awaitsApproval, authorizationLine, planSummary } from "../src/plan.mjs";
import { bookTool } from "../src/tools/book.mjs";
import { stateBlock } from "../src/state.mjs";
import { describeCall } from "../src/terminal.mjs";
import { changeTools } from "../src/tools/change.mjs";
import { TOOLS } from "../src/prompt.mjs";
import { assessmentPath } from "../src/assessment.mjs";
import { topPath } from "../src/top.mjs";
import { traceFile, watchTrace } from "../src/trace.mjs";
import { USER_NAME } from "../src/user.mjs";

const fresh = (t) => {
	const root = mkdtempSync(join(tmpdir(), "carto-test-"));
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, brainDir };
};
const NOW = "2026-11-15T00:00:00.000Z";

// ─── The ledger ─────────────────────────────────────────────────────────────

test("ledger: an entry added through the same op the agent uses is done by settleRow", (t) => {
	const { brainDir } = fresh(t);
	const added = applyAdd(brainDir, "ledger", JSON.stringify({ kind: "note", text: "Keep quotes in English." }), null);
	assert.equal(added, "n1 added.");
	const settled = settleRow(brainDir, "n1", null);
	assert.match(settled, /n1 closed\./);
	const { ledger } = loadLedger(brainDir);
	assert.equal(ledger.items[0].status, POLICY.enums.entryStatus.done);
});

test("ledger: settling an unknown id says so plainly", (t) => {
	const { brainDir } = fresh(t);
	assert.match(settleRow(brainDir, "t99", null), /^There is no t99\./);
});

test("ledger: closing a goal re-pins the copy at the top of the context", (t) => {
	const { brainDir, root } = fresh(t);
	applyAdd(brainDir, "ledger", JSON.stringify({ kind: "goal", text: "Ship the dice roller.", done_when: "It rolls." }), root);
	const settled = settleRow(brainDir, "g1", root);
	assert.match(settled, /copy of my assessment and graph/);
	assert.equal(existsSync(topPath(brainDir)), true);
});

test("ledger: a goal without a done-when line is refused, nothing is added", (t) => {
	const { brainDir } = fresh(t);
	assert.match(applyAdd(brainDir, "ledger", JSON.stringify({ kind: "goal", text: "Be the best." }), null), /done_when/);
	const { ledger } = loadLedger(brainDir);
	assert.equal(ledger.items.length, 0);
});

test("ledger: kind that does not exist is refused", (t) => {
	const { brainDir } = fresh(t);
	assert.match(applyAdd(brainDir, "ledger", JSON.stringify({ kind: "memo", text: "x" }), null), /goal, question, note/);
});

test("ledger: text that is not JSON is refused, nothing is added", (t) => {
	const { brainDir } = fresh(t);
	assert.match(applyAdd(brainDir, "ledger", "{not json", null), /does not parse/);
	const { ledger } = loadLedger(brainDir);
	assert.equal(ledger.items.length, 0);
});

test("ledger: a settled goal says so when settled again", (t) => {
	const { brainDir, root } = fresh(t);
	applyAdd(brainDir, "ledger", JSON.stringify({ kind: "goal", text: "Ship it.", done_when: "It ships." }), root);
	settleRow(brainDir, "g1", root);
	assert.match(settleRow(brainDir, "g1", root), /already closed/);
});

// ─── The plan ───────────────────────────────────────────────────────────────

test("plan: an item added through the same op the agent uses is done by settleRow", (t) => {
	const { brainDir } = fresh(t);
	const added = applyAdd(brainDir, "plan", JSON.stringify({ mode: "look", text: "Look at the files." }), null);
	assert.equal(added, "p1 added.");
	const settled = settleRow(brainDir, "p1", null);
	assert.match(settled, /p1 done\./);
	const { plan } = loadPlan(brainDir);
	assert.equal(plan.items[0].status, POLICY.enums.entryStatus.done);
});

test("plan: dropRow removes the named item, never the last one", (t) => {
	const { brainDir } = fresh(t);
	for (const text of ["one", "two", "three"]) applyAdd(brainDir, "plan", JSON.stringify({ mode: "look", text }), null);
	dropRow(brainDir, "p2");
	const { plan } = loadPlan(brainDir);
	assert.deepEqual(plan.items.map((item) => item.id), ["p1", "p3"]);
});

test("plan: archive and unarchive round-trip persists through the file", (t) => {
	const { brainDir } = fresh(t);
	applyAdd(brainDir, "plan", JSON.stringify({ mode: "look", text: "one" }), null);
	archiveRow(brainDir, "p1");
	assert.equal(loadPlan(brainDir).plan.items[0].archived, true);
	unarchiveRow(brainDir, "p1");
	assert.equal(loadPlan(brainDir).plan.items[0].archived, undefined);
});

test("plan: a change item added by the user goes through the same withdrawal as the agent's", (t) => {
	const { brainDir } = fresh(t);
	applyAdd(brainDir, "plan", JSON.stringify({ mode: "change", text: "Change the palette." }), null);
	assert.equal(loadPlan(brainDir).plan.authorized, undefined);
});

// ─── The shared books ───────────────────────────────────────────────────────

test("books: an assessment entry settles and assessment.md is kept in step", (t) => {
	const { brainDir } = fresh(t);
	assert.equal(applyAdd(brainDir, "books", JSON.stringify({ kind: "assessment", text: "A dice roller." }), null), "a1 added.");
	// Assessment.md renders the open entries; a settled entry leaves it.
	assert.match(readFileSync(assessmentPath(brainDir), "utf8"), /A dice roller\./);
	const settled = settleRow(brainDir, "a1", null);
	assert.match(settled, /a1 settled\./);
	assert.doesNotMatch(readFileSync(assessmentPath(brainDir), "utf8"), /A dice roller\./);
	const book = loadBooks(brainDir);
	assert.equal(book.items[0].status, POLICY.enums.entryStatus.done);
});

test("books: dropRow removes the named entry, never the last one", (t) => {
	const { brainDir } = fresh(t);
	applyAdd(brainDir, "books", JSON.stringify({ kind: "assessment", text: "About the project." }), null);
	applyAdd(brainDir, "books", JSON.stringify({ kind: "practice", text: "Verify notes." }), null);
	dropRow(brainDir, "a1");
	// The two books share one id counter, so the practice entry is r2; the point is that the named one goes, not the last.
	assert.deepEqual(loadBooks(brainDir).items.map((item) => item.id), ["r2"]);
});

test("books: archive and unarchive round-trip persists through the file", (t) => {
	const { brainDir } = fresh(t);
	applyAdd(brainDir, "books", JSON.stringify({ kind: "practice", text: "Verify notes." }), null);
	archiveRow(brainDir, "r1");
	assert.equal(loadBooks(brainDir).items[0].archived, true);
	unarchiveRow(brainDir, "r1");
	assert.equal(loadBooks(brainDir).items[0].archived, undefined);
});

test("books: a kind that does not exist is refused, nothing is added", (t) => {
	const { brainDir } = fresh(t);
	assert.match(applyAdd(brainDir, "books", JSON.stringify({ kind: "memo", text: "x" }), null), /assessment, practice/);
	assert.equal(loadBooks(brainDir).items.length, 0);
});

// ─── The atlas ──────────────────────────────────────────────────────────────

test("atlas: add refuses a file that does not exist, then accepts it once it does", (t) => {
	const { brainDir, root } = fresh(t);
	const missing = applyAdd(brainDir, "atlas", JSON.stringify({ name: "docs", gist: "The docs.", kind: "component", detail: "Design notes.", files: ["docs/design.md"] }), root);
	assert.match(missing, /there is no file or folder docs\/design\.md/);
	assert.equal(loadAtlas(brainDir).atlas.nodes.length, 0);
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "design.md"), "# design\n");
	const added = applyAdd(brainDir, "atlas", JSON.stringify({ name: "docs", gist: "The docs.", kind: "component", detail: "Design notes.", files: ["docs/design.md"] }), root);
	assert.equal(added, "c1 docs written.");
	assert.deepEqual(loadAtlas(brainDir).atlas.nodes.map((node) => node.name), ["docs"]);
});

test("atlas: settleRow confirms a node", (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "design.md"), "# design\n");
	applyAdd(brainDir, "atlas", JSON.stringify({ name: "docs", gist: "The docs.", kind: "component", detail: "Design notes.", files: ["docs/design.md"] }), root);
	assert.match(settleRow(brainDir, "docs", root), /docs confirmed\./);
});

test("atlas: dropRow takes a node out of the graph", (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "app.mjs"), "console.log(1)\n");
	applyAdd(brainDir, "atlas", JSON.stringify({ name: "src", gist: "The source.", kind: "component", detail: "Where the code lives.", files: ["src/app.mjs"] }), root);
	dropRow(brainDir, "src");
	assert.equal(loadAtlas(brainDir).atlas.nodes.length, 0);
});

test("atlas: a node kind the graph does not know is refused", (t) => {
	const { brainDir, root } = fresh(t);
	assert.match(applyAdd(brainDir, "atlas", JSON.stringify({ name: "docs", gist: "x", kind: "directory" }), root), /component, finding, dead_end/);
});

test("atlas: a graph written before ids existed gets them, deterministically, and keeps them", (t) => {
	const { brainDir } = fresh(t);
	writeFileSync(join(brainDir, "carto-atlas.json"), JSON.stringify({ version: 1, view: { anchor: "." }, nodes: [
		{ name: "one", gist: "the first node", links: [], files: [], seen: {} },
		{ name: "two", gist: "the second node", links: ["one"], files: [], seen: {}, id: "c7" },
		{ name: "three", gist: "the third node", links: [], files: [], seen: {}, id: "c7" },
	] }));
	const loaded = loadAtlas(brainDir).atlas;
	assert.equal(loaded.nodes[0].id, "c1", "a node without one is given the next free id");
	assert.equal(loaded.nodes[1].id, "c7", "a valid, unique id survives the migration");
	assert.equal(loaded.nodes[2].id, "c2", "a duplicated id is replaced");
	saveAtlas(brainDir, loaded);
	assert.deepEqual(loadAtlas(brainDir).atlas.nodes.map((node) => node.id), ["c1", "c7", "c2"], "and what was saved is what is read back");
});

test("atlas: the ref system takes the node, end to end through the book tool", async (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "app.mjs"), "console.log(1)\n");
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const api = { conversationId: ROOT_CONVERSATION_ID, taskId: "t", now: () => 0, executeTool: () => Promise.reject(new Error("unexpected nested tool")) };
	const added = await tool.execute(tool.prepareArguments({ target: "atlas", action: "add", operation: { name: "src", gist: "The source.", kind: "component" } }), api, undefined);
	assert.ok(!added.isError, added.output[0].text);
	const id = loadAtlas(brainDir).atlas.nodes[0].id;
	assert.match(id, /^c\d+$/, "the node came back with a c-id");
	const listed = await tool.execute({ target: "atlas", action: "list" }, api, undefined);
	assert.match(listed.output[0].text, new RegExp(`"id": "${id}"`), "and `list` returns a ref to it");
	const confirmed = await tool.execute(tool.prepareArguments({ target: "atlas", action: "confirm", ref: { id }, operation: {} }), api, undefined);
	assert.ok(!confirmed.isError, confirmed.output[0].text);
	assert.match(confirmed.output[0].text, new RegExp(`${id} src confirmed\.`), "confirming by the id alone reaches the node");
	const renamed = await tool.execute(tool.prepareArguments({ target: "atlas", action: "rename", ref: { id }, operation: { to: "source" } }), api, undefined);
	assert.ok(!renamed.isError, renamed.output[0].text);
	assert.equal(loadAtlas(brainDir).atlas.nodes[0].name, "source", "and the rename moves the name, not the id");
	assert.equal(loadAtlas(brainDir).atlas.nodes[0].id, id);
});
