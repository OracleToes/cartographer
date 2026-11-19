import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyApprovedPatch, isApprovedPatchApplied, parseUnifiedPatch } from "../dist/runtime/patch.js";

const newFilePatch = [
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "index 0000000..3b18e13",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+new file",
  "",
].join("\n");

test("an applied new-file patch is detectable after an interrupted status commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-new-patch-"));
  const change = {
    id: "change:new",
    rationale: "Create a file.",
    patch: newFilePatch,
    base: [],
    status: "approved",
    createdAt: Date.now(),
    resolvedAt: null,
  };
  try {
    await applyApprovedPatch(root, change);
    assert.equal(await readFile(join(root, "new.txt"), "utf8"), "new file\n");
    assert.equal(await isApprovedPatchApplied(root, change), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a proposal patch cannot reach .brain", () => {
  assert.throws(
    () =>
      parseUnifiedPatch([
        "diff --git a/.brain/brain.sqlite b/.brain/brain.sqlite",
        "--- a/.brain/brain.sqlite",
        "+++ b/.brain/brain.sqlite",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n")),
    /does not patch .brain/,
  );
});
