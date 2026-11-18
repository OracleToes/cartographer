// Fast, self-contained unit checks. No model server, no terminal, no sandbox:
// temp brain directories and direct calls to the operations. Runs in seconds.
// Run with: npm test
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { contextWindowLimits, loadConfig, modelContextWindow, POLICY } from "../src/config.mjs";
import { UI_ERROR_CODE, UI_ERROR_KIND } from "../src/application/contracts.mjs";
import { TALK_ACTION, createTalkApplication } from "../src/application/talk.mjs";
import { WORKSPACE_ACTION, createWorkspaceApplication } from "../src/application/workspace.mjs";
import { applyOp, loadLedger, saveLedger } from "../src/ledger.mjs";
import { applyPlanOp, approve, findMove, liveMove, loadPlan, mayRun, PlanError, reportMove, savePlan, startMove, undoMove } from "../src/plan.mjs";
import { activeMoveOverlays, applyAtlasOp, attentionSnapshot, fileMarks, loadAtlas, observeAtlas, renderAttention, saveAtlas } from "../src/atlas.mjs";
import { createRefDescriber } from "../src/refs.mjs";
import { archiveRow, dropRow, settleRow, unarchiveRow, applyAdd, addTemplate, editRow } from "../src/ops.mjs";
import { ignoredLine, shellTool } from "../src/tools/shell.mjs";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { startStandIn } from "./stand-in.mjs";
import { observeFile, loadCatalog, saveCatalog } from "../src/catalog.mjs";
import { loadPrepend } from "../src/prepend.mjs";
import { shelfItem, updateContext, loadContext, taskState, noteChat, writeFront, chatLine, addRecord, bindTalkSource, dressMain, KEPT_AS, recordSoftForgetPending, removeTalkSource, reviseTalkSource } from "../src/context.mjs";
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
import { changeTools, changedSurface, writeOne } from "../src/tools/change.mjs";
import { consultTool } from "../src/tools/consult.mjs";
import { createConferenceExtension } from "../src/conference-extension.mjs";
import { ConferenceError, attachChildConference, completeConference, conferenceStatusLine, createConferenceCapture, debateStatus, enumGrammar, loadConference, participantTail, readConferenceSource, recordParticipantActivity, recordParticipantTurn, recordRequestPlan, recordSelectorChoice, recordToolReceipt, renderConference, restrictParticipantPayload, selectorGrammar, selectorMessages, selectorOptions, selectorTail, validateConsultReturn, withConferenceBrain } from "../src/conference.mjs";
import { chooseNativeGrammar, nativeLiteralGrammar, probeNativeGrammarCapability } from "../src/native-grammar.mjs";
import { dressRequest, planRequest, withoutAdditions } from "../src/request.mjs";
import { activeContextProjection, bridgeRequestSources } from "../src/request-sources.mjs";
import { createEngine } from "../src/engine.mjs";
import { openSession, runFromBrief } from "../src/harness.mjs";
import { TOOLS, TASK_HEADER, TASK_HANDOFF, LOOK_NOTE, CHANGE_NOTE, HANDOFF_IN_TURN, HANDOFF_NOTE, systemPrompt } from "../src/prompt.mjs";
import { assessmentPath } from "../src/assessment.mjs";
import { topPath } from "../src/top.mjs";
import { traceFile, watchTrace } from "../src/trace.mjs";
import { USER_NAME } from "../src/user.mjs";
import { RECORD } from "../src/voice.mjs";
import { applyStagePromotion, collectStageCandidate, createStage, disposeStage, prepareStagePromotion, StageError } from "../src/stage.mjs";
import { createRunner, sandboxArgs, STAGE_WORK_DIR } from "../src/sandbox.mjs";
import { createChat } from "../src/screen/chat.mjs";
import { inventoryLegacyProducts, LegacyCutoverBlockedError, migrateLegacyProducts } from "../src/legacy-cutover.mjs";
import { llamaCppSelectorProbePayload, runLlamaCppSelectorProbe, selectorProbeLogPath, writeSelectorProbeLog } from "../src/consult-probe.mjs";

const fresh = (t) => {
	const root = mkdtempSync(join(tmpdir(), "carto-test-"));
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, brainDir };
};
const NOW = "2026-11-15T00:00:00.000Z";
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
test("prompt: the sleep checklist names the person whose message may be waiting", () => {
	const prompt = systemPrompt({ root: "/project" });
	assert.ok(prompt.includes(`no message from ${USER_NAME} waiting`));
	assert.ok(!prompt.includes("no user message waiting"));
	assert.ok(TOOLS.sleep.includes(`${USER_NAME} speaks`));
});

test("C5: the only consult contract is same-model conference, and obsolete thread/config inputs are refused", async (t) => {
	const { root, brainDir } = fresh(t);
	const prompt = systemPrompt({ root });
	assert.equal(Object.hasOwn(TOOLS, "case"), false, "the retired Case tool is absent from the prompt registry");
	assert.doesNotMatch(prompt, /evidence case|\bcase tool\b/i, "the active system prompt does not advertise a Case product");
	assert.match(TOOLS.consult, /current resolved model/i);
	assert.match(TOOLS.consult, /There is no `thread` follow-up/i);
	const consult = consultTool({ root, brainDir });
	const rejected = await consult.execute({ question: "Can an old transcript continue?", myPersona: "Audit the migration boundary.", thread: "st1" }, {}, undefined);
	assert.equal(rejected.isError, true);
	assert.match(rejected.output[0].text, /thread.*removed by the C5 cutover/i);
	for (const retired of ["consultModel", "consultMaxTokens", "consultTemperature", "consultTimeoutSeconds"]) {
		writeFileSync(join(brainDir, "config.json"), JSON.stringify({ [retired]: retired === "consultModel" ? "" : 1 }));
		assert.throws(() => loadConfig({ brainDir, flags: {}, env: { CARTO_CONFIG: join(root, "no-core-config.json"), CARTO_SERVER: "http://example.test/v1", CARTO_MODEL: "model" } }), new RegExp(`Removed external-consult setting\\(s\\): .*${retired}`));
	}
	writeFileSync(join(brainDir, "config.json"), JSON.stringify({ consultGrammar: "openai" }));
	assert.throws(() => loadConfig({ brainDir, flags: {}, env: { CARTO_CONFIG: join(root, "no-core-config.json"), CARTO_SERVER: "http://example.test/v1", CARTO_MODEL: "model" } }), /Removed native-grammar compatibility setting\(s\): .*consultGrammar/);
	writeFileSync(join(brainDir, "config.json"), "{}");
	assert.throws(() => loadConfig({ brainDir, flags: {}, env: { CARTO_CONFIG: join(root, "no-core-config.json"), CARTO_SERVER: "http://example.test/v1", CARTO_MODEL: "model", CARTO_CONSULT_MODEL: "" } }), /CARTO_CONSULT_MODEL was removed/i);
});

test("native llama.cpp selector probe uses no tools, records raw evidence, and fails closed when grammar is ignored", async (t) => {
	const { root, brainDir } = fresh(t);
	const calls = [];
	const allowedFetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		calls.push(request);
		const output = /"([^"\\]+)"/.exec(request.grammar)?.[1];
		return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: output }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
	};
	const record = await runLlamaCppSelectorProbe({ server: "http://selector.test/v1", modelId: "qwen-test", fetchImpl: allowedFetch, now: () => Date.parse(NOW) });
	assert.equal(record.passed, true);
	assert.equal(calls.length, 2, "the forced literal and finite-route checks are separate no-tool requests");
	for (const request of calls) {
		assert.equal(request.tools, undefined, "native grammar routing does not mix grammar with tools");
		assert.equal(request.tool_choice, undefined);
		assert.match(request.grammar, /^root ::= /);
		assert.equal(request.chat_template_kwargs.enable_thinking, false);
	}
	assert.deepEqual(record.cases.map((entry) => entry.output), ["cartographer", "atlas"]);
	const explicit = selectorProbeLogPath({ root, brainDir, path: "evidence/selector-probe.json", at: Date.parse(NOW) });
	writeSelectorProbeLog(explicit, record);
	assert.deepEqual(JSON.parse(readFileSync(explicit, "utf8")), record, "the shareable log preserves raw synthetic requests and responses exactly");
	assert.throws(() => selectorProbeLogPath({ root, brainDir, path: "../outside.json" }), /stay inside the project/i);
	assert.throws(() => selectorProbeLogPath({ root, brainDir, path: "/tmp/outside.json" }), /relative to the project/i);
	assert.throws(() => selectorProbeLogPath({ root, brainDir, path: "evidence/selector-probe.txt" }), /end in .json/i);
	assert.throws(() => selectorProbeLogPath({ root, brainDir, path: "evidence/selector-probe.json" }), /already exists/i);

	const ignored = await runLlamaCppSelectorProbe({
		server: "http://selector.test/v1",
		modelId: "qwen-test",
		fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "outside-the-allowed-selector-set" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } }),
		now: () => Date.parse(NOW),
	});
	assert.equal(ignored.passed, false, "prompt obedience alone cannot make an ignored grammar look like a valid selector");
	assert.equal(ignored.cases[0].passed, false);
	assert.equal(ignored.cases[1].skipped, true, "the multi-choice request is not sent after enforcement has already failed");
	assert.match(ignored.cases[0].reason, /outside the grammar/i);
	assert.deepEqual(llamaCppSelectorProbePayload({ modelId: "qwen-test", ids: ["atlas"], instruction: "Choose atlas." }).grammar, 'root ::= "atlas"');
});

test("C5: stopped legacy data is byte-archived, shelf snapshots become inert, and exports recover", (t) => {
	const { brainDir } = fresh(t);
	const storyteller = join(brainDir, "storyteller");
	const cases = join(brainDir, "cases");
	mkdirSync(storyteller, { recursive: true });
	mkdirSync(cases, { recursive: true });
	const transcript = "<!-- storyteller v1 -->\nlegacy bytes stay exact\n";
	const stoppedCase = `${JSON.stringify({ id: "c1", status: "stopped", note: "explicitly stopped before C5" }, null, "\t")}\n`;
	writeFileSync(join(storyteller, "st1.md"), transcript);
	writeFileSync(join(cases, "c1.json"), stoppedCase);
	const originalContext = `${JSON.stringify({
		version: 1,
		shelf: [{ id: "sh1", ref: { type: "story", id: "st1" }, path: "story:st1" }],
		front: { shelf: [{ id: "sh1", target: { kind: "story", id: "st1" }, path: "story:st1" }] },
		tasks: { oldCase: { caseId: "c1", phase: "construct", shelf: [] }, ordinary: { mode: "look", shelf: [] } },
	}, null, "\t")}\n`;
	writeFileSync(join(brainDir, "carto-context.json"), originalContext);

	const inventory = inventoryLegacyProducts(brainDir);
	assert.deepEqual(inventory.active, [], "a stopped Case task is retired, not treated as resumable");
	const migrated = migrateLegacyProducts(brainDir, { at: Date.UTC(2026, 10, 17) });
	assert.equal(migrated.migrated, true);
	assert.equal(existsSync(storyteller), false);
	assert.equal(existsSync(cases), false);
	const rawStory = join(brainDir, "legacy", "raw", "storyteller", "st1.md");
	const rawCase = join(brainDir, "legacy", "raw", "cases", "c1.json");
	const rawContext = join(brainDir, "legacy", "raw", "context", "carto-context.json");
	assert.equal(readFileSync(rawStory, "utf8"), transcript);
	assert.equal(readFileSync(rawCase, "utf8"), stoppedCase);
	assert.equal(readFileSync(rawContext, "utf8"), originalContext, "the pre-migration context bytes are retained before its pointers are rewritten");
	const manifest = JSON.parse(readFileSync(join(brainDir, "legacy", "cutover-v1.json"), "utf8"));
	assert.equal(manifest.state, "completed");
	assert.match(manifest.storyteller[0].digest, /^[a-f0-9]{64}$/);
	assert.match(manifest.cases[0].digest, /^[a-f0-9]{64}$/);
	assert.match(manifest.context.digest, /^[a-f0-9]{64}$/);
	assert.match(readFileSync(join(brainDir, "legacy", "exports", "storyteller", "st1.md"), "utf8"), /static C5 archive export/);
	assert.match(readFileSync(join(brainDir, "legacy", "exports", "cases", "c1.md"), "utf8"), /explicitly stopped before C5/);
	assert.match(readFileSync(join(brainDir, "legacy", "exports", "context", "carto-context.json.md"), "utf8"), /oldCase/);
	const context = JSON.parse(readFileSync(join(brainDir, "carto-context.json"), "utf8"));
	assert.equal(context.tasks.oldCase, undefined, "retired Case task metadata is removed from live context");
	assert.ok(context.tasks.ordinary, "ordinary task state is retained");
	for (const item of [context.shelf[0], context.front.shelf[0]]) {
		assert.equal(item.ref, undefined);
		assert.equal(item.target, undefined);
		assert.equal(item.legacyArchive.kind, "storyteller");
		assert.match(item.snapshot, /immutable C5 migration snapshot/);
	}
	const exportFile = join(brainDir, "legacy", "exports", "storyteller", "st1.md");
	rmSync(exportFile);
	assert.equal(migrateLegacyProducts(brainDir).migrated, true, "a missing static export is recreated from retained exact bytes");
	assert.equal(existsSync(exportFile), true);
	assert.equal(migrateLegacyProducts(brainDir).migrated, false, "a completed intact archive is a no-op");
});

test("C5: active, unreadable, or malformed legacy Cases block cutover without an override", (t) => {
	const { brainDir } = fresh(t);
	const cases = join(brainDir, "cases");
	mkdirSync(cases, { recursive: true });
	writeFileSync(join(cases, "c7.json"), JSON.stringify({ id: "c7", status: "running" }));
	writeFileSync(join(brainDir, "carto-context.json"), JSON.stringify({ tasks: { phase: { caseId: "c7", phase: "construct" } } }));
	let inventory = inventoryLegacyProducts(brainDir);
	assert.deepEqual(inventory.active.map((entry) => entry.id), ["c7"], "the record and task metadata produce one blocker, not duplicates");
	assert.throws(() => migrateLegacyProducts(brainDir), (error) => error instanceof LegacyCutoverBlockedError && /explicitly stop each Case/i.test(error.message));
	assert.equal(existsSync(join(cases, "c7.json")), true, "blocked cutover leaves the source record in place");

	rmSync(join(cases, "c7.json"));
	writeFileSync(join(brainDir, "carto-context.json"), JSON.stringify({ tasks: {} }));
	writeFileSync(join(cases, "c8.json"), "{ not valid JSON");
	inventory = inventoryLegacyProducts(brainDir);
	assert.deepEqual(inventory.active.map((entry) => [entry.id, entry.status]), [["c8", "unreadable"]], "unreadable bytes are treated as potentially resumable");
	assert.throws(() => migrateLegacyProducts(brainDir), LegacyCutoverBlockedError);

	writeFileSync(join(cases, "c8.json"), JSON.stringify({ id: "c99", status: "stopped" }));
	inventory = inventoryLegacyProducts(brainDir);
	assert.deepEqual(inventory.active.map((entry) => [entry.id, entry.status]), [["c8", "malformed"]], "a mismatched stopped envelope cannot evade the blocker");
	assert.throws(() => migrateLegacyProducts(brainDir), LegacyCutoverBlockedError);
	assert.equal(existsSync(join(cases, "c8.json")), true, "malformed source bytes remain untouched while cutover is blocked");
});

test("harness: a cached inspect brief restores its look contract", () => {
	assert.deepEqual(runFromBrief({ mode: "look", move: "m2", revision: 3, targets: ["src/index.mjs"], turns: 2 }), {
		mode: "look", move: "m2", revision: 3, targets: ["src/index.mjs"], turns: 2,
	});
	assert.deepEqual(runFromBrief({ mode: "change", network: false, move: "m3", revision: 4 }), { mode: "change", move: "m3", revision: 4 }, "only an explicit true carries network");
	assert.deepEqual(runFromBrief({ mode: "look", turns: 3, caseId: "c1", phase: "falsify" }), { mode: "look", turns: 3 }, "retired Case metadata cannot revive a legacy phase route");
	assert.deepEqual(runFromBrief({ mode: "unknown", network: true, move: "m4" }), { mode: "look" }, "a malformed stored brief fails closed to inspect");
});

test("context window: a reported capacity is the whole active context without a reply reserve", () => {
	assert.deepEqual(contextWindowLimits(100_000, 75_000), {
		configuredContextWindow: 100_000,
		usableContextWindow: 75_000,
		serverContextWindow: 75_000,
	});
	assert.deepEqual(contextWindowLimits(40_000, 75_000), {
		configuredContextWindow: 40_000,
		usableContextWindow: 40_000,
		serverContextWindow: 75_000,
	}, "metadata never raises the configured cap");
	assert.deepEqual(contextWindowLimits(100_000, 8_192), {
		configuredContextWindow: 100_000,
		usableContextWindow: 8_192,
		serverContextWindow: 8_192,
	}, "a small server exposes its full advertised window to the collapse engine");
	assert.deepEqual(contextWindowLimits(100_000, undefined), {
		configuredContextWindow: 100_000,
		usableContextWindow: 100_000,
	}, "without server metadata, the configured cap remains in force");
});

test("application: workspace actions expose typed outcomes, cancellation, and destructive confirmation", async (t) => {
	const { root, brainDir } = fresh(t);
	const app = createWorkspaceApplication({ brainDir, root, now: () => Date.parse(NOW) });
	const invalid = await app.execute(WORKSPACE_ACTION.add, { book: "unknown", text: "{}" }, { requestId: "invalid-add" });
	assert.equal(invalid.ok, false);
	if (invalid.ok) throw new Error("an invalid book must not add a row");
	assert.equal(invalid.error.code, UI_ERROR_CODE.invalidInput);
	assert.equal(invalid.error.kind, UI_ERROR_KIND.validation);
	assert.equal(invalid.error.field, "book");
	assert.equal(invalid.meta.requestId, "invalid-add");
	assert.equal(invalid.meta.at, NOW);

	const added = await app.execute(WORKSPACE_ACTION.add, {
		book: "ledger",
		text: JSON.stringify({ kind: "note", text: "Move UI actions behind the application boundary", salient: false, done_when: "" }),
	});
	assert.equal(added.ok, true);
	if (!added.ok) throw new Error(added.error.message);
	assert.equal(added.data.action, WORKSPACE_ACTION.add);
	assert.equal(added.notices[0].level, "success");
	const incompleteMove = await app.execute(WORKSPACE_ACTION.addMove, { parent: "p1", text: "Read the entry point." });
	assert.equal(incompleteMove.ok, false);
	if (incompleteMove.ok) throw new Error("a move without done-when text must be refused before the plan operation");
	assert.equal(incompleteMove.error.code, UI_ERROR_CODE.invalidInput);
	assert.equal(incompleteMove.error.field, "doneWhen");
	const envelope = await app.execute(WORKSPACE_ACTION.add, {
		book: "plan",
		text: JSON.stringify({ mode: "look", text: "Inspect the entry point.", done_when: "The entry point is identified." }),
	});
	assert.equal(envelope.ok, true);
	if (!envelope.ok) throw new Error(envelope.error.message);
	const moved = await app.execute(WORKSPACE_ACTION.addMove, {
		parent: "p1",
		text: "Read src/index.mjs.",
		doneWhen: "The entry point is identified.",
	});
	assert.equal(moved.ok, true);
	if (!moved.ok) throw new Error(moved.error.message);
	assert.equal(moved.data.action, WORKSPACE_ACTION.addMove);
	assert.equal(loadPlan(brainDir).plan.moves[0]?.parent, "p1", "a typed plan-move action uses the durable plan operation");
	const missingShelfPath = await app.execute(WORKSPACE_ACTION.shelve, { path: "   " });
	assert.equal(missingShelfPath.ok, false);
	if (missingShelfPath.ok) throw new Error("a shelf action without a target must be refused before the context mutation");
	assert.equal(missingShelfPath.error.code, UI_ERROR_CODE.invalidInput);
	assert.equal(missingShelfPath.error.field, "path");
	writeFileSync(join(root, "shelf.txt"), "first\nsecond\n");
	const shelved = await app.execute(WORKSPACE_ACTION.shelve, { path: "shelf.txt", lines: "1-1" });
	assert.equal(shelved.ok, true);
	if (!shelved.ok) throw new Error(shelved.error.message);
	assert.equal(shelved.data.action, WORKSPACE_ACTION.shelve);
	const shelf = loadContext(brainDir).shelf[0];
	assert.equal(shelf?.path, "shelf.txt", "the typed shelf action owns the context placement");
	assert.ok(shelf?.id, "the typed shelf action allocates a durable placement id");
	const unshelved = await app.execute(WORKSPACE_ACTION.unshelve, { id: shelf.id });
	assert.equal(unshelved.ok, true);
	assert.equal(loadContext(brainDir).shelf.length, 0, "the existing unshelve action clears the placement through the same facade");
	const entry = loadLedger(brainDir).ledger.items[0];
	assert.ok(entry, "the successful result comes from the same durable row operation the terminal already uses");
	const cannotFold = await app.execute(WORKSPACE_ACTION.toggleFold, { id: entry.id });
	assert.equal(cannotFold.ok, false);
	if (cannotFold.ok) throw new Error("a ledger entry cannot be folded as a report");
	assert.equal(cannotFold.error.code, UI_ERROR_CODE.actionRefused);
	assert.equal(cannotFold.error.kind, UI_ERROR_KIND.validation);

	const cancelledController = new AbortController();
	cancelledController.abort();
	const cancelled = await app.execute(WORKSPACE_ACTION.archive, { id: entry.id }, { signal: cancelledController.signal });
	assert.equal(cancelled.ok, false);
	if (cancelled.ok) throw new Error("an aborted action must not run");
	assert.equal(cancelled.error.code, UI_ERROR_CODE.cancelled);
	assert.equal(loadLedger(brainDir).ledger.items[0].archived, undefined, "cancellation occurs before the legacy mutation seam");

	const missing = await app.execute(WORKSPACE_ACTION.archive, { id: "g999" });
	assert.equal(missing.ok, false);
	if (missing.ok) throw new Error("a missing row must be a typed failure");
	assert.equal(missing.error.code, UI_ERROR_CODE.notFound);
	assert.equal(missing.error.kind, UI_ERROR_KIND.notFound);

	const asked = await app.execute(WORKSPACE_ACTION.delete, { id: entry.id });
	assert.equal(asked.ok, false);
	if (asked.ok) throw new Error("delete needs confirmation");
	assert.equal(asked.error.code, UI_ERROR_CODE.confirmationRequired);
	assert.deepEqual(asked.confirmation, {
		actionId: WORKSPACE_ACTION.delete,
		target: entry.id,
		summary: `Delete ${entry.id} permanently. This cannot be undone.`,
		strength: "acknowledge",
	});
	assert.ok(loadLedger(brainDir).ledger.items.some((item) => item.id === entry.id), "a confirmation request does not mutate durable state");

	const deleted = await app.execute(WORKSPACE_ACTION.delete, { id: entry.id }, {
		confirmation: { actionId: WORKSPACE_ACTION.delete, target: entry.id, acknowledged: true },
	});
	assert.equal(deleted.ok, true);
	assert.equal(loadLedger(brainDir).ledger.items.some((item) => item.id === entry.id), false);
	const deleteCapability = app.capabilities.list().find((capability) => capability.id === WORKSPACE_ACTION.delete);
	assert.deepEqual(deleteCapability?.availability, { enabled: true });
	assert.equal(deleteCapability?.confirmation, "acknowledge");
	const shelfCapability = app.capabilities.list().find((capability) => capability.id === WORKSPACE_ACTION.shelve);
	assert.deepEqual(shelfCapability?.availability, { enabled: true });
	assert.equal(shelfCapability?.intent, "mutate");
});

test("application: kept-talk actions preserve the durable transcript boundary and require confirmation to forget", async (t) => {
	const { brainDir } = fresh(t);
	const app = createTalkApplication({ brainDir, now: () => Date.parse(NOW) });
	const source = { kind: "chat-call", conversationId: "root", callId: "call-1" };
	noteChat(brainDir, "user", Date.parse(NOW), "Keep this wording for a future collapse.", { source });
	const invalid = await app.execute(TALK_ACTION.revise, { source, text: "   " });
	assert.equal(invalid.ok, false);
	if (invalid.ok) throw new Error("empty kept talk must be refused");
	assert.equal(invalid.error.code, UI_ERROR_CODE.invalidInput);
	assert.equal(invalid.error.field, "text");
	const revised = await app.execute(TALK_ACTION.revise, { source, text: "Keep the corrected wording for a future collapse." });
	assert.equal(revised.ok, true);
	if (!revised.ok) throw new Error(revised.error.message);
	assert.equal(loadContext(brainDir).chat[0]?.text, "Keep the corrected wording for a future collapse.");
	const asked = await app.execute(TALK_ACTION.forget, { source });
	assert.equal(asked.ok, false);
	if (asked.ok) throw new Error("forgetting kept talk needs confirmation");
	assert.equal(asked.error.code, UI_ERROR_CODE.confirmationRequired);
	assert.ok(asked.confirmation, "the action gives the screen a scoped acknowledgement request");
	assert.equal(loadContext(brainDir).chat.length, 1, "asking for confirmation does not alter the kept talk");
	const forgotten = await app.execute(TALK_ACTION.forget, { source }, { confirmation: { ...asked.confirmation, acknowledged: true } });
	assert.equal(forgotten.ok, true);
	assert.equal(loadContext(brainDir).chat.length, 0, "only the acknowledged action removes the future-collapse source");
	const forgetCapability = app.capabilities.list().find((capability) => capability.id === TALK_ACTION.forget);
	assert.equal(forgetCapability?.confirmation, "acknowledge");
});

test("model listing: llama-swap context_length wins over legacy metadata", () => {
	assert.equal(modelContextWindow({ context_length: 64_000, context_window: 64_000, meta: { n_ctx: 100_000 } }), 64_000);
	assert.equal(modelContextWindow({ context_window: 65_536 }), 65_536, "the OpenAI-gateway mirror is accepted when context_length is absent");
	assert.equal(modelContextWindow({ meta: { n_ctx: 32_768, n_ctx_train: 131_072 } }), 32_768, "legacy llama.cpp n_ctx is runtime capacity, unlike n_ctx_train");
	assert.equal(modelContextWindow({ context_length: 0, meta: { n_ctx: "64k" } }), undefined, "only a positive integer is trustworthy server capacity");
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
	assert.match(settleRow(brainDir, "m1", null), /needs an acceptance review/);
	assert.match(settleRow(brainDir, "m1", null, "The recorded source read identifies the entry point required by this move."), /m1 accepted\./);
	assert.equal(loadPlan(brainDir).plan.moves[0].acceptedReview, "The recorded source read identifies the entry point required by this move.");
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
	assert.throws(() => applyPlanOp(plan, { action: "acceptMove", id: "m1" }, NOW), /`review`/);
	assert.doesNotThrow(() => applyPlanOp(plan, { action: "acceptMove", id: "m1", review: "The focused test output witnesses that the export changed." }, NOW));
	assert.equal(plan.moves[0].acceptedReview, "The focused test output witnesses that the export changed.");
	assert.throws(() => applyPlanOp(plan, { action: "done", id: "p1" }, NOW), /still has m2 \(open\)/);
	startMove(plan, "m2", NOW);
	reportMove(plan, "m2", 1, { done: true, report: "t2", checkpoints: { before: "c2", after: "c3" }, changes: [{ path: "src/two.mjs" }], proof: "second test output" }, NOW);
	applyPlanOp(plan, { action: "acceptMove", id: "m2", review: "The second test output witnesses that the check passed." }, NOW);
	assert.doesNotThrow(() => applyPlanOp(plan, { action: "done", id: "p1" }, NOW));
	undoMove(plan, "m1", NOW);
	assert.equal(plan.moves[0].status, "open");
	assert.equal(plan.moves[0].approvedRevision, undefined);
	assert.equal(plan.items[0].status, "open");
	assert.equal(plan.items[0].closed, undefined);
	assert.equal(plan.moves[1].status, "blocked", "a later accepted sibling is stale after an earlier undo");
});

test("plan: a recorded closure gap blocks a completion claim and survives a hand-edited reported state", (t) => {
	const { plan } = loadPlan(fresh(t).brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Show the simulation.", done_when: "The browser visibly runs it." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Create js/main.js", done_when: "The browser loads the simulation.", targets: ["js/main.js"], proof: "Browser observation shows the running simulation." }, NOW);
	approve(plan, NOW, ["m1"]);
	startMove(plan, "m1", NOW);
	reportMove(plan, "m1", 1, {
		done: true,
		report: "t1",
		checkpoints: { before: "c1", after: "c2" },
		changes: [{ path: "js/main.js" }],
		proof: "node --check js/main.js exits zero.",
		closureGap: "index.html must load js/main.js before the browser witness is reachable.",
	}, NOW);
	assert.equal(plan.moves[0].status, "blocked");
	assert.equal(plan.moves[0].reported.claimed, false);
	assert.match(plan.moves[0].blocked, /Closure gap: index\.html/);
	assert.equal(plan.moves[0].reported.closureGap, "index.html must load js/main.js before the browser witness is reachable.");
	plan.moves[0].status = "reported";
	plan.moves[0].reported.claimed = true;
	assert.throws(() => applyPlanOp(plan, { action: "acceptMove", id: "m1", review: "A syntax check proves the browser runs it." }, NOW), /reported a closure gap/);
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

test("atlas attention: focus, one-hop heat, gaps, decay and archive candidates stay separate from map truth", (t) => {
	const { brainDir, root } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "entry.mjs"), "export const entry = 1;\n");
	writeFileSync(join(root, "src", "nearby.mjs"), "export const nearby = 1;\n");
	writeFileSync(join(root, "src", "unmapped.mjs"), "export const unmapped = 1;\n");
	const { atlas } = loadAtlas(brainDir);
	const who = { root, now: NOW, by: POLICY.enums.atlasAuthors.main, main: true, files: () => ["src/entry.mjs", "src/nearby.mjs", "src/unmapped.mjs"] };
	applyAtlasOp(atlas, { action: "add", name: "entry", gist: "The entry path.", files: ["src/entry.mjs"], links: ["nearby"] }, who);
	applyAtlasOp(atlas, { action: "add", name: "nearby", gist: "The direct neighbour.", files: ["src/nearby.mjs"] }, who);
	applyAtlasOp(atlas, { action: "add", name: "orphan", gist: "A leaf no one uses." }, who);
	const entry = atlas.nodes.find((node) => node.name === "entry");
	applyAtlasOp(atlas, { action: "focus", path: "src/entry.mjs", reason: "Start at the file boundary." }, who);
	const focused = applyAtlasOp(atlas, { action: "focus", name: entry.id, reason: "Trace request delivery." }, who);
	assert.match(focused.line, /Focus changed from src\/entry\.mjs to c1 entry/, "a replacement is explicit rather than silently inferred from work");
	observeAtlas(atlas, [{ kind: "read", paths: ["src/entry.mjs", "src/unmapped.mjs"] }], { at: NOW });
	const active = activeMoveOverlays({ moves: [
		{ id: "m1", status: POLICY.enums.moveStatus.running, targets: ["src/entry.mjs"] },
		{ id: "m2", status: POLICY.enums.moveStatus.open, targets: ["src/nearby.mjs"] },
	] });
	assert.deepEqual(active, [{ kind: "move", paths: ["src/entry.mjs"], label: "m1 targets src/entry.mjs" }], "only a running declared move becomes a temporary overlay");
	let snapshot = attentionSnapshot(root, atlas, { active });
	assert.equal(snapshot.focus.label, "entry");
	assert.deepEqual(snapshot.hot.map((entry) => entry.node.name), ["entry"]);
	assert.deepEqual(snapshot.warm.map((entry) => entry.node.name), ["nearby"], "only one graph hop is warmed");
	assert.deepEqual(snapshot.gaps.map((gap) => gap.path), ["src/unmapped.mjs"], "an active, unmapped path is a gap rather than an invented node");
	assert.match(renderAttention(snapshot), /Focus: entry/);
	assert.match(renderAttention(snapshot), /Mapping gaps/);

	writeFileSync(join(root, "src", "entry.mjs"), "export const entry = 200;\n");
	snapshot = attentionSnapshot(root, atlas, { active: { kind: "task", label: "m1 targets src/entry.mjs", paths: ["src/entry.mjs"] } });
	assert.deepEqual(snapshot.care.map((entry) => entry.node.name), ["entry"], "file drift is care pressure, not ordinary warmth");

	for (let round = 0; round < POLICY.limits.atlas.attention.candidateEpochs; round++) observeAtlas(atlas, [{ kind: "read", paths: ["src/entry.mjs"] }], { at: NOW });
	snapshot = attentionSnapshot(root, atlas);
	assert.deepEqual(snapshot.gaps.map((gap) => gap.path), ["src/unmapped.mjs"], "a persisted mapping gap stays visible until an existing node covers it");
	assert.deepEqual(snapshot.candidates.map((candidate) => candidate.node.name), ["orphan"], "only a cold unreferenced leaf becomes a reversible archive candidate");
	assert.match(renderAttention(snapshot, { idle: true }), /Cold candidates: 1/);
	applyAtlasOp(atlas, { action: "archive", name: "orphan" }, who);
	assert.equal(attentionSnapshot(root, atlas).candidateCount, 0, "archiving resolves the candidate without removing the node");
	applyAtlasOp(atlas, { action: "restore", name: "orphan" }, who);
	assert.equal(atlas.nodes.find((node) => node.name === "orphan").archived, undefined);
	applyAtlasOp(atlas, { action: "rename", name: "entry", to: "delivery" }, who);
	assert.equal(attentionSnapshot(root, atlas).focus.label, "delivery", "focus follows the stable node id through a rename");

	saveAtlas(brainDir, atlas);
	const reloaded = loadAtlas(brainDir).atlas;
	assert.equal(reloaded.view.focus.target.id, entry.id, "focus and attention survive a restart by durable id");
	applyAtlasOp(reloaded, { action: "archive", name: "delivery" }, who);
	assert.equal(reloaded.view.focus.target.id, entry.id, "archiving never silently clears an explicit focus lens");
	assert.match(renderAttention(attentionSnapshot(root, reloaded)), /archived; restore it to make it active/);
	assert.throws(() => applyAtlasOp(reloaded, { action: "remove", name: "delivery" }, who), /explicit focus/, "removal asks for an explicit clear or replacement first");
	assert.equal(fileMarks(reloaded).has("src/entry.mjs"), false, "an archived node leaves the active tree marks too");
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
	const focused = await tool.execute(tool.prepareArguments({ target: "atlas", action: "focus", id, reason: "Trace the source boundary." }), api(), undefined);
	assert.ok(!focused.isError, focused.output[0].text);
	assert.equal(loadAtlas(brainDir).atlas.view.focus.target.id, id, "a book call can persist a node lens by its stable id");
	const cleared = await tool.execute(tool.prepareArguments({ target: "atlas", action: "unfocus" }), api(), undefined);
	assert.ok(!cleared.isError, cleared.output[0].text);
	assert.equal(loadAtlas(brainDir).atlas.view.focus, undefined, "unfocus clears only the explicit lens");
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
	assert.match(TOOLS.shell, /A declared change move is different in direct mode: it runs directly under its live move token with detection-only final checkpoint scope checking/);
	assert.match(TOOLS.shell, /private disposable source copy/i);
	assert.match(TOOLS.shell, /read, wait, stop and close work for every context/i);
});

test("stage: a sandbox command candidate cannot touch the live tree before its approved promotion", (t) => {
	const { root, brainDir } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, "src", "format.mjs"), "export const value = 1;\n");
	writeFileSync(join(root, ".git", "secret"), "not source\n");
	writeFileSync(join(brainDir, "private"), "not source\n");
	const stage = createStage({ root });
	t.after(() => disposeStage(stage));
	assert.equal(existsSync(join(stage.work, ".git")), false, "the source projection excludes git metadata");
	assert.equal(existsSync(join(stage.work, ".brain")), false, "the source projection excludes the durable brain");
	writeFileSync(join(stage.work, "src", "format.mjs"), "export const value = 2;\n");
	assert.equal(readFileSync(join(root, "src", "format.mjs"), "utf8"), "export const value = 1;\n", "the stage copy cannot mutate the live source before promotion");
	const candidate = collectStageCandidate(stage);
	assert.deepEqual(candidate.changes.map(({ path, status }) => ({ path, status })), [{ path: "src/format.mjs", status: "changed" }]);
	const prepared = prepareStagePromotion({ root, brainDir, record: stage, targets: ["src/format.mjs"], fileOpsLimit: 1 });
	const applied = applyStagePromotion(prepared);
	assert.deepEqual(applied.changes, [{ path: "src/format.mjs", status: "changed", added: 1, removed: 1 }], "the candidate is a normal bounded file change only after validation");
	assert.equal(readFileSync(join(root, "src", "format.mjs"), "utf8"), "export const value = 2;\n");
	assert.equal(disposeStage(stage).removed, true, "normal completion removes the private stage root");
	assert.equal(existsSync(stage.root), false);
});

test("stage: the sandbox launch binds only the disposable work tree writable and blocks the brain without network", (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(root, "source.txt"), "source\n");
	const stage = createStage({ root });
	t.after(() => disposeStage(stage));
	const launch = sandboxArgs({ root: stage.work, target: STAGE_WORK_DIR, cwd: STAGE_WORK_DIR, brainDir, sandboxHome: stage.home, bindBrain: false, hide: [brainDir, join(root, ".git")] });
	const pairs = launch.args.join("\u0000");
	const stageBind = launch.args.findIndex((entry, index) => entry === "--bind" && launch.args[index + 1] === stage.work && launch.args[index + 2] === STAGE_WORK_DIR);
	const tmpfs = launch.args.findIndex((entry, index) => entry === "--tmpfs" && launch.args[index + 1] === "/tmp");
	const stageDir = launch.args.findIndex((entry, index) => entry === "--dir" && launch.args[index + 1] === STAGE_WORK_DIR);
	assert.ok(stageBind >= 0, "the stage work copy is the writable project-shaped mount");
	assert.ok(tmpfs >= 0 && stageDir > tmpfs, "the stage mount target is made inside the writable /tmp tmpfs, never under the read-only system root");
	assert.match(pairs, /--tmpfs\u0000.*\.brain/, "the live durable brain is covered after the system read-only bind");
	assert.ok(launch.args.includes("--unshare-net"), "network is off unless the move explicitly enables it");
	assert.doesNotMatch(pairs, new RegExp(`--bind\\u0000${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\u0000${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the live project is never rebound writable");
});

test("stage: stale, forbidden, out-of-target, and oversized candidate paths are refused without promotion", (t) => {
	const { root, brainDir } = fresh(t);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "one.mjs"), "export const one = 1;\n");
	writeFileSync(join(root, "src", "two.mjs"), "export const two = 2;\n");
	const wrongTarget = createStage({ root });
	t.after(() => disposeStage(wrongTarget));
	writeFileSync(join(wrongTarget.work, "src", "one.mjs"), "export const one = 3;\n");
	assert.throws(() => prepareStagePromotion({ root, brainDir, record: wrongTarget, targets: ["src/two.mjs"], fileOpsLimit: 1 }), /outside this move's declared targets/);
	assert.equal(readFileSync(join(root, "src", "one.mjs"), "utf8"), "export const one = 1;\n");

	const forbidden = createStage({ root });
	t.after(() => disposeStage(forbidden));
	mkdirSync(join(forbidden.work, ".brain"), { recursive: true });
	writeFileSync(join(forbidden.work, ".brain", "bypass"), "no\n");
	assert.throws(() => collectStageCandidate(forbidden), /forbidden .brain/);

	const stale = createStage({ root });
	t.after(() => disposeStage(stale));
	writeFileSync(join(stale.work, "src", "one.mjs"), "export const one = 4;\n");
	writeFileSync(join(root, "src", "two.mjs"), "export const two = 5;\n");
	assert.throws(() => prepareStagePromotion({ root, brainDir, record: stale, targets: ["src/one.mjs"], fileOpsLimit: 1 }), /live project changed after this command stage was materialized/);
	assert.equal(readFileSync(join(root, "src", "one.mjs"), "utf8"), "export const one = 1;\n", "a stale candidate never overwrites the live source");
});

test("stage: a failed promotion restores every earlier live path and cleans its disposable root", (t) => {
	const { root, brainDir } = fresh(t);
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	writeFileSync(join(root, "src", "a.mjs"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "nested", "b.mjs"), "export const b = 1;\n");
	const stage = createStage({ root });
	writeFileSync(join(stage.work, "src", "a.mjs"), "export const a = 2;\n");
	writeFileSync(join(stage.work, "src", "nested", "b.mjs"), "export const b = 2;\n");
	const prepared = prepareStagePromotion({ root, brainDir, record: stage, targets: ["src/a.mjs", "src/nested/b.mjs"], fileOpsLimit: 2 });
	// This mimics a concurrent filesystem failure after the whole candidate was validated: the first path has
	// already landed when the second's parent becomes a file. The staged apply must put the first one back.
	rmSync(join(root, "src", "nested"), { recursive: true, force: true });
	writeFileSync(join(root, "src", "nested"), "not a folder\n");
	assert.throws(() => applyStagePromotion(prepared), StageError);
	assert.equal(readFileSync(join(root, "src", "a.mjs"), "utf8"), "export const a = 1;\n", "the first promoted path was rolled back");
	assert.equal(disposeStage(stage).removed, true, "a failed promotion still cleans its own stage root");
	assert.equal(existsSync(stage.root), false);
});

test("shell: a live move owns its window, spends command starts, and loses stop authority when its revision changes", async (t) => {
	const { root, brainDir } = fresh(t);
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
	let launched;
	const windows = {
		list: () => [...open].map((name) => ({ name, state: "busy" })),
		run: async (name, command, options) => { launched = { name, command, options }; open.add(name); return result(name); },
		send: async (name) => result(name),
		stop: async (name) => { stopped++; return result(name, { wasBusy: true, ended: true, exit: 130, state: "idle" }); },
		close: (name) => ({ wasGone: !open.delete(name) }),
	};
	const tool = shellTool({ root, brainDir, config: { shellWait: 30 }, gate: { yolo: false }, runner: { mode: "sandbox" }, windows, runOf: () => ({ mode: "change", move: "m1", revision: 1 }) });
	const api = { conversationId: focus, taskId: "shell-focus" };
	const started = await tool.execute({ action: "run", command: "npm test", window: "check" }, api, {});
	assert.equal(started.isError, false, started.output[0].text);
	assert.equal(loadContext(brainDir).tasks[focus].commandUses, 1);
	assert.deepEqual(loadContext(brainDir).tasks[focus].windows, ["check"]);
	const stageReceipt = loadContext(brainDir).tasks[focus].stage;
	assert.match(stageReceipt.id, /./, "a sandboxed change command receives a task-owned stage receipt");
	assert.equal(launched.options.stage.id, stageReceipt.id, "the writable window receives that stage rather than the live project");
	assert.equal(existsSync(stageReceipt.root), true, "the receipt names the disposable root until task finalization");
	t.after(() => disposeStage(stageReceipt));
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

test("state: Dispatch is main-only mechanical evidence, not an automatic task command", (t) => {
	const { brainDir, root } = fresh(t);
	writeFileSync(join(root, "src.txt"), "source\n");
	const shelved = shelfItem(root, "src.txt", undefined, brainDir, []);
	updateContext(brainDir, (store) => { store.shelf.push(shelved.item); });
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Change source.", done_when: "The source changes." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Edit src.txt", done_when: "The source has the local edit.", targets: ["src.txt"], proof: "A named check passes." }, NOW);
	approve(plan, NOW, ["m1"]);
	savePlan(brainDir, plan);
	const main = stateBlock(brainDir, { mode: "sandbox" }, { root, messages: [] });
	assert.match(main, /Dispatch\n/);
	assert.match(main, /Eligible move facts:/);
	assert.match(main, /m1 revision 1/);
	assert.match(main, /Closure facts — boundary: src\.txt\. Claim: The source has the local edit\. Witness: A named check passes\./);
	assert.match(main, /src\.txt: .*shelf sh1 current/);
	assert.match(main, /This lens neither delegates work nor approves a move/);
	assert.doesNotMatch(main, /I call `task` with `move:m1`/, "a ready move is a fact, not an imperative");
	const focused = stateBlock(brainDir, { mode: "sandbox" }, { root, task: { purpose: "check the source", move: "m1", revision: 1, budget: { replies: 2, fileOps: 1, commandStarts: 0 } }, context: "Context\nFocus evidence and local shelf: empty.\n\n" });
	assert.match(focused, /Focus Move: m1 revision 1\./);
	assert.doesNotMatch(focused, /Dispatch\n/);
	assert.doesNotMatch(focused, /Ledger\n/);
	assert.doesNotMatch(focused, /Plan\n/);
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
	assert.equal(plan.parts[0].source, `unmapped:${ROOT_CONVERSATION_ID}:0`, "an unavailable Durable id is explicitly unmapped, never a text-match key");
	assert.match(plan.parts.find((part) => part.kind === "generated-state").fragment, /^<state>/, "generated state has its exact planned fragment");
});

test("active context projection: it preserves Durable entry identities through edits, multi-message contributions, ordering, and synthetic results", (t) => {
	const user = { role: "user", timestamp: 100, content: [{ type: "text", text: "replacement words" }] };
	const assistant = { role: "assistant", timestamp: 101, content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] };
	const result = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "one result" }] };
	const synthetic = { role: "toolResult", toolCallId: "missing", toolName: "read", content: [{ type: "text", text: "Durable synthesized this result" }] };
	const view = {
		entries: [
			{ id: "u1", conversationId: "main", model: [{ role: "user", timestamp: 100, content: [{ type: "text", text: "old words" }] }] },
			{ id: "a1", conversationId: "main", model: [assistant] },
			{ id: "r1", conversationId: "main", model: [result] },
			{ id: "omitted", conversationId: "main", model: [{ role: "user", timestamp: 99, content: [{ type: "text", text: "gone" }] }] },
		],
		contributions: [[user], [assistant], [result], []],
		// Flattening may put the result beside its call and add a missing result. It is not an editable-row map.
		messages: [user, assistant, result, synthetic],
	};
	const projection = activeContextProjection(view);
	assert.deepEqual(projection.map((event) => [event.entryId, event.contributions.length]), [["u1", 1], ["a1", 1], ["r1", 1], ["omitted", 0]], "the projection follows active contributions, not raw entry models");
	const copies = view.messages.map((message) => JSON.parse(JSON.stringify(message)));
	const sources = bridgeRequestSources(copies, view);
	assert.deepEqual(sources.map((source) => source?.entryId), ["u1", "a1", "r1", undefined], "reordered active messages retain their entry ids while a synthesized result stays unmapped");
	assert.deepEqual(sources.slice(0, 3).map((source) => source?.position), [0, 0, 0], "each source also names its contribution position");
	const { brainDir, root } = fresh(t);
	const plan = planRequest(copies, { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: true, conversationId: "main", used: 1, fired: [], wakeLines: [], windowRows: [], sources });
	const active = plan.parts.filter((part) => part.kind === "active-message");
	assert.deepEqual(active.map((part) => part.source), ["durable:main:u1:0", "durable:main:a1:0", "durable:main:r1:0", "unmapped:main:3"], "frozen request provenance keeps contribution ids and marks a synthesized result as unmapped");
	assert.equal(active[0].sourceRef.entryId, "u1", "the plan retains the structured source beside its printable provenance");
	const firstSameStamp = { role: "user", timestamp: 200, content: [{ type: "text", text: "one" }] };
	const secondSameStamp = { role: "user", timestamp: 200, content: [{ type: "text", text: "two" }] };
	const ambiguous = { entries: [{ id: "u2", conversationId: "main" }, { id: "u3", conversationId: "main" }], contributions: [[firstSameStamp], [secondSameStamp]], messages: [firstSameStamp, secondSameStamp] };
	assert.deepEqual(bridgeRequestSources(ambiguous.messages.map((message) => JSON.parse(JSON.stringify(message))), ambiguous), [undefined, undefined], "a copied ambiguous timestamp pair stays unmapped rather than borrowing array position or text");
});

test("talk source mutations: equal visible words cannot select one another", (t) => {
	const { brainDir } = fresh(t);
	const one = { kind: "durable-message", conversationId: "main", entryId: "u1", position: 0 };
	const two = { kind: "durable-message", conversationId: "main", entryId: "u2", position: 0 };
	noteChat(brainDir, "user", 100, "same words", { source: one });
	noteChat(brainDir, "user", 101, "same words", { source: two });
	assert.equal(reviseTalkSource(brainDir, one, "first reworded"), true, "the selected Durable source changes");
	assert.deepEqual(loadContext(brainDir).chat.map((entry) => entry.text), ["first reworded", "same words"], "an equal later saying stays untouched");
	assert.equal(removeTalkSource(brainDir, two), true, "the selected second source leaves future kept talk");
	assert.deepEqual(loadContext(brainDir).chat.map((entry) => entry.text), ["first reworded"], "removal is source-specific too");
	const provisional = { kind: "chat-call", conversationId: "main", callId: "c1" };
	noteChat(brainDir, "you", 102, "agent words", { source: provisional });
	assert.equal(bindTalkSource(brainDir, provisional, { kind: "durable-message", conversationId: "main", entryId: "a1", position: 0, callId: "c1" }), true, "a tool call is promoted to its admitted entry id");
	assert.equal(reviseTalkSource(brainDir, { kind: "durable-message", conversationId: "main", entryId: "a1", position: 0, callId: "c1" }, "agent reworded"), true, "the stable admitted source drives later mutation");
	const beforeToolWrites = { kind: "chat-call", conversationId: "main", callId: "c2" };
	assert.equal(bindTalkSource(brainDir, beforeToolWrites, { kind: "durable-message", conversationId: "main", entryId: "a2", position: 0, callId: "c2" }), true, "an admitted entry may arrive before its tool writes talk");
	noteChat(brainDir, "you", 103, "later tool words", { source: beforeToolWrites });
	assert.deepEqual(loadContext(brainDir).chat.map((entry) => entry.text), ["first reworded", "agent reworded", "later tool words"]);
	assert.equal(loadContext(brainDir).chat.at(-1).source.entryId, "a2", "the pending call binding promotes the stored saying without comparing its words");
	const forgotten = { kind: "durable-message", conversationId: "main", entryId: "u-forget", position: 0 };
	noteChat(brainDir, "user", 104, "equal soft-forget words", { source: forgotten });
	noteChat(brainDir, "user", 105, "equal soft-forget words");
	recordSoftForgetPending(brainDir, { entryId: "u-forget" });
	const equalAfterForget = loadContext(brainDir).chat.filter((entry) => entry.text === "equal soft-forget words");
	assert.equal(equalAfterForget.length, 1, "soft-forget removes only its admitted entry from kept talk");
	assert.equal(equalAfterForget[0].source, undefined, "an equal legacy saying is not removed by its text");
});

test("task: selected main shelf evidence is captured into the durable focus capsule and replay stays local", async (t) => {
	const { brainDir, root } = fresh(t);
	writeFileSync(join(root, "evidence.txt"), "captured first version\n");
	const selected = shelfItem(root, "evidence.txt", undefined, brainDir, []);
	updateContext(brainDir, (store) => { store.shelf.push(selected.item); });
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "look", text: "Inspect captured evidence.", done_when: "The evidence is reported." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Read the captured evidence", done_when: "Its relevant fact is reported." }, NOW);
	savePlan(brainDir, plan);
	const entries = [];
	const memos = new Map();
	const child = "capsule-focus";
	const now = Date.parse(NOW);
	const tool = taskTool({ root, brainDir, config: { taskTurns: 4, maxTokens: 4096 } });
	const result = await tool.execute({ move: "m1", context: "Read this source only; leave adjacent work for later.", shelf: [selected.item.id] }, {
		conversationId: ROOT_CONVERSATION_ID,
		taskId: "capsule-task",
		callId: "task-call",
		now: () => now,
		memo: async (key, value) => { if (value !== undefined) memos.set(key, value); return memos.get(key); },
		details: async () => {},
		commit: async (fn) => fn({
			scanConversations: async () => ({ items: [] }),
			scanEntries: async ({ conversationId }) => {
				if (conversationId === ROOT_CONVERSATION_ID) return { items: [{ id: "parent-call", model: [{ role: "assistant", content: [{ type: "toolCall", id: "task-call", name: "task", arguments: {} }] }] }] };
				return { items: [] };
			},
			forkConversation: async () => ({ id: child }),
			doc: async () => ({}),
			appendEntry: async (_conversation, entry) => { entries.push(entry); },
		}),
		conversation: async () => ({
			submit: async () => ({ wait: async () => {
				updateContext(brainDir, (store) => { taskState(store, child).returned = { report: "Observed the captured source.", done: true }; });
				return { status: "done" };
			} }),
		}),
	}, undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	const run = entries.find((entry) => entry.kind === "carto.brief")?.data;
	assert.ok(run, "the focus durable brief stores its run");
	assert.equal(run.evidence.length, 1);
	assert.equal(run.evidence[0].placement, selected.item.id);
	assert.equal(run.evidence[0].item.snapshot, selected.item.snapshot, "the exact rendered snapshot is retained");
	assert.match(run.evidence[0].digest, /^[a-f0-9]{64}$/);
	assert.match(run.brief, /Boundary and facts from the main context/);
	assert.match(run.brief, /captured first version/);
	assert.match(run.brief, /do not add targets, capabilities, proof, approval, or completion authority/);
	assert.match(run.brief, /Closure: this focus is done only when its declared result is observed within its declared authority/);
	writeFileSync(join(root, "evidence.txt"), "later live version\n");
	updateContext(brainDir, (store) => {
		store.shelf = [];
		Object.assign(taskState(store, child), { mode: run.mode, move: run.move, revision: run.revision, budget: run.budget, evidence: run.evidence, changedSurface: { bytes: 0, lines: 0 } });
	});
	const request = dressRequest([
		{ role: "user", content: [{ type: "text", text: "Broad parent planning history must not be sent." }] },
		{ role: "toolResult", toolCallId: "task-call", toolName: "task", content: [{ type: "text", text: `${TASK_HEADER}\n\n${run.brief}` }] },
	], { brainDir, root, config: { contextWindow: 100_000 }, gate: { yolo: false }, main: false, conversationId: child });
	const rendered = request.map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")).join("\n");
	assert.match(rendered, /captured first version/, "replay uses the captured snapshot");
	assert.doesNotMatch(rendered, /later live version/, "a later shelf/source change cannot rewrite the handoff");
	assert.doesNotMatch(rendered, /Broad parent planning history/, "the parent conversation is not replayed into the provider request");
	assert.doesNotMatch(rendered, /Dispatch\n/, "the main-only Dispatch lens stays out of the focus");
	assert.doesNotMatch(rendered, /Requests\n/, "the main request queue stays out of the focus");
});

test("dressRequest: a task gets compact local state, not main requests, reports, or shelf", (t) => {
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
	assert.match(block, /Focus evidence and local shelf: empty\./, "it does not inherit the main shelf");
	assert.doesNotMatch(block, /In view in full: s1/, "main reports stay out of a focus");
	assert.doesNotMatch(block, /Requests\nThese wait for /, "the main request queue stays out of a focus");
	assert.doesNotMatch(block, /Which parser\?/, "unrelated ledger material stays out too");
	assert.doesNotMatch(block, /Dispatch\n/, "the main Dispatch lens is never replayed into a focus");
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

test("write create: standalone writes keep the complete requested file; focus tools measure surface before writing", (t) => {
	const { root, brainDir } = fresh(t);
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const result = writeOne(root, brainDir, "long.txt", content, { newOnly: true });
	assert.equal(readFileSync(join(root, "long.txt"), "utf8"), content, "the low-level primitive never clips a requested file");
	assert.match(result, /100 lines, a new file/);
	assert.throws(() => writeOne(root, brainDir, "long.txt", "replacement", { newOnly: true }), /already exists/);
	assert.deepEqual(changedSurface("one\ntwo\n", "one\nthree\n"), { bytes: 6, lines: 2, added: { bytes: 4, lines: 1 }, removed: { bytes: 2, lines: 1 } }, "added and removed spans both count");
	const oneLine = changedSurface("x".repeat(500), "y".repeat(500));
	assert.equal(oneLine.bytes, 1000, "a one-line replacement is bounded by bytes too");
	assert.equal(oneLine.lines, 2, "and still reports both replaced text spans");
});

test("direct file changes use one atomic symmetric changed-surface allowance", async (t) => {
	const { root, brainDir } = fresh(t);
	const { plan } = loadPlan(brainDir);
	applyPlanOp(plan, { action: "add", mode: "change", text: "Make one bounded file change.", done_when: "The file is changed." }, NOW);
	applyPlanOp(plan, { action: "addMove", parent: "p1", text: "Change src/surface.txt", done_when: "The bounded file change is present.", targets: ["src/surface.txt"], proof: "The file is read back.", budget: { replies: 3, fileOps: 4, commandStarts: 0 } }, NOW);
	approve(plan, NOW, ["m1"]);
	startMove(plan, "m1", NOW);
	savePlan(brainDir, plan);
	const focus = "surface-focus";
	updateContext(brainDir, (store) => { Object.assign(taskState(store, focus), { mode: "change", move: "m1", revision: 1, fileOps: 0, changedSurface: { bytes: 0, lines: 0 } }); });
	const [write, edit, rm] = changeTools({ root, brainDir, gate: { yolo: false } });
	const api = { conversationId: focus, taskId: "surface-task" };
	const over = await write.execute({ path: "src/surface.txt", content: "x".repeat(POLICY.limits.change.surfaceBytes + 1) }, api, undefined);
	assert.equal(over.isError, true);
	assert.match(over.output[0].text, /Nothing was changed/);
	assert.equal(existsSync(join(root, "src", "surface.txt")), false, "an oversized create never leaves a clipped or partial file");
	assert.deepEqual(loadContext(brainDir).tasks[focus].changedSurface, { bytes: 0, lines: 0 }, "a refusal spends no surface");
	const made = await write.execute({ path: "src/surface.txt", content: "old" }, api, undefined);
	assert.equal(made.isError, undefined, made.output[0].text);
	assert.match(made.output[0].text, /Direct changed surface: 3\//, "the tool makes used surface visible");
	const rewrite = await edit.execute({ path: "src/surface.txt", old_text: "old", new_text: "y".repeat(POLICY.limits.change.surfaceBytes) }, api, undefined);
	assert.equal(rewrite.isError, true);
	assert.match(rewrite.output[0].text, /proposed edit changes/);
	assert.equal(readFileSync(join(root, "src", "surface.txt"), "utf8"), "old", "a whole-file edit receives the same atomic refusal");
	const removed = await rm.execute({ path: "src/surface.txt" }, api, undefined);
	assert.equal(removed.isError, undefined, removed.output[0].text);
	assert.equal(existsSync(join(root, "src", "surface.txt")), false);
	const recreated = await write.execute({ path: "src/surface.txt", content: "new" }, api, undefined);
	assert.equal(recreated.isError, true);
	assert.match(recreated.output[0].text, /cannot be recreated as a rewrite path/);
	assert.equal(existsSync(join(root, "src", "surface.txt")), false, "remove then create cannot evade the shared allowance in one focus");
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

test("book: target-family reads preserve their live and stale reference results", async (t) => {
	const { root, brainDir } = fresh(t);
	const engine = { messagesOf: () => [], want: () => {}, callWords: () => "book" };
	const registry = {
		tools: () => [{
			extension: { name: "demo" },
			tool: { name: "echo", description: "Echo a value.", parameters: { type: "object", properties: { value: { type: "string" } } } },
		}],
	};
	const tool = bookTool({ root, brainDir, config: {}, engine, gate: { yolo: false } });
	let serial = 0;
	const api = () => ({
		conversationId: ROOT_CONVERSATION_ID,
		taskId: `family-${++serial}`,
		now: () => 1_700_000_000_000,
		registry,
		executeTool: async () => { throw new Error("unexpected nested tool"); },
	});
	const run = (args) => tool.execute(tool.prepareArguments(args), api(), undefined);

	const durableList = await run({ target: "tool", action: "list" });
	assert.equal(durableList.isError, undefined, durableList.output[0].text);
	assert.deepEqual(durableList.details, { target: "tool", count: 1, shown: 1 });
	assert.equal(JSON.parse(durableList.output[0].text)[0].ref.kind, "tool");
	const durableLive = await run({ target: "tool", action: "read", id: "demo:echo" });
	assert.equal(durableLive.isError, undefined, durableLive.output[0].text);
	assert.deepEqual(JSON.parse(durableLive.output[0].text), { extension: "demo", name: "echo", description: "Echo a value.", schema: { type: "object", properties: { value: { type: "string" } } } });
	assert.equal(durableLive.details.status, "live");
	assert.equal(durableLive.details.ref.kind, "tool");
	const durableStale = await run({ target: "tool", action: "read", ref: { id: "demo:echo", version: "0".repeat(64) } });
	assert.equal(durableStale.isError, true);
	assert.match(durableStale.output[0].text, /tool reference is stale: requested 0+, current [0-9a-f]{64}; the requested immutable version is unavailable/);

	const added = await run({ target: "ledger", action: "add", kind: "note", text: "Keep this exact." });
	assert.equal(added.isError, undefined, added.output[0].text);
	const brainList = await run({ target: "ledger", action: "list" });
	assert.equal(brainList.isError, undefined, brainList.output[0].text);
	assert.deepEqual(brainList.details, { target: "ledger", count: 1, shown: 1 });
	assert.equal(JSON.parse(brainList.output[0].text)[0].ref.kind, "ledger");
	const brainLive = await run({ target: "ledger", action: "read", id: "n1" });
	assert.equal(brainLive.isError, undefined, brainLive.output[0].text);
	assert.equal(JSON.parse(brainLive.output[0].text).text, "Keep this exact.");
	assert.equal(brainLive.details.status, "live");
	assert.equal(brainLive.details.ref.kind, "ledger");
	const brainStale = await run({ target: "ledger", action: "read", ref: { id: "n1", version: "0".repeat(64) } });
	assert.equal(brainStale.isError, true);
	assert.match(brainStale.output[0].text, /ledger reference is stale: requested 0+, current [0-9a-f]{64}; historical content is unavailable/);

	addRecord(brainDir, { id: "t1", at: 1_700_000_000_000, mode: "look", brief: "Review routing", report: "The route stayed exact.", summary: "Routing reviewed." });
	const reportList = await run({ target: "report", action: "list" });
	assert.equal(reportList.isError, undefined, reportList.output[0].text);
	assert.deepEqual(reportList.details, { target: "report", count: 1, shown: 1 });
	assert.equal(JSON.parse(reportList.output[0].text)[0].ref.kind, "report");
	const reportLive = await run({ target: "report", action: "read", id: "t1" });
	assert.equal(reportLive.isError, undefined, reportLive.output[0].text);
	assert.match(reportLive.output[0].text, /^Report t1 /);
	assert.equal(reportLive.details.status, "live");
	assert.equal(reportLive.details.ref.kind, "report");

	const assessment = await run({ target: "assessment", action: "write", text: "The router is central." });
	assert.equal(assessment.isError, undefined, assessment.output[0].text);
	assert.deepEqual(assessment.details, { target: "assessment", action: "write", shown: ["assessment written, 22 characters"] });
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

test("return: a closure gap cannot accompany a completion claim and is kept for the orchestrator", async (t) => {
	const { root, brainDir } = fresh(t);
	const tool = returnTool({ root, brainDir, config: {} });
	const api = { conversationId: "gap-focus", now: () => Date.parse(NOW) };
	const contradictory = await tool.execute({ report: "The script parses, but the page cannot load it.", proof: "node --check exits 0.", done: true, closure_gap: "index.html is outside the declared targets." }, api, undefined);
	assert.equal(contradictory.isError, true);
	assert.match(contradictory.output[0].text, /`closure_gap`.*`done` must be false/);
	assert.equal(loadContext(brainDir).tasks["gap-focus"], undefined, "a contradictory return does not end or persist the focus");
	const blocked = await tool.execute({ report: "The script parses, but the page cannot load it.", proof: "node --check exits 0.", done: false, closure_gap: "index.html is outside the declared targets." }, api, undefined);
	assert.equal(blocked.isError, undefined, blocked.output[0].text);
	assert.equal(loadContext(brainDir).tasks["gap-focus"].returned.done, false);
	assert.equal(loadContext(brainDir).tasks["gap-focus"].returned.closureGap, "index.html is outside the declared targets.");
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
	assert.throws(() => tool.prepareArguments({ target: "plan", action: "acceptMove", id: "m1" }), /review/);
	const mDone = await run({ target: "plan", action: "acceptMove", id: "m1", review: "Reading src/index.mjs witnesses that its entry point is named." });
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
	assert.match(TOOLS.read, /later successful read batch removes the prior batch from active view/);
	assert.match(TOOLS.read, /deliberately preserve source material/);
	assert.match(TOOLS.read, /shared ledger, atlas or assessment/);
	assert.match(LOOK_NOTE, /retain lasting conclusions in the shared ledger, atlas or assessment/);
	assert.match(CHANGE_NOTE({ item: "p1", move: "m1", revision: 1, text: "Edit file", doneWhen: "The file is updated.", proof: "A check.", targets: ["src/file.mjs"] }), /keep lasting findings before return/);
	assert.doesNotMatch(TOOLS.read, /one `read` comes back per reply/);
	assert.match(TOOLS.shelf, /action/);
});

test("prepend: the user's own markdown is read before the prompt as source of truth; nothing when absent", (t) => {
	const { root, brainDir } = fresh(t);
	const core = join(root, "PREPEND.md");
	// Nothing anywhere: nothing to prepend.
	assert.equal(loadPrepend(brainDir, core), undefined, "no files, no prepend");
	// The core alone.
	writeFileSync(core, "Be brief.\n");
	const coreOnly = loadPrepend(brainDir, core);
	assert.equal(coreOnly, "Source of Truth:\nBe brief.");
	assert.equal(coreOnly.includes("Always sign off"), false, "only what exists is read");
	// Both: the core is read before the brain, so the closer instruction comes last.
	writeFileSync(join(brainDir, "PREPEND.md"), "Always sign off as Molly.\n");
	const both = loadPrepend(brainDir, core);
	assert.equal(both, "Source of Truth:\nBe brief.\n\nSource of Truth:\nAlways sign off as Molly.");
	// A whitespace-only brain file is nothing, not even a header.
	writeFileSync(join(brainDir, "PREPEND.md"), "  \n\n");
	const after = loadPrepend(brainDir, core);
	assert.equal(after.includes("Molly"), false);
	assert.equal(after, "Source of Truth:\nBe brief.");
	// An unreadable core (a folder) is skipped, not fatal.
	assert.equal(loadPrepend(brainDir, root), undefined, "a folder where the file would be: nothing added");
	// Line endings and a byte order mark do not stand in the way.
	writeFileSync(core, "\uFEFFBe terse.\r\n");
	const crlf = loadPrepend(brainDir, core);
	assert.equal(crlf, "Source of Truth:\nBe terse.");
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

test("engine: the optional context handoff is a raw no-tools native grammar decision and fails closed", async (t) => {
	const { root, brainDir } = fresh(t);
	const server = await startStandIn({ tokenDelayMs: 0 });
	const ignored = await startStandIn({ tokenDelayMs: 0, ignoreNativeGrammar: true });
	t.after(async () => { await server.close(); await ignored.close(); });
	const payload = {
		model: "stand-in",
		messages: [
			{ role: "system", content: "ordinary system prompt" },
			{ role: "user", content: "ON COLLAPSE: preserve this one fact" },
		],
		tools: [{ type: "function", function: { name: "book", parameters: {} } }],
		tool_choice: "auto",
		stream: true,
	};
	const prepare = (url) => {
		const engine = createEngine({ root, brainDir, config: { server: url, model: "stand-in", contextWindow: 10_000, collapseFull: 80 } });
		engine.sending(ROOT_CONVERSATION_ID, payload, { provider: "local", id: "stand-in" });
		engine.replied(ROOT_CONVERSATION_ID, { content: [{ type: "text", text: "A normal participant reply." }] });
		return engine;
	};
	const choice = await prepare(server.url).ask(ROOT_CONVERSATION_ID, { reason: "a test collapse" });
	assert.equal(choice.handoff, true);
	const request = server.nativeRequests.at(-1);
	assert.equal(request.stream, false);
	assert.equal(request.tools, undefined, "the host decision never copies ordinary provider tools");
	assert.equal(request.tool_choice, undefined);
	assert.match(request.grammar, /handoff/);
	assert.match(request.messages.at(-1).content, /Answer \{\"handoff\": true\}/);

	const refused = await prepare(ignored.url).ask(ROOT_CONVERSATION_ID, { reason: "a test collapse" });
	assert.equal(refused.handoff, false, "an ignored grammar cannot be accepted by a prompt-only parser");
	assert.match(refused.error, /required native grammar handoff decision failed/i);
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
	engine.sending(focus, { messages: [{ role: "user", content: "a later direct send" }] }, { provider: "local", id: "qwen" });
	assert.equal(engine.window("newest").plan, undefined, "a send without a fresh plan never inherits prior request provenance");
});

test("legacy `<shelf-ask>` blocks in older stored transcripts are stripped cleanly", () => {
	const legacy = "file body\n\n<shelf-ask>\nShould I shelf index.html? Yes or no.\n</shelf-ask>\n";
	assert.equal(withoutShelfAsk(legacy), "file body");
	assert.equal(withoutAdditions(legacy), "file body");
});

// ─── Same-model consultation conference ─────────────────────────────────────

test("native grammar is Cartographer's hard host-decision boundary, not an OpenAI custom-tool option", async (t) => {
	const server = await startStandIn({ tokenDelayMs: 0 });
	t.after(() => server.close());
	const capability = await probeNativeGrammarCapability({ server: server.url, modelId: "stand-in", cache: false });
	assert.equal(capability.ok, true);
	const probe = server.nativeRequests.at(-1);
	assert.equal(probe.tools, undefined);
	assert.equal(probe.tool_choice, undefined);
	assert.equal(probe.stream, false);
	assert.match(probe.grammar, /"cartographer"/);
	assert.match(probe.messages.at(-1).content, /outside-the-allowed-native-grammar-set/);

	const choice = await chooseNativeGrammar({
		server: server.url,
		modelId: "stand-in",
		messages: [{ role: "user", content: "Choose the next host role." }],
		grammar: nativeLiteralGrammar(["atlas", "ledger"]),
		eligible: ["atlas", "ledger"],
	});
	assert.equal(choice.value, "atlas");
	assert.equal(choice.record.request.tools, undefined);

	const ignored = await startStandIn({ tokenDelayMs: 0, ignoreNativeGrammar: true });
	t.after(() => ignored.close());
	const refused = await probeNativeGrammarCapability({ server: ignored.url, modelId: "stand-in", cache: false });
	assert.equal(refused.ok, false, "a server that accepts but ignores grammar never becomes a valid Cartographer route");
	assert.match(refused.error, /outside the grammar/i);
});

test("harness: a direct Durable submission cannot bypass the deferred native grammar gate", async (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(brainDir, "config.json"), JSON.stringify({ prefill: false }));
	const server = await startStandIn({ tokenDelayMs: 0, ignoreNativeGrammar: true });
	let session;
	t.after(async () => {
		await session?.harness.close(session.context);
		await server.close();
	});
	const config = loadConfig({
		brainDir,
		flags: { url: server.url, model: "stand-in" },
		env: { ...process.env, CARTO_CONFIG: join(root, "no-install-config.json"), CARTO_SERVER: "", CARTO_MODEL: "" },
	});
	session = await openSession({ root, brainDir, config, runner: createRunner() });
	assert.equal(server.nativeRequests.length, 0, "opening a local Durable session does not preflight the server");
	assert.equal(server.requests.length, 0);

	// This deliberately calls Durable directly, without terminal.submit()/ensureModelReady(). The provider wrapper
	// remains the non-bypassable last gate for resumed work and other integration entry points.
	const submission = await session.main.submit({ type: "input", content: "say: this ordinary request must not be sent || sleep" }, session.context);
	const outcome = await submission.wait(session.context);
	await session.harness.waitForIdle(session.context);
	assert.equal(outcome.status, "unanswered");
	assert.equal(outcome.reason, "model_error");
	assert.match(outcome.detail, /requires llama\.cpp native GBNF grammar enforcement/i);
	assert.equal(server.nativeRequests.length, 1, "the direct path sends only the mandatory native proof");
	assert.equal(server.requests.length, 0, "an ignored native grammar still receives no ordinary provider request");
});

test("conference C1-C4: an independent same-model child preserves the handoff prefix, reaches a bounded return, and lets the root rest", async (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(root, "source.txt"), "first captured line\nsecond captured line\n");
	writeFileSync(join(brainDir, "config.json"), JSON.stringify({ initiate: false, prefill: false }));
	const server = await startStandIn({ tokenDelayMs: 0 });
	let session;
	t.after(async () => {
		await session?.harness.close(session.context);
		await server.close();
	});
	const config = loadConfig({
		brainDir,
		flags: { url: server.url, model: "stand-in" },
		env: { ...process.env, CARTO_CONFIG: join(root, "no-install-config.json"), CARTO_SERVER: "", CARTO_MODEL: "" },
	});
	session = await openSession({ root, brainDir, config, runner: createRunner() });
	const input = {
		question: "Which bounded fixture path should we choose?",
		context: "COMMON CONTEXT SENTINEL",
		files: [{ path: "source.txt", range: "1-1" }],
		myPersona: "OPENING PERSONA SENTINEL",
	};
	const submitted = await session.main.submit({ type: "input", content: `PARENT-EXCLUSION-SENTINEL || consult: ${JSON.stringify(input)}` }, session.context);
	const settled = await submitted.wait(session.context);
	assert.equal(settled.status, "done", "the root ends after its post-consult sleep rather than repeatedly accepting the completed receipt");
	assert.equal(server.requests.length, 5, "root call, two bounded debate turns, host-authorized Cartographer report, then one root receipt turn");
	const [rootBefore, opening, selected, report, rootAfter] = server.requests;
	assert.equal(rootBefore.model, "stand-in");
	const [capability, firstSelector, reportSelector] = server.nativeRequests;
	const tools = (request) => (request.tools ?? []).map((tool) => `function:${tool.function?.name}`);
	const messageText = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
	const joined = (request) => request.messages.map(messageText).join("\n");

	assert.equal(capability.model, "stand-in");
	assert.match(capability.grammar, /"cartographer"/);
	assert.deepEqual(tools(opening), ["function:consult_source"], "an opening/debate participant cannot receive consult_return");
	assert.equal(opening.tool_choice, undefined);
	assert.deepEqual(tools(selected), ["function:consult_source"], "an arbitrary selected debater cannot return the conference");
	assert.equal(selected.tool_choice, undefined);
	assert.deepEqual(tools(report), ["function:consult_source", "function:consult_return"], "only the host-authorized Cartographer report receives the terminal tool");
	assert.equal(report.tool_choice, undefined);
	for (const selector of [firstSelector, reportSelector]) {
		assert.equal(selector.tools, undefined, "the raw native selector has no tool surface");
		assert.equal(selector.tool_choice, undefined);
	}
	assert.match(firstSelector.grammar, /"continue:atlas"/);
	assert.doesNotMatch(firstSelector.grammar, /"report:cartographer"/, "the host gate physically removes the report choice before two members have debated");
	assert.doesNotMatch(firstSelector.grammar, /"continue:cartographer"/, "the prior speaker is physically absent from the finite grammar");
	assert.match(reportSelector.grammar, /"report:cartographer"/, "only the host-native selector can authorize Cartographer's final report");
	for (const request of [opening, selected, report]) {
		assert.equal(request.model, "stand-in", "every participant request uses the caller's resolved model");
		assert.doesNotMatch(joined(request), /PARENT-EXCLUSION-SENTINEL/, "the independent child has no parent transcript");
	}
	const firstSelectorText = firstSelector.messages.map(messageText).join("\n");
	const reportSelectorText = reportSelector.messages.map(messageText).join("\n");
	assert.match(joined(opening), /OPENING PERSONA SENTINEL/, "Cartographer alone receives the request-local opening persona");
	assert.match(joined(opening), /COMMON CONTEXT SENTINEL/, "the captured caller context is part of the immutable common packet");
	assert.doesNotMatch(firstSelectorText, /OPENING PERSONA SENTINEL/, "the native selector receives no active persona packet");
	assert.doesNotMatch(firstSelectorText, /COMMON CONTEXT SENTINEL/, "the native selector receives no raw captured project context");
	assert.doesNotMatch(joined(selected), /OPENING PERSONA SENTINEL/, "the selected participant does not inherit the prior persona tail");
	assert.match(joined(selected), /You are Atlas \(atlas\)/);
	assert.match(joined(selected), /private entry-time atlas snapshot.*empty snapshot/is, "even an empty Atlas book remains a real role packet");
	assert.match(joined(selected), /OPENING CONFERENCE CONTRIBUTION/, "the selected participant retains the completed shared contribution");
	assert.match(joined(selected), /Native GBNF selected atlas to continue the bounded debate/, "the host records the native continuation handoff in the durable child");
	assert.match(reportSelectorText, /Host debate gate: 2\/2 completed contributions and 2\/2 distinct participants \(met\)/, "the host-native selector receives explicit debate evidence before it may conclude");
	assert.match(joined(report), /host's native GBNF decision found the bounded debate ready for a final advisory/i);
	assert.match(joined(report), /Native GBNF authorized Cartographer to write the final advisory report/);
	assert.match(messageText(rootAfter.messages.at(-1)), /Consult conference co1 returned answered from cartographer/);

	const { conference } = loadConference(brainDir, "co1");
	assert.equal(conference.status, "returned");
	assert.notEqual(conference.childConversationId, session.main.id, "the conference owns a new Durable conversation, not a parent fork");
	assert.deepEqual(conference.model, { provider: "local", modelId: "stand-in" });
	assert.deepEqual(conference.turns.map((turn) => turn.participant), ["cartographer", "atlas"]);
	assert.deepEqual(conference.selectorEvents.map((event) => [event.after, event.participant, event.decision]), [["cartographer", "atlas", "continue"], ["atlas", "cartographer", "report"]]);
	assert.equal(conference.final.participant, "cartographer", "only host-authorized Cartographer can return the conference");
	assert.equal(conference.requestPlans.length, 5);
	assert.ok(conference.requestPlans.length <= POLICY.limits.conference.requestPlans, "the audit cap is above this complete bounded handoff and did not discard its evidence");
	assert.ok(POLICY.limits.conference.requestPlans >= Math.max(8, POLICY.limits.conference.turns * 4 + 4) + POLICY.limits.conference.turns, "the request-plan audit cap covers every bounded child request plus each possible raw selector handoff");
});

test("conference C1/C2: host-native choices gate the terminal report and debate payloads cannot expose it", () => {
	const declared = {
		model: "fixture",
		tool_choice: "required",
		tools: [
			{ type: "function", function: { name: "consult_source", parameters: {} } },
			{ type: "function", function: { name: "consult_return", parameters: {} } },
		],
	};
	const deliberation = restrictParticipantPayload(declared);
	assert.deepEqual(deliberation.tools.map((tool) => tool.function.name), ["consult_source"]);
	assert.equal(deliberation.tool_choice, undefined, "a participant never inherits host routing control");
	const report = restrictParticipantPayload(declared, { allowReturn: true });
	assert.deepEqual(report.tools.map((tool) => tool.function.name), ["consult_source", "consult_return"]);
	assert.throws(() => restrictParticipantPayload({ tools: [{ type: "function", function: { name: "consult_source" } }] }, { allowReturn: true }), ConferenceError);
	const record = {
		id: "co1",
		question: "Which role should inspect the boundary?",
		turns: [{ participant: "cartographer", text: "The opening contribution is complete." }],
		active: { kind: "selector", previousSpeaker: "cartographer" },
	};
	assert.deepEqual(debateStatus(record), { turns: 1, participants: ["cartographer"], debateTurns: POLICY.limits.conference.debateTurns, debateParticipants: POLICY.limits.conference.debateParticipants, ready: false });
	const firstOptions = selectorOptions(record, ["atlas", "ledger"]);
	assert.deepEqual(firstOptions.map((option) => option.value), ["continue:atlas", "continue:ledger"]);
	assert.equal(selectorGrammar(firstOptions), 'root ::= "continue:atlas" | "continue:ledger"');
	const messages = selectorMessages(record, ["atlas", "ledger"]);
	assert.equal(messages.length, 2);
	assert.match(messages[1].content, /continue:atlas, continue:ledger/);
	assert.match(messages[1].content, /Host debate gate: 1\/2 completed contributions and 1\/2 distinct participants \(not met\)/);
	assert.match(messages[1].content, /opening contribution/);
	assert.doesNotMatch(messages.map((message) => message.content).join("\n"), /consult_source|consult_return|select_persona/);
	assert.equal(enumGrammar(["atlas", "ledger"]), 'root ::= "atlas" | "ledger"');
	const ready = {
		...record,
		turns: [...record.turns, { participant: "atlas", text: "A second perspective completed the debate." }],
		active: { kind: "selector", previousSpeaker: "atlas" },
	};
	const readyOptions = selectorOptions(ready, ["cartographer", "ledger"]);
	assert.deepEqual(readyOptions.map((option) => option.value), ["continue:cartographer", "continue:ledger", "report:cartographer"]);
	assert.match(selectorTail(ready, ["cartographer", "ledger"]), /report:cartographer/);
	assert.throws(() => selectorMessages({ ...record, active: { kind: "selector", previousSpeaker: "invented" } }), /unvalidated state|invalid previous/i, "a corrupt routing record cannot widen a native grammar");
	assert.throws(() => selectorTail(record, ["cartographer", "atlas"]), /immediately prior participant/, "a caller cannot reinsert the prior speaker into an explicit eligible set");
});

test("conference recovery resumes a pending native selector and commits its labelled handoff once", async (t) => {
	const { root, brainDir } = fresh(t);
	const server = await startStandIn({ tokenDelayMs: 0 });
	t.after(() => server.close());
	const conference = createConferenceCapture({
		root,
		brainDir,
		question: "Which fresh perspective should inspect the recovery boundary?",
		myPersona: "Keep the host handoff auditable.",
		model: { provider: "local", modelId: "stand-in" },
		caller: { conversationId: "parent", taskId: "outer", callId: "consult" },
		at: 1,
	});
	attachChildConference(brainDir, conference.id, "recovery-child", 2);
	// This is the durable state a process can leave after recording a no-tool turn
	// and before it finishes the raw selector HTTP call.
	recordParticipantTurn(brainDir, conference.id, "cartographer", { content: [{ type: "text", text: "The opening contribution survived the restart." }] }, 3);
	assert.equal(loadConference(brainDir, conference.id).conference.active.kind, "selector");

	const extension = createConferenceExtension({ brainDir, server: server.url });
	const generation = extension.hooks.find((entry) => entry.task === "pi.generation").handlers;
	const planned = await generation.beforeRequest({ messages: [{ role: "user", content: "Conference entry packet" }] }, { conversationId: "recovery-child", now: () => 4 });
	const joined = planned.messages.map((message) => message.content).join("\n");
	assert.match(joined, /Native GBNF selected atlas to continue the bounded debate/, "recovery recreates the labelled host handoff before the selected participant request");
	assert.match(joined, /You are Atlas \(atlas\)/, "the recovered request uses the selected participant's private tail");
	assert.equal(server.nativeRequests.length, 2, "cold recovery first proves native enforcement, then makes its bounded selector decision");
	const [capability, selector] = server.nativeRequests;
	assert.equal(capability.tools, undefined);
	assert.match(capability.grammar, /"cartographer"/);
	assert.equal(selector.tools, undefined);
	assert.match(selector.grammar, /"continue:atlas"/);
	assert.doesNotMatch(selector.grammar, /"continue:cartographer"/);
	assert.doesNotMatch(selector.grammar, /"report:cartographer"/, "a recovered one-member opening cannot skip the debate gate");
	const resumed = loadConference(brainDir, conference.id).conference;
	assert.equal(resumed.active.participant, "atlas");
	assert.equal(resumed.active.nativeSelectionPending, undefined, "the restart path consumes the handoff marker before a provider request can replay it");
	assert.equal(resumed.selectorEvents.length, 1);
	assert.equal(resumed.requestPlans.filter((plan) => plan.kind === "native-selector").length, 1);
	assert.equal(generation.onYield({ stopReason: "stop", content: [] }, { conversationId: "recovery-child", now: () => 5 }), undefined, "a recovered handoff is not appended again after Atlas speaks");
});

test("conference C2/C3: entry snapshots stay immutable, persona tails are private, and routing excludes the previous speaker", (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(root, "source.txt"), "one\ntwo\nthree\n");
	const conference = createConferenceCapture({
		root,
		brainDir,
		question: "Which bounded migration is safer?",
		context: "Caller fact A.",
		files: [{ path: "source.txt", range: "2-3" }],
		myPersona: "Care about a reversible migration boundary.",
		model: { provider: "local", modelId: "fixture" },
		caller: { conversationId: "main", taskId: "task-1", callId: "call-1" },
		at: 1,
	});
	assert.equal(conference.id, "co1");
	assert.equal(readConferenceSource(brainDir, conference, "s1").text, "two\nthree");
	writeFileSync(join(root, "source.txt"), "mutated live project bytes\n");
	assert.equal(readConferenceSource(brainDir, loadConference(brainDir, "co1").conference, "s1").text, "two\nthree", "the conference reads its frozen source, not the changed project path");
	assert.throws(() => readConferenceSource(brainDir, conference, "b-atlas"), /only inspect c0 or one captured s<N> source/);
	assert.throws(() => createConferenceCapture({ root, brainDir, question: "q", myPersona: "p", files: ["../escape.txt"], model: {}, caller: {} }), /Supplied file refused/);
	assert.throws(() => createConferenceCapture({ root, brainDir, question: "q", myPersona: "p", files: [{ path: "source.txt", range: "1-99999" }], model: {}, caller: {} }), /at most/);

	const running = attachChildConference(brainDir, conference.id, "conference-child", 2);
	const opening = participantTail(withConferenceBrain(running, brainDir));
	assert.match(opening, /Care about a reversible migration boundary/);
	assert.doesNotMatch(opening, /Atlas entry snapshot/);
	recordParticipantTurn(brainDir, conference.id, "cartographer", { content: [{ type: "text", text: "Opening contribution." }] }, 3);
	assert.throws(() => recordSelectorChoice(brainDir, conference.id, "continue:cartographer", { at: 4 }), /not an eligible native decision/);
	recordSelectorChoice(brainDir, conference.id, "continue:atlas", { at: 4 });
	const atlas = loadConference(brainDir, conference.id).conference;
	const atlasTail = participantTail(withConferenceBrain(atlas, brainDir));
	assert.match(atlasTail, /You are Atlas \(atlas\)/);
	assert.match(atlasTail, /empty snapshot/);
	assert.doesNotMatch(atlasTail, /Care about a reversible migration boundary/, "the next participant never inherits Cartographer's request-local persona");
	const neutral = selectorTail({ ...running, turns: [{ participant: "cartographer" }], active: { kind: "selector", previousSpeaker: "cartographer" } });
	assert.match(neutral, /continue:atlas, continue:ledger, continue:plan, continue:assessment, continue:context/);
	assert.doesNotMatch(neutral, /Care about a reversible migration boundary/);
	assert.doesNotMatch(neutral, /Atlas entry snapshot/);
	assert.equal(loadConference(brainDir, conference.id).conference.turns[0].participant, "cartographer");
	assert.equal(loadConference(brainDir, conference.id).conference.selectorEvents[0].participant, "atlas");
});

test("conference C4: request-plan audit retention stays bounded with monotonic provenance indexes", (t) => {
	const { root, brainDir } = fresh(t);
	const conference = createConferenceCapture({ root, brainDir, question: "Bound the audit.", myPersona: "Keep the handoff evidence finite.", model: {}, caller: {}, at: 1 });
	const total = POLICY.limits.conference.requestPlans + 3;
	for (let index = 0; index < total; index++) {
		recordRequestPlan(brainDir, conference.id, index % 2 === 0 ? "participant" : "selector", [{ role: "user", content: `stable ${index}` }], `tail ${index}`, index + 2);
	}
	const bounded = loadConference(brainDir, conference.id).conference;
	assert.equal(bounded.requestPlans.length, POLICY.limits.conference.requestPlans);
	assert.equal(bounded.requestPlanCount, total);
	assert.equal(bounded.requestPlans[0].index, total - POLICY.limits.conference.requestPlans + 1);
	assert.equal(bounded.requestPlans.at(-1).index, total);
	assert.match(renderConference(bounded), new RegExp(`${total} total`));
});

test("conference C4: private activity and receipt retention use durable event identities and bounded monotonic indexes", (t) => {
	const { root, brainDir } = fresh(t);
	const conference = createConferenceCapture({ root, brainDir, question: "Can the audit remain bounded?", myPersona: "Keep every retained response attributable.", model: {}, caller: {}, at: 1 });
	attachChildConference(brainDir, conference.id, "retention-child", 2);
	const repeated = { stopReason: "toolUse", content: [{ type: "text", text: "The same short local observation." }, { type: "toolCall", id: "same-local-call", name: "consult_source", arguments: { action: "list" } }] };
	const totalActivities = POLICY.limits.conference.activities + 3;
	for (let index = 1; index <= totalActivities; index++) recordParticipantActivity(brainDir, conference.id, "cartographer", repeated, index + 1, `generation-${index}`);
	// A restart of one generation must not create another activity, but identical words from another generation do.
	recordParticipantActivity(brainDir, conference.id, "cartographer", repeated, totalActivities + 2, `generation-${totalActivities}`);
	let bounded = loadConference(brainDir, conference.id).conference;
	assert.equal(bounded.activities.length, POLICY.limits.conference.activities);
	assert.equal(bounded.activityCount, totalActivities);
	assert.equal(bounded.activities[0].index, totalActivities - POLICY.limits.conference.activities + 1);
	assert.equal(bounded.activities.at(-1).index, totalActivities);
	assert.equal(bounded.activities.at(-1).eventId, `generation-${totalActivities}`);

	const totalReceipts = POLICY.limits.conference.toolReceipts + 3;
	for (let index = 1; index <= totalReceipts; index++) {
		recordToolReceipt(brainDir, conference.id, { id: `source-${index}`, callId: `call-${index}`, participant: "cartographer", action: "list", result: `listed source snapshot ${index}`, at: new Date(index).toISOString() });
	}
	// A replay of the most recent tool call keeps the original receipt rather than duplicating it.
	recordToolReceipt(brainDir, conference.id, { id: `source-${totalReceipts}`, callId: `call-${totalReceipts}`, participant: "cartographer", action: "list", result: "replayed", at: new Date(totalReceipts).toISOString() });
	bounded = loadConference(brainDir, conference.id).conference;
	assert.equal(bounded.toolReceipts.length, POLICY.limits.conference.toolReceipts);
	assert.equal(bounded.toolReceiptCount, totalReceipts);
	assert.equal(bounded.toolReceipts[0].index, totalReceipts - POLICY.limits.conference.toolReceipts + 1);
	assert.equal(bounded.toolReceipts.at(-1).index, totalReceipts);
	assert.match(renderConference(bounded), new RegExp(`${totalActivities} total`));
	assert.match(renderConference(bounded), new RegExp(`${totalReceipts} total`));
});

test("conference C4: a recovered completed turn is idempotent after the selector has advanced", (t) => {
	const { root, brainDir } = fresh(t);
	const conference = createConferenceCapture({ root, brainDir, question: "Can recovered turns replay safely?", myPersona: "Keep audit provenance stable.", model: {}, caller: {}, at: 1 });
	attachChildConference(brainDir, conference.id, "replay-child", 2);
	const response = { id: "durable-generation-7", content: [{ type: "text", text: "The first member completed this contribution." }] };
	recordParticipantTurn(brainDir, conference.id, "cartographer", response, 3, "durable-generation-7");
	recordSelectorChoice(brainDir, conference.id, "continue:atlas", { at: 4 });
	const before = loadConference(brainDir, conference.id).conference;
	assert.equal(before.active.participant, "atlas");
	// Durable may replay its afterResponse hook after the selector has moved on. This must be an idempotent no-op,
	// not an active-speaker failure and not a second activity/turn.
	const replayed = recordParticipantTurn(brainDir, conference.id, "cartographer", response, 5, "durable-generation-7");
	assert.equal(replayed.active.participant, "atlas");
	const after = loadConference(brainDir, conference.id).conference;
	assert.equal(after.activities.length, 1);
	assert.equal(after.turns.length, 1);
	assert.equal(after.selectorEvents.length, 1);
	assert.equal(after.activities[0].eventId, "durable-generation-7");
	assert.equal(after.turns[0].eventId, "durable-generation-7");
});

test("conference C4: tool activity keeps its speaker, malformed returns and limits preserve an auditable incomplete state, and a valid return carries provenance", async (t) => {
	const { root, brainDir } = fresh(t);
	const server = await startStandIn({ tokenDelayMs: 0 });
	t.after(() => server.close());
	writeFileSync(join(root, "packet.txt"), "captured evidence\n");
	const captured = createConferenceCapture({
		root,
		brainDir,
		question: "How should the bounded conference end?",
		context: "captured context",
		files: ["packet.txt"],
		myPersona: "Opening perspective.",
		model: { provider: "local", modelId: "fixture" },
		caller: { conversationId: "parent", taskId: "outer-tool", callId: "call-consult" },
		at: 1,
	});
	attachChildConference(brainDir, captured.id, "conference-child", 2);
	assert.throws(() => completeConference(brainDir, captured.id, "cartographer", { outcome: "answered", synthesis: "Opening prose is not a host-authorized conclusion." }, 3), /host-authorized Cartographer report state/, "a direct storage call cannot turn the opening contribution into a final advisory");
	const extension = createConferenceExtension({ brainDir, server: server.url });
	const generation = extension.hooks.find((entry) => entry.task === "pi.generation").handlers;
	const source = extension.tools.find((tool) => tool.name === "consult_source");
	const returned = extension.tools.find((tool) => tool.name === "consult_return");
	assert.equal(extension.tools.length, 2, "the child exposes only participant tools; native selection is outside Durable's tool registry");
	const api = { conversationId: "conference-child", now: () => 10 };

	await generation.afterResponse({ stopReason: "toolUse", content: [
		{ type: "text", text: "I will inspect the packet before I hand off." },
		{ type: "toolCall", id: "source-1", name: "consult_source", arguments: { action: "read", id: "s1" } },
	] }, api);
	const afterToolResponse = loadConference(brainDir, captured.id).conference;
	assert.deepEqual(afterToolResponse.active, { kind: "participant", participant: "cartographer", opening: true }, "text plus a tool call does not trigger a selector handoff");
	assert.deepEqual(afterToolResponse.activities.map((activity) => [activity.participant, activity.reasoning, activity.prose, activity.calls?.[0]?.name]), [["cartographer", undefined, "I will inspect the packet before I hand off.", "consult_source"]], "the private co<N> audit retains a persona-attributed response and local call without placing it in parent context");
	const read = await source.execute({ action: "read", id: "s1" }, api);
	assert.equal(read.isError, undefined);
	assert.match(read.output[0].text, /captured evidence/);
	assert.equal(loadConference(brainDir, captured.id).conference.toolReceipts.length, 1);
	assert.match(loadConference(brainDir, captured.id).conference.toolReceipts[0].result, /captured evidence/, "a consult-local tool receipt retains its bounded result for the separate audit view");

	await generation.afterResponse({ stopReason: "stop", content: [{ type: "text", text: "My completed contribution." }] }, api);
	let running = loadConference(brainDir, captured.id).conference;
	assert.equal(running.active.kind, "participant");
	assert.equal(running.active.participant, "atlas", "the raw native grammar selector activates the validated next participant");
	assert.equal(running.turns.length, 1, "only the no-tool response closes the participant turn");
	assert.equal(running.active.phase, "debate");
	assert.equal(running.selectorEvents[0].method, "llama.cpp-native-gbnf");
	assert.equal(running.selectorEvents[0].grammarEnforced, true);
	assert.match(generation.onYield({ stopReason: "stop", content: [] }, api).continue, /Native GBNF selected atlas to continue the bounded debate/);
	assert.equal(loadConference(brainDir, captured.id).conference.active.nativeSelectionPending, undefined, "the labelled host continuation is consumed exactly once");

	const premature = await returned.execute({ outcome: "needs_input", synthesis: "A choice is needed.", evidence: [{ source: "not-a-source", claim: "invented citation" }] }, api);
	assert.equal(premature.isError, true);
	assert.match(premature.output[0].text, /host must first make a native-GBNF report decision/i);
	running = loadConference(brainDir, captured.id).conference;
	assert.equal(running.status, "running");
	assert.equal(running.active.participant, "atlas", "a deliberating participant cannot end the conference even by calling the registered tool directly");
	assert.equal(running.active.phase, "debate");
	assert.throws(() => validateConsultReturn({ outcome: "answered", synthesis: "x", alternatives: [{ option: "", tradeoff: "missing option" }] }), /alternatives/);

	await generation.afterResponse({ stopReason: "stop", content: [{ type: "text", text: "Atlas completed the second bounded contribution." }] }, api);
	running = loadConference(brainDir, captured.id).conference;
	assert.equal(running.active.participant, "cartographer");
	assert.equal(running.active.phase, "report", "the native selector alone advances a completed debate to Cartographer's report state");
	assert.equal(running.turns.length, 2);
	assert.equal(running.selectorEvents.at(-1).decision, "report");
	assert.match(generation.onYield({ stopReason: "stop", content: [] }, api).continue, /Native GBNF authorized Cartographer to write the final advisory report/);
	assert.equal(loadConference(brainDir, captured.id).conference.active.nativeSelectionPending, undefined);

	const malformed = await returned.execute({ outcome: "needs_input", synthesis: "A choice is needed.", evidence: [{ source: "not-a-source", claim: "invented citation" }] }, api);
	assert.equal(malformed.isError, true);
	running = loadConference(brainDir, captured.id).conference;
	assert.equal(running.status, "running");
	assert.equal(running.active.participant, "cartographer", "a malformed host-authorized return leaves Cartographer active to correct it");
	assert.equal(running.active.phase, "report");

	const final = await returned.execute({
		outcome: "answered",
		synthesis: "Use the captured evidence and keep the conclusion advisory.",
		evidence: [{ source: "c0", claim: "The caller captured bounded common context." }],
		uncertainties: ["No live project verification happened."],
	}, api);
	assert.equal(final.isError, undefined);
	assert.equal(final.control.terminate, true);
	const returnedRecord = loadConference(brainDir, captured.id).conference;
	assert.equal(returnedRecord.status, "returned");
	assert.deepEqual(returnedRecord.final.provenance.participantPacket, { kind: "opening-persona", id: "myPersona", digest: returnedRecord.myPersona.digest });
	assert.deepEqual(returnedRecord.final.provenance.selectorHistory.map((event) => [event.after, event.participant, event.decision]), [["cartographer", "atlas", "continue"], ["atlas", "cartographer", "report"]]);
	assert.match(renderConference(returnedRecord), /authorize Cartographer final report/);
	assert.match(renderConference(returnedRecord), /grammar enforced yes/);
	assert.match(conferenceStatusLine(returnedRecord), /returned/);

	const limited = createConferenceCapture({ root, brainDir, question: "What if output ends?", myPersona: "Bound the output.", model: {}, caller: {}, at: 20 });
	attachChildConference(brainDir, limited.id, "limited-child", 21);
	await generation.afterResponse({ stopReason: "length", content: [{ type: "text", text: "partial" }] }, { conversationId: "limited-child", now: () => 22 });
	const limitedRecord = loadConference(brainDir, limited.id).conference;
	assert.equal(limitedRecord.status, "interrupted");
	assert.equal(limitedRecord.final, undefined, "an output limit never fabricates a synthesis");
	assert.match(renderConference(limitedRecord), /No synthesis was fabricated/);

	const cancelled = createConferenceCapture({ root, brainDir, question: "What if routing is stopped?", myPersona: "Keep cancellation explicit.", model: { provider: "local", modelId: "stand-in" }, caller: {}, at: 30 });
	attachChildConference(brainDir, cancelled.id, "cancelled-selector-child", 31);
	const controller = new AbortController();
	controller.abort();
	await generation.afterResponse({ stopReason: "stop", content: [{ type: "text", text: "A turn whose native routing was stopped." }] }, { conversationId: "cancelled-selector-child", now: () => 32 }, { abortSignal: controller.signal });
	const cancelledRecord = loadConference(brainDir, cancelled.id).conference;
	assert.equal(cancelledRecord.status, "cancelled", "aborting an in-flight raw selector preserves cancellation instead of recording a generic failure");
	assert.match(cancelledRecord.ended.reason, /native selector/i);

	const chat = createChat({ readConference: (id) => id === captured.id ? returnedRecord : undefined });
	chat.entry(0, { id: "entry-1", conversationId: "parent", model: [
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "consult-call", name: "consult", arguments: { question: captured.question, myPersona: captured.myPersona.text } }] },
		{ role: "toolResult", toolCallId: "consult-call", toolName: "consult", isError: false, details: { conference: captured.id }, content: [{ type: "text", text: "Only the compact parent receipt." }] },
	] });
	const group = chat.items.find((item) => item.type === "group");
	const viewText = (instance, projection) => instance.lines(120, projection).map((line) => line.spans.map(([text]) => text).join("")).join("\n");
	assert.doesNotMatch(viewText(chat, "work"), /Consult conference|Only the compact parent receipt/, "the parent Work projection has no conference notebook or receipt");
	assert.equal(chat.textOf(group.key, 0), "Private consultation activity is available only in Chat · Consult.", "copying a hidden parent pointer cannot export conference activity");
	assert.match(viewText(chat, "consult"), /Consultation co1/, "only Consult reads the local co<N> notebook");

	let liveAudit = { ...returnedRecord, status: "running", final: undefined, ended: undefined, active: { kind: "participant", participant: "cartographer" } };
	const liveChat = createChat({ readConference: () => liveAudit });
	liveChat.entry(0, { id: "entry-live", conversationId: "parent", model: [
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "consult-live", name: "consult", arguments: { question: captured.question, myPersona: captured.myPersona.text } }] },
	] });
	liveChat.liveTools(0, [{ callId: "consult-live", status: "running", details: { conference: captured.id } }]);
	assert.match(viewText(liveChat, "consult"), /Cartographer · active/, "Consult reads live conference status without exposing it through parent Work");
	liveAudit = { ...liveAudit, active: { kind: "participant", participant: "atlas" } };
	assert.match(viewText(liveChat, "consult"), /Atlas · active/, "Consult refreshes its private audit while the conference progresses");
	assert.doesNotMatch(viewText(liveChat, "work"), /Cartographer · active|Atlas · active/, "Work remains isolated from private conference activity");
});

test("conference C4: an authorized report that omits consult_return fails closed", async (t) => {
	const { root, brainDir } = fresh(t);
	const conference = createConferenceCapture({ root, brainDir, question: "Must a report use the terminal boundary?", myPersona: "Preserve the final-return contract.", model: { provider: "local", modelId: "fixture" }, caller: {}, at: 1 });
	attachChildConference(brainDir, conference.id, "report-child", 2);
	recordParticipantTurn(brainDir, conference.id, "cartographer", { content: [{ type: "text", text: "Opening contribution." }] }, 3);
	recordSelectorChoice(brainDir, conference.id, "continue:atlas", { at: 4 });
	recordParticipantTurn(brainDir, conference.id, "atlas", { content: [{ type: "text", text: "Second contribution." }] }, 5);
	recordSelectorChoice(brainDir, conference.id, "report:cartographer", { at: 6 });
	const extension = createConferenceExtension({ brainDir, server: "http://unused.invalid" });
	const generation = extension.hooks.find((entry) => entry.task === "pi.generation").handlers;
	const api = { conversationId: "report-child", now: () => 7 };
	assert.match(generation.onYield({ stopReason: "stop", content: [] }, api).continue, /authorized Cartographer to write the final advisory report/);
	await generation.afterResponse({ stopReason: "stop", content: [{ type: "text", text: "An unstructured final-looking sentence." }] }, api);
	const failed = loadConference(brainDir, conference.id).conference;
	assert.equal(failed.status, "failed");
	assert.equal(failed.final, undefined);
	assert.match(failed.ended.reason, /ended without consult_return/);
	assert.match(renderConference(failed), /No synthesis was fabricated/);
});

test("conference C4: recovery resumes the captured child and captured model rather than allocating or adopting a later model", async (t) => {
	const { root, brainDir } = fresh(t);
	const server = await startStandIn({ tokenDelayMs: 0 });
	t.after(() => server.close());
	const captured = createConferenceCapture({
		root,
		brainDir,
		question: "Can recovery preserve the model boundary?",
		myPersona: "Keep recovery deterministic.",
		model: { provider: "frozen-provider", modelId: "frozen-model" },
		caller: { conversationId: "caller", taskId: "recover-task", callId: "recover-call" },
		at: 1,
	});
	const selected = [];
	const submissions = [];
	const frozenModel = { provider: "frozen-provider", id: "frozen-model", api: "openai-completions", baseUrl: server.url };
	const models = {
		getModel(provider, modelId) {
			selected.push([provider, modelId]);
			return provider === "frozen-provider" && modelId === "frozen-model" ? frozenModel : undefined;
		},
	};
	const tool = consultTool({ root, brainDir, config: {}, conferenceExtension: { name: "consult-conference", tools: [{}, {}] } });
	const api = {
		conversationId: "caller",
		taskId: "recover-task",
		callId: "recover-call",
		now: () => 3,
		models,
		agent: async () => { throw new Error("a resumed conference must not read a later caller model"); },
		commit: async (work) => work({
			createConversation: async () => { throw new Error("a resumed conference must not create another child"); },
			scanConversations: async () => ({ items: [{ id: "unrelated-child", parent: { at: 1 } }, { id: "existing-private-child", parent: { at: 1 } }] }),
			scanEntries: async ({ conversationId }) => ({ items: [{ conversationId, kind: "carto.conference-seed", data: { conference: conversationId === "existing-private-child" ? captured.id : "co999", version: captured.version } }] }),
		}),
		details: async () => {},
		conversation: async (id) => {
			assert.equal(id, "existing-private-child");
			return {
				submit: async (input) => {
					submissions.push(input);
					recordParticipantTurn(brainDir, captured.id, "cartographer", { content: [{ type: "text", text: "Recovered opening contribution." }] }, 4);
					recordSelectorChoice(brainDir, captured.id, "continue:atlas", { at: 5 });
					recordParticipantTurn(brainDir, captured.id, "atlas", { content: [{ type: "text", text: "Recovered second contribution." }] }, 6);
					recordSelectorChoice(brainDir, captured.id, "report:cartographer", { at: 7 });
					completeConference(brainDir, captured.id, "cartographer", { outcome: "answered", synthesis: "Recovered from the existing isolated child.", evidence: [], assumptions: [], uncertainties: [], alternatives: [], next_checks: [] }, 8);
					return { wait: async () => ({ status: "done" }) };
				},
				abort: async () => {},
			};
		},
	};
	const result = await tool.execute({ question: captured.question, myPersona: captured.myPersona.text }, api, undefined);
	assert.equal(result.isError, undefined, result.output[0].text);
	assert.deepEqual(selected, [["frozen-provider", "frozen-model"]]);
	assert.deepEqual(submissions, [{ type: "continue", requestId: "consult:recover-task" }]);
	const resumed = loadConference(brainDir, captured.id).conference;
	assert.equal(resumed.childConversationId, "existing-private-child");
	assert.equal(resumed.status, "returned");
	assert.match(result.output[0].text, /Recovered from the existing isolated child/);
});

test("conference C4: stopping the outer tool records cancellation rather than a made-up answer", async (t) => {
	const { root, brainDir } = fresh(t);
	writeFileSync(join(brainDir, "config.json"), JSON.stringify({ initiate: false, prefill: false }));
	const server = await startStandIn({
		tokenDelayMs: 0,
		holdWhen: (request) => (request.tools ?? []).some((tool) => tool.function?.name === "consult_source")
			&& request.messages.some((message) => typeof message.content === "string" && message.content.includes("Active participant packet")),
	});
	let session;
	t.after(async () => {
		await session?.harness.close(session.context);
		await server.close();
	});
	const config = loadConfig({ brainDir, flags: { url: server.url, model: "stand-in" }, env: { ...process.env, CARTO_CONFIG: join(root, "no-install-config.json"), CARTO_SERVER: "", CARTO_MODEL: "" } });
	session = await openSession({ root, brainDir, config, runner: createRunner() });
	const submitted = await session.main.submit({ type: "input", content: `consult: ${JSON.stringify({ question: "Stop this child.", myPersona: "Observe cancellation." })}` }, session.context);
	const deadline = Date.now() + 2_000;
	while (server.heldCount() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(server.heldCount(), 1, "the test stopped an active participant request, not a completed consultation");
	await session.main.abort(session.context);
	const settled = await submitted.wait(session.context);
	assert.equal(settled.status, "unanswered");
	const cancelled = loadConference(brainDir, "co1").conference;
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.final, undefined);
	assert.match(cancelled.ended.reason, /caller stopped/i);
});


test("conference C4/C5: final objects require an honest structured return and legacy thread revival is refused before model work", async (t) => {
	assert.throws(() => validateConsultReturn({ outcome: "needs_input", synthesis: "Need a choice." }), /blocking_question/);
	assert.deepEqual(validateConsultReturn({ outcome: "answered", synthesis: "Use the frozen packet.", evidence: [{ source: "s1", claim: "The captured file says so." }], uncertainties: ["No live verification yet."] }), {
		outcome: "answered",
		synthesis: "Use the frozen packet.",
		evidence: [{ source: "s1", claim: "The captured file says so." }],
		assumptions: [],
		uncertainties: ["No live verification yet."],
		alternatives: [],
		next_checks: [],
	});
	const { root, brainDir } = fresh(t);
	const tool = consultTool({ root, brainDir });
	const result = await tool.execute({ question: "q", myPersona: "p", thread: "st1" }, {}, undefined);
	assert.equal(result.isError, true);
	assert.match(result.output[0].text, /thread.*removed by the C5 cutover/i);
});
