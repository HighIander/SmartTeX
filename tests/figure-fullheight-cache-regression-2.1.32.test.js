/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const gate = fs.readFileSync(path.join(root, "popup-gate.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");

test("figure previews may grow to the usable viewport height before zoom/scroll", () => {
  assert.match(gate, /const heightLimit = type === "image"\s*\? bounds\.height/);
  assert.match(gate, /window\.innerHeight \* 0\.4 \* relativeScale/);
  assert.match(content, /figureRequiredHeight/);
  assert.match(content, /growForContent/);
});

test("markup-only environment cache entries are reused instead of reparsed", () => {
  assert.match(content, /normalizedPreviewCacheEntry\(lruCacheGet\(previewRenderCache, exactKey\)\)/);
  assert.match(content, /if \(exact\?\.markup\)/);
  assert.match(content, /measured: Boolean\(exact\.metrics\?\.naturalSize\)/);
  assert.match(content, /normalizedPreviewCacheEntry\(lruCacheGet\(previewBaseRenderCache, baseKey\)\)/);
  assert.match(content, /if \(base\?\.markup\)/);
});

test("build retains the figure-height/cache regression fixes", () => {
  const match = manifest.match(/"version"\s*:\s*"2\.1\.(\d+)"/);
  assert.ok(match && Number(match[1]) >= 35);
});
