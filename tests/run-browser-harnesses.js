/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleRoot = process.argv[2];
if (!moduleRoot) {
  throw new Error("Pass the bundled node_modules directory as the first argument.");
}
const { chromium } = require(path.join(moduleRoot, "playwright"));
const executablePath = process.argv[3] || undefined;

const allHarnesses = [
  { file: "popup-content-reset-harness.html", attribute: "popupContentResetTest" },
  { file: "click-list-priority-browser-harness.html", attribute: "clickListPriorityTest" },
  {
    file: "typing-idle-browser-harness.html",
    attribute: "typingIdleTest"
  },
  {
    file: "uninterrupted-preview-browser-harness.html",
    attribute: "uninterruptedPreviewTest"
  },
  {
    file: "cursor-highlight-browser-harness.html",
    attribute: "cursorHighlightTest"
  },
  {
    file: "keyboard-preview-browser-harness.html",
    attribute: "keyboardPreviewTest"
  },
  {
    file: "citation-bridge-harness.html",
    attribute: "citationBridgeTest"
  },
  {
    file: "citation-autocomplete-harness.html",
    attribute: "citationTest"
  },
  {
    file: "citation-typing-persistence-harness.html",
    attribute: "citationTypingPersistenceTest"
  },
  {
    file: "citation-hover-harness.html",
    attribute: "citationHoverTest"
  },
  {
    file: "reference-autocomplete-harness.html",
    attribute: "referenceAutocompleteTest"
  },
  {
    file: "includegraphics-hover-preview-harness.html",
    attribute: "includegraphicsHoverTest"
  },
  {
    file: "figure-autocomplete-harness.html",
    attribute: "figureAutocompleteTest"
  },
  {
    file: "direct-autocomplete-routing-harness.html",
    attribute: "directRoutingTest"
  },
  {
    file: "editor-reference-harness.html",
    attribute: "editorReferenceTest"
  },
  {
    file: "popup-trigger-harness.html",
    attribute: "popupTriggerTest"
  },
  {
    file: "controls-harness.html",
    attribute: "controlsTest"
  },
  {
    file: "figure-high-resolution-zoom-harness.html",
    attribute: "figureHighResolutionZoomTest"
  },
  {
    file: "figure-raster-zoom-harness.html",
    attribute: "figureRasterZoomTest"
  },
  {
    file: "figure-environment-preview-harness.html",
    attribute: "figureEnvironmentPreviewTest"
  },
  {
    file: "equation-cursor-performance-harness.html",
    attribute: "equationCursorPerformanceTest"
  },
  {
    file: "equation-creation-harness.html",
    attribute: "equationCreationTest"
  },
  {
    file: "equation-stale-render-harness.html",
    attribute: "equationStaleRenderTest"
  },
  {
    file: "preview-harness.html",
    attribute: "positionTest"
  },
  {
    file: "table-preview-harness.html",
    attribute: "tableTest"
  },
  {
    file: "table-editing-harness.html",
    attribute: "tableEditingTest"
  },
  {
    file: "editor-toolbar-harness.html",
    attribute: "editorToolbarTest"
  },
  {
    file: "popup-interaction-harness.html",
    attribute: "popupInteractionTest"
  },
  {
    file: "figure-caption-live-update-harness.html",
    attribute: "figureCaptionLiveUpdateTest"
  },
  {
    file: "nextcloud-client-harness.html",
    attribute: "nextcloudClientTest"
  },
  {
    file: "nextcloud-project-harness.html",
    attribute: "nextcloudProjectTest"
  }
];

const requestedHarnesses = new Set(process.argv.slice(4));
const harnesses = requestedHarnesses.size
  ? allHarnesses.filter((harness) => requestedHarnesses.has(harness.file))
  : allHarnesses;

async function run() {
  const browser = await chromium.launch({
    executablePath,
    headless: true
  });
  let failed = false;
  try {
    for (const harness of harnesses) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.stack || error.message));
      await page.goto(pathToFileURL(path.join(__dirname, harness.file)).href);
      await page.waitForFunction(
        (attribute) => (
          ["passed", "failed"].includes(document.documentElement.dataset[attribute])
        ),
        harness.attribute,
        { timeout: 30000 }
      );
      const result = await page.evaluate(
        (attribute) => document.documentElement.dataset[attribute],
        harness.attribute
      );
      const output = await page.locator(
        "output[id$='test-result'], output#result"
      ).first().textContent().catch(() => "");
      const passed = result === "passed" && errors.length === 0;
      failed ||= !passed;
      console.log(
        `${passed ? "PASS" : "FAIL"} ${harness.file}: ${output || result}` +
        (errors.length ? ` | ${errors.join(" | ")}` : "")
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
