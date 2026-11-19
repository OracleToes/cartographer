import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MiniProject } from "../dist/runtime/project.js";

const config = { version: 1, model: "openai/gpt-4.1-mini", collapseMode: "request" };

test("a project rotates one live context into one archive on confirmed collapse", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-project-"));
  const project = await MiniProject.open(root, config);
  try {
    const first = await project.view();
    assert.ok(first.brain.context.liveGeneration);
    assert.equal(first.brain.context.archiveGeneration, null);

    await project.requestCollapse();
    assert.equal((await project.view()).brain.activity.kind, "waiting-for-collapse");

    await project.confirmCollapse();
    const second = await project.view();
    assert.ok(second.brain.context.liveGeneration);
    assert.notEqual(second.brain.context.liveGeneration, first.brain.context.liveGeneration);
    assert.equal(second.brain.context.archiveGeneration, first.brain.context.liveGeneration);
    assert.equal(second.brain.activity.kind, "idle");

    const files = await readdir(join(root, ".brain", "context"));
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 2);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});
