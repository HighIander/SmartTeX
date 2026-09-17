/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const listeners = new Map();
const timers = new Map();
let timerId = 0;
const classes = new Set();
const scrollStates = [];
const attributes = new Map();

const editorTarget = {
  scrollTop: 0,
  scrollLeft: 0,
  matches(selector) { return String(selector).includes(".ace_scroller"); },
  closest(selector) { return String(selector).includes(".ace_") ? this : null; },
  querySelector() { return this; },
  parentElement: null
};

class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}

const sandbox = {
  console,
  CustomEvent,
  scrollX: 0,
  scrollY: 0,
  navigator: { scheduling: { isInputPending() { return false; } } },
  document: {
    activeElement: editorTarget,
    scrollingElement: null,
    documentElement: {
      getAttribute(name) { return attributes.get(name); },
      hasAttribute(name) { return attributes.has(name); },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      classList: {
        toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
      }
    }
  },
  addEventListener(type, callback) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
  },
  dispatchEvent(event) {
    if (event.type === "smarttex:editor-scroll-state") scrollStates.push(event.detail);
    for (const callback of listeners.get(event.type) || []) callback(event);
    return true;
  },
  setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  requestAnimationFrame(callback) { callback(); return 1; },
  cancelAnimationFrame() {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "interaction-tasks.js"), "utf8"), sandbox, {
  filename: "interaction-tasks.js"
});

function emit(type, target = editorTarget, details = {}) {
  for (const callback of listeners.get(type) || []) {
    callback({ type, target, composedPath: () => [target], ...details });
  }
}

const popupTarget = {
  closest(selector) { return String(selector).includes("#smarttex-reference-autocomplete-popup") ? this : null; },
  parentElement: null
};
const generationBeforePopupWheel = sandbox.SmartTeXInteractionTasks.generation();
emit("wheel", popupTarget);
assert.equal(
  sandbox.SmartTeXInteractionTasks.generation(),
  generationBeforePopupWheel,
  "scrolling inside a SmartTeX popup must not hide or cancel the popup"
);

// Navigation, including extended selections, never starts the typing barrier.
for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Shift", "Control", "Alt", "Meta"]) {
  emit("keydown", editorTarget, { key, shiftKey: true });
  assert.equal(attributes.has("data-smarttex-editor-typing"), false, key);
  assert.ok(sandbox.SmartTeXInteractionTasks.keyboardIdleRemaining() > 0, key);
  emit("scroll");
  assert.equal(classes.has("smarttex-editor-scrolling"), false, key);
}
// Cursor-driven horizontal scrolling hides overlays only after displacement.
emit("keydown", editorTarget, { key: "ArrowRight" });
editorTarget.scrollLeft = 32;
emit("scroll");
assert.equal(classes.has("smarttex-editor-scrolling"), true);
assert.equal(sandbox.SmartTeXInteractionTasks.scrollIdleMs, 500);
for (const timer of [...timers.values()]) timer.callback();
assert.equal(classes.has("smarttex-editor-scrolling"), false);

// Text edits still freeze stale decorations until typing settles.
emit("keydown");
assert.equal(attributes.get("data-smarttex-editor-typing"), "true");
sandbox.SmartTeXInteractionTasks.endKeyboardActivity();
emit("beforeinput", editorTarget, { inputType: "insertText" });
assert.equal(attributes.get("data-smarttex-editor-typing"), "true");
sandbox.SmartTeXInteractionTasks.endKeyboardActivity();
assert.equal(classes.has("smarttex-editor-scrolling"), false);
emit("wheel");
assert.equal(classes.has("smarttex-editor-scrolling"), false);

// A spurious scroll event at an unchanged offset must not hide overlays.
emit("scroll");
assert.equal(classes.has("smarttex-editor-scrolling"), false);

// Only an actual viewport displacement starts the hidden-scroll state.
editorTarget.scrollTop = 48;
timers.clear();
emit("scroll");
assert.equal(classes.has("smarttex-editor-scrolling"), true);
assert.equal(sandbox.SmartTeXInteractionTasks.isScrolling(), true);
assert.equal(sandbox.SmartTeXInteractionTasks.canRunLongTask({}, 0), false);
assert.equal(scrollStates.at(-1)?.active, true);
assert.deepEqual([...timers.values()].map((timer) => timer.delay), [500]);

for (const timer of [...timers.values()]) timer.callback();
assert.equal(classes.has("smarttex-editor-scrolling"), false);
assert.equal(sandbox.SmartTeXInteractionTasks.isScrolling(), false);
assert.equal(scrollStates.at(-1)?.active, false);

const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
for (const selector of [
  "#smarttex-source-structure-highlights",
  "#smarttex-source-number-badges",
  "#smarttex-equation-preview",
  ".smarttex-document-reference-popup",
  "#smarttex-reference-autocomplete-popup",
  "#smarttex-citation-popup",
  "#smarttex-figure-autocomplete-popup",
  "#smarttex-review-comment-highlights",
  "#smarttex-review-markup-layer",
  "#smarttex-collaboration-presence-layer"
]) {
  assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.match(css, /data-smarttex-source-overlays-pending/);

const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.match(content, /popupsSuppressedAfterEditorScroll = true/);
assert.doesNotMatch(content, /active !== false[\s\S]{0,300}scheduleRender\(\)/);
for (const file of ["citation-autocomplete.js", "reference-autocomplete.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(source, /event\?\.detail\?\.active === true[\s\S]*scrollSuppressed = true;[\s\S]*hidePopup\(\);[\s\S]*return;/);
  assert.match(source, /interactionTasks\?\.isScrolling\?\.\(\)[\s\S]*positionPopup\(\)/);
}
const figureAutocomplete = fs.readFileSync(path.join(root, "figure-autocomplete.js"), "utf8");
assert.match(
  figureAutocomplete,
  /event\?\.detail\?\.active === true[\s\S]*scrollSuppressed = true;[\s\S]*hidePopup\(\);[\s\S]*return;[\s\S]*updateFromState\(\)/,
  "Figure autocomplete must refresh only after scrolling settles."
);
assert.match(figureAutocomplete, /interactionTasks\?\.isScrolling\?\.\(\)[\s\S]*positionPopup\(\)/);
assert.match(
  content,
  /active === true[\s\S]*popupsSuppressedAfterEditorScroll = true;[\s\S]*cancelPendingEnvironmentPreviewRender\(\);[\s\S]*hidePreview\(\{ clearDismissal: false, force: true \}\)[\s\S]*return;/,
  "Scrolling must cancel work and close the environment popup immediately."
);
assert.match(fs.readFileSync(path.join(root, "page-bridge.js"), "utf8"), /smarttex:editor-scroll-state/);
assert.match(fs.readFileSync(path.join(root, "page-bridge.js"), "utf8"), /setSourceOverlaysPending\(true\)/);

console.log("Actual editor-scroll overlay visibility tests passed.");
