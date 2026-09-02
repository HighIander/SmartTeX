/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const tasks = read("interaction-tasks.js");
const bridge = read("page-bridge.js");
const review = read("review.js");
const content = read("content.js");
const preview = read("document-preview.js");
const toolbar = read("editor-toolbar.js");
const labelGuard = read("label-reference-guard.js");
const projectFiles = read("project-files.js");
const comments = read("comments.js");

assert.match(tasks, /const KEYBOARD_IDLE_MS = 500/);
assert.match(tasks, /const KEYBOARD_TRANSACTION_MS = 120/);
assert.match(tasks, /function keyboardIdleRemaining\(\)/);
assert.match(tasks, /const KEYBOARD_IDLE_EVENT = "smarttex:keyboard-idle"/);
assert.match(tasks, /data-smarttex-editor-typing/);
assert.match(tasks, /function finishKeyboardActivity\(\)/);
assert.match(tasks, /function parseEditorState\(value\)/);
assert.match(tasks, /function canRunLongTask\(state, sourceLength = 0\)/);
assert.match(tasks, /function canRunBackgroundTask\(state, sourceLength = 0\)/);
assert.match(tasks, /if \(!notifySubscribers\) return/);
assert.match(tasks, /now - lastKeyboardSubscriberAt > KEYBOARD_TRANSACTION_MS/);

assert.match(bridge, /stateTimer = window\.setTimeout\(\(\) => emitState\(revision\), idleDelay\)/);
assert.match(bridge, /if \(expectedRevision !== stateScheduleRevision\) return/);
assert.match(bridge, /function renderSourceNumberBadges[\s\S]*if \(keyboardIdleDelay\(\) > 0\) return false/);
assert.match(bridge, /interactionTasks\?\.keyboardIdleEventName \|\| "smarttex:keyboard-idle"/);
assert.match(bridge, /queueMicrotask\(\(\) => emitState\(revision\)\)/);
assert.match(bridge, /interactionTasks\?\.subscribe\?\.\(\(\) =>/);
assert.doesNotMatch(bridge, /if \(activity\?\.reason === "keyboard"\) scheduleState\(\)/);
assert.match(bridge, /Poll(?:ing)? previously copied the complete[\s\S]*if \(!editor \|\| !root\?\.isConnected\) refreshEditorBinding\(\)/);
assert.doesNotMatch(bridge, /const state = getEditorState\(\);\s*if \(state && stateFingerprint\(state\) !== lastFingerprint\)/);
assert.match(bridge, /if \(!mutations\.some\(occludingOverlayMutation\)\) return/);
assert.match(bridge, /if \(editor && root\?\.isConnected\) return/);

assert.match(review, /const idleDelay = Math\.max\(\s*500,[\s\S]*keyboardIdleRemaining/);
assert.match(review, /if \(lastRoutedStateAt < requestedAt\) void captureTrackedEditorState\(\)/);
assert.doesNotMatch(review, /immediateStateCaptureTimer|trailingStateCaptureTimer|settledStateCaptureTimer/);

assert.match(content, /canRunBackgroundTask\(currentState, sourceLength\)/);
assert.match(content, /runSync\("preview-cache-index", collect\)/);
assert.match(content, /begin\?\.\("preview-cache-entry"\)/);
assert.match(content, /function scheduleNumberedOutlineUpdate\(delay = 80\)[\s\S]*keyboardIdleRemaining/);
assert.match(content, /if \(optionsButton\.isConnected && optionsButtonSlot\?\.isConnected\) return/);
assert.match(content, /mutations\.some\(graphicAutocompleteMutation\)/);
assert.match(preview, /const scheduleIntegrationRefresh = \(\) => \{[\s\S]*keyboardIdleRemaining/);
assert.match(toolbar, /function scheduleAttachEditingToolbar\(\)[\s\S]*keyboardIdleRemaining/);
assert.match(labelGuard, /const wait = Math\.max\([\s\S]*keyboardIdleRemaining/);
assert.match(projectFiles, /function scheduleUiRefresh\(delayMs = 80\)[\s\S]*keyboardIdleRemaining/);
assert.match(comments, /function schedulePaneGeometry\(\)[\s\S]*keyboardIdleRemaining/);
const css = read("content.css");
assert.match(css, /html\[data-smarttex-editor-typing="true"\] #smarttex-source-structure-highlights/);
assert.match(review, /function markLocalInput\(event\) \{\s*if \(!trackingEnabled\(\)\) return/);
assert.match(review, /if \(event\.type === "input"\) scheduleTrackedStateCapture\(\)/);

console.log("Typing idle responsiveness regression checks passed.");
