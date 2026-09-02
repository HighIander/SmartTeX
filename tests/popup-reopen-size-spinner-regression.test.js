"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const popupGate = fs.readFileSync(path.join(root, "popup-gate.js"), "utf8");

// Repeated staged openings must clear stale slider-scaled geometry before any
// figure/table fitting happens, then measure and size only once afterwards.
assert.match(popupGate, /resetForMeasurement:[\s\S]*clearSize\(popup\)[\s\S]*delete state\.naturalSizes\[state\.type\]/);
assert.match(content, /if \(rebase\) previewPopupUI\?\.resetForMeasurement\?\.\(\);[\s\S]*prepareForReveal\?\.\(\{ rebase: false \}\)[\s\S]*applyPreviewAutoFitPolicy/);

// Environment-preview loading owns a separate spinner so generic reference
// pointer-move cleanup cannot hide it.
assert.match(content, /environmentPopupLoadingSpinner/);
assert.match(content, /showEnvironmentPopupLoadingSpinner/);
assert.match(content, /hideEnvironmentPopupLoadingSpinner/);
assert.match(content, /previewLoadingGlobalGeneration = showEnvironmentPopupLoadingSpinner\(loadingAnchor\)/);
assert.match(content, /hideEnvironmentPopupLoadingSpinner\(previewLoadingGlobalGeneration\)/);

// Cold renders give the spinner a guaranteed paint; measured warm-cache
// renders intentionally skip this delay and reveal immediately.
assert.match(content, /if \(!warmPreview && loadingGeneration !== null[\s\S]*await nextPreviewFrame\(\);[\s\S]*await nextPreviewFrame\(\);/);

console.log("Popup reopen sizing and stable spinner regression checks passed.");
