// Fast, self-contained unit checks. No model server, no terminal, no sandbox:
// temp brain directories and direct calls to the operations. Runs in seconds.
// Run with: npm test
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { contextWindowLimits, POLICY } from "../src/config.mjs";
import { applyOp, loadLedger, saveLedger } from "../src/ledger.mjs";
import { applyPlanOp, approve, findMove, liveMove, loadPlan, mayRun, PlanError, reportMove, savePlan, startMove, undoMove } from "../src/plan.mjs";
import { loadAtlas, saveAtlas } from "../src/atlas.mjs";
import { createRefDescriber } from "../src/refs.mjs";
import { archiveRow, dropRow, settleRow, unarchiveRow, applyAdd, addTemplate, editRow } from "../src/ops.mjs";
import { ignoredLine, shellTool } from "../src/tools/shell.mjs";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { observeFile, loadCatalog, saveCatalog } from "../src/catalog.mjs";
import { loadPrepend } from "../src/prepend.mjs";
import { shelfItem, updateContext, loadContext, taskState, noteChat, writeFront, chatLine, addRecord, dressMain, KEPT_AS } from "../src/context.mjs";
import { approveRequests, approvalWords } from "../src/requests.mjs";
import { awaitsApproval, authorizationLine, planSummary } from "../src/plan.mjs";
import { bookTool } from "../src/tools/book.mjs";
import { readTool } from "../src/tools/read.mjs";
import { shelfTool } from "../src/tools/shelf.mjs";
import { taskTool } from "../src/tools/task.mjs";
import { returnTool } from "../src/tools/return.mjs";
import { stateBlock } from "../src/state.mjs";
import { noteKey } from "../src/wake.mjs";
import { describeCall, describeResult } from "../src/terminal.mjs";
import { changeTools, clipWriteContent, writeOne } from "../src/tools/change.mjs";
import { consultTool } from "../src/tools/consult.mjs";
import { dressRequest, planRequest, withoutAdditions } from "../src/request.mjs";
import { createEngine } from "../src/engine.mjs";
import { runFromBrief } from "../src/harness.mjs";
import { TOOLS, TASK_HEADER, TASK_HANDOFF, LOOK_NOTE, CHANGE_NOTE, HANDOFF_IN_TURN, HANDOFF_NOTE, systemPrompt } from "../src/prompt.mjs";
import { assessmentPath } from "../src/assessment.mjs";
import { topPath } from "../src/top.mjs";
import { traceFile, watchTrace } from "../src/trace.mjs";
import { USER_NAME } from "../src/user.mjs";
import { RECORD } from "../src/voice.mjs";

const fresh = (t) => {
	const root = mkdtempSync(join(tmpdir(), "carto-test-"));
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, brainDir };
};
const NOW = "2026-11-15T00:00:00.000Z";

test("prompt: the sleep checklist names the person whose message may be waiting", () => {
	const prompt = systemPrompt({ root: "/project" });
	assert.ok(prompt.includes(`no message from ${USER_NAME} waiting`));
	assert.ok(!prompt.includes("no user message waiting"));
	assert.ok(TOOLS.sleep.includes(`${USER_NAME} speaks`));
});

test("harness: a cached inspect brief restores its look contract", () => {
	assert.deepEqual(runFromBrief({ mode: "look", move: "m2", revision: 3, targets: ["src/index.mjs"], turns: 2 }), {
		mode: "look", move: "m2", revision: 3, targets: ["src/index.mjs"], turns: 2,
	});
	assert.deepEqual(runFromBrief({ mode: "change", network: false, move: "m3", revision: 4 }), { mode: "change", move: "m3", revision: 4 }, "only an explicit true carries network");
	assert.deepEqual(runFromBrief({ mode: "unknown", network: true, move: "m4" }), { mode: "look" }, "a malformed stored brief fails closed to inspect");
});

test("context window: a reported capacity reserves configured reply room without raising the setting cap", () => {
	assert.deepEqual(contextWindowLimits(100_000, 32_768, 75_000), {
		configuredContextWindow: 100_000,
		usableContextWindow: 42_232,
		serverContextWindow: 75_000,
		replyReserve: 32_768,
	});
	assert.deepEqual(contextWindowLimits(40_000, 32_768, 75_000), {
		configuredContextWindow: 40_000,
		usableContextWindow: 40_000,
		serverContextWindow: 75_000,
		replyReserve: 32_768,
	}, "metadata never raises the configured cap");
	assert.deepEqual(contextWindowLimits(100_000, 32_768, 8_192), {
		configuredContextWindow: 100_000,
		usableContextWindow: 4_096,
		serverContextWindow: 8_192,
		replyReserve: 4_096,
	}, "a small server keeps the existing half-context split instead of losing all input room");
	assert.deepEqual(contextWindowLimits(100_000, 32_768, undefined), {
		configuredContextWindow: 100_000,
		usableContextWindow: 100_000,
	}, "without server metadata, the configured cap remains in force");
});

// ─── The wake notes ──────────────────────────────────────────────────────────

test("wake: the same note is the same note ignoring layout and case", () => {
	assert.equal(noteKey("The roller is\n   broken  again"), noteKey("the ROLLER is broken again"));
	assert.notEqual(noteKey("The roller is broken"), noteKey("The roller is still broken"), "different words are a different note");
	assert.equal(noteKey(""), noteKey("   \n "), "empty and whitespace-only are the same key");
	assert.notEqual(noteKey(""), noteKey("x"));
});

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

test("plan: an envelope is not runnable and closes only after a declared move is accepted", (t) => {
	const { brainDir } = fresh(t);
	const added = applyAdd(brainDir, "plan", JSON.stringify({ mode: "look", text: "Inspect the entry point." }), null);
	assert.match(added, /^p1 added as an authorization envelope/);
	assert.match(settleRow(brainDir, "p1", null), /has no execution moves/);
	const { plan } = loadPlan(brainDir);
	const moved = applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Read src/index.mjs", done_when: "Its entry point is identified." }, NOW);
	assert.match(moved.line, /^m1 added under p1/);
	const started = startMove(plan, "m1", NOW);
	assert.equal(started.move.status, "running");
	reportMove(plan, "m1", 1, { done: true, report: "t1", proof: "src/index.mjs was read" }, NOW);
	savePlan(brainDir, plan);
	assert.match(settleRow(brainDir, "m1", null), /m1 accepted\./);
	assert.match(settleRow(brainDir, "p1", null), /p1 is done\./);
	assert.equal(loadPlan(brainDir).plan.items[0].status, POLICY.enums.entryStatus.done);
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

test("plan: a change move persists its concrete contract and has no approval until a user grants its revision", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Improve the palette.", done_when: "The requested palette is visible." }, NOW);
	applyPlanOp(plan, {
		action: "addMove",
		parent: "p1",
		text: "Edit src/theme.mjs",
		done_when: "The new palette values are exported.",
		targets: ["src/theme.mjs"],
		proof: "The focused report names the palette check.",
		capabilities: { files: true, commands: false },
		budget: { replies: 3, fileOps: 2, commandStarts: 0 },
	}, NOW);
	const move = findMove(plan, "m1");
	assert.deepEqual({ action: move.action, targets: move.targets, doneWhen: move.doneWhen, proof: move.proof, capabilities: move.capabilities, budget: move.budget, revision: move.revision, status: move.status }, {
		action: "Edit src/theme.mjs",
		targets: ["src/theme.mjs"],
		doneWhen: "The new palette values are exported.",
		proof: "The focused report names the palette check.",
		capabilities: { files: true, commands: false, network: false },
		budget: { replies: 3, fileOps: 2, commandStarts: 0 },
		revision: 1,
		status: "open",
	});
	assert.equal(mayRun(plan, move), false, "the envelope is intent, not authority");
	approve(plan, NOW, ["p1"]);
	assert.equal(mayRun(plan, move), true);
	savePlan(brainDir, plan);
	assert.deepEqual(loadPlan(brainDir).plan.moves[0].budget, { replies: 3, fileOps: 2, commandStarts: 0 }, "the contract round-trips through disk");
});

test("plan: acceptance refuses a reported move from an earlier envelope revision", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Change one export.", done_when: "The export is demonstrated." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src/one.mjs", done_when: "The export changes.", targets: ["src/one.mjs"], proof: "Focused test output." }, NOW);
	approve(plan, NOW, ["m1"]);
	startMove(plan, "m1", NOW);
	reportMove(plan, "m1", 1, { done: true, report: "t1", checkpoints: { before: "c1", after: "c2" }, changes: [{ path: "src/one.mjs" }], proof: "Focused test exits zero." }, NOW);
	plan.items[0].revision = 2; // A hand-edited plan file must not let an old report complete new intent.
	assert.throws(() => applyPlanOp(plan, { action: "acceptMove", id: "m1" }, NOW), /earlier revision of p1/);
	savePlan(brainDir, plan);
	assert.equal(loadPlan(brainDir).plan.moves[0].parentRevision, 1, "the persisted move still records the envelope revision it ran under");
});

test("plan: a move field edit carries the UI's capability and budget changes, and withdraws only that move revision", (t) => {
	const { brainDir, root } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Tighten one check.", done_when: "The narrow check is recorded." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src/check.mjs", done_when: "The check is updated.", targets: ["src/check.mjs"], proof: "The focused check output." }, NOW);
	approve(plan, NOW, ["m1"]);
	savePlan(brainDir, plan);
	const said = editRow(brainDir, "m1", {
		proof: "The named focused test exits zero.",
		capabilities: { commands: false },
		budget: { replies: 3, fileOps: 1, commandStarts: 0 },
	}, root);
	assert.match(said, /m1 changed and needs approval again/);
	const move = loadPlan(brainDir).plan.moves[0];
	assert.equal(move.revision, 2);
	assert.equal(move.approvedRevision, undefined);
	assert.deepEqual(move.capabilities, { files: true, commands: false, network: false });
	assert.deepEqual(move.budget, { replies: 3, fileOps: 1, commandStarts: 0 });
	assert.equal(move.proof, "The named focused test exits zero.");
});

// ─── The assessment ─────────────────────────────────────────────────────────

test("assessment: the book tool writes it whole, and /assessment reads the file", async (t) => {
	const { brainDir, root } = fresh(t);
	const tool = bookTool({ root, brainDir, config: {}, engine: { messagesOf: () => [] } });
	const api = { conversationId: ROOT_CONVERSATION_ID, taskId: "test-assessment-write", now: () => Date.now(), executeTool: () => Promise.reject(new Error("unexpected nested tool")) };
	const result = await tool.execute(tool.prepareArguments({ target: "assessment", action: "write", text: "A dice roller. Builds with npm test." }), api, undefined);
	assert.equal(result.isError, undefined, JSON.stringify(result.output));
	assert.match(readFileSync(assessmentPath(brainDir), "utf8"), /A dice roller\./);
	assert.match(result.output[0].text, /Assessment saved \(36 characters/);
	// An empty assessment is refused at the door, and the file is untouched; the retired `operation` envelope is rejected.
	assert.throws(() => tool.prepareArguments({ target: "assessment", action: "write", text: "" }), /text/);
	assert.throws(() => tool.prepareArguments({ target: "assessment", action: "write", operation: { text: "nope" } }), /operation|unknown|additional/i);
	// An over-long one is clipped and says so.
	const long = "x".repeat(4000);
	const clipped = await tool.execute(tool.prepareArguments({ target: "assessment", action: "write", text: long }), api, undefined);
	assert.equal(clipped.isError, undefined);
	assert.equal(readFileSync(assessmentPath(brainDir), "utf8").trim().length <= 3001, true);
});

// ─── The plan: approval in the user's own words ─────────────────────────────

test("approval words: i yes approves the one waiting move revision, while a named move may deliberately allow network", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Change the palette.", done_when: "The palette changed." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src/theme.mjs", done_when: "The values are exported.", targets: ["src/theme.mjs"], proof: "A palette check." }, NOW);
	savePlan(brainDir, plan);
	assert.deepEqual(approvalWords(brainDir, "i yes", NOW), ["m1"]);
	let loaded = loadPlan(brainDir).plan;
	assert.equal(loaded.moves[0].approvedRevision, 1);
	applyPlanOp(loaded, { action: "add", mode: "change", text: "Check the published schema.", done_when: "The schema response is checked." , network: true }, NOW);
	applyPlanOp(loaded, { action: "addMove", parent: "p2", text: "Run the schema check", done_when: "The command reports the schema version.", targets: ["src/schema.mjs"], proof: "Command output.", capabilities: { network: true } }, NOW);
	savePlan(brainDir, loaded);
	assert.deepEqual(approvalWords(brainDir, "approved m2", NOW), ["m2"]);
	assert.equal(loadPlan(brainDir).plan.moves[1].approvedRevision, 1);
});

test("approval words: a bare affirmative does not sweep a batch, while scoped approval snapshots its current waiting moves", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	for (const [intent, action, path] of [["One", "Edit src/one.mjs", "src/one.mjs"], ["Two", "Edit src/two.mjs", "src/two.mjs"]]) {
		applyPlanOp(plan, { action: "add", mode: "change", text: intent, done_when: `${intent} is complete.` }, NOW);
		applyPlanOp(plan, { action: "addMove", parent: `p${plan.next - 1}`, text: action, done_when: `${intent} works.`, targets: [path], proof: `${intent} proof.` }, NOW);
	}
	savePlan(brainDir, plan);
	assert.equal(approvalWords(brainDir, "yes", NOW), undefined, "an unrelated yes never approves a queue of moves");
	assert.deepEqual(approvalWords(brainDir, "yes all", NOW), ["m1", "m2"]);
	const loaded = loadPlan(brainDir).plan;
	assert.deepEqual(loaded.moves.map((move) => move.approvedRevision), [1, 1]);
	applyPlanOp(loaded, { action: "addMove", parent: "p1", text: "Add a later check", done_when: "The extra check runs.", targets: ["test/one.mjs"], proof: "Extra check output." }, NOW);
	assert.equal(loaded.moves[2].approvedRevision, undefined, "a later addition never inherits the envelope snapshot");
});

test("approval words: a named envelope selects only its waiting child revisions, and an unknown p or m selects nothing", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "One.", done_when: "One is complete." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src/one.mjs", done_when: "One works.", targets: ["src/one.mjs"], proof: "One proof." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Test src/one.mjs", done_when: "One is tested.", targets: ["test/one.mjs"], proof: "Test output." }, NOW);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Two.", done_when: "Two is complete." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p2", text: "Edit src/two.mjs", done_when: "Two works.", targets: ["src/two.mjs"], proof: "Two proof." }, NOW);
	savePlan(brainDir, plan);
	assert.deepEqual(approvalWords(brainDir, "approved p1", NOW), ["m1", "m2"]);
	const loaded = loadPlan(brainDir).plan;
	assert.equal(loaded.moves[2].approvedRevision, undefined);
	assert.equal(approvalWords(brainDir, "approved p9", NOW), undefined);
	assert.equal(approvalWords(brainDir, "approved m99", NOW), undefined);
});

test("approval words: anything less than an affirmative is not approval of a move", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Change it.", done_when: "It changed." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src/it.mjs", done_when: "It works.", targets: ["src/it.mjs"], proof: "A check." }, NOW);
	savePlan(brainDir, plan);
	for (const words of ["no, wait", "yes but not p1", "what does p1 do?", "maybe", "ok?", "approve it later", "I approved the plan yesterday"]) {
		assert.equal(approvalWords(brainDir, words, NOW), undefined, JSON.stringify(words));
	}
	assert.equal(loadPlan(brainDir).plan.moves[0].approvedRevision, undefined);
});

test("approval words: whole-plan wording approves the current moves, and an edit creates a fresh unapproved revision", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Change it.", done_when: "It changed." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src/it.mjs", done_when: "It works.", targets: ["src/it.mjs"], proof: "A check." }, NOW);
	applyPlanOp(plan, { action: "add", mode: "change", text: "And that.", done_when: "That changed." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p2", text: "Edit src/that.mjs", done_when: "That works.", targets: ["src/that.mjs"], proof: "Another check." }, NOW);
	savePlan(brainDir, plan);
	assert.deepEqual(approvalWords(brainDir, "i approved the plan", NOW), ["m1", "m2"]);
	const loaded = loadPlan(brainDir).plan;
	applyPlanOp(loaded, { action: "editMove", id: "m1", proof: "A newer check." }, NOW);
	assert.equal(loaded.moves[0].revision, 2);
	assert.equal(loaded.moves[0].approvedRevision, undefined);
	assert.equal(mayRun(loaded, "m1"), false);
});


test("plan: a reported change move needs report, checkpoints, changed paths and proof before orchestration may accept it", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Ship a narrow change.", done_when: "The narrow change is demonstrated." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src/one.mjs", done_when: "The export changes.", targets: ["src/one.mjs"], proof: "The focused test output." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Check src/two.mjs", done_when: "The check passes.", targets: ["src/two.mjs"], proof: "The second test output." }, NOW);
	approve(plan, NOW, ["p1"]);
	startMove(plan, "m1", NOW);
	reportMove(plan, "m1", 1, { done: true, report: "t1", checkpoints: { before: "c1", after: "c2" }, changes: [{ path: "src/other.mjs" }], proof: "test output" }, NOW);
	assert.throws(() => applyPlanOp(plan, { action: "acceptMove", id: "m1" }, NOW), /outside its declared targets/);
	plan.moves[0].reported.changes = [{ path: "src/one.mjs" }];
	assert.doesNotThrow(() => applyPlanOp(plan, { action: "acceptMove", id: "m1" }, NOW));
	assert.throws(() => applyPlanOp(plan, { action: "done", id: "p1" }, NOW), /still has m2 \(open\)/);
	startMove(plan, "m2", NOW);
	reportMove(plan, "m2", 1, { done: true, report: "t2", checkpoints: { before: "c2", after: "c3" }, changes: [{ path: "src/two.mjs" }], proof: "second test output" }, NOW);
	applyPlanOp(plan, { action: "acceptMove", id: "m2" }, NOW);
	assert.doesNotThrow(() => applyPlanOp(plan, { action: "done", id: "p1" }, NOW));
	undoMove(plan, "m1", NOW);
	assert.equal(plan.moves[0].status, "open");
	assert.equal(plan.moves[0].approvedRevision, undefined);
	assert.equal(plan.items[0].status, "open");
	assert.equal(plan.items[0].closed, undefined);
	assert.equal(plan.moves[1].status, "blocked", "a later accepted sibling is stale after an earlier undo");
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
	const added = await tool.execute(tool.prepareArguments({ target: "atlas", action: "add", name: "src", gist: "The source." }), api(), undefined);
	assert.ok(!added.isError, added.output[0].text);
	const id = loadAtlas(brainDir).atlas.nodes[0].id;
	assert.match(id, /^c\d+$/, "the node came back with a c-id");
	const listed = await tool.execute({ target: "atlas", action: "list" }, api(), undefined);
	assert.match(listed.output[0].text, new RegExp(`"id": "${id}"`), "and `list` returns a ref to it");
	const confirmed = await tool.execute(tool.prepareArguments({ target: "atlas", action: "confirm", id }), api(), undefined);
	assert.ok(!confirmed.isError, confirmed.output[0].text);
	assert.match(confirmed.output[0].text, new RegExp(`${id} src confirmed\\.`), "confirming by top-level id reaches the node");
	const renamed = await tool.execute(tool.prepareArguments({ target: "atlas", action: "rename", id, to: "source" }), api(), undefined);
	assert.ok(!renamed.isError, renamed.output[0].text);
	assert.equal(loadAtlas(brainDir).atlas.nodes[0].name, "source", "and the rename moves the name, not the id");
	assert.equal(loadAtlas(brainDir).atlas.nodes[0].id, id);
	// Node name lookup works anywhere `id` is accepted (`edit`, `read`, `look`, `confirm`).
	const editedByName = await tool.execute(tool.prepareArguments({ target: "atlas", action: "edit", id: "source", gist: "Updated source.", files: ["src/app.mjs"] }), api(), undefined);
	assert.ok(!editedByName.isError, editedByName.output[0].text);
	const readByName = await tool.execute(tool.prepareArguments({ target: "atlas", action: "read", id: "source" }), api(), undefined);
	assert.ok(!readByName.isError, readByName.output[0].text);
	assert.equal(readByName.details.ref.id, id);
	const lookedById = await tool.execute(tool.prepareArguments({ target: "atlas", action: "look", id }), api(), undefined);
	assert.ok(!lookedById.isError && lookedById.output[0].text.includes("Updated source."));
	const batchConfirmed = await tool.execute(tool.prepareArguments({ target: "atlas", action: "confirm", names: ["source"] }), api(), undefined);
	assert.ok(!batchConfirmed.isError, batchConfirmed.output[0].text);
});

test("refs: the chat shows a file ref as its file, not as a bare id", (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.html"), "<!doctype html>\n");
	const { ref } = observeFile(root, brainDir, "src/index.html");
	const describeRef = createRefDescriber({ brainDir });
	assert.equal(describeRef(ref), `index.html (${ref.id})`);
	assert.equal(describeCall({ name: "read", arguments: { id: ref.id } }, describeRef), `read index.html (${ref.id})`);
	assert.equal(describeCall({ name: "read", arguments: { id: ref.id, range: "1-20" } }, describeRef), `read index.html (${ref.id}) (lines 1-20)`);
	assert.equal(describeCall({ name: "shelf", arguments: { action: "add", id: ref.id } }, describeRef), `shelf add index.html (${ref.id})`);
	// What a call means without a describer is unchanged: the bare id.
	assert.equal(describeCall({ name: "read", arguments: { id: ref.id } }), `read ${ref.id}`);
});

test("refs: the chat shows an atlas ref as its node, not as a bare id", async (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "app.mjs"), "console.log(1)\n");
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const api = { conversationId: ROOT_CONVERSATION_ID, taskId: "t1", now: () => 0, executeTool: () => Promise.reject(new Error("unexpected nested tool")) };
	await tool.execute(tool.prepareArguments({ target: "atlas", action: "add", name: "src", gist: "The source." }), api, undefined);
	const node = loadAtlas(brainDir).atlas.nodes[0];
	const describeRef = createRefDescriber({ brainDir });
	assert.equal(describeRef({ kind: "atlas", id: node.id }), `src (${node.id})`);
	assert.equal(describeCall({ name: "book", arguments: { target: "atlas", action: "confirm", id: node.id } }, describeRef), `book atlas confirm src (${node.id})`);
	assert.equal(describeCall({ name: "book", arguments: { target: "atlas", action: "confirm", ref: { namespace: "n-0123456789abcdef", kind: "atlas", id: node.id } } }, describeRef), `book atlas confirm src (${node.id})`);
});

// ─── The templates ──────────────────────────────────────────────────────────

test("templates: every book has a template that parses and applies", (t) => {
	const { brainDir, root } = fresh(t);
	for (const [book, expect] of [["ledger", /added\.$/], ["plan", /added as an authorization envelope\./]]) {
		const template = addTemplate(book);
		assert.equal(typeof template, "string");
		assert.doesNotThrow(() => JSON.parse(template));
		const filled = template
			.replace('"text": ""', '"text": "from the template."')
			.replace('"done_when": ""', '"done_when": "the declared work is complete."')
			.replace('"gist": ""', '"gist": "from the template."');
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

test("shell: a read-only inline run with a cross-action argument still runs, and says so", async () => {
	const tool = shellTool({ config: { shellWait: 30 }, runner: { mode: "sandbox" }, windows: stubWindows(), runOf: () => ({ mode: "look" }) });
	const result = await tool.execute({ action: "run", command: "ls", text: "typed?" }, { conversationId: ROOT_CONVERSATION_ID, taskId: "t", now: () => Date.now() }, {});
	assert.match(result.output[0].text, /Ignored as not for `run`: `text` \(send only\)\./);
});

test("shell: TOOLS.shell distinguishes the confined inline lane from an authorized direct move", () => {
	assert.match(TOOLS.shell, /Inline commands from the orchestrating context always use the read-only lane; in direct mode that lane still needs working bubblewrap and is refused without it\./);
	assert.match(TOOLS.shell, /A declared change move is different: in direct mode it runs directly under its live move token even when bubblewrap is unavailable/);
	assert.match(TOOLS.shell, /read, wait, stop and close work for every context/i);
});

test("shell: a live move owns its window, spends command starts, and loses stop authority when its revision changes", async (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Run the narrow check.", done_when: "The check is recorded." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Run npm test", done_when: "The test exits.", targets: ["src/check.mjs"], proof: "Test output.", budget: { replies: 3, fileOps: 0, commandStarts: 1 } }, NOW);
	approve(plan, NOW, ["m1"]);
	startMove(plan, "m1", NOW);
	savePlan(brainDir, plan);
	const focus = "shell-focus";
	updateContext(brainDir, (store) => { Object.assign(taskState(store, focus), { mode: "change", move: "m1", revision: 1, commandUses: 0, windows: [], commands: [] }); });
	const open = new Set();
	const result = (window, more = {}) => ({ text: "", ms: 1, reason: "time", window, cwd: ".", lines: 0, kept: 0, sandbox: true, network: false, state: "busy", ...more });
	let stopped = 0;
	const windows = {
		list: () => [...open].map((name) => ({ name, state: "busy" })),
		run: async (name) => { open.add(name); return result(name); },
		send: async (name) => result(name),
		stop: async (name) => { stopped++; return result(name, { wasBusy: true, ended: true, exit: 130, state: "idle" }); },
		close: (name) => ({ wasGone: !open.delete(name) }),
	};
	const tool = shellTool({ brainDir, config: { shellWait: 30 }, gate: { yolo: false }, runner: { mode: "sandbox" }, windows, runOf: () => ({ mode: "change", move: "m1", revision: 1 }) });
	const api = { conversationId: focus, taskId: "shell-focus" };
	const started = await tool.execute({ action: "run", command: "npm test", window: "check" }, api, {});
	assert.equal(started.isError, false, started.output[0].text);
	assert.equal(loadContext(brainDir).tasks[focus].commandUses, 1);
	assert.deepEqual(loadContext(brainDir).tasks[focus].windows, ["check"]);
	const sent = await tool.execute({ action: "send", window: "check", text: "q" }, api, {});
	assert.equal(sent.isError, false, sent.output[0].text);
	const exhausted = await tool.execute({ action: "run", command: "npm test", window: "other" }, api, {});
	assert.equal(exhausted.isError, true);
	assert.match(exhausted.output[0].text, /started all 1 commands/);
	const altered = loadPlan(brainDir).plan;
	applyPlanOp(altered, { action: "editMove", id: "m1", proof: "A newer test output." }, NOW);
	savePlan(brainDir, altered);
	const refusedStop = await tool.execute({ action: "stop", window: "check" }, api, {});
	assert.equal(refusedStop.isError, true);
	assert.equal(stopped, 0, "a stale move cannot control its old shell window");
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
	const user = front.text.indexOf(`${USER_NAME}: please add the wrist throw`);
	const me = front.text.indexOf("me: on it");
	assert.ok(user >= 0 && me >= 0, "both sayings stand");
	assert.ok(user < me, "in the order they were said");
	assert.ok(front.text.split("\n").includes(`13:10  ${USER_NAME}: please add the wrist throw`));
	assert.ok(front.text.split("\n").includes("13:12  me: on it"));
	assert.equal(chatLine({ who: "user", at: at(13, 10), text: "please add the wrist throw" }), `13:10  ${USER_NAME}: please add the wrist throw`);
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

test("lane: a declared direct change move still runs when bubblewrap is absent", async (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Run the direct check.", done_when: "The direct check is recorded." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Run the direct check", done_when: "The command exits.", targets: ["src/check.mjs"], proof: "Command output.", budget: { replies: 2, fileOps: 0, commandStarts: 1 } }, NOW);
	approve(plan, NOW, ["m1"]);
	startMove(plan, "m1", NOW);
	savePlan(brainDir, plan);
	const focus = "direct-shell-focus";
	updateContext(brainDir, (store) => { Object.assign(taskState(store, focus), { mode: "change", move: "m1", revision: 1, commandUses: 0, windows: [], commands: [] }); });
	let called;
	const windows = {
		...stubWindows(),
		list: () => [],
		async run(name, command, options) {
			called = { name, command, options };
			return { text: "ok", ms: 1, reason: "done", exit: 0, window: name, cwd: ".", lines: 1, kept: 1, sandbox: false, network: true, state: "idle" };
		},
	};
	const runner = gatedRunnerOf(true, { ok: false, why: "bubblewrap (the bwrap command) is not installed" });
	const tool = shellTool({ brainDir, config: { shellWait: 1 }, gate: { yolo: false }, runner, windows, runOf: () => ({ mode: "change", move: "m1", revision: 1 }) });
	const result = await tool.execute({ action: "run", command: "npm test", window: "direct" }, { conversationId: focus, taskId: focus }, {});
	assert.equal(result.isError, false, result.output[0].text);
	assert.deepEqual(called, { name: "direct", command: "npm test", options: { network: false, waitMs: 1_000, signal: undefined, readOnly: false } });
	assert.equal(loadContext(brainDir).tasks[focus].commandUses, 1);
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
	assert.match(block, /Inline commands remain read-only when bubblewrap works; when it does not, none run\./);
});

test("state: the no-sandbox line says no command can be run at all", (t) => {
	const block = blockOf(t, runnerOf(false, { ok: false, why: "bubblewrap (the bwrap command) is not installed" }));
	assert.match(block, /No command can be run in this session/);
});

test("state: the sandboxed block does not claim the main agent is blocked", (t) => {
	const block = blockOf(t, runnerOf(false, { ok: true, version: "0.9.0", shell: "bash" }));
	assert.doesNotMatch(block, /You yourself may still run commands in this session/);
});

test("dressRequest: the replay build equals the live build, for the same inputs", (t) => {
	const { brainDir, root } = fresh(t);
	writeFileSync(join(brainDir, "carto-ledger.json"), JSON.stringify({ version: 1, next: 1, items: [] }, null, "\t"));
	writeFileSync(join(brainDir, "carto-plan.json"), JSON.stringify({ version: 1, items: [] }, null, "\t"));
	writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
	const at = Date.parse("2026-11-15T10:00:00.000Z");
	const messages = [
		{ role: "user", content: [{ type: "text", text: "Map the parser." }], timestamp: at },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }], timestamp: at + 1000 },
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "alpha\nbeta\n" }], timestamp: at + 2000 },
	];
	// Both builds get the same stubs; the replay just may not consume anything.
	let consumed = 0;
	const windows = { list: () => [], noteShown: () => { consumed += 1; return []; } };
	const wakes = { check: () => { consumed += 1; }, noteShown: () => { consumed += 1; return []; }, lines: () => undefined };
	const args = { brainDir, root, runner: { mode: "sandbox", available: { ok: true, version: "0.9.0", shell: "bash" } }, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: true, conversationId: ROOT_CONVERSATION_ID, used: 4321 };
	const live = dressRequest(messages, { ...args, windows, wakes });
	const replay = dressRequest(messages, { ...args, windows, wakes, replay: true });
	const again = dressRequest(messages, { ...args, windows, wakes, replay: true });
	assert.equal(JSON.stringify(replay), JSON.stringify(again), "the replay is deterministic");
	assert.equal(consumed, 3, "the live build consumed its wakes and windows; the replay consumed nothing");
	assert.equal(JSON.stringify(live), JSON.stringify(replay), "the view the screen renders is byte-identical to the request the model got");
});

test("request plan: it is a pure current calculation with ordered source facts", (t) => {
	const { brainDir, root } = fresh(t);
	const at = Date.parse("2026-11-15T10:00:00.000Z");
	const messages = [
		{ role: "user", content: [{ type: "text", text: "Map the parser." }], timestamp: at },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "alpha\nbeta\n" }] },
	];
	const before = JSON.stringify(messages);
	const plan = planRequest(messages, {
		brainDir,
		root,
		runner: { mode: "sandbox", available: { ok: true, version: "0.9.0", shell: "bash" } },
		config: { contextWindow: 100_000 },
		gate: { yolo: false },
		main: true,
		conversationId: ROOT_CONVERSATION_ID,
		used: 4321,
		fired: [],
		wakeLines: ["one scheduled wake"],
		windowRows: [],
		// A planner never looks at these live-effect doors. Passing them makes an accidental call fail this test.
		wakes: { check: () => { throw new Error("preview checked wakes"); }, noteShown: () => { throw new Error("preview consumed wakes"); } },
		windows: { noteShown: () => { throw new Error("preview consumed windows"); } },
	});
	assert.equal(JSON.stringify(messages), before, "planning never mutates the active conversation");
	assert.match(plan.messages.at(-1).content.at(-1).text, /<read-tail>/, "the current read batch is planned at the tail");
	assert.deepEqual(plan.parts.map((part) => part.kind), ["active-message", "active-message", "active-message", "generated-state", "transient-read-tail"], "the plan captures source order before provider formatting");
	assert.equal(plan.parts[0].source, `active:${ROOT_CONVERSATION_ID}:0`, "a source has an identity rather than a text-match key");
	assert.match(plan.parts.find((part) => part.kind === "generated-state").fragment, /^<state>/, "generated state has its exact planned fragment");
});

test("dressRequest: a task carries the context lines and the requests, as the live agent does", (t) => {
	const { brainDir, root } = fresh(t);
	writeFileSync(join(brainDir, "carto-ledger.json"), JSON.stringify({ version: 1, next: 1, items: [] }, null, "\t"));
	writeFileSync(join(brainDir, "carto-plan.json"), JSON.stringify({ version: 1, items: [] }, null, "\t"));
	applyAdd(brainDir, "ledger", JSON.stringify({ kind: "question", text: "Which parser?" }), null);
	// A report in full, and a file on the shelf: the coordination lines need both.
	mkdirSync(join(brainDir, "reports"), { recursive: true });
	writeFileSync(join(brainDir, "reports", "s1.md"), "# Report s1\n\nIt parses now.\n");
	updateContext(brainDir, (store) => {
		store.rows.push({ id: "s1", species: "composed", at: "2026-11-15T09:00:00.000Z", mode: "look", brief: "Map the parser", outcome: "It parses.", changed: 0, ref: { type: "report", id: "s1" } });
	});
	writeFileSync(join(root, "shelf.txt"), "the shelf keeps this\n");
	const shelved = shelfItem(root, "shelf.txt", undefined, brainDir, []);
	updateContext(brainDir, (store) => { store.shelf.push(shelved.item); });
	const messages = [{ role: "user", content: [{ type: "text", text: "Carry out the brief." }], timestamp: Date.parse("2026-11-15T10:00:00.000Z") }];
	const textOf = (message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));
	const dressed = dressRequest(messages, { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: false, conversationId: "task-1", used: 1234 });
	const block = new RegExp(`<state>\\n[\\s\\S]*\\n</state>`).exec(textOf(dressed.at(-1)))?.[0];
	assert.ok(block !== undefined, "a task's request ends with its state block");
	assert.match(block, /Focus\n/, "with its one-line purpose");
	assert.match(block, /My context holds about 1,234 of 100,000 tokens\./, "and its own server count");
	assert.match(block, /Shelf items \(stable ID; unshelve by ID or path\):/, "and the shelf lines");
	assert.match(block, /In view in full: s1 \(about [\d,]+ tokens\)\./, "and which reports stand in view in full");
	assert.match(block, /Requests\nThese wait for /, "and what waits for the user");
	assert.match(block, /q1 {2}Which parser\?/, "named, not counted");
	assert.doesNotMatch(block, /Wakes\n/, "wakes alone stay the main agent's");
	const main = dressRequest(messages, { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: true, conversationId: ROOT_CONVERSATION_ID, used: 1234 });
	const mainBlock = new RegExp(`<state>\\n[\\s\\S]*\\n</state>`).exec(textOf(main.at(-1)))?.[0];
	assert.match(mainBlock, /Requests\nThese wait for /, "the main agent's block keeps the same list");
});

test("dressRequest: only human chat gets the configured speaker label, which replay strips", (t) => {
	const { brainDir, root } = fresh(t);
	const front = `${POLICY.markup.context.open}\n${RECORD} My context was collapsed.\n${POLICY.markup.context.close}`;
	const note = `${POLICY.markup.note.open}\n${RECORD} Nobody typed this.\n${POLICY.markup.note.close}`;
	const collapsed = `${POLICY.markup.note.open}\nEarlier task steps were collapsed.\n${POLICY.markup.note.close}`;
	const messages = [
		{ role: "user", content: "Hello" },
		{ role: "user", content: front },
		{ role: "user", content: note },
		{ role: "user", content: collapsed },
		{ role: "user", content: `${USER_NAME}: already labeled` },
	];
	const dressed = dressRequest(messages, { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: false, conversationId: "task-1", note: "One-request task note" });
	const userTexts = dressed.filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")));
	assert.equal(userTexts[0], `${USER_NAME}: Hello`);
	assert.equal(userTexts[1], front, "the front block is not a person speaking");
	assert.equal(userTexts[2], note, "Cartographer's notes are not a person speaking");
	assert.equal(userTexts[3], collapsed, "a collapsed task-steps block is not a person speaking");
	assert.equal(userTexts[4], `${USER_NAME}: already labeled`, "an existing label is not repeated");
	assert.ok(userTexts[5].startsWith("One-request task note"), "the task's ephemeral note is appended after speaker dressing");
	assert.equal(messages[0].content, "Hello", "stored messages are not changed");
	assert.equal(withoutAdditions(userTexts[0]), "Hello", "the request-only label comes off for display and replay");
	assert.equal(withoutAdditions(`${USER_NAME}: Hello\n\n[sent Thu 12 Nov 2026, 14:02]`), "Hello", "the label and timestamp both come off");
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

test("plan: named request approval expands an envelope's current moves and state names the move contract", (t) => {
	const { brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	for (const [intent, action, path] of [["Add the wrist throw.", "Edit src/throw.mjs", "src/throw.mjs"], ["Test the throw.", "Edit test/throw.mjs", "test/throw.mjs"]]) {
		applyPlanOp(plan, { action: "add", mode: "change", text: intent, done_when: `${intent} is demonstrated.` }, NOW);
		applyPlanOp(plan, { action: "addMove", parent: `p${plan.next - 1}`, text: action, done_when: `${intent} works.`, targets: [path], proof: `${intent} proof.` }, NOW);
	}
	savePlan(brainDir, plan);
	let loaded = loadPlan(brainDir).plan;
	assert.equal(awaitsApproval(loaded), true, "two change moves wait for the user");
	assert.match(authorizationLine(loaded), /^Not approved/);
	assert.match(planSummary(loaded), /2 moves wait for approval/);
	const done = approveRequests(brainDir, ["p1"]);
	assert.deepEqual(done.items, ["m1"]);
	loaded = loadPlan(brainDir).plan;
	assert.equal(awaitsApproval(loaded), true, "m2 still waits");
	assert.match(authorizationLine(loaded), /^Not approved/);
	approveRequests(brainDir, ["m2"]);
	loaded = loadPlan(brainDir).plan;
	assert.equal(awaitsApproval(loaded), false);
	assert.match(authorizationLine(loaded), new RegExp("^Authorized by " + USER_NAME));
	assert.match(planSummary(loaded), /2 moves approved/);
});

test("change gate: a focus carries one approved move revision; direct file authority is target- and budget-scoped", async (t) => {
	const { root, brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Add the wrist throw.", done_when: "The throw is available." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Create src/throw.mjs", done_when: "The module exists.", targets: ["src/throw.mjs"], proof: "The module is read back.", budget: { replies: 3, fileOps: 1, commandStarts: 0 } }, NOW);
	approve(plan, NOW, ["m1"]);
	startMove(plan, "m1", NOW);
	savePlan(brainDir, plan);
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const [write] = changeTools({ root, brainDir, gate: { yolo: false }, write: { newOnly: true, maxLines: 60 } });
	const focus = "focus-7777";
	updateContext(brainDir, (store) => {
		Object.assign(taskState(store, focus), { purpose: "create the throw", item: "p1", move: "m1", revision: 1, mode: "change", fileOps: 0, commandUses: 0, windows: [] });
	});
	const focusApi = {
		conversationId: focus,
		taskId: "file-focus",
		executeTool: async (name, args) => {
			assert.equal(name, "write");
			const nested = await write.execute(args, focusApi, undefined);
			return { isError: nested.isError === true, structuredOutput: nested.output?.[0]?.text };
		},
	};
	const outside = await tool.execute(tool.prepareArguments({ target: "file", action: "create", path: "src/outside.mjs", content: "export {};\n" }), focusApi, undefined);
	assert.equal(outside.isError, true);
	assert.match(outside.output[0].text, /outside m1's declared targets/);
	assert.equal(loadContext(brainDir).tasks[focus].fileOps, 0, "a refused path does not spend the move's file budget");
	const created = await tool.execute(tool.prepareArguments({ target: "file", action: "create", path: "src/throw.mjs", content: "export const throwDie = () => 1;\n" }), focusApi, undefined);
	assert.equal(created.isError, false, created.output[0].text);
	assert.equal(existsSync(join(root, "src", "throw.mjs")), true);
	assert.equal(loadContext(brainDir).tasks[focus].fileOps, 1, "the successful write spends the move's file budget");
	const spent = await tool.execute(tool.prepareArguments({ target: "file", action: "create", path: "src/throw.mjs", content: "export {};\n" }), focusApi, undefined);
	assert.equal(spent.isError, true);
	assert.match(spent.output[0].text, /used all 1 direct file mutations/);
	const stranger = await tool.execute(tool.prepareArguments({ target: "file", action: "create", path: "src/throw.mjs", content: "export {};\n" }), { conversationId: "focus-4242", executeTool: async () => { throw new Error("must not run"); } }, undefined);
	assert.equal(stranger.isError, true);
	assert.match(stranger.output[0].text, /not carrying a live authorized change move/);
});

test("file edit: top-level id or path is enough, and always points at the live version", async (t) => {
	const { root, brainDir } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "dice.js"), "const a = 1;\nconst b = 2;\n");
	writeFileSync(join(root, "src", "extra.js"), "export const x = 1;\n");
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Edit the throw files.", done_when: "The module and its helper are updated." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Update src/dice.js and src/extra.js", done_when: "Both source files have the intended edits.", targets: ["src/dice.js", "src/extra.js"], proof: "The files are read back." }, NOW);
	approve(plan, NOW, ["m1"]);
	startMove(plan, "m1", NOW);
	savePlan(brainDir, plan);
	const { ref } = observeFile(root, brainDir, "src/dice.js");
	const id = ref.id;
	// The agent never sees a namespace, a kind or a 64-character hash: only the file's ID or path.
	const tool = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const focus = "focus-7777";
	updateContext(brainDir, (store) => {
		Object.assign(taskState(store, focus), { purpose: "edit the throw", item: "p1", move: "m1", revision: 1, mode: "change", fileOps: 0, commandUses: 0, windows: [] });
	});
	const [, edit, rm] = changeTools({ root, brainDir, gate: { yolo: false } });
	const focusApi = { conversationId: focus, taskId: "file-edit-focus", executeTool: async (name, args) => {
		const impl = name === "edit" ? edit : name === "rm" ? rm : undefined;
		if (!impl) throw new Error(`unexpected nested tool ${name}`);
		const nested = await impl.execute(args, focusApi, undefined);
		// What the harness does with a nested call's result: flag + structured output.
		return { isError: nested.isError === true, structuredOutput: nested.output?.[0]?.text };
	} };

	// Top-level `read` by `id` (and by `path`): the bytes as they are, no line numbers, and the ID to edit by.
	const reader = readTool({ root, brainDir });
	const read = await reader.execute(reader.prepareArguments({ id }), focusApi, undefined);
	const readText = read.output[0].text;
	assert.ok(readText.includes("const a = 1;\nconst b = 2;"), `the read shows the exact bytes:\n${readText}`);
	assert.ok(!/\d+ │ /.test(readText) && !/│/.test(readText), "no line numbers in the read");
	assert.ok(readText.includes(`file ${id}`), "and it says which file ID it is");
	const readByPath = await reader.execute(reader.prepareArguments({ path: "src/dice.js", range: "1-1" }), focusApi, undefined);
	assert.match(readByPath.output[0].text, /== src\/dice\.js \(lines 1-1 of 2\) · file f\d+/);
	assert.ok(!readByPath.output[0].text.includes("const b = 2;"));
	// `book` redirects `file read` cleanly to top-level `read` / `shelf`.
	assert.throws(() => tool.prepareArguments({ target: "file", action: "read", id }), /top-level `read` tool/);

	// `file edit` by top-level `id` alone (with no `planItem` needed).
	const firstEdit = await tool.execute(tool.prepareArguments({ target: "file", action: "edit", id, oldText: "const b = 2;\n", newText: "const b = 3;\n" }), focusApi, undefined);
	assert.equal(firstEdit.isError, false, `the edit by ID succeeded: ${firstEdit.output[0].text}`);
	assert.equal(readFileSync(join(root, "src", "dice.js"), "utf8"), "const a = 1;\nconst b = 3;\n");

	// The ID points at the live version: a second edit with no version anywhere must succeed too.
	const secondEdit = await tool.execute(tool.prepareArguments({ target: "file", action: "edit", id, oldText: "const a = 1;\n", newText: "const a = 10;\n" }), focusApi, undefined);
	assert.equal(secondEdit.isError, false, `the second edit by ID succeeded: ${secondEdit.output[0].text}`);
	assert.equal(readFileSync(join(root, "src", "dice.js"), "utf8"), "const a = 10;\nconst b = 3;\n");

	// A pinned ref is still honored as an optimistic check, and fails only because it is stale by choice.
	const stale = await tool.execute(tool.prepareArguments({ target: "file", action: "edit", ref: { ...ref, version: ref.version }, oldText: "const a = 10;\n", newText: "const a = 11;\n" }), focusApi, undefined);
	assert.equal(stale.isError, true);
	assert.match(stale.output[0].text, /Stale|status/);

	// `file edit` and `file remove` also accept `path` directly (and empty `newText` deletes the passage).
	const byPathEdit = await tool.execute(tool.prepareArguments({ target: "file", action: "edit", path: "src/extra.js", oldText: "export const x = 1;\n", newText: "" }), focusApi, undefined);
	assert.equal(byPathEdit.isError, false, byPathEdit.output[0].text);
	assert.equal(readFileSync(join(root, "src", "extra.js"), "utf8"), "");
	const byPathRemove = await tool.execute(tool.prepareArguments({ target: "file", action: "remove", path: "src/extra.js" }), focusApi, undefined);
	assert.equal(byPathRemove.isError, false, byPathRemove.output[0].text);
	assert.equal(existsSync(join(root, "src", "extra.js")), false);

	// The call label names the tool that carries it, and the result summary strips the file header like `edit`.
	assert.equal(describeCall({ name: "book", arguments: { target: "file", action: "edit", id, oldText: "x", newText: "y" } }), `book file edit ${id}`);
	assert.equal(describeResult({ toolName: "book", content: firstEdit.output, details: firstEdit.details, isError: firstEdit.isError }), "2 lines from line 2 replaced by 2 lines");
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

test("shelf tool: first-class add/remove/list, one-line receipt, range refresh by placement id, and focus shelf in state", async (t) => {
	const { root, brainDir } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "notes.txt"), "Ship it on Friday.\nSecond line.\nThird line.\n");
	writeFileSync(join(root, "index.html"), "<!doctype html>\n<title>dice</title>\n");
	const { ref } = observeFile(root, brainDir, "src/notes.txt");
	const shelf = shelfTool({ root, brainDir, config: { contextWindow: 100_000 } });
	const book = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	let taskSeq = 0;
	const makeApi = (conversationId = ROOT_CONVERSATION_ID) => ({ conversationId, taskId: `shelf-${++taskSeq}`, executeTool: () => Promise.reject(new Error("unexpected nested tool")) });

	// `book` redirects `target: "shelf"` to the top-level `shelf` tool.
	assert.throws(() => book.prepareArguments({ target: "shelf", action: "add", id: ref.id }), /top-level `shelf` tool/);

	// Top-level `id` alone survives prepareArguments, shelves the catalog file, and returns a 1-line receipt (no duplicate snapshot body).
	const prepared = shelf.prepareArguments({ action: "add", id: ref.id });
	const added = await shelf.execute(prepared, makeApi(), undefined);
	assert.ok(!added.isError, `shelf add by top-level id succeeded: ${added.output[0].text}`);
	assert.equal(added.output[0].text.includes("Ship it on Friday."), false, "receipt does not duplicate the snapshot body into tool history");
	const listed = await shelf.execute(shelf.prepareArguments({ action: "list" }), makeApi(), undefined);
	assert.match(listed.output[0].text, /placement/, "and the shelf holds it");
	assert.match(listed.output[0].text, new RegExp(`"id":\\s*"${ref.id}"`), "as the file the agent saw");

	// Re-adding by placement ID (`sh1`) updates the range and refreshes from disk.
	writeFileSync(join(root, "src", "notes.txt"), "Ship it on Monday.\nSecond line.\nThird line.\n");
	const narrowed = await shelf.execute(shelf.prepareArguments({ action: "add", id: added.details.placement, range: "1-1" }), makeApi(), undefined);
	assert.ok(!narrowed.isError, narrowed.output[0].text);
	assert.equal(narrowed.details.placement, added.details.placement, "updates the same placement in place");
	assert.match(loadContext(brainDir).shelf[0].snapshot, /Ship it on Monday\./);
	assert.doesNotMatch(loadContext(brainDir).shelf[0].snapshot, /Second line\./);

	// Passing an existing project path in `id` (before any prior `read`) catalogs and shelves it on the first call.
	const byPathInId = await shelf.execute(shelf.prepareArguments({ action: "add", id: "index.html" }), makeApi(), undefined);
	assert.ok(!byPathInId.isError, `shelf add with path in id succeeded: ${byPathInId.output[0].text}`);

	// Snapshot renders once in `<state>` (and vanishes immediately on `shelf remove`).
	const userMessages = [{ role: "user", content: [{ type: "text", text: "Check shelf." }], timestamp: Date.parse("2026-11-16T10:00:00.000Z") }];
	const beforeRemove = dressRequest(userMessages, { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: true, conversationId: ROOT_CONVERSATION_ID });
	assert.match(beforeRemove.at(-1).content.at(-1).text, /<title>dice<\/title>/, "snapshot body appears in state block");

	// Removing by placement `id` (`sh1`) and by `path` both work; retired `placementId` is rejected by validation.
	assert.throws(() => shelf.prepareArguments({ action: "remove", placementId: added.details.placement }), /placementId|unknown|additional/i);
	const removedById = await shelf.execute(shelf.prepareArguments({ action: "remove", id: added.details.placement }), makeApi(), undefined);
	assert.ok(!removedById.isError, removedById.output[0].text);
	const removedByPath = await shelf.execute(shelf.prepareArguments({ action: "remove", path: "index.html" }), makeApi(), undefined);
	assert.ok(!removedByPath.isError, removedByPath.output[0].text);
	const afterRemove = dressRequest(userMessages, { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: true, conversationId: ROOT_CONVERSATION_ID });
	assert.doesNotMatch(afterRemove.at(-1).content.at(-1).text, /<title>dice<\/title>/, "unshelving drops the snapshot from the next request immediately");

	// Inside a focused task, `shelf add` populates the focus's own shelf and `<state>` renders it for that focus.
	const focusAdded = await shelf.execute(shelf.prepareArguments({ action: "add", path: "index.html" }), makeApi("focus-42"), undefined);
	assert.ok(!focusAdded.isError, focusAdded.output[0].text);
	assert.equal(loadContext(brainDir).shelf.length, 0, "main shelf remains empty");
	const focusDressed = dressRequest(userMessages, { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: false, conversationId: "focus-42" });
	assert.match(focusDressed.at(-1).content.at(-1).text, /<title>dice<\/title>/, "focus sees its own shelved snapshot in state");

	// An ID that is nothing at all is refused with a sentence, not a validation error.
	const missing = await shelf.execute(shelf.prepareArguments({ action: "add", id: "f999" }), makeApi(), undefined);
	assert.equal(missing.isError, true);
	assert.match(missing.output[0].text, /Nothing with the ID/);
});

test("prepareArguments: book, read, and shelf repair deeply frozen harness arguments without mutating them", (t) => {
	// The harness reads the assistant entry and deep-freezes everything in it, the tool-call arguments included
	// (pi-durable freezeJson). Each tool's repair must carry a new object instead of mutating the frozen one.
	const { root, brainDir } = fresh(t);
	const book = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const reader = readTool({ root, brainDir });
	const shelf = shelfTool({ root, brainDir, config: {} });
	const deepFreeze = (value) => {
		if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
		return value;
	};
	const readPath = deepFreeze({ path: "index.html", range: "1-40" });
	assert.deepEqual(reader.prepareArguments(readPath), { path: "index.html", range: "1-40" });
	const readId = deepFreeze({ id: "f1", version: "a".repeat(64) });
	assert.deepEqual(reader.prepareArguments(readId), { id: "f1", version: "a".repeat(64) });
	assert.throws(() => reader.prepareArguments(deepFreeze({})), /read needs `path` or `id`/);

	const shelfById = shelf.prepareArguments(deepFreeze({ action: "add", id: "f1", range: "1-20" }));
	assert.equal(shelfById.id, "f1");
	assert.equal(shelfById.ref.id, "f1");
	assert.ok(typeof shelfById.ref.namespace === "string" && shelfById.ref.namespace.length >= 16);
	assert.throws(() => shelf.prepareArguments(deepFreeze({ action: "add", id: "f1", ref: { id: "f2" } })), /matching `id` and `ref\.id`/);

	const editPath = book.prepareArguments(deepFreeze({ target: "file", action: "edit", path: "index.html", oldText: "a", newText: "b" }));
	assert.equal(editPath.ref, undefined, "no ref is invented for a path call");
	const editId = book.prepareArguments(deepFreeze({ target: "file", action: "edit", id: "f1", oldText: "a", newText: "b" }));
	assert.equal(editId.id, "f1");
	assert.equal(editId.ref.id, "f1");
	assert.equal(editId.ref.kind, "file", "the kind is inferred from the target");
	const editRef = book.prepareArguments(deepFreeze({ target: "file", action: "edit", ref: { id: "f1", version: "a".repeat(64) }, oldText: "a", newText: "b" }));
	assert.equal(editRef.ref.version, "a".repeat(64));
	assert.throws(() => book.prepareArguments({ target: "file", action: "edit", id: "f1", ref: { id: "f2" }, oldText: "a", newText: "b" }), /matching `id` and `ref\.id`/);
});

test("return: a declared proof is durable and separate from the task report", async (t) => {
	const { root, brainDir } = fresh(t);
	const tool = returnTool({ root, brainDir, config: {} });
	const result = await tool.execute({ report: "The targeted test passed.", proof: "npm test -- focused exits 0.", done: true }, { conversationId: "proof-focus", now: () => Date.parse(NOW) }, undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	assert.equal(loadContext(brainDir).tasks["proof-focus"].returned.report, "The targeted test passed.");
	assert.equal(loadContext(brainDir).tasks["proof-focus"].returned.proof, "npm test -- focused exits 0.");
	assert.equal(loadContext(brainDir).tasks["proof-focus"].returned.done, true);
});

test("book: flat plan, ledger, context recall, task report, and prompt contract", async (t) => {
	const { root, brainDir } = fresh(t);
	let messages = [];
	const engine = { messagesOf: () => messages, want: () => {}, callWords: () => "book" };
	const tool = bookTool({ root, brainDir, config: {}, engine, gate: { yolo: false } });
	let seq = 0;
	const api = () => ({ conversationId: ROOT_CONVERSATION_ID, taskId: `flat-${++seq}`, now: () => 1700000000000, executeTool: () => Promise.reject(new Error("unexpected nested tool")) });
	const run = (args) => tool.execute(tool.prepareArguments(args), api(), undefined);

	// Plan: flat envelope/move add, a reported move's acceptance, edit, remove, and clear.
	const p1 = await run({ target: "plan", action: "add", mode: "look", text: "Map the entry point." });
	assert.ok(!p1.isError && /p1 added as an authorization envelope/.test(p1.output[0].text), p1.output[0].text);
	const m1 = await run({ target: "plan", action: "addMove", parent: "p1", text: "Read src/index.mjs", done_when: "The entry point is named." });
	assert.ok(!m1.isError && /m1 added under p1/.test(m1.output[0].text), m1.output[0].text);
	const reportPlan = loadPlan(brainDir).plan;
	startMove(reportPlan, "m1", NOW);
	reportMove(reportPlan, "m1", 1, { done: true, report: "t-flat", proof: "src/index.mjs was read" }, NOW);
	savePlan(brainDir, reportPlan);
	const mDone = await run({ target: "plan", action: "acceptMove", id: "m1" });
	assert.ok(!mDone.isError && /m1 accepted\./.test(mDone.output[0].text), mDone.output[0].text);
	const pDone = await run({ target: "plan", action: "done", id: "p1", text: "Mapped src/index.js." });
	assert.ok(!pDone.isError && /p1 is done\./.test(pDone.output[0].text), pDone.output[0].text);
	const p2 = await run({ target: "plan", action: "add", mode: "change", text: "Fix the roller.", done_when: "The roller works.", before: "p1" });
	assert.ok(!p2.isError && /p2 added as an authorization envelope/.test(p2.output[0].text), p2.output[0].text);
	const pEdit = await run({ target: "plan", action: "edit", id: "p2", text: "Fix the dice roller." });
	assert.ok(!pEdit.isError, pEdit.output[0].text);
	const pRemove = await run({ target: "plan", action: "remove", id: "p2" });
	assert.ok(!pRemove.isError && /p2 removed/.test(pRemove.output[0].text), pRemove.output[0].text);
	await run({ target: "plan", action: "add", mode: "look", text: "Leftover envelope." });
	const cleared = await run({ target: "plan", action: "clear" });
	assert.ok(!cleared.isError && /The plan is empty now\./.test(cleared.output[0].text), cleared.output[0].text);
	assert.equal(loadPlan(brainDir).plan.items.length, 0);

	// Ledger: flat goal add, salient note add/edit, done, remove.
	const g1 = await run({ target: "ledger", action: "add", kind: "goal", text: "Clean schema", done_when: "npm test passes with flat book calls" });
	assert.ok(!g1.isError && /g1 added/.test(g1.output[0].text), g1.output[0].text);
	const n2 = await run({ target: "ledger", action: "add", kind: "note", text: "Use top-level id.", salient: true });
	assert.ok(!n2.isError && /n2 added/.test(n2.output[0].text), n2.output[0].text);
	const nEdit = await run({ target: "ledger", action: "edit", id: "n2", salient: false });
	assert.ok(!nEdit.isError, nEdit.output[0].text);
	const gDone = await run({ target: "ledger", action: "done", id: "g1", text: "All tests pass." });
	assert.ok(!gDone.isError && /g1 closed/.test(gDone.output[0].text), gDone.output[0].text);
	const nRemove = await run({ target: "ledger", action: "remove", id: "n2" });
	assert.ok(!nRemove.isError && /n2 removed/.test(nRemove.output[0].text), nRemove.output[0].text);

	// Context: fold by top-level `id`, dressMain notice, and `context recall` by top-level `id`.
	addRecord(brainDir, { id: "t1", at: 1700000000000, mode: "look", brief: "Inspect", report: `Detailed report body.\n\n${KEPT_AS("t1")}`, summary: "Inspected" });
	messages = [{ role: "toolResult", toolCallId: "tc1", toolName: "task", content: [{ type: "text", text: `Detailed report body.\n\n${KEPT_AS("t1")}` }] }];
	const folded = await run({ target: "context", action: "fold", id: "t1" });
	assert.ok(!folded.isError && /Dropped from view: t1/.test(folded.output[0].text), folded.output[0].text);
	const dressed = dressMain(messages, brainDir);
	assert.match(dressed[0].content[0].text, /target=context, action=recall/);
	const recalled = await run({ target: "context", action: "recall", id: "t1" });
	assert.ok(!recalled.isError && /Report t1 stands in its place again/.test(recalled.output[0].text), recalled.output[0].text);

	// Task tool no longer appends the unconditional "Internal checkpoint" prompt to task reports.
	const memos = new Map();
	const tTool = taskTool({ root, brainDir, config: { taskTurns: 4, maxTokens: 4096 } });
	const taskRes = await tTool.execute({ brief: "Read index", done_when: "The index entry point is reported." }, {
		conversationId: ROOT_CONVERSATION_ID,
		taskId: "task-run-1",
		callId: "call-1",
		now: () => 1700000000000,
		memo: async (k, v) => { if (v !== undefined) memos.set(k, v); return memos.get(k); },
		details: async () => {},
		commit: async (fn) => fn({
			scanConversations: async () => ({ items: [{ id: "focus-1", parent: { at: 1 } }] }),
			scanEntries: async () => ({ items: [{ conversationId: "focus-1", kind: "carto.brief", data: { mode: "look" } }] }),
		}),
		conversation: async () => ({
			submit: async () => ({
				wait: async () => {
					updateContext(brainDir, (store) => { taskState(store, "focus-1").returned = { report: "Clean task report.", done: true }; });
					return {};
				},
			}),
		}),
	}, undefined);
	assert.equal(taskRes.isError, undefined);
	assert.match(taskRes.output[0].text, /Clean task report\./);
	assert.doesNotMatch(taskRes.output[0].text, /Internal checkpoint/);

	// Prompts accurately reflect first-class `read` and `shelf` plus flat `book`, with no stale `<shelf-ask>`, `target=shelf`, or `file read` instructions.
	const fullPrompt = [
		systemPrompt({ root }),
		TOOLS.read,
		TOOLS.shelf,
		TOOLS.book,
		LOOK_NOTE,
		CHANGE_NOTE({ item: "p1", move: "m1", revision: 1, text: "Edit file", doneWhen: "The file is updated.", proof: "The focused check.", targets: ["src/file.mjs"] }, { commands: "sandbox", network: false }),
		HANDOFF_IN_TURN("test"),
		HANDOFF_NOTE("test"),
		TASK_HANDOFF,
	].join("\n");
	assert.doesNotMatch(fullPrompt, /operation\s*\{|operation\.text|placementId|in `operation`|target=shelf|target="shelf"|`file read`|target\s*=\s*"?file"?[^.\n]*action\s*=\s*"?read"?|Should I shelf|asked when I read|asked whether to shelf/);
	assert.match(TOOLS.read, /read batch/);
	assert.match(TOOLS.read, /next successful read batch replaces/);
	assert.match(TOOLS.read, /shared ledger, atlas or assessment/);
	assert.match(LOOK_NOTE, /retain lasting conclusions in the shared ledger, atlas or assessment/);
	assert.match(CHANGE_NOTE({ item: "p1", move: "m1", revision: 1, text: "Edit file", doneWhen: "The file is updated.", proof: "A check.", targets: ["src/file.mjs"] }), /keep lasting findings before return/);
	assert.doesNotMatch(TOOLS.read, /one `read` comes back per reply/);
	assert.match(TOOLS.shelf, /action/);
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
	assert.ok(coreOnly.includes(`written by ${USER_NAME}`));
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

// ─── Read batches: bounded transient groups, with legacy cleanup ────────────

import { beginReadBatch, readBatchAllowance, readBatchCheck, withoutShelfAsk } from "../src/read-batch.mjs";

const readCall = (path, id) => ({ type: "toolCall", id: id ?? `c-${path}`, name: "read", arguments: { path } });
const shelfCall = (path, id) => ({ type: "toolCall", id: id ?? `s-${path}`, name: "shelf", arguments: { action: "add", path } });

test("read batches: one reply admits a bounded group, splits the output allowance, and never gates shelf", () => {
	const id = "batch-first";
	const reads = Array.from({ length: POLICY.limits.look.readMaxFiles + 1 }, (_, index) => readCall(`file-${index + 1}.md`));
	const message = { role: "assistant", timestamp: 1, content: [reads[0], shelfCall("c.md"), reads[1], shelfCall("d.md"), ...reads.slice(2)] };
	beginReadBatch(id, message);
	for (const call of reads.slice(0, POLICY.limits.look.readMaxFiles)) assert.equal(readBatchCheck(id, call), undefined, `${call.arguments.path} runs in the batch`);
	assert.equal(readBatchCheck(id, shelfCall("c.md")), undefined, "shelf calls are never gated");
	assert.equal(readBatchCheck(id, shelfCall("d.md")), undefined, "multiple shelf calls in one reply all run");
	const refused = readBatchCheck(id, reads.at(-1));
	assert.match(refused, new RegExp(`read batch already has ${POLICY.limits.look.readMaxFiles} files`));
	assert.match(refused, /later read batch/);
	assert.equal(readBatchAllowance(id, reads[0].id), Math.floor(POLICY.limits.look.readTokenCeiling / POLICY.limits.look.readMaxFiles), "each permitted file gets its planned share of the batch budget");
	assert.equal(readBatchAllowance(id, reads.at(-1).id), undefined, "the refused file has no allowance");
	const three = [readCall("one.md", "batch-one"), readCall("two.md", "batch-two"), readCall("three.md", "batch-three")];
	beginReadBatch(id, { role: "assistant", timestamp: 2, content: three });
	const shares = three.map((call) => readBatchAllowance(id, call.id));
	assert.equal(shares.reduce((total, allowance) => total + allowance, 0), POLICY.limits.look.readTokenCeiling, "all planned shares add up to the one aggregate ceiling");
	assert.ok(shares[0] >= shares[1] && shares[1] >= shares[2] && shares[0] - shares[2] <= 1, "whole-token remainder goes to earlier calls in reply order");
	// A reply with no `read` clears the batch plan.
	beginReadBatch(id, { role: "assistant", timestamp: 3, content: [shelfCall("f.md")] });
	assert.equal(readBatchCheck(id, reads[0]), undefined);
	assert.equal(readBatchAllowance(id, reads[0].id), undefined);
});

test("read tool: a batch share is the actual returned ceiling", async (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(root, "long.txt"), Array.from({ length: 1_024 }, () => "x".repeat(100)).join("\n"));
	const id = "batch-ceiling";
	const first = readCall("long.txt", "batch-long-a");
	const second = readCall("other.txt", "batch-long-b");
	beginReadBatch(id, { role: "assistant", content: [first, second] });
	const reader = readTool({ root, brainDir });
	const result = await reader.execute(reader.prepareArguments(first.arguments), { conversationId: id, callId: first.id }, undefined);
	assert.equal(result.isError, undefined);
	assert.match(result.output[0].text, /share of this read batch/, "the result says why it stopped early");
	assert.match(result.output[0].text, /more lines; ask for range/, "and tells the next useful selection");
	const failed = await reader.execute(reader.prepareArguments(second.arguments), { conversationId: id, callId: second.id }, undefined);
	assert.equal(failed.isError, true, "an admitted missing file still fails inline");
	assert.equal(readBatchAllowance(id, first.id), POLICY.limits.look.readTokenCeiling / 2, "that failure does not redistribute the first call's planned share");
	assert.equal(readBatchAllowance(id, second.id), POLICY.limits.look.readTokenCeiling / 2, "or discard its own planned share");
	const legacy = bookTool({ root, brainDir, config: {}, engine: {}, gate: { yolo: false } });
	const replay = await legacy.execute({ target: "file", action: "read", path: "long.txt" }, { conversationId: id, callId: first.id }, undefined);
	assert.match(replay.output[0].text, /share of this read batch/, "a stored legacy book file read receives the same planned share");
});

test("engine: task read turnover drops only redundant task steps, never schedules a collapse", (t) => {
	const { root, brainDir } = fresh(t);
	const focus = "focus-read-turnover";
	const engine = createEngine({ root, brainDir, config: { contextWindow: 10_000, collapseFull: 80 } });
	engine.seen(focus, [
		{ role: "toolResult", content: [{ type: "text", text: TASK_HEADER }] },
		{ role: "assistant", content: [readCall("a.js", "old-read")] },
		{ role: "toolResult", toolCallId: "old-read", toolName: "read", content: [{ type: "text", text: "x".repeat(2_000) }] },
		{ role: "assistant", content: [readCall("a.js", "new-read")] },
	]);
	assert.deepEqual(engine.afterTaskRead(focus, { path: "a.js" }), ["s1"], "the older same-file task step is the only change");
	assert.equal(engine.due(), undefined, "a read turnover does not schedule the main-context collapse");
	const task = loadContext(brainDir).tasks[focus];
	assert.equal(task.cut, undefined, "and it does not write a task collapse block");
	assert.equal(task.dropped.s1, "An earlier read of the same lines stood here; the newer one is further down.");
});

test("engine: a sent provider request is an immutable snapshot with separate provider usage", (t) => {
	const { root, brainDir } = fresh(t);
	const engine = createEngine({ root, brainDir, config: { contextWindow: 10_000, collapseFull: 80 } });
	const focus = "focus-snapshot";
	const payload = { model: "qwen", stream: true, messages: [{ role: "user", content: "first words" }], tools: [{ type: "function", function: { name: "read" } }] };
	const plan = { messages: [{ role: "user", content: [{ type: "text", text: "first words" }] }], parts: [{ id: "part:focus-snapshot:message:0", kind: "active-message", source: "durable:focus-snapshot:42", lifecycle: "planned" }] };
	engine.planned(focus, plan);
	engine.sending(focus, payload, { provider: "local", api: "openai-completions", id: "qwen" });
	payload.messages[0].content = "changed after dispatch";
	plan.parts[0].source = "changed after dispatch";
	payload.tools[0].function.name = "changed";
	engine.replied(focus, { role: "assistant", content: [{ type: "text", text: "reply" }], usage: { input: 10, cacheRead: 7, output: 3 } });

	const first = engine.window("newest");
	assert.equal(first.requestId, `${focus}:1`);
	assert.equal(first.payload.messages[0].content, "first words", "the body was copied before outside code could mutate it");
	assert.equal(first.payload.tools[0].function.name, "read");
	assert.equal(first.payloadHash?.length, 16, "the frozen JSON has a short comparison hash");
	assert.deepEqual(first.model, { provider: "local", api: "openai-completions", id: "qwen" });
	assert.equal(first.plan.parts[0].source, "durable:focus-snapshot:42", "the pre-formatting plan and its source fact freeze with the provider body");
	assert.deepEqual(first.usage, { input: 10, cacheRead: 7, output: 3 }, "provider fields stay separate from the old collapse accounting total");
	assert.equal(first.used, 20, "the existing total keeps its old collapse meaning");
	first.payload.messages[0].content = "a screen cannot mutate the snapshot";
	first.reply.content[0].text = "a screen cannot mutate the reply";
	const again = engine.window("newest");
	assert.equal(again.payload.messages[0].content, "first words", "window callers get copies too");
	assert.equal(again.reply.content[0].text, "reply");
});

test("legacy `<shelf-ask>` blocks in older stored transcripts are stripped cleanly", () => {
	const legacy = "file body\n\n<shelf-ask>\nShould I shelf index.html? Yes or no.\n</shelf-ask>\n";
	assert.equal(withoutShelfAsk(legacy), "file body");
	assert.equal(withoutAdditions(legacy), "file body");
});

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
	assert.match(thread, /^st\d+$/, "a fresh story mints the short thread marker, like every other id");
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

test("consult: fresh stories mint short thread markers from the folder, and legacy markers stay valid", async (t) => {
	const { root, brainDir } = fresh(t);
	let n = 0;
	const fetchImpl = async () => { n += 1; return okAnswer(`Answer ${n}.`); };
	const tool = consultTool({ root, brainDir, config: consultConfig, fetchImpl });
	// Two new stories in a fresh brain: st1, then st2.
	const first = await tool.execute({ question: "q1" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	const second = await tool.execute({ question: "q2" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(first.details.thread, "st1");
	assert.equal(second.details.thread, "st2");
	// A follow-up to the legacy story minted before the short markers: the marker stays as it was.
	const legacy = "st-20261115-143022-k7q2";
	mkdirSync(join(brainDir, "storyteller"), { recursive: true });
	writeFileSync(join(brainDir, "storyteller", `${legacy}.md`), "<!-- storyteller v1 -->\nThe storyteller — one long problem, kept whole\n\nModel: MythosNano\nStarted: 2026-11-15T14:30:22.000Z\n\n## Round 1 — 2026-11-15T14:30:22.000Z\n\nQuestion:\n```text\nlegacy question?\n```\n\nAnswer:\n```text\nlegacy answer.\n```\n");
	const third = await tool.execute({ question: "and then?", thread: legacy }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(third.isError, undefined, third.output[0].text);
	assert.equal(third.details.thread, legacy, "a legacy thread keeps its marker");
	// The next fresh story after legacy files still mints the short form from the short ids in the folder — st3.
	const fourth = await tool.execute({ question: "q4" }, consultApi(ROOT_CONVERSATION_ID), undefined);
	assert.equal(fourth.details.thread, "st3");
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
