import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { emptyBrain } from "../dist/domain/records.js";
import { AnchorError, atlasAttachedPaths, formatSize, projectTreeBlock, projectTreeView, renderTreeLines, scanTree } from "../dist/runtime/project-tree.js";

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
    // Every line carries the handle the tree minted for it (§5.4): files are
    // numbered as they render, and so are directories, each in its own run.
    assert.deepEqual(block.lines, [
      "  empty/  0B  D1",
      "  src/  >=512B  D2",
      "    domain/  >=0B  D3",
      "    cli.ts  512B  F1",
      `  linked-dir  ${formatSize(linkSize)}  F2`,
      "  MINI.md  2K  F3",
      "  (>= sizes are partial; depth, entry limit, or unreadable entries)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("depth bounds the display; depth 1 is the anchor's contents", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    assert.deepEqual(projectTreeBlock(root, root, 1, brain).lines, projectTreeBlock(root, root, 0, brain).lines);
    assert.deepEqual(projectTreeBlock(root, join(root, "src"), 1, brain).lines, [
      "  domain/  >=0B  D1",
      "  cli.ts  512B  F1",
      "  (>= sizes are partial; depth, entry limit, or unreadable entries)",
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
    assert.match(mine, /MINI\.md  2K  F2  A2$/);
    assert.ok(!block.lines.some((line) => line.includes("cli.ts")), "depth 1 does not show cli.ts");
    const deep = projectTreeBlock(root, root, 2, brain);
    assert.match(deep.lines.find((line) => line.includes("cli.ts")), /cli\.ts  512B  F1  A1 A3$/);
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

test("an anchor outside the project root or on a file is rejected; a depth below one renders as one", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    assert.throws(() => projectTreeBlock(root, join(root, ".."), 1, brain), AnchorError);
    assert.throws(() => projectTreeBlock(root, join(root, "MINI.md"), 1, brain), AnchorError);
    // Depth has no meaning below one: nothing is refused, and the render is the same (§6.3).
    const one = projectTreeBlock(root, root, 1, brain);
    const zero = projectTreeBlock(root, root, 0, brain);
    const negative = projectTreeBlock(root, root, -3, brain);
    assert.deepEqual(zero.lines, one.lines);
    assert.deepEqual(negative.lines, one.lines);
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

test("every file and directory the tree shows carries the handle the block draws, and the map agrees with it", () => {
  const root = makeProject();
  try {
    const block = projectTreeBlock(root, root, 3, emptyBrain());
    const byHandle = new Map([...block.handles].map(([path, handle]) => [handle, path]));
    assert.ok(block.handles.size > 0, "the tree handed out handles");

    // §5.4: a file's handle comes from the tree. Every handle in the map is on
    // the line for its path, so a handle in the block means one thing.
    for (const [path, handle] of block.handles) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      assert.ok(/^[FD]\d+$/.test(handle), `${handle} is a file or directory handle`);
      const line = block.lines.find((candidate) => candidate.trim().startsWith(name + (handle.startsWith("D") ? "/" : "")));
      assert.ok(line !== undefined, `${name} is drawn`);
      assert.ok(line.includes(handle), `${name}'s line carries ${handle}`);
    }
    // A directory and a file never share a handle: the prefixes differ.
    assert.ok(byHandle.size === block.handles.size, "no handle names two paths");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("bounded scans mark omitted entries and propagate partial sizes without mislabeling bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "carto-budget-"));
  try {
    mkdirSync(join(root, "nested"));
    for (let i = 0; i < 12; i++) writeFileSync(join(root, "nested", `file${i}`), Buffer.alloc(300));
    const shallow = scanTree(root, root, 1, 100);
    assert.equal(shallow.children[0].incomplete, true);
    assert.equal(shallow.children[0].children, undefined, "the depth boundary is not opened");
    const limited = scanTree(root, root, 4, 5);
    const folder = limited.children.find((child) => child.name === "nested");
    assert.equal(folder.children.length, 4);
    assert.equal(folder.size, 1200);
    assert.equal(folder.listingIncomplete, true);
    assert.equal(limited.incomplete, true);
    const lines = renderTreeLines(limited, 4, new Map());
    assert.ok(lines.some((line) => line.includes("nested/  >=1200B")));
    assert.ok(lines.some((line) => line.includes("entries omitted or unreadable")));
    const full = scanTree(root, root, 4, 100);
    assert.equal(full.incomplete, undefined);
    assert.equal(full.size, 3600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("view and block share a bounded scan while annotations are projected freshly", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    const view = projectTreeView(root, root, 2, brain);
    const again = projectTreeView(root, root, 2, brain);
    const block = projectTreeBlock(root, root, 2, brain);
    assert.equal(view.entry, again.entry);
    assert.deepEqual([...view.handles], [...block.handles]);
    const changed = applyWrite(brain, { kind: "atlas.upsert", node: atlasNode("fresh", [fileAttachment("src/cli.ts")]) }, Date.now());
    const annotated = projectTreeBlock(root, root, 2, changed);
    assert.ok(annotated.lines.some((line) => line.includes("cli.ts") && line.includes("A1")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("shared scans refresh on the next access after their short reuse window", () => {
  const root = makeProject();
  const realNow = Date.now;
  try {
    let now = realNow();
    Date.now = () => now;
    const first = projectTreeView(root, root, 2, emptyBrain());
    writeFileSync(join(root, "new.txt"), "new");
    assert.equal(projectTreeView(root, root, 2, emptyBrain()).entry, first.entry);
    now += 1001;
    const refreshed = projectTreeBlock(root, root, 2, emptyBrain());
    assert.ok(refreshed.lines.some((line) => line.includes("new.txt")));
  } finally { Date.now = realNow; rmSync(root, { recursive: true, force: true }); }
});


test("tree pages cap addressable entries and retain unaddressable ancestor context", () => {
  const root = makeProject();
  try {
    const brain = emptyBrain();
    const first = projectTreeBlock(root, root, 2, brain, { limit: 2 });
    assert.deepEqual(first.page, { offset: 0, end: 2, total: 6, limit: 2, scanIncomplete: false });
    assert.deepEqual([...first.handles.keys()], [join(root, "empty"), join(root, "src")]);
    assert.match(first.lines.join("\n"), /0 before, 4 after; next: tree offset 2/);
    const next = projectTreeBlock(root, root, 2, brain, { limit: 2, offset: 2 });
    assert.deepEqual([...next.handles.keys()], [join(root, "src/domain"), join(root, "src/cli.ts")]);
    assert.match(next.lines.join("\n"), /src\/  >=512B  \(context\)/);
    assert.equal(next.handles.has(join(root, "src")), false);
    assert.match(next.lines.join("\n"), /2 before, 2 after; next: tree offset 4/);
    const view = projectTreeView(root, root, 2, brain, { limit: 2, offset: 2 });
    assert.deepEqual([...view.handles], [...next.handles]);
    const last = projectTreeBlock(root, root, 2, brain, { limit: 2, offset: 4 });
    assert.equal(last.handles.size, 2);
    assert.match(last.lines.join("\n"), /4 before, 0 after/);
    assert.doesNotMatch(last.lines.join("\n"), /next: tree offset/);
    const beyond = projectTreeBlock(root, root, 2, brain, { limit: 2, offset: 999 });
    assert.equal(beyond.handles.size, 0);
    assert.match(beyond.lines.join("\n"), /empty at offset 6/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the default page caps a wide directory independently of the scan budget", () => {
  const root = mkdtempSync(join(tmpdir(), "carto-tree-pages-"));
  try {
    for (let i = 0; i < 125; i++) writeFileSync(join(root, `file-${String(i).padStart(3, "0")}`), "x");
    const page = projectTreeBlock(root, root, 1, emptyBrain());
    assert.equal(page.handles.size, 100);
    assert.equal(page.page.total, 125);
    assert.match(page.lines.join("\n"), /25 after; next: tree offset 100/);
    const tail = projectTreeBlock(root, root, 1, emptyBrain(), { offset: 100 });
    assert.equal(tail.handles.size, 25);
    assert.equal(tail.page.end, 125);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
