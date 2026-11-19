import assert from "node:assert/strict";
import test from "node:test";

import { inputBoxHeight, inputBoxRows, inputTextCells } from "../dist/ui/input-box.js";
import { margin, rule, width } from "../dist/ui/text.js";

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function box(lines, columns, gutter = margin(columns), extra = {}) {
  return inputBoxRows({ lines, title: "send follow-up", columns, gutter, ...extra });
}

function assertAllWidth(rows, columns) {
  for (const row of rows) {
    assert.equal(width(row), columns, `box row is not ${columns} cells: ${JSON.stringify(plain(row))}`);
  }
}

test("every box row is exactly as wide as the terminal", () => {
  for (const columns of [40, 58, 72, 96, 120]) {
    assertAllWidth(box([], columns), columns);
    assertAllWidth(box(["one line"], columns), columns);
    assertAllWidth(box(["a", "b", "c"], columns), columns);
    // A long line must be cut by the box, not wrapped, so the height it
    // reported to the layout still holds.
    assertAllWidth(box(["x".repeat(400)], columns), columns);
  }
});

test("the box lines up with the frame's rule", () => {
  // The rule the frame draws above the body and the box's top edge start and
  // end in the same columns, so the box reads as part of the chrome.
  for (const columns of [58, 96]) {
    const gutter = margin(columns);
    const frameRule = plain(`${" ".repeat(gutter)}${" ".repeat(2)}${rule(columns - gutter * 2 - 4)}${" ".repeat(2)}${" ".repeat(gutter)}`);
    const top = plain(box(["x"], columns)[0]);
    assert.equal(top.indexOf("╭"), frameRule.indexOf("─"));
    assert.equal(top.indexOf("╮"), frameRule.lastIndexOf("─"));
    assert.equal(width(frameRule), columns);
  }
});

test("the box names what Enter does, and cuts the title before the corner", () => {
  const wide = plain(box([], 96)[0]);
  assert.match(wide, /^ +╭ send follow-up ─+╮ *$/);
  // At 20 columns the title cannot fit whole; the corner must survive.
  const narrow = plain(box([], 20)[0]);
  assert.match(narrow, /╮\s*$/);
  assert.doesNotMatch(narrow, /^ *╭ *╮ *$/, "the title vanished completely");
});

test("the box keeps one cell of air around the text, so a prompt never touches the frame", () => {
  const rows = box(["hello"], 60).map(plain);
  const text = rows.find((row) => row.includes("hello"));
  assert.ok(text !== undefined);
  assert.match(text, /│ hello +│/);
});

test("the text cells the editor wraps at are the cells the box draws", () => {
  for (const columns of [40, 58, 96, 120]) {
    const gutter = margin(columns);
    const inside = plain(box([""], columns)[0]).indexOf("╮") - plain(box([""], columns)[0]).indexOf("╭") - 1;
    // The box's inside, less its two side walls and the air on each side.
    assert.equal(inputTextCells(columns, gutter), inside - 4 + 2);
  }
});

test("the box's height is its text plus two edges, and never zero", () => {
  assert.equal(inputBoxHeight([]), 3);
  assert.equal(inputBoxHeight(["a"]), 3);
  assert.equal(inputBoxHeight(["a", "b", "c"]), 5);
  assert.equal(inputBoxHeight(0), 3);
});

test("a note sits on the bottom edge, and an empty note leaves the edge plain", () => {
  const bare = plain(box([], 60).at(-1));
  assert.match(bare, /^ +╰─+╯ *$/);
  const noted = plain(box([], 60, margin(60), { note: "Esc back · Enter send" }).at(-1));
  assert.match(noted, /╰─+ Esc back · Enter send ╯/);
});
