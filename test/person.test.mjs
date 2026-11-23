/**
 * What the agent calls the person.
 *
 * The model reads strings, not a data model: a tool description, a tool
 * result, a state block line. Those said "the person" and "the user", which is
 * a placeholder standing where somebody's name belongs. Every one of them now
 * names the person at the keyboard — the account that launched Carto, or the
 * name a configuration setting gives — so these tests hold two things at once:
 * the resolution order, and the fact that the old words are gone from every
 * string the model can reach.
 */
import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { personName, launchingUserName, UNNAMED_PERSON } from "../dist/domain/person.js";
import { parseConfig, ConfigError } from "../dist/runtime/config.js";
import { renderStateBlock } from "../dist/domain/state-block.js";
import { projectContext } from "../dist/domain/projection.js";
import { emptyBrain } from "../dist/domain/records.js";
import { createTools } from "../dist/runtime/tools.js";
import { cartoInstructions } from "../dist/runtime/carto-extension.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "carto-person-"));

// The old words, in the forms that used to appear. Matched as whole phrases so
// a name that happens to contain "user" is not a false failure.
const OLD_WORDS = /\b(the person|the user|person's|user's|personMessage|the human|the operator)\b/;

test("the configured name wins; without one, the launching account is used", () => {
  const nobody = () => ({ username: "" });
  assert.equal(personName("OracleToes"), "OracleToes");
  assert.equal(personName("  padded  "), "padded", "the name is trimmed");
  // A setting that is only whitespace is not a name: fall back rather than
  // calling somebody "".
  assert.equal(personName("   ", { USER: "from-env" }, nobody), "from-env");
  assert.equal(personName(undefined, { USER: "from-env" }, nobody), "from-env");
  assert.equal(personName("OracleToes", { USER: "from-env" }, nobody), "OracleToes", "the setting beats the login");
});

test("the login name is read from the OS first, then the environment it falls back to", () => {
  // Whatever this machine says is the launching account; the point is that it
  // is a real name and never the empty string.
  const real = launchingUserName();
  assert.ok(real.length > 0, "a name, even if the last resort is the neutral noun");

  const nobody = () => ({ username: "" });
  assert.equal(launchingUserName({ USER: "alice", LOGNAME: "bob", USERNAME: "carol" }, nobody), "alice", "USER first");
  assert.equal(launchingUserName({ LOGNAME: "bob", USERNAME: "carol" }, nobody), "bob", "then LOGNAME");
  assert.equal(launchingUserName({ USERNAME: "carol" }, nobody), "carol", "then USERNAME (Windows)");
  assert.equal(launchingUserName({}, nobody), UNNAMED_PERSON, "nothing anywhere leaves the neutral noun");

  // A uid with no passwd entry must not crash the boot: it reads the environment.
  const throws = () => {
    throw new Error("no such user");
  };
  assert.equal(launchingUserName({ USER: "alice" }, throws), "alice", "a failed lookup falls through");

  // The OS name beats the environment, because it is the account that ran.
  assert.equal(launchingUserName({ USER: "from-env" }, () => ({ username: "from-os" })), "from-os");
});

test("userName is validated like every other config field", () => {
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", userName: "OracleToes" }).userName, "OracleToes");
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", userName: "  OracleToes  " }).userName, "OracleToes");
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", userName: 42 }), ConfigError);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", userName: 42 }), /userName must be a string/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", userName: "  " }), /must not be empty/);
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x" }).userName, undefined, "unset is the launching account");
});

test("the instructions name the person, and never the old words", () => {
  const text = cartoInstructions("OracleToes");
  assert.match(text, /kept for OracleToes\./);
  assert.match(text, /U is OracleToes's messages/);
  assert.match(text, /OracleToes hears you through/);
  assert.doesNotMatch(text, OLD_WORDS);
});

test("the state block names the person on pending, pins and marks", () => {
  const block = renderStateBlock({
    person: "OracleToes",
    contextWindow: 32_768,
    lastReportedInput: undefined,
    systemTokens: 1,
    transcriptTokens: 1,
    toolWorkTokens: 1,
    toolWorkSince: 0,
    sizes: { atlas: 0, ledger: 0, chat: 0, ephemera: 0 },
    pending: [{ kind: "chat", action: "record", id: "c7" }],
    pinned: [{ handle: "L2", author: "user" }],
    marks: [{ handle: "A8", action: "archive", author: "user" }],
    stale: [],
    resolveHandle: () => "C7",
    mode: "edit",
    tree: { root: "/project", depth: 1, lines: [] },
  });
  assert.match(block, /C7 · said to OracleToes/);
  assert.match(block, /P L2 · placed by OracleToes/);
  assert.match(block, /marked by OracleToes/);
  assert.doesNotMatch(block, OLD_WORDS);
});

test("the frozen head names the person who pinned and kept things", () => {
  let brain = emptyBrain();
  brain = {
    ...brain,
    files: [{ path: "notes.md", pinned: "user", createdAt: 1 }],
    ephemera: [{ id: "e1", text: "kept", kind: "reasoning", pinned: "user", createdAt: 1 }],
  };
  const text = projectContext(brain, new Map([["notes.md", "notes"]]), "OracleToes").text;
  assert.match(text, /Pinned — what OracleToes kept in front of you/);
  assert.match(text, /notes\.md · pinned by OracleToes/);
  assert.doesNotMatch(text, OLD_WORDS);
});

test("every tool the agent sees is written in the person's name, not a role word", () => {
  const root = tempDir();
  try {
    const session = {
      person: "OracleToes",
      pending: [],
      tree: { anchor: root, depth: 2 },
      collapseRequested: null,
      generation: "gen-test",
      readOnly: false,
    };
    const tools = createTools({ root, brain: { read: async () => emptyBrain() }, session });
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.doesNotMatch(tool.description, OLD_WORDS, `${tool.name}'s description speaks in a name`);
    }
    // The one description that used to open with the placeholder now opens
    // with the name, and the sleep parameters read the same way.
    const chat = tools.find((tool) => tool.name === "chat");
    assert.match(chat.description, /^Say something to OracleToes\./);
    const sleep = tools.find((tool) => tool.name === "sleep");
    assert.match(sleep.parameters.properties.seconds.description, /until OracleToes messages you/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// CLI help and --user persistence are covered in the end-to-end config suite,
// alongside the other flags, without starting duplicate Carto processes.
