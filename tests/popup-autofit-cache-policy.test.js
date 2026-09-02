const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const gate = fs.readFileSync(path.join(root, 'popup-gate.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'content.css'), 'utf8');
const figure = fs.readFileSync(path.join(root, 'figure-renderer.js'), 'utf8');

test('environment previews grow before zoom and only scroll after 75 percent auto-fit', () => {
  assert.match(gate, /widthFraction = wideSingleLineEquation \? 0\.8 : 0\.4/);
  assert.match(gate, /window\.innerWidth \* widthFraction \* relativeScale/);
  assert.match(gate, /type === \"image\"[\s\S]*\? bounds\.height[\s\S]*window\.innerHeight \* 0\.4 \* relativeScale/);
  assert.match(content, /previewPopupUI\?\.growForContent\?\./);
  assert.match(content, /previewAutoFitZoom = Math\.max\(\s*0\.75,/s);
  assert.match(content, /smarttex-preview-scroll-fallback/);
  assert.match(css, /smarttex-preview-scroll-fallback[\s\S]*overflow: auto !important/);
  assert.match(figure, /const minimumFitScale = requestedScale \* autoFitScale/);
});

test('intrinsic measurement happens without viewport caps before final sizing', () => {
  assert.match(content, /smarttex-preview-intrinsic-measure/);
  assert.match(css, /smarttex-preview-intrinsic-measure[\s\S]*max-width: none !important/);
  assert.match(css, /smarttex-preview-intrinsic-measure[\s\S]*overflow: visible !important/);
});

test('popup thumbnail and caption caches are bounded and warmed in background', () => {
  assert.match(content, /const previewRenderCache = new Map\(\)/);
  assert.match(content, /const previewBaseRenderCache = new Map\(\)/);
  assert.match(content, /const structureHoverRenderCache = new Map\(\)/);
  assert.match(content, /const captionRenderCache = new Map\(\)/);
  assert.match(content, /requestIdleCallback/);
  assert.match(content, /buildBackgroundPopupCache/);
  assert.match(content, /cachedNumberedOutlineHoverPreview/);
  assert.match(content, /captionRenderCache/);
});
