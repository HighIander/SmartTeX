/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");

test("automatic cleanup cannot close an active environment popup", () => {
  assert.match(content, /function activeEnvironmentPreviewContainsState\(state\)/);
  assert.match(
    content,
    /function hidePreview[\s\S]*!force && activeEnvironmentPreviewContainsState\(currentState\)[\s\S]*return false;/
  );
});

test("equation source edits always use the in-place session while the caret remains inside", () => {
  assert.match(
    content,
    /continuingActivePreview && \(sourceChanged \|\| cursorChanged\)[\s\S]*activeKind === "equation"[\s\S]*activeEquationTypingContext\(currentState\)[\s\S]*scheduleLiveEquationUpdate\(currentState, liveContext/
  );
  assert.match(content, /activeEnvironmentInputTransactionContainsState\(currentState\)/);
  assert.match(content, /popup-live-equation/);
});

test("caret moves inside an open environment bypass generic reopen logic", () => {
  assert.match(
    content,
    /continuingActivePreview && \(sourceChanged \|\| cursorChanged\)[\s\S]*immediate: !sourceChanged[\s\S]*return;/
  );
  assert.match(content, /if \(!sourceChanged\)[\s\S]*positionPreviewAtCursor\(\);[\s\S]*return;/);
});

test("cached refreshes preserve popup position and use only cursor-proximity relocation", () => {
  assert.match(content, /const stablePosition = !openingFromCache \? preview\.getBoundingClientRect\(\) : null;/);
  assert.match(content, /if \(stablePosition\)[\s\S]*previewPositioned = true;[\s\S]*positionPreviewAtCursor\(\{/);
  assert.match(content, /if \(!force && previewPositioned && !popupTooCloseToCursor\)/);
});
