"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");

// A manual close must remain effective while the source grows inside the same
// environment; the stored source length is used to adjust the dismissed range.
assert.match(content, /sourceLength:\s*String\(activePreviewState\.value \|\| ""\)\.length/);
assert.match(content, /function dismissedRangeContainsState\([\s\S]*sourceLengthDelta[\s\S]*adjustedCloseEnd/);
assert.match(content, /function stateIsInsideDismissedPreview\(/);
assert.match(content, /stateIsInsideDismissedPreview\(state\)[\s\S]*hidePreview\(\{ clearDismissal: false, force: true \}\)/);

// Caption edits use a substantially calmer debounce and defer the expensive
// context lookup until typing has paused.
assert.match(content, /CAPTION_TYPING_RENDER_DELAY_MS = 500/);
assert.match(content, /deferContextLookup = false/);
assert.match(content, /if \(deferContextLookup && !immediate\)[\s\S]*setTimeout/);
assert.match(content, /captionTypingActive[\s\S]*CAPTION_TYPING_RENDER_DELAY_MS[\s\S]*deferContextLookup: captionTypingActive/);

// Both figure and table captions use the cheap active-caption continuation.
assert.match(content, /\["figure", "table"\]\.includes\(activePreviewContext\?\.kind\)/);
assert.match(content, /container\?\.kind === activePreviewContext\?\.kind/);

// Updating a caption must not rebuild an existing table or figure body.
assert.match(content, /function updateFloatCaptionInPlace\(/);
assert.match(content, /const renderedFloat = renderedFigure \|\| renderedTable/);
assert.match(content, /const updateCaptionOnly = Boolean\([\s\S]*renderedFloat[\s\S]*caretInFloatCaption/);
assert.match(content, /if \(renderedTable && !updateCaptionOnly\)/);

console.log("Caption preview dismissal and typing-performance checks passed.");
