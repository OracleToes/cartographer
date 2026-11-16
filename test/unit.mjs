// Fast, self-contained unit checks. No model server, no terminal, no sandbox:
// temp brain directories and direct calls to the operations. Runs in seconds.
// Run with: npm test
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { POLICY } from "../src/config.mjs";
import { applyOp, loadLedger, saveLedger } from "../src/ledger.mjs";
import { applyPlanOp, loadPlan, savePlan } from "../src/plan.mjs";
import { loadAtlas, saveAtlas } from "../src/atlas.mjs";
import { createRefDescriber } from "../src/refs.mjs";
import { archiveRow, dropRow, settleRow, unarchiveRow, applyAdd, addTemplate } from "../src/ops.mjs";
import { ignoredLine, shellTool } from "../src/tools/shell.mjs";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { observeFile, loadCatalog, saveCatalog } from "../src/catalog.mjs";
import { loadPrepend } from "../src/prepend.mjs";
import { shelfItem, updateContext, loadContext, taskState, noteChat, writeFront } from "../src/context.mjs";
import { approveRequests, approvalWords } from "../src/requests.mjs";
import { awaitsApproval, authorizationLine, planSummary } from "../src/plan.mjs";
import { bookTool } from "../src/tools/book.mjs";
import { stateBlock } from "../src/state.mjs";
import { describeCall } from "../src/terminal.mjs";
import { changeTools, clipWriteContent, writeOne } from "../src/tools/change.mjs";
import { consultTool } from "../src/tools/consult.mjs";
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

// ─── The assessment ─────────────────────────────────────────────────────────

test("assessment: the book tool writes it whole, and /assessment reads the file", async (t) => {
	const { brainDir, root } = fresh(t);
	const tool = bookTool({ root, brainDir, config: {}, engine: { messagesOf: () => [] } });
	const api = { conversationId: ROOT_CONVERSATION_ID, taskId: "test-assessment-write", now: () => Date.now(), executeTool: () => Promise.reject(new Error("unexpected nested tool")) };
	const result = await tool.execute(tool.prepareArguments({ target: "assessment", action: "write", operation: { text: "A dice roller. Builds with npm test." } }), api, undefined);
	assert.equal(result.isError, undefined, JSON.stringify(result.output));
	assert.match(readFileSync(assessmentPath(brainDir), "utf8"), /A dice roller\./);
	assert.match(result.output[0].text, /Assessment saved \(36 characters/);
	// An empty assessment is refused at the door, and the file is untouched.
	assert.throws(() => tool.prepareArguments({ target: "assessment", action: "write", operation: { text: "" } }), /operation.text/);
	// An over-long one is clipped and says so.
	const long = "x".repeat(4000);
	const clipped = await tool.execute(tool.prepareArguments({ target: "assessment", action: "write", operation: { text: long } }), api, undefined);
	assert.equal(clipped.isError, undefined);
	assert.equal(readFileSync(assessmentPath(brainDir), "utf8").trim().length <= 3001, true);
});

// ─── The plan: approval in the user's own words ─────────────────────────────

test("approval words: a bare affirmative authorizes the waiting change items", (t) => {
	const { brainDir } = fresh(t);
	savePlan(brainDir, { version: 1, next: 1, items: [
		{ id: "p1", mode: "change", text: "Change the palette.", status: "open", added: 1 },
		{ id: "p2", mode: "change", text: "Change the schema.", network: true, status: "open", added: 1 },
		{ id: "p3", mode: "look", text: "Look first.", status: "open", added: 1 },
	] });
	assert.deepEqual(approvalWords(brainDir, "yes"), ["p1"]);
	const { plan } = loadPlan(brainDir);
	assert.equal(plan.items.find((item) => item.id === "p1").approved !== undefined, true, "the change item is approved");
	assert.equal(plan.items.find((item) => item.id === "p2").approved, undefined, "a network item never rides a bare word — name it or /approve it");
	// Naming the network item approves it: deliberate, item by item.
	assert.deepEqual(approvalWords(brainDir, "approved p2"), ["p2"]);
});

test("approval words: only the named items are approved; look items never wait", (t) => {
	const { brainDir } = fresh(t);
	savePlan(brainDir, { version: 1, next: 1, items: [
		{ id: "p1", mode: "change", text: "One.", status: "open", added: 1 },
		{ id: "p2", mode: "change", text: "Two.", network: true, status: "open", added: 1 },
	] });
	assert.deepEqual(approvalWords(brainDir, "approved p2"), ["p2"]);
	const { plan } = loadPlan(brainDir);
	assert.equal(plan.items.find((item) => item.id === "p1").approved, undefined);
	assert.equal(approvalWords(brainDir, "approved p9"), undefined, "an unknown id approves nothing");
});

test("approval words: anything less than an affirmative is not an approval", (t) => {
	const { brainDir } = fresh(t);
	savePlan(brainDir, { version: 1, next: 1, items: [{ id: "p1", mode: "change", text: "Change it.", status: "open", added: 1 }] });
	for (const words of ["no, wait", "yes but not p1", "what does p1 do?", "maybe", "ok?", "approve it later", "I approved the plan yesterday"]) {
		assert.equal(approvalWords(brainDir, words), undefined, JSON.stringify(words));
	}
	assert.equal(loadPlan(brainDir).plan.items[0].approved, undefined);
});

test("approval words: the whole-plan wording authorizes the plan as it stands", (t) => {
	const { brainDir } = fresh(t);
	savePlan(brainDir, { version: 1, next: 1, items: [
		{ id: "p1", mode: "change", text: "Change it.", status: "open", added: 1 },
		{ id: "p2", mode: "change", text: "And that.", status: "open", added: 1 },
	] });
	assert.deepEqual(approvalWords(brainDir, "i approved the plan"), ["p1", "p2"]);
});

// ─── The atlas ──────────────────────────────────────────────────────────────

test("atlas: add refuses a file that does not exist, then accepts it once it does", (t) => {
	const { brainDir, root } = fresh(t);
	const missing = applyAdd(brainDir, "atlas", JSON.stringify({ name: "docs", gist: "The docs.", detail: "Design notes.", files: ["docs/design.md"] }), root);
	assert.match(missing, /there is no file or folder docs\/design\.md/);
	assert.equal(loadAtlas(brainDir).atlas.nodes.length, 0);
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "design.md"), "# design\n");
	const added = applyAdd(brainDir, "atlas", JSON.stringify({ name: "docs", gist: "The docs.", detail: "Design notes.", files: ["docs/design.md"] }), root);
	assert.equal(added, "c1 docs written.");
	assert.deepEqual(loadAtlas(brainDir).atlas.nodes.map((node) => node.name), ["docs"]);
});

test("atlas: settleRow confirms a node", (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "design.md"), "# design\n");
	applyAdd(brainDir, "atlas", JSON.stringify({ name: "docs", gist: "The docs.", detail: "Design notes.", files: ["docs/design.md"] }), root);
	assert.match(settleRow(brainDir, "docs", root), /docs confirmed\./);
});

test("atlas: dropRow takes a node out of the graph", (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "app.mjs"), "console.log(1)\n");
	applyAdd(brainDir, "atlas", JSON.stringify({ name: "src", gist: "The source.", detail: "Where the code lives.", files: ["src/app.mjs"] }), root);
	dropRow(brainDir, "src");
	assert.equal(loadAtlas(brainDir).atlas.nodes.length, 0);
});

test("atlas: a `kind` written by an older carto is not read nor kept", (t) => {
	const { brainDir, root } = fresh(t);
	writeFileSync(join(brainDir, "carto-atlas.json"), JSON.stringify({ version: 1, next: 0, view: { anchor: ".", depth: 2 }, nodes: [{ id: "c1", name: "docs", kind: "finding", gist: "x", links: [], files: [], seen: {}, written: 1, by: "main" }] }));
	const { atlas } = loadAtlas(brainDir);
	assert.equal(atlas.nodes[0].kind, undefined, "the kind is dropped on load");
	saveAtlas(brainDir, atlas);
	assert.equal(readFileSync(join(brainDir, "carto-atlas.json"), "utf8").includes("\"kind\""), false, "and never written back");
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
	// Each call carries its own taskId in production; reusing one would mean "the same call runs again",
	// which the replay guard swallows on purpose.
	let serial = 0;
	const api = () => ({ conversationId: ROOT_CONVERSATION_ID, taskId: `t${++serial}`, now: () => 0, executeTool: () => Promise.reject(new Error("unexpected nested tool")) });
	const added = await tool.execute(tool.prepareArguments({ target: "atlas", action: "add", operation: { name: "src", gist: "The source." } }), api(), undefined);
	assert.ok(!added.isError, added.output[0].text);
	const id = loadAtlas(brainDir).atlas.nodes[0].id;
	assert.match(id, /^c\d+$/, "the node came back with a c-id");
	const listed = await tool.execute({ target: "atlas", action: "list" }, api(), undefined);
	assert.match(listed.output[0].text, new RegExp(`"id": "${id}"`), "and `list` returns a ref to it");
	const confirmed = await tool.execute(tool.prepareArguments({ target: "atlas", action: "confirm", ref: { id }, operation: {} }), api(), undefined);
	assert.ok(!confirmed.isError, confirmed.output[0].text);
	assert.match(confirmed.output[0].text, new RegExp(`${id} src confirmed\.`), "confirming by the id alone reaches the node");
	const renamed = await tool.execute(tool.prepareArguments({ target: "atlas", action: "rename", ref: { id }, operation: { to: "source" } }), api(), undefined);
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
	const api = { conversationId: ROOT_CONVERSATION_ID, taskId: "t1", now: () => 0, executeTool: () => Promise.reject(new Error("unexpected nested tool")) };
	await tool.execute(tool.prepareArguments({ target: "atlas", action: "add", operation: { name: "src", gist: "The source." } }), api, undefined);
	const node = loadAtlas(brainDir).atlas.nodes[0];
	const describeRef = createRefDescriber({ brainDir });
	assert.equal(describeRef({ kind: "atlas", id: node.id }), `src (${node.id})`);
	assert.equal(describeCall({ name: "book", arguments: { target: "atlas", action: "confirm", ref: { namespace: "n-0123456789abcdef", kind: "atlas", id: node.id } } }, describeRef), `book atlas confirm src (${node.id})`);
});

// ─── The templates ──────────────────────────────────────────────────────────

test("templates: every book has a template that parses and applies", (t) => {
	const { brainDir, root } = fresh(t);
	for (const [book, expect] of [["ledger", /added\.$/], ["plan", /added\.$/]]) {
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

// ─── The front block: what a collapse keeps ──────────────────────────────────

test("collapse: the front block reads as typed, minute-stamped clusters; the calls cluster is capped", (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(root, "shelf.txt"), "the shelf keeps this\n");
	const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
	// The talk, oldest first.
	noteChat(brainDir, "user", at(13, 10), "please add the wrist throw");
	noteChat(brainDir, "you", at(13, 12), "on it");
	// A salient note.
	assert.equal(applyAdd(brainDir, "ledger", JSON.stringify({ kind: "note", text: "Keep quotes in English." }), null), "n1 added.");
	const { ledger } = loadLedger(brainDir);
	applyOp(ledger, { action: "edit", id: "n1", salient: true }, new Date().toISOString());
	saveLedger(brainDir, ledger);
	// Two finished tasks, as the record holds them.
	mkdirSync(join(brainDir, "reports"), { recursive: true });
	writeFileSync(join(brainDir, "reports", "s3.md"), "# Report s3\n\nIt is done.\n");
	writeFileSync(join(brainDir, "reports", "s4.md"), "# Report s4\n\nIt is done.\n");
	updateContext(brainDir, (store) => {
		store.rows.push({ id: "s3", species: "composed", at: at(13, 5), mode: "look", brief: "Add the wrist throw", outcome: "It throws.", changed: 2, ref: { type: "report", id: "s3" } });
		store.rows.push({ id: "s4", species: "composed", at: at(13, 40), mode: "change", item: "p1", brief: "Ship the dice roller", outcome: "It rolls one die.", changed: 4, ref: { type: "report", id: "s4" } });
	});
	// A shelved file.
	const shelved = shelfItem(root, "shelf.txt", undefined, brainDir, []);
	updateContext(brainDir, (store) => { store.shelf.push(shelved.item); });
	// The stretch of calls the collapse drops.
	const calls = Array.from({ length: 40 }, (_, i) => ({ at: at(13, 20), text: `read a-file-with-a-rather-long-name-${i}.txt`, outcome: `${i} lines read, and some words to spend the budget honestly ${"x".repeat(24)}` }));
	const front = writeFront(brainDir, root, { chatWindow: 2_000, contextWindow: 100_000 }, { now: at(14, 32), reason: "a test collapse", calls });

	assert.ok(front.text.startsWith("<context>\n"), "the block opens with the marker");
	assert.ok(front.text.endsWith("\n</context>"), "and closes with it");
	assert.match(front.text, /My context was collapsed at 14:32 \(a test collapse\)/);
	// The clusters stand in order: tasks, notes, shelf, talk, calls.
	const order = ["Finished tasks", "Salient notes", "Shelf at 14:32", "Talk with", "Calls of the stretch"];
	let idx = -1;
	for (const heading of order) {
		const found = front.text.indexOf(heading);
		assert.ok(found > idx, `${heading} stands after the cluster before it`);
		idx = found;
	}
	// The record lines are chronological, each with its minute.
	const s3 = front.text.indexOf("s3 · 13:05");
	const s4 = front.text.indexOf("s4 · 13:40");
	assert.ok(s3 >= 0 && s4 >= 0, "both record lines stand, with their minutes");
	assert.ok(s3 < s4, "the record reads in the order things happened");
	// The salient note with its minute.
	assert.match(front.text, /^\d{2}:\d{2}  ● n1  Keep quotes in English\.$/m);
	// The shelf: a structured listing, then the contents.
	assert.match(front.text, /^14:32  shelf\.txt \[sh1\]$/m);
	assert.match(front.text, /^== shelf\.txt/m);
	assert.match(front.text, /the shelf keeps this/);
	// The talk: word for word, in order, each saying with its minute.
	const user = front.text.indexOf("user: please add the wrist throw");
	const me = front.text.indexOf("me: on it");
	assert.ok(user >= 0 && me >= 0, "both sayings stand");
	assert.ok(user < me, "in the order they were said");
	assert.match(front.text, /^13:10  user: please add the wrist throw$/m);
	assert.match(front.text, /^13:12  me: on it$/m);
	// The calls: the newest fit the budget, the oldest are counted, and the section reads in order.
	assert.match(front.text, /^Calls of the stretch before the collapse/m);
	assert.match(front.text, /\(\d+ earlier calls? are not listed\.\)/);
	assert.ok(front.text.includes("read a-file-with-a-rather-long-name-39.txt"), "the newest call stands");
	assert.ok(!front.text.includes("a-file-with-a-rather-long-name-0.txt"), "the oldest fell out of the budget");
	const last = front.text.indexOf("name-38.txt");
	const newest = front.text.indexOf("name-39.txt");
	assert.ok(last >= 0 && newest >= 0 && last < newest, "the calls read in the order they were made");
	// The act of writing the block says what it kept.
	assert.deepEqual(front.kept, { tasks: 2, shelf: 1, talk: 2 });
	assert.equal(typeof front.tokens.calls, "number");
});

test("collapse: no calls and a tight talk window — the sections shrink, the block still stands", (t) => {
	const { root, brainDir } = fresh(t);
	const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
	noteChat(brainDir, "user", at(9, 0), `the first saying, long enough to spend the whole window ${"x".repeat(120)}`);
	noteChat(brainDir, "you", at(9, 1), "the second saying");
	const front = writeFront(brainDir, root, { chatWindow: 20, contextWindow: 100_000 }, { now: at(9, 5), reason: "a test collapse" });
	assert.ok(!front.text.includes("Calls of the stretch"), "no calls, no cluster");
	assert.ok(!front.text.includes("the first saying"), "the oldest saying fell out of the window");
	assert.ok(front.text.includes("the second saying"), "the newest stands");
	assert.equal(loadContext(brainDir).chat.length, 1, "the window prunes what is stored, not only what is shown");
	// The front block is what is kept already: a collapse frees nothing more of it.
	const kept = writeFront(brainDir, root, { chatWindow: 20, contextWindow: 100_000 }, { now: at(9, 6), reason: "again" });
	assert.ok(kept.text.startsWith("<context>\n"));
});

test("collapse: mid-turn — the stretch's calls and the current reply's calls each stand once, in their own section", (t) => {
	const { root, brainDir } = fresh(t);
	const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
	mkdirSync(join(brainDir, "reports"), { recursive: true });
	const front = writeFront(brainDir, root, { chatWindow: 2_000, contextWindow: 100_000 }, {
		now: at(15, 0),
		reason: "it held about 80% of what fits",
		midTurn: { by: "user", reminded: false, calls: [{ text: "edit src/roll.py", result: "12 lines changed" }] },
		calls: [{ at: at(14, 40), text: "read src/roll.py", outcome: "30 lines" }],
	});
	// The stretch cluster holds the earlier call, one line, with its minute and outcome.
	assert.match(front.text, /^Calls of the stretch before the collapse/m);
	assert.match(front.text, /^14:40  read src\/roll\.py → 30 lines$/m);
	// The current reply's calls stand in the mid-turn section, verbatim, marked.
	assert.match(front.text, /This collapse came in the middle of my turn/);
	assert.match(front.text, /^▸ edit src\/roll\.py\n12 lines changed$/m);
	// The current reply's call is not in the calls cluster, and the stretch's call is not in the mid-turn section.
	const stretchAt = front.text.indexOf("14:40  read src/roll.py");
	const midAt = front.text.indexOf("▸ edit src/roll.py");
	assert.ok(stretchAt >= 0 && midAt >= 0);
	assert.ok(stretchAt < midAt, "the calls cluster precedes the mid-turn section");
	assert.ok(!front.text.slice(0, midAt).includes("▸"), "no verbatim call lines before the mid-turn section");
	assert.equal(front.text.indexOf("12 lines changed"), front.text.lastIndexOf("12 lines changed"), "the reply's outcome stands exactly once");
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

test("write create: over the line cap the head is written and the agent is told", (t) => {
	const { root, brainDir } = fresh(t);
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const [write] = changeTools({ root, brainDir, write: { newOnly: true, maxLines: 60 } });
	const prepared = write.prepareArguments({ path: "long.txt", content });
	assert.equal(prepared.content.split("\n").length, 60, "prepareArguments clips to the line cap before validation sees it");
	assert.equal(prepared.content, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n"));
	const result = writeOne(root, brainDir, "long.txt", content, { newOnly: true, maxLines: 60 });
	assert.equal(readFileSync(join(root, "long.txt"), "utf8"), prepared.content, "the file holds the head, and only the head");
	assert.match(result, /60 lines, a new file/);
	assert.match(result, /if you wrote more, the rest is not in the file/);
	// A file written exactly at the cap carries the same honest advisory; below the cap, no advisory.
	assert.match(writeOne(root, brainDir, "exact.txt", "a\nb\n", { newOnly: true, maxLines: 2 }), /at most|most a new file/, "the exact-cap file is told the rule");
	assert.doesNotMatch(writeOne(root, brainDir, "small.txt", "a\nb\n", { newOnly: true, maxLines: 60 }), /most a new file/);
	// One pathological line is cut at the character budget, not kept whole.
	const clipped = clipWriteContent("z".repeat(300), 1);
	assert.equal(clipped.text.length, 250);
	assert.equal(clipped.clipped, true);
});

test("shelf add: the ID alone is enough, and it finds the file behind it", async (t) => {
	const { root, brainDir } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "notes.txt"), "Ship it on Friday.\n");
	const { ref } = observeFile(root, brainDir, "src/notes.txt");
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
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

// ─── The read gate: one read per reply, then the shelf question ─────────────

import { beginShelfGate, readGateCheck, takeShelfAsk, settleShelfAsk, parseShelfDecision, dressShelfAsk, SHELF_ASK_OPEN } from "../src/shelf-ask.mjs";

const readCall = (path, id) => ({ type: "toolCall", id: id ?? `c${path}`, name: "book", arguments: { target: "file", action: "read", path } });

test("read gate: the first file read of a reply is returned, the rest are refused, and the question rides the read that came back", () => {
	const id = "gate-first";
	const message = { role: "assistant", timestamp: 1, content: [readCall("a.md"), readCall("b.md"), readCall("c.md")] };
	beginShelfGate(id, message);
	assert.equal(readGateCheck(id, readCall("a.md")), undefined);
	assert.match(readGateCheck(id, readCall("b.md")), /b\.md was not returned/);
	assert.match(readGateCheck(id, readCall("c.md")), /c\.md was not returned/);
	// A refusal carries no question,
	assert.equal(takeShelfAsk(id, readCall("b.md"), { isError: true }), undefined, "a refusal never carries the question");
	// and neither does a result from a call that is not one of the reply's reads.
	assert.equal(takeShelfAsk(id, { type: "toolCall", id: "shell-1", name: "shell", arguments: {} }, { isError: false }), undefined);
	// The read that came back does.
	const ask = takeShelfAsk(id, readCall("a.md"), { isError: false });
	assert.match(ask, /<shelf-ask>/);
	assert.match(ask, /1  a\.md  \(read this reply\)/);
	assert.match(ask, /2  b\.md {2}\(not returned\)/);
	assert.match(ask, /3  c\.md {2}\(not returned\)/);
	assert.match(ask, /not answering shelves none/);
	assert.equal(takeShelfAsk(id, readCall("a.md"), { isError: false }), undefined, "the question rides a once");
	// A reply without file reads clears the gate.
	beginShelfGate(id, { role: "assistant", timestamp: 2, content: [{ type: "text", text: "noted" }] });
	assert.equal(takeShelfAsk(id, readCall("a.md"), { isError: false }), undefined);
});

test("read gate: when no read comes back cleanly, the last read of the reply carries the question", () => {
	const id = "gate-all-fail";
	beginShelfGate(id, { role: "assistant", timestamp: 1, content: [readCall("a.md"), readCall("b.md")] });
	assert.equal(readGateCheck(id, readCall("a.md")), undefined);
	assert.match(readGateCheck(id, readCall("b.md")), /b\.md was not returned/);
	assert.equal(takeShelfAsk(id, readCall("a.md"), { isError: true }), undefined, "not before the round's reads are all in");
	const ask = takeShelfAsk(id, readCall("b.md"), { isError: true });
	assert.match(ask, /<shelf-ask>/, "the last read carries it rather than no one");
});

test("read gate: a single read asks the yes/no question about the one file", () => {
	const id = "gate-single";
	beginShelfGate(id, { role: "assistant", timestamp: 1, content: [readCall("solo.md")] });
	assert.equal(readGateCheck(id, readCall("solo.md")), undefined);
	const ask = takeShelfAsk(id, readCall("solo.md"), { isError: false });
	assert.match(ask, /Should I shelf solo\.md\? Yes or no/);
	assert.doesNotMatch(ask, /by number/);
});

test("read gate: a yes shelves the files, numbers pick, a no shelves none", (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(root, "x.md"), "alpha\n");
	writeFileSync(join(root, "y.md"), "beta\n");
	const mk = (id, files) => {
		beginShelfGate(id, { role: "assistant", timestamp: 1, content: files.map((f, i) => readCall(f, `c${i}`)) });
		for (const f of files) readGateCheck(id, readCall(f, `c${files.indexOf(f)}`));
		takeShelfAsk(id, readCall(files[0], "c0"), { isError: false });
	};
	const main = ROOT_CONVERSATION_ID;
	mk(main, ["x.md", "y.md"]);
	settleShelfAsk(main, { role: "assistant", content: [{ type: "text", text: "yes" }] }, { root, brainDir });
	assert.deepEqual(loadContext(brainDir).shelf.map((s) => s.path).sort(), ["x.md", "y.md"]);

	// A no: nothing new on the shelf.
	const id = "gate-no";
	mk(id, ["x.md"]);
	const before = loadContext(brainDir).shelf.length;
	settleShelfAsk(id, { role: "assistant", content: [{ type: "text", text: "no" }] }, { root, brainDir });
	assert.equal(loadContext(brainDir).shelf.length, before);

	// Numbers pick, across an unanswered single question folded in.
	assert.deepEqual(parseShelfDecision("yes — 2", 3), [1]);
	assert.deepEqual(parseShelfDecision("1 3", 3), [0, 2]);
	assert.deepEqual(parseShelfDecision("yes", 2), [0, 1]);
	assert.deepEqual(parseShelfDecision("the renderer has 3 faces and 18 vertices", 3), []);
	assert.deepEqual(parseShelfDecision("2d canvas", 3), []);
});

test("shelf ask: the question stays until the agent has answered, then dresses out", () => {
	const toolResult = (text) => ({ role: "toolResult", toolName: "book", toolCallId: "c0", content: [{ type: "text", text }] });
	const ask = `content of the read\n\n${SHELF_ASK_OPEN}\nShould I shelf it? Yes or no.\n${SHELF_ASK_OPEN.replace("shelf-ask", "/shelf-ask")}`;
	// Nothing for the model to see yet: no assistant message after it.
	const before = dressShelfAsk([toolResult(ask)]);
	assert.match(text0(before), /shelf it/i);
	// The agent answered: the question is stripped from what it sees.
	const after = dressShelfAsk([toolResult(ask), { role: "assistant", content: [{ type: "text", text: "no" }] }]);
	assert.doesNotMatch(text0(after), /shelf it/i);
	assert.match(text0(after), /content of the read/, "the read itself stays");
});
const text0 = (messages) => messages.map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join(""))).join("\n");

// ─── The consult tool ────────────────────────────────────────────────────────

const consultConfig = { server: "http://127.0.0.1:8888/v1", consultModel: "MythosNano", consultMaxTokens: 40960, consultTemperature: 0.6, consultTimeoutSeconds: 1800, contextWindow: 100000 };
const consultApi = (conversationId) => ({ conversationId, taskId: "c1", now: () => 1726000000000, executeTool: () => Promise.reject(new Error("unexpected nested tool")) });
/** An SSE body the way the endpoint streams one: deltas, a final finish_reason with usage, a [DONE]. */
const sseAnswer = (content = "The answer is 42.", finishReason = "stop", completionTokens = 1234) => {
	const frames = [];
	for (const piece of String(content).split(/(?<=\n)/)) {
		if (piece === "") continue;
		frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
	}
	frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 256, completion_tokens: completionTokens, total_tokens: 256 + completionTokens } })}\n\n`);
	frames.push("data: [DONE]\n\n");
	return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const okAnswer = sseAnswer;

test("consult: one plain chat completion, the answer in a file, shelved", async (t) => {
	const { root, brainDir } = fresh(t);
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return okAnswer("The answer is 42.\n");
	};
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const chunks = [];
	const api = { ...consultApi(ROOT_CONVERSATION_ID), output: (chunk) => chunks.push(chunk) };
	const result = await tool.execute({ question: "What is the answer?", context: "It was asked before." }, api, undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	assert.equal(chunks.join(""), "The answer is 42.\n", "the words are reported as they stream, token for token");
	// The request: same endpoint, plain chat completion, no tools, no grammar, the question last.
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://127.0.0.1:8888/v1/chat/completions");
	assert.equal(calls[0].init.method, "POST");
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.model, "MythosNano");
	assert.equal(sent.max_tokens, 40960);
	assert.equal(sent.temperature, 0.6);
	assert.equal(sent.stream, true, "the story streams token by token");
	assert.equal(sent.stream_options?.include_usage, true, "and asks the server for usage at the end");
	assert.equal("tools" in sent, false, "no tool definitions are sent");
	assert.equal(sent.messages.length, 1);
	assert.equal(sent.messages[0].role, "user");
	assert.ok(sent.messages[0].content.endsWith("What is the answer?"), "the question is last");
	assert.ok(sent.messages[0].content.startsWith("It was asked before."), "the context comes first");
	// The answer lands in the brain under a thread; the question stands in the story for whoever reads it later.
	const thread = result.details.thread;
	assert.match(thread, /^st-\d{8}-\d{6}-[a-z0-9]{4}$/);
	assert.equal(result.details.rounds, 1);
	const file = readFileSync(join(brainDir, "storyteller", `${thread}.md`), "utf8");
	assert.ok(file.includes("What is the answer?"));
	assert.ok(file.includes("The answer is 42."));
	assert.ok(file.includes("finish: stop"));
	assert.equal(result.output[0].text.includes(".brain"), false, "the receipt never names a path");
	assert.equal(result.output[0].text.includes("storyteller/"), false, "the receipt never names the file");
	// Shelved for the main agent as a story reference; the receipt names the placement, not the answer.
	const store = loadContext(brainDir);
	assert.equal(store.shelf.length, 1);
	assert.equal(store.shelf[0].ref.type, "story");
	assert.equal(store.shelf[0].ref.id, thread);
	assert.match(result.output[0].text, new RegExp(`shelved as placement ${store.shelf[0].id}`, "i"));
	assert.match(result.output[0].text, new RegExp(`thread: "${thread}"`), "the receipt says how to ask on");
	assert.doesNotMatch(result.output[0].text, /The answer is 42/, "the answer is not dumped into the context");
	assert.doesNotMatch(store.shelf[0].snapshot, /MythosNano|storyteller\//, "the shelf carries the exchange, not the provenance");
});

test("consult: a focus shelves the answer into its own shelf, not the main one", async (t) => {
	const { root, brainDir } = fresh(t);
	const fetchImpl = async () => okAnswer("Task-scoped answer.");
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const result = await tool.execute({ question: "Settle this kernel." }, consultApi(7777), undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	const store = loadContext(brainDir);
	assert.equal(store.shelf.length, 0, "the main shelf is untouched");
	assert.equal(taskState(store, "7777").shelf.length, 1, "the focus shelf holds it");
	assert.equal(taskState(store, "7777").shelf[0].ref.id, result.details.thread);
});

test("consult: the context is clipped to the cap, in prepareArguments and at send time", async (t) => {
	const { root, brainDir } = fresh(t);
	const big = "c".repeat(65000);
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl: async () => okAnswer("clipped ok") });
	const prepared = tool.prepareArguments({ question: "q?", context: big });
	assert.equal(prepared.context.length, 64000, "prepareArguments clips to the cap before validation sees it");
	const calls = [];
	const spy = consultTool({ root, brainDir, config: consultConfig, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return okAnswer("clipped ok"); } });
	const result = await spy.execute({ question: "q?", context: big }, consultApi(ROOT_CONVERSATION_ID), undefined);
	const sent = calls[0].messages[0].content;
	assert.ok(sent.includes("c".repeat(64000)) && !sent.includes("c".repeat(64001)), "only the head is sent");
	assert.match(result.output[0].text, /clipped to the first/);
});

test("consult: an HTTP error names the model and the setting that fixes it", async (t) => {
	const { root, brainDir } = fresh(t);
	const fetchImpl = async () => new Response("unknown model: MythosNano", { status: 404 });
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const result = await tool.execute({ question: "q?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, true);
	assert.match(result.output[0].text, /HTTP 404/);
	assert.match(result.output[0].text, /consultModel/, "it says which setting names the model");
});

test("consult: a cut-off answer says the ending is incomplete", async (t) => {
	const { root, brainDir } = fresh(t);
	const fetchImpl = async () => okAnswer("Partial reasoning…", "length", 40960);
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const result = await tool.execute({ question: "q?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	assert.match(result.output[0].text, /ran out of room/);
	assert.match(readFileSync(join(brainDir, "storyteller", `${result.details.thread}.md`), "utf8"), /finish: length/);
});

test("consult: an empty consultModel switches the tool off and asks nothing", async (t) => {
	const { root, brainDir } = fresh(t);
	let called = 0;
	const tool = consultTool({ root, brainDir, config: { ...consultConfig, consultModel: "" }, fetchImpl: async () => { called += 1; return okAnswer(); } });
	const result = await tool.execute({ question: "q?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, true);
	assert.match(result.output[0].text, /switched off/);
	assert.equal(called, 0, "the endpoint is never hit");
});

test("consult: the stream is read the way llama.cpp frames it — pings, CRLF, and frames split mid-frame across chunks", async (t) => {
	const { root, brainDir } = fresh(t);
	const encoder = new TextEncoder();
	const frames = [
		": ping\r\n\r\n",
		`data: {"choices":[{"delta":{"role":"assistant","content":"It "},"finish_reason":null}]}\r\n\r\n`,
		`data: {"choices":[{"delta":{"content":"is 42."},"finish_reason":null}]}\r\n\r\n`,
		": ping\r\n\r\n",
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":12}}\r\n\r\n`,
		"data: [DONE]\r\n\r\n",
	];
	// Bytes, not frames: every TCP chunk boundary is fair game.
	const bytes = encoder.encode(frames.join(""));
	const stream = new ReadableStream({
		async start(controller) {
			for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
			controller.close();
		},
	});
	const fetchImpl = async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	const chunks = [];
	const api = { ...consultApi(ROOT_CONVERSATION_ID), output: (chunk) => chunks.push(chunk) };
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const result = await tool.execute({ question: "q?" }, api, undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	assert.equal(chunks.join(""), "It is 42.", "the pieces are reassembled across chunk boundaries");
	assert.ok(readFileSync(join(brainDir, "storyteller", `${result.details.thread}.md`), "utf8").includes("It is 42."));
});

test("consult: a story that breaks mid-answer leaves the partial in the file, marked as cut off", async (t) => {
	const { root, brainDir } = fresh(t);
	const encoder = new TextEncoder();
	const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: "It is not. Roll twice." }, finish_reason: null }] })}\n\n`;
	let sent = false;
	const stream = new ReadableStream({
		pull(controller) {
			if (!sent) {
				controller.enqueue(encoder.encode(frames));
				sent = true;
				return;
			}
			controller.error(new Error("connection reset"));
		},
	});
	const fetchImpl = async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const result = await tool.execute({ question: "q?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, true, "a broken story is an error");
	assert.match(result.output[0].text, /broke off mid-answer/);
	const file = readFileSync(join(brainDir, "storyteller", `${result.details.thread}.md`), "utf8");
	assert.ok(file.includes("It is not. Roll twice."), "what was written stands in the story");
	assert.match(file, /broke off mid-answer/, "and says it broke off");
	const store = loadContext(brainDir);
	assert.equal(store.shelf.length, 1, "the partial is shelved all the same");
});

test("consult: a server that refuses stream_options is asked again without it", async (t) => {
	const { root, brainDir } = fresh(t);
	const calls = [];
	const fetchImpl = async (url, init) => {
		const sent = JSON.parse(init.body);
		calls.push(sent);
		if (sent.stream_options !== undefined) return new Response("unknown field: stream_options", { status: 400 });
		return okAnswer("Plain answer.");
	};
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const result = await tool.execute({ question: "q?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	assert.equal(calls.length, 2, "the refusal is answered with one retry, no more");
	assert.equal(calls[1].stream_options, undefined, "without stream_options the second time");
});

test("consult: a server that answers with one plain JSON body all the same reads the story out of it", async (t) => {
	const { root, brainDir } = fresh(t);
	const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: "42." }, finish_reason: "stop" }], usage: { completion_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const result = await tool.execute({ question: "q?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	assert.ok(readFileSync(join(brainDir, "storyteller", `${result.details.thread}.md`), "utf8").includes("42."));
});

test("consult: a timeout is reported as a timeout and writes nothing", async (t) => {
	const { root, brainDir } = fresh(t);
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl: async () => { throw new DOMException("The operation timed out.", "TimeoutError"); } });
	const result = await tool.execute({ question: "q?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, true);
	assert.match(result.output[0].text, /did not answer within 1800 seconds/);
	assert.equal(existsSync(join(brainDir, "storyteller")), false, "no story is written");
});

test("consult: a follow-up carries the whole story — the original question and the answer — and appends its round", async (t) => {
	const { root, brainDir } = fresh(t);
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push(JSON.parse(init.body));
		return okAnswer(calls.length === 1 ? "Roll twice, not once, or the die never lands on six." : "Once lands on six only half the time.");
	};
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const first = await tool.execute({ question: "Is the roller sound?", context: "It rolls one die." }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(first.isError, undefined, first.output[0].text);
	const thread = first.details.thread;
	assert.equal(first.details.rounds, 1);
	const second = await tool.execute({ question: "Why twice?", thread }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(second.isError, undefined, second.output[0].text);
	assert.equal(second.details.thread, thread, "the follow-up keeps the same thread");
	assert.equal(second.details.rounds, 2);
	// The storyteller sees round one whole: the context, the question, the answer — then this question.
	const sent = calls[1];
	assert.equal(sent.messages.length, 3);
	assert.equal(sent.messages[0].role, "user");
	assert.ok(sent.messages[0].content.startsWith("It rolls one die."), "round one's context stands first");
	assert.ok(sent.messages[0].content.endsWith("Is the roller sound?"), "and its question last within the round");
	assert.equal(sent.messages[1].role, "assistant");
	assert.equal(sent.messages[1].content, "Roll twice, not once, or the die never lands on six.");
	assert.equal(sent.messages[2].role, "user");
	assert.equal(sent.messages[2].content, "Why twice?");
	// One story on disk, both rounds, in order.
	const file = readFileSync(join(brainDir, "storyteller", `${thread}.md`), "utf8");
	assert.match(file, /## Round 1 — /);
	assert.match(file, /## Round 2 — /);
	assert.ok(file.indexOf("## Round 1") < file.indexOf("## Round 2"));
	assert.ok(file.includes("Roll twice") && file.includes("Once lands on six"));
	// One placement on the shelf, re-shelved with the whole exchange; no path and no model name in it.
	const store = loadContext(brainDir);
	assert.equal(store.shelf.length, 1, "the story is one placement, re-shelved, not minted twice");
	assert.equal(store.shelf[0].ref.type, "story");
	assert.equal(store.shelf[0].ref.id, thread);
	assert.ok(store.shelf[0].snapshot.includes("Is the roller sound?"));
	assert.ok(store.shelf[0].snapshot.includes("Roll twice"));
	assert.ok(store.shelf[0].snapshot.includes("Why twice?"));
	assert.ok(store.shelf[0].snapshot.includes("Once lands on six"));
	assert.doesNotMatch(store.shelf[0].snapshot, /MythosNano|storyteller\//, "the shelf carries the exchange, not the provenance or the path");
	// The round-two receipt says where in the story it stands, and never carries the answer.
	assert.match(second.output[0].text, /^Round 2\./);
	assert.ok(second.output[0].text.includes(`thread: "${thread}"`));
	assert.doesNotMatch(second.output[0].text, /Once lands on six/);
});

test("consult: a fresh round-two of the same story re-uses the placement id", async (t) => {
	const { root, brainDir } = fresh(t);
	let n = 0;
	const fetchImpl = async () => { n += 1; return okAnswer(`Answer ${n}.`); };
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const first = await tool.execute({ question: "q1" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	const second = await tool.execute({ question: "q2", thread: first.details.thread }, consultApi(ROOT_CONVERSATION_ID), undefined);
	const placement = loadContext(brainDir).shelf[0].id;
	assert.equal(first.details.placement, second.details.placement, "the placement is re-used, not re-minted");
	assert.equal(loadContext(brainDir).shelf[0].id, placement);
	assert.ok(loadContext(brainDir).shelf[0].snapshot.includes("Answer 1.") && loadContext(brainDir).shelf[0].snapshot.includes("Answer 2."));
});

test("consult: a thread that is not a storyteller thread is refused before anything is asked", async (t) => {
	const { root, brainDir } = fresh(t);
	let called = 0;
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl: async () => { called += 1; return okAnswer(); } });
	for (const bad of ["../etc/passwd", "st-20261115", "st-20261115-143022-XYZ!", "story:st-20261115-143022-k7q2", `/abs/path/st-20261115-143022-k7q2`]) {
		const result = await tool.execute({ question: "q?", thread: bad }, consultApi(ROOT_CONVERSATION_ID), undefined);
		assert.equal(result.isError, true, bad);
		assert.match(result.output[0].text, /not a thread the storyteller minted/);
	}
	assert.equal(called, 0, "a bad thread never reaches the endpoint");
});

test("consult: a well-formed thread with no story behind it is refused before anything is asked", async (t) => {
	const { root, brainDir } = fresh(t);
	let called = 0;
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl: async () => { called += 1; return okAnswer(); } });
	const result = await tool.execute({ question: "q?", thread: "st-20261115-000000-zzzz" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, true);
	assert.match(result.output[0].text, /No story stands under thread st-20261115-000000-zzzz/);
	assert.equal(called, 0);
});

test("consult: a story file that does not parse is refused, never guessed at", async (t) => {
	const { root, brainDir } = fresh(t);
	const id = "st-20261115-000000-a1b2";
	mkdirSync(join(brainDir, "storyteller"), { recursive: true });
	writeFileSync(join(brainDir, "storyteller", `${id}.md`), "The storyteller — one long problem, kept whole\n\n## Round 1 — nope\n\nQuestion:\naaa\nAnswer:\nbbb\n");
	let called = 0;
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl: async () => { called += 1; return okAnswer(); } });
	const result = await tool.execute({ question: "follow up?", thread: id }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(result.isError, true);
	assert.match(result.output[0].text, /cannot be read as a story/);
	assert.equal(called, 0, "a broken story never reaches the endpoint");
});

test("consult: a follow-up whose story grows is sent the whole conversation — round one is not re-sent by the agent", async (t) => {
	const { root, brainDir } = fresh(t);
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push(JSON.parse(init.body));
		return okAnswer(`Answer ${calls.length}.`);
	};
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const first = await tool.execute({ question: "Round one question." }, consultApi(ROOT_CONVERSATION_ID), undefined);
	const second = await tool.execute({ question: "Round two question.", thread: first.details.thread }, consultApi(ROOT_CONVERSATION_ID), undefined);
	const third = await tool.execute({ question: "Round three question.", thread: first.details.thread }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(third.details.rounds, 3);
	const sent = calls[2];
	assert.deepEqual(sent.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
	assert.equal(sent.messages[0].content, "Round one question.");
	assert.equal(sent.messages[1].content, "Answer 1.");
	assert.equal(sent.messages[2].content, "Round two question.");
	assert.equal(sent.messages[3].content, "Answer 2.");
	assert.equal(sent.messages[4].content, "Round three question.");
	assert.equal(second.details.rounds, 2);
});

test("consult: a story survives a question that carries its own fenced blocks and labels", async (t) => {
	const { root, brainDir } = fresh(t);
	const calls = [];
	const tricky = "It failed with:\n\nQuestion:\n```text\nAnswer:\n```\n\n## Round 99 — fake\n\nWhat does it print?";
	const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return okAnswer("The exit code is 1.\n```\nb ```\nDone."); };
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const first = await tool.execute({ question: tricky }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(first.isError, undefined, first.output[0].text);
	const second = await tool.execute({ question: "And the sign?", thread: first.details.thread }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(second.isError, undefined, second.output[0].text);
	const sent = calls[1];
	assert.equal(sent.messages.length, 3);
	assert.equal(sent.messages[0].content, tricky, "the tricky round-one payload round-trips byte for byte");
	assert.equal(sent.messages[1].content, "The exit code is 1.\n```\nb ```\nDone.");
});

test("consult: a server refusing an over-long conversation is said as such — the story outgrew the storyteller", async (t) => {
	const { root, brainDir } = fresh(t);
	let call = 0;
	const fetchImpl = async () => {
		call += 1;
		if (call === 1) return okAnswer("Roll twice.");
		return new Response("request (99999 tokens) exceeds the available context size (65536 tokens)", { status: 400 });
	};
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	const first = await tool.execute({ question: "Is the roller sound?" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	const thread = first.details.thread;
	const second = await tool.execute({ question: "Go on.", thread }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(second.isError, true);
	assert.match(second.output[0].text, /outgrown what the storyteller can hold/);
	assert.match(second.output[0].text, /let it rest, or begin a new one with the crux/);
	assert.doesNotMatch(second.output[0].text, /consultModel/, "an overflow is not a model-name problem");
	// Round one overflow names the ask, not a story:
	const solo = await consultTool({ root, brainDir, config: consultConfig, fetchImpl: async () => new Response("prompt is too long: 99999 tokens", { status: 400 }) }).execute({ question: "x".repeat(50000) }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(solo.isError, true);
	assert.match(solo.output[0].text, /outgrew what the storyteller can hold/);
});
