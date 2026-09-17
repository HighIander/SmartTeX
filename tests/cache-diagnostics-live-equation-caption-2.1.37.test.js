"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const bridge = fs.readFileSync(path.join(root, "page-bridge.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");

// Cache diagnostics were temporary instrumentation and must no longer paint
// green dots in either the source editor or popup header. Cache-origin state may
// remain nonvisual for internal testing/debugging.
assert.doesNotMatch(content, /smarttex-preview-cache-dot/);
assert.doesNotMatch(content, /PREVIEW_CACHE_DIAGNOSTIC_EVENT/);
assert.doesNotMatch(bridge, /PREVIEW_CACHE_DIAGNOSTIC_EVENT|smarttexPreviewCacheDot|background:#22c55e/);
assert.doesNotMatch(css, /smarttex-preview-cache-dot/);
assert.match(content, /smarttexOpenedFromCache/);

// Caption typography remains fixed UI text controlled by the S-menu variable.
assert.match(css, /data-preview-kind="figure"[^}]*smarttex-float-popup-caption[\s\S]*var\(--smarttex-popup-caption-font-size, 11px\)/);
assert.match(css, /data-preview-kind="table"[^}]*smarttex-float-popup-caption[\s\S]*var\(--smarttex-popup-caption-font-size, 11px\)/);

// Live figure/table captions mirror the editor caret with the same marker
// mechanism used by table text/math rendering, without caching cursor-specific
// caption DOM. Arrow-key moves take the immediate caption-only update path.
assert.match(content, /function liveCaptionTextFromLock\(state\)[\s\S]*cursor >= start[\s\S]*\\uE001/);
assert.match(content, /captionHasCaret[\s\S]*captionCacheKey = captionHasCaret \? null/);
assert.match(content, /cursorChanged && captionPreviewIsLocked\(\)[\s\S]*scheduleLiveCaptionUpdate\(currentState, \{ immediate: true \}\)/);
assert.match(content, /cachedExactIsCurrent[\s\S]*needsFloatCaretRefresh[\s\S]*if \(cachedExactIsCurrent && !needsFloatCaretRefresh\) return/);
assert.match(content, /SmartTeXCaret[\s\S]*smarttex-rendered-caret/);

assert.match(manifest, /"version":\s*"2\.1\.(?:4[5-9]|[5-9]\d|\d{3,})"/);
console.log("No cache dots and live caption-caret checks passed.");
