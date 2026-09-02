"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");

// Clicking a SmartTeX numbered row must move the outline current marker before
// the asynchronous editor-state round trip completes.
assert.match(content, /setNumberedOutlinePendingCursor\(sourceIndex\);[\s\S]*?updateNumberedOutlineActiveIndicator\(sourceIndex\);[\s\S]*?bridgeRequest\("setCursor"/);
assert.match(content, /numberedOutlinePendingCursorIndex/);
assert.match(content, /requestAnimationFrame\?\.\(\(\) => updateNumberedOutlineActiveIndicator/);

// The active target is the last visible numbered element after the most recent
// structural section/subsection boundary.
assert.match(content, /function numberedOutlineActiveEntryForCursor\(/);
assert.match(content, /if \(entryIndex < latestSectionIndex\) continue;/);
assert.match(content, /if \(body && !numberedOutlineLinkForEntry\(body, entry\)\) continue;/);

// Reuse CollabTeX's native current-item class and temporarily suppress the
// native section marker while a deeper numbered element is active.
assert.match(content, /outline-item-link-highlight/);
assert.match(content, /suppressNativeOutlineHighlight\(body\);/);
assert.match(content, /restoreSuppressedNativeOutlineHighlight\(body\);/);
assert.match(content, /link\.setAttribute\("aria-current", "location"\)/);

// Collapsing the numbered rows must immediately recompute the target so the
// indicator falls back to CollabTeX's structural section/subsection entry.
assert.match(content, /setNumberedOutlineCollapsed\(toggle, list, nextCollapsed\);[\s\S]*?scheduleNumberedOutlineActiveIndicator\(\);/);

assert.match(css, /\.smarttex-numbered-outline-link\.smarttex-numbered-outline-link-active/);

console.log("Numbered outline current-element synchronization checks passed.");
