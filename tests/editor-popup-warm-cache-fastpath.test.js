/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const gate = fs.readFileSync(path.join(root, "popup-gate.js"), "utf8");

test("background popup cache stores measured geometry and line classification", () => {
  assert.match(content, /measureBackgroundPreviewMarkup/);
  assert.match(content, /naturalSize:\s*\{ width: rect\.width, height: rect\.height \}/);
  assert.match(content, /contentNaturalSize/);
  assert.match(content, /equationSingleLine/);
  assert.match(content, /previewCacheSet\(previewBaseRenderCache/);
});

test("measured warm cache bypasses normal render delay and staged measurement", () => {
  assert.match(content, /const warm = warmPreviewCacheForStateContext\(state, context\);/);
  assert.match(content, /warmCacheReady = Boolean\(warm\)/);
  assert.match(content, /if \(immediate \|\| warmCacheReady\)/);
  assert.match(content, /tryFastWarmPreview/);
  assert.match(content, /prepareCachedForReveal/);
  assert.match(content, /if \(!warmPreview && loadingGeneration/);
});

test("popup gate can restore cached natural and fitted geometry without persisting it", () => {
  assert.match(gate, /function prepareCachedForReveal/);
  assert.match(gate, /state\.naturalSizes\[type\] =/);
  assert.match(gate, /cacheCompatible/);
  assert.match(gate, /persist:\s*false/);
  assert.match(gate, /prepareCachedForReveal: \(cached = \{\}\)/);
});
