const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('live equation edit session vetoes generic popup hides', () => {
  assert.match(
    content,
    /function hidePreview\([\s\S]*?if \(!force && liveEquationEditSessionContainsState\(currentState\)\) \{[\s\S]*?hidePreviewLoading\(\);[\s\S]*?return false;/
  );
});

test('editor auto-scroll hides the active equation visually and defers all popup work', () => {
  assert.match(
    content,
    /event\?\.detail\?\.active === true[\s\S]*?popupsSuppressedAfterEditorScroll = true;[\s\S]*?return;/
  );
  assert.doesNotMatch(content, /event\?\.detail\?\.active === true[\s\S]{0,300}positionPreview/);
});

test('explicit forced close still bypasses the equation edit veto', () => {
  assert.match(content, /hidePreview\(\{ clearDismissal: false, force: true \}\)/);
});
