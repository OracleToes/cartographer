import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("the carto launcher finds its program through a user-bin symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "carto-launcher-"));
  const launcher = join(directory, "carto");
  await symlink(resolve("bin", "carto"), launcher);
  try {
    const result = await run(launcher, ["--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage: carto/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function run(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}
