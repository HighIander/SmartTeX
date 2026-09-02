/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const popupGate = fs.readFileSync(path.join(root, "popup-gate.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");

assert.match(content, /smarttex-preview-staging/);
assert.match(content, /revealStagedPreview/);
assert.match(content, /resetForMeasurement\?\.\(\)/);
assert.match(content, /prepareForReveal\?\.\(\{ rebase: false \}\)/);
assert.match(content, /__smarttexReadyPromise = Promise\.allSettled/);
assert.match(content, /await stagedFigure\.__smarttexReadyPromise/);
assert.match(content, /renderWithTransientRetries/);
assert.match(content, /popupSpinnerAnchorPosition/);
assert.match(popupGate, /popup\.dataset\.smarttexStaging === "true"/);
assert.match(popupGate, /resetForMeasurement:/);
assert.match(popupGate, /prepareForReveal:/);
assert.match(css, /#smarttex-equation-preview\.smarttex-preview-staging/);

console.log("Staged popup opening checks passed.");
