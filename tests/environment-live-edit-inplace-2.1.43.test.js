/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("live environment edits cancel stale generic render jobs without hiding the mounted popup", () => {
  assert.match(content, /function cancelPendingEnvironmentPreviewRender\(\)[\s\S]*renderGeneration \+= 1;[\s\S]*hidePreviewLoading\(\);/);
  assert.match(content, /continuingActivePreview && \(sourceChanged \|\| cursorChanged\)[\s\S]*cancelPendingEnvironmentPreviewRender\(\);/);
});

test("equation typing and cursor movement both use the in-place renderer", () => {
  assert.match(content, /scheduleLiveEquationUpdate\(currentState, liveEquationContext\);\s*return;/);
  assert.match(content, /scheduleLiveEquationUpdate\(currentState, cursorContext, \{ immediate: true \}\);\s*return;/);
  assert.match(content, /contextTools\.resolveCaretPlacement\([\s\S]*contextTools\.previewBody\(context, commandSide, numbering, !hasSelection\)/);
  assert.match(content, /"\\\\SmartTeXCaret"[\s\S]*smarttex-rendered-caret/);
});

test("caption typing updates the mounted float and does not fall through to the delayed full popup renderer", () => {
  assert.match(content, /setCaptionPreviewLockFromCaption\(state, context, floatCaption\);/);
  assert.match(content, /activeKind === "figure" \|\| activeKind === "table"[\s\S]*scheduleLiveCaptionUpdate\(currentState\);[\s\S]*return;/);
  assert.match(content, /function applyLiveCaptionUpdate\(state\)[\s\S]*pinnedLeftStyle[\s\S]*applyPreviewAutoFitPolicyNow[\s\S]*positionPreviewAtCursor\(\);/);
  assert.match(content, /advanceActiveEnvironmentRangeForSourceEdit\(currentState\);/);
});

test("active environment editor auto-scroll remains mounted and uses only the cursor safety relocation rule", () => {
  assert.match(content, /const activeEnvironmentEdit = activeEnvironmentPreviewContainsState\(currentState\);/);
  assert.match(content, /activeCaptionEdit \|\|[\s\S]*activeEquationEdit \|\|[\s\S]*activeEnvironmentEdit \|\|/);
  assert.match(content, /if \(!force && previewPositioned && !popupTooCloseToCursor\)[\s\S]*return;/);
});

test("build version includes the unified in-place environment lifecycle fix", () => {
  assert.equal(String(manifest.version).startsWith("2.1."), true);
  assert.ok(Number(String(manifest.version).split(".")[2]) >= 45);
});
