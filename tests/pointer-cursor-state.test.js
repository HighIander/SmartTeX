/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tasks = fs.readFileSync(path.join(root, "interaction-tasks.js"), "utf8");
const bridge = fs.readFileSync(path.join(root, "page-bridge.js"), "utf8");

assert.match(tasks, /event\?\.type === "pointerdown"/);
assert.match(tasks, /if \(reason === "pointer"\) \{[\s\S]*endKeyboardActivity\(\)/);
assert.match(tasks, /"input", "pointerdown", "wheel"/);
assert.match(bridge, /let pointerSelectionActive = false/);
assert.match(bridge, /function scheduleState\(\) \{\s*if \(pointerSelectionActive\) return/);
assert.match(bridge, /document\.addEventListener\("pointerdown"[\s\S]*pointerSelectionActive = true/);
assert.match(bridge, /document\.addEventListener\("pointerup"[\s\S]*pointerSelectionActive = false;[\s\S]*schedulePointerState\(\)/);
assert.match(bridge, /function schedulePointerState\(\)[\s\S]*queueMicrotask[\s\S]*emitPreviewState[\s\S]*emitState\(pointerStateRevision, state\)/);
assert.doesNotMatch(bridge, /const events = \[[\s\S]*?"mouseup"[\s\S]*?\];/);

console.log("Pointer cursor-state transaction checks passed.");
