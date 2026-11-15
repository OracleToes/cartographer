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
import { loadAtlas } from "../src/atlas.mjs";
import { archiveRow, dropRow, settleRow, unarchiveRow, applyAdd, addTemplate } from "../src/ops.mjs";
import { ignoredLine, shellTool } from "../src/tools/shell.mjs";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { stateBlock } from "../src/state.mjs";
import { TOOLS } from "../src/prompt.mjs";
import { assessmentPath } from "../src/assessment.mjs";
import { topPath } from "../src/top.mjs";

const fresh = (t) => {
	const root = mkdtempSync(join(tmpdir(), "carto-test-"));
	const brainDir = join(root, ".atlas");
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
	assert.match(settled, /copy of your assessment and graph/);
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
	assert.equal(added, "docs written.");
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

test("shell: the sandbox-off line of TOOLS.shell and the charter both say the main agent cannot run commands at all", () => {
	assert.match(TOOLS.shell, /If the user has switched the sandbox off, the main context cannot run commands at all\./);
	assert.match(TOOLS.shell, /read, wait, stop and close work for every context/i);
});

// ─── The state block ────────────────────────────────────────────────────────

const runnerOf = (off, available) => ({ off, available, get mode() { return this.off ? "direct" : this.available.ok ? "sandbox" : "none"; } });
const blockOf = (t, runner) => {
	const { brainDir, root } = fresh(t);
	writeFileSync(join(brainDir, "carto-ledger.json"), JSON.stringify({ version: 1, next: 1, items: [] }, null, "\t"));
	writeFileSync(join(brainDir, "carto-plan.json"), JSON.stringify({ version: 1, items: [] }, null, "\t"));
	return stateBlock(brainDir, runner, { root, messages: [] });
};

test("state: the sandbox-off line says the main agent cannot run commands at all", (t) => {
	const block = blockOf(t, runnerOf(true, { ok: false, why: "not used" }));
	assert.match(block, /You cannot run commands yourself in this session/);
});

test("state: the no-sandbox line says no command can be run at all", (t) => {
	const block = blockOf(t, runnerOf(false, { ok: false, why: "bubblewrap (the bwrap command) is not installed" }));
	assert.match(block, /No command can be run in this session/);
});

test("state: the sandboxed block does not claim the main agent is blocked", (t) => {
	const block = blockOf(t, runnerOf(false, { ok: true, version: "0.9.0", shell: "bash" }));
	assert.doesNotMatch(block, /You cannot run commands yourself in this session/);
});
