import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestProjectFile, inspectProjectFile, MAX_INSPECT_BYTES, resolveProjectWritePath, WorkspaceError } from "../dist/runtime/workspace.js";

test("inspection rejects .brain and links that resolve outside the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "carto-outside-"));
  try {
    await mkdir(join(root, ".brain"));
    await writeFile(join(root, ".brain", "secret.txt"), "private\n", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside\n", "utf8");
    await symlink(join(outside, "outside.txt"), join(root, "outside-link.txt"));
    await symlink(outside, join(root, "outside-directory"));

    await assert.rejects(() => inspectProjectFile(root, { path: ".brain/secret.txt", startLine: 1, endLine: 1 }), WorkspaceError);
    await assert.rejects(
      () => inspectProjectFile(root, { path: "outside-link.txt", startLine: 1, endLine: 1 }),
      /symbolic link resolves outside/,
    );
    await assert.rejects(() => resolveProjectWritePath(root, ".brain/new.txt"), /does not patch .brain/);
    await assert.rejects(() => resolveProjectWritePath(root, "outside-link.txt"), /symbolic link resolves outside/);
    await assert.rejects(() => resolveProjectWritePath(root, "outside-directory/new.txt"), /symbolic link resolves outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a patch-base digest can cover a file larger than an inspect request", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-workspace-large-"));
  const text = "x".repeat(MAX_INSPECT_BYTES + 1);
  try {
    await writeFile(join(root, "large.txt"), text, "utf8");

    await assert.rejects(
      () => inspectProjectFile(root, { path: "large.txt", startLine: 1, endLine: 1 }),
      /reads files up to/,
    );
    assert.equal((await digestProjectFile(root, "large.txt")).digest, createHash("sha256").update(text).digest("hex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection permits a link that resolves inside the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-workspace-link-"));
  try {
    await writeFile(join(root, "inside.txt"), "inside\n", "utf8");
    await symlink("inside.txt", join(root, "inside-link.txt"));

    const inspected = await inspectProjectFile(root, { path: "inside-link.txt", startLine: 1, endLine: 1 });

    assert.equal(inspected.path, "inside.txt");
    assert.equal(inspected.excerpt, "inside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
