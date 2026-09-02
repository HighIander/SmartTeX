/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const gate = fs.readFileSync(path.join(root, "popup-gate.js"), "utf8");
const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");

test("popup header dragging is capture-phase and carries a direct hand cursor", () => {
  assert.match(gate, /function markMoveHandle\(heading\)/);
  assert.match(gate, /heading\.style\.setProperty\("cursor", "grab", "important"\)/);
  assert.match(gate, /heading\.style\.setProperty\("cursor", "grabbing", "important"\)/);
  assert.match(gate, /popup\.addEventListener\("pointerdown",[\s\S]*\{ capture: true, passive: false \}\)/);
  assert.match(gate, /event\.target\?\.closest\?\.\([\s\S]*smarttex-preview-heading/);
});

test("initial source state starts proactive popup-cache warming before interaction gating", () => {
  const warmIndex = content.indexOf("schedulePreviewCacheWarm({");
  const gateIndex = content.indexOf("if (!popupInteractionReady())", warmIndex - 1800);
  assert.ok(warmIndex >= 0, "expected proactive cache warm call");
  assert.ok(gateIndex > warmIndex, "cache warming must be scheduled before popup interaction gating returns");
  assert.match(content, /initial:\s*!previousState \|\| previousFileName !== currentFileName/);
});

test("background warming covers all display preview environments progressively", () => {
  assert.match(content, /function backgroundPreviewEntriesForState/);
  assert.match(content, /analysis\.equations\?\.contexts/);
  assert.match(content, /context\?\.display === false/);
  assert.match(content, /\\\\begin\\s\*\\\{figure\\\*\?\\\}/);
  assert.match(content, /\\\\begin\\s\*\\\{table\\\*\?\\\}/);
  assert.doesNotMatch(content, /\.slice\(0, 120\)/);
  assert.match(content, /await previewWarmYield/);
  assert.match(content, /schedulePreviewCacheWarm\(\{ initial: false \}\)/);
});

test("popup header/proactive-cache feature remains present in current 2.1.x builds", () => {
  const match = manifest.match(/"version"\s*:\s*"2\.1\.(\d+)"/);
  assert.ok(match, "expected a 2.1.x manifest version");
  assert.ok(Number(match[1]) >= 35, "feature requires version 2.1.35 or newer");
});
