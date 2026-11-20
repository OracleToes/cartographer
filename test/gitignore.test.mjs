import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emptyBrain } from "../dist/domain/records.js";
import { projectTreeBlock, scanTree } from "../dist/runtime/project-tree.js";

const makeProject = (build) => {
  const root = mkdtempSync(join(tmpdir(), "carto-ignore-"));
  try {
    build(root);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};

const withProject = (build, fn) => {
  const root = makeProject(build);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const write = (root, rel, bytes) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes));
};

const lines = (root, anchor, depth = 8) => projectTreeBlock(root, anchor, depth, emptyBrain()).lines;

test("a gitignored directory is skipped entirely — no line, no bytes in the aggregate", () => {
  withProject((root) => {
    write(root, "MINI.md", 2048);
    write(root, "src/keep.ts", 512);
    write(root, "node_modules/pkg/big.bin", 8192);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  }, (root) => {
    const tree = scanTree(root, root);
    const ignoreBytes = Buffer.byteLength("node_modules/\n");
    assert.equal(tree.size, 2048 + 512 + ignoreBytes, "the ignored subtree contributes no bytes; the .gitignore itself counts");
    const rendered = lines(root, root);
    assert.ok(!rendered.some((line) => line.includes("node_modules")), "the ignored directory renders nothing");
    assert.ok(rendered.some((line) => line.includes("src/  512B")));
  });
});

test("an anchored pattern matches only at the .gitignore's own level", () => {
  withProject((root) => {
    write(root, "dist/a.bin", 100);
    write(root, "src/dist/b.bin", 200);
    writeFileSync(join(root, ".gitignore"), "/dist/\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(!rendered.includes("  dist/  100B"), "the root dist is gone");
    assert.ok(rendered.includes("    dist/  200B"), "src/dist survives: /dist anchored at the root only");
  });
});

test("a basename pattern matches at any depth", () => {
  withProject((root) => {
    write(root, "a.log", 10);
    write(root, "src/deep/b.log", 20);
    write(root, "src/keep.ts", 512);
    writeFileSync(join(root, ".gitignore"), "*.log\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(!rendered.some((line) => line.includes(".log")), "every .log matches at any depth");
    assert.ok(rendered.some((line) => line.includes("keep.ts")));
  });
});

test("negation re-includes a file covered by an earlier rule; last rule wins", () => {
  withProject((root) => {
    write(root, "drop.log", 10);
    write(root, "keep.log", 10);
    writeFileSync(join(root, ".gitignore"), "*.log\n!keep.log\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(!rendered.some((line) => line.includes("drop.log")));
    assert.ok(rendered.some((line) => line.includes("keep.log")), "the negated file survives");
  });
});

test("a nested .gitignore governs only its own subtree", () => {
  withProject((root) => {
    write(root, "gen/top.bin", 100);
    write(root, "src/gen/nested.bin", 200);
    write(root, "src/keep.ts", 512);
    writeFileSync(join(root, "src", ".gitignore"), "gen/\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(rendered.some((line) => line.trim() === "gen/  100B"), "the root gen is outside the src/.gitignore");
    assert.ok(!rendered.some((line) => line.includes("nested.bin")), "src/gen is pruned by src/.gitignore");
  });
});

test(".git/info/exclude is honored", () => {
  withProject((root) => {
    write(root, "secret/bin", 512);
    write(root, "shown/bin", 512);
    mkdirSync(join(root, ".git/info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "secret/\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(!rendered.some((line) => line.includes("secret")));
    assert.ok(rendered.some((line) => line.includes("shown")));
  });
});

test("a re-include cannot reach inside a pruned directory (git parity)", () => {
  withProject((root) => {
    write(root, "build/out.bin", 100);
    write(root, "build/keep.log", 100);
    writeFileSync(join(root, ".gitignore"), "build/\n!build/keep.log\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(!rendered.some((line) => line.includes("build")), "the pruned directory takes its contents with it");
  });
});

test("a directory-only rule does not match a same-named file", () => {
  withProject((root) => {
    write(root, "sub/deps/bin.bin", 100);
    write(root, "deps", 123); // a FILE named deps at the root
    writeFileSync(join(root, ".gitignore"), "deps/\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(!rendered.some((line) => line.includes("deps/")), "the directory named deps is ignored");
    assert.ok(rendered.some((line) => line.trim().startsWith("deps  123B")), "the file named deps survives");
  });
});

test("a leading double-star matches at any depth, root included", () => {
  withProject((root) => {
    write(root, "cache/bin.bin", 100);
    write(root, "src/cache/bin.bin", 200);
    write(root, "src/keep.ts", 512);
    writeFileSync(join(root, ".gitignore"), "**/cache/\n");
  }, (root) => {
    const rendered = lines(root, root);
    assert.ok(!rendered.some((line) => line.includes("cache")), "both cache directories are gone");
    assert.ok(rendered.some((line) => line.includes("keep.ts")));
  });
});

test("a .gitignore above the anchor still governs the anchor's contents", () => {
  withProject((root) => {
    write(root, "src/generated/api.bin", 400);
    write(root, "src/keep.ts", 512);
    writeFileSync(join(root, ".gitignore"), "src/generated/\n");
  }, (root) => {
    const rendered = lines(root, join(root, "src"));
    assert.ok(!rendered.some((line) => line.includes("generated")), "src/generated pruned even when the anchor is src");
    assert.ok(rendered.some((line) => line.includes("keep.ts")));
  });
});

test("a directory ignored above the anchor is pruned even though it is never listed", () => {
  withProject((root) => {
    write(root, "src/node_modules/pkg/bin.bin", 8192);
    write(root, "src/keep.ts", 512);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  }, (root) => {
    const tree = scanTree(root, join(root, "src"));
    assert.equal(tree.size, 512, "the basename rule prunes node_modules at any depth");
  });
});

test("the aggregate excludes ignored bytes but keeps everything else honest", () => {
  withProject((root) => {
    write(root, "keep.ts", 512);
    write(root, "tmp/x.bin", 4096);
    write(root, "tmp/y.bin", 4096);
    writeFileSync(join(root, ".gitignore"), "tmp/\n");
  }, (root) => {
    assert.equal(scanTree(root, root).size, 512 + Buffer.byteLength("tmp/\n"), "the .gitignore itself counts; tmp/ does not");
  });
});
