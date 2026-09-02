"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");

// SmartTeX entries must stay invisible to CollabTeX's native outline indexing.
assert.match(content, /const list = document\.createElement\("div"\);/);
assert.match(content, /const item = document\.createElement\("div"\);/);
assert.match(content, /const link = document\.createElement\("div"\);/);
assert.doesNotMatch(content, /item\.setAttribute\("role", "treeitem"\)/);
assert.doesNotMatch(content, /list\.setAttribute\("role", "group"\)/);
assert.doesNotMatch(content, /button\.className = "smarttex-numbered-outline-link"/);

// Each section with numbered entries gets its own independent disclosure arrow.
assert.match(content, /function attachNumberedOutlineToggle\(nativeItem, section, list\)/);
assert.match(content, /control\.prepend\(toggle\)/);
assert.match(content, /numberedOutlineCollapsedSections\.add\(collapseKey\)/);
assert.match(content, /numberedOutlineCollapsedSections\.delete\(collapseKey\)/);
assert.match(content, /setNumberedOutlineCollapsed\(toggle, list, nextCollapsed\)/);
assert.match(content, /toggle\.dataset\.smarttexSectionIndex/);
assert.match(content, /body\.querySelectorAll\("\.smarttex-numbered-outline-toggle"\)/);

// Clicking the triangle must not activate the native section header.
assert.match(content, /event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);/);

assert.match(css, /\.smarttex-numbered-outline-toggle\s*\{/);
assert.match(css, /\.smarttex-numbered-outline-toggle::before\s*\{/);
assert.match(css, /smarttex-numbered-outline-toggle-collapsed::before/);
assert.match(css, /\.smarttex-numbered-outline-list\[hidden\]/);

console.log("Numbered outline active-section/collapse checks passed.");
