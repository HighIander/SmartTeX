/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

(async () => {
  const profileSource = read("comment-profile.js");
  const stored = {};
  const storage = {
    async get(key) { return { [key]: stored[key] }; },
    async set(value) { Object.assign(stored, value); }
  };
  const context = vm.createContext({ console, Math, Object, String, RegExp });
  vm.runInContext(profileSource, context, { filename: "comment-profile.js" });
  const api = context.SmartTeXCommentProfile;
  assert.ok(api, "The shared comment-profile helper must be installed.");
  const first = await api.ensure(storage);
  assert.ok(api.ANIMALS.includes(first.name), "First-run comment names must be random animal names.");
  assert.ok(api.COLORS.includes(first.color), "First-run comment colors must come from the user-color palette.");
  const second = await api.ensure(storage);
  assert.deepEqual(
    JSON.parse(JSON.stringify(second)),
    JSON.parse(JSON.stringify(first)),
    "The generated identity must persist rather than changing on each load."
  );

  const comments = read("comments.js");
  assert.match(comments, /const METADATA_FILE = "\.smarttex-comments\.json"/);
  assert.match(comments, /function mergeData\(/, "Collaborative metadata must merge by stable IDs.");
  assert.match(comments, /deletedAt/, "Collaborative deletion tombstones must be retained for synchronization.");
  assert.match(comments, /function reattachRecord\(/, "Source anchors must support contextual reattachment.");
  assert.match(comments, /function scheduleEditorSourceChange\(/, "Anchor maintenance must stay off the immediate typing path.");
  assert.match(comments, /if \(sourceChanged\) scheduleEditorSourceChange\(state\)/, "Cursor-only states must not schedule source maintenance.");
  assert.match(comments, /keyboardIdleRemaining[\s\S]*window\.setTimeout\(flushAfterIdle/, "Source maintenance must recheck the shared typing barrier.");
  assert.match(comments, /lastTrackChangesRenderFingerprint/, "Unchanged review data must not rebuild all change cards.");
  assert.match(comments, /Minimize all comments/);
  assert.match(comments, /smarttex-comments-close/, "The comments pane must expose a header close button.");
  assert.match(comments, /querySelector\("\.smarttex-comments-close"\)\?\.addEventListener\("click", closePane\)/, "The pane close button must use the same close state as the toolbar toggle.");
  assert.match(comments, /Reply/);
  assert.match(comments, /Toggle marker highlight/);
  assert.match(comments, /smarttex:comment-anchor-activate/);
  assert.match(comments, /function beginEditComment\(/, "Double-click editing must be supported for comments and replies.");
  assert.match(comments, /addEventListener\("dblclick"/, "Comment/mark entries must expose double-click actions.");
  assert.match(comments, /function renderMark\(/, "Standalone markings must appear in the comments pane.");
  assert.match(comments, />marked</, "Standalone markings must be labelled as marked.");
  assert.match(comments, /convertedFromMarkId/, "A marking must be convertible into a comment draft without losing the original on cancel.");
  assert.match(comments, /selectionOverlapsExistingAnchor/, "Existing marked/commented selections must suppress the selection action popup.");
  assert.match(comments, /split\(\/\\r\?\\n\//);
  assert.match(comments, /\}\\.\.\.`|\}\.{3}/, "Collapsed comments must visibly end with an ellipsis.");

  const bridge = read("page-bridge.js");
  assert.match(bridge, /readProjectMetadataFile/);
  assert.match(bridge, /writeProjectMetadataFile/);
  assert.match(bridge, /projectMetadataWriteQueue/);
  assert.match(bridge, /smarttex-comment-anchor-icon/);
  assert.match(bridge, /appendCommentRange/);
  assert.match(bridge, /smarttex-marker-anchor-icon/);
  assert.match(bridge, /convert-to-comment/);
  assert.match(bridge, /function scheduleOverlayRender\(\) \{\s*if \(interactionTasks\?\.isScrolling\?\.\(\)\) return;/, "Structure overlays must remain dormant during active scrolling.");

  const review = read("review.js");
  assert.match(review, /lastReviewStateFingerprint/, "Review state fan-out must be revision-deduplicated.");
  assert.match(review, /if \(sourceChanged \|\| fileChanged\) dispatchReviewState\(\)/, "Cursor-only states must not republish the complete review list.");
  assert.match(review, /function scheduleOverlayRender\(\) \{\s*if \(interactionTasks\?\.isScrolling\?\.\(\)\) return;/, "Review overlays must remain dormant during active scrolling.");

  const toolbar = read("editor-toolbar.js");
  assert.match(toolbar, /smarttex-comments-toggle-button/);
  assert.match(toolbar, /smarttex:comments-toggle-pane/);

  const options = read("options.html");
  assert.match(options, /smarttex-comment-user-name/);
  assert.match(options, /smarttex-comment-user-color/);

  const settings = read("settings-menu.js");
  assert.match(settings, /Comments identity/);
  assert.match(settings, /Comment user name/);
  assert.match(settings, /Comment user color/);

  const css = read("content.css");
  assert.match(css, /#smarttex-comments-pane/);
  assert.match(css, /smarttex-comments-resizer/);
  assert.match(css, /#smarttex-comment-selection-popup/);
  assert.match(css, /smarttex-editor-scrolling #smarttex-comment-highlights/);
  assert.match(css, /smarttex-editor-scrolling #smarttex-comment-icons/);

  // Realtime invalidation normally triggers the read immediately. The fallback
  // probe/read loop remains quick enough for hosts where the socket cannot be
  // discovered, without running on the typing path.
  assert.match(comments, /const SYNC_INTERVAL_MS = 5000/);
  assert.match(comments, /const FULL_SYNC_FALLBACK_MS = 20000/);
  assert.match(comments, /probeProjectMetadataFile/);
  assert.match(bridge, /function probeProjectMetadataFile\(pathValue\)/);
  assert.match(comments, /smarttex:collaboration-signal/);
  assert.match(bridge, /clientTracking\.updatePosition/);
  assert.match(bridge, /clientTracking\.clientUpdated/);

  // Marker icons on text are toggle controls, and off-screen comment/marker icons
  // are not clamped to the editor viewport edges.
  assert.match(bridge, /"Remove marking"[\s\S]*"toggle-mark"/);
  assert.match(comments, /detail\.action === "toggle-mark"[\s\S]*deleteMark\(markId\)/);
  assert.match(bridge, /commentAnchorScreenVisible\(screen, bounds, 1\)/);

  // Root-folder discovery is retried and transient discovery failures are hidden
  // from the pane status while the write is retried.
  assert.match(bridge, /for \(let attempt = 0; attempt < 5 && !rootFolderId; attempt \+= 1\)/);
  assert.match(comments, /isTransientProjectRootError/);
  assert.match(css, /\.smarttex-comments-settings[\s\S]*margin-left: auto/);
  assert.match(css, /\.smarttex-comments-close[\s\S]*margin-left: 0/);

  console.log("Collaborative comments feature checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
