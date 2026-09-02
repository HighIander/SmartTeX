const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const review = fs.readFileSync(path.join(root, 'review.js'), 'utf8');

// Multiline insertion/deletion markup must be expanded to one visual-line
// rectangle per editor line instead of using a tall coalesced middle rect.
assert.match(review, /\["insert", "replace"\]\.includes\(change\.type\)[\s\S]*lineRectsForStrike\(rects, response\.lineHeight\)[\s\S]*smarttex-review-addition-line/);
assert.match(review, /change\.type === "delete" && change\.retained[\s\S]*lineRectsForStrike\(rects, response\.lineHeight\)[\s\S]*smarttex-review-deletion-line/);

// A moved target must carry one continuous green marker from the first
// visible moved line to the last, so its height matches the moved text.
assert.match(review, /const targetLineRects = lineRectsForStrike\(rects, response\.lineHeight\)/);
assert.match(review, /const moveTargetBounds = targetLineRects\.reduce/);
assert.match(review, /top: Math\.min\(bounds\.top, to\.top\)/);
assert.match(review, /bottom: Math\.max\(bounds\.bottom, to\.bottom\)/);
assert.match(review, /const gutterX = Number\(response\.gutterX\)/);
assert.match(review, /const markerLeft = Number\.isFinite\(gutterX\) \? gutterX \+ 1 : fallbackLeft/);
assert.match(review, /left: markerLeft[\s\S]*right: markerLeft \+ 4[\s\S]*moveTargetBounds\.top[\s\S]*moveTargetBounds\.bottom[\s\S]*smarttex-review-move-target/);

// State capture uses the normal debounced bridge event and performs one full
// document fallback read only when that event was omitted by the host editor.
assert.match(review, /function scheduleTrackedStateCapture\(\)[\s\S]*Math\.max\(\s*500,[\s\S]*keyboardIdleRemaining/);
assert.match(review, /if \(lastRoutedStateAt < requestedAt\) void captureTrackedEditorState\(\)/);
assert.doesNotMatch(review, /immediateStateCaptureTimer|trailingStateCaptureTimer|settledStateCaptureTimer/);
assert.match(review, /\["beforeinput", "input", "keydown", "paste", "cut", "drop", "pointerdown"\]/);

// Synthetic retained-delete restoration states are queued and reconciled
// before later edits are diffed; this is critical for fast cut/paste moves.
assert.match(review, /function routeEditorState\(next\)[\s\S]*queuedStateDuringRetainedRestore = next/);
assert.match(review, /lastValueByFile\.set\(restoreFile, restorePrevious\)[\s\S]*bridgeRequest\("getState"/);

// Exact delete+insert pairs can also be repaired after the fact, so a stale
// delete/insert pair does not remain red+blue instead of one green Move.
assert.match(review, /function promoteExistingDeleteInsertPairToMove\(fileName\)/);
assert.match(review, /deletion\.type = "move"/);
assert.match(review, /tombstoneItem\(insertion\.id\)/);

console.log('lossless multiline/move tracking regression checks passed');
