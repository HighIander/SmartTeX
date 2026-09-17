"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
require(path.join(root, "latex-context.js"));
const tools = globalThis.SmartTeXLatexContext;
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");

test("equation parser structural kinds are normalized before popup cache lookup", () => {
  const source = "\\begin{equation}a=b\\end{equation}";
  const analyzed = tools.analyzeEquations(source).contexts[0];
  const opened = tools.findEquationContext(source, source.indexOf("a=b") + 1);

  // This is the real mismatch that caused the first-open miss: equation
  // contexts intentionally keep parser-level kinds such as "environment".
  assert.equal(analyzed.kind, "environment");
  assert.equal(opened.kind, "environment");

  const helper = content.match(/function previewElementKind\(context\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(helper, /return "equation";/);

  const identityBlock = content.match(/function previewEnvironmentIdentity\(state, context\) \{[\s\S]*?\n  \}/)?.[0] || "";
  const keyBlock = content.match(/function previewBaseCacheKey\(state, context\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(identityBlock, /previewElementKind\(context\)/);
  assert.match(keyBlock, /previewEnvironmentIdentity\(state, context\)/);
  assert.doesNotMatch(keyBlock, /String\(context\?\.kind/);
});

test("live equation lifecycle also uses the logical preview kind", () => {
  assert.match(content, /previewElementKind\(activePreviewContext\) !== "equation"/);
  assert.match(content, /previewElementKind\(context\) !== "equation"/);
  assert.doesNotMatch(content, /activePreviewContext\?\.kind !== "equation"/);
  assert.doesNotMatch(content, /context\.kind !== "equation"/);
});
