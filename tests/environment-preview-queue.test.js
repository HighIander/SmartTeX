/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const taskSource = fs.readFileSync(path.join(__dirname, "..", "interaction-tasks.js"), "utf8");
const jobs = [];
const completed = [];
let warmResult = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = (text, cursorIndex = 20) => ({ value: text, fileName: "main.tex", cursorIndex, selectionFrom: cursorIndex, selectionTo: cursorIndex });
const initialText = "x".repeat(100);
const context = { kind: "table", openStart: 10, closeEnd: 70 };
const sandbox = {
  console, setTimeout, clearTimeout, environmentPreviewSession: null, renderGeneration: 0,
  scheduledPreviewHint: null, activePreviewState: null, currentState: null,
  previousEnvironmentRenderCache: new Map(),
  preview: { hidden: true, dataset: {} },
  window: { setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0) },
  environmentPopupUsesHover: () => false,
  stateCanShowPreview: () => true,
  stateIsInsideDismissedPreview: () => false,
  previewContextIsDismissed: () => false,
  readyPreviewContextForState: () => null,
  findPreviewContext: current => current.cursorIndex < 70 ? { ...context } : null,
  contextEnvironmentRange: current => ({ openStart: current.openStart, closeEnd: current.closeEnd }),
  previewElementKind: current => current.kind,
  previewContextId: (current, parsed) => `${current.fileName}:${parsed.openStart}:${parsed.kind}`,
  warmPreviewCacheForStateContext: () => warmResult,
  positionPreviewAtCursor() {},
  resetPreviewOpening() { sandbox.preview.hidden = true; },
  hidePreview() { sandbox.cancelEnvironmentPreviewSession(); sandbox.preview.hidden = true; },
  async renderPreview(generation, loading, job) {
    if (sandbox.scheduledPreviewHint?.warm) {
      sandbox.scheduledPreviewHint = null;
      sandbox.preview.hidden = false;
      return;
    }
    const token = sandbox.interactionTasks.begin("delayed-preview", sandbox.environmentPreviewTaskOptions(job.session));
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    jobs.push({ state: job.state, release, token });
    try {
      await pending;
      sandbox.interactionTasks.checkpoint(0, 1, token);
      sandbox.interactionTasks.checkpoint(0, 1);
      assert.equal(generation, sandbox.renderGeneration);
      completed.push(job.state.value);
      sandbox.preview.hidden = false;
    } finally { sandbox.interactionTasks.end(token); }
  }
};
vm.createContext(sandbox);
vm.runInContext(taskSource, sandbox);
sandbox.interactionTasks = sandbox.SmartTeXInteractionTasks;
const start = source.indexOf("  function environmentPreviewTaskOptions(");
const end = source.indexOf("  function previewHintMatchesState(", start);
vm.runInContext(source.slice(start, end), sandbox);
const sourceRange = { openStart: 10, closeEnd: 70 };
assert.equal(sandbox.previewRangeAfterEdit(sourceRange, initialText, initialText + "outside").closeEnd, 70);
assert.equal(sandbox.previewRangeAfterEdit(sourceRange, initialText, initialText.slice(0, 20) + "new" + initialText.slice(20)).closeEnd, 73);
assert.equal(sandbox.previewRangeAfterEdit(sourceRange, initialText, "new" + initialText).openStart, 13);
async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), "queue operation must complete");
}
(async () => {
  sandbox.queueEnvironmentPreview(state(initialText));
  await waitFor(() => jobs.length === 1);
  const background = sandbox.interactionTasks.begin("background");
  for (let index = 1; index <= 12; index += 1) {
    sandbox.interactionTasks.cancel("keyboard");
    sandbox.queueEnvironmentPreview(state(initialText + "a".repeat(index)));
  }
  assert.throws(() => sandbox.interactionTasks.checkpoint(0, 1, background), /aborted/);
  sandbox.interactionTasks.end(background);
  assert.equal(jobs.length, 1, "typing cannot replace or overlap the in-flight render");
  sandbox.queueEnvironmentPreview({ ...state(initialText + "a".repeat(12)), focused: false, screen: null });
  assert.throws(
    () => sandbox.interactionTasks.checkpoint(0, 1, jobs[0].token),
    /aborted/,
    "typing cancels the non-cached render already in flight"
  );
  jobs[0].release();
  await waitFor(() => jobs.length === 2);
  assert.equal(completed.length, 0, "the cancelled snapshot cannot publish");
  assert.equal(jobs[1].state.value, initialText + "a".repeat(12), "only the newest buffered edit is rendered next");
  sandbox.queueEnvironmentPreview(state(initialText + "a".repeat(12), 99));
  assert.equal(sandbox.preview.hidden, true, "leaving the environment closes immediately");
  assert.throws(() => sandbox.interactionTasks.checkpoint(0, 1, jobs[1].token), /environment-exit/);
  jobs[1].release();
  await pause(100);
  assert.equal(completed.length, 0, "exited work cannot publish a late result");
  assert.equal(sandbox.preview.hidden, true);
  assert.equal(sandbox.environmentPreviewSession, null);
  const jobCountBeforeWarmOpen = jobs.length;
  warmResult = { exact: true, stale: false, entry: { markup: "cached" } };
  sandbox.queueEnvironmentPreview(state(initialText));
  await waitFor(() => sandbox.environmentPreviewSession?.renderedState);
  await pause(80);
  assert.equal(jobs.length, jobCountBeforeWarmOpen, "an exact current cache hit must not schedule a second render");
  sandbox.queueEnvironmentPreview(state(initialText, 99));
  console.log("Environment preview queue runtime checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
