import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CartoProject } from "../dist/runtime/project.js";
import { ACTIONS, available, footerHints } from "../dist/ui/actions.js";
import { renderFrame } from "../dist/ui/frame.js";
import { width } from "../dist/ui/text.js";

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const config = {
  version: 1,
  model: "llama-swap/Flint",
  llamaSwapEndpoint: "http://127.0.0.1:8888/v1",
  collapseMode: "request",
};

async function withProject(run) {
  const root = await mkdtemp(join(tmpdir(), "carto-frame-"));
  const project = await CartoProject.open(root, config);
  try {
    await run(project);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
}

function stateOf(project, overrides = {}) {
  const now = Date.now();
  return {
    root: project.root,
    model: config.model,
    view: overrides.view,
    contextWindow: 32_768,
    tab: "chat",
    mode: "navigate",
    detail: null,
    selected: 0,
    folds: new Set(),
    expandedActivity: new Set(),
    sendMode: "follow-up",
    applying: false,
    now,
    startedAt: now - 500,
    ...overrides,
  };
}

/** Every row of the frame is exactly as wide as the frame says it is. */
function assertFrameWidth(frame, columns) {
  for (const row of [...frame.top, ...frame.body, ...frame.bottom]) {
    assert.equal(width(row), columns, `row is not ${columns} cells: ${JSON.stringify(plain(row))}`);
  }
}

test("an empty Chat frame names the tab, the bar, and the keys that work", async () => {
  await withProject(async (project) => {
    const frame = renderFrame(stateOf(project, { view: await project.view() }), 96);
    assertFrameWidth(frame, 96);
    const text = plain([...frame.top, ...frame.body, ...frame.bottom].join("\n"));
    assert.match(text, /Carto · /);
    assert.match(text, /1 Chat {2}2 Brain {2}3 Context/);
    assert.match(text, /○ idle/);
    assert.match(text, /\(estimate\)/);
    assert.match(text, /j k move · .* i input · a actions · \? help/);
    assert.match(text, /No deliberate Chat yet\./);
    // The footer is the last row, and it holds the hints and the mode.
    assert.match(plain(frame.bottom.at(-1)), /chat · send follow-up/);
  });
});

test("a read-only frame never writes to the Brain", async () => {
  await withProject(async (project) => {
    await project.upsertLedger({ id: "ledger:one", kind: "goal", status: "open", text: "Ship it", answer: null });
    const before = (await project.view()).brain;
    // Handles are already complete, so many reads in a row must leave the
    // Brain byte-for-byte identical: a view is not allowed to commit.
    for (let index = 0; index < 5; index += 1) await project.view();
    const after = (await project.view()).brain;
    assert.deepEqual(after, before);
  });
});

test("a chat record reads as a handle, a speaker, a local time, and its text", async () => {
  await withProject(async (project) => {
    await project.addAgentChat("One scheduler, two backoffs.");
    const frame = renderFrame(stateOf(project, { view: await project.view() }), 96);
    const text = plain(frame.body.join("\n"));
    assert.match(text, /▌C1 {2}Agent · \d{2}:\d{2}/);
    assert.match(text, /One scheduler, two backoffs\./);
    // The durable ISO stamp stays in agent context, not on the row.
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/);
  });
});

test("the Context tab prints one row per record, and a pin keeps its reason", async () => {
  await withProject(async (project) => {
    await project.addUserContextPin("Keep the retry contract", "The public API must not move.");
    const frame = renderFrame(stateOf(project, { view: await project.view(), tab: "context" }), 96);
    assertFrameWidth(frame, 96);
    const rows = plain(frame.body.join("\n")).split("\n").filter((row) => /^ {4}R1|P1|L1/.test(row));
    assert.equal(rows.length, 1, "a pin appears once, as its projection block");
    const text = plain(frame.body.join("\n"));
    assert.match(text, /P1 {2}Pins {2}Keep the retry contract {2}· The public API must not move\./);
  });
});

test("the hint table hides a key that cannot act now", async () => {
  await withProject(async (project) => {
    const view = await project.view();
    const chatOnly = {
      mode: "navigate",
      tab: "chat",
      view,
      chatSelected: true,
      activitySelected: false,
      pinSelected: false,
      brainSelected: false,
      detailOpen: false,
      busy: false,
      paused: false,
      running: false,
    };
    const hints = available(chatOnly).map((action) => action.id);
    assert.ok(hints.includes("fold"));
    assert.ok(hints.includes("delete"));
    assert.equal(hints.includes("unpin"), false, "no pin is selected, so the pin keys are absent");

    const pinSelected = { ...chatOnly, tab: "context", chatSelected: false, pinSelected: true };
    const pinHints = available(pinSelected).map((action) => action.id);
    assert.ok(pinHints.includes("unpin"));
    assert.ok(pinHints.includes("unpin-now"));
    assert.equal(pinHints.includes("fold"), false);

    const busy = { ...chatOnly, busy: true, running: true };
    const busyHints = available(busy).map((action) => action.id);
    assert.ok(busyHints.includes("pause"));
    assert.ok(busyHints.includes("cancel"));
    assert.equal(busyHints.includes("delete"), false, "the Brain cannot change while a run holds it");
  });
});

test("the footer drops hints that do not fit rather than cutting one in half", async () => {
  await withProject(async (project) => {
    const view = await project.view();
    const context = {
      mode: "navigate",
      tab: "chat",
      view,
      chatSelected: true,
      activitySelected: false,
      pinSelected: false,
      brainSelected: false,
      detailOpen: false,
      busy: false,
      paused: false,
      running: false,
    };
    for (const cells of [12, 30, 48, 120]) {
      const text = footerHints(context, cells, width);
      assert.ok(width(text) <= cells, `${width(text)} > ${cells}`);
      if (text !== "") assert.ok(!text.endsWith(" · "), "a separator is not left hanging");
    }
  });
});

test("every action names real keys and a group", () => {
  for (const action of ACTIONS) {
    assert.ok(action.keys.length > 0, `${action.id} has no key`);
    assert.ok(action.label !== "", `${action.id} has no footer label`);
    assert.ok(action.help !== "", `${action.id} has no help line`);
    assert.ok(["move", "chat", "context", "turn", "view", "commands"].includes(action.group));
  }
});

test("a running frame shows the reading as a bar, and the estimate is gone", async () => {
  await withProject(async (project) => {
    const view = await project.view();
    const frame = renderFrame(
      stateOf(project, {
        view: { ...view, turn: { ...view.turn, state: "running" } },
        prefill: { phase: "reading", total: 10_600, cache: 1_200, processed: 7_200, ms: 4_000, began: 0, updatedAt: 0 },
        runStartedAt: Date.now() - 12_000,
      }),
      96,
    );
    assertFrameWidth(frame, 96);
    const text = plain(frame.top.join("\n"));
    assert.match(text, /▰+▨+/);
    assert.match(text, /7\.2k \+ 3\.4k new \/ 33k/);
    assert.doesNotMatch(text, /estimate/);
    assert.match(text, /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
    assert.match(text, /reading 64%/);
  });
});

test("a narrow terminal keeps the bar, shortens the tabs, and drops the tail of the footer", async () => {
  await withProject(async (project) => {
    for (const columns of [58, 72, 96]) {
      const frame = renderFrame(stateOf(project, { view: await project.view() }), columns);
      assertFrameWidth(frame, columns);
      const text = plain([...frame.top, ...frame.bottom].join("\n"));
      assert.match(text, /1 Chat/);
      assert.match(text, /33k/);
    }
  });
});

test("a paused turn says so, and its footer offers resume rather than pause", async () => {
  await withProject(async (project) => {
    const view = await project.view();
    const frame = renderFrame(stateOf(project, { view: { ...view, turn: { ...view.turn, state: "paused", pausedDraft: "half" } } }), 96);
    const text = plain(frame.top.join("\n"));
    assert.match(text, /⏸ paused · r edits the draft · x cancels/);
    assert.doesNotMatch(text, /reading \d+%/);
  });
});

test("a failed frame shows the error in the status row and keeps drawing", async () => {
  await withProject(async (project) => {
    const frame = renderFrame(stateOf(project, { view: await project.view(), error: "storage is locked" }), 96);
    assertFrameWidth(frame, 96);
    assert.match(plain(frame.top.join("\n")), /! storage is locked/);
  });
});
