const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const gate = fs.readFileSync(path.join(root, 'popup-gate.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'content.css'), 'utf8');

test('single-line editor equation previews get an 80 percent horizontal cap', () => {
  assert.match(gate, /wideSingleLineEquation[\s\S]*widthFraction = wideSingleLineEquation \? 0\.8 : 0\.4/);
  assert.match(gate, /window\.innerWidth \* widthFraction \* relativeScale/);
  assert.match(content, /smarttexEquationSingleLine/);
  assert.match(content, /equationPreviewIsSingleLine/);
});

test('rendered multiline equations stay on the normal cap', () => {
  assert.match(content, /\/\\\\\\\\\/\.test\(source\)/);
  assert.match(content, /querySelectorAll\("\.mtable \.mtr"\)/);
  assert.match(content, /rowCount > 1/);
});

test('equation preview content is never artificially wrapped', () => {
  assert.match(css, /data-preview-kind="equation"[\s\S]*max-width: none;[\s\S]*white-space: nowrap;/);
  assert.match(css, /data-preview-kind="equation"[\s\S]*\.katex[\s\S]*white-space: nowrap;/);
});
