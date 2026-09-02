/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const gate = fs.readFileSync(path.join(root, "popup-gate.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");

test("popup move header explicitly participates in hit testing", () => {
  assert.match(gate, /heading\.style\.setProperty\("pointer-events", "auto", "important"\)/);
  assert.match(css, /\.smarttex-popup-move-handle,[\s\S]*pointer-events:\s*auto\s*!important;[\s\S]*cursor:\s*grab\s*!important;/);
  assert.match(gate, /popup\.addEventListener\("pointerdown",[\s\S]*startMove\(event, popup, state, liveHeading\)/);
});

test("version is current", () => {
  assert.match(manifest, /"version"\s*:\s*"2\.1\.\d+"/);
});
