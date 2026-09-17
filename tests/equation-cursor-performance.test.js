"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.join(__dirname, "..");
require(path.join(root, "latex-context.js"));
const tools = globalThis.SmartTeXLatexContext;

const equations = [];
for (let index = 0; index < 800; index += 1) {
  equations.push(`\\begin{equation}\\vect{x}_{${index}} = ${index}\\end{equation}`);
}
const source = [
  "\\newcommand{\\vect}[1]{\\mathbf{#1}}",
  "\\newcommand{\\pair}[2][x]{#1+#2}",
  ...equations
].join("\n");

const analysis = tools.analyzeEquations(source);
assert.equal(analysis.contexts.length, 800);
assert.equal(analysis.finalCounter, 800);
assert.equal(analysis.numberingByOpenStart.get(analysis.contexts[399].openStart).numbers[0].value, "400");

const target = analysis.contexts[700];
const cursorStart = target.contentStart;
const cursorEnd = target.contentEnd;
const startedAt = performance.now();
for (let pass = 0; pass < 10000; pass += 1) {
  const cursor = cursorStart + (pass % Math.max(1, cursorEnd - cursorStart + 1));
  const context = tools.findEquationContextFromAnalysis(source, cursor, analysis);
  assert.equal(context.openStart, target.openStart);
}
const elapsed = performance.now() - startedAt;
// This is deliberately generous and only guards against accidentally
// reintroducing a complete-document parse for every cursor position.
assert.ok(elapsed < 1500, `cached cursor lookup took ${elapsed.toFixed(1)} ms`);

const prepared = tools.prepareDocumentCommandContext(source, target.openStart);
const first = tools.applyPreparedDocumentCommands(prepared, "\\vect{x}");
const second = tools.applyPreparedDocumentCommands(prepared, "\\pair[y]{z}");
assert.equal(first.macros["\\vect"], "\\mathbf{#1}");
assert.equal(second.body, "{y+z}");

const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.match(content, /SOURCE_RENDER_DELAY_MS/);
assert.match(content, /cursorOnlyUpdate[\s\S]*scheduleEnvironmentPreviewSession\(session, cursorOnlyUpdate\)/);
assert.match(content, /session\.immediateRequested[\s\S]*if \(runImmediately \|\| cacheOnly\)[\s\S]*runEnvironmentPreviewSession\(session, \{ cacheOnly \}\)[\s\S]*Math\.max\(48, typingDelay\)/);
assert.match(content, /equationRenderData: new Map\(\)/);
assert.match(content, /activeEquationContextForState\(state\) \|\| cachedEquationContextForState\(state\)/);
assert.match(content, /const equationRenderData = equationRenderDataForState\(state, context\)/);
assert.match(content, /sourceChanged \? canonicalPreviewBaseMarkup\(lastSuccessfulMarkup\) : ""/);
assert.match(
  content,
  /if \(generation !== renderGeneration\) return;\s*if \(!stateCanShowPreview\(state\)\) \{\s*hidePreview\(\)/s,
  "A superseded equation render must not hide the popup owned by the latest keystroke."
);

const bridge = fs.readFileSync(path.join(root, "page-bridge.js"), "utf8");
assert.match(bridge, /if \(source === cachedStructureSource\) \{ scheduleOverlayRender\(\); return; \}/);
assert.match(bridge, /scroller\?\.addEventListener\("scroll", scheduleOverlayRender/);
assert.match(bridge, /editor\.renderer\?\.on\?\.\("afterRender", scheduleOverlayRender\)/);
assert.match(bridge, /queueMicrotask\(\(\) => emitState\(revision\)\)/);

console.log(`Equation cursor performance regression checks passed (${elapsed.toFixed(1)} ms for 10,000 cached lookups).`);
