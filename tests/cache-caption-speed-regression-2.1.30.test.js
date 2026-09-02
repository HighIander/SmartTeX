/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const figureRenderer = fs.readFileSync(path.join(root, "figure-renderer.js"), "utf8");

test("warm popup cache reserves image geometry and avoids duplicate context parsing", () => {
  assert.match(content, /function stabilizeCachedPreviewMedia/);
  assert.match(content, /image\.setAttribute\("width"/);
  assert.match(content, /function cachedPreviewMediaGeometryReady/);
  assert.match(content, /scheduledPreviewHint = \{ generation, state, context, warm \}/);
  assert.match(content, /tryFastWarmPreview\(generation, renderHint\)/);
  assert.match(content, /const context = renderHint && previewHintMatchesState/);
  assert.match(content, /function lastFloatContextForState/);
  assert.match(content, /const cachedFloat = lastFloatContextForState\(state\)/);
});

test("editor figure popup reserves full-width caption row and media yields height first", () => {
  assert.match(css, /data-preview-kind="figure"[^]*grid-template-rows:\s*minmax\(0, 1fr\) auto/);
  assert.match(css, /data-preview-kind="figure"[^]*\.smarttex-float-popup-caption[^]*width:\s*100%/);
  assert.match(css, /smarttex-preview-scroll-fallback[^]*\.smarttex-figure-popup-viewport[^]*overflow:\s*auto/);
  assert.match(figureRenderer, /const mainEditorFigure = Boolean/);
  assert.match(figureRenderer, /figure\.style\.width = "100%"/);
  assert.match(content, /mediaOverflowHeight/);
  assert.match(content, /availableHeight \+ mediaOverflowHeight/);
});

test("resize hit areas stay close to border and do not cover scrollbar body", () => {
  assert.match(css, /data-direction="e"\]\s*\{ right:\s*-5px; \}/);
  assert.match(css, /data-direction="w"\]\s*\{ left:\s*-5px; \}/);
  assert.match(css, /data-direction="e"\],[^]*width:\s*8px/);
});

test("cached image aspect ratio is usable before decoded clone completes", () => {
  assert.match(figureRenderer, /Number\(image\?\.getAttribute\?\.\("width"\)\)/);
  assert.match(figureRenderer, /Number\(image\?\.getAttribute\?\.\("height"\)\)/);
});
