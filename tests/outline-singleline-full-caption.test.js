const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");

assert.match(css, /\.smarttex-numbered-outline-link\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?white-space:\s*nowrap;/);
assert.match(css, /\.smarttex-numbered-outline-label\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
assert.match(css, /\.smarttex-structure-hover-caption\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/);
assert.doesNotMatch(css, /\.smarttex-structure-hover-caption\s*\{[\s\S]*?max-height:\s*42px/);
console.log("outline single-line/full-caption regressions passed");
