/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "page-bridge.js"), "utf8");
const start = source.indexOf("  function renderSourceNumberBadges(");
const end = source.indexOf("  function commentIconMarkup(", start);
let paints = 0;
let scrollTop = 0;
let scrollLeft = 0;
let commentRenders = 0;
const layer = { children: [], replaceChildren(fragment) { this.children = fragment.children; paints += 1; } };
const highlightLayer = { ...layer };
const sandbox = {
  editor: {},
  lastEditorState: { cursorIndex: 12 },
  lastStructurePaint: null,
  cachedStructures: { badges: [], highlights: [{ kind: "environment", start: 10, end: 60, firstLineEnd: 20 }] },
  structureHighlightSettings: { activeEnabled: true, environmentEnabled: true },
  keyboardIdleDelay: () => 0,
  sourceOverlaysPending: () => false,
  ensureNumberBadgeLayer: () => layer,
  ensureStructureHighlightLayer: () => highlightLayer,
  editorViewportBounds: () => ({ left: 0, top: 0, right: 500, bottom: 500 }),
  nativeEditorOverlayRects: () => [],
  editorScreenPosition: (index) => ({ pageX: 20 - scrollLeft, pageY: index * 4 - scrollTop, lineHeight: 16 }),
  updateOverlayBounds() {},
  taskCheckpoint() {},
  finishSourceOverlayPaint() {},
  appendHighlightRect(fragment, _bounds, _rect, background) {
    fragment.children.push({ smarttexSourceHighlight: background, style: { background: background.color } });
  },
  colorWithAlpha: (_color, alpha) => `rgba(0, 0, 255, ${alpha})`,
  activeAlpha: (normal, maximum, active) => active ? maximum : normal,
  renderCommentOverlays() { commentRenders += 1; },
  document: { createDocumentFragment: () => ({ children: [] }) },
  window: { scrollX: 0, scrollY: 0 }
};
vm.createContext(sandbox);
vm.runInContext(source.slice(source.indexOf("  function sourceHighlightBackground("), source.indexOf("  function appendHighlightRect(")), sandbox);
vm.runInContext(source.slice(start, end), sandbox);
const render = (cursorIndex) => sandbox.renderSourceNumberBadges({ cursorIndex });
assert.equal(render(12), true);
assert.equal(paints, 2);
const originalNodes = [...highlightLayer.children];
const activeColors = originalNodes.map(node => node.style.background);
for (let index = 13; index < 50; index += 1) render(index);
assert.equal(paints, 2, "cursor movement within an environment must preserve mounted highlights and badges");
assert.equal(commentRenders, 38, "comment overlays retain their independent updates");
render(65);
assert.equal(paints, 2, "crossing an environment boundary must preserve mounted geometry");
assert.deepEqual(highlightLayer.children, originalNodes);
assert.notDeepEqual(originalNodes.map(node => node.style.background), activeColors, "leaving an environment updates shading in place");
scrollTop = 20;
render(66);
assert.equal(paints, 4, "vertical scrolling updates geometry");
scrollLeft = 20;
render(67);
assert.equal(paints, 6, "horizontal scrolling updates geometry");
render(68);
assert.equal(paints, 6, "subsequent stationary cursor movement preserves geometry");
sandbox.cachedStructures = { ...sandbox.cachedStructures };
render(69);
assert.equal(paints, 8, "new source analysis invalidates the paint cache");
sandbox.structureHighlightSettings.environmentColor = "red";
render(69);
assert.equal(paints, 10, "settings changes repaint immediately");
console.log("Cursor highlight persistence runtime checks passed.");
