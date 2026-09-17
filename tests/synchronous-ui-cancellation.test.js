/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const tasks = read("interaction-tasks.js");
const references = read("reference-autocomplete.js");
const figures = read("figure-autocomplete.js");
const citations = read("citation-autocomplete.js");
const bridge = read("page-bridge.js");
const content = read("content.js");
const toolbar = read("editor-toolbar.js");
const labelGuard = read("label-reference-guard.js");
const latex = read("latex-context.js");
const bibtex = read("bibtex-parser.js");

for (const eventName of ["keydown", "beforeinput", "input", "wheel", "scroll", "touchmove"]) {
  assert.match(tasks, new RegExp(`["']${eventName}["']`));
}
assert.match(tasks, /navigator\?\.scheduling\?\.isInputPending/);
assert.match(tasks, /includeContinuous:\s*true/);
assert.match(tasks, /eventBelongsToEditor/);
assert.match(tasks, /never prevents default or stops propagation/);
assert.match(tasks, /cancelScheduledWork/);
assert.match(tasks, /token\.checkpointCalls/);
assert.match(tasks, /Math\.min\(32, requestedInterval\)/);

assert.match(references, /runSync\(\s*"reference-target-index"/);
assert.match(references, /runSync\(\s*"reference-list-filter"/);
assert.match(references, /if \(!nextRecords\) return false;/);
assert.match(references, /if \(renderPopupNow\(\) === false\) scheduleListRenderRetry\(\)/);
assert.match(figures, /runSync\(\s*"figure-list-filter"/);
assert.match(figures, /const fragment = document\.createDocumentFragment\(\)/);
assert.match(citations, /runSync\(\s*"citation-list-filter"/);
assert.match(citations, /throwIfGenerationChanged/);
assert.match(bridge, /runSync\(\s*"structure-highlight-analysis"/);
assert.match(bridge, /runSync\(\s*"source-overlay-render"/);
assert.match(content, /begin\?\.\(\s*"popup-preview-render"(?:,|\))/);
assert.match(content, /isAbortError\?\.\(error\)/);
assert.match(toolbar, /runSync\(\s*"toolbar-state-analysis"/);
assert.match(labelGuard, /runSync\(\s*"label-reference-analysis"/);
assert.match(latex, /SmartTeXInteractionTasks\?\.checkpoint/);
assert.match(bibtex, /SmartTeXInteractionTasks\?\.checkpoint/);

console.log("Synchronous UI cancellation regression checks passed.");
