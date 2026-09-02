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

test("figure popup grows for full media plus caption instead of cropping media into a fixed row", () => {
  assert.match(figureRenderer, /smarttexRequiredHeightPx/);
  assert.match(figureRenderer, /desiredHeight \* finalScale \+ captionHeight \+ gap/);
  assert.match(content, /figureRequiredHeight/);
  assert.match(content, /Number\(figurePopup\.dataset\.smarttexRequiredHeightPx\)/);
  assert.match(css, /grid-template-rows:\s*auto auto/);
  assert.match(css, /\.smarttex-figure-popup[^]*height:\s*max-content/);
  assert.doesNotMatch(css, /grid-template-rows:\s*minmax\(0, 1fr\) auto/);
});

test("figure and table cache keys ignore collapsed caret motion and store canonical base markup", () => {
  assert.match(content, /function canonicalPreviewBaseMarkup/);
  assert.match(content, /\.smarttex-rendered-caret, \.smarttex-rendered-operator-caret/);
  assert.match(content, /if \(\(kind === "figure" \|\| kind === "table"\) && selectionFrom === selectionTo\)/);
  assert.match(content, /cursorIndex = -1;[^]*selectionFrom = -1;[^]*selectionTo = -1;/);
  assert.match(content, /const cacheableMarkup = \(!hasSelection\)/);
  assert.match(content, /if \(!hasSelection\) \{[^]*previewBaseRenderCache/);
});

test("background popup cache prioritizes elements near the current cursor and has ample capacity", () => {
  assert.match(content, /const PREVIEW_RENDER_CACHE_LIMIT = 256/);
  assert.match(content, /Math\.abs\(\(Number\(left\?\.sourceIndex\) \|\| 0\) - cursorIndex\)/);
  assert.match(content, /function backgroundPreviewEntriesForState/);
  assert.doesNotMatch(content, /\.slice\(0, 120\)/);
  assert.match(content, /const startDelay = initial \? 40 : 180/);
  assert.match(content, /await previewWarmYield/);
});

test("resize edge hit areas stay essentially on the border", () => {
  assert.match(css, /data-direction="e"\]\s*\{ right:\s*-4px; \}/);
  assert.match(css, /data-direction="w"\]\s*\{ left:\s*-4px; \}/);
  assert.match(css, /data-direction="e"\],[^]*width:\s*6px/);
});
