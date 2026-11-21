import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { emptyBrain } from "../dist/domain/records.js";
import { AnchorError, atlasAttachedPaths, formatSize, projectTreeBlock, scanTree } from "../dist/runtime/project-tree.js";

const at = (iso) => Date.parse(iso);
const fileAttachment = (path) => ({ kind: "file", path });
const atlasNode = (id, attachments) => ({ id, title: `title ${id}`, text: `text ${id}`, links: [], attachments, createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:00:00.000Z") });

const makeProject = () => {
  const root = mkdtempSync(join(tmpdir(), "carto-tree-"));
  mkdirSync(join(root, "src/domain"), { recursive: true });
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "MINI.md"), Buffer.alloc(2048));
  writeFileSync(join(root, "src/cli.ts"), Buffer.alloc(512));
  writeFileSync(join(root, "src/domain/records.ts"), Buffer.alloc(1536));
  symlinkSync(join(root, "src/domain"), join(root, "linked-dir"), "dir");
  // The agent does not see the Brain: present once here so the skip is tested
  // against a populated store, including an unreadable-looking WAL.
  mkdirSync(join(root, ".brain/context"), { recursive: true });
  writeFileSync(join(root, ".brain/brain.sqlite"), Buffer.alloc(4096));
  writeFileSync(join(root, ".brain/context/live.sqlite"), Buffer.alloc(1024));
  return root;
};

test("the tree renders directories first, with honest aggregated sizes", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    const block = projectTreeBlock(root, root, 2, brain);
    assert.equal(block.root, root);
    assert.equal(block.depth, 2);
    const linkSize = lstatSync(join(root, "linked-dir")).size;
    assert.deepEqual(block.lines, [
      "  empty/  0B",
      "  src/  2K",
      "    domain/  2K",
      "    cli.ts  512B",
      `  linked-dir  ${formatSize(linkSize)}`,
      "  MINI.md  2K",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("depth bounds the display; zero depth renders nothing below the anchor", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    assert.deepEqual(projectTreeBlock(root, root, 0, brain).lines, []);
    assert.deepEqual(projectTreeBlock(root, join(root, "src"), 1, brain).lines, [
      "  domain/  2K",
      "  cli.ts  512B",
    ]);
    assert.equal(projectTreeBlock(root, join(root, "src"), 1, brain).root, join(root, "src"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atlas-attached files are marked by handle; relative and absolute attachment paths both resolve", () => {
  const root = makeProject();
  try {
    let brain = emptyBrain();
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n1", [fileAttachment("src/cli.ts")]) }, at("2026-11-16T04:00:00.000Z"));
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n2", [fileAttachment(join(root, "MINI.md"))]) }, at("2026-11-16T04:01:00.000Z"));
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n3", [fileAttachment("src/cli.ts")]) }, at("2026-11-16T04:02:00.000Z"));
    const attached = atlasAttachedPaths(brain, root);
    assert.deepEqual(attached.get(join(root, "src/cli.ts")), ["A1", "A3"]);
    const block = projectTreeBlock(root, root, 1, brain);
    const mine = block.lines.find((line) => line.includes("MINI.md"));
    assert.match(mine, /MINI\.md  2K  A2$/);
    assert.ok(!block.lines.some((line) => line.includes("cli.ts")), "depth 1 does not show cli.ts");
    const deep = projectTreeBlock(root, root, 2, brain);
    assert.match(deep.lines.find((line) => line.includes("cli.ts")), /cli\.ts  512B  A1 A3$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment paths escaping the root never mark anything", () => {
  const root = makeProject();
  try {
    let brain = emptyBrain();
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n1", [fileAttachment("../outside.txt")]) }, at("2026-11-16T04:00:00.000Z"));
    assert.equal(atlasAttachedPaths(brain, root).size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an anchor outside the project root, a file anchor, and a bad depth are rejected", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    assert.throws(() => projectTreeBlock(root, join(root, ".."), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, join(root, "MINI.md"), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, root, -1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, root, 1.5, brain), AnchorError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked directory renders as a leaf and is never followed", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    const block = projectTreeBlock(root, root, 3, brain);
    const linkLine = block.lines.find((line) => line.includes("linked-dir"));
    assert.ok(!linkLine.endsWith("/"));
    assert.ok(!block.lines.some((line) => line.includes("records.ts") && line.startsWith("  linked-dir")));
    const scanned = scanTree(root, root);
    const symlink = scanned.children.find((child) => child.name === "linked-dir");
    assert.equal(symlink.directory, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`.brain` and `.git` are never listed and never in the aggregated sizes", () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, ".git/objects"), { recursive: true });
    writeFileSync(join(root, ".git/config"), Buffer.alloc(1024));
    writeFileSync(join(root, ".git/objects/pack"), Buffer.alloc(8192));
    const brain = emptyBrain();
    const block = projectTreeBlock(root, root, 10, brain);
    assert.ok(!block.lines.some((line) => line.includes(".brain")), ".brain renders no line");
    assert.ok(!block.lines.some((line) => line.includes(".git")), ".git renders no line");
    // The Brain and .git bytes are excluded wholesale: nothing above or below the anchor aggregates them.
    const scanned = scanTree(root, root);
    assert.equal(scanned.children?.some((child) => child.name === ".brain"), false);
    assert.equal(scanned.children?.some((child) => child.name === ".git"), false);
    const srcNode = scanned.children?.find((child) => child.name === "src");
    assert.equal(srcNode?.size, 2048);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an anchor into `.brain` or `.git`, at any depth, is rejected", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    mkdirSync(join(root, "src/.brain"), { recursive: true });
    mkdirSync(join(root, "src/.git"), { recursive: true });
    assert.throws(() => projectTreeBlock(root, join(root, ".brain"), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, join(root, ".brain", "context"), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, join(root, "src", ".brain"), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, ".brain", 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, join(root, ".git"), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, join(root, "src", ".git"), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, ".git", 1, brain), AnchorError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
