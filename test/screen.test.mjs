import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { contextMeter, meterCells } from "../dist/domain/meter.js";
import { createPrefillMonitor, parseProgress } from "../dist/runtime/prefill.js";
import { meterRow, meterRowWidth } from "../dist/ui/meter-bar.js";
import { spinnerChanged, spinnerFrame } from "../dist/ui/spinner.js";
import { statusLine } from "../dist/ui/state.js";
import { duration, clock, rate, short, width } from "../dist/ui/text.js";
import { row } from "../dist/ui/chrome.js";

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const WINDOW = 32_768;
const CAP = 16_000;

test("a token count reads at the magnitude a person needs", () => {
  assert.equal(short(0), "0");
  assert.equal(short(950), "950");
  assert.equal(short(9_400), "9.4k");
  assert.equal(short(32_768), "33k");
  assert.equal(short(123_456), "123k");
  assert.equal(short(Number.NaN), "?");
});

test("a clock, a pause, and a rate use the shortest form that stays exact", () => {
  assert.match(clock(Date.now()), /^\d{2}:\d{2}$/);
  assert.equal(duration(800), "800ms");
  assert.equal(duration(1_250), "1.3s");
  assert.equal(duration(75_000), "1m 15s");
  assert.equal(rate(1_400, 1_000), "1.4k tok/s");
  assert.equal(rate(0, 0), "?");
});

test("a two-part row fills its width exactly, and the right part survives", () => {
  const wide = row("left side of the row", "right", 20);
  assert.equal(width(wide), 20);
  assert.ok(plain(wide).endsWith("right"));
  const narrow = row("a very long left part", "right", 10);
  assert.equal(width(narrow), 10);
  assert.ok(plain(narrow).endsWith("right"));
  // The right part is the state, so it survives even with no room left.
  const none = row("left", "right", 5);
  assert.equal(width(none), 5);
  assert.ok(plain(none).endsWith("right"));
});

test("the meter uses the real window and marks the budget inside it", () => {
  const meter = contextMeter({ window: WINDOW, cap: CAP, reading: { total: 10_600, cache: 1_200, processed: 7_200 } });
  assert.equal(meter.source, "server");
  assert.equal(meter.filled, 7_200);
  assert.equal(meter.changing, 3_400);
  assert.equal(meter.overCap, false);
  assert.equal(meter.percent, 32);
  const cells = meterCells(meter, 20);
  assert.equal(cells.filled + cells.changing + cells.free, 20);
  // The budget is at half the window, so the mark is in the middle cell range.
  assert.equal(cells.capIndex, 9);
  assert.equal(cells.capShown, true);
});

test("the meter keeps the estimate distinct until a server reports", () => {
  const estimate = contextMeter({ window: WINDOW, cap: CAP, estimate: 3_200 });
  assert.equal(estimate.source, "estimate");
  assert.equal(estimate.filled, 0);
  assert.equal(estimate.changing, 3_200);
  const row = plain(meterRow(estimate, 20));
  assert.match(row, /^▤+/);
  assert.match(row, /~3\.2k/);
  assert.match(row, /\(estimate\)$/);
});

test("a reading moves the changing cells into the filled cells as the server reads", () => {
  const early = meterCells(contextMeter({ window: WINDOW, cap: CAP, reading: { total: 10_600, cache: 1_200, processed: 2_000 } }), 20);
  const late = meterCells(contextMeter({ window: WINDOW, cap: CAP, reading: { total: 10_600, cache: 1_200, processed: 9_600 } }), 20);
  assert.ok(late.filled > early.filled);
  assert.ok(late.changing < early.changing);
  assert.equal(late.filled + late.changing, early.filled + early.changing);
});

test("a bar never draws more cells than it has, and its parts add up", () => {
  for (const estimate of [0, 1, 999, 16_000, 32_768, 40_000]) {
    for (const cells of [0, 1, 10, 20, 41]) {
      const parts = meterCells(contextMeter({ window: WINDOW, cap: CAP, estimate }), cells);
      assert.equal(parts.filled + parts.changing + parts.free, cells);
      assert.ok(parts.filled >= 0 && parts.changing >= 0 && parts.free >= 0);
      if (parts.capShown) assert.ok(parts.capIndex >= parts.filled + parts.changing);
    }
  }
});

test("a bar past the window says so instead of clamping silently", () => {
  const meter = contextMeter({ window: WINDOW, cap: CAP, reading: { total: 40_000, cache: 0, processed: 20_000 } });
  assert.equal(meter.overWindow, true);
  const row = plain(meterRow(meter, 20));
  assert.match(row, /over window by 7\.2k/);
  assert.match(row, /over cap by 24k/);
});

test("a measured row reports the width it draws", () => {
  const meter = contextMeter({ window: WINDOW, cap: CAP, estimate: 3_200 });
  for (const cells of [0, 10, 20]) {
    assert.equal(meterRowWidth(meter, cells), width(meterRow(meter, cells)));
  }
});

test("the spinner advances a frame every 100 ms", () => {
  assert.equal(spinnerFrame(0), "⠋");
  assert.equal(spinnerFrame(99), "⠋");
  assert.equal(spinnerFrame(100), "⠙");
  assert.equal(spinnerChanged(0, 50), false);
  assert.equal(spinnerChanged(0, 100), true);
});

test("the status line names the state, and only a live state spins", () => {
  const idle = statusLine({
    view: { turn: { state: "idle" }, activity: [], error: null },
    now: 0,
    applying: false,
  });
  assert.equal(idle.spinning, false);
  assert.equal(idle.text, "idle");

  const reading = statusLine({
    view: { turn: { state: "running" }, activity: [], error: null },
    prefill: { phase: "reading", total: 10_000, cache: 2_000, processed: 6_000, ms: 1_000, began: 0, updatedAt: 0 },
    now: 1_000,
    applying: false,
  });
  assert.equal(reading.spinning, true);
  assert.match(reading.text, /reading 50%/);

  const stopping = statusLine({
    view: { turn: { state: "cancelling" }, activity: [], error: null },
    now: 0,
    applying: false,
  });
  assert.equal(stopping.spinning, true);
  assert.match(stopping.text, /stopping/);

  const failed = statusLine({
    view: { turn: { state: "idle" }, activity: [], error: "model refused" },
    now: 0,
    applying: false,
  });
  assert.equal(failed.mark, "!");
  assert.equal(failed.spinning, false);
});

test("a progress line parses, and anything else is ignored", () => {
  const line = `data: ${JSON.stringify({ prompt_progress: { total: 8_000, cache: 500, processed: 3_000, time_ms: 900 } })}`;
  assert.deepEqual(parseProgress(line), { total: 8_000, cache: 500, processed: 3_000, time_ms: 900 });
  assert.equal(parseProgress(`data: ${JSON.stringify({ choices: [] })}`), undefined);
  assert.equal(parseProgress("data: {broken"), undefined);
});

test("the monitor asks llama.cpp for progress and reads the reply a second time", async () => {
  const seen = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    seen.push({ headers: request.headers, body: JSON.parse(text) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ prompt_progress: { total: 6_000, cache: 1_000, processed: 3_000, time_ms: 400 } })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Ready." }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const monitor = createPrefillMonitor({ provider: "llama-swap", fetch: globalThis.fetch });
    const models = monitor.wrap({
      stream: async () => ({ ok: true }),
      streamSimple: async (model, context, options) => {
        const payload = await options.onPayload({ model: "Flint", stream: true });
        const response = await options.fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        // The caller's body is the server's body: the side read must not
        // consume or alter it. Pi's own parser ignores the progress frames.
        const text = await response.text();
        return { ok: true, text };
      },
    });

    const result = await models.streamSimple({ provider: "llama-swap" }, {}, {});
    assert.equal(result.ok, true);
    assert.match(result.text, /Ready\./);
    assert.match(result.text, /"finish_reason":"stop"/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.return_progress, true);
    assert.equal(seen[0].headers.authorization, undefined);

    // The side stream is read asynchronously; let it finish before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const state = monitor.current();
    assert.ok(state !== undefined);
    assert.equal(state.total, 6_000);
    assert.equal(state.cache, 1_000);
    assert.equal(state.processed, 3_000);
    assert.equal(state.ms, 400);
    assert.equal(state.phase, "writing");
    monitor.dispose();
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  }
});

test("a provider other than llama-swap is not touched", async () => {
  let called = false;
  const monitor = createPrefillMonitor({ provider: "llama-swap" });
  const models = monitor.wrap({
    stream: async () => ({ called: true }),
    streamSimple: async () => ({ called: true }),
  });
  // `streamSimple` is what the Harness calls; the wrong-provider request must
  // reach the original untouched, and must not start a reading.
  const result = await models.streamSimple({ provider: "openai" }, {}, {});
  called = result.called;
  assert.equal(called, true);
  assert.equal(monitor.current(), undefined);
  monitor.dispose();
});
