"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// Long, ellipsized numbered rows may be brought into view vertically, but a
// click/active-indicator update must never pan the CollabTeX outline sideways.
assert.match(content, /function numberedOutlineHorizontalScrollSnapshot\(body\)/);
assert.match(content, /function restoreNumberedOutlineHorizontalScroll\(snapshot\)/);
assert.match(content, /function preserveNumberedOutlineHorizontalScroll\(body, action\)/);
assert.match(content, /scrollIntoView\?\.\(\{ block: "nearest", inline: "nearest" \}\)/);
assert.match(content, /preserveNumberedOutlineHorizontalScroll\(body, \(\) => \{[\s\S]*?scrollIntoView/);
assert.match(content, /const horizontalSnapshot = numberedOutlineHorizontalScrollSnapshot\(body\)/);
assert.match(content, /bridgeRequest\("setCursor"[\s\S]*?restoreNumberedOutlineHorizontalScroll\(horizontalSnapshot\)/);

// The consolidated behavior contract must explicitly document the no-horizontal-
// pan invariant so later outline refactors do not reintroduce this regression.
assert.match(content, /must preserve every outline-pane ancestor's horizontal scroll position/);
assert.match(content, /must never pan the File Outline to the right/);

console.log("Numbered outline horizontal-scroll preservation checks passed.");
