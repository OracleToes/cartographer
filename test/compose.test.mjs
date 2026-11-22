import assert from "node:assert/strict";
import test from "node:test";

import { composeInEditor, ctrlC, CTRL_C_ARM_WINDOW_MS, editorCommand } from "../dist/ui/compose.js";

test("the editor is $VISUAL first, then $EDITOR, then vi — and a blank one is no editor at all", () => {
  assert.deepEqual(editorCommand({}), { command: "vi", args: [] }, "the conventional fallback");
  assert.deepEqual(editorCommand({ EDITOR: "nvim" }), { command: "nvim", args: [] });
  assert.deepEqual(
    editorCommand({ EDITOR: "nano", VISUAL: "code" }),
    { command: "code", args: [] },
    "$VISUAL is the one meant for a full-screen editor, so it wins",
  );
  assert.deepEqual(
    editorCommand({ EDITOR: "code --wait" }),
    { command: "code", args: ["--wait"] },
    "arguments after the command are kept",
  );
  // A path with spaces is why the command is split like a shell and not on
  // whitespace alone.
  assert.deepEqual(editorCommand({ EDITOR: "'/Applications/Sublime Text/subl' -w" }), {
    command: "/Applications/Sublime Text/subl",
    args: ["-w"],
  });
  assert.deepEqual(editorCommand({ EDITOR: '"/opt/my editor/ed" -n --title="a b"' }), {
    command: "/opt/my editor/ed",
    args: ["-n", "--title=a b"],
  });
  // Set to whitespace: the person configured an editor and it is not one. The
  // honest answer is that there is none, not a silent `vi`.
  assert.equal(editorCommand({ EDITOR: "   " }), undefined);
});

test("the editor's file comes back as the prompt; a failure says why and keeps the old text", async () => {
  // A real program, so the spawn, the temporary file, and the read-back are all
  // exercised rather than mocked. It rewrites the file it is handed.
  const writes = await composeInEditor("half a thought", {
    env: { EDITOR: `node -e "require('fs').writeFileSync(process.argv[1], 'the whole thought')"` },
  });
  assert.equal(writes.ok, true, `the editor ran: ${JSON.stringify(writes)}`);
  assert.equal(writes.ok && writes.text, "the whole thought");
  assert.equal(writes.ok && writes.command, "node");

  // The same editor, but it leaves the file alone: the text is unchanged, which
  // is how the caller knows not to touch the prompt.
  const untouched = await composeInEditor("as it was", {
    env: { EDITOR: `node -e "process.exit(0)"` },
  });
  assert.equal(untouched.ok, true);
  assert.equal(untouched.ok && untouched.text, "as it was");

  // A failing editor that wrote nothing: refused, with the reason, and no text
  // pretending to be an edit.
  const failing = await composeInEditor("keep me", {
    env: { EDITOR: `node -e "process.exit(3)"` },
  });
  assert.equal(failing.ok, false);
  assert.match(failing.ok ? "" : failing.error, /exited 3/);

  // A command that does not exist is a failure, not a crash.
  const missing = await composeInEditor("keep me", { env: { EDITOR: "carto-no-such-editor-xyz" } });
  assert.equal(missing.ok, false);

  const none = await composeInEditor("keep me", { env: { EDITOR: "" } });
  assert.equal(none.ok, false);
  assert.match(none.ok ? "" : none.error, /no editor set/);
});

test("Ctrl-C clears a line with text, arms on an empty one, and leaves on the second press inside the window", () => {
  const at = 1_000;
  // Text on the line: cleared, and the arming is left exactly as it was.
  assert.deepEqual(ctrlC({ typed: "half a sentence", armedAt: undefined, now: at }), {
    outcome: { action: "cleared" },
    armedAt: undefined,
  });
  // Whitespace is not text: an empty prompt with a stray space still arms.
  assert.deepEqual(ctrlC({ typed: "   ", armedAt: undefined, now: at }).outcome, {
    action: "armed",
    windowMs: CTRL_C_ARM_WINDOW_MS,
  });
  // First press on an empty line: armed, and remembered.
  const first = ctrlC({ typed: "", armedAt: undefined, now: at });
  assert.equal(first.outcome.action, "armed");
  assert.equal(first.armedAt, at);
  // Second press inside the window: leave.
  assert.deepEqual(ctrlC({ typed: "", armedAt: at, now: at + 1_000 }).outcome, { action: "quit" });
  // Second press after it: not a quit — the arming lapsed, and this press arms again.
  const lapsed = ctrlC({ typed: "", armedAt: at, now: at + CTRL_C_ARM_WINDOW_MS + 1 });
  assert.equal(lapsed.outcome.action, "armed");
  assert.equal(lapsed.armedAt, at + CTRL_C_ARM_WINDOW_MS + 1);
  // A clear between the two presses does not spend the arming: the person was
  // typing again, and the quit they asked for was never made.
  const cleared = ctrlC({ typed: "typing again", armedAt: at, now: at + 500 });
  assert.equal(cleared.outcome.action, "cleared");
  assert.equal(cleared.armedAt, at, "the arming is untouched by a clear");
});
