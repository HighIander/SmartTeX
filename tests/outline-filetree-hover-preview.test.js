/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const versionPatch = Number(String(manifest.version).split(".")[2]);
assert.equal(String(manifest.version).startsWith("2.1."), true);
assert.ok(versionPatch >= 35);

// Numbered outline rows schedule a lightweight hover preview but keep the
// existing click navigation path untouched.
assert.match(content, /STRUCTURE_HOVER_PREVIEW_DELAY_MS = 180/);
assert.match(content, /link\.addEventListener\("pointerenter", \(event\) => \{[\s\S]*?scheduleNumberedOutlineHoverPreview\(link, entry, event\)/);
assert.match(content, /link\.addEventListener\("pointerleave", \(\) => \{[\s\S]*?hideStructureHoverPreview\(\)/);
assert.match(content, /jumpFromNumberedOutline\(entry\)/);

// Equations and tables use the existing renderers while figures use the
// shared cached media loader without opening/repositioning the normal popup.
assert.match(content, /katex\.render\(prepared\.body, equation/);
assert.match(content, /tableRenderer\.renderTable/);
assert.match(content, /renderer\.createMedia\(file\.path \|\| path, file\.url/);
assert.doesNotMatch(content, /buildNumberedOutlineHoverPreview[\s\S]{0,8000}positionPreviewAtCursor/);

// Graphics in the native CollabTeX file tree are detected independently of
// whether they are included, and delegated pointerover/out avoids mousemove
// rerendering while the pointer remains in the same row.
assert.match(content, /function fileTreeGraphicItemFromNode\(/);
assert.match(content, /smarttex-figure-tree-item/);
assert.match(content, /document\.addEventListener\("pointerover"/);
assert.match(content, /item\.contains\(event\.relatedTarget\)/);
assert.match(content, /document\.addEventListener\("pointerout"/);

// Preview is rendered before it is positioned/revealed and is constrained to
// the viewport. It is noninteractive, so it cannot steal hover/click events.
assert.match(content, /smarttex-structure-hover-preview-measuring/);
assert.match(content, /positionStructureHoverPreview\(anchor, popup\)/);
assert.match(content, /window\.addEventListener\("scroll", \(\) => hideStructureHoverPreview\(\), true\)/);
assert.match(css, /#smarttex-structure-hover-preview\s*\{/);
assert.match(css, /pointer-events:\s*none/);
assert.match(css, /smarttex-structure-hover-media-grid/);
assert.match(css, /smarttex-structure-hover-file-body/);


// Rich previews suppress competing browser title tooltips. Numbered rows use
// aria-label instead of title, while native file-tree titles are removed only
// during the active hover and restored afterwards.
assert.match(content, /link\.setAttribute\("aria-label", numberedOutlineEntryTitle\(entry\)\)/);
assert.doesNotMatch(content, /link\.title = numberedOutlineEntryTitle\(entry\)/);
assert.match(content, /function suppressStructureHoverTooltips\(root\)/);
assert.match(content, /function restoreStructureHoverTooltips\(\)/);

// Figure hover previews preserve the parsed row/panel hierarchy so graphics
// that are vertically stacked in one figure remain stacked in the thumbnail.
assert.match(content, /smarttex-structure-hover-figure-row/);
assert.match(content, /smarttex-structure-hover-figure-panel/);
assert.match(content, /smarttex-structure-hover-figure-image-slot/);
assert.match(css, /smarttex-structure-hover-figure-layout/);
assert.match(css, /smarttex-structure-hover-figure-panel\s*\{[\s\S]*?flex-direction:\s*column/);

// A dedicated loading spinner is shown before rendering and tracks the live
// pointer until the preview is fully positioned and revealed.
assert.match(content, /function showStructureHoverSpinner\(\)/);
assert.match(content, /function updateStructureHoverPointer\(event\)/);
assert.match(content, /showStructureHoverSpinner\(\);[\s\S]*?requestAnimationFrame[\s\S]*?await builder\(\)/);
assert.match(content, /document\.addEventListener\("pointermove", \(event\) => \{[\s\S]*?updateStructureHoverPointer\(event\)/);
assert.match(css, /smarttex-structure-hover-loading-spinner/);

// Figure and table captions use the same inline-LaTeX rendering path as the
// normal float popup, including document macros and rendered references.
assert.match(content, /function appendStructureHoverCaption\(/);
assert.match(content, /tableRenderer\.renderInlineLatex\(prepared\.body/);
assert.match(content, /renderReference: createCaptionReferenceLink/);
assert.match(content, /entry\.caption \|\| target\.caption/);

console.log("Outline/file-tree hover preview checks passed.");
