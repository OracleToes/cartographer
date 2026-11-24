import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AGENT_REMINDER } from "./agent-reminder.mjs";

test("every test suite and the test guard echo the AGENTS.md and compaction reminder and forbid removing it", () => {
  assert.match(AGENT_REMINDER, /AGENTS\.md/);
  assert.match(AGENT_REMINDER, /compacted/i);
  assert.match(AGENT_REMINDER, /never remove/i);

  const guard = readFileSync(join("test", "guard.mjs"), "utf8");
  assert.match(guard, /agent-reminder\.mjs/, "test/guard.mjs must load agent-reminder.mjs");
  assert.match(guard, /printAgentReminder\(\)/, "test/guard.mjs must echo the reminder");

  const suites = readdirSync("test").filter((name) => name.endsWith(".test.mjs")).sort();
  for (const name of suites) {
    const body = readFileSync(join("test", name), "utf8");
    assert.match(body, /import\s+["']\.\/agent-reminder\.mjs["']/, `${name} must import ./agent-reminder.mjs`);
  }

  const agents = readFileSync("AGENTS.md", "utf8");
  assert.match(agents, /never remove.*reminder|Do not remove.*reminder/i, "AGENTS.md must forbid removing the test reminder");
});
