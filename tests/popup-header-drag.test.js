const fs = require('fs');
const assert = require('assert');
const source = fs.readFileSync('popup-gate.js', 'utf8');
const css = fs.readFileSync('content.css', 'utf8');
assert.match(source, /function startMove\(/);
assert.match(source, /popup\.addEventListener\("pointerdown"[\s\S]*liveHeading[\s\S]*startMove\(event, popup, state, liveHeading\)/);
assert.match(source, /popup\.style\.left = `\$\{Math\.round\(left\)\}px`/);
assert.match(source, /popup\.style\.top = `\$\{Math\.round\(top\)\}px`/);
assert.match(source, /restoreTemporaryMove\(popup, state\)/);
assert.match(css, /\.smarttex-popup-move-handle,[\s\S]*?cursor:\s*grab\s*!important/);
assert.match(css, /\.smarttex-popup-moving \.smarttex-popup-move-handle,[\s\S]*?cursor:\s*grabbing\s*!important/);
console.log('Popup header drag checks passed.');

assert.match(css, /smarttex-popup-resizable > \.smarttex-preview-heading[\s\S]*cursor:\s*grab\s*!important/);
