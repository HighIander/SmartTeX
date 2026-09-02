"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const popupUi = read("popup-gate.js");
const background = read("background.js");
const content = read("content.js");
const citation = read("citation-autocomplete.js");
const reference = read("reference-autocomplete.js");
const figure = read("figure-autocomplete.js");
const figureRenderer = read("figure-renderer.js");
const settingsMenu = read("settings-menu.js");
const css = read("content.css");

assert.match(background, /"popup-gate\.js",[\s\S]*"content\.js"/);
assert.doesNotMatch(background, /"popup-ui\.js"/);
assert.match(popupUi, /smarttex:popup-sizes:v1/);
assert.match(popupUi, /new Set\(\["list", "image", "equation", "table"\]\)/);
for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
  assert.match(popupUi, new RegExp(`"${direction}"`));
}
assert.match(popupUi, /localStorage\.setItem\(STORAGE_KEY/);
assert.match(popupUi, /smarttex:popup-resized/);
assert.match(popupUi, /function resizePopup\(/);
assert.match(popupUi, /const widthRatio = width \/ Math\.max\(1, naturalSize\.width\)/);
assert.match(popupUi, /const heightRatio = height \/ Math\.max\(1, naturalSize\.height\)/);
assert.match(popupUi, /const contentScale = Number\(contentScaleOverride\) > 0[\s\S]*Math\.min\(widthRatio, heightRatio\)/);
assert.match(popupUi, /resizePopup\(popup, state, type, \{ left, top, width, height \}, \{ live: true \}\)/);
assert.match(popupUi, /persist: false/);
assert.match(popupUi, /smarttexTemporarySized/);
assert.match(popupUi, /live: true/);
assert.match(popupUi, /function resetSizes\(\)/);
assert.match(popupUi, /localStorage\.removeItem\(STORAGE_KEY\)/);
assert.match(settingsMenu, /Reset popup sizes/);
assert.match(settingsMenu, /SmartTeXPopupUI\.resetSizes/);

for (const source of [content, citation, reference, figure]) {
  assert.match(source, /smarttex-popup-escape-hint/);
  assert.match(source, /SmartTeXPopupUI\?\.enhance/);
}
assert.match(content, /if \(!graphicAutocompletePreview\.hidden\) dismissGraphicAutocompleteClickPreview\(\)/);
for (const source of [citation, reference, figure]) {
  assert.match(source, /smarttexUserSized !== "true"/);
}

assert.match(citation, /function appendHighlightedText\(/);
assert.match(citation, /className = "smarttex-autocomplete-match"/);
assert.match(citation, /appendHighlightedText\(title,/);
assert.match(citation, /appendHighlightedText\(key,/);
assert.match(citation, /appendHighlightedText\(authors,/);
assert.match(citation, /appendHighlightedText\(publication,/);

assert.match(css, /\.smarttex-popup-resize-handle\[data-direction="se"\]::before/);
assert.match(css, /pointer-events:\s*auto !important/);
assert.match(css, /linear-gradient\(135deg,[\s\S]*linear-gradient\(135deg/);
assert.match(popupUi, /window\.addEventListener\("pointermove", move/);
assert.match(css, /#smarttex-equation-preview\[data-smarttex-user-sized="true"\]/);
assert.match(css, /#smarttex-graphic-autocomplete-preview\[data-smarttex-user-sized="true"\]/);
assert.match(css, /\.smarttex-float-popup-caption[\s\S]*var\(--smarttex-popup-content-scale/);
assert.match(figureRenderer, /const maximumFitScale = popup\?\.dataset\.smarttexUserSized === "true" \? 4 : 1/);
assert.match(figureRenderer, /resizableOutput\.clientWidth - padding/);
assert.match(figureRenderer, /fixedWidth \* imageScale \* layoutScale/);
assert.match(figureRenderer, /smarttex-graphic-autocomplete-figure/);
assert.match(figureRenderer, /viewport\.style\.width = "100%"/);
assert.match(content, /isFigure \? "image" : isTable \? "table" : "equation"/);
assert.match(css, /data-smarttex-popup-type="table"[\s\S]*--smarttex-table-render-scale/);
assert.match(content, /className = "smarttex-figure-zoom-controls smarttex-preview-zoom-controls"/);
assert.match(content, /output\.addEventListener\("wheel"/);
assert.match(content, /function fitTablePreview\(\)/);
assert.match(content, /renderedTable\.replaceChildren/);
assert.match(content, /if \(previewPositioned\) positionPreviewAtCursor\(\)/);

console.log("Popup close, match highlighting, resizing, and persistence checks passed.");
