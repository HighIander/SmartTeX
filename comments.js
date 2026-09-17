/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (window.top !== window || globalThis.__smartTeXCommentsLoaded) return;
  globalThis.__smartTeXCommentsLoaded = true;

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const PROFILE_KEY = globalThis.SmartTeXCommentProfile?.KEY || "smarttex:comment-profile:v1";
  const AUTHOR_ID_KEY = "smarttex:comment-author-id:v1";
  const REQUEST_EVENT = "smarttex:citation-editor-request";
  const RESPONSE_EVENT = "smarttex:citation-editor-response";
  const STATE_EVENT = "smarttex:editor-state";
  const OVERLAY_EVENT = "smarttex:comment-overlay-state";
  const ANCHOR_EVENT = "smarttex:comment-anchor-activate";
  const TOGGLE_EVENT = "smarttex:comments-toggle-pane";
  const PANE_STATE_EVENT = "smarttex:comments-pane-state";
  const UNREAD_STATE_EVENT = "smarttex:comments-unread-state";
  const REVIEW_CONTROL_EVENT = "smarttex:review-control";
  const REVIEW_STOP_CONFIRM_EVENT = "smarttex:review-stop-confirm-needed";
  const REVIEW_STATE_EVENT = "smarttex:review-state";
  const ADD_RANGE_COMMENT_EVENT = "smarttex:comments-add-range";
  const INITIALIZATION_STATE_EVENT = "smarttex:comments-initialization-state";
  const COLLABORATION_PROFILE_EVENT = "smarttex:collaboration-local-profile";
  const COLLABORATION_PRESENCE_EVENT = "smarttex:collaboration-presence";
  const COLLABORATION_DIRTY_EVENT = "smarttex:collaboration-metadata-dirty";
  const COLLABORATION_SIGNAL_EVENT = "smarttex:collaboration-signal";
  const METADATA_FILE = ".smarttex-comments.json";
  const LOCAL_UI_KEY_PREFIX = "smarttex:comments-ui:v1:";
  const LOCAL_PENDING_KEY_PREFIX = "smarttex:comments-pending:v1:";
  const SCHEMA_VERSION = 3;
  const SYNC_INTERVAL_MS = 5000;
  const FULL_SYNC_FALLBACK_MS = 20000;
  const WRITE_DELAY_MS = 1600;
  const CONTEXT_SIZE = 36;

  let requestCounter = 0;
  const pendingRequests = new Map();
  let currentState = null;
  let profile = { name: "Anonymous", color: "#268bd2" };
  let authorId = "";
  let data = emptyData();
  let pane = null;
  let paneOpen = false;
  let selectionPopup = null;
  let selectionPopupRevision = 0;
  let syncTimer = 0;
  let writeTimer = 0;
  let writeInFlight = false;
  let pendingCacheWriteQueue = Promise.resolve();
  let mutationRevision = 0;
  let lastSavedRevision = 0;
  let syncStatus = "";
  let draftThread = null;
  let editingComment = null;
  const replyDrafts = new Map();
  const replyGiphyDrafts = new Map();
  const giphyPendingAnalytics = new Map();
  const collapsedThreads = new Set();
  const lastSources = new Map();
  const anchorDeletionRecoveries = [];
  let pendingNavigation = null;
  let panelWidth = 340;
  let editorIconOpacity = 1;
  let editorIconsVisible = true;
  let editorMarkOpacity = 0.30;
  let editorMarksVisible = true;
  let initialSyncComplete = false;
  let initialSyncCompletedAt = 0;
  const autoOpenCheckedFiles = new Set();
  let cursorActiveThreadId = "";
  let iconFocusedThreadId = "";
  let iconFocusedThreadTimer = 0;
  let paneGeometryFrame = 0;
  let paneGeometryTimer = 0;
  let dockedEditorSurface = null;
  let dockedSourceLayoutPane = null;
  let dockedSourceInlineStyle = null;

  interactionTasks?.subscribe?.(() => {
    window.clearTimeout(paneGeometryTimer);
    paneGeometryTimer = 0;
    if (paneGeometryFrame) cancelAnimationFrame(paneGeometryFrame);
    paneGeometryFrame = 0;
    // The post-idle editor-state event schedules the replacement geometry pass.
  });
  let dockedPdfLayoutPane = null;
  let paneLayoutResizeObserver = null;
  let editorResizeTimer = 0;
  let paneObservedLayoutHost = null;
  let paneObservedPdfPanel = null;
  let sourceChangeTimer = 0;
  let pendingSourceState = null;
  let lastScheduledSourceFile = "";
  let lastScheduledSourceValue = "";
  let lastTrackChangesRenderFingerprint = "";
  let lastTrackChangesRenderList = null;
  let lastRemoteProbeToken = null;
  let lastFullRemoteReadAt = 0;
  let confirmationOverlay = null;
  let confirmationConfirmAction = null;
  let confirmationCancelAction = null;
  let confirmationRestoreFocus = null;
  let colorPickerOverlay = null;
  let colorPickerTarget = null;
  let colorPickerOriginalColor = "";
  let colorPickerRestoreFocus = null;
  let paneSettingsExpanded = false;
  let unreadTrackingInitialized = false;
  let reviewUiState = { tracking: false, markupMode: "markup", totalChangeCount: 0, changes: [] };
  let trackSectionCollapsed = false;
  let commentsSectionCollapsed = false;
  let showResolvedThreads = false;
  let reviewSplitRatio = 0.5;
  let reviewSplitterDragging = false;
  let paneAwaitingInitialReviewState = false;
  const readActivity = new Map();
  const EMOJI_PICKER_VALUES = [
    "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
    "😊", "🙂", "😉", "😍", "🥰", "😘", "😎", "🤓",
    "🤔", "🤗", "🤭", "😮", "😢", "😭", "😡", "🥳",
    "🤩", "😴", "👍", "👎", "👏", "🙌", "👌", "✌️",
    "🤞", "💪", "🙏", "❤️", "🧡", "💛", "💚", "💙",
    "💜", "🖤", "💯", "✅", "🎉", "🚀", "🔥", "👀",
    "💡", "✨", "🌟", "⚡", "🌈", "☀️", "🎯", "🏆"
  ];
  let emojiPicker = null;
  let emojiPickerTarget = null;
  let emojiPickerRestoreFocus = null;
  let giphyPicker = null;
  let giphyPickerTarget = null;
  let giphyPickerRestoreFocus = null;
  let giphySearchTimer = 0;
  let giphySearchController = null;
  let giphyResultObserver = null;
  let giphyPaginationObserver = null;
  let suppressGiphyAutoPrompt = false;
  let reactionTooltip = null;
  let reactionTooltipOwner = null;
  let paneRenderDeferred = false;
  let paneRenderFlushTimer = 0;

  function emptyData() {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: 0, threads: {}, marks: {} };
  }

  function now() {
    return Date.now();
  }

  function nextMutationStamp(...records) {
    let stamp = now();
    for (const record of records.flat().filter(Boolean)) {
      stamp = Math.max(
        stamp,
        Number(record.updatedAt) || 0,
        Number(record.deletedAt) || 0,
        Number(record.resolvedUpdatedAt) || 0
      );
    }
    return stamp + 1;
  }

  function uid(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
  }

  function validColor(value, fallback = "#268bd2") {
    return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : fallback;
  }

  function normalizeProfile(value, fallback = profile) {
    return globalThis.SmartTeXCommentProfile?.normalize?.(value, fallback) || {
      name: String(value?.name || fallback?.name || "Anonymous").trim().slice(0, 80) || "Anonymous",
      color: validColor(value?.color, fallback?.color || "#268bd2")
    };
  }

  function graphemeCount(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    try {
      if (typeof Intl?.Segmenter === "function") {
        return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
      }
    } catch (_error) {}
    return [...text].length;
  }

  function isEmojiOnlyText(value) {
    const text = String(value || "").trim();
    if (!text || graphemeCount(text) !== 1) return false;
    try {
      return /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(text);
    } catch (_error) {
      return EMOJI_PICKER_VALUES.includes(text);
    }
  }

  function cleanGiphyAttachment(value) {
    return globalThis.SmartTeXGiphyIntegration?.cleanAttachment?.(value) || null;
  }

  function safeObjectKey(value) {
    const key = String(value || "").trim().slice(0, 220);
    return key && !["__proto__", "prototype", "constructor"].includes(key) ? key : "";
  }

  function cleanReaction(value = {}, actorKey = "") {
    const updatedAt = Number(value.updatedAt) || 0;
    return {
      actorKey: safeObjectKey(value.actorKey || actorKey),
      authorId: String(value.authorId || "").slice(0, 180),
      authorName: String(value.authorName || "Anonymous").trim().slice(0, 80) || "Anonymous",
      authorColor: validColor(value.authorColor, "#268bd2"),
      active: value.active !== false,
      updatedAt
    };
  }

  function cleanReactions(value) {
    const result = {};
    if (!value || typeof value !== "object") return result;
    let emojiCount = 0;
    for (const [emojiValue, actorsValue] of Object.entries(value)) {
      const emoji = String(emojiValue || "").trim();
      if (!isEmojiOnlyText(emoji) || !actorsValue || typeof actorsValue !== "object") continue;
      if (emojiCount++ >= 64) break;
      const actors = {};
      let actorCount = 0;
      for (const [actorKeyValue, reactionValue] of Object.entries(actorsValue)) {
        const actorKey = safeObjectKey(actorKeyValue);
        if (!actorKey || !reactionValue || typeof reactionValue !== "object") continue;
        if (actorCount++ >= 500) break;
        const reaction = cleanReaction(reactionValue, actorKey);
        reaction.actorKey = actorKey;
        actors[actorKey] = reaction;
      }
      if (Object.keys(actors).length) result[emoji] = actors;
    }
    return result;
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 5000) {
    const requestId = `comments-${Date.now()}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`SmartTeX comment request timed out: ${type}`));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, type, ...payload })
      }));
    });
  }

  window.addEventListener(RESPONSE_EVENT, (event) => {
    let response;
    try { response = JSON.parse(String(event.detail || "{}")); } catch (_error) { return; }
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(response.requestId);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "SmartTeX comment request failed."));
  });

  function projectKey() {
    const projectId = location.pathname.match(/\/project\/([^/?#]+)/i)?.[1] || "project";
    return `${LOCAL_UI_KEY_PREFIX}${location.origin}:${projectId}`;
  }

  function pendingDataKey() {
    const projectId = location.pathname.match(/\/project\/([^/?#]+)/i)?.[1] || "project";
    return `${LOCAL_PENDING_KEY_PREFIX}${location.origin}:${projectId}`;
  }

  function dispatchInitializationState(active) {
    const next = Boolean(active);
    globalThis.__smartTeXCommentsInitializationActive = next;
    window.dispatchEvent(new CustomEvent(INITIALIZATION_STATE_EVENT, {
      detail: { active: next }
    }));
  }

  function persistPendingDataSnapshot() {
    if (typeof extensionApi?.storage?.local?.set !== "function") return;
    const key = pendingDataKey();
    const revision = mutationRevision;
    const snapshot = { revision, data: normalizeData(data), updatedAt: now() };
    pendingCacheWriteQueue = pendingCacheWriteQueue
      .catch(() => {})
      .then(() => extensionApi.storage.local.set({ [key]: snapshot }))
      .catch(() => {});
  }

  async function loadPendingDataSnapshot() {
    if (typeof extensionApi?.storage?.local?.get !== "function") return false;
    try {
      const key = pendingDataKey();
      const stored = await extensionApi.storage.local.get(key) || {};
      const pending = stored[key];
      if (!pending?.data || typeof pending.data !== "object") return false;
      data = mergeData(data, pending.data);
      mutationRevision = Math.max(mutationRevision, Number(pending.revision) || 1);
      lastSavedRevision = Math.min(lastSavedRevision, mutationRevision - 1);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function clearPendingDataThrough(revision) {
    if (typeof extensionApi?.storage?.local?.get !== "function" ||
        typeof extensionApi?.storage?.local?.remove !== "function") return;
    const key = pendingDataKey();
    const savedRevision = Math.max(0, Number(revision) || 0);
    pendingCacheWriteQueue = pendingCacheWriteQueue
      .catch(() => {})
      .then(async () => {
        const stored = await extensionApi.storage.local.get(key) || {};
        const pending = stored[key];
        if (!pending || (Number(pending.revision) || 0) <= savedRevision) {
          await extensionApi.storage.local.remove(key);
        }
      })
      .catch(() => {});
  }

  async function ensureAuthorId() {
    if (authorId) return authorId;
    try {
      const stored = await extensionApi?.storage?.local?.get?.(AUTHOR_ID_KEY) || {};
      const existing = String(stored?.[AUTHOR_ID_KEY] || "").trim();
      if (existing) { authorId = existing; return authorId; }
      authorId = uid("author");
      await extensionApi?.storage?.local?.set?.({ [AUTHOR_ID_KEY]: authorId });
      return authorId;
    } catch (_error) {
      authorId = authorId || uid("author");
      return authorId;
    }
  }

  async function loadLocalUi() {
    try {
      const stored = await extensionApi?.storage?.local?.get?.(projectKey()) || {};
      const value = stored[projectKey()] || {};
      panelWidth = Math.max(220, Math.min(680, Number(value.width) || 340));
      if (value.iconOpacityDefaultV2 === true) {
        editorIconOpacity = Math.max(0.15, Math.min(1, Number(value.editorIconOpacity) || 1));
      } else {
        // One-time migration from the earlier semi-transparent default. The
        // requested initial value is now 100%, even for projects that already
        // persisted the old implicit 55% default.
        editorIconOpacity = 1;
      }
      editorIconsVisible = value.editorIconsVisible !== false;
      editorMarkOpacity = Math.max(0.05, Math.min(1, Number(value.editorMarkOpacity) || 0.30));
      editorMarksVisible = value.editorMarksVisible !== false;
      unreadTrackingInitialized = value.unreadTrackingInitializedV1 === true;
      readActivity.clear();
      if (value.readActivity && typeof value.readActivity === "object") {
        for (const [key, stamp] of Object.entries(value.readActivity)) {
          const normalizedStamp = Number(stamp) || 0;
          if (normalizedStamp > 0) readActivity.set(String(key), normalizedStamp);
        }
      }
      trackSectionCollapsed = value.trackSectionCollapsed === true;
      commentsSectionCollapsed = value.commentsSectionCollapsed === true;
      showResolvedThreads = value.showResolvedThreads === true;
      reviewSplitRatio = Math.max(0.2, Math.min(0.8, Number(value.reviewSplitRatio) || 0.5));
      for (const id of Array.isArray(value.collapsedThreads) ? value.collapsedThreads : []) {
        collapsedThreads.add(String(id));
      }
    } catch (_error) {}
  }

  function saveLocalUi() {
    extensionApi?.storage?.local?.set?.({
      [projectKey()]: {
        width: panelWidth,
        editorIconOpacity,
        iconOpacityDefaultV2: true,
        editorIconsVisible,
        editorMarkOpacity,
        editorMarksVisible,
        unreadTrackingInitializedV1: unreadTrackingInitialized,
        readActivity: Object.fromEntries([...readActivity.entries()].slice(-5000)),
        collapsedThreads: [...collapsedThreads].slice(0, 1000),
        trackSectionCollapsed,
        commentsSectionCollapsed,
        showResolvedThreads,
        reviewSplitRatio
      }
    }).catch?.(() => {});
  }

  function cleanComment(value = {}) {
    const createdAt = Number(value.createdAt) || now();
    return {
      id: String(value.id || uid("comment")),
      authorName: String(value.authorName || "Anonymous").slice(0, 80),
      authorColor: validColor(value.authorColor, "#268bd2"),
      authorId: String(value.authorId || ""),
      text: String(value.text || ""),
      giphy: cleanGiphyAttachment(value.giphy),
      reactions: cleanReactions(value.reactions),
      createdAt,
      updatedAt: Number(value.updatedAt) || createdAt,
      deletedAt: Number(value.deletedAt) || 0,
      permanentlyDeleted: Boolean(value.permanentlyDeleted)
    };
  }

  function cleanAnchorRecord(value = {}, kind = "thread") {
    const createdAt = Number(value.createdAt) || now();
    const start = Math.max(0, Number(value.start) || 0);
    const end = Math.max(start, Number(value.end) || start);
    const base = {
      id: String(value.id || uid(kind)),
      fileName: String(value.fileName || ""),
      start,
      end,
      quote: String(value.quote || ""),
      before: String(value.before || "").slice(-CONTEXT_SIZE),
      after: String(value.after || "").slice(0, CONTEXT_SIZE),
      color: validColor(value.color, "#268bd2"),
      createdAt,
      updatedAt: Number(value.updatedAt) || createdAt,
      deletedAt: Number(value.deletedAt) || 0,
      permanentlyDeleted: Boolean(value.permanentlyDeleted)
    };
    if (kind === "thread") {
      const comments = {};
      const sourceComments = value.comments && typeof value.comments === "object" ? value.comments : {};
      for (const [id, comment] of Object.entries(sourceComments)) {
        const cleaned = cleanComment({ ...comment, id: comment?.id || id });
        comments[cleaned.id] = cleaned;
      }
      return {
        ...base,
        authorName: String(value.authorName || "Anonymous").slice(0, 80),
        authorId: String(value.authorId || ""),
        resolved: Boolean(value.resolved),
        resolvedAt: Number(value.resolvedAt) || 0,
        resolvedUpdatedAt: Number(value.resolvedUpdatedAt) || Number(value.resolvedAt) || 0,
        comments
      };
    }
    return {
      ...base,
      authorName: String(value.authorName || "Anonymous").slice(0, 80),
      authorId: String(value.authorId || "")
    };
  }

  function normalizeData(value) {
    const result = emptyData();
    if (!value || typeof value !== "object") return result;
    result.updatedAt = Number(value.updatedAt) || 0;
    const sourceThreads = value.threads && typeof value.threads === "object" ? value.threads : {};
    for (const [id, thread] of Object.entries(sourceThreads)) {
      const cleaned = cleanAnchorRecord({ ...thread, id: thread?.id || id }, "thread");
      result.threads[cleaned.id] = cleaned;
    }
    const sourceMarks = value.marks && typeof value.marks === "object" ? value.marks : {};
    for (const [id, mark] of Object.entries(sourceMarks)) {
      const cleaned = cleanAnchorRecord({ ...mark, id: mark?.id || id }, "mark");
      result.marks[cleaned.id] = cleaned;
    }
    return result;
  }

  function latestRecord(left, right) {
    if (!left) return right ? structuredCloneSafe(right) : null;
    if (!right) return structuredCloneSafe(left);
    const leftStamp = Math.max(Number(left.updatedAt) || 0, Number(left.deletedAt) || 0);
    const rightStamp = Math.max(Number(right.updatedAt) || 0, Number(right.deletedAt) || 0);
    const result = structuredCloneSafe(rightStamp >= leftStamp ? right : left);
    // Explicit UI deletion is a permanent tombstone. A delayed profile update,
    // stale metadata upload, or clock-skewed peer must never resurrect it.
    if (left.permanentlyDeleted || right.permanentlyDeleted) {
      result.permanentlyDeleted = true;
      result.deletedAt = Math.max(Number(left.deletedAt) || 0, Number(right.deletedAt) || 0, 1);
    }
    return result;
  }

  function latestReaction(left, right) {
    if (!left) return right ? structuredCloneSafe(right) : null;
    if (!right) return structuredCloneSafe(left);
    return structuredCloneSafe(
      (Number(right.updatedAt) || 0) >= (Number(left.updatedAt) || 0) ? right : left
    );
  }

  function mergeReactions(leftValue, rightValue) {
    const left = cleanReactions(leftValue);
    const right = cleanReactions(rightValue);
    const merged = {};
    for (const emoji of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const actors = {};
      for (const actorKey of new Set([
        ...Object.keys(left[emoji] || {}), ...Object.keys(right[emoji] || {})
      ])) {
        const reaction = latestReaction(left[emoji]?.[actorKey], right[emoji]?.[actorKey]);
        if (reaction) actors[actorKey] = reaction;
      }
      if (Object.keys(actors).length) merged[emoji] = actors;
    }
    return merged;
  }

  function mergeComment(left, right) {
    const merged = latestRecord(left, right);
    if (!merged) return null;
    merged.reactions = mergeReactions(left?.reactions, right?.reactions);
    return merged;
  }

  function structuredCloneSafe(value) {
    try { return structuredClone(value); } catch (_error) { return JSON.parse(JSON.stringify(value)); }
  }

  function mergeData(leftValue, rightValue) {
    const left = normalizeData(leftValue);
    const right = normalizeData(rightValue);
    const merged = emptyData();
    merged.updatedAt = Math.max(left.updatedAt, right.updatedAt);
    for (const id of new Set([...Object.keys(left.marks), ...Object.keys(right.marks)])) {
      merged.marks[id] = latestRecord(left.marks[id], right.marks[id]);
    }
    for (const id of new Set([...Object.keys(left.threads), ...Object.keys(right.threads)])) {
      const l = left.threads[id];
      const r = right.threads[id];
      const base = latestRecord(l, r);
      if (!base) continue;
      base.comments = {};
      for (const commentId of new Set([
        ...Object.keys(l?.comments || {}), ...Object.keys(r?.comments || {})
      ])) {
        base.comments[commentId] = mergeComment(l?.comments?.[commentId], r?.comments?.[commentId]);
      }
      const resolvedSource = (Number(r?.resolvedUpdatedAt) || 0) >= (Number(l?.resolvedUpdatedAt) || 0)
        ? r
        : l;
      base.resolved = Boolean(resolvedSource?.resolved);
      base.resolvedAt = Number(resolvedSource?.resolvedAt) || 0;
      base.resolvedUpdatedAt = Number(resolvedSource?.resolvedUpdatedAt) || 0;
      merged.threads[id] = base;
    }
    return merged;
  }

  function sameDataRecords(leftValue, rightValue) {
    const left = normalizeData(leftValue);
    const right = normalizeData(rightValue);
    return JSON.stringify(left.threads) === JSON.stringify(right.threads) &&
      JSON.stringify(left.marks) === JSON.stringify(right.marks);
  }

  function realtimeCorrectionForIncoming(remoteValue, mergedValue) {
    const remote = normalizeData(remoteValue);
    const merged = normalizeData(mergedValue);
    const patch = emptyData();
    patch.updatedAt = now();
    for (const id of Object.keys(remote.threads)) {
      if (merged.threads[id]) patch.threads[id] = merged.threads[id];
    }
    for (const id of Object.keys(remote.marks)) {
      if (merged.marks[id]) patch.marks[id] = merged.marks[id];
    }
    return normalizeData(patch);
  }

  function alive(record) {
    return Boolean(record) && !record.permanentlyDeleted &&
      (!record.deletedAt || record.deletedAt < record.updatedAt);
  }

  function fileMatches(left, right) {
    const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    const a = normalize(left);
    const b = normalize(right);
    if (!a || !b) return false;
    return a === b || a.split("/").pop() === b.split("/").pop();
  }

  function isOwnActivity(name, color, recordAuthorId = "") {
    const actor = String(recordAuthorId || "");
    if (actor && authorId) return actor === authorId;
    return String(name || "") === String(profile.name || "") &&
      validColor(color, "#268bd2") === validColor(profile.color, "#268bd2");
  }

  function ownsComment(comment) {
    return Boolean(comment && isOwnActivity(comment.authorName, comment.authorColor, comment.authorId));
  }

  function ownsThread(thread) {
    if (!thread) return false;
    if (thread.authorId) return thread.authorId === authorId;
    const first = Object.values(thread.comments || {})
      .filter(alive)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    return ownsComment(first);
  }

  function applyCommentsAuthorProfile(authorIdValue, nextProfile, legacyProfile = null) {
    const targetAuthorId = String(authorIdValue || "");
    if (!targetAuthorId) return false;
    const name = String(nextProfile?.name || "Anonymous").trim().slice(0, 80) || "Anonymous";
    const color = validColor(nextProfile?.color);
    const legacyName = String(legacyProfile?.name || "");
    const legacyColor = validColor(legacyProfile?.color, "#000000");
    const stamp = nextMutationStamp(Object.values(data.threads), Object.values(data.marks));
    let changed = false;
    const matches = (record, colorField) => (
      String(record?.authorId || "") === targetAuthorId ||
      (!record?.authorId && legacyName && record?.authorName === legacyName &&
        validColor(record?.[colorField], "#000000") === legacyColor)
    );
    for (const thread of Object.values(data.threads)) {
      if (!alive(thread)) continue;
      let threadChanged = false;
      if (String(thread.authorId || "") === targetAuthorId && (
        thread.authorName !== name || thread.color !== color
      )) {
        thread.authorName = name;
        thread.authorId = targetAuthorId;
        thread.color = color;
        threadChanged = true;
      }
      for (const comment of Object.values(thread.comments || {})) {
        if (!alive(comment)) continue;
        if (matches(comment, "authorColor") && !(
          comment.authorName === name && comment.authorColor === color && comment.authorId === targetAuthorId
        )) {
          comment.authorName = name;
          comment.authorColor = color;
          comment.authorId = targetAuthorId;
          comment.updatedAt = stamp;
          threadChanged = true;
        }
        for (const actors of Object.values(comment.reactions || {})) {
          for (const reaction of Object.values(actors || {})) {
            if (!matches(reaction, "authorColor")) continue;
            if (reaction.authorName === name && reaction.authorColor === color && reaction.authorId === targetAuthorId) continue;
            reaction.authorName = name;
            reaction.authorColor = color;
            reaction.authorId = targetAuthorId;
            reaction.updatedAt = stamp;
            threadChanged = true;
          }
        }
      }
      if (threadChanged) {
        const first = Object.values(thread.comments || {}).filter(alive)
          .sort((left, right) => left.createdAt - right.createdAt)[0];
        if (first?.authorId === targetAuthorId) {
          thread.authorName = name;
          thread.authorId = targetAuthorId;
          thread.color = color;
        }
        thread.updatedAt = stamp;
        changed = true;
      }
    }
    for (const mark of Object.values(data.marks)) {
      if (!alive(mark) || !matches(mark, "color")) continue;
      if (mark.authorName === name && mark.color === color && mark.authorId === targetAuthorId) continue;
      mark.authorName = name;
      mark.authorId = targetAuthorId;
      mark.color = color;
      mark.updatedAt = stamp;
      changed = true;
    }
    return changed;
  }

  function commentActivityKey(threadId, commentId) {
    return `comment:${String(threadId || "")}:${String(commentId || "")}`;
  }

  function markActivityKey(markId) {
    return `mark:${String(markId || "")}`;
  }

  function commentActivityStamp(comment) {
    return Math.max(Number(comment?.createdAt) || 0, Number(comment?.updatedAt) || 0);
  }

  function markActivityStamp(mark) {
    // A mark is unread only when it is newly created. Anchor movement or color
    // edits are not treated as a new collaborator notification.
    return Number(mark?.createdAt) || 0;
  }

  function isCommentUnread(thread, comment) {
    if (!alive(thread) || !alive(comment)) return false;
    if (isOwnActivity(comment.authorName, comment.authorColor, comment.authorId)) return false;
    const stamp = commentActivityStamp(comment);
    return stamp > (readActivity.get(commentActivityKey(thread.id, comment.id)) || 0);
  }

  function isMarkUnread(mark) {
    if (!alive(mark)) return false;
    if (isOwnActivity(mark.authorName, mark.color, mark.authorId)) return false;
    const stamp = markActivityStamp(mark);
    return stamp > (readActivity.get(markActivityKey(mark.id)) || 0);
  }

  function markActivityRead(key, stamp, { save = true, refresh = true } = {}) {
    const normalizedKey = String(key || "");
    const normalizedStamp = Number(stamp) || 0;
    if (!normalizedKey || normalizedStamp <= (readActivity.get(normalizedKey) || 0)) return false;
    readActivity.set(normalizedKey, normalizedStamp);
    if (save) saveLocalUi();
    if (refresh) {
      dispatchUnreadState();
      if (paneOpen) requestAnimationFrame(renderPaneThreads);
    }
    return true;
  }

  function markCommentRead(thread, comment, options) {
    return markActivityRead(commentActivityKey(thread.id, comment.id), commentActivityStamp(comment), options);
  }

  function markMarkRead(mark, options) {
    return markActivityRead(markActivityKey(mark.id), markActivityStamp(mark), options);
  }

  function markThreadRead(thread, { save = true, refresh = true } = {}) {
    let changed = false;
    for (const comment of Object.values(thread?.comments || {})) {
      if (!alive(comment)) continue;
      changed = markCommentRead(thread, comment, { save: false, refresh: false }) || changed;
    }
    if (changed && save) saveLocalUi();
    if (changed && refresh) {
      dispatchUnreadState();
      if (paneOpen) requestAnimationFrame(renderPaneThreads);
    }
    return changed;
  }

  function currentFileUnreadCount() {
    const fileName = String(currentState?.fileName || "");
    if (!fileName) return 0;
    let count = 0;
    for (const thread of Object.values(data.threads)) {
      if (!alive(thread) || !fileMatches(thread.fileName, fileName)) continue;
      for (const comment of Object.values(thread.comments || {})) {
        if (isCommentUnread(thread, comment)) count += 1;
      }
    }
    for (const mark of Object.values(data.marks)) {
      if (alive(mark) && fileMatches(mark.fileName, fileName) && isMarkUnread(mark)) count += 1;
    }
    return count;
  }

  function dispatchUnreadState() {
    const count = currentFileUnreadCount();
    globalThis.__smartTeXCommentsUnreadCount = count;
    window.dispatchEvent(new CustomEvent(UNREAD_STATE_EVENT, { detail: { count, unread: count > 0 } }));
  }

  function markCurrentFileRead({ refresh = true } = {}) {
    const fileName = String(currentState?.fileName || "");
    if (!fileName) return false;
    let changed = false;
    for (const thread of Object.values(data.threads)) {
      if (!alive(thread) || !fileMatches(thread.fileName, fileName)) continue;
      changed = markThreadRead(thread, { save: false, refresh: false }) || changed;
    }
    for (const mark of Object.values(data.marks)) {
      if (!alive(mark) || !fileMatches(mark.fileName, fileName)) continue;
      changed = markMarkRead(mark, { save: false, refresh: false }) || changed;
    }
    if (changed) saveLocalUi();
    if (refresh) {
      dispatchUnreadState();
      if (paneOpen) requestAnimationFrame(renderPaneThreads);
    }
    return changed;
  }

  function markAllExistingActivityReadAsBaseline() {
    for (const thread of Object.values(data.threads)) {
      if (!alive(thread)) continue;
      markThreadRead(thread, { save: false, refresh: false });
    }
    for (const mark of Object.values(data.marks)) {
      if (!alive(mark)) continue;
      markMarkRead(mark, { save: false, refresh: false });
    }
    unreadTrackingInitialized = true;
    saveLocalUi();
    dispatchUnreadState();
  }

  function captureContext(record, source) {
    const start = Math.max(0, Math.min(record.start, source.length));
    const end = Math.max(start, Math.min(record.end, source.length));
    record.start = start;
    record.end = end;
    record.quote = end > start ? source.slice(start, end) : "";
    record.before = source.slice(Math.max(0, start - CONTEXT_SIZE), start);
    record.after = source.slice(end, Math.min(source.length, end + CONTEXT_SIZE));
  }

  function suffixScore(candidate, expected) {
    const max = Math.min(candidate.length, expected.length, CONTEXT_SIZE);
    let score = 0;
    for (let i = 1; i <= max && candidate[candidate.length - i] === expected[expected.length - i]; i += 1) score += 1;
    return score;
  }

  function prefixScore(candidate, expected) {
    const max = Math.min(candidate.length, expected.length, CONTEXT_SIZE);
    let score = 0;
    for (let i = 0; i < max && candidate[i] === expected[i]; i += 1) score += 1;
    return score;
  }

  function reattachRecord(record, source) {
    if (!source) return false;
    const oldStart = record.start;
    const oldEnd = record.end;
    if (record.end > record.start && record.quote) {
      if (source.slice(record.start, record.end) === record.quote) return false;
      const candidates = [];
      let index = source.indexOf(record.quote);
      while (index >= 0 && candidates.length < 200) {
        const end = index + record.quote.length;
        const before = source.slice(Math.max(0, index - CONTEXT_SIZE), index);
        const after = source.slice(end, Math.min(source.length, end + CONTEXT_SIZE));
        const score = suffixScore(before, record.before) + prefixScore(after, record.after) - Math.min(20, Math.abs(index - oldStart) / 50);
        candidates.push({ start: index, end, score });
        index = source.indexOf(record.quote, index + 1);
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score);
        record.start = candidates[0].start;
        record.end = candidates[0].end;
        captureContext(record, source);
        return record.start !== oldStart || record.end !== oldEnd;
      }
    }

    const before = record.before || "";
    const after = record.after || "";
    if (before || after) {
      const around = Math.max(0, Math.min(oldStart, source.length));
      let best = null;
      const beforeNeedle = before.slice(-Math.min(16, before.length));
      const searchStart = Math.max(0, around - 3000);
      const searchEnd = Math.min(source.length, around + 3000);
      if (beforeNeedle) {
        let position = source.indexOf(beforeNeedle, searchStart);
        while (position >= 0 && position <= searchEnd) {
          const start = position + beforeNeedle.length;
          const afterCandidate = source.slice(start, start + CONTEXT_SIZE);
          const score = prefixScore(afterCandidate, after) - Math.abs(start - around) / 200;
          if (!best || score > best.score) best = { start, score };
          position = source.indexOf(beforeNeedle, position + 1);
        }
      }
      if (best) {
        const length = Math.max(0, oldEnd - oldStart);
        record.start = best.start;
        record.end = Math.min(source.length, best.start + length);
        captureContext(record, source);
        return record.start !== oldStart || record.end !== oldEnd;
      }
    }
    record.start = Math.max(0, Math.min(record.start, source.length));
    record.end = Math.max(record.start, Math.min(record.end, source.length));
    return record.start !== oldStart || record.end !== oldEnd;
  }

  function diffSpan(oldSource, newSource) {
    if (oldSource === newSource) return null;
    let prefix = 0;
    const maxPrefix = Math.min(oldSource.length, newSource.length);
    while (prefix < maxPrefix && oldSource.charCodeAt(prefix) === newSource.charCodeAt(prefix)) prefix += 1;
    let suffix = 0;
    const maxSuffix = Math.min(oldSource.length - prefix, newSource.length - prefix);
    while (
      suffix < maxSuffix &&
      oldSource.charCodeAt(oldSource.length - 1 - suffix) === newSource.charCodeAt(newSource.length - 1 - suffix)
    ) suffix += 1;
    return {
      start: prefix,
      oldEnd: oldSource.length - suffix,
      newEnd: newSource.length - suffix,
      delta: newSource.length - oldSource.length
    };
  }

  function transformRecordForDiff(record, diff, source) {
    const oldStart = record.start;
    const oldEnd = record.end;
    if (diff.oldEnd <= oldStart) {
      record.start = Math.max(0, oldStart + diff.delta);
      record.end = Math.max(record.start, oldEnd + diff.delta);
    } else if (diff.start >= oldEnd && oldEnd > oldStart) {
      return false;
    } else if (oldEnd === oldStart && diff.start > oldStart) {
      return false;
    } else {
      const transform = (position, affinityEnd = false) => {
        if (position < diff.start) return position;
        if (position > diff.oldEnd) return position + diff.delta;
        return affinityEnd ? diff.newEnd : diff.start;
      };
      record.start = transform(oldStart, false);
      record.end = Math.max(record.start, transform(oldEnd, true));
    }
    captureContext(record, source);
    return record.start !== oldStart || record.end !== oldEnd || diff.start < oldEnd;
  }

  function allCurrentFileRecords() {
    const fileName = currentState?.fileName || "";
    const records = [];
    for (const thread of Object.values(data.threads)) if (alive(thread) && fileMatches(thread.fileName, fileName)) records.push(thread);
    for (const mark of Object.values(data.marks)) if (alive(mark) && fileMatches(mark.fileName, fileName)) records.push(mark);
    return records;
  }

  function rememberAnchorDeletionRecovery(kind, record, beforeSource, afterSource) {
    const id = String(record?.id || "");
    if (!id || !record?.fileName) return;
    const key = `${kind}:${id}`;
    for (let index = anchorDeletionRecoveries.length - 1; index >= 0; index -= 1) {
      if (anchorDeletionRecoveries[index]?.key === key) anchorDeletionRecoveries.splice(index, 1);
    }
    anchorDeletionRecoveries.push({
      key,
      kind,
      id,
      fileName: String(record.fileName || ""),
      beforeSource: String(beforeSource || ""),
      afterSource: String(afterSource || ""),
      anchor: {
        start: Number(record.start) || 0,
        end: Number(record.end) || 0,
        quote: String(record.quote || ""),
        before: String(record.before || ""),
        after: String(record.after || "")
      }
    });
    if (anchorDeletionRecoveries.length > 100) anchorDeletionRecoveries.splice(0, anchorDeletionRecoveries.length - 100);
  }

  function restoreAnchorDeletionRecoveries(fileName, source) {
    const restoredMarks = new Set();
    const restoredThreads = new Set();
    let restored = false;
    const stamp = now();
    for (let index = anchorDeletionRecoveries.length - 1; index >= 0; index -= 1) {
      const recovery = anchorDeletionRecoveries[index];
      if (!fileMatches(recovery?.fileName, fileName) || recovery.beforeSource !== source) continue;
      const record = recovery.kind === "mark" ? data.marks[recovery.id] : data.threads[recovery.id];
      if (!record) {
        anchorDeletionRecoveries.splice(index, 1);
        continue;
      }
      record.start = recovery.anchor.start;
      record.end = recovery.anchor.end;
      record.quote = recovery.anchor.quote;
      record.before = recovery.anchor.before;
      record.after = recovery.anchor.after;
      record.deletedAt = 0;
      record.updatedAt = Math.max(Number(record.updatedAt) || 0, stamp + index + 1);
      if (recovery.kind === "mark") restoredMarks.add(recovery.id);
      else restoredThreads.add(recovery.id);
      anchorDeletionRecoveries.splice(index, 1);
      restored = true;
    }
    return { restored, restoredMarks, restoredThreads };
  }

  function applyEditorSourceChange(state) {
    const fileName = String(state?.fileName || "");
    const source = String(state?.value || "");
    if (!fileName) return;
    const previous = lastSources.get(fileName);
    let changedAnchors = false;
    if (typeof previous === "string" && previous !== source) {
      const recovery = restoreAnchorDeletionRecoveries(fileName, source);
      if (recovery.restored) changedAnchors = true;
      const diff = diffSpan(previous, source);
      if (diff) {
        const stamp = now();
        const isFullRangeDeletion = (record) => (
          record.end > record.start &&
          diff.newEnd === diff.start &&
          diff.start <= record.start &&
          diff.oldEnd >= record.end
        );

        for (const mark of Object.values(data.marks)) {
          if (!alive(mark) || !fileMatches(mark.fileName, fileName) || recovery.restoredMarks.has(mark.id)) continue;
          if (isFullRangeDeletion(mark)) {
            rememberAnchorDeletionRecovery("mark", mark, previous, source);
            // A plain marking has no useful point representation. Once all of
            // its marked text is deleted, remove the pane entry as well.
            mark.deletedAt = stamp;
            mark.updatedAt = Math.max(Number(mark.updatedAt) || 0, stamp - 1);
            changedAnchors = true;
            continue;
          }
          if (transformRecordForDiff(mark, diff, source)) changedAnchors = true;
        }

        for (const thread of Object.values(data.threads)) {
          if (!alive(thread) || !fileMatches(thread.fileName, fileName) || recovery.restoredThreads.has(thread.id)) continue;
          if (isFullRangeDeletion(thread)) {
            rememberAnchorDeletionRecovery("thread", thread, previous, source);
            // Comments survive deletion of their selected text. Collapse their
            // anchor to the deletion point so the editor renders the existing
            // vertical-line point-comment representation there.
            const point = Math.max(0, Math.min(diff.start, source.length));
            thread.start = point;
            thread.end = point;
            captureContext(thread, source);
            thread.updatedAt = Math.max(Number(thread.updatedAt) || 0, stamp);
            changedAnchors = true;
            continue;
          }
          if (transformRecordForDiff(thread, diff, source)) changedAnchors = true;
        }

        if (draftThread && fileMatches(draftThread.fileName, fileName)) transformRecordForDiff(draftThread, diff, source);
      }
    } else if (previous === undefined) {
      for (const record of allCurrentFileRecords()) {
        if (reattachRecord(record, source)) changedAnchors = true;
      }
    }
    lastSources.set(fileName, source);
    if (changedAnchors) markDirty(2200);
  }

  function flushPendingSourceChange() {
    if (!pendingSourceState) return;
    const pending = pendingSourceState;
    pendingSourceState = null;
    clearTimeout(sourceChangeTimer);
    sourceChangeTimer = 0;
    if (!currentState || !fileMatches(pending.fileName, currentState.fileName)) return;
    applyEditorSourceChange(pending);
  }

  function scheduleEditorSourceChange(state) {
    const fileName = String(state?.fileName || "");
    if (!fileName) return;
    const value = String(state?.value || "");
    if (fileMatches(fileName, lastScheduledSourceFile) && value === lastScheduledSourceValue) return;
    lastScheduledSourceFile = fileName;
    lastScheduledSourceValue = value;
    pendingSourceState = { fileName, value };
    clearTimeout(sourceChangeTimer);
    // Re-anchoring scans the source around changed ranges. Keep it off the
    // immediate typing path and apply it after a short idle period instead.
    const flushAfterIdle = () => {
      const idleDelay = Math.max(0, Number(interactionTasks?.keyboardIdleRemaining?.()) || 0);
      if (idleDelay > 0) {
        sourceChangeTimer = window.setTimeout(flushAfterIdle, idleDelay);
        return;
      }
      flushPendingSourceChange();
      // Source maintenance must not tear down an active comment editor or
      // chooser. The pane refresh is deferred until the interaction ends.
      renderAll({ preserveInteraction: true });
    };
    sourceChangeTimer = window.setTimeout(flushAfterIdle, 700);
  }

  function serializeData(value = data) {
    const normalized = normalizeData(value);
    normalized.updatedAt = now();
    return JSON.stringify(normalized, null, 2) + "\n";
  }

  function setSyncStatus(message) {
    syncStatus = String(message || "");
    updatePaneStatus();
  }

  async function readRemote(options = {}) {
    const response = await bridgeRequest("readProjectMetadataFile", {
      path: METADATA_FILE,
      fileId: String(options.fileId || ""),
      entityType: String(options.entityType || "")
    }, 8000);
    const file = response?.file;
    if (!file?.exists || !String(file.value || "").trim()) return emptyData();
    try { return normalizeData(JSON.parse(String(file.value))); }
    catch (_error) { throw new Error(`${METADATA_FILE} contains invalid JSON.`); }
  }

  async function probeRemote() {
    const response = await bridgeRequest("probeProjectMetadataFile", { path: METADATA_FILE }, 4500);
    const probe = response?.probe || {};
    return String(probe.token || (probe.exists ? "present" : "missing"));
  }

  function isTransientProjectRootError(error) {
    return /Could not determine the CollabTeX project root folder/i.test(String(error?.message || error || ""));
  }

  async function syncFromProject(options = {}) {
    if (writeInFlight) return false;
    flushPendingSourceChange();
    const force = options?.force === true;
    const fallbackDue = (now() - lastFullRemoteReadAt) >= FULL_SYNC_FALLBACK_MS;
    let shouldRead = force || fallbackDue;
    try {
      // The frequent check only inspects the project-model metadata/file id.
      // A full JSON read is performed only when that token changes, plus a
      // bounded full-read fallback so collaborators are still seen even if
      // CollabTeX keeps a stale file-tree object temporarily.
      const token = await probeRemote();
      if (lastRemoteProbeToken === null || token !== lastRemoteProbeToken) shouldRead = true;
      lastRemoteProbeToken = token;
    } catch (_error) {
      // Probe failures are intentionally silent. The bounded full-read fallback
      // still guarantees periodic collaboration refreshes.
    }
    if (!shouldRead) return true;
    try {
      const remote = await readRemote(options);
      lastFullRemoteReadAt = now();
      const merged = mergeData(data, remote);
      const recordsChanged = !sameDataRecords(merged, data);
      const remoteNeedsRepair = !sameDataRecords(merged, remote);
      data = merged;
      const ownProfileChanged = applyCommentsAuthorProfile(authorId, profile, profile);
      let reattached = false;
      if (currentState?.value) {
        for (const record of allCurrentFileRecords()) if (reattachRecord(record, currentState.value)) reattached = true;
        if (reattached) markDirty(2200);
      }
      setSyncStatus("");
      // The 5 s probe / 20 s fallback used to rebuild the pane even when the
      // remote records were identical. That destroyed focused inputs and open
      // choosers. Only refresh records when something actually changed, and
      // defer that refresh while the user is interacting with the pane.
      if (recordsChanged || ownProfileChanged || reattached) {
        renderAll({ preserveInteraction: true });
      } else {
        renderOverlays();
        dispatchUnreadState();
      }
      if (ownProfileChanged || remoteNeedsRepair) markDirty(250);
      if (initialSyncComplete) maybeAutoOpenForCurrentDocument();
      return true;
    } catch (error) {
      if (isTransientProjectRootError(error)) setSyncStatus("");
      else setSyncStatus(error?.message || String(error));
      return false;
    }
  }

  function markDirty(delay = WRITE_DELAY_MS, realtimeData = null) {
    mutationRevision += 1;
    broadcastCommentsRealtime(realtimeData);
    persistPendingDataSnapshot();
    clearTimeout(writeTimer);
    writeTimer = window.setTimeout(() => flushProjectData(), Math.max(250, delay));
  }

  function realtimeDataForRecords(...records) {
    const patch = emptyData();
    patch.updatedAt = now();
    for (const record of records.flat().filter(Boolean)) {
      if (record.comments && typeof record.comments === "object") patch.threads[record.id] = record;
      else patch.marks[record.id] = record;
    }
    return normalizeData(patch);
  }

  function currentFileRealtimeData() {
    const fileName = String(currentState?.fileName || "");
    return realtimeDataForRecords(
      Object.values(data.threads).filter((thread) => fileMatches(thread.fileName, fileName)),
      Object.values(data.marks).filter((mark) => fileMatches(mark.fileName, fileName))
    );
  }

  function broadcastCommentsRealtime(realtimeData = null) {
    window.dispatchEvent(new CustomEvent(COLLABORATION_DIRTY_EVENT, {
      detail: JSON.stringify({
        kind: "comments-live",
        nonce: `${mutationRevision}:${now()}`,
        payload: { data: realtimeData ? normalizeData(realtimeData) : currentFileRealtimeData() }
      })
    }));
  }

  async function flushProjectData() {
    flushPendingSourceChange();
    clearTimeout(writeTimer);
    writeTimer = 0;
    if (writeInFlight || lastSavedRevision === mutationRevision) return;
    writeInFlight = true;
    const targetRevision = mutationRevision;
    setSyncStatus("Saving comments…");
    try {
      let remote = emptyData();
      try { remote = await readRemote(); } catch (_error) { /* a new metadata file is valid */ }
      data = mergeData(remote, data);
      data.updatedAt = now();
      const writeResponse = await bridgeRequest("writeProjectMetadataFile", {
        path: METADATA_FILE,
        text: serializeData(data)
      }, 15000);
      lastSavedRevision = targetRevision;
      setSyncStatus("");
      clearPendingDataThrough(targetRevision);
      window.dispatchEvent(new CustomEvent(COLLABORATION_DIRTY_EVENT, {
        detail: JSON.stringify({
          kind: "comments",
          nonce: `${targetRevision}:${now()}`,
          path: METADATA_FILE,
          fileId: String(writeResponse?.result?.fileId || ""),
          entityType: String(writeResponse?.result?.entityType || "")
        })
      }));
      if (mutationRevision !== targetRevision) markDirty(500);
    } catch (error) {
      const transientRoot = isTransientProjectRootError(error);
      setSyncStatus(transientRoot ? "" : (error?.message || String(error)));
      window.setTimeout(() => {
        if (lastSavedRevision === mutationRevision || writeInFlight) return;
        clearTimeout(writeTimer);
        writeTimer = window.setTimeout(() => flushProjectData(), transientRoot ? 1200 : 2500);
      }, transientRoot ? 300 : 1200);
    } finally {
      writeInFlight = false;
    }
  }

  function scheduleSyncLoop() {
    clearInterval(syncTimer);
    syncTimer = window.setInterval(syncFromProject, SYNC_INTERVAL_MS);
  }

  function currentSelection() {
    if (!currentState) return null;
    const from = Math.max(0, Number(currentState.selectionFrom ?? Math.min(currentState.selectionAnchor || 0, currentState.selectionHead || 0)) || 0);
    const to = Math.max(from, Number(currentState.selectionTo ?? Math.max(currentState.selectionAnchor || 0, currentState.selectionHead || 0)) || from);
    return to > from ? { start: from, end: to } : null;
  }

  function makeAnchor(start, end, color = profile.color) {
    const source = String(currentState?.value || "");
    const record = {
      fileName: String(currentState?.fileName || ""),
      start: Math.max(0, start),
      end: Math.max(start, end),
      quote: "",
      before: "",
      after: "",
      color: validColor(color, profile.color)
    };
    captureContext(record, source);
    return record;
  }

  function ensureDraftCommentEditorVisible() {
    const list = pane?.querySelector(".smarttex-comments-list");
    const card = list?.querySelector?.("[data-smarttex-draft-thread]");
    if (!list || !card) return;
    const listRect = list.getBoundingClientRect?.();
    const cardRect = card.getBoundingClientRect?.();
    if (!listRect || !cardRect || !listRect.height || !cardRect.height) return;
    const margin = 8;
    const visibleTop = listRect.top + margin;
    const visibleBottom = listRect.bottom - margin;
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    let delta = 0;
    if (cardRect.height > visibleHeight || cardRect.top < visibleTop) {
      delta = cardRect.top - visibleTop;
    } else if (cardRect.bottom > visibleBottom) {
      delta = cardRect.bottom - visibleBottom;
    }
    if (Math.abs(delta) >= 1) list.scrollTop += delta;
  }

  function focusDraftCommentEditor() {
    const focusOnce = () => {
      const textarea = pane?.querySelector("[data-smarttex-draft-thread] textarea");
      if (!textarea) return false;
      try {
        textarea.focus({ preventScroll: true });
        const end = String(textarea.value || "").length;
        textarea.setSelectionRange?.(end, end);
      } catch (_error) {
        textarea.focus?.();
      }
      ensureDraftCommentEditorVisible();
      return document.activeElement === textarea;
    };
    requestAnimationFrame(() => {
      const focused = focusOnce();
      requestAnimationFrame(() => {
        ensureDraftCommentEditorVisible();
        if (focused) return;
        if (focusOnce()) return;
        window.setTimeout(focusOnce, 40);
      });
    });
  }

  function maybeShowFallbackNameNoticeForDraft() {
    if (!draftThread || !paneOpen || !globalThis.SmartTeXCommentProfile?.isFallbackProfile?.(profile)) return;
    const anchor = pane?.querySelector?.('[data-smarttex-draft-thread="true"] .smarttex-comment-draft-heading strong');
    if (!anchor?.isConnected) return;
    globalThis.SmartTeXCommentProfile?.maybeShowFallbackNotice?.(
      extensionApi?.storage?.local,
      profile,
      anchor
    ).catch?.(() => {});
  }

  function startCommentAt(start, end) {
    if (!currentState?.fileName || draftThread) return;
    const anchor = makeAnchor(start, end);
    draftThread = {
      ...anchor,
      id: uid("thread"),
      createdAt: now(),
      updatedAt: now(),
      comments: {},
      draftText: "",
      giphy: null
    };
    openPane();
    renderAll();
    focusDraftCommentEditor();
    // Re-run host identity discovery at the moment the feature is used, then
    // give it a brief chance to replace the generated fallback before the
    // one-time explanation is shown.
    if (globalThis.SmartTeXCommentProfile?.isFallbackProfile?.(profile)) {
      window.dispatchEvent(new CustomEvent(
        globalThis.SmartTeXCommentProfile?.IDENTITY_REFRESH_EVENT || "smarttex:collabtex-identity-refresh"
      ));
    }
    window.setTimeout(maybeShowFallbackNameNoticeForDraft, 300);
  }

  function createMarkFromAnchor(anchor, stamp = now()) {
    if (!anchor || Number(anchor.end) <= Number(anchor.start)) return null;
    const mark = cleanAnchorRecord({
      ...structuredCloneSafe(anchor),
      id: uid("mark"),
      authorName: String(anchor.authorName || profile.name || "Anonymous"),
      authorId: String(anchor.authorId || authorId || ""),
      createdAt: Number(anchor.createdAt) || stamp,
      updatedAt: stamp,
      deletedAt: 0
    }, "mark");
    data.marks[mark.id] = mark;
    return mark;
  }

  function convertThreadToMark(thread) {
    if (!alive(thread) || Number(thread.end) <= Number(thread.start)) return false;
    const stamp = now();
    createMarkFromAnchor({ ...thread, authorName: profile.name }, stamp);
    thread.deletedAt = stamp;
    thread.permanentlyDeleted = true;
    thread.updatedAt = Math.max(Number(thread.updatedAt) || 0, stamp - 1);
    editingComment = null;
    markDirty();
    renderAll();
    return true;
  }

  function commitDraftThread() {
    if (!draftThread) return;
    const textarea = pane?.querySelector("[data-smarttex-draft-thread] textarea");
    const text = String(textarea?.value || draftThread.draftText || "").trim();
    const giphy = cleanGiphyAttachment(draftThread.giphy);
    if (!text && !giphy) {
      const draft = draftThread;
      const convertedFromMarkId = String(draft.convertedFromMarkId || "");
      draftThread = null;
      if (convertedFromMarkId) {
        // The source mark stayed alive while it was being converted, so an
        // empty OK simply returns to that mark.
        renderAll();
        return;
      }
      if (Number(draft.end) > Number(draft.start)) {
        createMarkFromAnchor({ ...draft, authorName: profile.name });
        markDirty();
        renderAll();
        return;
      }
      // A point comment cannot become a text marking. Keep the draft open.
      draftThread = draft;
      renderAll();
      focusDraftCommentEditor();
      return;
    }
    const stamp = now();
    const comment = cleanComment({
      id: uid("comment"), authorName: profile.name, authorColor: profile.color, authorId,
      text, giphy, createdAt: stamp, updatedAt: stamp
    });
    const thread = cleanAnchorRecord({
      ...draftThread,
      authorName: profile.name,
      authorId,
      updatedAt: stamp,
      comments: { [comment.id]: comment }
    }, "thread");
    const convertedFromMarkId = String(draftThread.convertedFromMarkId || "");
    data.threads[thread.id] = thread;
    if (convertedFromMarkId) {
      const mark = activeMarkById(convertedFromMarkId);
      if (mark) {
        mark.deletedAt = stamp;
        mark.permanentlyDeleted = true;
        mark.updatedAt = Math.max(mark.updatedAt || 0, stamp - 1);
      }
    }
    const threadId = thread.id;
    registerGiphySend(giphy);
    draftThread = null;
    markDirty(WRITE_DELAY_MS, realtimeDataForRecords(thread));
    renderAll();
    requestAnimationFrame(() => scrollThreadIntoView(threadId));
  }

  function cancelDraftThread() {
    if (!draftThread) return;
    draftThread = null;

    // Cancelling a newly created comment discards its temporary range
    // highlight as well. A draft converted from an already existing marking
    // leaves that pre-existing marking untouched.
    renderAll();
  }

  function toggleMark(start, end) {
    const existing = Object.values(data.marks).find((mark) => (
      alive(mark) && fileMatches(mark.fileName, currentState?.fileName) && mark.start === start && mark.end === end
    ));
    const stamp = existing ? nextMutationStamp(existing) : now();
    if (existing) {
      existing.deletedAt = stamp;
      existing.permanentlyDeleted = true;
      existing.updatedAt = Math.max(existing.updatedAt || 0, stamp - 1);
    } else {
      const anchor = makeAnchor(start, end);
      const mark = cleanAnchorRecord({
        ...anchor, id: uid("mark"), authorName: profile.name, authorId,
        createdAt: stamp, updatedAt: stamp
      }, "mark");
      data.marks[mark.id] = mark;
    }
    markDirty();
    renderAll();
  }

  function activeMarkById(markId) {
    const mark = data.marks[String(markId || "")];
    return alive(mark) ? mark : null;
  }

  function deleteMark(markId) {
    const mark = activeMarkById(markId);
    if (!mark) return;
    const stamp = nextMutationStamp(mark);
    mark.deletedAt = stamp;
    mark.permanentlyDeleted = true;
    mark.updatedAt = Math.max(mark.updatedAt || 0, stamp - 1);
    markDirty();
    renderAll();
  }

  function startCommentFromMark(markId) {
    const mark = activeMarkById(markId);
    if (!mark || draftThread) return;
    draftThread = {
      ...structuredCloneSafe(mark),
      id: uid("thread"),
      createdAt: now(),
      updatedAt: now(),
      comments: {},
      draftText: "",
      giphy: null,
      convertedFromMarkId: mark.id
    };
    openPane();
    renderAll();
    focusDraftCommentEditor();
  }

  function beginEditComment(threadId, commentId) {
    const thread = data.threads[String(threadId || "")];
    const comment = thread?.comments?.[String(commentId || "")];
    if (!alive(thread) || !alive(comment) || !ownsComment(comment)) return;
    editingComment = {
      threadId: thread.id,
      commentId: comment.id,
      draftText: String(comment.text || ""),
      draftGiphy: cleanGiphyAttachment(comment.giphy)
    };
    renderAll();
    requestAnimationFrame(() => {
      pane?.querySelector(`[data-comment-id="${CSS.escape(comment.id)}"] textarea`)?.focus?.();
    });
  }

  function commitEditedComment(threadId, commentId, text, giphyValue = null) {
    const thread = data.threads[String(threadId || "")];
    const comment = thread?.comments?.[String(commentId || "")];
    const body = String(text || "").trim();
    const giphy = cleanGiphyAttachment(giphyValue);
    if (!alive(thread) || !alive(comment) || !ownsComment(comment)) return false;
    if (!body && !giphy) {
      const aliveComments = Object.values(thread.comments || {}).filter(alive);
      if (aliveComments.length === 1 && aliveComments[0].id === comment.id) {
        return convertThreadToMark(thread);
      }
      return false;
    }
    comment.text = body;
    comment.giphy = giphy;
    registerGiphySend(giphy);
    comment.updatedAt = nextMutationStamp(comment, thread);
    thread.updatedAt = comment.updatedAt;
    editingComment = null;
    markDirty(WRITE_DELAY_MS, realtimeDataForRecords(thread));
    renderAll();
    return true;
  }

  function deleteComment(threadId, commentId) {
    const thread = data.threads[threadId];
    const comment = thread?.comments?.[commentId];
    if (!thread || !comment) return;
    const aliveComments = Object.values(thread.comments || {}).filter(alive)
      .sort((left, right) => left.createdAt - right.createdAt);
    const deletingRootComment = aliveComments[0]?.id === comment.id;
    const stamp = nextMutationStamp(comment, thread, aliveComments);
    comment.deletedAt = stamp;
    comment.permanentlyDeleted = true;
    comment.updatedAt = Math.max(comment.updatedAt || 0, stamp - 1);
    thread.updatedAt = stamp;
    // The root comment owns the editor anchor/marking. Removing it removes the
    // complete anchored thread; replies cannot leave an orphaned highlight.
    if (deletingRootComment || !Object.values(thread.comments).some(alive)) {
      thread.deletedAt = stamp;
      thread.permanentlyDeleted = true;
    }
    markDirty(WRITE_DELAY_MS, realtimeDataForRecords(thread));
    renderAll();
  }

  function deleteThread(threadId) {
    const thread = data.threads[threadId];
    if (!thread) return;
    const stamp = nextMutationStamp(thread, Object.values(thread.comments || {}));
    thread.deletedAt = stamp;
    thread.permanentlyDeleted = true;
    thread.updatedAt = Math.max(thread.updatedAt || 0, stamp - 1);
    markDirty(WRITE_DELAY_MS, realtimeDataForRecords(thread));
    renderAll();
  }

  function toggleThreadResolved(threadId) {
    const thread = data.threads[String(threadId || "")];
    if (!alive(thread)) return;
    const stamp = nextMutationStamp(thread);
    thread.resolved = !thread.resolved;
    thread.resolvedAt = thread.resolved ? stamp : 0;
    thread.resolvedUpdatedAt = stamp;
    thread.updatedAt = stamp;
    collapsedThreads.delete(thread.id);
    markDirty(250, realtimeDataForRecords(thread));
    renderAll();
  }

  function addReply(threadId, text, giphyValue = null) {
    const thread = data.threads[threadId];
    const body = String(text || "").trim();
    const giphy = cleanGiphyAttachment(giphyValue);
    if (!thread || (!body && !giphy)) return false;
    const stamp = nextMutationStamp(thread, Object.values(thread.comments || {}));
    const comment = cleanComment({
      id: uid("comment"), authorName: profile.name, authorColor: profile.color, authorId,
      text: body, giphy, createdAt: stamp, updatedAt: stamp
    });
    thread.comments[comment.id] = comment;
    registerGiphySend(giphy);
    thread.updatedAt = stamp;
    replyDrafts.delete(threadId);
    replyGiphyDrafts.delete(threadId);
    markDirty(WRITE_DELAY_MS, realtimeDataForRecords(thread));
    renderAll();
    return true;
  }

  function smileyIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01M15.5 10h.01M8.5 14.2c1 1.2 2.1 1.8 3.5 1.8s2.5-.6 3.5-1.8"/></svg>';
  }

  function reactionActorKey() {
    return safeObjectKey(authorId || `legacy:${profile.name}:${validColor(profile.color)}`);
  }

  function activeReactionGroups(comment) {
    const groups = [];
    for (const [emoji, actorsValue] of Object.entries(comment?.reactions || {})) {
      const actors = Object.values(actorsValue || {}).filter((reaction) => reaction?.active !== false);
      if (!actors.length) continue;
      actors.sort((left, right) => (
        String(left.authorName || "").localeCompare(String(right.authorName || ""), undefined, { sensitivity: "base" })
      ));
      groups.push({
        emoji,
        actors,
        firstAt: Math.min(...actors.map((reaction) => Number(reaction.updatedAt) || 0))
      });
    }
    return groups.sort((left, right) => left.firstAt - right.firstAt || left.emoji.localeCompare(right.emoji));
  }

  function toggleCommentReaction(threadIdValue, commentIdValue, emojiValue) {
    const thread = data.threads[String(threadIdValue || "")];
    const comment = thread?.comments?.[String(commentIdValue || "")];
    const emoji = String(emojiValue || "").trim();
    const actorKey = reactionActorKey();
    if (!alive(thread) || !alive(comment) || !actorKey || !isEmojiOnlyText(emoji)) return false;
    if (!comment.reactions || typeof comment.reactions !== "object") comment.reactions = {};
    if (!comment.reactions[emoji] || typeof comment.reactions[emoji] !== "object") {
      comment.reactions[emoji] = {};
    }
    const current = comment.reactions[emoji][actorKey];
    const stamp = nextMutationStamp(thread, comment, Object.values(comment.reactions[emoji]));
    comment.reactions[emoji][actorKey] = cleanReaction({
      actorKey,
      authorId,
      authorName: profile.name,
      authorColor: profile.color,
      active: current?.active === false || !current,
      updatedAt: stamp
    }, actorKey);
    thread.updatedAt = stamp;
    markDirty(250, realtimeDataForRecords(thread));
    renderAll();
    return true;
  }

  function closeEmojiPicker({ restoreFocus = true } = {}) {
    if (!emojiPicker) return;
    emojiPicker.hidden = true;
    emojiPicker.setAttribute("aria-hidden", "true");
    const restore = emojiPickerTarget?.textarea?.isConnected
      ? emojiPickerTarget.textarea
      : emojiPickerRestoreFocus;
    emojiPickerTarget = null;
    emojiPickerRestoreFocus = null;
    if (restoreFocus && restore?.isConnected) {
      requestAnimationFrame(() => {
        try { restore.focus({ preventScroll: true }); } catch (_error) { restore.focus?.(); }
      });
    }
    scheduleDeferredPaneRenderFlush();
  }

  function choosePickerEmoji(emoji) {
    const target = emojiPickerTarget;
    if (!target) return;
    if (target.kind === "input" && target.textarea?.isConnected) {
      const textarea = target.textarea;
      const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
      const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
      textarea.setRangeText(emoji, start, end, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      closeEmojiPicker({ restoreFocus: false });
      try { textarea.focus({ preventScroll: true }); } catch (_error) { textarea.focus?.(); }
      return;
    }
    if (target.kind === "reaction") {
      const { threadId, commentId } = target;
      closeEmojiPicker({ restoreFocus: false });
      toggleCommentReaction(threadId, commentId, emoji);
    }
  }

  function ensureEmojiPicker() {
    if (emojiPicker?.isConnected) return emojiPicker;
    const picker = document.createElement("div");
    picker.id = "smarttex-comment-emoji-picker";
    picker.hidden = true;
    picker.setAttribute("aria-hidden", "true");
    picker.setAttribute("role", "dialog");
    picker.setAttribute("aria-label", "Choose emoji");
    const heading = document.createElement("div");
    heading.className = "smarttex-comment-emoji-picker-heading";
    heading.textContent = "Emoji";
    const grid = document.createElement("div");
    grid.className = "smarttex-comment-emoji-grid";
    grid.setAttribute("role", "listbox");
    for (const emoji of EMOJI_PICKER_VALUES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "smarttex-comment-emoji-option";
      button.textContent = emoji;
      button.dataset.emoji = emoji;
      button.setAttribute("role", "option");
      button.setAttribute("aria-label", `Choose ${emoji}`);
      grid.appendChild(button);
    }
    grid.addEventListener("click", (event) => {
      const button = event.target.closest(".smarttex-comment-emoji-option");
      if (button?.dataset?.emoji) choosePickerEmoji(button.dataset.emoji);
    });
    grid.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const buttons = [...grid.querySelectorAll(".smarttex-comment-emoji-option")];
      const current = Math.max(0, buttons.indexOf(document.activeElement));
      const columns = 8;
      const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 :
        event.key === "ArrowUp" ? -columns : columns;
      event.preventDefault();
      buttons[(current + delta + buttons.length) % buttons.length]?.focus?.();
    });
    picker.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeEmojiPicker();
    });
    picker.append(heading, grid);
    document.body.appendChild(picker);
    document.addEventListener("pointerdown", (event) => {
      if (picker.hidden || picker.contains(event.target) || emojiPickerRestoreFocus?.contains?.(event.target)) return;
      closeEmojiPicker({ restoreFocus: false });
    }, true);
    emojiPicker = picker;
    return picker;
  }

  function openEmojiPicker(button, target) {
    const picker = ensureEmojiPicker();
    if (!picker || !button || !target) return;
    if (!picker.hidden) closeEmojiPicker({ restoreFocus: false });
    emojiPickerTarget = target;
    emojiPickerRestoreFocus = button;
    picker.hidden = false;
    picker.setAttribute("aria-hidden", "false");
    picker.classList.toggle("smarttex-comments-dark", Boolean(pane?.classList?.contains("smarttex-comments-dark")));
    const rect = button.getBoundingClientRect();
    const width = 284;
    picker.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    picker.style.top = `${Math.max(8, rect.bottom + 6)}px`;
    requestAnimationFrame(() => {
      const pickerRect = picker.getBoundingClientRect();
      if (pickerRect.bottom > window.innerHeight - 8) {
        picker.style.top = `${Math.max(8, rect.top - pickerRect.height - 6)}px`;
      }
      picker.querySelector(".smarttex-comment-emoji-option")?.focus?.();
    });
  }

  function giphyBrandElement() {
    const link = document.createElement("a");
    link.className = "smarttex-comment-giphy-brand";
    link.href = globalThis.SmartTeXGiphyIntegration?.GIPHY_URL || "https://giphy.com/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Open GIPHY";
    const asset = globalThis.SmartTeXGiphyIntegration?.attributionAssetUrl?.();
    if (asset) {
      const img = document.createElement("img");
      img.src = asset;
      img.alt = "Powered by GIPHY";
      link.appendChild(img);
    } else {
      link.textContent = "Powered by GIPHY";
    }
    link.addEventListener("click", (event) => event.stopPropagation());
    return link;
  }

  function giphyAttributionElement(attachmentValue) {
    const attachment = cleanGiphyAttachment(attachmentValue);
    const row = document.createElement("div");
    row.className = "smarttex-comment-giphy-attribution";
    row.appendChild(giphyBrandElement());
    if (!attachment) return row;

    const view = document.createElement("a");
    view.className = "smarttex-comment-giphy-credit";
    view.href = attachment.url;
    view.target = "_blank";
    view.rel = "noopener noreferrer";
    view.textContent = "View on GIPHY";
    view.addEventListener("click", (event) => event.stopPropagation());
    row.appendChild(view);

    const creatorLabel = String(attachment.username || "").trim();
    if (creatorLabel) {
      const creator = document.createElement("a");
      creator.className = "smarttex-comment-giphy-credit";
      creator.href = attachment.userUrl || attachment.url;
      creator.target = "_blank";
      creator.rel = "noopener noreferrer";
      creator.textContent = `GIF by ${creatorLabel.startsWith("@") ? creatorLabel : `@${creatorLabel}`}`;
      creator.addEventListener("click", (event) => event.stopPropagation());
      row.appendChild(creator);
    }

    if (attachment.sourceTld) {
      const source = document.createElement(attachment.sourcePostUrl ? "a" : "span");
      source.className = "smarttex-comment-giphy-credit";
      source.textContent = `Source: ${attachment.sourceTld}`;
      if (attachment.sourcePostUrl) {
        source.href = attachment.sourcePostUrl;
        source.target = "_blank";
        source.rel = "noopener noreferrer";
        source.addEventListener("click", (event) => event.stopPropagation());
      }
      row.appendChild(source);
    }
    return row;
  }

  function renderGiphyAttachment(attachmentValue, { allowRemove = false, onRemove = null } = {}) {
    const attachment = cleanGiphyAttachment(attachmentValue);
    if (!attachment) return null;
    const integration = globalThis.SmartTeXGiphyIntegration;
    const wrapper = document.createElement("div");
    wrapper.className = "smarttex-comment-giphy-attachment";
    wrapper.dataset.giphyId = attachment.id;

    const media = document.createElement("div");
    media.className = "smarttex-comment-giphy-media";
    wrapper.appendChild(media);

    const showBlocked = () => {
      media.replaceChildren();
      const blocked = document.createElement("button");
      blocked.type = "button";
      blocked.className = "smarttex-comment-giphy-blocked";
      blocked.innerHTML = "<strong>GIPHY GIF</strong><span>Allow GIPHY to load this GIF</span>";
      blocked.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const allowed = await integration?.requestConsent?.({ reason: "view" });
        if (allowed) showEmbed();
      });
      media.appendChild(blocked);
    };

    const showEmbed = () => {
      media.replaceChildren();
      const frame = document.createElement("iframe");
      frame.className = "smarttex-comment-giphy-frame";
      frame.src = attachment.embedUrl;
      frame.title = attachment.title || "GIPHY GIF";
      frame.loading = "lazy";
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("allowfullscreen", "");
      frame.setAttribute("allow", "fullscreen");
      if (attachment.width > 0 && attachment.height > 0) {
        const ratio = Math.max(0.45, Math.min(2.4, attachment.width / attachment.height));
        frame.style.aspectRatio = String(ratio);
      }
      media.appendChild(frame);
    };

    showBlocked();
    const allowAutomaticConsentPrompt = !suppressGiphyAutoPrompt;
    Promise.resolve(integration?.hasConsent?.()).then((allowed) => {
      if (allowed) {
        showEmbed();
        return;
      }
      if (!allowAutomaticConsentPrompt) return false;
      return integration?.maybeRequestViewingConsent?.().then((granted) => {
        if (granted) showEmbed();
        return granted;
      });
    }).catch(() => {});

    wrapper.appendChild(giphyAttributionElement(attachment));
    if (allowRemove) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "smarttex-comment-giphy-remove";
      remove.textContent = "×";
      remove.title = "Remove GIPHY GIF";
      remove.setAttribute("aria-label", "Remove GIPHY GIF");
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove?.();
      });
      wrapper.appendChild(remove);
    }
    return wrapper;
  }

  function closeGiphyPicker({ restoreFocus = true } = {}) {
    window.clearTimeout(giphySearchTimer);
    giphySearchTimer = 0;
    giphySearchController?.abort?.();
    giphySearchController = null;
    giphyResultObserver?.disconnect?.();
    giphyResultObserver = null;
    giphyPaginationObserver?.disconnect?.();
    giphyPaginationObserver = null;
    if (!giphyPicker) return;
    giphyPicker.hidden = true;
    giphyPicker.setAttribute("aria-hidden", "true");
    const restore = giphyPickerTarget?.textarea?.isConnected
      ? giphyPickerTarget.textarea
      : giphyPickerRestoreFocus;
    giphyPickerTarget = null;
    giphyPickerRestoreFocus = null;
    if (restoreFocus && restore?.isConnected) {
      requestAnimationFrame(() => {
        try { restore.focus({ preventScroll: true }); } catch (_error) { restore.focus?.(); }
      });
    }
    scheduleDeferredPaneRenderFlush();
  }

  function positionGiphyPicker(button) {
    if (!giphyPicker || !button?.isConnected) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(386, Math.max(300, window.innerWidth - 16));
    giphyPicker.style.width = `${width}px`;
    giphyPicker.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    giphyPicker.style.top = `${Math.max(8, rect.bottom + 6)}px`;
    requestAnimationFrame(() => {
      if (!giphyPicker || giphyPicker.hidden) return;
      const pickerRect = giphyPicker.getBoundingClientRect();
      if (pickerRect.bottom > window.innerHeight - 8) {
        giphyPicker.style.top = `${Math.max(8, rect.top - pickerRect.height - 6)}px`;
      }
    });
  }

  function setGiphyForTextarea(textarea, attachment) {
    if (!textarea?.isConnected) return;
    textarea.__smarttexGiphySet?.(cleanGiphyAttachment(attachment));
    textarea.__smarttexGiphyRefresh?.();
  }

  function rememberGiphyAnalytics(result) {
    const id = String(result?.attachment?.id || "");
    if (!id) return;
    const analytics = result?.analytics && typeof result.analytics === "object"
      ? { ...result.analytics }
      : {};
    giphyPendingAnalytics.set(id, analytics);
  }

  function registerGiphySend(attachmentValue) {
    const attachment = cleanGiphyAttachment(attachmentValue);
    if (!attachment) return;
    const analytics = giphyPendingAnalytics.get(attachment.id);
    if (analytics?.onsent) globalThis.SmartTeXGiphyIntegration?.pingAnalytics?.(analytics.onsent);
    giphyPendingAnalytics.delete(attachment.id);
  }

  function ensureGiphyResultObserver(grid) {
    if (giphyResultObserver || typeof IntersectionObserver !== "function") return;
    giphyResultObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        const button = entry.target;
        button.__smarttexGiphyVisible = Boolean(entry.isIntersecting && entry.intersectionRatio > 0);
        button.__smarttexGiphyRegisterView?.();
        if (button.dataset.smarttexGiphyViewed === "true") observer.unobserve(button);
      }
    }, { root: grid, threshold: 0.05 });
  }

  function appendGiphyResultButtons(grid, list, startIndex) {
    ensureGiphyResultObserver(grid);
    for (let relativeIndex = 0; relativeIndex < list.length; relativeIndex += 1) {
      const result = list[relativeIndex];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "smarttex-comment-giphy-result";
      button.dataset.giphyIndex = String(startIndex + relativeIndex);
      button.title = result.attachment.title || "Insert GIPHY GIF";
      const img = document.createElement("img");
      img.src = result.previewUrl;
      img.alt = result.attachment.title || "GIPHY GIF";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      const registerView = () => {
        if (button.dataset.smarttexGiphyViewed === "true") return;
        if (!img.complete || !img.naturalWidth) return;
        if (giphyResultObserver && !button.__smarttexGiphyVisible) return;
        button.dataset.smarttexGiphyViewed = "true";
        if (result.analytics?.onload) globalThis.SmartTeXGiphyIntegration?.pingAnalytics?.(result.analytics.onload);
      };
      button.__smarttexGiphyRegisterView = registerView;
      img.addEventListener("load", registerView, { once: true });
      button.appendChild(img);
      const resultCredits = [];
      if (result.attachment.username) {
        resultCredits.push(result.attachment.username.startsWith("@")
          ? result.attachment.username
          : `@${result.attachment.username}`);
      }
      if (result.attachment.sourceTld) resultCredits.push(result.attachment.sourceTld);
      if (resultCredits.length) {
        const credit = document.createElement("span");
        credit.textContent = resultCredits.join(" · ");
        button.appendChild(credit);
      }
      grid.appendChild(button);
      if (giphyResultObserver) giphyResultObserver.observe(button);
      else registerView();
    }
  }

  function setGiphyPaginationLoading(loading) {
    const more = giphyPicker?.querySelector(".smarttex-comment-giphy-pagination");
    if (!more) return;
    more.classList.toggle("smarttex-comment-giphy-pagination-loading", Boolean(loading));
    const button = more.querySelector(".smarttex-comment-giphy-load-more");
    const label = more.querySelector(".smarttex-comment-giphy-more-label");
    const spinner = more.querySelector(".smarttex-comment-giphy-pagination-spinner");
    if (button) button.hidden = Boolean(loading);
    if (label) label.hidden = Boolean(loading);
    if (spinner) spinner.hidden = !loading;
    more.setAttribute("aria-busy", loading ? "true" : "false");
  }

  function configureGiphyPagination(pageResults) {
    const grid = giphyPicker?.querySelector(".smarttex-comment-giphy-grid");
    if (!grid || !giphyPicker) return;
    giphyPaginationObserver?.disconnect?.();
    giphyPaginationObserver = null;
    grid.querySelector(".smarttex-comment-giphy-pagination")?.remove?.();

    const pagination = pageResults?.pagination || {};
    if (!pagination.hasMore) return;
    const nextOffset = Math.max(0, Number(pagination.nextOffset) || 0);
    const usesBundledKey = Boolean(pageResults?.usesBundledKey);
    const query = String(giphyPicker.__smarttexQuery || "");
    const more = document.createElement("div");
    more.className = "smarttex-comment-giphy-pagination";
    more.setAttribute("aria-live", "polite");

    const spinner = document.createElement("span");
    spinner.className = "smarttex-comment-giphy-pagination-spinner";
    spinner.hidden = true;
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-label", "Loading more GIFs");

    const loadNext = () => {
      if (!giphyPicker || giphyPicker.hidden || giphyPicker.__smarttexLoadingMore) return;
      setGiphyPaginationLoading(true);
      loadGiphyPickerResults(query, { append: true, offset: nextOffset });
    };

    if (usesBundledKey || typeof IntersectionObserver !== "function") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "smarttex-comment-giphy-load-more";
      button.textContent = "Load more";
      button.title = usesBundledKey
        ? "Load 50 more GIFs (uses one GIPHY API call)"
        : "Load 50 more GIFs";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        loadNext();
      });
      more.appendChild(button);
    } else {
      const label = document.createElement("span");
      label.className = "smarttex-comment-giphy-more-label";
      label.textContent = "Scroll for more";
      more.appendChild(label);
      giphyPaginationObserver = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        giphyPaginationObserver?.disconnect?.();
        giphyPaginationObserver = null;
        loadNext();
      }, { root: grid, rootMargin: "0px 0px 240px 0px", threshold: 0 });
      giphyPaginationObserver.observe(more);
    }
    more.appendChild(spinner);
    grid.appendChild(more);
  }

  function renderGiphyPickerResults(results, { append = false } = {}) {
    const grid = giphyPicker?.querySelector(".smarttex-comment-giphy-grid");
    const status = giphyPicker?.querySelector(".smarttex-comment-giphy-status");
    if (!grid || !status || !giphyPicker) return;

    const list = Array.isArray(results) ? results : [];
    if (!append) {
      giphyResultObserver?.disconnect?.();
      giphyResultObserver = null;
      giphyPaginationObserver?.disconnect?.();
      giphyPaginationObserver = null;
      grid.replaceChildren();
      giphyPicker.__smarttexResults = [];
    } else {
      grid.querySelector(".smarttex-comment-giphy-pagination")?.remove?.();
    }

    const existing = Array.isArray(giphyPicker.__smarttexResults) ? giphyPicker.__smarttexResults : [];
    const startIndex = existing.length;
    giphyPicker.__smarttexResults = existing.concat(list);
    appendGiphyResultButtons(grid, list, startIndex);
    status.textContent = giphyPicker.__smarttexResults.length ? "" : "No GIFs found.";
    configureGiphyPagination(results);
  }

  async function loadGiphyPickerResults(query = "", { append = false, offset = 0 } = {}) {
    if (!giphyPicker || giphyPicker.hidden) return;
    const grid = giphyPicker.querySelector(".smarttex-comment-giphy-grid");
    const status = giphyPicker.querySelector(".smarttex-comment-giphy-status");
    if (!grid || !status) return;
    if (append && giphyPicker.__smarttexLoadingMore) return;

    if (!append) {
      giphySearchController?.abort?.();
      giphyPaginationObserver?.disconnect?.();
      giphyPaginationObserver = null;
      grid.replaceChildren();
      giphyPicker.__smarttexResults = [];
      giphyPicker.__smarttexQuery = String(query || "");
      status.textContent = query.trim() ? "Searching GIPHY…" : "Loading trending GIFs…";
    } else {
      if (String(query || "") !== String(giphyPicker.__smarttexQuery || "")) return;
      giphyPicker.__smarttexLoadingMore = true;
      setGiphyPaginationLoading(true);
      status.textContent = "Loading 50 more GIFs…";
    }

    const controller = new AbortController();
    giphySearchController = controller;
    try {
      const results = await globalThis.SmartTeXGiphyIntegration?.search?.(query, {
        signal: controller.signal,
        offset
      });
      if (controller.signal.aborted || giphySearchController !== controller) return;
      // Release the in-flight guard before arming the next-page observer.
      if (append && giphyPicker) giphyPicker.__smarttexLoadingMore = false;
      renderGiphyPickerResults(results || [], { append });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (append) setGiphyPaginationLoading(false);
      if (!append) grid.replaceChildren();
      status.replaceChildren();
      const message = document.createElement("span");
      message.textContent = error?.message || "Could not load GIPHY GIFs.";
      status.appendChild(message);
      if (error?.code === "MISSING_API_KEY" || error?.code === "PERSONAL_API_KEY_REQUIRED") {
        const options = document.createElement("button");
        options.type = "button";
        options.className = "smarttex-comment-giphy-options-button";
        options.textContent = "Open SmartTeX options";
        options.addEventListener("click", (event) => {
          event.stopPropagation();
          globalThis.SmartTeXGiphyIntegration?.openOptions?.();
        });
        status.appendChild(options);
      }
    } finally {
      if (giphySearchController === controller) giphySearchController = null;
      if (giphyPicker) giphyPicker.__smarttexLoadingMore = false;
    }
  }

  function ensureGiphyPicker() {
    if (giphyPicker?.isConnected) return giphyPicker;
    const picker = document.createElement("div");
    picker.id = "smarttex-comment-giphy-picker";
    picker.hidden = true;
    picker.setAttribute("aria-hidden", "true");
    picker.setAttribute("role", "dialog");
    picker.setAttribute("aria-label", "Choose a GIPHY GIF");

    const top = document.createElement("div");
    top.className = "smarttex-comment-giphy-picker-top";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "smarttex-comment-giphy-search";
    input.placeholder = "Search GIPHY GIFs";
    input.autocomplete = "off";
    input.spellcheck = false;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "smarttex-comment-giphy-picker-close";
    close.textContent = "×";
    close.title = "Close GIPHY picker";
    close.setAttribute("aria-label", "Close GIPHY picker");
    close.addEventListener("click", () => closeGiphyPicker());
    top.append(input, close);

    const status = document.createElement("div");
    status.className = "smarttex-comment-giphy-status";
    const grid = document.createElement("div");
    grid.className = "smarttex-comment-giphy-grid";
    const footer = document.createElement("div");
    footer.className = "smarttex-comment-giphy-footer";
    footer.appendChild(giphyBrandElement());

    input.addEventListener("input", () => {
      window.clearTimeout(giphySearchTimer);
      const exactQuery = input.value;
      giphySearchTimer = window.setTimeout(() => loadGiphyPickerResults(exactQuery), 320);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        window.clearTimeout(giphySearchTimer);
        loadGiphyPickerResults(input.value);
      }
    });
    grid.addEventListener("click", async (event) => {
      const button = event.target.closest(".smarttex-comment-giphy-result");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const result = picker.__smarttexResults?.[Number(button.dataset.giphyIndex)];
      if (!result?.attachment || !giphyPickerTarget?.textarea) return;
      const integration = globalThis.SmartTeXGiphyIntegration;
      if (!(await integration?.ensureGifInsertionAllowed?.({ prompt: true }))) {
        closeGiphyPicker({ restoreFocus: false });
        return;
      }
      if (result.analytics?.onclick) integration?.pingAnalytics?.(result.analytics.onclick);
      rememberGiphyAnalytics(result);
      const textarea = giphyPickerTarget.textarea;
      setGiphyForTextarea(textarea, result.attachment);
      await integration?.recordGifInsertion?.();
      closeGiphyPicker({ restoreFocus: false });
      try { textarea.focus({ preventScroll: true }); } catch (_error) { textarea.focus?.(); }
    });
    picker.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeGiphyPicker();
    });
    picker.append(top, status, grid, footer);
    document.body.appendChild(picker);
    document.addEventListener("pointerdown", (event) => {
      if (picker.hidden || picker.contains(event.target) || giphyPickerRestoreFocus?.contains?.(event.target)) return;
      closeGiphyPicker({ restoreFocus: false });
    }, true);
    giphyPicker = picker;
    return picker;
  }

  function describeGiphyInput(textarea) {
    if (!textarea) return null;
    const draft = textarea.closest?.('[data-smarttex-draft-thread="true"]');
    if (draft) return { kind: "draft" };

    const entry = textarea.closest?.(".smarttex-comment-entry");
    const thread = textarea.closest?.(".smarttex-comment-thread");
    if (entry?.dataset?.commentId && thread?.dataset?.threadId) {
      return {
        kind: "edit",
        threadId: String(thread.dataset.threadId),
        commentId: String(entry.dataset.commentId)
      };
    }

    const reply = textarea.closest?.(".smarttex-comment-reply-editor");
    if (reply && thread?.dataset?.threadId) {
      return { kind: "reply", threadId: String(thread.dataset.threadId) };
    }
    return null;
  }

  function escapeGiphySelector(value) {
    const exact = String(value || "");
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(exact);
    return exact.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
  }

  function resolveGiphyInput(context, fallbackButton, fallbackTextarea) {
    if (fallbackButton?.isConnected && fallbackTextarea?.isConnected) {
      return { button: fallbackButton, textarea: fallbackTextarea };
    }
    const root = pane?.isConnected ? pane : document;
    let host = null;
    if (context?.kind === "draft") {
      host = root.querySelector?.('[data-smarttex-draft-thread="true"]');
    } else if (context?.kind === "reply" && context.threadId) {
      host = root.querySelector?.(
        `[data-thread-id="${escapeGiphySelector(context.threadId)}"] .smarttex-comment-reply-editor`
      );
    } else if (context?.kind === "edit" && context.threadId && context.commentId) {
      host = root.querySelector?.(
        `[data-thread-id="${escapeGiphySelector(context.threadId)}"] ` +
        `.smarttex-comment-entry[data-comment-id="${escapeGiphySelector(context.commentId)}"]`
      );
    }
    const textarea = host?.querySelector?.("textarea");
    const button = host?.querySelector?.(".smarttex-comment-giphy-trigger");
    if (!textarea?.isConnected || !button?.isConnected) return null;
    return { button, textarea };
  }

  async function openGiphyPicker(button, textarea) {
    if (!button || !textarea) return;
    const context = describeGiphyInput(textarea);
    const integration = globalThis.SmartTeXGiphyIntegration;
    const allowed = await integration?.requestConsent?.({ reason: "add" });
    if (!allowed) return;

    // Consent can trigger UI updates. Resolve the current textarea/button pair
    // again after the asynchronous consent step so the first click remains valid
    // even if the comments pane was re-rendered in the meantime.
    const target = resolveGiphyInput(context, button, textarea);
    if (!target) return;
    button = target.button;
    textarea = target.textarea;

    if (emojiPicker && !emojiPicker.hidden) closeEmojiPicker({ restoreFocus: false });
    const picker = ensureGiphyPicker();
    if (!picker.hidden) closeGiphyPicker({ restoreFocus: false });
    giphyPickerTarget = { textarea };
    giphyPickerRestoreFocus = button;
    picker.hidden = false;
    picker.setAttribute("aria-hidden", "false");
    picker.classList.toggle("smarttex-comments-dark", Boolean(pane?.classList?.contains("smarttex-comments-dark")));
    const input = picker.querySelector(".smarttex-comment-giphy-search");
    if (input) input.value = "";
    positionGiphyPicker(button);
    await loadGiphyPickerResults("");
    if (!picker.hidden) {
      positionGiphyPicker(button);
      input?.focus?.();
    }
  }

  function emojiInputShell(textarea) {
    const shell = document.createElement("div");
    shell.className = "smarttex-comment-input-shell";

    const emojiButton = document.createElement("button");
    emojiButton.type = "button";
    emojiButton.className = "smarttex-comment-emoji-trigger";
    emojiButton.innerHTML = smileyIconSvg();
    emojiButton.title = "Insert emoji";
    emojiButton.setAttribute("aria-label", "Insert emoji");
    emojiButton.addEventListener("pointerdown", (event) => event.preventDefault());
    emojiButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openEmojiPicker(emojiButton, { kind: "input", textarea });
    });

    const giphyButton = document.createElement("button");
    giphyButton.type = "button";
    giphyButton.className = "smarttex-comment-giphy-trigger";
    giphyButton.textContent = "GIF";
    giphyButton.title = "Insert GIPHY GIF";
    giphyButton.setAttribute("aria-label", "Insert GIPHY GIF");
    // Trigger on pointerdown, with click as the keyboard/accessibility fallback.
    // This prevents the first activation from being lost to focus/re-render work
    // in the surrounding comment card and suppresses the duplicate click event.
    bindImmediateButtonAction(giphyButton, () => {
      openGiphyPicker(giphyButton, textarea);
    });

    const preview = document.createElement("div");
    preview.className = "smarttex-comment-giphy-input-preview";
    const refreshPreview = () => {
      preview.replaceChildren();
      const attachment = cleanGiphyAttachment(textarea.__smarttexGiphyGet?.());
      if (!attachment) {
        preview.hidden = true;
        return;
      }
      preview.hidden = false;
      const rendered = renderGiphyAttachment(attachment, {
        allowRemove: true,
        onRemove: () => {
          textarea.__smarttexGiphySet?.(null);
          giphyPendingAnalytics.delete(attachment.id);
          refreshPreview();
        }
      });
      if (rendered) preview.appendChild(rendered);
    };
    textarea.__smarttexGiphyRefresh = refreshPreview;

    shell.append(textarea, giphyButton, emojiButton, preview);
    refreshPreview();
    return shell;
  }

  function ensureReactionTooltip() {
    if (reactionTooltip?.isConnected) return reactionTooltip;
    const tooltip = document.createElement("div");
    tooltip.id = "smarttex-comment-reaction-tooltip";
    tooltip.className = "smarttex-comment-reaction-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    reactionTooltip = tooltip;
    return tooltip;
  }

  function hideReactionTooltip(owner = null) {
    if (!reactionTooltip || (owner && reactionTooltipOwner !== owner)) return;
    reactionTooltip.hidden = true;
    reactionTooltip.classList.remove("smarttex-comment-reaction-tooltip-visible");
    reactionTooltip.replaceChildren();
    reactionTooltip.style.removeProperty("left");
    reactionTooltip.style.removeProperty("top");
    reactionTooltipOwner = null;
  }

  function showReactionTooltip(button, actors) {
    const tooltip = ensureReactionTooltip();
    if (!tooltip || !button?.isConnected) return;
    reactionTooltipOwner = button;
    tooltip.replaceChildren();
    for (const reaction of actors) {
      const name = document.createElement("span");
      name.textContent = reaction.authorName || "Anonymous";
      tooltip.appendChild(name);
    }
    tooltip.classList.toggle("smarttex-comments-dark", Boolean(pane?.classList?.contains("smarttex-comments-dark")));
    tooltip.hidden = false;
    tooltip.classList.add("smarttex-comment-reaction-tooltip-visible");
    const rect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(6, Math.min(window.innerWidth - tooltipRect.width - 6, rect.left + rect.width / 2 - tooltipRect.width / 2))}px`;
    const above = rect.top - tooltipRect.height - 8;
    tooltip.style.top = `${above >= 6 ? above : Math.min(window.innerHeight - tooltipRect.height - 6, rect.bottom + 8)}px`;
  }

  function renderCommentReactions(thread, comment) {
    const wrapper = document.createElement("div");
    wrapper.className = "smarttex-comment-reactions";
    const groups = activeReactionGroups(comment);
    const ownActorKey = reactionActorKey();
    for (const group of groups) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "smarttex-comment-reaction";
      button.setAttribute("aria-pressed", group.actors.some((reaction) => reaction.actorKey === ownActorKey) ? "true" : "false");
      button.setAttribute("aria-describedby", "smarttex-comment-reaction-tooltip");
      button.setAttribute(
        "aria-label",
        `${group.emoji}: ${group.actors.length} reaction${group.actors.length === 1 ? "" : "s"} from ${group.actors.map((reaction) => reaction.authorName || "Anonymous").join(", ")}`
      );
      const emoji = document.createElement("span");
      emoji.className = "smarttex-comment-reaction-emoji";
      emoji.textContent = group.emoji;
      const badge = document.createElement("span");
      badge.className = "smarttex-comment-reaction-count";
      badge.textContent = String(group.actors.length);
      button.appendChild(emoji);
      if (group.actors.length >= 2) button.appendChild(badge);
      button.addEventListener("mouseenter", () => showReactionTooltip(button, group.actors));
      button.addEventListener("mouseleave", () => hideReactionTooltip(button));
      button.addEventListener("focus", () => showReactionTooltip(button, group.actors));
      button.addEventListener("blur", () => hideReactionTooltip(button));
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        hideReactionTooltip(button);
        toggleCommentReaction(thread.id, comment.id, group.emoji);
      });
      wrapper.appendChild(button);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "smarttex-comment-reaction-add";
    if (groups.length) {
      add.textContent = "+";
      add.classList.add("smarttex-comment-reaction-add-plus");
    } else {
      add.innerHTML = smileyIconSvg();
    }
    add.title = "Add reaction";
    add.setAttribute("aria-label", "Add reaction");
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      openEmojiPicker(add, { kind: "reaction", threadId: thread.id, commentId: comment.id });
    });
    wrapper.appendChild(add);
    return wrapper;
  }

  function commentIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-8l-5 3v-3H5a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Z"/></svg>';
  }

  function markerIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 18 8.8-12.2 5.4 3.9L9.4 22H4v-4Z"/><path d="m13.8 4.4 1.8-2.5 5.4 3.9-1.8 2.5"/><path d="M2 22h20"/></svg>';
  }

  function trashIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7"/></svg>';
  }

  function paletteIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.4a1.8 1.8 0 0 0 1.2-3.1 1.8 1.8 0 0 1 1.2-3.1H18A3 3 0 0 0 21 12c0-5-4-9-9-9Z"/><circle cx="7.5" cy="10" r="1"/><circle cx="10" cy="6.8" r="1"/><circle cx="14.2" cy="6.9" r="1"/><circle cx="17" cy="10" r="1"/></svg>';
  }

  function settingsIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>';
  }

  function closeColorPicker({ apply = false } = {}) {
    if (!colorPickerOverlay || !colorPickerTarget) return;
    const target = colorPickerTarget;
    const chosen = validColor(colorPickerOverlay.querySelector(".smarttex-comment-color-native")?.value, target.record.color);
    if (apply) {
      target.record.color = chosen;
      target.record.updatedAt = now();
      markDirty();
    } else {
      target.record.color = colorPickerOriginalColor;
    }
    target.card?.style?.setProperty("--smarttex-thread-color", target.record.color);
    renderOverlays();
    colorPickerOverlay.hidden = true;
    colorPickerOverlay.setAttribute("aria-hidden", "true");
    colorPickerTarget = null;
    colorPickerOriginalColor = "";
    const restore = colorPickerRestoreFocus;
    colorPickerRestoreFocus = null;
    renderPaneThreads();
    requestAnimationFrame(() => { try { restore?.focus?.({ preventScroll: true }); } catch (_error) {} });
  }

  function ensureColorPickerOverlay() {
    if (colorPickerOverlay?.isConnected) return colorPickerOverlay;
    const overlay = document.createElement("div");
    overlay.id = "smarttex-comment-color-overlay";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    const swatches = (globalThis.SmartTeXCommentProfile?.COLORS || [
      "#e5534b", "#d97706", "#b58900", "#5f9f45", "#2f9e72", "#159eaf",
      "#268bd2", "#4f7fe8", "#7455d9", "#9b59b6", "#c94f9d", "#d94f70"
    ]).map((color) => `<button type="button" class="smarttex-comment-color-swatch" data-color="${color}" style="--smarttex-swatch:${color}" aria-label="Use ${color}"></button>`).join("");
    overlay.innerHTML = `
      <div class="smarttex-comment-color-picker" role="dialog" aria-modal="true" aria-labelledby="smarttex-comment-color-title">
        <div class="smarttex-comment-color-title" id="smarttex-comment-color-title">Change color</div>
        <div class="smarttex-comment-color-swatches">${swatches}</div>
        <label class="smarttex-comment-color-custom"><span>Custom</span><input type="color" class="smarttex-comment-color-native" value="#268bd2"></label>
        <label class="smarttex-comment-color-hex"><span>Hex</span><input type="text" class="smarttex-comment-color-hex-input" value="#268bd2" maxlength="7" spellcheck="false"></label>
        <div class="smarttex-comment-color-actions">
          <button type="button" class="smarttex-comment-color-cancel">Cancel</button>
          <button type="button" class="smarttex-comment-color-apply">Apply</button>
        </div>
      </div>`;
    const picker = overlay.querySelector(".smarttex-comment-color-picker");
    const native = overlay.querySelector(".smarttex-comment-color-native");
    const hex = overlay.querySelector(".smarttex-comment-color-hex-input");
    const preview = (value) => {
      if (!colorPickerTarget) return;
      const color = validColor(value, colorPickerTarget.record.color);
      colorPickerTarget.record.color = color;
      colorPickerTarget.card?.style?.setProperty("--smarttex-thread-color", color);
      if (native) native.value = color;
      if (hex) hex.value = color;
      renderOverlays();
    };
    overlay.querySelectorAll(".smarttex-comment-color-swatch").forEach((swatch) => {
      swatch.addEventListener("click", () => preview(swatch.dataset.color));
    });
    native?.addEventListener("input", () => preview(native.value));
    hex?.addEventListener("input", () => {
      const raw = String(hex.value || "").trim();
      hex.classList.toggle("smarttex-comment-color-invalid", !/^#[0-9a-f]{6}$/i.test(raw));
      if (/^#[0-9a-f]{6}$/i.test(raw)) preview(raw.toLowerCase());
    });
    overlay.querySelector(".smarttex-comment-color-cancel")?.addEventListener("click", () => closeColorPicker({ apply: false }));
    overlay.querySelector(".smarttex-comment-color-apply")?.addEventListener("click", () => closeColorPicker({ apply: true }));
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) {
        event.preventDefault();
        closeColorPicker({ apply: false });
      }
    });
    picker?.addEventListener("pointerdown", (event) => event.stopPropagation());
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeColorPicker({ apply: false });
      }
    });
    document.body.appendChild(overlay);
    colorPickerOverlay = overlay;
    return overlay;
  }

  function openColorPicker(button, record, card, label = "Change color") {
    const overlay = ensureColorPickerOverlay();
    if (!overlay || !button || !record) return;
    if (colorPickerTarget) closeColorPicker({ apply: false });
    const original = validColor(record.color);
    colorPickerTarget = { button, record, card };
    colorPickerOriginalColor = original;
    colorPickerRestoreFocus = button;
    const title = overlay.querySelector("#smarttex-comment-color-title");
    const native = overlay.querySelector(".smarttex-comment-color-native");
    const hex = overlay.querySelector(".smarttex-comment-color-hex-input");
    if (title) title.textContent = label;
    if (native) native.value = original;
    if (hex) {
      hex.value = original;
      hex.classList.remove("smarttex-comment-color-invalid");
    }
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    overlay.classList.toggle("smarttex-comments-dark", pane?.classList?.contains("smarttex-comments-dark"));
    const picker = overlay.querySelector(".smarttex-comment-color-picker");
    const rect = button.getBoundingClientRect();
    if (picker) {
      picker.style.left = `${Math.max(8, Math.min(window.innerWidth - 248, rect.right - 232))}px`;
      picker.style.top = `${Math.max(8, Math.min(window.innerHeight - 260, rect.bottom + 6))}px`;
      requestAnimationFrame(() => {
        const pr = picker.getBoundingClientRect();
        if (pr.bottom > window.innerHeight - 8) picker.style.top = `${Math.max(8, rect.top - pr.height - 6)}px`;
      });
    }
    requestAnimationFrame(() => native?.focus?.());
  }

  function attachColorPicker(header, record, card, label = "Change color") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "smarttex-comment-thread-action smarttex-comment-color-button";
    button.innerHTML = paletteIconSvg();
    button.title = label;
    button.setAttribute("aria-label", label);
    bindImmediateButtonAction(button, () => openColorPicker(button, record, card, label));
    return { button };
  }

  function collapseIconSvg(collapsed) {
    return collapsed
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 8 7-8 7"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 8 7 8 7-8"/></svg>';
  }

  function activeThreads() {
    const fileName = currentState?.fileName || "";
    return Object.values(data.threads)
      .filter((thread) => (
        alive(thread) && fileMatches(thread.fileName, fileName) &&
        (showResolvedThreads || !thread.resolved)
      ))
      .sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
  }

  function hasActualCommentsForCurrentDocument() {
    return activeThreads().some((thread) =>
      Object.values(thread.comments || {}).some((comment) => alive(comment))
    );
  }

  function hasTrackedChangesForCurrentDocument() {
    return Array.isArray(reviewUiState.changes) && reviewUiState.changes.some((change) => {
      if (!change) return false;
      if (change.type === "insert") return Boolean(change.text) && Number(change.end) > Number(change.start);
      if (change.type === "delete") return Boolean(change.originalText) && (!change.retained || Number(change.end) > Number(change.start));
      if (change.type === "replace") return String(change.originalText || "") !== String(change.text || "");
      if (change.type === "move") return Boolean(change.text || change.originalText) && Number(change.toEnd) > Number(change.toStart);
      return false;
    });
  }

  function maybeAutoOpenForCurrentDocument() {
    if (!initialSyncComplete || !currentState?.fileName) return;
    const fileName = String(currentState.fileName);
    if (autoOpenCheckedFiles.has(fileName)) return;
    if (hasActualCommentsForCurrentDocument()) {
      autoOpenCheckedFiles.add(fileName);
      openPane();
      return;
    }
    if (hasTrackedChangesForCurrentDocument()) {
      autoOpenCheckedFiles.add(fileName);
      openPane();
      return;
    }
    // Root-folder/file-tree discovery can lag document startup. Do not mark a
    // marker-only/temporarily-unread document as checked immediately; allow the
    // lightweight collaboration refresh loop to discover comments for 30 s.
    if (initialSyncCompletedAt && now() - initialSyncCompletedAt >= 30000) {
      autoOpenCheckedFiles.add(fileName);
    }
  }

  function unreadDot(title = "Unread collaborator activity") {
    const dot = document.createElement("span");
    dot.className = "smarttex-comments-unread-dot";
    dot.title = title;
    dot.setAttribute("aria-label", title);
    return dot;
  }

  function renderCommentEntry(thread, comment) {
    const row = document.createElement("article");
    row.className = "smarttex-comment-entry";
    row.dataset.commentId = comment.id;
    row.style.setProperty("--smarttex-comment-author-color", validColor(comment.authorColor));
    const unread = isCommentUnread(thread, comment);
    row.classList.toggle("smarttex-comment-unread", unread);
    const heading = document.createElement("div");
    heading.className = "smarttex-comment-entry-heading";
    const author = document.createElement("strong");
    author.textContent = comment.authorName || "Anonymous";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "smarttex-comment-remove";
    remove.textContent = "×";
    remove.title = "Remove this comment";
    remove.setAttribute("aria-label", "Remove this comment");
    bindImmediateButtonAction(remove, () => {
      confirmRemoval({
        title: "Delete comment?",
        message: "Delete this comment? This action cannot be undone.",
        onConfirm: () => deleteComment(thread.id, comment.id)
      });
    });
    if (unread) heading.appendChild(unreadDot("Unread comment"));
    heading.append(author, remove);
    if (unread) {
      row.addEventListener("click", (event) => {
        if (event.target.closest("button, textarea, input, a, iframe")) return;
        if (!markCommentRead(thread, comment, { refresh: false })) return;
        row.classList.remove("smarttex-comment-unread");
        row.querySelector(".smarttex-comments-unread-dot")?.remove?.();
        const card = row.closest(".smarttex-comment-thread");
        if (!Object.values(thread.comments || {}).some((entry) => isCommentUnread(thread, entry))) {
          card?.classList?.remove("smarttex-comment-thread-has-unread");
          card?.querySelector(":scope > .smarttex-comment-thread-header .smarttex-comments-unread-dot")?.remove?.();
        }
        dispatchUnreadState();
      });
    }
    const editable = ownsComment(comment);
    const isEditing = editable && editingComment?.threadId === thread.id && editingComment?.commentId === comment.id;
    if (isEditing) {
      const textarea = document.createElement("textarea");
      textarea.rows = 3;
      textarea.value = editingComment.draftText;
      textarea.__smarttexGiphyGet = () => (
        editingComment?.threadId === thread.id && editingComment?.commentId === comment.id
          ? editingComment.draftGiphy
          : null
      );
      textarea.__smarttexGiphySet = (value) => {
        if (editingComment?.threadId === thread.id && editingComment?.commentId === comment.id) {
          editingComment.draftGiphy = cleanGiphyAttachment(value);
        }
      };
      textarea.addEventListener("input", () => {
        if (editingComment?.threadId === thread.id && editingComment?.commentId === comment.id) {
          editingComment.draftText = textarea.value;
        }
      });
      const actions = document.createElement("div");
      actions.className = "smarttex-comment-edit-actions";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "smarttex-comment-primary";
      ok.textContent = "OK";
      bindImmediateButtonAction(ok, () => {
        if (!commitEditedComment(thread.id, comment.id, textarea.value, editingComment?.draftGiphy)) textarea.focus();
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      bindImmediateButtonAction(cancel, () => {
        editingComment = null;
        renderAll();
      });
      actions.append(ok, cancel);
      row.append(heading, emojiInputShell(textarea), actions);
    } else {
      const content = document.createElement("div");
      content.className = "smarttex-comment-content";
      if (comment.text) {
        const text = document.createElement("div");
        text.className = "smarttex-comment-text";
        text.textContent = comment.text;
        text.classList.toggle("smarttex-comment-text-emoji-only", isEmojiOnlyText(comment.text));
        if (editable) text.title = "Double-click to edit";
        content.appendChild(text);
      }
      const gif = renderGiphyAttachment(comment.giphy);
      if (gif) content.appendChild(gif);
      if (editable && !comment.text) content.title = "Double-click to edit";
      row.append(heading, content, renderCommentReactions(thread, comment));
      if (editable) {
        // Keep clicks on an editable comment inside the comment pane. Without
        // this, the first click of a double-click bubbles to the thread card,
        // which navigates to the source editor and steals focus before editing.
        row.addEventListener("click", (event) => {
          if (event.target.closest("button, textarea, input, a, iframe")) return;
          event.stopPropagation();
        });
        row.addEventListener("dblclick", (event) => {
          if (event.target.closest("button, textarea, input, a, iframe")) return;
          event.preventDefault();
          event.stopPropagation();
          beginEditComment(thread.id, comment.id);
        });
      }
    }
    return row;
  }

  function renderReplyEditor(thread) {
    const wrapper = document.createElement("div");
    wrapper.className = "smarttex-comment-reply-editor";
    const textarea = document.createElement("textarea");
    textarea.rows = 2;
    textarea.placeholder = "Reply…";
    textarea.value = replyDrafts.get(thread.id) || "";
    textarea.__smarttexGiphyGet = () => replyGiphyDrafts.get(thread.id) || null;
    textarea.__smarttexGiphySet = (value) => {
      const giphy = cleanGiphyAttachment(value);
      if (giphy) replyGiphyDrafts.set(thread.id, giphy);
      else replyGiphyDrafts.delete(thread.id);
    };
    textarea.addEventListener("input", () => replyDrafts.set(thread.id, textarea.value));
    const actions = document.createElement("div");
    actions.className = "smarttex-comment-edit-actions";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "smarttex-comment-primary";
    ok.textContent = "OK";
    ok.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!addReply(thread.id, textarea.value, replyGiphyDrafts.get(thread.id))) textarea.focus();
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      replyDrafts.delete(thread.id);
      replyGiphyDrafts.delete(thread.id);
      renderAll();
    });
    actions.append(ok, cancel);
    wrapper.append(emojiInputShell(textarea), actions);
    return wrapper;
  }

  function renderThread(thread) {
    const card = document.createElement("section");
    card.className = "smarttex-comment-thread";
    card.classList.toggle("smarttex-comment-thread-cursor-active", cursorActiveThreadId === thread.id);
    card.classList.toggle("smarttex-comment-thread-icon-active", iconFocusedThreadId === thread.id);
    card.dataset.threadId = thread.id;
    card.style.setProperty("--smarttex-thread-color", validColor(thread.color));
    card.classList.toggle("smarttex-comment-thread-resolved", Boolean(thread.resolved));
    const collapsed = collapsedThreads.has(thread.id);
    card.classList.toggle("smarttex-comment-thread-collapsed", collapsed);

    const header = document.createElement("header");
    header.className = "smarttex-comment-thread-header";
    const unreadComments = Object.values(thread.comments || {}).filter((comment) => isCommentUnread(thread, comment));
    if (unreadComments.length) {
      card.classList.add("smarttex-comment-thread-has-unread");
      header.appendChild(unreadDot(unreadComments.length === 1 ? "1 unread comment" : `${unreadComments.length} unread comments`));
    }
    const location = document.createElement("button");
    location.type = "button";
    location.className = "smarttex-comment-thread-location";
    location.innerHTML = commentIconSvg();
    location.title = "Go to comment in editor";
    location.setAttribute("aria-label", "Go to comment in editor");
    bindImmediateButtonAction(location, () => {
      markThreadRead(thread);
      navigateToThread(thread);
    });
    const spacer = document.createElement("span");
    spacer.className = "smarttex-comment-thread-spacer";
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "smarttex-comment-thread-action";
    collapse.innerHTML = collapseIconSvg(collapsed);
    collapse.title = collapsed ? "Expand comment" : "Minimize comment";
    collapse.setAttribute("aria-label", collapse.title);
    collapse.addEventListener("click", (event) => {
      event.stopPropagation();
      if (collapsed) collapsedThreads.delete(thread.id); else collapsedThreads.add(thread.id);
      saveLocalUi();
      renderAll();
    });
    const resolve = document.createElement("button");
    resolve.type = "button";
    resolve.className = "smarttex-comment-thread-action smarttex-comment-resolve-toggle";
    resolve.textContent = thread.resolved ? "↺" : "✓";
    resolve.title = thread.resolved ? "Reopen comment thread" : "Resolve comment thread";
    resolve.setAttribute("aria-label", resolve.title);
    resolve.setAttribute("aria-pressed", thread.resolved ? "true" : "false");
    bindImmediateButtonAction(resolve, () => toggleThreadResolved(thread.id));
    const palette = attachColorPicker(header, thread, card, "Change comment color");
    palette.button.hidden = !ownsThread(thread);
    const trash = document.createElement("button");
    trash.type = "button";
    trash.className = "smarttex-comment-thread-action smarttex-comment-thread-trash";
    trash.innerHTML = trashIconSvg();
    trash.title = "Delete comment thread";
    trash.setAttribute("aria-label", trash.title);
    bindImmediateButtonAction(trash, () => {
      confirmRemoval({
        title: "Delete comment thread?",
        message: "Delete this entire comment thread, including all replies? This action cannot be undone.",
        onConfirm: () => deleteThread(thread.id)
      });
    });
    header.append(location, spacer, resolve, collapse, palette.button, trash);
    card.appendChild(header);

    const comments = Object.values(thread.comments || {}).filter(alive).sort((a, b) => a.createdAt - b.createdAt);
    if (collapsed) {
      const first = comments[0];
      const preview = document.createElement("div");
      preview.className = "smarttex-comment-collapsed-preview";
      preview.textContent = first
        ? `${first.authorName}: ${String(first.text).split(/\r?\n/, 1)[0]}...`
        : "Comment...";
      card.appendChild(preview);
    } else {
      const body = document.createElement("div");
      body.className = "smarttex-comment-thread-body";
      for (const comment of comments) body.appendChild(renderCommentEntry(thread, comment));
      if (replyDrafts.has(thread.id)) {
        body.appendChild(renderReplyEditor(thread));
      } else {
        const reply = document.createElement("button");
        reply.type = "button";
        reply.className = "smarttex-comment-reply-button";
        reply.textContent = "Reply";
        reply.addEventListener("click", (event) => {
          event.stopPropagation();
          replyDrafts.set(thread.id, "");
          renderAll();
          requestAnimationFrame(() => pane?.querySelector(`[data-thread-id="${CSS.escape(thread.id)}"] textarea`)?.focus?.());
        });
        body.appendChild(reply);
      }
      card.appendChild(body);
    }
    card.addEventListener("click", (event) => {
      if (event.target.closest("button, textarea, input")) return;
      // Clicking a specific message marks only that message read. Clicking the
      // collapsed/thread-level card marks the whole visible thread read.
      if (!event.target.closest(".smarttex-comment-entry")) markThreadRead(thread);
      navigateToThread(thread);
    });
    return card;
  }

  function renderMark(mark) {
    const card = document.createElement("section");
    card.className = "smarttex-comment-thread smarttex-comment-mark-entry";
    card.dataset.markId = mark.id;
    card.style.setProperty("--smarttex-thread-color", validColor(mark.color));
    const unread = isMarkUnread(mark);
    card.classList.toggle("smarttex-comment-mark-unread", unread);

    const header = document.createElement("header");
    header.className = "smarttex-comment-thread-header";
    if (unread) header.appendChild(unreadDot("Unread marking"));
    const location = document.createElement("button");
    location.type = "button";
    location.className = "smarttex-comment-thread-location smarttex-comment-mark-location";
    location.innerHTML = markerIconSvg();
    location.title = "Go to marking in editor";
    location.setAttribute("aria-label", location.title);
    bindImmediateButtonAction(location, () => {
      markMarkRead(mark);
      navigateToThread(mark);
    });

    const text = document.createElement("div");
    text.className = "smarttex-comment-mark-label";
    text.innerHTML = `<strong></strong><span>marked</span>`;
    text.querySelector("strong").textContent = mark.authorName || "Anonymous";

    const spacer = document.createElement("span");
    spacer.className = "smarttex-comment-thread-spacer";
    const palette = attachColorPicker(header, mark, card, "Change marking color");
    palette.button.hidden = !isOwnActivity(mark.authorName, mark.color, mark.authorId);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "smarttex-comment-thread-action smarttex-comment-thread-trash";
    remove.innerHTML = trashIconSvg();
    remove.title = "Remove marking";
    remove.setAttribute("aria-label", remove.title);
    bindImmediateButtonAction(remove, () => {
      deleteMark(mark.id);
    });
    header.append(location, text, spacer, palette.button, remove);
    card.appendChild(header);

    card.title = "Double-click to turn this marking into a comment";
    card.addEventListener("dblclick", (event) => {
      if (event.target.closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      startCommentFromMark(mark.id);
    });
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      if (markMarkRead(mark, { refresh: false })) {
        card.classList.remove("smarttex-comment-mark-unread");
        card.querySelector(".smarttex-comments-unread-dot")?.remove?.();
        dispatchUnreadState();
      }
      navigateToThread(mark);
    });
    return card;
  }

  function renderDraftThread() {
    if (!draftThread || !fileMatches(draftThread.fileName, currentState?.fileName)) return null;
    const card = document.createElement("section");
    card.className = "smarttex-comment-thread smarttex-comment-thread-draft";
    card.dataset.smarttexDraftThread = "true";
    card.style.setProperty("--smarttex-thread-color", validColor(draftThread.color));
    const heading = document.createElement("div");
    heading.className = "smarttex-comment-draft-heading";
    const author = document.createElement("strong");
    author.textContent = profile.name || "Anonymous";
    heading.appendChild(author);
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.placeholder = "Add comment…";
    textarea.value = draftThread.draftText || "";
    textarea.__smarttexGiphyGet = () => cleanGiphyAttachment(draftThread?.giphy);
    textarea.__smarttexGiphySet = (value) => {
      if (draftThread) draftThread.giphy = cleanGiphyAttachment(value);
    };
    textarea.addEventListener("input", () => { if (draftThread) draftThread.draftText = textarea.value; });
    const actions = document.createElement("div");
    actions.className = "smarttex-comment-edit-actions";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "smarttex-comment-primary";
    ok.textContent = "OK";
    bindImmediateButtonAction(ok, commitDraftThread);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    bindImmediateButtonAction(cancel, cancelDraftThread);
    actions.append(ok, cancel);
    card.append(heading, emojiInputShell(textarea), actions);
    return card;
  }

  function startCommentAtCurrentSelection() {
    const selection = currentSelection();
    if (selection) {
      startCommentAt(selection.start, selection.end);
      return;
    }
    const cursor = Math.max(0, Number(currentState?.cursorIndex) || 0);
    startCommentAt(cursor, cursor);
  }

  function renderAddCommentControl() {
    const row = document.createElement("div");
    row.className = "smarttex-comments-add-row";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "smarttex-comments-add";
    add.textContent = "+";
    add.title = "Add comment at cursor or selection";
    add.setAttribute("aria-label", add.title);
    bindImmediateButtonAction(add, startCommentAtCurrentSelection);
    row.appendChild(add);
    return row;
  }

  function paneInteractionIsActive() {
    if (giphyPicker && !giphyPicker.hidden) return true;
    if (emojiPicker && !emojiPicker.hidden) return true;
    if (confirmationOverlay && !confirmationOverlay.hidden) return true;
    if (colorPickerOverlay && !colorPickerOverlay.hidden) return true;
    if (document.getElementById("smarttex-review-stop-overlay")) return true;
    if (document.getElementById("smarttex-giphy-consent-overlay")) return true;
    if (document.getElementById("smarttex-giphy-key-limit-overlay")) return true;

    const active = document.activeElement;
    if (!active || !pane?.contains?.(active)) return false;
    return Boolean(active.closest?.(
      'textarea, input, select, [contenteditable="true"], [role="textbox"]'
    ));
  }

  function scheduleDeferredPaneRenderFlush(delay = 0) {
    if (!paneRenderDeferred) return;
    window.clearTimeout(paneRenderFlushTimer);
    paneRenderFlushTimer = window.setTimeout(() => {
      paneRenderFlushTimer = 0;
      if (!paneRenderDeferred || !paneOpen || paneInteractionIsActive()) return;
      paneRenderDeferred = false;
      renderAll();
    }, Math.max(0, Number(delay) || 0));
  }

  function updatePaneThreadHighlights() {
    if (!pane) return;
    for (const card of pane.querySelectorAll?.(".smarttex-comment-thread[data-thread-id]") || []) {
      const threadId = String(card.dataset.threadId || "");
      card.classList.toggle(
        "smarttex-comment-thread-cursor-active",
        threadId === cursorActiveThreadId
      );
      card.classList.toggle(
        "smarttex-comment-thread-icon-active",
        threadId === iconFocusedThreadId
      );
    }
  }

  function renderPaneThreads({ preserveInteraction = false } = {}) {
    if (preserveInteraction && paneInteractionIsActive()) {
      paneRenderDeferred = true;
      updatePaneStatus();
      updatePaneThreadHighlights();
      return false;
    }
    paneRenderDeferred = false;
    if (!pane) return;
    hideReactionTooltip();
    if (emojiPicker && !emojiPicker.hidden) closeEmojiPicker({ restoreFocus: false });
    if (giphyPicker && !giphyPicker.hidden) closeGiphyPicker({ restoreFocus: false });
    const list = pane.querySelector(".smarttex-comments-list");
    if (!list) return;
    const activeElement = document.activeElement;
    const restoreDraftFocus = Boolean(activeElement?.closest?.("[data-smarttex-draft-thread]"));
    const focusedCommentId = String(activeElement?.closest?.("[data-comment-id]")?.dataset?.commentId || "");
    const focusedThreadId = String(activeElement?.closest?.("[data-thread-id]")?.dataset?.threadId || "");
    const activeWasTextarea = activeElement?.tagName === "TEXTAREA";
    const selectionStart = activeWasTextarea ? Number(activeElement.selectionStart) : null;
    const selectionEnd = activeWasTextarea ? Number(activeElement.selectionEnd) : null;
    const fragment = document.createDocumentFragment();
    const draft = renderDraftThread();
    const threads = activeThreads();
    const marks = Object.values(data.marks)
      .filter((mark) => alive(mark) && fileMatches(mark.fileName, currentState?.fileName))
      .sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
    const entries = [
      ...threads.map((thread) => ({ kind: "thread", start: thread.start, createdAt: thread.createdAt, value: thread })),
      ...marks.map((mark) => ({ kind: "mark", start: mark.start, createdAt: mark.createdAt, value: mark })),
      ...(draft ? [{ kind: "draft", start: draftThread.start, createdAt: draftThread.createdAt, value: draft }] : [])
    ].sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
    for (const entry of entries) {
      fragment.appendChild(
        entry.kind === "thread" ? renderThread(entry.value) :
          entry.kind === "mark" ? renderMark(entry.value) : entry.value
      );
    }
    fragment.appendChild(renderAddCommentControl());
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "smarttex-comments-empty";
      empty.textContent = "No comments or markings in this document.";
      fragment.appendChild(empty);
    }
    list.replaceChildren(fragment);
    const showResolved = pane.querySelector(".smarttex-comments-show-resolved");
    if (showResolved) {
      showResolved.textContent = showResolvedThreads ? "Hide resolved" : "Show resolved";
      showResolved.setAttribute("aria-pressed", showResolvedThreads ? "true" : "false");
    }
    updatePaneStatus();
    if (activeWasTextarea) {
      let replacement = null;
      if (restoreDraftFocus) {
        replacement = list.querySelector("[data-smarttex-draft-thread] textarea");
      } else if (focusedCommentId) {
        replacement = list.querySelector(`[data-comment-id="${CSS.escape(focusedCommentId)}"] textarea`);
      } else if (focusedThreadId) {
        replacement = list.querySelector(`[data-thread-id="${CSS.escape(focusedThreadId)}"] .smarttex-comment-reply-editor textarea`);
      }
      if (replacement) {
        try {
          replacement.focus({ preventScroll: true });
          if (Number.isFinite(selectionStart) && Number.isFinite(selectionEnd)) {
            const length = String(replacement.value || "").length;
            replacement.setSelectionRange(
              Math.max(0, Math.min(length, selectionStart)),
              Math.max(0, Math.min(length, selectionEnd))
            );
          }
        } catch (_error) {}
      }
    }
    return true;
  }

  function updatePaneStatus() {
    const status = pane?.querySelector(".smarttex-comments-sync-status");
    if (!status) return;
    status.textContent = syncStatus;
    status.hidden = !syncStatus;
  }

  function overlayAnchors() {
    const fileName = currentState?.fileName || "";
    const anchors = [];
    for (const mark of Object.values(data.marks)) {
      if (!alive(mark) || !fileMatches(mark.fileName, fileName)) continue;
      if (draftThread?.convertedFromMarkId === mark.id) continue;
      anchors.push({ kind: "mark", markId: mark.id, start: mark.start, end: mark.end, color: mark.color });
    }
    for (const thread of Object.values(data.threads)) {
      if (!alive(thread) || !fileMatches(thread.fileName, fileName)) continue;
      anchors.push({ kind: "thread", threadId: thread.id, start: thread.start, end: thread.end, color: thread.color });
    }
    if (draftThread && fileMatches(draftThread.fileName, fileName)) {
      anchors.push({ kind: "thread", threadId: draftThread.id, start: draftThread.start, end: draftThread.end, color: draftThread.color });
    }
    return anchors;
  }

  function renderOverlays() {
    window.dispatchEvent(new CustomEvent(OVERLAY_EVENT, {
      detail: JSON.stringify({
        anchors: overlayAnchors(),
        icons: { visible: editorIconsVisible, opacity: editorIconOpacity },
        marks: { visible: editorMarksVisible, opacity: editorMarkOpacity }
      })
    }));
  }

  function renderAll({ preserveInteraction = false } = {}) {
    renderOverlays();
    dispatchUnreadState();
    if (paneOpen) {
      renderPaneThreads({ preserveInteraction });
      scheduleSelectionPopup();
    } else {
      hideSelectionPopup();
    }
  }

  function paneBackgroundFromEditor() {
    const candidates = [
      document.querySelector("#ide-redesign-panel-source-editor .cm-editor"),
      document.querySelector("#ide-redesign-panel-source-editor .ace_editor"),
      document.querySelector("#ide-redesign-panel-source-editor"),
      document.querySelector("#ide-redesign-panel-editor .cm-editor"),
      document.querySelector("#ide-redesign-panel-editor .ace_editor"),
      document.querySelector("#ide-redesign-panel-editor"),
      document.body
    ].filter(Boolean);
    for (const element of candidates) {
      const style = getComputedStyle(element);
      const bg = String(style.backgroundColor || "");
      const match = bg.match(/^rgba?\(([^)]+)\)$/i);
      if (!match) continue;
      const values = match[1].split(",").map((v) => Number.parseFloat(v));
      const alpha = values.length > 3 ? values[3] : 1;
      if (alpha < 0.85) continue;
      const [r, g, b] = values;
      const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
      return { bg, fg: dark ? "#e7edf5" : "#172033", muted: dark ? "#aab7c8" : "#667587", dark };
    }
    return { bg: "#fff", fg: "#172033", muted: "#667587", dark: false };
  }

  function applyPaneTheme() {
    if (!pane) return;
    const theme = paneBackgroundFromEditor();
    pane.style.setProperty("--smarttex-comments-bg", theme.bg);
    pane.style.setProperty("--smarttex-comments-fg", theme.fg);
    pane.style.setProperty("--smarttex-comments-muted", theme.muted);
    pane.classList.toggle("smarttex-comments-dark", theme.dark);
    if (selectionPopup) selectionPopup.classList.toggle("smarttex-comments-dark", theme.dark);
    if (colorPickerOverlay) colorPickerOverlay.classList.toggle("smarttex-comments-dark", theme.dark);
    if (emojiPicker) emojiPicker.classList.toggle("smarttex-comments-dark", theme.dark);
    if (giphyPicker) giphyPicker.classList.toggle("smarttex-comments-dark", theme.dark);
    if (reactionTooltip) reactionTooltip.classList.toggle("smarttex-comments-dark", theme.dark);
  }

  function pdfLayoutContainer() {
    // Legacy/current CollabTeX keeps the source editor and PDF preview as the
    // center/east panes of one jQuery-layout container. This is the safest
    // place for a third, SmartTeX-owned pane because the project file tree is
    // outside this container.
    const preview = document.querySelector(
      "pdf-preview, #ide-redesign-panel-pdf, [data-testid='pdf-preview'], " +
      "[data-testid*='pdf-preview' i], .pdf-viewer"
    );
    const fromPreview = preview?.closest?.(".ui-layout-container[layout='pdf']");
    if (fromPreview) return fromPreview;

    for (const candidate of document.querySelectorAll(".ui-layout-container[layout='pdf']")) {
      if (candidate.querySelector("#editor, .ace_editor, .CodeMirror, .cm-editor, pdf-preview, .pdf-viewer")) {
        return candidate;
      }
    }
    return null;
  }

  function directLayoutChild(host, classNames) {
    if (!host) return null;
    const required = classNames.split(/\s+/).filter(Boolean);
    return Array.from(host.children || []).find((child) =>
      required.every((name) => child.classList?.contains(name))
    ) || null;
  }

  function sourceLayoutPane(host = pdfLayoutContainer()) {
    const legacy = directLayoutChild(host, "ui-layout-center ui-layout-pane-center");
    if (legacy?.querySelector?.("#editor, .ace_editor, .CodeMirror, .cm-editor")) return legacy;
    return document.querySelector("#ide-redesign-panel-source-editor, #ide-redesign-panel-editor");
  }

  function pdfLayoutPane(host = pdfLayoutContainer()) {
    const legacy = directLayoutChild(host, "ui-layout-east ui-layout-pane-east");
    if (legacy?.querySelector?.("pdf-preview, .pdf-viewer, .pdf")) return legacy;
    const preview = document.querySelector(
      "#ide-redesign-panel-pdf, [data-testid='pdf-preview'], " +
      "[data-testid*='pdf-preview' i], pdf-preview, .pdf-viewer, .pdf-pane"
    );
    return preview?.closest?.(".ui-layout-east.ui-layout-pane-east") ||
      preview?.closest?.("#ide-redesign-panel-pdf") || preview || null;
  }

  function sourceEditorPanel() {
    const host = pdfLayoutContainer();
    const layoutPane = sourceLayoutPane(host);
    if (layoutPane) return layoutPane;

    const surface = sourceEditorSurface();
    if (!surface) return null;
    return surface.closest?.("#ide-redesign-panel-source-editor, #ide-redesign-panel-editor, .editor-pane, section, main") ||
      surface.parentElement || null;
  }

  function pdfPreviewPanel() {
    return pdfLayoutPane(pdfLayoutContainer());
  }

  function sourceEditorSurface() {
    return document.querySelector(
      "#ide-redesign-panel-source-editor .cm-editor, " +
      "#ide-redesign-panel-source-editor .CodeMirror, " +
      "#ide-redesign-panel-source-editor .ace_editor, " +
      "#ide-redesign-panel-editor .cm-editor, " +
      "#ide-redesign-panel-editor .CodeMirror, " +
      "#ide-redesign-panel-editor .ace_editor, " +
      ".ide-redesign-editor-container .cm-editor, " +
      ".ide-redesign-editor-container .ace_editor, " +
      "#editor.ace_editor, #editor .ace_editor, #editor"
    );
  }

  function inlineStyleSnapshot(element, properties) {
    const snapshot = {};
    for (const property of properties) {
      snapshot[property] = {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      };
    }
    return snapshot;
  }

  function restoreInlineStyle(element, snapshot) {
    if (!element || !snapshot) return;
    for (const [property, saved] of Object.entries(snapshot)) {
      if (saved.value) element.style.setProperty(property, saved.value, saved.priority || "");
      else element.style.removeProperty(property);
    }
  }

  function releaseDockedSourcePane() {
    if (!dockedSourceLayoutPane) return;
    restoreInlineStyle(dockedSourceLayoutPane, dockedSourceInlineStyle);
    dockedSourceLayoutPane.classList.remove("smarttex-comments-source-pane-docked");
    dockedSourceLayoutPane.style.removeProperty("--smarttex-comments-source-width");
    dockedSourceLayoutPane.style.removeProperty("--smarttex-comments-dock-width");
    dockedSourceLayoutPane = null;
    dockedSourceInlineStyle = null;
  }

  function scheduleEditorResize() {
    window.clearTimeout(editorResizeTimer);
    editorResizeTimer = window.setTimeout(() => {
      editorResizeTimer = 0;
      bridgeRequest("resizeEditor", {}, 1200).catch(() => {});
    }, 0);
  }

  function bindImmediateButtonAction(button, action) {
    if (!button || typeof action !== "function") return;
    let handledAt = -Infinity;
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      handledAt = performance.now();
      action(event);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() - handledAt < 750) return;
      action(event);
    });
  }

  function closeRemovalConfirmation(confirmed = false, { runCancelAction = true } = {}) {
    if (!confirmationOverlay) return;
    const confirmAction = confirmationConfirmAction;
    const cancelAction = confirmationCancelAction;
    const restoreFocus = confirmationRestoreFocus;
    confirmationConfirmAction = null;
    confirmationCancelAction = null;
    confirmationRestoreFocus = null;
    confirmationOverlay.hidden = true;
    confirmationOverlay.setAttribute("aria-hidden", "true");
    if (confirmed && typeof confirmAction === "function") confirmAction();
    else if (!confirmed && runCancelAction && typeof cancelAction === "function") cancelAction();
    requestAnimationFrame(() => {
      try { restoreFocus?.focus?.({ preventScroll: true }); } catch (_error) {}
    });
  }

  function ensureRemovalConfirmationOverlay() {
    if (confirmationOverlay?.isConnected) return confirmationOverlay;
    const overlay = document.createElement("div");
    overlay.id = "smarttex-comments-confirm-overlay";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="smarttex-comments-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="smarttex-comments-confirm-title" aria-describedby="smarttex-comments-confirm-message">
        <h2 id="smarttex-comments-confirm-title">Delete comment?</h2>
        <p id="smarttex-comments-confirm-message"></p>
        <div class="smarttex-comments-confirm-actions">
          <button type="button" class="smarttex-comments-confirm-cancel">Cancel</button>
          <button type="button" class="smarttex-comments-confirm-delete">Delete</button>
        </div>
      </div>`;
    const dialog = overlay.querySelector(".smarttex-comments-confirm-dialog");
    const cancel = overlay.querySelector(".smarttex-comments-confirm-cancel");
    const remove = overlay.querySelector(".smarttex-comments-confirm-delete");
    cancel?.addEventListener("click", () => closeRemovalConfirmation(false, { runCancelAction: true }));
    remove?.addEventListener("click", () => closeRemovalConfirmation(true));
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) {
        event.preventDefault();
        closeRemovalConfirmation(false, { runCancelAction: false });
      }
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRemovalConfirmation(false, { runCancelAction: false });
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [cancel, remove].filter(Boolean);
      if (!focusable.length) return;
      const index = focusable.indexOf(document.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    });
    dialog?.addEventListener("pointerdown", (event) => event.stopPropagation());
    document.body.appendChild(overlay);
    confirmationOverlay = overlay;
    return overlay;
  }

  function confirmRemoval({
    title = "Delete comment?",
    message = "This action cannot be undone.",
    confirmLabel = "Delete",
    cancelLabel = "Cancel",
    danger = true,
    onConfirm,
    onCancel
  } = {}) {
    const overlay = ensureRemovalConfirmationOverlay();
    if (!overlay) return;
    confirmationRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmationConfirmAction = typeof onConfirm === "function" ? onConfirm : null;
    confirmationCancelAction = typeof onCancel === "function" ? onCancel : null;
    const titleNode = overlay.querySelector("#smarttex-comments-confirm-title");
    const messageNode = overlay.querySelector("#smarttex-comments-confirm-message");
    const cancelButton = overlay.querySelector(".smarttex-comments-confirm-cancel");
    const confirmButton = overlay.querySelector(".smarttex-comments-confirm-delete");
    if (titleNode) titleNode.textContent = String(title || "Delete comment?");
    if (messageNode) messageNode.textContent = String(message || "This action cannot be undone.");
    if (cancelButton) cancelButton.textContent = String(cancelLabel || "Cancel");
    if (confirmButton) {
      confirmButton.textContent = String(confirmLabel || "Delete");
      confirmButton.classList.toggle("smarttex-comments-confirm-danger", Boolean(danger));
      confirmButton.classList.toggle("smarttex-comments-confirm-primary", !danger);
    }
    overlay.classList.toggle("smarttex-comments-dark", Boolean(pane?.classList?.contains("smarttex-comments-dark")));
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => cancelButton?.focus());
  }

  function clearEditorDock() {
    if (dockedEditorSurface) {
      dockedEditorSurface.classList.remove("smarttex-comments-editor-docked");
      dockedEditorSurface.style.removeProperty("--smarttex-comments-dock-width");
      dockedEditorSurface = null;
    }
    if (dockedSourceLayoutPane) releaseDockedSourcePane();
    if (dockedPdfLayoutPane) {
      dockedPdfLayoutPane.classList.remove("smarttex-comments-pdf-pane-docked");
      dockedPdfLayoutPane.style.removeProperty("--smarttex-comments-pdf-width");
      dockedPdfLayoutPane = null;
    }
  }

  function elementIsVisible(element, rect = element?.getBoundingClientRect?.()) {
    if (!element || !rect || rect.width <= 1 || rect.height <= 1) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function observePaneLayout(host, pdfPanel) {
    if (typeof ResizeObserver !== "function") return;
    if (paneObservedLayoutHost === host && paneObservedPdfPanel === pdfPanel && paneLayoutResizeObserver) return;
    paneLayoutResizeObserver?.disconnect();
    paneLayoutResizeObserver = new ResizeObserver(() => schedulePaneGeometry());
    paneObservedLayoutHost = host || null;
    paneObservedPdfPanel = pdfPanel || null;
    if (host) paneLayoutResizeObserver.observe(host);
    if (pdfPanel && pdfPanel !== host) paneLayoutResizeObserver.observe(pdfPanel);
  }

  function clearPaneLayoutObserver() {
    paneLayoutResizeObserver?.disconnect();
    paneLayoutResizeObserver = null;
    paneObservedLayoutHost = null;
    paneObservedPdfPanel = null;
  }

  function applyLegacyLayoutPaneGeometry(host, sourcePane, pdfPanel) {
    if (!host || !sourcePane || !pane) return false;
    const hostRect = host.getBoundingClientRect();
    const sourceRect = sourcePane.getBoundingClientRect();
    const pdfRect = pdfPanel?.getBoundingClientRect?.();
    const sourceVisible = elementIsVisible(sourcePane, sourceRect);
    const pdfVisible = elementIsVisible(pdfPanel, pdfRect);
    if (!(hostRect.width > 0 && hostRect.height > 0) || (!sourceVisible && !pdfVisible)) return false;

    // Keep the SmartTeX pane inside the PDF layout container. The project tree
    // is a sibling of that container at the outer layout level, so changing a
    // child width here can never push the editor underneath the file tree.
    if (pane.parentElement !== host) host.appendChild(pane);
    pane.style.position = "absolute";
    pane.style.top = "0px";
    pane.style.height = "100%";
    pane.style.flex = "none";
    pane.style.zIndex = "6";

    if (sourceVisible) {
      if (dockedPdfLayoutPane) {
        dockedPdfLayoutPane.classList.remove("smarttex-comments-pdf-pane-docked");
        dockedPdfLayoutPane.style.removeProperty("--smarttex-comments-pdf-width");
        dockedPdfLayoutPane = null;
      }

      const resizer = directLayoutChild(host, "ui-layout-resizer-east");
      const resizerRect = resizer?.getBoundingClientRect?.();
      const sourceLeft = Math.max(0, sourceRect.left - hostRect.left);
      let boundary = hostRect.width;
      if (pdfVisible) {
        const resizerIsUsable = elementIsVisible(resizer, resizerRect) &&
          resizerRect.left >= hostRect.left && resizerRect.left <= hostRect.right;
        boundary = resizerIsUsable
          ? resizerRect.left - hostRect.left
          : Math.max(sourceLeft, Math.min(hostRect.width, pdfRect.left - hostRect.left));
      }

      const sourceSpan = Math.max(0, boundary - sourceLeft);
      const maxDockWidth = Math.max(220, Math.min(680, sourceSpan - 220));
      const effectiveWidth = Math.max(220, Math.min(panelWidth, maxDockWidth));
      const paneLeft = Math.max(sourceLeft, boundary - effectiveWidth);

      // Keep CollabTeX's source layout pane at its native full width. This lets
      // the formatting/symbol toolbar span the combined editor + comments area.
      // Only the actual editor surface below that toolbar gives up horizontal
      // space to the comments pane.
      pane.style.left = `${Math.round(paneLeft)}px`;
      pane.style.width = `${Math.round(effectiveWidth)}px`;
      const toolbar = sourcePane.querySelector(".toolbar.toolbar-editor, .smarttex-document-editing-toolbar");
      const toolbarRect = toolbar?.getBoundingClientRect?.();
      const paneTop = toolbarRect && toolbarRect.height > 0
        ? Math.max(0, Math.min(hostRect.height - 80, toolbarRect.bottom - hostRect.top))
        : 0;
      pane.style.top = `${Math.round(paneTop)}px`;
      pane.style.height = `${Math.max(120, Math.round(hostRect.height - paneTop))}px`;

      if (dockedSourceLayoutPane && dockedSourceLayoutPane !== sourcePane) releaseDockedSourcePane();
      dockedSourceLayoutPane = sourcePane;
      dockedSourceInlineStyle = null;
      sourcePane.classList.add("smarttex-comments-source-pane-docked");
      sourcePane.style.setProperty("--smarttex-comments-dock-width", `${Math.round(effectiveWidth)}px`);

      const editorSurface = sourceEditorSurface();
      if (dockedEditorSurface && dockedEditorSurface !== editorSurface) {
        dockedEditorSurface.classList.remove("smarttex-comments-editor-docked");
        dockedEditorSurface.style.removeProperty("--smarttex-comments-dock-width");
      }
      dockedEditorSurface = editorSurface || null;
      if (dockedEditorSurface) {
        dockedEditorSurface.classList.add("smarttex-comments-editor-docked");
        dockedEditorSurface.style.setProperty("--smarttex-comments-dock-width", `${Math.round(effectiveWidth)}px`);
      }

      scheduleEditorResize();
      observePaneLayout(host, pdfPanel);
      return true;
    }

    // PDF-only layout: use existing free space to the left of the PDF when it
    // exists. If the PDF already occupies the whole container, reduce its
    // width from the left while keeping its right edge fixed.
    if (dockedEditorSurface) {
      dockedEditorSurface.classList.remove("smarttex-comments-editor-docked");
      dockedEditorSurface.style.removeProperty("--smarttex-comments-dock-width");
      dockedEditorSurface = null;
    }
    if (dockedSourceLayoutPane) releaseDockedSourcePane();
    const pdfLeft = Math.max(0, pdfRect.left - hostRect.left);
    const maxDockWidth = Math.max(220, Math.min(680, hostRect.width - 300));
    const effectiveWidth = Math.max(220, Math.min(panelWidth, maxDockWidth));
    if (pdfLeft >= effectiveWidth) {
      pane.style.left = `${Math.round(pdfLeft - effectiveWidth)}px`;
      pane.style.width = `${Math.round(effectiveWidth)}px`;
      if (dockedPdfLayoutPane) {
        dockedPdfLayoutPane.classList.remove("smarttex-comments-pdf-pane-docked");
        dockedPdfLayoutPane.style.removeProperty("--smarttex-comments-pdf-width");
        dockedPdfLayoutPane = null;
      }
    } else {
      const shift = effectiveWidth - pdfLeft;
      const pdfWidth = Math.max(300, pdfRect.width - shift);
      pane.style.left = "0px";
      pane.style.width = `${Math.round(effectiveWidth)}px`;
      dockedPdfLayoutPane = pdfPanel;
      pdfPanel.classList.add("smarttex-comments-pdf-pane-docked");
      pdfPanel.style.setProperty("--smarttex-comments-pdf-width", `${Math.round(pdfWidth)}px`);
    }
    observePaneLayout(host, pdfPanel);
    return true;
  }

  function applyPaneGeometry() {
    paneGeometryFrame = 0;
    if (!paneOpen || !pane?.isConnected) return;

    const layoutHost = pdfLayoutContainer();
    const layoutSourcePane = sourceLayoutPane(layoutHost);
    const layoutPdfPane = pdfLayoutPane(layoutHost);
    if (layoutHost && layoutSourcePane && applyLegacyLayoutPaneGeometry(layoutHost, layoutSourcePane, layoutPdfPane)) {
      return;
    }

    // Fallback for redesigned CollabTeX variants that do not expose the
    // legacy layout=pdf container. In that case the body-mounted pane uses
    // the concrete source/PDF panel geometry.
    const editorPanel = sourceEditorPanel();
    const editorSurface = sourceEditorSurface();
    const pdfPanel = pdfPreviewPanel();
    if (!editorPanel || !editorSurface || !pdfPanel) return;
    const editorRect = editorPanel.getBoundingClientRect();
    const pdfRect = pdfPanel.getBoundingClientRect();
    if (!(editorRect.width > 0 && editorRect.height > 0 && pdfRect.width > 0)) return;
    if (pane.parentElement !== document.body) document.body.appendChild(pane);

    const rightBoundary = Math.max(editorRect.left + 220, Math.min(window.innerWidth, pdfRect.left));
    const sourceSpan = Math.max(0, rightBoundary - editorRect.left);
    const maxDockWidth = Math.max(220, Math.min(680, sourceSpan - 220));
    const effectiveWidth = Math.max(220, Math.min(panelWidth, maxDockWidth));
    const top = Math.max(0, editorRect.top);
    const bottom = Math.min(window.innerHeight, editorRect.bottom);

    pane.style.position = "fixed";
    pane.style.left = `${Math.round(rightBoundary - effectiveWidth)}px`;
    pane.style.top = `${Math.round(top)}px`;
    pane.style.width = `${Math.round(effectiveWidth)}px`;
    pane.style.height = `${Math.max(120, Math.round(bottom - top))}px`;
    pane.style.flex = "none";
    pane.style.zIndex = "2147483000";

    if (dockedSourceLayoutPane) releaseDockedSourcePane();
    if (dockedPdfLayoutPane) {
      dockedPdfLayoutPane.classList.remove("smarttex-comments-pdf-pane-docked");
      dockedPdfLayoutPane.style.removeProperty("--smarttex-comments-pdf-width");
      dockedPdfLayoutPane = null;
    }
    if (dockedEditorSurface && dockedEditorSurface !== editorSurface) clearEditorDock();
    dockedEditorSurface = editorSurface;
    editorSurface.classList.add("smarttex-comments-editor-docked");
    editorSurface.style.setProperty("--smarttex-comments-dock-width", `${Math.round(effectiveWidth)}px`);
    observePaneLayout(null, pdfPanel);
  }

  function schedulePaneGeometry() {
    if (!paneOpen) return;
    const idleDelay = Math.max(0, Number(interactionTasks?.keyboardIdleRemaining?.()) || 0);
    if (idleDelay > 0) {
      if (paneGeometryTimer) return;
      paneGeometryTimer = window.setTimeout(() => {
        paneGeometryTimer = 0;
        schedulePaneGeometry();
      }, idleDelay);
      return;
    }
    if (paneGeometryFrame || paneGeometryTimer) return;
    paneGeometryFrame = requestAnimationFrame(applyPaneGeometry);
  }

  function setPaneSettingsExpanded(expanded) {
    paneSettingsExpanded = Boolean(expanded);
    const controls = pane?.querySelector(".smarttex-comments-display-controls");
    const button = pane?.querySelector(".smarttex-comments-settings");
    if (controls) controls.hidden = !paneSettingsExpanded;
    if (button) {
      button.setAttribute("aria-expanded", paneSettingsExpanded ? "true" : "false");
      button.classList.toggle("smarttex-comments-settings-active", paneSettingsExpanded);
    }
    if (paneOpen) schedulePaneGeometry();
  }

  function dispatchReviewControl(action, extra = {}) {
    window.dispatchEvent(new CustomEvent(REVIEW_CONTROL_EVENT, { detail: { action, ...extra } }));
  }

  function reviewChangeKind(change) {
    return ({ insert: "Added", delete: "Deleted", replace: "Replaced", move: "Moved" })[change?.type] || "Changed";
  }

  function whitespaceChangeExcerpt(value) {
    const raw = String(value ?? "");
    const clean = raw.replace(/\s+/g, " ").trim();
    if (clean) return clean.length > 180 ? `${clean.slice(0, 179)}…` : clean;
    const lineBreaks = (raw.match(/\r\n|\r|\n/g) || []).length;
    if (lineBreaks) return lineBreaks === 1 ? "↵ line break" : `↵ ${lineBreaks} line breaks`;
    const tabs = (raw.match(/\t/g) || []).length;
    const spaces = raw.length - tabs;
    if (tabs && spaces) return `whitespace (${spaces} spaces, ${tabs} tabs)`;
    if (tabs) return tabs === 1 ? "tab" : `${tabs} tabs`;
    if (spaces) return spaces === 1 ? "space" : `${spaces} spaces`;
    return "";
  }

  function reviewChangeExcerpt(change) {
    if (change?.type === "replace") {
      const before = whitespaceChangeExcerpt(change.originalText);
      const after = whitespaceChangeExcerpt(change.text);
      return `${before || "∅"} → ${after || "∅"}`;
    }
    const raw = change?.type === "delete" ? change.originalText
      : change?.type === "move" ? (change.text || change.originalText)
      : change?.text;
    return whitespaceChangeExcerpt(raw);
  }

  function isDisplayableReviewChange(change) {
    if (!change || !change.id) return false;
    const start = Math.max(0, Number(change.start) || 0);
    const end = Math.max(0, Number(change.end) || 0);
    if (change.type === "insert") return String(change.text || "").length > 0 && end > start;
    if (change.type === "delete") {
      return String(change.originalText || "").length > 0 && (!change.retained || end > start);
    }
    if (change.type === "replace") return String(change.originalText || "") !== String(change.text || "");
    if (change.type === "move") {
      const fromStart = Math.max(0, Number(change.fromStart) || 0);
      const fromEnd = Math.max(0, Number(change.fromEnd) || 0);
      const toStart = Math.max(0, Number(change.toStart) || 0);
      const toEnd = Math.max(0, Number(change.toEnd) || 0);
      const sourceRangeValid = !change.retained || fromEnd > fromStart;
      return String(change.text || change.originalText || "").length > 0 &&
        toEnd > toStart && sourceRangeValid &&
        (fromStart !== toStart || fromEnd !== toEnd);
    }
    return false;
  }

  function renderTrackChangesList() {
    const list = pane?.querySelector(".smarttex-track-change-list");
    if (!list) return;
    // The review engine already prunes ineffective records. Filter again here so
    // a stale UI event can never surface a zero-length "empty change" card.
    const changes = Array.isArray(reviewUiState.changes)
      ? reviewUiState.changes.filter(isDisplayableReviewChange)
      : [];
    const fingerprint = JSON.stringify([
      reviewUiState.tracking,
      reviewUiState.markupMode,
      changes.map((change) => [change.id, change.updatedAt, change.type, change.start, change.end,
        change.fromStart, change.fromEnd, change.toStart, change.toEnd, change.text,
        change.originalText, change.authorName, change.resolved])
    ]);
    if (list === lastTrackChangesRenderList && fingerprint === lastTrackChangesRenderFingerprint) return;
    lastTrackChangesRenderList = list;
    lastTrackChangesRenderFingerprint = fingerprint;
    const count = pane.querySelector(".smarttex-track-change-count");
    if (count) count.textContent = changes.length ? String(changes.length) : "";
    for (const selector of [".smarttex-track-accept-all", ".smarttex-track-reject-all"]) {
      const button = pane.querySelector(selector);
      if (button) button.disabled = changes.length === 0;
    }
    const fragment = document.createDocumentFragment();
    if (!changes.length) {
      const empty = document.createElement("div");
      empty.className = "smarttex-track-change-empty";
      empty.textContent = reviewUiState.tracking ? "No tracked changes in this document." : "Track changes is off.";
      fragment.appendChild(empty);
    } else {
      for (const change of changes) {
        const card = document.createElement("article");
        card.className = `smarttex-track-change-card smarttex-track-change-${change.type || "replace"}`;
        card.dataset.changeId = String(change.id || "");
        card.style.setProperty("--smarttex-change-author-color", validColor(change.color, "#64748b"));
        const timestamp = new Date(change.updatedAt || change.createdAt || Date.now());
        const when = Number.isNaN(timestamp.getTime()) ? "" : timestamp.toLocaleString();
        card.innerHTML = `
          <div class="smarttex-track-change-card-heading">
            <strong></strong><span class="smarttex-track-change-author"></span><time></time>
          </div>
          <div class="smarttex-track-change-excerpt"></div>
          <div class="smarttex-track-change-move-links" hidden>
            <a href="#" data-change-location="from">from</a>
            <span aria-hidden="true">→</span>
            <a href="#" data-change-location="to">to</a>
          </div>
          <div class="smarttex-track-change-card-actions">
            <button type="button" class="smarttex-track-change-accept" title="Accept change" aria-label="Accept change">✓</button>
            <button type="button" class="smarttex-track-change-reject" title="Reject change" aria-label="Reject change">×</button>
          </div>`;
        card.querySelector("strong").textContent = reviewChangeKind(change);
        card.querySelector(".smarttex-track-change-author").textContent = String(change.author || "anonymous");
        const time = card.querySelector("time");
        time.textContent = when;
        time.dateTime = String(change.updatedAt || change.createdAt || "");
        card.querySelector(".smarttex-track-change-excerpt").textContent = reviewChangeExcerpt(change);
        const moveLinks = card.querySelector(".smarttex-track-change-move-links");
        if (moveLinks && change.type === "move") {
          moveLinks.hidden = false;
          for (const link of moveLinks.querySelectorAll("a[data-change-location]")) {
            bindImmediateButtonAction(link, () => {
              dispatchReviewControl("jump", { id: change.id, location: link.dataset.changeLocation });
            });
          }
        }
        card.addEventListener("click", (event) => {
          if (event.target.closest("button, a")) return;
          dispatchReviewControl("jump", { id: change.id });
        });
        bindImmediateButtonAction(card.querySelector(".smarttex-track-change-accept"), () => {
          dispatchReviewControl("accept", { id: change.id });
        });
        bindImmediateButtonAction(card.querySelector(".smarttex-track-change-reject"), () => {
          dispatchReviewControl("reject", { id: change.id });
        });
        fragment.appendChild(card);
      }
    }
    list.replaceChildren(fragment);
  }

  function applyReviewSectionLayout() {
    if (!pane) return;
    const track = pane.querySelector(".smarttex-track-section");
    const comments = pane.querySelector(".smarttex-comments-section");
    const trackBody = pane.querySelector(".smarttex-track-section-body");
    const commentsBody = pane.querySelector(".smarttex-comments-section-body");
    const splitter = pane.querySelector(".smarttex-review-horizontal-splitter");
    const trackToggle = pane.querySelector(".smarttex-track-section-toggle");
    const commentsToggle = pane.querySelector(".smarttex-comments-section-toggle");
    if (!track || !comments) return;
    track.classList.toggle("smarttex-review-section-collapsed", trackSectionCollapsed);
    comments.classList.toggle("smarttex-review-section-collapsed", commentsSectionCollapsed);
    if (trackBody) trackBody.hidden = trackSectionCollapsed;
    if (commentsBody) commentsBody.hidden = commentsSectionCollapsed;
    if (trackToggle) {
      trackToggle.textContent = trackSectionCollapsed ? "▸" : "▾";
      trackToggle.setAttribute("aria-expanded", trackSectionCollapsed ? "false" : "true");
      trackToggle.title = trackSectionCollapsed ? "Maximize track changes" : "Minimize track changes";
    }
    if (commentsToggle) {
      commentsToggle.textContent = commentsSectionCollapsed ? "▸" : "▾";
      commentsToggle.setAttribute("aria-expanded", commentsSectionCollapsed ? "false" : "true");
      commentsToggle.title = commentsSectionCollapsed ? "Maximize comments" : "Minimize comments";
    }
    if (!trackSectionCollapsed && !commentsSectionCollapsed) {
      track.style.flex = `${reviewSplitRatio} 1 0`;
      comments.style.flex = `${1 - reviewSplitRatio} 1 0`;
      if (splitter) splitter.hidden = false;
    } else if (!trackSectionCollapsed) {
      track.style.flex = "1 1 0";
      comments.style.flex = "0 0 auto";
      if (splitter) splitter.hidden = true;
    } else if (!commentsSectionCollapsed) {
      track.style.flex = "0 0 auto";
      comments.style.flex = "1 1 0";
      if (splitter) splitter.hidden = true;
    } else {
      track.style.flex = "0 0 auto";
      comments.style.flex = "0 0 auto";
      if (splitter) splitter.hidden = true;
    }
    if (paneOpen) schedulePaneGeometry();
  }

  function setupReviewSectionSplitter(handle) {
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      if (trackSectionCollapsed || commentsSectionCollapsed) return;
      event.preventDefault();
      reviewSplitterDragging = true;
      handle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        const sections = pane?.querySelector(".smarttex-review-sections");
        const trackHeader = pane?.querySelector(".smarttex-track-section .smarttex-review-subheader");
        const commentsHeader = pane?.querySelector(".smarttex-comments-section .smarttex-review-subheader");
        const rect = sections?.getBoundingClientRect?.();
        if (!rect || rect.height < 100) return;
        const fixed = (trackHeader?.getBoundingClientRect?.().height || 0) + (commentsHeader?.getBoundingClientRect?.().height || 0) + handle.getBoundingClientRect().height;
        const bodyHeight = Math.max(80, rect.height - fixed);
        const topBody = rect.top + (trackHeader?.getBoundingClientRect?.().height || 0);
        reviewSplitRatio = Math.max(0.2, Math.min(0.8, (moveEvent.clientY - topBody) / bodyHeight));
        applyReviewSectionLayout();
      };
      const up = () => {
        reviewSplitterDragging = false;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        saveLocalUi();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function closeStopTrackingDialog() {
    document.getElementById("smarttex-review-stop-overlay")?.remove();
  }

  function confirmStopTrackingFinal(mode) {
    const accept = mode === "accept";
    confirmRemoval({
      title: accept ? "Accept all changes?" : "Reject all changes?",
      message: accept ? "Do you really want to accept all changes?" : "Do you really want to reject all changes?",
      confirmLabel: accept ? "Yes, accept all changes" : "Yes, reject all changes",
      cancelLabel: "Cancel",
      danger: !accept,
      onConfirm: () => dispatchReviewControl(accept ? "stop-accept-all" : "stop-reject-all")
    });
  }

  function showStopTrackingDialog() {
    closeStopTrackingDialog();
    const overlay = document.createElement("div");
    overlay.id = "smarttex-review-stop-overlay";
    overlay.classList.toggle("smarttex-comments-dark", Boolean(pane?.classList?.contains("smarttex-comments-dark")));
    overlay.innerHTML = `
      <div class="smarttex-comments-confirm-dialog smarttex-review-stop-dialog" role="alertdialog" aria-modal="true">
        <h2>Stop tracking changes?</h2>
        <p>Do really want to stop tracking changes for all authors?</p>
        <div class="smarttex-comments-confirm-actions smarttex-review-stop-actions">
          <button type="button" data-stop-choice="cancel">Cancel</button>
          <button type="button" class="smarttex-review-stop-accept" data-stop-choice="accept">yes, accept all changes</button>
          <button type="button" class="smarttex-review-stop-reject" data-stop-choice="reject">yes, reject all changes</button>
        </div>
      </div>`;
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) closeStopTrackingDialog();
    });
    overlay.addEventListener("click", (event) => {
      const button = event.target.closest("[data-stop-choice]");
      if (!button) return;
      const choice = button.dataset.stopChoice;
      closeStopTrackingDialog();
      if (choice === "accept" || choice === "reject") confirmStopTrackingFinal(choice);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeStopTrackingDialog();
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.querySelector('[data-stop-choice="cancel"]')?.focus());
  }

  function attachPane() {
    const layoutHost = pdfLayoutContainer();
    const host = layoutHost || document.body;
    if (pane?.isConnected) {
      if (host && pane.parentElement !== host) host.appendChild(pane);
      schedulePaneGeometry();
      return pane;
    }
    if (!host || !sourceEditorPanel()) return null;
    pane = document.createElement("aside");
    pane.id = "smarttex-comments-pane";
    pane.style.width = `${panelWidth}px`;
    pane.innerHTML = `
      <div class="smarttex-comments-resizer" role="separator" aria-orientation="vertical" title="Drag to resize review pane"></div>
      <header class="smarttex-review-pane-titlebar">
        <strong>Review &amp; comments</strong>
        <span class="smarttex-comments-sync-status" hidden></span>
        <button type="button" class="smarttex-comments-close" title="Close review and comments" aria-label="Close review and comments">×</button>
      </header>
      <div class="smarttex-review-sections">
        <section class="smarttex-review-section smarttex-track-section">
          <header class="smarttex-review-subheader">
            <button type="button" class="smarttex-review-section-toggle smarttex-track-section-toggle" aria-expanded="true" title="Minimize track changes" aria-label="Minimize track changes">▾</button>
            <strong>track changes (beta)</strong>
            <span class="smarttex-track-change-count"></span>
          </header>
          <div class="smarttex-review-section-body smarttex-track-section-body">
            <div class="smarttex-comments-track-row">
              <button type="button" class="smarttex-comments-track-toggle" role="switch" aria-checked="false" title="Track changes for all collaborators">
                <span class="smarttex-comments-track-switch" aria-hidden="true"><span></span></span>
                <span>track changes</span>
              </button>
              <select class="smarttex-comments-track-view" aria-label="Tracked changes display mode" hidden>
                <option value="final">show final</option>
                <option value="markup" selected>show markup</option>
                <option value="original">show original</option>
              </select>
              <button type="button" class="smarttex-track-accept-all" title="Accept all changes" aria-label="Accept all changes">✓</button>
              <button type="button" class="smarttex-track-reject-all" title="Reject all changes" aria-label="Reject all changes">×</button>
            </div>
            <div class="smarttex-track-change-list"></div>
          </div>
        </section>
        <div class="smarttex-review-horizontal-splitter" role="separator" aria-orientation="horizontal" title="Drag to resize track changes and comments"></div>
        <section class="smarttex-review-section smarttex-comments-section">
          <header class="smarttex-review-subheader smarttex-comments-header">
            <button type="button" class="smarttex-review-section-toggle smarttex-comments-section-toggle" aria-expanded="true" title="Minimize comments" aria-label="Minimize comments">▾</button>
            <strong>comments</strong>
            <button type="button" class="smarttex-comments-settings" title="Comment display settings" aria-label="Comment display settings" aria-expanded="false">${settingsIconSvg()}</button>
          </header>
          <div class="smarttex-review-section-body smarttex-comments-section-body">
            <div class="smarttex-comments-display-controls" hidden>
              <div class="smarttex-comments-control-row">
                <button type="button" class="smarttex-comments-icons-toggle" aria-pressed="true" title="Hide editor comment and marker icons">Icons on</button>
                <label class="smarttex-comments-opacity-label">
                  <span>Opacity</span>
                  <input type="range" class="smarttex-comments-opacity" min="0.15" max="1" step="0.05" value="1" aria-label="Editor comment and marker icon opacity">
                </label>
              </div>
              <div class="smarttex-comments-control-row">
                <button type="button" class="smarttex-comments-marks-toggle" aria-pressed="true" title="Hide marked-text highlights">Marks on</button>
                <label class="smarttex-comments-opacity-label">
                  <span>Opacity</span>
                  <input type="range" class="smarttex-comments-mark-opacity" min="0.05" max="1" step="0.05" value="0.30" aria-label="Marked-text opacity">
                </label>
              </div>
            </div>
            <div class="smarttex-comments-list"></div>
            <footer class="smarttex-comments-footer">
              <button type="button" class="smarttex-comments-minimize-all">Minimize all comments</button>
              <button type="button" class="smarttex-comments-show-resolved" aria-pressed="false">Show resolved</button>
            </footer>
          </div>
        </section>
      </div>`;
    host.appendChild(pane);
    applyPaneTheme();

    const trackToggle = pane.querySelector(".smarttex-comments-track-toggle");
    const trackView = pane.querySelector(".smarttex-comments-track-view");
    const runtimeReviewState = globalThis.__smartTeXReviewState;
    if (runtimeReviewState && typeof runtimeReviewState === "object") {
      reviewUiState = {
        tracking: Boolean(runtimeReviewState.tracking),
        markupMode: ["final", "markup", "original"].includes(runtimeReviewState.markupMode)
          ? runtimeReviewState.markupMode
          : "markup",
        totalChangeCount: Math.max(0, Number(runtimeReviewState.totalChangeCount) || 0),
        changes: Array.isArray(runtimeReviewState.changes) ? runtimeReviewState.changes : []
      };
    }
    const updateReviewControls = () => {
      const tracking = Boolean(reviewUiState.tracking);
      if (trackToggle) {
        trackToggle.setAttribute("aria-checked", tracking ? "true" : "false");
        trackToggle.classList.toggle("smarttex-comments-track-enabled", tracking);
      }
      if (trackView) {
        trackView.hidden = !tracking;
        trackView.value = ["final", "markup", "original"].includes(reviewUiState.markupMode)
          ? reviewUiState.markupMode
          : "markup";
      }
    };
    bindImmediateButtonAction(trackToggle, () => {
      if (!reviewUiState.tracking) {
        dispatchReviewControl("toggle");
        return;
      }
      // Ask the review engine to decide against its authoritative current
      // state. This avoids stale pane entries causing a confirmation dialog
      // after the final change has already been accepted/rejected/undone.
      dispatchReviewControl("request-stop");
    });
    trackView?.addEventListener("change", () => {
      dispatchReviewControl("markup", { value: trackView.value });
    });
    bindImmediateButtonAction(pane.querySelector(".smarttex-track-accept-all"), () => dispatchReviewControl("accept-all"));
    bindImmediateButtonAction(pane.querySelector(".smarttex-track-reject-all"), () => dispatchReviewControl("reject-all"));
    pane.querySelector(".smarttex-track-section-toggle")?.addEventListener("click", () => {
      trackSectionCollapsed = !trackSectionCollapsed;
      applyReviewSectionLayout();
      saveLocalUi();
    });
    pane.querySelector(".smarttex-comments-section-toggle")?.addEventListener("click", () => {
      commentsSectionCollapsed = !commentsSectionCollapsed;
      applyReviewSectionLayout();
      saveLocalUi();
    });
    setupReviewSectionSplitter(pane.querySelector(".smarttex-review-horizontal-splitter"));
    updateReviewControls();
    renderTrackChangesList();
    applyReviewSectionLayout();

    pane.querySelector(".smarttex-comments-close")?.addEventListener("click", closePane);
    const settingsButton = pane.querySelector(".smarttex-comments-settings");
    bindImmediateButtonAction(settingsButton, () => setPaneSettingsExpanded(!paneSettingsExpanded));
    setPaneSettingsExpanded(false);

    const iconsToggle = pane.querySelector(".smarttex-comments-icons-toggle");
    const opacitySlider = pane.querySelector(".smarttex-comments-opacity");
    const marksToggle = pane.querySelector(".smarttex-comments-marks-toggle");
    const markOpacitySlider = pane.querySelector(".smarttex-comments-mark-opacity");
    const updateIconControls = () => {
      if (iconsToggle) {
        iconsToggle.setAttribute("aria-pressed", editorIconsVisible ? "true" : "false");
        iconsToggle.textContent = editorIconsVisible ? "Icons on" : "Icons off";
        iconsToggle.title = editorIconsVisible ? "Hide editor comment and marker icons" : "Show editor comment and marker icons";
      }
      if (opacitySlider) {
        opacitySlider.value = String(editorIconOpacity);
        opacitySlider.disabled = !editorIconsVisible;
      }
      if (marksToggle) {
        marksToggle.setAttribute("aria-pressed", editorMarksVisible ? "true" : "false");
        marksToggle.textContent = editorMarksVisible ? "Marks on" : "Marks off";
        marksToggle.title = editorMarksVisible ? "Hide marked-text highlights" : "Show marked-text highlights";
      }
      if (markOpacitySlider) {
        markOpacitySlider.value = String(editorMarkOpacity);
        markOpacitySlider.disabled = !editorMarksVisible;
      }
    };
    updateIconControls();
    iconsToggle?.addEventListener("click", (event) => {
      event.preventDefault();
      editorIconsVisible = !editorIconsVisible;
      updateIconControls();
      saveLocalUi();
      renderOverlays();
    });
    opacitySlider?.addEventListener("input", () => {
      editorIconOpacity = Math.max(0.15, Math.min(1, Number(opacitySlider.value) || 1));
      renderOverlays();
    });
    opacitySlider?.addEventListener("change", () => saveLocalUi());
    marksToggle?.addEventListener("click", (event) => {
      event.preventDefault();
      editorMarksVisible = !editorMarksVisible;
      updateIconControls();
      saveLocalUi();
      renderOverlays();
    });
    markOpacitySlider?.addEventListener("input", () => {
      editorMarkOpacity = Math.max(0.05, Math.min(1, Number(markOpacitySlider.value) || 0.30));
      renderOverlays();
    });
    markOpacitySlider?.addEventListener("change", () => saveLocalUi());
    pane.querySelector(".smarttex-comments-minimize-all")?.addEventListener("click", () => {
      for (const thread of activeThreads()) collapsedThreads.add(thread.id);
      saveLocalUi();
      renderAll();
    });
    pane.querySelector(".smarttex-comments-show-resolved")?.addEventListener("click", () => {
      showResolvedThreads = !showResolvedThreads;
      saveLocalUi();
      renderAll();
    });
    setupPaneResize(pane.querySelector(".smarttex-comments-resizer"));
    return pane;
  }

  function setupPaneResize(handle) {
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = pane?.getBoundingClientRect().width || panelWidth;
      handle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        // The pane is pinned to the PDF boundary, therefore dragging its left
        // edge to the left increases its width.
        panelWidth = Math.max(220, Math.min(680, startWidth + (startX - moveEvent.clientX)));
        applyPaneGeometry();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        saveLocalUi();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function openPane() {
    // Mark open before geometry is scheduled: attachPane() may request a frame.
    paneOpen = true;
    const element = attachPane();
    if (!element) {
      paneOpen = false;
      return;
    }

    // Apply the automatic collapsed state only when the pane itself is opened.
    // Turning tracking off while the pane is already open must not collapse the
    // section underneath the user's pointer. If review.js has not published its
    // initial state yet, defer this one-time open decision until the first state
    // event arrives.
    const runtimeReviewState = globalThis.__smartTeXReviewState;
    paneAwaitingInitialReviewState = !(runtimeReviewState && typeof runtimeReviewState === "object");
    if (!paneAwaitingInitialReviewState && !runtimeReviewState.tracking) {
      trackSectionCollapsed = true;
      applyReviewSectionLayout();
    }

    setPaneSettingsExpanded(false);
    element.hidden = false;
    applyPaneTheme();
    applyPaneGeometry();
    renderAll();
    if (cursorActiveThreadId) {
      requestAnimationFrame(() => scrollThreadIntoView(cursorActiveThreadId));
    }
    window.dispatchEvent(new CustomEvent(PANE_STATE_EVENT, { detail: { open: true } }));
  }

  function finishClosePane({ markAllRead = false } = {}) {
    if (markAllRead) markCurrentFileRead({ refresh: false });
    paneOpen = false;
    paneRenderDeferred = false;
    window.clearTimeout(paneRenderFlushTimer);
    paneRenderFlushTimer = 0;
    closeEmojiPicker({ restoreFocus: false });
    closeGiphyPicker({ restoreFocus: false });
    hideReactionTooltip();
    paneAwaitingInitialReviewState = false;
    if (pane) pane.hidden = true;
    if (paneGeometryFrame) {
      cancelAnimationFrame(paneGeometryFrame);
      paneGeometryFrame = 0;
    }
    clearEditorDock();
    if (editorResizeTimer) {
      window.clearTimeout(editorResizeTimer);
      editorResizeTimer = 0;
    }
    scheduleEditorResize();
    clearPaneLayoutObserver();
    hideSelectionPopup();
    dispatchUnreadState();
    window.dispatchEvent(new CustomEvent(PANE_STATE_EVENT, { detail: { open: false } }));
  }

  function closePane() {
    const unreadCount = currentFileUnreadCount();
    if (unreadCount <= 0) {
      finishClosePane();
      return;
    }
    confirmRemoval({
      title: "Mark unread activity as read?",
      message: unreadCount === 1
        ? "There is 1 unread comment, reply, or marking in this document. Mark it as read before closing the Comments pane?"
        : `There are ${unreadCount} unread comments, replies, or markings in this document. Mark them all as read before closing the Comments pane?`,
      confirmLabel: "Mark all read",
      cancelLabel: "Keep unread",
      danger: false,
      onConfirm: () => finishClosePane({ markAllRead: true }),
      onCancel: () => finishClosePane({ markAllRead: false })
    });
  }

  function togglePane() {
    if (paneOpen) closePane(); else openPane();
  }

  function ensureSelectionPopup() {
    if (selectionPopup?.isConnected) return selectionPopup;
    selectionPopup = document.createElement("div");
    selectionPopup.id = "smarttex-comment-selection-popup";
    const comment = document.createElement("button");
    comment.type = "button";
    comment.title = "Comment on selection";
    comment.setAttribute("aria-label", comment.title);
    comment.innerHTML = commentIconSvg();
    const marker = document.createElement("button");
    marker.type = "button";
    marker.title = "Toggle marker highlight";
    marker.setAttribute("aria-label", marker.title);
    marker.innerHTML = markerIconSvg();
    selectionPopup.append(comment, marker);
    selectionPopup.addEventListener("pointerdown", (event) => event.preventDefault());
    comment.addEventListener("click", () => {
      const selection = currentSelection();
      hideSelectionPopup();
      if (selection) startCommentAt(selection.start, selection.end);
    });
    marker.addEventListener("click", () => {
      const selection = currentSelection();
      hideSelectionPopup();
      if (selection) toggleMark(selection.start, selection.end);
    });
    document.documentElement.appendChild(selectionPopup);
    selectionPopup.classList.toggle("smarttex-comments-dark", Boolean(pane?.classList?.contains("smarttex-comments-dark")));
    return selectionPopup;
  }

  function hideSelectionPopup() {
    if (selectionPopup) selectionPopup.hidden = true;
  }

  window.addEventListener("smarttex:editor-scroll-state", (event) => {
    if (event?.detail?.active === true) hideSelectionPopup();
  });

  function scheduleSelectionPopup() {
    const revision = ++selectionPopupRevision;
    const selection = currentSelection();
    if (!paneOpen || !selection || !currentState?.focused || selectionOverlapsExistingAnchor(selection)) {
      hideSelectionPopup();
      return;
    }
    bridgeRequest("getCoordinates", { index: selection.end }, 2500).then((response) => {
      const liveSelection = currentSelection();
      if (revision !== selectionPopupRevision || !paneOpen || !liveSelection || selectionOverlapsExistingAnchor(liveSelection)) return;
      const screen = response?.screen;
      if (!screen) return;
      const popup = ensureSelectionPopup();
      popup.hidden = false;
      const width = 70;
      const left = Math.max(6, Math.min(window.innerWidth - width - 6, Number(screen.pageX) - window.scrollX + 4));
      const top = Math.max(6, Number(screen.pageY) - window.scrollY - 34);
      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
    }).catch(() => hideSelectionPopup());
  }

  function rangesOverlap(selection, record) {
    if (!selection || !record) return false;
    const aStart = Math.max(0, Number(selection.start) || 0);
    const aEnd = Math.max(aStart, Number(selection.end) || aStart);
    const bStart = Math.max(0, Number(record.start) || 0);
    const bEnd = Math.max(bStart, Number(record.end) || bStart);
    if (bEnd === bStart) return bStart >= aStart && bStart <= aEnd;
    return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
  }

  function selectionOverlapsExistingAnchor(selection) {
    const fileName = currentState?.fileName || "";
    for (const mark of Object.values(data.marks)) {
      if (alive(mark) && fileMatches(mark.fileName, fileName) && rangesOverlap(selection, mark)) return true;
    }
    for (const thread of Object.values(data.threads)) {
      if (alive(thread) && fileMatches(thread.fileName, fileName) && rangesOverlap(selection, thread)) return true;
    }
    return Boolean(draftThread && fileMatches(draftThread.fileName, fileName) && rangesOverlap(selection, draftThread));
  }

  function cursorIndexFromState(state = currentState) {
    const direct = Number(state?.cursorIndex);
    if (Number.isFinite(direct)) return Math.max(0, direct);
    const head = Number(state?.selectionHead);
    if (Number.isFinite(head)) return Math.max(0, head);
    const anchor = Number(state?.selectionAnchor);
    return Number.isFinite(anchor) ? Math.max(0, anchor) : 0;
  }

  function threadAtCurrentCursor() {
    const fileName = currentState?.fileName || "";
    const cursor = cursorIndexFromState();
    const ranged = activeThreads().filter((thread) => (
      fileMatches(thread.fileName, fileName) && thread.end > thread.start
    ));
    // Prefer a true in-range hit. If none exists, a caret exactly one boundary
    // position behind a commented range still belongs visually to that range.
    // This keeps the pane highlight stable while the caret sits just after the
    // marked text without stealing the boundary from a following comment.
    return ranged.find((thread) => cursor >= thread.start && cursor < thread.end) ||
      ranged.find((thread) => cursor === thread.end) || null;
  }

  function updateCursorThreadFocus() {
    const next = threadAtCurrentCursor()?.id || "";
    const changed = next !== cursorActiveThreadId;
    cursorActiveThreadId = next;
    return { changed, threadId: next };
  }

  function focusThreadFromIcon(threadId) {
    window.clearTimeout(iconFocusedThreadTimer);
    iconFocusedThreadId = String(threadId || "");
    if (paneOpen) updatePaneThreadHighlights();
    iconFocusedThreadTimer = window.setTimeout(() => {
      iconFocusedThreadTimer = 0;
      if (iconFocusedThreadId !== threadId) return;
      iconFocusedThreadId = "";
      if (paneOpen) updatePaneThreadHighlights();
    }, 1600);
  }

  function scrollThreadIntoView(threadId) {
    if (!pane) return;
    const element = pane.querySelector(`[data-thread-id="${CSS.escape(String(threadId))}"]`);
    element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    element?.classList?.add("smarttex-comment-thread-target");
    setTimeout(() => element?.classList?.remove("smarttex-comment-thread-target"), 900);
  }

  async function navigateToThread(thread) {
    if (!thread) return;
    if (!fileMatches(thread.fileName, currentState?.fileName)) {
      pendingNavigation = { fileName: thread.fileName, start: thread.start, end: thread.end };
      try { await bridgeRequest("openProjectFile", { path: thread.fileName }, 7000); } catch (_error) { pendingNavigation = null; }
      return;
    }
    const head = thread.end > thread.start ? thread.end : thread.start;
    await bridgeRequest("setSelection", { anchor: thread.start, head, focus: true }).catch(() => {});
  }

  let lastToggleEvent = null;
  const handleToggleEvent = (event) => {
    if (event === lastToggleEvent) return;
    lastToggleEvent = event;
    togglePane();
    queueMicrotask(() => { if (lastToggleEvent === event) lastToggleEvent = null; });
  };
  window.addEventListener(TOGGLE_EVENT, handleToggleEvent);
  document.addEventListener(TOGGLE_EVENT, handleToggleEvent);
  window.addEventListener(ANCHOR_EVENT, (event) => {
    let detail = {};
    try { detail = JSON.parse(String(event.detail || "{}")); } catch (_error) { return; }
    const markId = String(detail.markId || "");
    if (markId) {
      const mark = activeMarkById(markId);
      if (!mark) return;
      if (detail.action === "toggle-mark") {
        deleteMark(markId);
        return;
      }
      if (detail.action === "convert-to-comment") {
        startCommentFromMark(markId);
        return;
      }
      openPane();
      renderPaneThreads();
      requestAnimationFrame(() => {
        const element = pane?.querySelector(`[data-mark-id="${CSS.escape(markId)}"]`);
        element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      });
      return;
    }
    const threadId = String(detail.threadId || "");
    if (!threadId || !alive(data.threads[threadId])) return;
    // Explicit icon activation is the action that opens a closed pane. Cursor
    // movement inside the commented text never calls openPane().
    focusThreadFromIcon(threadId);
    markThreadRead(data.threads[threadId], { refresh: false });
    openPane();
    renderPaneThreads();
    requestAnimationFrame(() => scrollThreadIntoView(threadId));
  });

  // If a background refresh was deferred while the user was typing or using a
  // chooser, apply it only after focus has genuinely left all protected UI.
  // setTimeout lets focus move between textarea -> GIF button -> picker without
  // creating a destructive refresh in the middle of that transition.
  document.addEventListener("focusout", () => {
    scheduleDeferredPaneRenderFlush();
  }, true);

  window.addEventListener(STATE_EVENT, (event) => {
    let state = null;
    try {
      state = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) { return; }
    if (!state) return;
    const previousFileName = String(currentState?.fileName || "");
    const fileChanged = Boolean(previousFileName) && !fileMatches(previousFileName, state.fileName);
    if (fileChanged) flushPendingSourceChange();
    const sourceChanged = !currentState || fileChanged || String(currentState.value || "") !== String(state.value || "");
    currentState = state;
    if (sourceChanged) scheduleEditorSourceChange(state);
    maybeAutoOpenForCurrentDocument();
    const cursorFocus = updateCursorThreadFocus();
    if (pendingNavigation && fileMatches(pendingNavigation.fileName, state.fileName)) {
      const navigation = pendingNavigation;
      pendingNavigation = null;
      setTimeout(() => {
        bridgeRequest("setSelection", {
          anchor: navigation.start,
          head: navigation.end > navigation.start ? navigation.end : navigation.start,
          focus: true
        }).catch(() => {});
      }, 120);
    }

    if (fileChanged) {
      // A document switch needs a new list, but even this is deferred while a
      // modal/comment interaction is active so focus is never stolen mid-action.
      renderAll({ preserveInteraction: true });
    } else {
      // Editor cursor/selection events are very frequent. They only need
      // overlays, selection UI and the active-thread class; rebuilding the
      // complete comments DOM here was the main source of random focus loss.
      renderOverlays();
      dispatchUnreadState();
      updatePaneThreadHighlights();
      if (paneOpen) scheduleSelectionPopup();
      else hideSelectionPopup();
    }
    if (paneOpen && cursorFocus.threadId && cursorFocus.changed) {
      requestAnimationFrame(() => scrollThreadIntoView(cursorFocus.threadId));
    }
  });

  window.addEventListener(REVIEW_STOP_CONFIRM_EVENT, () => {
    if (!reviewUiState.tracking) return;
    showStopTrackingDialog();
  });

  window.addEventListener(REVIEW_STATE_EVENT, (event) => {
    const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
    reviewUiState = {
      tracking: Boolean(detail.tracking),
      markupMode: ["final", "markup", "original"].includes(detail.markupMode) ? detail.markupMode : "markup",
      totalChangeCount: Math.max(0, Number(detail.totalChangeCount) || 0),
      changes: Array.isArray(detail.changes) ? detail.changes : []
    };
    const trackToggle = pane?.querySelector(".smarttex-comments-track-toggle");
    const trackView = pane?.querySelector(".smarttex-comments-track-view");
    if (trackToggle) {
      trackToggle.setAttribute("aria-checked", reviewUiState.tracking ? "true" : "false");
      trackToggle.classList.toggle("smarttex-comments-track-enabled", reviewUiState.tracking);
    }
    if (trackView) {
      trackView.hidden = !reviewUiState.tracking;
      trackView.value = reviewUiState.markupMode;
    }
    renderTrackChangesList();

    // If the pane was opened before review.js published its initial state,
    // perform the open-time collapse decision exactly once here. Later state
    // changes (including toggling tracking off) preserve the user's current
    // expanded/collapsed layout.
    if (paneOpen && paneAwaitingInitialReviewState) {
      paneAwaitingInitialReviewState = false;
      if (!reviewUiState.tracking && !trackSectionCollapsed) {
        trackSectionCollapsed = true;
        applyReviewSectionLayout();
      }
    }

    maybeAutoOpenForCurrentDocument();
    if (paneOpen) schedulePaneGeometry();
  });

  window.addEventListener(ADD_RANGE_COMMENT_EVENT, (event) => {
    const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
    if (!currentState?.fileName) return;
    if (detail.fileName && !fileMatches(detail.fileName, currentState.fileName)) return;
    const start = Math.max(0, Number(detail.start) || 0);
    const end = Math.max(start, Number(detail.end) || start);
    startCommentAt(start, end);
  });

  window.addEventListener(COLLABORATION_SIGNAL_EVENT, (event) => {
    let detail = {};
    try { detail = JSON.parse(String(event.detail || "{}")); } catch (_error) { return; }
    if (detail.kind === "comments-live") {
      const remote = normalizeData(detail.payload?.data);
      const merged = mergeData(data, remote);
      const localChanged = !sameDataRecords(merged, data);
      const correction = realtimeCorrectionForIncoming(remote, merged);
      const incomingNeedsCorrection = !sameDataRecords(correction, remote);
      if (localChanged) {
        data = merged;
        renderAll({ preserveInteraction: true });
        if (initialSyncComplete) maybeAutoOpenForCurrentDocument();
      }
      if (incomingNeedsCorrection) {
        // A peer may have sent a full thread from a stale local snapshot while
        // changing a different reaction. Re-broadcast and persist the merged
        // record so newer per-actor reaction tombstones cannot be overwritten.
        markDirty(250, correction);
      }
      return;
    }
    if (detail.kind !== "comments") return;
    // The realtime packet is only an invalidation hint. The mergeable project
    // file remains authoritative. A pair of short retries covers the host file
    // tree's delete/re-upload propagation window without continuous reads.
    for (const delay of [0, 500, 1500]) {
      window.setTimeout(() => syncFromProject({
        force: true,
        fileId: String(detail.fileId || ""),
        entityType: String(detail.entityType || "")
      }).catch(() => {}), delay);
    }
  });

  window.addEventListener(COLLABORATION_PRESENCE_EVENT, (event) => {
    let detail = {};
    try { detail = JSON.parse(String(event.detail || "{}")); } catch (_error) { return; }
    if (detail.disconnected) return;
    if (applyCommentsAuthorProfile(String(detail.authorId || ""), {
      name: detail.name,
      color: detail.color
    })) renderAll({ preserveInteraction: true });
  });

  window.addEventListener(
    globalThis.SmartTeXGiphyIntegration?.CONSENT_CHANGED_EVENT || "smarttex:giphy-consent-changed",
    () => {
      Promise.resolve(globalThis.SmartTeXGiphyIntegration?.hasConsent?.()).then((accepted) => {
        if (accepted) {
          // Do not re-render the comment pane here. In the add-GIF flow this event
          // fires while openGiphyPicker() is awaiting consent; a full render would
          // replace the clicked button/textarea and make the first activation fail.
          suppressGiphyAutoPrompt = false;
          return;
        }
        closeGiphyPicker({ restoreFocus: false });
        suppressGiphyAutoPrompt = true;
        if (paneOpen) renderAll();
        suppressGiphyAutoPrompt = false;
      }).catch(() => { suppressGiphyAutoPrompt = false; });
    }
  );

  extensionApi?.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local" || !changes[PROFILE_KEY]) return;
    const previousProfile = profile;
    profile = normalizeProfile(changes[PROFILE_KEY].newValue, profile);
    if (!globalThis.SmartTeXCommentProfile?.isFallbackProfile?.(profile)) {
      globalThis.SmartTeXCommentProfile?.dismissFallbackNotice?.();
    }
    if (draftThread) draftThread.color = profile.color;
    window.dispatchEvent(new CustomEvent(COLLABORATION_PROFILE_EVENT, {
      detail: JSON.stringify({ name: profile.name, color: profile.color, authorId })
    }));
    if (applyCommentsAuthorProfile(authorId, profile, previousProfile)) markDirty(250);
    else renderAll({ preserveInteraction: true });
  });

  const themeObserver = new MutationObserver(() => {
    if (paneOpen) applyPaneTheme();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });

  let paneReattachFrame = 0;
  const layoutObserver = new MutationObserver((mutations) => {
    if (!paneOpen) return;
    const editorSelector = ".ace_editor, .cm-editor, #ide-redesign-panel-source-editor";
    if (mutations.every((mutation) => (
      mutation.target instanceof Element && mutation.target.closest(editorSelector)
    ))) return;
    if (!pane?.isConnected && !paneReattachFrame) {
      paneReattachFrame = requestAnimationFrame(() => {
        paneReattachFrame = 0;
        pane = null;
        const restored = attachPane();
        if (!restored) return;
        restored.hidden = false;
        applyPaneGeometry();
        renderAll();
      });
      return;
    }
    schedulePaneGeometry();
  });
  if (document.body) layoutObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("resize", () => {
    if (paneOpen) {
      applyPaneTheme();
      schedulePaneGeometry();
      scheduleSelectionPopup();
    }
  }, { passive: true });

  window.addEventListener("pagehide", () => {
    clearInterval(syncTimer);
    clearTimeout(writeTimer);
    window.clearTimeout(paneRenderFlushTimer);
    paneRenderFlushTimer = 0;
    flushPendingSourceChange();
    themeObserver.disconnect();
    layoutObserver.disconnect();
    if (paneReattachFrame) cancelAnimationFrame(paneReattachFrame);
    if (paneGeometryFrame) cancelAnimationFrame(paneGeometryFrame);
    window.clearTimeout(paneGeometryTimer);
    clearEditorDock();
    clearPaneLayoutObserver();
    hideSelectionPopup();
    confirmationConfirmAction = null;
    confirmationRestoreFocus = null;
    window.clearTimeout(iconFocusedThreadTimer);
    iconFocusedThreadTimer = 0;
    confirmationOverlay?.remove?.();
    confirmationOverlay = null;
    closeStopTrackingDialog();
    colorPickerOverlay?.remove?.();
    colorPickerOverlay = null;
    colorPickerTarget = null;
    emojiPicker?.remove?.();
    emojiPicker = null;
    emojiPickerTarget = null;
    emojiPickerRestoreFocus = null;
    giphySearchController?.abort?.();
    giphySearchController = null;
    giphyResultObserver?.disconnect?.();
    giphyResultObserver = null;
    window.clearTimeout(giphySearchTimer);
    giphySearchTimer = 0;
    giphyPicker?.remove?.();
    giphyPicker = null;
    giphyPickerTarget = null;
    giphyPickerRestoreFocus = null;
    reactionTooltip?.remove?.();
    reactionTooltip = null;
    reactionTooltipOwner = null;
    if (lastSavedRevision !== mutationRevision) flushProjectData();
  }, { once: true });

  dispatchInitializationState(true);
  (async () => {
    try {
      await loadLocalUi();
      await loadPendingDataSnapshot();
      await ensureAuthorId();
      profile = normalizeProfile(await globalThis.SmartTeXCommentProfile?.ensure?.(extensionApi?.storage?.local), profile);
      window.dispatchEvent(new CustomEvent(COLLABORATION_PROFILE_EVENT, {
        detail: JSON.stringify({ name: profile.name, color: profile.color, authorId })
      }));
      try {
        const response = await bridgeRequest("getState", {}, 4000);
        if (response?.state) {
          currentState = response.state;
          lastSources.set(String(currentState.fileName || ""), String(currentState.value || ""));
        }
      } catch (_error) {}

      // During a page reload CollabTeX can expose the editor before its project
      // file model is ready. Retry the initial metadata hydration quickly so an
      // early empty/missing response never leaves existing comments or marks
      // absent until the normal 20-second collaboration poll.
      let hydrated = false;
      for (let attempt = 0; attempt < 6 && !hydrated; attempt += 1) {
        hydrated = await syncFromProject({ force: true });
        if (!hydrated) await new Promise((resolve) => window.setTimeout(resolve, 250 + attempt * 150));
      }
      if (!unreadTrackingInitialized) markAllExistingActivityReadAsBaseline();
      initialSyncComplete = true;
      initialSyncCompletedAt = now();
      maybeAutoOpenForCurrentDocument();
      scheduleSyncLoop();
      renderAll();

      // A locally cached unsaved mutation (for example a reload immediately
      // after editing a comment) is pushed back to the collaborative metadata
      // file as soon as the project model becomes writable.
      if (mutationRevision > lastSavedRevision) markDirty(500);
    } finally {
      dispatchInitializationState(false);
    }
  })().catch((error) => {
    console.warn("SmartTeX comments initialization failed:", error);
  });
})();
