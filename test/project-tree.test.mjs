import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { emptyBrain } from "../dist/domain/records.js";
import { AnchorError, atlasLinkedPaths, formatSize, projectTreeBlock, scanTree } from "../dist/runtime/project-tree.js";

const at = (iso) => Date.parse(iso);
const source = (path, freshness = "fresh") => ({ kind: "file", path, startLine: 1, endLine: 10, digest: "d", excerpt: "e", freshness });
const atlasNode = (id, evidence) => ({ id, title: `title ${id}`, claim: `claim ${id}`, evidence, edges: [], createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:00:00.000Z") });

const makeProject = () => {
  const root = mkdtempSync(join(tmpdir(), "carto-tree-"));
  mkdirSync(join(root, "src/domain"), { recursive: true });
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "MINI.md"), Buffer.alloc(2048));
  writeFileSync(join(root, "src/cli.ts"), Buffer.alloc(512));
  writeFileSync(join(root, "src/domain/records.ts"), Buffer.alloc(1536));
  symlinkSync(join(root, "src/domain"), join(root, "linked-dir"), "dir");
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

test("Atlas-linked files are marked by handle; relative and absolute evidence paths both resolve", () => {
  const root = makeProject();
  try {
    let brain = emptyBrain();
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n1", [source("src/cli.ts")]) }, at("2026-11-16T04:00:00.000Z"));
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n2", [source(join(root, "MINI.md"))]) }, at("2026-11-16T04:01:00.000Z"));
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n3", [source("src/cli.ts")]) }, at("2026-11-16T04:02:00.000Z"));
    const linked = atlasLinkedPaths(brain, root);
    assert.deepEqual(linked.get(join(root, "src/cli.ts")), ["A1", "A3"]);
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

test("evidence paths escaping the root never mark anything", () => {
  const root = makeProject();
  try {
    let brain = emptyBrain();
    brain = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("n1", [source("../outside.txt")]) }, at("2026-11-16T04:00:00.000Z"));
    assert.equal(atlasLinkedPaths(brain, root).size, 0);
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
    const linked = new Map();
    const block = projectTreeBlock(root, root, 3, brain);
    const linkLine = block.lines.find((line) => line.includes("linked-dir"));
    assert.ok(!linkLine.endsWith("/"));
    assert.ok(!block.lines.some((line) => line.includes("records.ts") && line.startsWith("  linked-dir")));
    assert.equal(linked.size, 0);
    const scanned = scanTree(root, root);
    const symlink = scanned.children.find((child) => child.name === "linked-dir");
    assert.equal(symlink.directory, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
