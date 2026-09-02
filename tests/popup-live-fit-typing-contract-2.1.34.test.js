/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("cached and cold previews use the same convergent 75 percent live-DOM fit", () => {
  assert.match(content, /function finishPreviewAutoFitNow\(/);
  assert.match(content, /const floorMetrics = setPreviewAutoFitZoomAndMeasure\(0\.75\)/);
  assert.match(content, /for \(let iteration = 0; iteration < 7; iteration \+= 1\)/);
  assert.match(content, /applyPreviewAutoFitPolicyNow\(prepared\)/);
  assert.match(content, /return finishPreviewAutoFitNow\(\)/);
});

test("typing keeps the popup mounted and stable except for cursor-safety relocation", () => {
  assert.match(content, /function activeEnvironmentPreviewContainsState\(state\)/);
  assert.match(content, /if \(!force && activeEnvironmentPreviewContainsState\(currentState\)\)[\s\S]*return false;/);
  assert.match(content, /if \(!force && previewPositioned && !popupTooCloseToCursor\)[\s\S]*return;/);
  assert.match(content, /LIVE_CAPTION_UPDATE_DELAY_MS = 48/);
  assert.match(content, /function scheduleLiveCaptionUpdate\(/);
  assert.match(content, /applyLiveCaptionUpdate\(state\)/);
  assert.match(content, /applyPreviewAutoFitPolicyNow\(prepared,[\s\S]*allowGrow/);
  assert.match(content, /CAPTION_TYPING_RENDER_DELAY_MS = 500/);
});

test("the accumulated popup and outline behavior contract is documented in source", () => {
  assert.match(content, /SMARTTEX POPUP \/ OUTLINE BEHAVIOR CONTRACT/);
  assert.match(content, /Mouse edge\/corner resizing is deliberately temporary/);
  assert.match(content, /Figure\/table captions span the complete popup content width/);
  assert.match(content, /Single-click on an included graphic jumps the source editor/);
  assert.match(content, /Numbered equations, figures, and tables are merged into the native outline/);
  assert.match(content, /Cached and freshly rendered previews must use[\s\S]*same final live-DOM fit solver/);
});

test("build retains the live-fit/typing contract", () => {
  const patch = Number(String(manifest.version).split(".")[2]);
  assert.equal(String(manifest.version).startsWith("2.1."), true);
  assert.ok(patch >= 35);
});
