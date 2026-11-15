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
import { createRefDescriber } from "../src/refs.mjs";
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

test("refs: the chat shows a file ref as its file, not as a bare id", (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.html"), "<!doctype html>\n");
	const { ref } = observeFile(root, brainDir, "src/index.html");
	const describeRef = createRefDescriber({ brainDir });
	assert.equal(describeRef(ref), `index.html (${ref.id})`);
	assert.equal(describeCall({ name: "book", arguments: { target: "file", action: "read", ref } }, describeRef), `book file read index.html (${ref.id})`);
	// What a call means without a describer is unchanged: the bare id.
	assert.equal(describeCall({ name: "book", arguments: { target: "file", action: "read", ref } }), `book file read ${ref.id}`);
});

test("refs: the chat shows an atlas ref as its node, not as a bare id", async (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "app.mjs"), "console.log(1)\n");
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const api = { conversationId: ROOT_CONVERSATION_ID, taskId: "t", now: () => 0, executeTool: () => Promise.reject(new Error("unexpected nested tool")) };
	await tool.execute(tool.prepareArguments({ target: "atlas", action: "add", operation: { name: "src", gist: "The source.", kind: "component" } }), api, undefined);
	const node = loadAtlas(brainDir).atlas.nodes[0];
	const describeRef = createRefDescriber({ brainDir });
	assert.equal(describeRef({ kind: "atlas", id: node.id }), `src (${node.id})`);
	assert.equal(describeCall({ name: "book", arguments: { target: "atlas", action: "confirm", ref: { namespace: "n-0123456789abcdef", kind: "atlas", id: node.id } } }, describeRef), `book atlas confirm src (${node.id})`);
});

// ─── The templates ──────────────────────────────────────────────────────────

test("templates: every book has a template that parses and applies", (t) => {
	const { brainDir, root } = fresh(t);
	for (const [book, expect] of [["ledger", /added\.$/], ["plan", /added\.$/], ["books", /added\.$/]]) {
		const template = addTemplate(book);
		assert.equal(typeof template, "string");
		assert.doesNotThrow(() => JSON.parse(template));
		const filled = template.replace('"text": ""', '"text": "from the template."').replace('"gist": ""', '"gist": "from the template."');
		const line = applyAdd(brainDir, book, filled, root);
		assert.match(line, expect, `${book} template should apply once filled in: ${line}`);
	}
	const node = addTemplate("atlas");
	assert.doesNotThrow(() => JSON.parse(node));
});

// ─── The shell tool ─────────────────────────────────────────────────────────

const stubWindows = () => ({
	async run(name, command) { return { text: `ran: ${command}`, ms: 5, reason: "done", exit: 0, window: name, cwd: ".", lines: 1, kept: 1, sandbox: true, network: false, state: "free" }; },
	read() { return { text: "", ms: 1, reason: "done", exit: 0, window: "main", cwd: ".", lines: 0, kept: 0, state: "free" }; },
	async wait() { return { text: "", ms: 1, reason: "done", exit: 0, window: "main", cwd: ".", lines: 0, kept: 0, state: "free" }; },
	async send() { return { text: "", ms: 1, reason: "done", exit: 0, window: "main", cwd: ".", lines: 0, kept: 0, state: "free" }; },
	list() { return []; },
});
const shellArgs = (args) => ({ name: "shell", arguments: args });

test("shell: run takes seconds, unified with wait and send", (t) => {
	const tool = shellTool({ config: { shellWait: 30 }, runner: { mode: "sandbox" }, windows: stubWindows(), runOf: () => ({ mode: "change" }) });
	const out = validateToolArguments(tool, shellArgs({ action: "run", command: "ls", seconds: 5 }));
	assert.equal(out.seconds, 5);
	assert.equal("wait" in out, false);
});

test("shell: missing required fields are refused before execution", (t) => {
	const tool = shellTool({ config: { shellWait: 30 }, runner: { mode: "sandbox" }, windows: stubWindows(), runOf: () => ({ mode: "change" }) });
	for (const [args, field] of [[{ action: "run" }, "command"], [{ action: "read" }, "window"], [{ action: "send", window: "w" }, "text"]]) {
		assert.throws(() => validateToolArguments(tool, shellArgs(args)), new RegExp(field));
	}
});

test("shell: arguments an action does not use are named in the result, not swallowed", () => {
	assert.equal(ignoredLine({ action: "run", command: "ls", until: "x", text: "y", lines: 3, window: "w", seconds: 1 }, "run"), "\nIgnored as not for `run`: `until` (wait only), `text` (send only), `lines` (read only).");
	assert.equal(ignoredLine({ action: "read", window: "w", command: "ls", seconds: 1 }, "read"), "\nIgnored as not for `read`: `command` (run only), `seconds` (run, wait and send only).");
	assert.equal(ignoredLine({ action: "run", command: "ls" }, "run"), "");
});

test("shell: a run with a cross-action argument still runs, and says so", async (t) => {
	const tool = shellTool({ config: { shellWait: 30 }, runner: { mode: "sandbox" }, windows: stubWindows(), runOf: () => ({ mode: "change" }) });
	const result = await tool.execute({ action: "run", command: "ls", text: "typed?" }, { conversationId: "c", taskId: "t", now: () => Date.now() }, {});
	assert.match(result.output[0].text, /Ignored as not for `run`: `text` \(send only\)\./);
});

test("shell: TOOLS.shell and the charter both say the lane survives the sandbox being off while bubblewrap works", () => {
	assert.match(TOOLS.shell, /when it says they run directly, I still run only in a read-only window, and only when bubblewrap works — when it does not, I run none at all\./);
	assert.match(TOOLS.shell, /read, wait, stop and close work for every context/i);
});

// ─── Reference ids count up per project ─────────────────────────────────────

const scratchProject = () => {
	const root = mkdtempSync(join(tmpdir(), "carto-ids-"));
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	return { root, brainDir };
};

test("catalog: file ids count up within a brain — f1, f2", () => {
	const { root, brainDir } = scratchProject();
	writeFileSync(join(root, "a.txt"), "a\n");
	writeFileSync(join(root, "b.txt"), "b\n");
	const first = observeFile(root, brainDir, "a.txt");
	const second = observeFile(root, brainDir, "b.txt");
	assert.equal(first.ref.id, "f1");
	assert.equal(second.ref.id, "f2");
	// A catalog that already holds ids to count past (the f-<uuid> era, and numbered ones) does so.
	const catalog = loadCatalog(brainDir);
	catalog.files.push({ id: "f-90000000-0000-0000-0000-000000000000", path: "legacy.txt", createdAt: 1, updatedAt: 1 });
	catalog.files.push({ id: "f7", path: "picked-up.txt", createdAt: 1, updatedAt: 1 });
	saveCatalog(brainDir, catalog);
	writeFileSync(join(root, "c.txt"), "c\n");
	assert.equal(observeFile(root, brainDir, "c.txt").ref.id, "f8", "mints above the highest numbered id, ignoring the uuid era");
});

test("shelf: placement ids count up within a brain — sh1, sh2 — across store and snapshots", () => {
	const { root, brainDir } = scratchProject();
	writeFileSync(join(root, "a.txt"), "a\n");
	writeFileSync(join(root, "b.txt"), "b\n");
	const first = shelfItem(root, "a.txt", undefined, brainDir, []);
	assert.equal(first.item.id, "sh1");
	// Persist it the way the shelf-add path does, so the next mint sees it on disk.
	updateContext(brainDir, (next) => { next.shelf.push(first.item); });
	const second = shelfItem(root, "b.txt", undefined, brainDir, []);
	assert.equal(second.item.id, "sh2", "the number comes from the store as well, not just the in-flight list");
	const store = loadContext(brainDir);
	assert.equal(store.shelf[0].id, "sh1");
});

// ─── The read-only lane ─────────────────────────────────────────────────────

const gatedRunnerOf = (off, available) => ({ off, available, get mode() { return this.off ? "direct" : this.available.ok ? "sandbox" : "none"; } });
const laneTool = (runner, windows) => shellTool({ config: { shellWait: 1 }, runner, windows, runOf: () => undefined });
const mainCall = (args) => ({ name: "shell", arguments: args });
const mainApi = { conversationId: ROOT_CONVERSATION_ID, taskId: "t", now: () => 0 };

test("lane: with the sandbox off and bubblewrap working, the main agent runs commands read-only", async (t) => {
	let called;
	const windows = { ...stubWindows(), async run(name, command, opts) { called = { name, command, opts }; return { text: "ok", ms: 1, reason: "done", exit: 0, window: name, cwd: ".", lines: 1, kept: 1, sandbox: true, network: false, state: "free", readOnly: true }; } };
	const tool = laneTool(gatedRunnerOf(true, { ok: true, version: "0.13.1", shell: "bash" }), windows);
	const result = await tool.execute({ action: "run", command: "git status" }, mainApi, {});
	assert.equal(called?.opts?.readOnly, true);
	assert.equal(result.isError, false);
});

test("lane: with the sandbox off and bubblewrap broken, the main agent cannot run commands at all", async (t) => {
	let called = false;
	const windows = { ...stubWindows(), async run() { called = true; throw new Error("must not be called"); } };
	const tool = laneTool(gatedRunnerOf(true, { ok: false, why: "bubblewrap (the bwrap command) is not installed" }), windows);
	const result = await tool.execute({ action: "run", command: "git status" }, mainApi, {});
	assert.match(result.output[0].text, /^Refused: A read-only window needs bubblewrap/);
	assert.equal(called, false);
});

test("lane: with no sandbox and the switch not taken, the main agent cannot run commands either", async (t) => {
	let called = false;
	const windows = { ...stubWindows(), async run() { called = true; throw new Error("must not be called"); } };
	const tool = laneTool(gatedRunnerOf(false, { ok: false, why: "bubblewrap (the bwrap command) is not installed" }), windows);
	const result = await tool.execute({ action: "run", command: "git status" }, mainApi, {});
	assert.match(result.output[0].text, /^Refused: Commands cannot be run in this session/);
	assert.equal(called, false);
});

// ─── The state block ────────────────────────────────────────────────────────

const runnerOf = (off, available) => ({ off, available, get mode() { return this.off ? "direct" : this.available.ok ? "sandbox" : "none"; } });
const blockOf = (t, runner) => {
	const { brainDir, root } = fresh(t);
	writeFileSync(join(brainDir, "carto-ledger.json"), JSON.stringify({ version: 1, next: 1, items: [] }, null, "\t"));
	writeFileSync(join(brainDir, "carto-plan.json"), JSON.stringify({ version: 1, items: [] }, null, "\t"));
	return stateBlock(brainDir, runner, { root, messages: [] });
};

test("state: the sandbox-off line says the main agent keeps a read-only lane while bubblewrap works", (t) => {
	const block = blockOf(t, runnerOf(true, { ok: true, version: "0.13.1", shell: "bash" }));
	assert.match(block, /always in a read-only window, when bubblewrap works/);
});

test("state: the no-sandbox line says no command can be run at all", (t) => {
	const block = blockOf(t, runnerOf(false, { ok: false, why: "bubblewrap (the bwrap command) is not installed" }));
	assert.match(block, /No command can be run in this session/);
});

test("state: the sandboxed block does not claim the main agent is blocked", (t) => {
	const block = blockOf(t, runnerOf(false, { ok: true, version: "0.9.0", shell: "bash" }));
	assert.doesNotMatch(block, /You yourself may still run commands in this session/);
});

// ─── The trace ─────────────────────────────────────────────────────────────

test("trace: CARTO_TRACE names the default file under the brain's export folder", (t) => {
	const { brainDir } = fresh(t);
	const file = traceFile({ env: { CARTO_TRACE: "1" }, brainDir, root: brainDir });
	assert.equal(file?.startsWith(join(brainDir, "export")), true);
	assert.match(file ?? "", /trace-\d{8}-\d{6}\.jsonl$/);
});

test("trace: CARTO_TRACE with a path is used as it is; nothing traces when it is not set", (t) => {
	const { root } = fresh(t);
	assert.equal(traceFile({ env: {}, root }), undefined);
	assert.equal(traceFile({ env: { CARTO_TRACE: "  " }, root }), undefined);
	assert.equal(traceFile({ env: { CARTO_TRACE: "/tmp/wire.jsonl" }, root }), "/tmp/wire.jsonl");
	assert.equal(traceFile({ env: { CARTO_TRACE: "wire.jsonl" }, root }), join(root, "wire.jsonl"));
});

test("trace: one call to the model is one JSON line: the request as sent, the response as read", async (t) => {
	const { brainDir } = fresh(t);
	const file = join(brainDir, "wire.jsonl");
	const provider = {
		stream: (model, request, options) => options.fetch("http://server.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], return_progress: true }) }),
		streamSimple: (model, request, options) => provider.stream(model, request, options),
	};
	watchTrace(provider, file);
	const body = new TextEncoder().encode('data: {"id":"x","choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n');
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const response = await provider.stream({ id: "m" }, {}, {});
	const chunks = [];
	for await (const chunk of response.body) chunks.push(chunk);
	// The trace writes at the end of the stream; give it a tick to land.
	await new Promise((resolve) => setImmediate(resolve));
	const lines = readFileSync(file, "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	const record = JSON.parse(lines[0]);
	assert.equal(record.method, "POST");
	assert.equal(record.request.model, "m");
	assert.equal(record.request.return_progress, true);
	assert.match(record.response, /data: \[DONE\]/);
	assert.equal(record.status, 200);
	assert.equal(record.bytesSent, Buffer.byteLength(JSON.stringify(record.request)));
});

// ─── The approval gate, as the live run taught it ────────────────────────────

test("plan: an item approved one by one is authorized everywhere the agent is told so", (t) => {
	const { brainDir } = fresh(t);
	applyAdd(brainDir, "plan", JSON.stringify({ mode: "change", text: "Add the wrist throw." }), null);
	applyAdd(brainDir, "plan", JSON.stringify({ mode: "change", text: "And the tests for it." }), null);
	let { plan } = loadPlan(brainDir);
	assert.equal(awaitsApproval(plan), true, "two change items wait for the user");
	assert.match(authorizationLine(plan), /^Not approved/);
	assert.match(planSummary(plan), /2 change items not authorized/);
	const done = approveRequests(brainDir, ["p1"]);
	assert.deepEqual(done.items, ["p1"]);
	({ plan } = loadPlan(brainDir));
	assert.equal(awaitsApproval(plan), true, "p2 still waits");
	assert.match(authorizationLine(plan), /^Not approved/);
	assert.match(planSummary(plan), /1 change item not authorized/);
	approveRequests(brainDir, ["p2"]);
	({ plan } = loadPlan(brainDir));
	assert.equal(awaitsApproval(plan), false);
	assert.match(authorizationLine(plan), new RegExp("^Authorized by " + USER_NAME));
	assert.match(planSummary(plan), /authorized$/);
});

test("change gate: a focus carries an approved item whatever the history's length; a stranger is refused", async (t) => {
	const { root, brainDir } = fresh(t);
	applyAdd(brainDir, "plan", JSON.stringify({ mode: "change", text: "Add the wrist throw." }), null);
	approveRequests(brainDir, ["p1"]);
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	/** A focus conversation id (7777), not the root: ROOT_CONVERSATION_ID is the main agent. Record it as the
	 * context store does when the fork is created. */
	const focus = 7777;
	updateContext(brainDir, (store) => {
		Object.assign(taskState(store, String(focus)), { purpose: "add the throw", item: "p1", mode: "change" });
	});
	const writes = [];
	const apis = {
		carry: { conversationId: focus, executeTool: async (name, args) => { writes.push([name, args]); return { isError: false, structuredOutput: "Wrote src/new.txt: 1 line, a new file." } } },
		stranger: { conversationId: 4242, executeTool: async () => { throw new Error("must not be reached"); } },
	};
	const ok = await tool.execute({ target: "file", action: "create", path: "src/new.txt", content: "hello\n", planItem: "p1" }, apis.carry, undefined);
	assert.equal(writes.length, 1, "the authorized focus reached the nested write");
	assert.equal(writes[0][0], "write");
	assert.equal(ok.isError, false);
	updateContext(brainDir, (store) => {
		Object.assign(taskState(store, "4242"), { purpose: "nosy", item: "p2", mode: "look" });
	});
	const no = await tool.execute({ target: "file", action: "create", path: "src/nope.txt", content: "x\n", planItem: "p1" }, apis.stranger, undefined);
	assert.equal(no.isError, true);
	assert.match(no.output[0].text, /not carrying/);
});

test("file edit: the ID alone is enough, and it always points at the live version", async (t) => {
	const { root, brainDir } = fresh(t);
	applyAdd(brainDir, "plan", JSON.stringify({ mode: "change", text: "Add the throw." }), null);
	approveRequests(brainDir, ["p1"]);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "dice.js"), "const a = 1;\nconst b = 2;\n");
	const { ref } = observeFile(root, brainDir, "src/dice.js");
	const id = ref.id;
	// The agent never sees a namespace, a kind or a 64-character hash: only the file's ID.
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const focus = 7777;
	updateContext(brainDir, (store) => {
		Object.assign(taskState(store, String(focus)), { purpose: "add the throw", item: "p1", mode: "change" });
	});
	const [, edit] = changeTools({ root, brainDir });
	const focusApi = { conversationId: focus, executeTool: async (name, args) => {
		if (name !== "edit") throw new Error(`unexpected nested tool ${name}`);
		const nested = await edit.execute(args);
		// What the harness does with a nested call's result: flag + structured output.
		return { isError: nested.isError === true, structuredOutput: nested.output?.[0]?.text };
	} };

	// `file read` by the ID alone: the bytes as they are, no line numbers, and the ID to edit by.
	const read = await tool.execute({ target: "file", action: "read", ref: { id } }, focusApi, undefined);
	const readText = read.output[0].text;
	assert.ok(readText.includes("const a = 1;\nconst b = 2;"), `the read shows the exact bytes:\n${readText}`);
	assert.ok(!/\d+ │ /.test(readText) && !/│/.test(readText), "no line numbers in the read");
	assert.ok(readText.includes(`file ${id}`), "and it says which file ID it is");

	// `file edit` by the ID alone.
	const firstEdit = await tool.execute({ target: "file", action: "edit", ref: { id }, oldText: "const b = 2;\n", newText: "const b = 3;\n", planItem: "p1" }, focusApi, undefined);
	assert.equal(firstEdit.isError, false, `the edit by ID succeeded: ${firstEdit.output[0].text}`);
	assert.equal(readFileSync(join(root, "src", "dice.js"), "utf8"), "const a = 1;\nconst b = 3;\n");

	// The ID points at the live version: a second edit with no version anywhere must succeed too.
	const secondEdit = await tool.execute({ target: "file", action: "edit", ref: { id }, oldText: "const a = 1;\n", newText: "const a = 10;\n", planItem: "p1" }, focusApi, undefined);
	assert.equal(secondEdit.isError, false, `the second edit by ID succeeded: ${secondEdit.output[0].text}`);
	assert.equal(readFileSync(join(root, "src", "dice.js"), "utf8"), "const a = 10;\nconst b = 3;\n");

	// A pinned ref is still honored as an optimistic check, and fails only because it is stale by choice.
	const stale = await tool.execute({ target: "file", action: "edit", ref: { ...ref, version: ref.version }, oldText: "const a = 10;\n", newText: "const a = 11;\n", planItem: "p1" }, focusApi, undefined);
	assert.equal(stale.isError, true);
	assert.match(stale.output[0].text, /Stale|status/);

	// The call label names the tool that carries it.
	assert.equal(describeCall({ name: "book", arguments: { target: "file", action: "edit", ref: { id }, oldText: "x", newText: "y" } }), `book file edit ${id}`);
});

test("shelf add: the ID alone is enough, and it finds the file behind it", async (t) => {
	const { root, brainDir } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "notes.txt"), "Ship it on Friday.\n");
	const { ref } = observeFile(root, brainDir, "src/notes.txt");
	const tool = bookTool({ root, brainDir, config: { shelfTokens: 2000 }, engine: {}, gate: { yolo: false } });
	// Root conversation: the main shelf.
	const focusApi = { conversationId: ROOT_CONVERSATION_ID, executeTool: () => Promise.reject(new Error("unexpected nested tool")) };

	// The harness runs every call through prepareArguments before dispatch; an id-only ref must survive it
	// (it once was refused for missing kind and namespace, which the shelf infers by design).
	const prepared = tool.prepareArguments({ target: "shelf", action: "add", ref: { id: ref.id } });
	const added = await tool.execute(prepared, focusApi, undefined);
	assert.ok(!added.isError, `shelf add by the ID alone succeeded: ${added.output[0].text}`);
	const listed = await tool.execute({ target: "shelf", action: "list" }, focusApi, undefined);
	assert.match(listed.output[0].text, /placement/, "and the shelf holds it");
	assert.match(listed.output[0].text, new RegExp(`"id":\\s*"${ref.id}"`), "as the file the agent saw");

	// An ID that is nothing at all is refused with a sentence, not a validation error.
	const missing = await tool.execute({ target: "shelf", action: "add", ref: { id: "f999" } }, focusApi, undefined);
	assert.equal(missing.isError, true);
	assert.match(missing.output[0].text, /Nothing with the ID/);
});

test("book: prepareArguments repairs the (deeply frozen) harness arguments without throwing", (t) => {
	// The harness reads the assistant entry and deep-freezes everything in it, the tool-call arguments included
	// (pi-durable freezeJson). The repair must carry a new object instead of mutating the frozen one.
	const { root, brainDir } = fresh(t);
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const deepFreeze = (value) => {
		if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
		return value;
	};
	const byPath = deepFreeze({ target: "file", action: "read", path: "index.html" });
	const preparedPath = tool.prepareArguments(byPath);
	assert.equal(preparedPath.target, "file");
	assert.equal(preparedPath.action, "read");
	assert.equal(preparedPath.ref, undefined, "no ref is invented for a path call");
	const byRef = deepFreeze({ target: "file", action: "read", ref: { id: "f1" } });
	const preparedRef = tool.prepareArguments(byRef);
	assert.equal(preparedRef.ref.id, "f1");
	assert.ok(typeof preparedRef.ref.namespace === "string" && preparedRef.ref.namespace.length >= 16, "the namespace is inferred");
	assert.equal(preparedRef.ref.kind, "file", "the kind is inferred from the target");
});

test("prepend: the user's own markdown is read before the prompt — core first, brain second; nothing when absent", (t) => {
	const { root, brainDir } = fresh(t);
	const core = join(root, "PREPEND.md");
	// Nothing anywhere: nothing to prepend.
	assert.equal(loadPrepend(brainDir, core), undefined, "no files, no prepend");
	// The core alone.
	writeFileSync(core, "Be brief.\n");
	const coreOnly = loadPrepend(brainDir, core);
	assert.match(coreOnly, /PREPEND\.md \(the installation/);
	assert.match(coreOnly, /written by the user/);
	assert.match(coreOnly, /Be brief\./);
	assert.equal(coreOnly.includes("this project's brain"), false, "only what exists is read");
	// Both: the core is read before the brain (the closer one said last, so it wins).
	writeFileSync(join(brainDir, "PREPEND.md"), "Always sign off as Molly.\n");
	const both = loadPrepend(brainDir, core);
	assert.ok(both.indexOf("Be brief.") < both.indexOf("Always sign off as Molly."), "core before brain");
	assert.match(both, /this project's brain/);
	// A whitespace-only brain file is nothing, not even a header.
	writeFileSync(join(brainDir, "PREPEND.md"), "  \n\n");
	const after = loadPrepend(brainDir, core);
	assert.equal(after.includes("Molly"), false);
	assert.match(after, /Be brief\./);
	// An unreadable core (a folder) is skipped, not fatal.
	assert.equal(loadPrepend(brainDir, root), undefined, "a folder where the file would be: nothing added");
	// Line endings and a byte order mark do not stand in the way.
	writeFileSync(core, "\uFEFFBe terse.\r\n");
	const crlf = loadPrepend(brainDir, core);
	assert.match(crlf, /Be terse\./);
	assert.equal(crlf.includes("\r"), false);
});
