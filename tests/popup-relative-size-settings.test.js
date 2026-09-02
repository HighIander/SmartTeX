"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const menu = read("settings-menu.js");
const popup = read("popup-gate.js");
const css = read("content.css");
const manifest = JSON.parse(read("manifest.json"));

assert.equal(manifest.version, "2.1.14");
assert.match(menu, /POPUP_SCALE_KEY = "smarttex:popup-scale:v1"/);
assert.match(menu, /globalScale\.min = "50"/);
assert.match(menu, /globalScale\.max = "200"/);
assert.match(menu, /\[\["image", "Image"\], \["equation", "Equation"\], \["table", "Table"\]\]/);
assert.match(menu, /detailToggle\.textContent = separate \? "▴" : "▾"/);
assert.match(menu, /globalScaleWrap\.hidden = separate/);
assert.match(menu, /separateScales\.hidden = !separate/);
assert.match(menu, /SmartTeXPopupUI\.setRelativeSizeSettings/);
assert.match(menu, /global: 1,[\s\S]*image: 1,[\s\S]*equation: 1,[\s\S]*table: 1/);
assert.match(popup, /RELATIVE_SCALE_KEY = "smarttex:popup-scale:v1"/);
assert.match(popup, /new Set\(\["image", "equation", "table"\]\)/);
assert.match(popup, /Math\.max\(0\.5, Math\.min\(2/);
assert.match(popup, /writeRelativeSettings\(\);[\s\S]*querySelectorAll\("\.smarttex-popup-resizable"\)/);
assert.match(popup, /applySize\(popup, state, state\.type,[\s\S]*widthRatio: ratio,[\s\S]*heightRatio: ratio[\s\S]*persist: false/);
assert.match(popup, /setRelativeSizeSettings/);
assert.match(css, /smarttex-settings-popup-global-scale/);
assert.match(css, /smarttex-settings-popup-separate-scales/);

console.log("Remembered relative popup-size controls passed.");
