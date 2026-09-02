"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const menu = fs.readFileSync(path.join(root, "settings-menu.js"), "utf8");

test("background figure cache keeps decoded media alive and requires fully measured entries", () => {
  assert.match(content, /mediaKeepalive/);
  assert.match(content, /kind === "figure"[\s\S]*staging\.querySelectorAll\("img"\)/);
  assert.match(content, /if \(!metrics\?\.naturalSize\) return;/);
  assert.doesNotMatch(content, /markEnvironmentPreviewCached|PREVIEW_CACHE_DIAGNOSTIC_EVENT/);
});

test("cached geometry measurement does not redundantly decode images with serialized dimensions", () => {
  const block = content.match(/async function measureBackgroundPreviewMarkup\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(block, /cachedPreviewMediaGeometryReady\(shellOutput\)/);
  assert.match(block, /waitForCachedPreviewMedia\(shellOutput\)/);
});

test("caption font uses compact default and persistent S-menu slider", () => {
  assert.match(css, /--smarttex-popup-caption-font-size, 11px/);
  assert.match(menu, /POPUP_CAPTION_FONT_SCALE_KEY/);
  assert.match(menu, /Caption font/);
  assert.match(menu, /captionScale\.type = "range"/);
  assert.match(menu, /captionScale\.min = "50"/);
  assert.match(menu, /captionScale\.max = "200"/);
  assert.match(menu, /applyPopupCaptionFontScale/);
  assert.match(content, /smarttex:set-popup-caption-font-scale/);
});
