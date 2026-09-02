"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");

test("background-warmed equation key is identical to first-open environment identity", () => {
  const keyBlock = content.match(/function previewBaseCacheKey\(state, context\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(keyBlock, /previewSourceSignature\(state\)/);
  assert.match(keyBlock, /context\?\.openStart/);
  assert.doesNotMatch(keyBlock, /fastPreviewHash\(context\?\.source/);
});

test("any warm equation cache is authoritative for the opening frame", () => {
  assert.match(content, /const warmPreview = await tryFastWarmPreview[\s\S]*if \(warmPreview\) \{[\s\S]*return;/);
  assert.match(content, /do not immediately continue[\s\S]*cold cursor-specific KaTeX render/);
});

test("equation typing updates the existing popup without generic scheduleRender", () => {
  const scheduler = content.match(/function scheduleLiveEquationUpdate\(state, context(?:, \{ immediate = false \} = \{\})?\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(scheduler, /renderLiveEquationInPlace/);
  assert.doesNotMatch(scheduler, /\bscheduleRender\s*\(\s*\{/);
  assert.match(content, /function liveEquationEditSessionContainsState\(/);
  assert.match(content, /if \(liveEquationEditSessionContainsState\(currentState\)\)[\s\S]*hidePreviewLoading\(\);[\s\S]*return;/);
});

test("live equation fit pins popup position while resizing content", () => {
  assert.match(content, /const pinnedRect = preview\.getBoundingClientRect\(\)/);
  assert.match(content, /applyPreviewAutoFitPolicyNow\(/);
  assert.match(content, /preview\.style\.left = pinnedLeftStyle \|\| `\$\{Math\.round\(pinnedLeft\)\}px`/);
  assert.match(content, /preview\.style\.top = pinnedTopStyle \|\| `\$\{Math\.round\(pinnedTop\)\}px`/);
});

test("version remains in the 2.1.x line", () => {
  assert.match(manifest, /"version":\s*"2\.1\.\d+"/);
});
