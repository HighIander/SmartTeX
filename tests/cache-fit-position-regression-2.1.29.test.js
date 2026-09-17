/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const gate = fs.readFileSync(path.join(root, "popup-gate.js"), "utf8");
const figureRenderer = fs.readFileSync(path.join(root, "figure-renderer.js"), "utf8");

test("figure/table exact cache keys ignore irrelevant caret movement", () => {
  assert.match(content, /Figure\/table rendering is structurally cursor-independent/);
  assert.match(content, /if \(\(kind === "figure" \|\| kind === "table"\) && selectionFrom === selectionTo\)/);
  assert.match(content, /cursorIndex = -1;[\s\S]*selectionFrom = -1;[\s\S]*selectionTo = -1;/);
});

test("warm cache reuses compatible fitted geometry without repeated layout search", () => {
  assert.match(content, /cachedPreviewMediaReady/);
  assert.match(content, /if \(prepared\.cacheCompatible\)/);
  assert.match(content, /fontSignature: previewFontSignature\(\)/);
  assert.match(content, /cached\.metrics = liveMetrics/);
  assert.match(content, /cached\.metrics = revealed\.metrics/);
  assert.match(gate, /hasCompatibleFittedGeometry[\s\S]*Number\(cached\.finalSize\.width\)/);
  assert.match(gate, /hasCompatibleFittedGeometry[\s\S]*Number\(cached\.finalSize\.height\)/);
});

test("outer popup clipping participates in overflow and figure height fitting", () => {
  assert.match(content, /popupRect\.bottom - outputRect\.top - 1/);
  assert.match(content, /contentHeight > availableHeight \+ 1/);
  assert.match(figureRenderer, /availableOutputHeight/);
  assert.match(figureRenderer, /popupRect\.bottom - outputRect\.top - 1/);
});

test("visible popup stays stationary unless cursor enters its safety margin", () => {
  assert.match(content, /Environment-boundary positioning is an opening-time decision only/);
  assert.match(content, /previewPositioned &&[\s\S]*smarttex-preview-visible[\s\S]*positionPreviewAtCursor/);
  assert.doesNotMatch(content, /if \(!force && verticalScrollRepositionPending && previewPositioned\)/);
  assert.match(content, /if \(!force && previewPositioned && !popupTooCloseToCursor\)/);
  assert.doesNotMatch(content, /!popupTooCloseToCursor && !popupLeavesViewport/);
});
