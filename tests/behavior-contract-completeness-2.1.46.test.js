/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const normalizedContent = content.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");

// The consolidated source comment is an intentional regression specification
// for the user-visible behavior accumulated during the popup/outline work. It
// should cover each requirement family so later refactors cannot silently lose
// the intent while preserving only incidental implementation details.
const requiredIntentPhrases = [
  "sliders are the only persistent popup-size setting",
  "Mouse edge/corner resizing is deliberately temporary",
  "captions span the complete popup content width",
  "50-200%, with 100% = 11 px",
  "Popup headers use a grab/grabbing hand cursor",
  "A visible popup keeps its position",
  "Resize hit zones live almost entirely on the outer border",
  "Cold figure/table/equation previews render invisibly first",
  "A loading spinner is shown at the initiating pointer/caret",
  "grow the popup first",
  "down to no less than 75%",
  "A genuinely one-line equation may use up to 80%",
  "must never be artificially line-wrapped",
  "Figure height is special",
  "Editing an already-open equation or figure/table caption updates that same popup live",
  "rendered equation caret is also refreshed in-place",
  "caret is inside a figure/table caption",
  "environment popup is owned by that environment until",
  "Manually closing an environment preview keeps it dismissed",
  "warmed during idle time",
  "Warming starts from the first available document state",
  "background-warmed equation miss on its first opening",
  "already-decoded media nodes",
  "Cached DOM is cloned into a fresh display instance",
  "Single-click on an included graphic jumps the source editor",
  "double-click retains CollabTeX's native behavior",
  "Hovering graphics files shows a cached thumbnail popup",
  "spinner follows the pointer",
  "Numbered equations, figures, and tables are merged into the native outline",
  "one line only (ellipsis instead of wrapping)",
  "disclosure arrows",
  "deepest visible target",
  "updates that marker immediately",
  "must preserve every outline-pane ancestor's horizontal scroll position",
  "must never pan the File Outline to the right",
  "Hovering numbered outline entries shows a compact cached preview",
  "preserve parsed panel/row layout",
  "full caption must fit",
  "native browser tooltips are suppressed"
];

for (const phrase of requiredIntentPhrases) {
  assert.ok(normalizedContent.includes(phrase), `Behavior contract is missing: ${phrase}`);
}

console.log("Accumulated popup/outline requirement-comment audit passed.");
