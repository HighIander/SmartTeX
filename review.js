/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;
  if (window.top !== window || globalThis.__smartTeXReviewLoaded) return;
  globalThis.__smartTeXReviewLoaded = true;

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const STATE_EVENT = "smarttex:editor-state";
  const REQUEST_EVENT = "smarttex:citation-editor-request";
  const RESPONSE_EVENT = "smarttex:citation-editor-response";
  const REVIEW_TOGGLE_EVENT = "smarttex:review-toggle";
  const REVIEW_STATE_EVENT = "smarttex:review-state";
  const REVIEW_CONTROL_EVENT = "smarttex:review-control";
  const REVIEW_STOP_CONFIRM_EVENT = "smarttex:review-stop-confirm-needed";
  const ADD_RANGE_COMMENT_EVENT = "smarttex:comments-add-range";
  const COMMENTS_PANE_STATE_EVENT = "smarttex:comments-pane-state";
  const RUNTIME_SETTINGS_EVENT = "smarttex:runtime-settings";
  const REVIEW_USER_KEY = "smarttex:review-user:v1";
  const COMMENT_PROFILE_KEY = globalThis.SmartTeXCommentProfile?.KEY || "smarttex:comment-profile:v1";
  const AUTHOR_ID_KEY = "smarttex:comment-author-id:v1";
  const REVIEW_UI_KEY = "smarttex:review-ui:v1";
  const REVIEW_LOCAL_PREFIX = "smarttex:review-local:v1:";
  const REVIEW_PROJECT_FILE = ".smarttex-review.json";
  const REVIEW_HYDRATION_STATE_EVENT = "smarttex:review-hydration-state";
  const COLLABORATION_PRESENCE_EVENT = "smarttex:collaboration-presence";
  const COLLABORATION_PROFILE_EVENT = "smarttex:collaboration-local-profile";
  const COLLABORATION_DIRTY_EVENT = "smarttex:collaboration-metadata-dirty";
  const COLLABORATION_SIGNAL_EVENT = "smarttex:collaboration-signal";
  const LOCAL_INPUT_WINDOW_MS = 1400;
  const TYPE_GROUP_WINDOW_MS = 2200;
  const MOVE_PAIR_WINDOW_MS = 30000;
  const PROJECT_SYNC_DELAY_MS = 1800;
  const PROJECT_POLL_MS = 20000;
  const PROJECT_FULL_SYNC_FALLBACK_MS = 120000;

  function dispatchReviewHydrationState(active) {
    const next = Boolean(active);
    globalThis.__smartTeXReviewHydrationActive = next;
    window.dispatchEvent(new CustomEvent(REVIEW_HYDRATION_STATE_EVENT, {
      detail: JSON.stringify({ active: next })
    }));
  }

  let requestCounter = 0;
  const pendingRequests = new Map();
  let currentState = null;
  let currentFile = "";
  const lastValueByFile = new Map();
  let lastLocalInputAt = 0;
  let lastLocalInputType = "";
  let suppressedTargetValue = null;
  let suppressedMode = "";
  const trackedHistoryByFile = new Map();
  let applyingTrackedHistory = false;
  let trackedHistoryQueue = Promise.resolve();
  let pendingRetainedRestore = null;
  let queuedStateDuringRetainedRestore = null;
  let trackedStateCaptureTimer = 0;
  let lastRoutedStateAt = 0;
  let lastQueuedHistoryKeydownAt = 0;
  let lastQueuedHistoryDirection = "";
  let pane = null;
  let paneOpen = false;
  let changeListNode = null;
  let markupSelect = null;
  let trackToggle = null;
  let scopeToggle = null;
  let minimizeAllButton = null;
  let selectionPopup = null;
  let changePopup = null;
  let commentHighlightLayer = null;
  let markupLayer = null;
  let temporaryLayer = null;
  let presenceLayer = null;
  let originalOverlay = null;
  let overlayFrame = 0;
  let overlayGeneration = 0;
  const collaboratorPresence = new Map();
  let presenceExpiryTimer = 0;
  let localSaveTimer = 0;
  let projectSaveTimer = 0;
  let projectPollTimer = 0;
  let projectSyncInProgress = false;
  let projectSyncPending = false;
  let projectFileKnown = false;
  let lastRemoteProbeToken = null;
  let lastFullRemoteReadAt = 0;
  let reviewActivated = false;
  let identity = { name: "anonymous", color: "#3b82f6" };
  let identityAuthorId = "";
  let popupTrigger = "cursor";
  let localUi = {
    trackingEnabled: false,
    trackingScope: "all",
    markupMode: "markup"
  };
  let reviewState = emptyReviewState();
  let activeChangeId = "";
  let activeChangePopupRequest = 0;
  // During page reload CollabTeX can expose the editor before the selected
  // document has been hydrated. In that short window getState() may report an
  // empty buffer. Never diff such a bootstrap snapshot against the real
  // document, otherwise the full document is recorded as a new insertion and
  // every persisted review range is shifted to the end of the file.
  let initialEditorHydrationPending = true;
  let latestInitialEditorState = null;

  function projectIdentity() {
    const match = String(location.pathname || "").match(/\/project\/([^/?#]+)/i);
    return `${location.origin}:${match?.[1] || location.pathname}`;
  }

  const localReviewKey = `${REVIEW_LOCAL_PREFIX}${projectIdentity()}`;

  function randomId(prefix = "review") {
    return globalThis.crypto?.randomUUID?.()
      || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function validColor(value, fallback = "#3b82f6") {
    return /^#[0-9a-f]{6}$/i.test(String(value || ""))
      ? String(value).toLowerCase()
      : fallback;
  }

  function normalizedIdentity(value) {
    return {
      name: String(value?.name || "anonymous").trim().slice(0, 80) || "anonymous",
      color: validColor(value?.color)
    };
  }

  function emptyReviewState() {
    return {
      version: 1,
      baselineByFile: {},
      baselineUpdatedAtByFile: {},
      baselineClearedAt: "",
      changes: [],
      comments: [],
      tombstones: {},
      sharedTracking: { enabled: false, updatedAt: "" },
      updatedAt: ""
    };
  }

  function normalizeChange(value) {
    if (!value || typeof value !== "object" || !value.id || !value.fileName) return null;
    const type = ["insert", "delete", "replace", "move"].includes(value.type)
      ? value.type
      : "replace";
    return {
      id: String(value.id),
      fileName: String(value.fileName),
      type,
      author: String(value.author || "anonymous"),
      authorId: String(value.authorId || ""),
      color: validColor(value.color, "#94a3b8"),
      start: Math.max(0, Number(value.start) || 0),
      end: Math.max(0, Number(value.end) || 0),
      fromStart: Math.max(0, Number(value.fromStart ?? value.start) || 0),
      fromEnd: Math.max(0, Number(value.fromEnd ?? value.fromStart ?? value.start) || 0),
      toStart: Math.max(0, Number(value.toStart ?? value.start) || 0),
      toEnd: Math.max(0, Number(value.toEnd ?? value.end) || 0),
      text: String(value.text || ""),
      originalText: String(value.originalText || ""),
      createdAt: String(value.createdAt || nowIso()),
      updatedAt: String(value.updatedAt || value.createdAt || nowIso()),
      retained: Boolean(value.retained)
    };
  }

  function normalizeComment(value) {
    if (!value || typeof value !== "object" || !value.id || !value.fileName) return null;
    return {
      id: String(value.id),
      fileName: String(value.fileName),
      start: Math.max(0, Number(value.start) || 0),
      end: Math.max(0, Number(value.end) || 0),
      author: String(value.author || "anonymous"),
      authorId: String(value.authorId || ""),
      color: validColor(value.color),
      kind: value.kind === "highlight" ? "highlight" : "comment",
      linkedChangeId: value.linkedChangeId ? String(value.linkedChangeId) : "",
      minimized: Boolean(value.minimized),
      draft: Boolean(value.draft),
      createdAt: String(value.createdAt || nowIso()),
      updatedAt: String(value.updatedAt || value.createdAt || nowIso()),
      thread: (Array.isArray(value.thread) ? value.thread : []).map((reply) => ({
        id: String(reply?.id || randomId("reply")),
        author: String(reply?.author || "anonymous"),
        authorId: String(reply?.authorId || ""),
        color: validColor(reply?.color),
        text: String(reply?.text || ""),
        createdAt: String(reply?.createdAt || nowIso())
      })).filter((reply) => reply.text.trim())
    };
  }

  function normalizeReviewState(value) {
    const source = value && typeof value === "object" ? value : {};
    const baselines = source.baselineByFile && typeof source.baselineByFile === "object"
      ? Object.fromEntries(Object.entries(source.baselineByFile).map(([key, text]) => [String(key), String(text ?? "")]))
      : {};
    const baselineTimes = source.baselineUpdatedAtByFile && typeof source.baselineUpdatedAtByFile === "object"
      ? { ...source.baselineUpdatedAtByFile }
      : {};
    const tombstones = source.tombstones && typeof source.tombstones === "object"
      ? { ...source.tombstones }
      : {};
    const changes = (Array.isArray(source.changes) ? source.changes : [])
      .map(normalizeChange)
      .filter(Boolean)
      .filter((item) => !tombstones[item.id] || String(tombstones[item.id]) < item.updatedAt);
    const comments = (Array.isArray(source.comments) ? source.comments : [])
      .map(normalizeComment)
      .filter(Boolean)
      .filter((item) => !item.draft)
      .filter((item) => !tombstones[item.id] || String(tombstones[item.id]) < item.updatedAt);
    return {
      version: 1,
      baselineByFile: baselines,
      baselineUpdatedAtByFile: baselineTimes,
      baselineClearedAt: String(source.baselineClearedAt || ""),
      changes,
      comments,
      tombstones,
      sharedTracking: {
        enabled: Boolean(source.sharedTracking?.enabled),
        updatedAt: String(source.sharedTracking?.updatedAt || "")
      },
      updatedAt: String(source.updatedAt || "")
    };
  }

  function normalizedLocalUi(value) {
    const rawMode = String(value?.markupMode || "");
    const markupMode = rawMode === "full" || rawMode === "simple" ? "markup"
      : ["markup", "final", "original"].includes(rawMode) ? rawMode : "markup";
    return {
      trackingEnabled: false,
      trackingScope: "all",
      markupMode
    };
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 5000) {
    const requestId = `review-${Date.now()}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`SmartTeX review request timed out: ${type}`));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, type, ...payload })
      }));
    });
  }

  window.addEventListener(RESPONSE_EVENT, (event) => {
    let response;
    try {
      response = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      return;
    }
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingRequests.delete(response.requestId);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "SmartTeX review editor request failed."));
  });

  function effectiveTrackingScope() {
    return "all";
  }

  function trackingEnabled() {
    return Boolean(reviewState.sharedTracking.enabled);
  }

  function dispatchReviewState() {
    pruneIneffectiveChanges();
    const changes = reviewState.changes
      .filter((change) => change.fileName === currentFile && isEffectiveChange(change))
      .sort((left, right) => {
        const leftPos = left.type === "move" ? left.toStart : left.start;
        const rightPos = right.type === "move" ? right.toStart : right.start;
        return leftPos - rightPos || String(left.createdAt).localeCompare(String(right.createdAt));
      })
      .map((change) => ({ ...change }));
    const detail = {
      open: paneOpen,
      tracking: trackingEnabled(),
      scope: "all",
      markupMode: localUi.markupMode,
      totalChangeCount: reviewState.changes.filter(isEffectiveChange).length,
      changes
    };
    globalThis.__smartTeXReviewState = detail;
    window.dispatchEvent(new CustomEvent(REVIEW_STATE_EVENT, { detail }));
  }

  function mergeById(localItems, remoteItems, tombstones) {
    const merged = new Map();
    for (const raw of [...localItems, ...remoteItems]) {
      const item = raw?.type ? normalizeChange(raw) : normalizeComment(raw);
      if (!item || item.draft) continue;
      const tombstone = String(tombstones[item.id] || "");
      if (tombstone && tombstone >= item.updatedAt) continue;
      const previous = merged.get(item.id);
      if (!previous) {
        merged.set(item.id, item);
        continue;
      }

      // A move is created by promoting an existing retained deletion after the
      // same text is inserted at another position.  Project synchronization can
      // still encounter the older deletion version of that very same id.  Never
      // let such a stale deletion downgrade a move, even when collaborating
      // clients have slightly skewed clocks or wrote the old state later.
      if (previous.type === "move" && item.type === "delete") {
        previous.updatedAt = String(previous.updatedAt) >= String(item.updatedAt)
          ? previous.updatedAt
          : item.updatedAt;
        merged.set(item.id, previous);
        continue;
      }
      if (previous.type === "delete" && item.type === "move") {
        item.updatedAt = String(item.updatedAt) >= String(previous.updatedAt)
          ? item.updatedAt
          : previous.updatedAt;
        merged.set(item.id, item);
        continue;
      }

      if (previous.updatedAt < item.updatedAt) merged.set(item.id, item);
    }
    return [...merged.values()];
  }

  function sameObservedChange(left, right) {
    if (!left || !right) return false;
    if (left.fileName !== right.fileName || left.type !== right.type) return false;
    if (left.text !== right.text || left.originalText !== right.originalText) return false;
    const leftTime = new Date(left.createdAt || left.updatedAt || 0).getTime();
    const rightTime = new Date(right.createdAt || right.updatedAt || 0).getTime();
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || Math.abs(leftTime - rightTime) > 12000) {
      return false;
    }
    if (left.type === "move") {
      return Math.abs(left.fromStart - right.fromStart) <= 8 && Math.abs(left.toStart - right.toStart) <= 8;
    }
    return Math.abs(left.start - right.start) <= 8;
  }

  function deduplicateObservedChanges(changes) {
    const result = [];
    for (const change of [...changes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      const duplicateIndex = result.findIndex((candidate) => sameObservedChange(candidate, change));
      if (duplicateIndex < 0) {
        result.push(change);
        continue;
      }
      const previous = result[duplicateIndex];
      const previousAnonymous = previous.author === "anonymous";
      const currentAnonymous = change.author === "anonymous";
      if ((previousAnonymous && !currentAnonymous) || (
        previousAnonymous === currentAnonymous && String(change.updatedAt) > String(previous.updatedAt)
      )) {
        result[duplicateIndex] = change;
      }
    }
    return result;
  }

  function mergeReviewStates(localValue, remoteValue) {
    const left = normalizeReviewState(localValue);
    const right = normalizeReviewState(remoteValue);
    const tombstones = { ...left.tombstones };
    for (const [id, time] of Object.entries(right.tombstones)) {
      if (!tombstones[id] || String(time) > String(tombstones[id])) tombstones[id] = String(time);
    }
    const baselineClearedAt = [String(left.baselineClearedAt || ""), String(right.baselineClearedAt || "")].sort().at(-1) || "";
    const baselineByFile = { ...left.baselineByFile };
    const baselineUpdatedAtByFile = { ...left.baselineUpdatedAtByFile };
    for (const [fileName, text] of Object.entries(right.baselineByFile)) {
      const rightTime = String(right.baselineUpdatedAtByFile[fileName] || "");
      const leftTime = String(baselineUpdatedAtByFile[fileName] || "");
      if (!leftTime || rightTime >= leftTime) {
        baselineByFile[fileName] = text;
        baselineUpdatedAtByFile[fileName] = rightTime;
      }
    }
    for (const fileName of Object.keys(baselineByFile)) {
      if (baselineClearedAt && String(baselineUpdatedAtByFile[fileName] || "") <= baselineClearedAt) {
        delete baselineByFile[fileName];
        delete baselineUpdatedAtByFile[fileName];
      }
    }
    const sharedTracking = String(right.sharedTracking.updatedAt || "") >= String(left.sharedTracking.updatedAt || "")
      ? right.sharedTracking
      : left.sharedTracking;
    return normalizeReviewState({
      version: 1,
      baselineByFile,
      baselineUpdatedAtByFile,
      baselineClearedAt,
      changes: deduplicateObservedChanges(mergeById(left.changes, right.changes, tombstones)),
      comments: mergeById(left.comments, right.comments, tombstones),
      tombstones,
      sharedTracking,
      updatedAt: [left.updatedAt, right.updatedAt].sort().at(-1) || ""
    });
  }

  function serializableReviewState() {
    return normalizeReviewState({
      ...reviewState,
      comments: reviewState.comments.filter((comment) => !comment.draft),
      updatedAt: nowIso()
    });
  }

  function scheduleLocalSave(delay = 120) {
    window.clearTimeout(localSaveTimer);
    localSaveTimer = window.setTimeout(async () => {
      localSaveTimer = 0;
      try {
        await extensionApi.storage.local.set({
          [localReviewKey]: {
            shared: serializableReviewState(),
            ui: { ...localUi }
          }
        });
      } catch (error) {
        console.warn("SmartTeX review local save failed:", error);
      }
    }, delay);
  }

  function scheduleProjectSave(delay = PROJECT_SYNC_DELAY_MS) {
    if (!reviewActivated) return;
    if (projectSyncInProgress) {
      // Never let an edit made while an earlier metadata write is in flight be
      // swallowed by that write. The finished sync immediately schedules one
      // more pass using the then-current local review state.
      projectSyncPending = true;
      return;
    }
    window.clearTimeout(projectSaveTimer);
    projectSaveTimer = window.setTimeout(() => {
      projectSaveTimer = 0;
      syncProjectState().catch((error) => {
        console.warn("SmartTeX review metadata sync failed:", error);
      });
    }, delay);
  }

  function saveState({ project = true, render = true } = {}) {
    reviewState.updatedAt = nowIso();
    broadcastReviewRealtime();
    scheduleLocalSave();
    if (project) scheduleProjectSave();
    if (render) {
      renderPane();
      scheduleOverlayRender();
    }
    dispatchReviewState();
  }

  function broadcastReviewRealtime() {
    const state = normalizeReviewState({
      ...reviewState,
      comments: reviewState.comments.filter((comment) => !comment.draft)
    });
    window.dispatchEvent(new CustomEvent(COLLABORATION_DIRTY_EVENT, {
      detail: JSON.stringify({
        kind: "review-live",
        nonce: `${state.updatedAt}:${state.changes.length}`,
        payload: { state }
      })
    }));
  }

  async function readRemoteReviewState(options = {}) {
    const response = await bridgeRequest("readProjectMetadataFile", {
      path: REVIEW_PROJECT_FILE,
      fileId: String(options.fileId || ""),
      entityType: String(options.entityType || "")
    }, 9000);
    const file = response?.file;
    if (!file?.exists || !String(file.value || "").trim()) return emptyReviewState();
    return normalizeReviewState(JSON.parse(String(file.value)));
  }

  async function probeRemoteReviewState() {
    const response = await bridgeRequest("probeProjectMetadataFile", { path: REVIEW_PROJECT_FILE }, 4500);
    const probe = response?.probe || {};
    return String(probe.token || (probe.exists ? "present" : "missing"));
  }

  async function syncProjectState() {
    if (!reviewActivated) return;
    if (projectSyncInProgress) {
      projectSyncPending = true;
      return;
    }
    projectSyncInProgress = true;
    try {
      const beforeMerge = normalizeReviewState(reviewState);
      let remote = emptyReviewState();
      try {
        remote = await readRemoteReviewState();
        projectFileKnown = true;
        lastFullRemoteReadAt = Date.now();
      } catch (_error) {
        // A missing metadata file is expected until review is used for the first time.
      }

      // The remote read is asynchronous. The user can continue editing while it
      // is in flight, so merge it into the CURRENT local state, never into a
      // snapshot captured before the await. Otherwise a newly created insert or
      // move can appear briefly and then disappear when the stale snapshot is
      // assigned back after PROJECT_SYNC_DELAY_MS.
      const merged = mergeReviewStates(reviewState, remote);
      let mergeChangedVisibleState = JSON.stringify(normalizeReviewState(merged)) !== JSON.stringify(beforeMerge);
      reviewState = merged;
      if (currentFile && promoteExistingDeleteInsertPairToMove(currentFile)) mergeChangedVisibleState = true;

      // Construct the payload immediately before dispatching the write. If an
      // edit happens while the write itself is pending, scheduleProjectSave()
      // sets projectSyncPending and the finally block performs another sync.
      const payload = serializableReviewState();
      const writeResponse = await bridgeRequest("writeProjectMetadataFile", {
        path: REVIEW_PROJECT_FILE,
        text: JSON.stringify(payload, null, 2) + "\n"
      }, 14000);
      projectFileKnown = true;
      window.dispatchEvent(new CustomEvent(COLLABORATION_DIRTY_EVENT, {
        detail: JSON.stringify({
          kind: "review",
          nonce: `${payload.updatedAt}:${payload.changes.length}`,
          path: REVIEW_PROJECT_FILE,
          fileId: String(writeResponse?.result?.fileId || ""),
          entityType: String(writeResponse?.result?.entityType || "")
        })
      }));
      scheduleLocalSave(0);
      hideMetadataTreeItem();
      if (mergeChangedVisibleState) {
        renderPane();
        scheduleOverlayRender();
        updateCursorChange();
        dispatchReviewState();
      }
    } finally {
      projectSyncInProgress = false;
      if (projectSyncPending) {
        projectSyncPending = false;
        scheduleProjectSave(0);
      }
    }
  }

  async function refreshProjectState(options = {}) {
    if (!reviewActivated || projectSyncInProgress) return;
    const force = options?.force === true;
    const fallbackDue = (Date.now() - lastFullRemoteReadAt) >= PROJECT_FULL_SYNC_FALLBACK_MS;
    let shouldRead = force || fallbackDue;
    try {
      const token = await probeRemoteReviewState();
      if (lastRemoteProbeToken === null || token !== lastRemoteProbeToken) shouldRead = true;
      lastRemoteProbeToken = token;
    } catch (_error) {
      // The periodic full-read fallback still refreshes collaborative state.
    }
    if (!shouldRead) return;
    try {
      const remote = await readRemoteReviewState(options);
      lastFullRemoteReadAt = Date.now();
      const merged = mergeReviewStates(reviewState, remote);
      let changed = JSON.stringify(merged) !== JSON.stringify(normalizeReviewState(reviewState));
      reviewState = merged;
      if (currentFile && promoteExistingDeleteInsertPairToMove(currentFile)) changed = true;
      projectFileKnown = true;
      hideMetadataTreeItem();
      if (changed) {
        scheduleLocalSave(0);
        renderPane();
        scheduleOverlayRender();
        updateCursorChange();
        dispatchReviewState();
      }
    } catch (_error) {
      // Keep the local cache usable while the project file is absent or temporarily unavailable.
    }
  }

  function ensureProjectPolling() {
    window.clearInterval(projectPollTimer);
    if (!reviewActivated) return;
    projectPollTimer = window.setInterval(refreshProjectState, PROJECT_POLL_MS);
  }

  function hideMetadataTreeItem() {
    for (const item of document.querySelectorAll('.file-tree-list [role="treeitem"]')) {
      const label = String(item.textContent || "").trim();
      if (label === REVIEW_PROJECT_FILE || label.endsWith(`/${REVIEW_PROJECT_FILE}`)) {
        item.style.display = "none";
        item.setAttribute("aria-hidden", "true");
      }
    }
  }

  function historyShortcut(event) {
    if (event.type !== "keydown") return "";
    const modifier = Boolean(event.ctrlKey || event.metaKey);
    if (!modifier || event.altKey) return "";
    const key = String(event.key || "").toLowerCase();
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && !event.shiftKey) return "redo";
    return "";
  }

  async function synchronizeEditorStateBeforeHistory() {
    const first = await bridgeRequest("getState", {}, 1800).catch(() => null);
    if (first?.state && String(first.state.fileName || "") === currentFile) {
      routeEditorState(first.state);
    }
    if (pendingRetainedRestore) {
      await pendingRetainedRestore.catch(() => {});
      const settled = await bridgeRequest("getState", {}, 1800).catch(() => null);
      if (settled?.state && String(settled.state.fileName || "") === currentFile) {
        routeEditorState(settled.state);
      }
    }
  }

  async function captureTrackedEditorState() {
    if (!trackingEnabled()) return;
    const response = await bridgeRequest("getState", {}, 1800).catch(() => null);
    if (response?.state) routeEditorState(response.state);
  }

  function scheduleTrackedStateCapture() {
    if (!trackingEnabled()) return;
    const requestedAt = Date.now();
    const idleDelay = Math.max(
      500,
      Number(globalThis.SmartTeXInteractionTasks?.keyboardIdleRemaining?.()) || 0
    );
    window.clearTimeout(trackedStateCaptureTimer);
    trackedStateCaptureTimer = window.setTimeout(() => {
      trackedStateCaptureTimer = 0;
      // Normal bridge publication is sufficient. Only copy the complete source
      // when the host omitted every state callback for this edit.
      if (lastRoutedStateAt < requestedAt) void captureTrackedEditorState();
    }, idleDelay + 100);
  }

  function queueTrackedHistory(direction) {
    trackedHistoryQueue = trackedHistoryQueue
      .catch(() => {})
      .then(async () => {
        await synchronizeEditorStateBeforeHistory();
        await performTrackedHistory(direction);
      });
    return trackedHistoryQueue;
  }

  function markLocalInput(event) {
    if (!trackingEnabled()) return;
    const target = event.target;
    const insideEditor = target?.closest?.(
      ".ace_editor, .ace_text-input, .cm-editor, .cm-content, #ide-redesign-panel-editor, .editor-pane"
    );
    const toolbar = target?.closest?.(".smarttex-document-editing-toolbar");
    if (!(insideEditor || toolbar)) return;

    const inputHistoryDirection = event.type === "beforeinput"
      ? (event.inputType === "historyUndo" ? "undo" : event.inputType === "historyRedo" ? "redo" : "")
      : "";
    const historyDirection = inputHistoryDirection || historyShortcut(event);
    if (historyDirection && trackingEnabled() && currentFile) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const timestamp = Date.now();
      if (event.type === "beforeinput" &&
          lastQueuedHistoryDirection === historyDirection &&
          timestamp - lastQueuedHistoryKeydownAt < 120) {
        return;
      }
      if (event.type === "keydown") {
        lastQueuedHistoryKeydownAt = timestamp;
        lastQueuedHistoryDirection = historyDirection;
      }
      void queueTrackedHistory(historyDirection);
      return;
    }

    lastLocalInputAt = Date.now();
    if (event.type === "beforeinput") {
      lastLocalInputType = String(event.inputType || "");
    } else if (event.type === "keydown") {
      const key = String(event.key || "");
      if (key === "Backspace") {
        lastLocalInputType = "deleteContentBackward";
      } else if (key === "Delete") {
        lastLocalInputType = "deleteContentForward";
      }
    }
    if (event.type === "input") scheduleTrackedStateCapture();
  }

  for (const eventName of ["beforeinput", "input", "keydown", "paste", "cut", "drop", "pointerdown"]) {
    document.addEventListener(eventName, markLocalInput, true);
  }

  function isLikelyLocalEdit() {
    return Date.now() - lastLocalInputAt <= LOCAL_INPUT_WINDOW_MS;
  }

  function historySnapshot(fileName, value) {
    return {
      value: String(value || ""),
      changes: reviewState.changes
        .filter((change) => change.fileName === fileName)
        .map((change) => ({ ...change })),
      baseline: Object.prototype.hasOwnProperty.call(reviewState.baselineByFile, fileName)
        ? String(reviewState.baselineByFile[fileName] || "")
        : null,
      baselineUpdatedAt: String(reviewState.baselineUpdatedAtByFile[fileName] || "")
    };
  }

  function historySnapshotKey(snapshot) {
    return JSON.stringify({ value: snapshot.value, changes: snapshot.changes });
  }

  function ensureTrackedHistory(fileName, value) {
    if (!fileName || trackedHistoryByFile.has(fileName)) return;
    trackedHistoryByFile.set(fileName, {
      entries: [historySnapshot(fileName, value)],
      index: 0
    });
  }

  function pushTrackedHistory(fileName, value) {
    ensureTrackedHistory(fileName, value);
    const history = trackedHistoryByFile.get(fileName);
    const snapshot = historySnapshot(fileName, value);
    const current = history.entries[history.index];
    if (current && historySnapshotKey(current) === historySnapshotKey(snapshot)) return;
    history.entries.splice(history.index + 1);
    history.entries.push(snapshot);
    if (history.entries.length > 250) history.entries.shift();
    history.index = history.entries.length - 1;
  }

  function restoreTrackedSnapshot(fileName, snapshot) {
    const restored = (snapshot.changes || []).map(normalizeChange).filter(Boolean);
    const restoredIds = new Set(restored.map((change) => change.id));
    reviewState.changes = reviewState.changes
      .filter((change) => change.fileName !== fileName)
      .concat(restored);
    for (const id of restoredIds) delete reviewState.tombstones[id];
    if (snapshot.baseline !== null) {
      reviewState.baselineByFile[fileName] = snapshot.baseline;
      reviewState.baselineUpdatedAtByFile[fileName] = snapshot.baselineUpdatedAt || nowIso();
    }
  }

  async function performTrackedHistory(direction) {
    if (applyingTrackedHistory || !currentFile || !currentState) return;
    const history = trackedHistoryByFile.get(currentFile);
    if (!history) return;
    const targetIndex = direction === "redo" ? history.index + 1 : history.index - 1;
    if (targetIndex < 0 || targetIndex >= history.entries.length) return;
    const snapshot = history.entries[targetIndex];
    const source = String(currentState.value || "");
    applyingTrackedHistory = true;
    try {
      if (snapshot.value !== source) {
        suppressedTargetValue = snapshot.value;
        suppressedMode = "history";
        const cursor = Math.min(snapshot.value.length, Math.max(0, Number(currentState.cursorIndex) || 0));
        const response = await bridgeRequest("replaceRange", {
          start: 0,
          end: source.length,
          text: snapshot.value,
          selectionStart: cursor,
          selectionEnd: cursor,
          focus: true
        }, 7000).catch(() => null);
        if (!response?.ok) {
          suppressedTargetValue = null;
          suppressedMode = "";
          return;
        }
      }
      restoreTrackedSnapshot(currentFile, snapshot);
      history.index = targetIndex;
      lastValueByFile.set(currentFile, snapshot.value);
      currentState = { ...currentState, value: snapshot.value };
      saveState();
      scheduleOverlayRender();
      renderPane();
      dispatchReviewState();
    } finally {
      applyingTrackedHistory = false;
    }
  }

  function singleSplice(oldValue, newValue) {
    if (oldValue === newValue) return null;
    let start = 0;
    const common = Math.min(oldValue.length, newValue.length);
    while (start < common && oldValue.charCodeAt(start) === newValue.charCodeAt(start)) start += 1;
    let oldTail = oldValue.length;
    let newTail = newValue.length;
    while (
      oldTail > start && newTail > start &&
      oldValue.charCodeAt(oldTail - 1) === newValue.charCodeAt(newTail - 1)
    ) {
      oldTail -= 1;
      newTail -= 1;
    }
    return {
      start,
      oldEnd: oldTail,
      newEnd: newTail,
      removed: oldValue.slice(start, oldTail),
      added: newValue.slice(start, newTail)
    };
  }

  function mapPosition(position, splice, bias = "left") {
    const pos = Math.max(0, Number(position) || 0);
    const insertedLength = splice.added.length;
    const removedLength = splice.oldEnd - splice.start;
    const delta = insertedLength - removedLength;
    if (pos < splice.start) return pos;
    if (pos > splice.oldEnd) return pos + delta;
    if (pos === splice.oldEnd && removedLength > 0) return pos + delta;
    if (pos === splice.start && removedLength === 0) {
      return bias === "right" ? pos + insertedLength : pos;
    }
    return bias === "right" ? splice.start + insertedLength : splice.start;
  }

  function transformRange(item, splice) {
    const oldStart = item.start;
    const oldEnd = item.end;
    const pureInsertion = Boolean(splice.added) && !splice.removed;
    if (item.type === "delete" && item.retained && pureInsertion) {
      const addedLength = splice.added.length;
      if (splice.start <= oldStart) {
        item.start = oldStart + addedLength;
        item.end = oldEnd + addedLength;
      } else if (splice.start >= oldEnd) {
        item.start = oldStart;
        item.end = oldEnd;
      } else {
        // A different modification inside a retained deletion temporarily
        // expands the range; it is split into two records immediately after
        // transformation by splitRetainedDeletionsBrokenByInsertion().
        item.start = oldStart;
        item.end = oldEnd + addedLength;
      }
    } else {
      item.start = mapPosition(oldStart, splice, "left");
      item.end = Math.max(item.start, mapPosition(oldEnd, splice, "right"));
    }
    if (item.type === "move") {
      item.fromStart = mapPosition(item.fromStart, splice, "left");
      item.fromEnd = Math.max(item.fromStart, mapPosition(item.fromEnd, splice, "right"));
      item.toStart = mapPosition(item.toStart, splice, "left");
      item.toEnd = Math.max(item.toStart, mapPosition(item.toEnd, splice, "right"));
    }
  }

  function transformExistingRecords(fileName, splice) {
    for (const change of reviewState.changes) {
      if (change.fileName === fileName) transformRange(change, splice);
    }
    for (const comment of reviewState.comments) {
      if (comment.fileName === fileName) transformRange(comment, splice);
    }
  }

  function comparableMoveText(value) {
    return String(value || "").replace(/\r\n?/g, "\n");
  }

  function matchingMoveDeletion(fileName, splice, localAuthor) {
    if (!splice.added || splice.removed || !moveSized(splice.added)) return null;
    const added = comparableMoveText(splice.added);
    const preferredAuthor = localAuthor ? identity.name : "";
    const now = Date.now();

    return [...reviewState.changes]
      .filter((change) => {
        if (change.fileName !== fileName || change.type !== "delete") return false;
        if (comparableMoveText(change.originalText) !== added) return false;
        if (!(splice.start <= change.start || splice.start >= change.end)) return false;

        // A delayed editor-state notification must not turn a genuine local
        // cut/paste into two unrelated delete+insert records merely because the
        // local-input timestamp expired. Prefer the current author, but permit
        // a recent exact-text deletion when authorship is temporarily reported
        // as anonymous. Never steal another named user's deletion for a known
        // local paste.
        if (preferredAuthor && change.author !== preferredAuthor && change.author !== "anonymous") {
          return false;
        }
        const changedAt = new Date(change.updatedAt || change.createdAt || 0).getTime();
        return !Number.isFinite(changedAt) || Math.abs(now - changedAt) <= MOVE_PAIR_WINDOW_MS;
      })
      .sort((left, right) => {
        const leftAuthorScore = preferredAuthor && left.author === preferredAuthor ? 1 : 0;
        const rightAuthorScore = preferredAuthor && right.author === preferredAuthor ? 1 : 0;
        return rightAuthorScore - leftAuthorScore
          || String(right.updatedAt).localeCompare(String(left.updatedAt));
      })[0] || null;
  }

  function promoteExistingDeleteInsertPairToMove(fileName) {
    const candidates = reviewState.changes.filter((change) => change.fileName === fileName);
    const deletions = candidates
      .filter((change) => change.type === "delete" && change.retained && moveSized(change.originalText))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const insertions = candidates.filter((change) => change.type === "insert");

    for (const deletion of deletions) {
      const deletedText = comparableMoveText(deletion.originalText);
      const deletionTime = new Date(deletion.updatedAt || deletion.createdAt || 0).getTime();
      const insertion = insertions
        .filter((change) => {
          if (comparableMoveText(change.text) !== deletedText) return false;
          if (!(change.end <= deletion.start || change.start >= deletion.end)) return false;
          const authorCompatible = change.author === deletion.author
            || change.author === "anonymous"
            || deletion.author === "anonymous";
          if (!authorCompatible) return false;
          const insertionTime = new Date(change.updatedAt || change.createdAt || 0).getTime();
          if (!Number.isFinite(deletionTime) || !Number.isFinite(insertionTime)) return true;
          return Math.abs(insertionTime - deletionTime) <= MOVE_PAIR_WINDOW_MS;
        })
        .sort((left, right) => {
          const leftDistance = Math.abs((new Date(left.updatedAt || left.createdAt || 0).getTime() || 0) - (deletionTime || 0));
          const rightDistance = Math.abs((new Date(right.updatedAt || right.createdAt || 0).getTime() || 0) - (deletionTime || 0));
          return leftDistance - rightDistance;
        })[0];
      if (!insertion) continue;

      const timestamp = nowIso();
      const namedAuthor = deletion.author !== "anonymous"
        ? deletion.author
        : (insertion.author !== "anonymous" ? insertion.author : deletion.author);
      const namedColor = namedAuthor === insertion.author ? insertion.color : deletion.color;
      deletion.type = "move";
      deletion.author = namedAuthor || "anonymous";
      deletion.authorId = deletion.authorId || insertion.authorId || "";
      deletion.color = namedColor || deletion.color;
      deletion.text = insertion.text;
      deletion.fromStart = deletion.start;
      deletion.fromEnd = deletion.end;
      deletion.toStart = insertion.start;
      deletion.toEnd = insertion.end;
      deletion.start = insertion.start;
      deletion.end = insertion.end;
      deletion.updatedAt = timestamp;

      tombstoneItem(insertion.id);
      reviewState.changes = reviewState.changes.filter((change) => change.id !== insertion.id);
      return true;
    }
    return false;
  }

  function keepAdjacentInsertionsOutsideMove(fileName, splice, beforeChanges, moveCandidateId) {
    if (!moveCandidateId || !splice.added || splice.removed) return;
    const addedLength = splice.added.length;
    for (const before of beforeChanges) {
      if (
        before.fileName !== fileName ||
        before.id === moveCandidateId ||
        before.type !== "insert"
      ) continue;

      const transformed = reviewState.changes.find((change) => change.id === before.id);
      if (!transformed || transformed.type !== "insert") continue;

      // A pasted block which is promoted to a Move is a separate modification.
      // If it is inserted exactly before or after an existing pending insertion,
      // the existing insertion must stay outside the moved block instead of
      // absorbing the pasted text through the generic range-affinity mapping.
      if (before.start === splice.start) {
        transformed.start = before.start + addedLength;
        transformed.end = before.end + addedLength;
      } else if (before.end === splice.start) {
        transformed.start = before.start;
        transformed.end = before.end;
      }
    }
  }

  function splitRetainedDeletionsBrokenByInsertion(fileName, splice, beforeChanges) {
    if (!splice.added || splice.removed) return;
    const addedLength = splice.added.length;
    for (const before of beforeChanges) {
      if (before.fileName !== fileName || before.type !== "delete" || !before.retained) continue;
      if (!(splice.start > before.start && splice.start < before.end)) continue;
      const transformed = reviewState.changes.find((change) => change.id === before.id);
      if (!transformed || transformed.type !== "delete" || !transformed.retained) continue;
      const splitOffset = splice.start - before.start;
      const leftText = before.originalText.slice(0, splitOffset);
      const rightText = before.originalText.slice(splitOffset);
      if (!leftText || !rightText) continue;

      const splitTimestamp = nowIso();
      transformed.start = before.start;
      transformed.end = splice.start;
      transformed.originalText = leftText;
      transformed.updatedAt = splitTimestamp;
      const right = normalizeChange({
        ...before,
        id: randomId("change"),
        start: splice.start + addedLength,
        end: before.end + addedLength,
        originalText: rightText,
        updatedAt: splitTimestamp
      });
      reviewState.changes.push(right);
    }
  }

  function splitMovedChangesBrokenByModification(fileName, splice, beforeChanges, options = {}) {
    const retainedEditorState = Boolean(options.retainedEditorState);
    const insertedLength = splice.added.length;
    const removedLength = Math.max(0, splice.oldEnd - splice.start);

    for (const before of beforeChanges) {
      if (before.fileName !== fileName || before.type !== "move") continue;

      // Only split when the modification is strictly inside the moved target.
      // Changes at either outer edge simply extend/abut the neighboring change.
      const editStart = splice.start;
      const editEnd = removedLength > 0 ? splice.oldEnd : splice.start;
      const strictlyInside = removedLength > 0
        ? editStart > before.toStart && editEnd < before.toEnd
        : editStart > before.toStart && editStart < before.toEnd;
      if (!strictlyInside) continue;

      const leftOffset = editStart - before.toStart;
      const rightOffset = editEnd - before.toStart;
      const movedText = String(before.text || before.originalText || "");
      const originalText = String(before.originalText || before.text || "");
      const leftText = movedText.slice(0, leftOffset);
      const rightText = movedText.slice(rightOffset);
      const leftOriginal = originalText.slice(0, leftOffset);
      const rightOriginal = originalText.slice(rightOffset);
      if (!leftText || !rightText) continue;

      const transformed = reviewState.changes.find((change) => change.id === before.id);
      if (!transformed || transformed.type !== "move") continue;

      // Retained deletions are immediately restored in the editor, so their
      // coordinates remain in the pre-splice document. Ordinary insert/replace
      // edits use the post-splice coordinates.
      const mappedFromStart = retainedEditorState
        ? before.fromStart
        : mapPosition(before.fromStart, splice, "left");
      const mappedToStart = retainedEditorState
        ? before.toStart
        : mapPosition(before.toStart, splice, "left");
      const rightToStart = retainedEditorState
        ? splice.oldEnd
        : splice.start + insertedLength;
      const mappedToEnd = retainedEditorState
        ? before.toEnd
        : mapPosition(before.toEnd, splice, "right");
      const splitTimestamp = nowIso();

      transformed.text = leftText;
      transformed.originalText = leftOriginal;
      transformed.fromStart = mappedFromStart;
      transformed.fromEnd = mappedFromStart + leftOffset;
      transformed.toStart = mappedToStart;
      transformed.toEnd = splice.start;
      transformed.start = transformed.toStart;
      transformed.end = transformed.toEnd;
      transformed.updatedAt = splitTimestamp;

      const right = normalizeChange({
        ...before,
        id: randomId("change"),
        text: rightText,
        originalText: rightOriginal,
        fromStart: mappedFromStart + rightOffset,
        fromEnd: mappedFromStart + rightOffset + rightText.length,
        toStart: rightToStart,
        toEnd: mappedToEnd,
        start: rightToStart,
        end: mappedToEnd,
        updatedAt: splitTimestamp
      });
      reviewState.changes.push(right);
    }
  }

  function moveSized(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    // Moves are intentionally limited to complete prose sentences (or several
    // sentences). Short fragments, clauses, words, and bare LaTeX blocks stay
    // represented as a deletion plus an addition.
    return /[\p{L}\p{N}][\s\S]*[.!?](?:["'’”\)\]}]+)?$/u.test(clean);
  }

  function trackedSpliceType(splice) {
    return splice.removed && splice.added
      ? "replace"
      : splice.added ? "insert" : "delete";
  }

  function trackedSpliceGroupingHint(fileName, splice, localAuthor, previousValue = "") {
    const author = localAuthor ? identity.name : "anonymous";
    const type = trackedSpliceType(splice);
    const candidates = reviewState.changes
      .filter((change) => (
        change.fileName === fileName &&
        change.author === author &&
        change.type === type
      ))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

    // Grouping is deliberately independent of typing cadence and cursor history.
    // Two edits by the same author belong to one change whenever the affected
    // ranges are spatially contiguous in the document.
    if (type === "insert") {
      const candidate = candidates.find((change) => (
        splice.start >= change.start && splice.start <= change.end
      ));
      if (candidate) {
        return {
          id: candidate.id,
          mode: "insert-at",
          offset: Math.max(0, splice.start - candidate.start)
        };
      }
    }

    if (type === "delete") {
      const candidate = candidates.find((change) => (
        change.retained && splice.start <= change.end && splice.oldEnd >= change.start
      ));
      if (candidate) {
        const start = Math.min(candidate.start, splice.start);
        const end = Math.max(candidate.end, splice.oldEnd);
        return {
          id: candidate.id,
          mode: "delete-retained-union",
          start,
          end,
          originalText: String(previousValue || "").slice(start, end)
        };
      }
    }

    if (type === "replace") {
      const candidate = candidates.find((change) => (
        splice.start <= change.end && splice.oldEnd >= change.start
      ));
      if (candidate) return { id: candidate.id, mode: "replace-touching" };
    }
    return null;
  }

  function insertionChangeAbsorbingDeletion(fileName, splice, localAuthor) {
    if (!localAuthor || !splice.removed || splice.added) return null;
    const author = identity.name;
    return reviewState.changes.find((change) => (
      change.fileName === fileName &&
      change.author === author &&
      change.type === "insert" &&
      splice.start >= change.start &&
      splice.oldEnd <= change.end
    )) || null;
  }

  function shrinkInsertionForDeletion(change, splice, oldStart) {
    if (!change) return;
    const offset = Math.max(0, splice.start - oldStart);
    const length = Math.max(0, splice.oldEnd - splice.start);
    change.text = change.text.slice(0, offset) + change.text.slice(offset + length);
    change.updatedAt = nowIso();
    if (change.text.length === 0 || change.end <= change.start) {
      tombstoneItem(change.id);
      reviewState.changes = reviewState.changes.filter((item) => item.id !== change.id);
    }
  }

  function recordTrackedSplice(fileName, splice, localAuthor, groupingHint = null, options = {}) {
    const author = localAuthor ? identity.name : "anonymous";
    const color = localAuthor ? identity.color : "#94a3b8";
    const timestamp = nowIso();
    const retainedDeletion = Boolean(options.retainedDeletion);

    if (splice.added && !splice.removed && String(splice.added).trim()) {
      const candidate = options.moveCandidateId
        ? reviewState.changes.find((change) => change.id === options.moveCandidateId)
        : matchingMoveDeletion(fileName, splice, localAuthor);
      if (candidate) {
        const sourceStart = candidate.start;
        const sourceEnd = candidate.retained && candidate.end > candidate.start
          ? candidate.end
          : candidate.start;
        candidate.type = "move";
        // Preserve the named author from the deletion if the paste state was
        // delivered late and therefore classified as anonymous.
        candidate.author = localAuthor
          ? identity.name
          : (candidate.author && candidate.author !== "anonymous" ? candidate.author : author);
        if (localAuthor) candidate.authorId = identityAuthorId;
        candidate.color = candidate.author === identity.name ? identity.color : candidate.color || color;
        candidate.text = splice.added;
        candidate.fromStart = sourceStart;
        candidate.fromEnd = sourceEnd;
        candidate.toStart = splice.start;
        candidate.toEnd = splice.start + splice.added.length;
        candidate.start = candidate.toStart;
        candidate.end = candidate.toEnd;
        candidate.updatedAt = timestamp;
        return candidate;
      }
    }

    const type = trackedSpliceType(splice);
    const grouped = groupingHint
      ? reviewState.changes.find((change) => change.id === groupingHint.id)
      : null;

    if (grouped && grouped.fileName === fileName && grouped.author === author && grouped.type === type) {
      if (groupingHint.mode === "insert-at") {
        const offset = Math.max(0, Math.min(grouped.text.length, Number(groupingHint.offset) || 0));
        grouped.text = grouped.text.slice(0, offset) + splice.added + grouped.text.slice(offset);
        grouped.updatedAt = timestamp;
        return grouped;
      }
      if (groupingHint.mode === "delete-retained-union") {
        grouped.start = groupingHint.start;
        grouped.end = groupingHint.end;
        grouped.originalText = groupingHint.originalText;
        grouped.retained = true;
        grouped.updatedAt = timestamp;
        return grouped;
      }
      if (groupingHint.mode === "replace-touching") {
        const start = Math.min(grouped.start, splice.start);
        const end = Math.max(grouped.end, splice.start + splice.added.length);
        grouped.start = start;
        grouped.end = end;
        grouped.originalText += splice.removed;
        grouped.text += splice.added;
        grouped.updatedAt = timestamp;
        return grouped;
      }
    }

    const created = normalizeChange({
      id: randomId("change"),
      fileName,
      type,
      author,
      authorId: localAuthor ? identityAuthorId : "",
      color,
      start: splice.start,
      end: type === "delete" && retainedDeletion
        ? splice.oldEnd
        : splice.start + splice.added.length,
      text: splice.added,
      originalText: splice.removed,
      retained: type === "delete" && retainedDeletion,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    reviewState.changes.push(created);
    return created;
  }

  function isEffectiveChange(change) {
    if (!change) return false;
    if (change.type === "insert") return Boolean(change.text) && change.end > change.start;
    if (change.type === "delete") return Boolean(change.originalText) && (!change.retained || change.end > change.start);
    if (change.type === "replace") return change.originalText !== change.text;
    if (change.type === "move") {
      const sourceRangeValid = !change.retained || change.fromEnd > change.fromStart;
      return Boolean(change.text || change.originalText) &&
        change.toEnd > change.toStart && sourceRangeValid &&
        (change.fromStart !== change.toStart || change.fromEnd !== change.toEnd);
    }
    return false;
  }

  function pruneIneffectiveChanges() {
    const ineffective = reviewState.changes.filter((change) => !isEffectiveChange(change));
    if (!ineffective.length) return false;
    const ids = new Set(ineffective.map((change) => change.id));
    for (const change of ineffective) tombstoneItem(change.id);
    reviewState.changes = reviewState.changes.filter((change) => !ids.has(change.id));
    return true;
  }

  function pendingChangesForFile(fileName) {
    return reviewState.changes
      .filter((change) => change.fileName === fileName && isEffectiveChange(change))
      .sort((left, right) => {
        const leftPos = left.type === "move" ? left.toStart : left.start;
        const rightPos = right.type === "move" ? right.toStart : right.start;
        return rightPos - leftPos;
      });
  }

  function reconstructAcceptedForFile(currentValue, fileName) {
    let source = String(currentValue || "");
    for (const change of pendingChangesForFile(fileName)) {
      if (change.type === "insert") {
        source = source.slice(0, change.start) + source.slice(change.end);
      } else if (change.type === "delete") {
        if (!change.retained) {
          source = source.slice(0, change.start) + change.originalText + source.slice(change.start);
        }
      } else if (change.type === "replace") {
        source = source.slice(0, change.start) + change.originalText + source.slice(change.end);
      } else if (change.type === "move") {
        const moved = source.slice(change.toStart, change.toEnd) || change.text;
        source = source.slice(0, change.toStart) + source.slice(change.toEnd);
        if (!change.retained) {
          let from = change.fromStart;
          if (from > change.toStart) from -= Math.max(0, change.toEnd - change.toStart);
          source = source.slice(0, from) + moved + source.slice(from);
        }
      }
    }
    return source;
  }

  function updateAcceptedBaseline(fileName, currentValue) {
    reviewState.baselineByFile[fileName] = reconstructAcceptedForFile(currentValue, fileName);
    reviewState.baselineUpdatedAtByFile[fileName] = nowIso();
  }

  function ensureBaseline(fileName, value) {
    if (!fileName || Object.prototype.hasOwnProperty.call(reviewState.baselineByFile, fileName)) return false;
    reviewState.baselineByFile[fileName] = String(value || "");
    reviewState.baselineUpdatedAtByFile[fileName] = nowIso();
    scheduleLocalSave(0);
    return true;
  }

  function shiftHydratedPositionBack(position, shift) {
    const value = Math.max(0, Number(position) || 0);
    if (!shift || value === 0) return value;
    return Math.max(0, value - shift);
  }

  function repairInitialWholeDocumentInsertArtifact(fileName, currentValue) {
    const value = String(currentValue || "");
    if (!fileName || !value) return false;
    const baseline = Object.prototype.hasOwnProperty.call(reviewState.baselineByFile, fileName)
      ? String(reviewState.baselineByFile[fileName] || "")
      : "";
    if (!baseline) return false;

    // A real edit cannot be a pure insertion of the complete current document
    // at offset zero while a non-empty accepted baseline already exists. This
    // exact record is produced when a transient empty editor state is consumed
    // during reload and the subsequently hydrated document is diffed against it.
    const artifacts = reviewState.changes.filter((change) => (
      change.fileName === fileName &&
      change.type === "insert" &&
      change.start === 0 &&
      change.end >= value.length &&
      comparableMoveText(change.text) === comparableMoveText(value)
    ));
    if (!artifacts.length) return false;

    const artifactIds = new Set(artifacts.map((change) => change.id));
    const shift = value.length * artifacts.length;
    for (const artifact of artifacts) tombstoneItem(artifact.id);
    reviewState.changes = reviewState.changes.filter((change) => !artifactIds.has(change.id));

    const unshiftRange = (item) => {
      item.start = shiftHydratedPositionBack(item.start, shift);
      item.end = Math.max(item.start, shiftHydratedPositionBack(item.end, shift));
      if (item.type === "move") {
        item.fromStart = shiftHydratedPositionBack(item.fromStart, shift);
        item.fromEnd = Math.max(item.fromStart, shiftHydratedPositionBack(item.fromEnd, shift));
        item.toStart = shiftHydratedPositionBack(item.toStart, shift);
        item.toEnd = Math.max(item.toStart, shiftHydratedPositionBack(item.toEnd, shift));
        item.start = item.toStart;
        item.end = item.toEnd;
      }
    };
    for (const change of reviewState.changes) {
      if (change.fileName === fileName) unshiftRange(change);
    }
    for (const comment of reviewState.comments) {
      if (comment.fileName === fileName) unshiftRange(comment);
    }
    return true;
  }

  function closestTextOccurrence(source, needle, preferredStart, excludedStart = -1) {
    const text = String(needle || "");
    if (!text) return -1;
    const preferred = Math.max(0, Number(preferredStart) || 0);
    let best = -1;
    let bestDistance = Infinity;
    let from = 0;
    while (from <= source.length - text.length) {
      const index = source.indexOf(text, from);
      if (index < 0) break;
      if (index !== excludedStart) {
        const distance = Math.abs(index - preferred);
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
      from = index + Math.max(1, text.length);
    }
    return best;
  }

  function repairHydratedChangeRanges(fileName, currentValue) {
    const source = String(currentValue || "");
    if (!fileName || !source) return false;
    let changed = false;
    for (const change of reviewState.changes) {
      if (change.fileName !== fileName || !isEffectiveChange(change)) continue;

      if (change.type === "move") {
        const movedText = String(change.text || change.originalText || "");
        const originalText = String(change.originalText || change.text || "");
        const sourceMatches = change.fromEnd <= source.length &&
          source.slice(change.fromStart, change.fromEnd) === originalText;
        const targetMatches = change.toEnd <= source.length &&
          source.slice(change.toStart, change.toEnd) === movedText;
        let fromStart = change.fromStart;
        let toStart = change.toStart;
        if (!sourceMatches && originalText) {
          const found = closestTextOccurrence(source, originalText, change.fromStart, targetMatches ? change.toStart : -1);
          if (found >= 0) fromStart = found;
        }
        if (!targetMatches && movedText) {
          const found = closestTextOccurrence(source, movedText, change.toStart, fromStart);
          if (found >= 0) toStart = found;
        }
        if (fromStart !== change.fromStart || toStart !== change.toStart) {
          change.fromStart = fromStart;
          change.fromEnd = fromStart + originalText.length;
          change.toStart = toStart;
          change.toEnd = toStart + movedText.length;
          change.start = change.toStart;
          change.end = change.toEnd;
          changed = true;
        }
        continue;
      }

      const visibleText = change.type === "delete"
        ? (change.retained ? String(change.originalText || "") : "")
        : String(change.text || "");
      if (!visibleText) continue;
      const rangeEnd = change.start + visibleText.length;
      if (rangeEnd <= source.length && source.slice(change.start, rangeEnd) === visibleText) {
        if (change.end !== rangeEnd && change.type !== "delete") {
          change.end = rangeEnd;
          changed = true;
        }
        continue;
      }
      const found = closestTextOccurrence(source, visibleText, change.start);
      if (found < 0) continue;
      change.start = found;
      change.end = found + visibleText.length;
      changed = true;
    }
    return changed;
  }

  function seedInitialEditorState(next) {
    if (!next || typeof next !== "object") return false;
    const fileName = String(next.fileName || "");
    if (!fileName) return false;
    const nextValue = String(next.value || "");
    currentState = next;
    currentFile = fileName;

    const repairedArtifact = repairInitialWholeDocumentInsertArtifact(fileName, nextValue);
    const repairedRanges = repairHydratedChangeRanges(fileName, nextValue);
    lastValueByFile.set(fileName, nextValue);
    if (trackingEnabled()) {
      ensureBaseline(fileName, nextValue);
      trackedHistoryByFile.delete(fileName);
      ensureTrackedHistory(fileName, nextValue);
    }
    if (promoteExistingDeleteInsertPairToMove(fileName)) saveState({ project: false, render: false });
    if (repairedArtifact || repairedRanges) saveState({ render: false });
    renderPane();
    scheduleOverlayRender();
    updateSelectionPopup();
    updateCursorChange();
    dispatchReviewState();
    return true;
  }

  function retainedDeletionCursor(splice) {
    if (lastLocalInputType === "deleteContentForward") return splice.oldEnd;
    return splice.start;
  }

  async function restoreRetainedDeletion(previousValue, nextValue, splice) {
    const fileName = currentFile;
    const cursor = retainedDeletionCursor(splice);
    const response = await bridgeRequest("replaceRange", {
      start: splice.start,
      end: splice.start,
      text: splice.removed,
      selectionStart: cursor,
      selectionEnd: cursor,
      focus: true
    }, 7000).catch(() => null);
    if (response?.ok) return true;

    // If restoration fails, fall back to the actual editor value and keep the
    // metadata internally consistent with the physical deletion.
    const change = reviewState.changes.find((item) => (
      item.fileName === fileName && item.retained && item.start === splice.start && item.originalText === splice.removed
    ));
    if (change) {
      change.retained = false;
      change.end = change.start;
    }
    lastValueByFile.set(fileName, nextValue);
    saveState();
    return false;
  }

  function routeEditorState(next) {
    if (!next || typeof next !== "object") return;
    lastRoutedStateAt = Date.now();
    if (initialEditorHydrationPending && !applyingTrackedHistory) {
      // Keep only the newest bootstrap snapshot. It is deliberately not used as
      // lastValueByFile until project review metadata has been loaded and a final
      // live editor state has been read. This prevents empty -> full-document
      // bootstrap transitions from becoming tracked edits.
      latestInitialEditorState = next;
      currentState = next;
      currentFile = String(next.fileName || "");
      return;
    }
    if (pendingRetainedRestore && !applyingTrackedHistory) {
      // While a tracked deletion is being restored into the physical editor,
      // CollabTeX may emit transient states with the source text absent. Those
      // states are not real review edits. Keep only the newest one and reconcile
      // once the restoration has completed. This is essential for fast cut/paste
      // moves and prevents both missed inserts and spurious replacement records.
      queuedStateDuringRetainedRestore = next;
      return;
    }
    handleEditorState(next);
  }

  function handleEditorState(next) {
    if (!next || typeof next !== "object") return;
    const fileName = String(next.fileName || "");
    const nextValue = String(next.value || "");
    currentState = next;
    currentFile = fileName;
    if (trackingEnabled()) {
      ensureBaseline(fileName, nextValue);
      ensureTrackedHistory(fileName, lastValueByFile.get(fileName) ?? nextValue);
    }

    if (!lastValueByFile.has(fileName)) {
      lastValueByFile.set(fileName, nextValue);
      if (trackingEnabled()) ensureTrackedHistory(fileName, nextValue);
      if (promoteExistingDeleteInsertPairToMove(fileName)) saveState();
      renderPane();
      scheduleOverlayRender();
      updateSelectionPopup();
      updateCursorChange();
      dispatchReviewState();
      return;
    }

    const previous = lastValueByFile.get(fileName);
    if (previous !== nextValue) {
      const splice = singleSplice(previous, nextValue);
      if (splice) {
        const suppressed = suppressedTargetValue !== null && nextValue === suppressedTargetValue;
        if (suppressed) {
          const mode = suppressedMode;
          suppressedTargetValue = null;
          suppressedMode = "";
          if (mode !== "retained-delete-restore" && mode !== "history") {
            transformExistingRecords(fileName, splice);
            if (trackingEnabled() || pendingChangesForFile(fileName).length > 0) {
              updateAcceptedBaseline(fileName, nextValue);
            }
          }
          saveState();
          lastValueByFile.set(fileName, nextValue);
        } else {
          const localAuthor = isLikelyLocalEdit();
          const scope = effectiveTrackingScope();
          const shouldTrack = trackingEnabled() && (scope === "all" || localAuthor);

          if (shouldTrack) ensureTrackedHistory(fileName, previous);

          const insertedChange = shouldTrack
            ? insertionChangeAbsorbingDeletion(fileName, splice, localAuthor)
            : null;

          if (insertedChange) {
            // Deleting text that was itself a pending insertion rewinds that
            // insertion instead of creating a new tracked deletion.
            const oldStart = insertedChange.start;
            transformExistingRecords(fileName, splice);
            shrinkInsertionForDeletion(insertedChange, splice, oldStart);
            saveState();
            lastValueByFile.set(fileName, nextValue);
            pushTrackedHistory(fileName, nextValue);
          } else if (shouldTrack && localAuthor && splice.removed && !splice.added) {
            // Pending deletions remain physically present in the editor so that
            // the cursor can traverse them and deleted paragraph structure is
            // preserved. Only the review metadata changes until Accept is used.
            const recordsBeforeSplit = reviewState.changes
              .filter((change) => change.fileName === fileName)
              .map((change) => ({ ...change }));
            splitMovedChangesBrokenByModification(fileName, splice, recordsBeforeSplit, { retainedEditorState: true });
            const groupingHint = trackedSpliceGroupingHint(fileName, splice, localAuthor, previous);
            recordTrackedSplice(fileName, splice, localAuthor, groupingHint, { retainedDeletion: true });
            saveState();
            pushTrackedHistory(fileName, previous);

            // Temporarily remember the host's deleted value so the restoration
            // state event is recognized as synthetic rather than as an insertion.
            lastValueByFile.set(fileName, nextValue);
            const restoreFile = fileName;
            const restorePrevious = previous;
            const restorePromise = restoreRetainedDeletion(previous, nextValue, splice);
            pendingRetainedRestore = restorePromise;
            void restorePromise.then(async (restored) => {
              if (pendingRetainedRestore !== restorePromise) return;
              pendingRetainedRestore = null;
              const queued = queuedStateDuringRetainedRestore;
              queuedStateDuringRetainedRestore = null;

              if (!restored) {
                if (queued) routeEditorState(queued);
                return;
              }

              // Treat the synthetic reinsertion as already consumed. If the user
              // pasted/typed while restoration was in flight, diff the newest
              // live document against the restored pre-delete document, not
              // against the transient document with the deletion physically
              // missing.
              lastValueByFile.set(restoreFile, restorePrevious);
              const live = await bridgeRequest("getState", {}, 2200).catch(() => null);
              const settled = live?.state || queued;
              if (!settled || String(settled.fileName || "") !== restoreFile) return;
              if (String(settled.value || "") === restorePrevious) {
                currentState = settled;
                currentFile = restoreFile;
                scheduleOverlayRender();
                updateCursorChange();
                dispatchReviewState();
                return;
              }
              routeEditorState(settled);
            }).catch(() => {
              if (pendingRetainedRestore === restorePromise) pendingRetainedRestore = null;
              queuedStateDuringRetainedRestore = null;
            });
          } else {
            const groupingHint = shouldTrack
              ? trackedSpliceGroupingHint(fileName, splice, localAuthor, previous)
              : null;
            const recordsBeforeTransform = reviewState.changes
              .filter((change) => change.fileName === fileName)
              .map((change) => ({ ...change }));
            const moveCandidate = shouldTrack
              ? matchingMoveDeletion(fileName, splice, localAuthor)
              : null;
            transformExistingRecords(fileName, splice);
            if (shouldTrack) {
              keepAdjacentInsertionsOutsideMove(
                fileName,
                splice,
                recordsBeforeTransform,
                moveCandidate?.id || null
              );
              splitRetainedDeletionsBrokenByInsertion(fileName, splice, recordsBeforeTransform);
              splitMovedChangesBrokenByModification(fileName, splice, recordsBeforeTransform);
              recordTrackedSplice(fileName, splice, localAuthor, groupingHint, {
                moveCandidateId: moveCandidate?.id || null
              });
              promoteExistingDeleteInsertPairToMove(fileName);
              pushTrackedHistory(fileName, nextValue);
            } else if (trackingEnabled() || pendingChangesForFile(fileName).length > 0) {
              updateAcceptedBaseline(fileName, nextValue);
            }
            saveState();
            lastValueByFile.set(fileName, nextValue);
          }
        }
      }
    } else {
      scheduleOverlayRender();
      updateSelectionPopup();
    }
    updateCursorChange();
    dispatchReviewState();
  }

  window.addEventListener(STATE_EVENT, (event) => {
    try {
      routeEditorState(interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "{}")));
    } catch (_error) {
      // Ignore transient editor-state payloads while the host switches files.
    }
  });

  function firstVisible(selectors) {
    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        const rect = candidate.getBoundingClientRect?.();
        const style = getComputedStyle(candidate);
        if (rect?.width > 100 && rect?.height > 100 && style.display !== "none" && style.visibility !== "hidden") {
          return candidate;
        }
      }
    }
    return null;
  }

  function attachPane() {
    if (!pane?.isConnected) return false;
    const pdf = firstVisible([
      "#ide-redesign-panel-pdf",
      "[data-testid*='pdf' i]",
      ".pdf-pane"
    ]);
    const editorPanel = firstVisible([
      "#ide-redesign-panel-editor",
      "[data-testid*='editor-panel' i]",
      ".editor-pane"
    ]);
    if (pdf?.parentElement) {
      if (pane.parentElement !== pdf.parentElement || pane.nextElementSibling !== pdf) {
        pdf.parentElement.insertBefore(pane, pdf);
      }
      pane.classList.remove("smarttex-review-pane-floating");
      return true;
    }
    if (editorPanel?.parentElement) {
      editorPanel.insertAdjacentElement("afterend", pane);
      pane.classList.remove("smarttex-review-pane-floating");
      return true;
    }
    if (pane.parentElement !== document.documentElement) document.documentElement.appendChild(pane);
    pane.classList.add("smarttex-review-pane-floating");
    return true;
  }

  function isDarkSurface() {
    const explicitDark = document.documentElement.matches(
      '[data-bs-theme="dark"], [data-theme="dark"], .dark, .theme-dark'
    ) || document.body?.matches?.('.dark, .theme-dark, [data-bs-theme="dark"], [data-theme="dark"]');
    if (explicitDark) return true;
    const editorPanel = firstVisible(["#ide-redesign-panel-editor", ".editor-pane", ".cm-editor", ".ace_editor"]);
    const color = editorPanel ? getComputedStyle(editorPanel).backgroundColor : "";
    const match = color.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
    if (match) return Number(match[1]) + Number(match[2]) + Number(match[3]) < 330;
    return matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;
  }

  function syncPaneTheme() {
    pane?.classList.toggle("smarttex-review-dark", isDarkSurface());
    originalOverlay?.classList.toggle("smarttex-review-dark", isDarkSurface());
  }

  function iconButton(label, symbol, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `smarttex-review-icon-button ${className}`.trim();
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = symbol;
    return button;
  }

  function createPane() {
    // Track Changes controls are integrated into the existing Comments pane.
    // Keep no second review pane in the document.
    pane = null;
    trackToggle = null;
    scopeToggle = null;
    markupSelect = null;
    changeListNode = null;
    minimizeAllButton = null;
    return null;
  }

  function setPaneOpen(value) {
    paneOpen = Boolean(value);
    if (!paneOpen) {
      removeSelectionPopup();
      hideChangePopup();
      removeOriginalOverlay();
    }
    dispatchReviewState();
  }

  window.addEventListener(REVIEW_TOGGLE_EVENT, () => setPaneOpen(!paneOpen));
  window.addEventListener(COMMENTS_PANE_STATE_EVENT, (event) => {
    paneOpen = Boolean(event.detail?.open);
  });
  window.addEventListener(REVIEW_CONTROL_EVENT, async (event) => {
    const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
    if (detail.action === "toggle") {
      toggleTracking();
      return;
    }
    if (detail.action === "markup") {
      const mode = ["final", "markup", "original"].includes(detail.value) ? detail.value : "markup";
      localUi.markupMode = mode;
      scheduleLocalSave(0);
      if (mode !== "markup") {
        activeChangeId = "";
        hideChangePopup();
      }
      scheduleOverlayRender();
      dispatchReviewState();
      return;
    }
    if (detail.action === "accept") await acceptChange(String(detail.id || ""));
    else if (detail.action === "reject") await rejectChange(String(detail.id || ""));
    else if (detail.action === "accept-all") await acceptAllChangesForCurrentFile();
    else if (detail.action === "reject-all") await rejectAllChangesForCurrentFile();
    else if (detail.action === "request-stop") requestStopTracking();
    else if (detail.action === "stop-empty") stopTrackingWithoutChanges();
    else if (detail.action === "stop-accept-all") await stopTrackingAndAcceptAll();
    else if (detail.action === "stop-reject-all") await stopTrackingAndRejectAll();
    else if (detail.action === "jump") {
      const change = reviewState.changes.find((item) => item.id === String(detail.id || ""));
      if (change) jumpToChange(change, String(detail.location || ""));
    }
  });

  function clearPendingChangesForFile(fileName) {
    if (!fileName) return;
    const kept = [];
    for (const change of reviewState.changes) {
      if (change.fileName === fileName) tombstoneItem(change.id);
      else kept.push(change);
    }
    reviewState.changes = kept;
  }

  function snapshotCurrentDocumentAsBaseline() {
    if (!currentFile || !currentState) return;
    clearPendingChangesForFile(currentFile);
    reviewState.baselineByFile[currentFile] = String(currentState.value || "");
    reviewState.baselineUpdatedAtByFile[currentFile] = nowIso();
    trackedHistoryByFile.delete(currentFile);
    ensureTrackedHistory(currentFile, currentState.value);
  }

  function toggleTracking() {
    reviewActivated = true;
    if (trackingEnabled()) return;
    const enable = true;
    snapshotCurrentDocumentAsBaseline();
    reviewState.sharedTracking.enabled = enable;
    reviewState.sharedTracking.updatedAt = nowIso();
    localUi.trackingEnabled = false;
    localUi.trackingScope = "all";
    activeChangeId = "";
    hideChangePopup();
    saveState();
    ensureProjectPolling();
  }

  function changeTrackingScope() {
    reviewActivated = true;
    const toAll = scopeToggle.checked;
    const wasEnabled = trackingEnabled();
    if (toAll) {
      localUi.trackingScope = "all";
      localUi.trackingEnabled = wasEnabled;
      if (wasEnabled) {
        reviewState.sharedTracking.enabled = true;
        reviewState.sharedTracking.updatedAt = nowIso();
      }
    } else {
      if (reviewState.sharedTracking.enabled) {
        reviewState.sharedTracking.enabled = false;
        reviewState.sharedTracking.updatedAt = nowIso();
      }
      localUi.trackingScope = "me";
      localUi.trackingEnabled = wasEnabled;
    }
    saveState();
  }

  function changeLabel(change) {
    return {
      insert: "Added",
      delete: "Deleted",
      replace: "Replaced",
      move: "Moved"
    }[change.type] || "Changed";
  }

  function excerpt(text, maxLength = 180) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
  }

  function changeVisibleRange(change) {
    if (change.type === "move") return { start: change.toStart, end: change.toEnd };
    if (change.type === "delete") {
      return change.retained && change.end > change.start
        ? { start: change.start, end: change.end }
        : { start: change.start, end: change.start };
    }
    return { start: change.start, end: change.end };
  }

  function changeMoveSourceRange(change) {
    return {
      start: Math.max(0, Number(change.fromStart) || 0),
      end: Math.max(Math.max(0, Number(change.fromStart) || 0), Number(change.fromEnd) || Number(change.fromStart) || 0)
    };
  }

  function renderChangeCard(change) {
    const card = document.createElement("article");
    card.className = "smarttex-review-card smarttex-review-change-card";
    card.dataset.changeCard = change.id;
    card.style.setProperty("--smarttex-review-user-color", change.color);
    const text = change.type === "delete" ? change.originalText
      : change.type === "replace" ? `${change.originalText} → ${change.text}`
      : change.text;
    card.innerHTML = `
      <header>
        <span class="smarttex-review-user-dot"></span>
        <strong class="smarttex-review-author"></strong>
        <span class="smarttex-review-kind"></span>
      </header>
      <div class="smarttex-review-excerpt"></div>
      <div class="smarttex-review-card-actions">
        <button type="button" data-review-action="accept" title="Accept change" aria-label="Accept change">✓</button>
        <button type="button" data-review-action="reject" title="Reject change" aria-label="Reject change">×</button>
        <button type="button" data-review-action="comment" title="Add comment" aria-label="Add comment">💬</button>
      </div>`;
    card.querySelector(".smarttex-review-author").textContent = change.author;
    card.querySelector(".smarttex-review-kind").textContent = changeLabel(change);
    const compact = excerpt(text);
    if (compact) {
      card.querySelector(".smarttex-review-excerpt").textContent = compact;
    } else {
      const raw = String(text || "");
      const lineBreaks = (raw.match(/\r\n|\r|\n/g) || []).length;
      card.querySelector(".smarttex-review-excerpt").textContent = lineBreaks
        ? (lineBreaks === 1 ? "↵ line break" : `↵ ${lineBreaks} line breaks`)
        : (raw.length ? "whitespace" : "");
    }
    return card;
  }

  function renderCommentCard(comment) {
    const card = document.createElement("article");
    card.className = "smarttex-review-card smarttex-review-comment-card";
    card.dataset.commentCard = comment.id;
    card.style.setProperty("--smarttex-review-user-color", comment.color);
    if (comment.minimized) card.classList.add("smarttex-review-comment-minimized");

    const header = document.createElement("header");
    const dot = document.createElement("span");
    dot.className = "smarttex-review-user-dot";
    const author = document.createElement("strong");
    author.className = "smarttex-review-author";
    author.textContent = comment.thread[0]?.author || comment.author;
    const collapse = iconButton(
      comment.minimized ? "Expand comment" : "Minimize comment",
      comment.minimized ? "▾" : "▴",
      "smarttex-review-comment-collapse"
    );
    collapse.dataset.reviewAction = "toggle-comment";
    const remove = iconButton("Remove comment", "×", "smarttex-review-comment-remove");
    remove.dataset.reviewAction = "remove-comment";
    header.append(dot, author, collapse, remove);
    card.appendChild(header);

    const firstLine = document.createElement("div");
    firstLine.className = "smarttex-review-comment-first-line";
    firstLine.textContent = excerpt(comment.thread[0]?.text || (comment.kind === "highlight" ? "Highlighted text" : "New comment"), 100);
    card.appendChild(firstLine);

    const body = document.createElement("div");
    body.className = "smarttex-review-comment-body";
    if (comment.draft) {
      const textarea = document.createElement("textarea");
      textarea.className = "smarttex-review-comment-draft";
      textarea.rows = 3;
      textarea.placeholder = "Comment";
      const actions = document.createElement("div");
      actions.className = "smarttex-review-comment-compose-actions";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = "OK";
      ok.dataset.reviewAction = "save-comment";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.dataset.reviewAction = "cancel-comment";
      actions.append(ok, cancel);
      body.append(textarea, actions);
    } else {
      for (const reply of comment.thread) {
        const replyNode = document.createElement("div");
        replyNode.className = "smarttex-review-reply";
        replyNode.style.setProperty("--smarttex-review-user-color", reply.color);
        const replyHeader = document.createElement("strong");
        replyHeader.textContent = reply.author;
        const replyText = document.createElement("div");
        replyText.textContent = reply.text;
        replyNode.append(replyHeader, replyText);
        body.appendChild(replyNode);
      }
      const replyButton = document.createElement("button");
      replyButton.type = "button";
      replyButton.className = "smarttex-review-reply-button";
      replyButton.textContent = "Reply";
      replyButton.dataset.reviewAction = "reply";
      body.appendChild(replyButton);
    }
    card.appendChild(body);
    return card;
  }

  function renderPane() {
    if (!pane?.isConnected) return;
    syncPaneTheme();
    const enabled = trackingEnabled();
    const scope = effectiveTrackingScope();
    trackToggle?.classList.toggle("smarttex-review-tracking-on", enabled);
    trackToggle?.setAttribute("aria-pressed", enabled ? "true" : "false");
    if (scopeToggle) scopeToggle.checked = scope === "all";
    if (markupSelect) markupSelect.value = localUi.markupMode;
    if (!changeListNode) return;

    const items = [
      ...reviewState.changes.filter((item) => item.fileName === currentFile).map((item) => ({ kind: "change", item })),
      ...reviewState.comments.filter((item) => item.fileName === currentFile).map((item) => ({ kind: "comment", item }))
    ].sort((left, right) => {
      const leftStart = left.item.type === "move" ? left.item.toStart : left.item.start;
      const rightStart = right.item.type === "move" ? right.item.toStart : right.item.start;
      return leftStart - rightStart || String(left.item.createdAt).localeCompare(String(right.item.createdAt));
    });

    const fragment = document.createDocumentFragment();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "smarttex-review-empty";
      empty.textContent = "No tracked changes or comments in this file.";
      fragment.appendChild(empty);
    } else {
      for (const entry of items) {
        fragment.appendChild(entry.kind === "change"
          ? renderChangeCard(entry.item)
          : renderCommentCard(entry.item));
      }
    }
    changeListNode.replaceChildren(fragment);
    minimizeAllButton.hidden = !reviewState.comments.some((comment) => (
      comment.fileName === currentFile && !comment.minimized && !comment.draft
    ));
    window.setTimeout(() => {
      changeListNode.querySelector(".smarttex-review-comment-draft")?.focus?.({ preventScroll: true });
    }, 0);
  }

  async function handlePaneClick(event) {
    const actionButton = event.target.closest?.("[data-review-action]");
    const changeCard = event.target.closest?.("[data-change-card]");
    const commentCard = event.target.closest?.("[data-comment-card]");
    if (actionButton) {
      event.preventDefault();
      event.stopPropagation();
      const action = actionButton.dataset.reviewAction;
      if (changeCard) {
        const id = changeCard.dataset.changeCard;
        if (action === "accept") await acceptChange(id);
        else if (action === "reject") await rejectChange(id);
        else if (action === "comment") addCommentForChange(id);
      } else if (commentCard) {
        const id = commentCard.dataset.commentCard;
        if (action === "toggle-comment") toggleCommentMinimized(id);
        else if (action === "remove-comment") removeComment(id);
        else if (action === "save-comment") saveDraftComment(id, commentCard);
        else if (action === "cancel-comment") cancelDraftComment(id);
        else if (action === "reply") showReplyComposer(id, commentCard);
        else if (action === "save-reply") saveReply(id, commentCard);
        else if (action === "cancel-reply") renderPane();
      }
      return;
    }
    if (event.target.closest("textarea, input, select, button")) return;
    if (changeCard) {
      const change = reviewState.changes.find((item) => item.id === changeCard.dataset.changeCard);
      if (change) jumpToChange(change);
    } else if (commentCard) {
      const comment = reviewState.comments.find((item) => item.id === commentCard.dataset.commentCard);
      if (comment) jumpToRange(comment.start, comment.end);
    }
  }

  function linkedComments(changeId) {
    return reviewState.comments.filter((comment) => comment.linkedChangeId === changeId);
  }

  function tombstoneItem(id) {
    reviewState.tombstones[id] = nowIso();
  }

  function removeChangeRecord(change, removeLinkedComments = false) {
    tombstoneItem(change.id);
    reviewState.changes = reviewState.changes.filter((item) => item.id !== change.id);
    for (const comment of linkedComments(change.id)) {
      if (removeLinkedComments) {
        tombstoneItem(comment.id);
        reviewState.comments = reviewState.comments.filter((item) => item.id !== comment.id);
      } else {
        comment.linkedChangeId = "";
        comment.updatedAt = nowIso();
      }
    }
  }

  function askRemoveLinkedComments(change) {
    const comments = linkedComments(change.id);
    if (!comments.length) return false;
    return window.confirm("This change has comments. Also remove the linked comments?");
  }

  async function acceptChange(id) {
    const change = reviewState.changes.find((item) => item.id === id);
    if (!change) return;
    const removeComments = askRemoveLinkedComments(change);

    if (change.type === "move" && change.retained && currentState?.fileName === change.fileName) {
      const source = String(currentState.value || "");
      const fromStart = Math.max(0, Math.min(change.fromStart, source.length));
      const fromEnd = Math.max(fromStart, Math.min(change.fromEnd, source.length));
      const next = source.slice(0, fromStart) + source.slice(fromEnd);
      suppressedTargetValue = next;
      suppressedMode = "accept-retained-move";
      const response = await bridgeRequest("replaceRange", {
        start: fromStart,
        end: fromEnd,
        text: "",
        selectionStart: fromStart,
        selectionEnd: fromStart,
        focus: true
      }, 7000).catch(() => null);
      if (!response?.ok) {
        suppressedTargetValue = null;
        suppressedMode = "";
        return;
      }
      removeChangeRecord(change, removeComments);
      lastValueByFile.set(change.fileName, next);
      currentState = { ...currentState, value: next, cursorIndex: fromStart };
      updateAcceptedBaseline(change.fileName, next);
      pushTrackedHistory(change.fileName, next);
    } else if (change.type === "delete" && change.retained && currentState?.fileName === change.fileName) {
      const source = String(currentState.value || "");
      const next = source.slice(0, change.start) + source.slice(change.end);
      suppressedTargetValue = next;
      suppressedMode = "accept-retained-delete";
      const response = await bridgeRequest("replaceRange", {
        start: change.start,
        end: change.end,
        text: "",
        selectionStart: change.start,
        selectionEnd: change.start,
        focus: true
      }, 7000).catch(() => null);
      if (!response?.ok) {
        suppressedTargetValue = null;
        suppressedMode = "";
        return;
      }
      removeChangeRecord(change, removeComments);
      lastValueByFile.set(change.fileName, next);
      currentState = { ...currentState, value: next, cursorIndex: change.start };
      updateAcceptedBaseline(change.fileName, next);
      pushTrackedHistory(change.fileName, next);
    } else {
      removeChangeRecord(change, removeComments);
      if (currentState?.fileName === change.fileName) updateAcceptedBaseline(change.fileName, currentState.value);
      if (currentState?.fileName === change.fileName) pushTrackedHistory(change.fileName, currentState.value);
    }
    saveState();
    hideChangePopup();
  }

  function sourceAfterReject(change, source) {
    if (change.type === "insert") {
      return source.slice(0, change.start) + source.slice(change.end);
    }
    if (change.type === "delete") {
      return change.retained
        ? source
        : source.slice(0, change.start) + change.originalText + source.slice(change.start);
    }
    if (change.type === "replace") {
      return source.slice(0, change.start) + change.originalText + source.slice(change.end);
    }
    if (change.type === "move") {
      const moved = source.slice(change.toStart, change.toEnd) || change.text;
      const without = source.slice(0, change.toStart) + source.slice(change.toEnd);
      if (change.retained) return without;
      let from = change.fromStart;
      if (from > change.toStart) from -= change.toEnd - change.toStart;
      from = Math.max(0, Math.min(from, without.length));
      return without.slice(0, from) + moved + without.slice(from);
    }
    return source;
  }

  async function rejectChange(id) {
    const change = reviewState.changes.find((item) => item.id === id);
    if (!change || !currentState || currentState.fileName !== change.fileName) return;
    const removeComments = askRemoveLinkedComments(change);
    const source = String(currentState.value || "");

    if (change.type === "delete" && change.retained) {
      // The pending deletion is still physically present in the editor. Rejecting
      // it therefore only removes the review metadata; no editor rewrite is needed.
      removeChangeRecord(change, removeComments);
      updateAcceptedBaseline(change.fileName, source);
      pushTrackedHistory(change.fileName, source);
      saveState();
      hideChangePopup();
      return;
    }

    const next = sourceAfterReject(change, source);
    suppressedTargetValue = next;
    suppressedMode = "reject-change";
    const response = await bridgeRequest("replaceRange", {
      start: 0,
      end: source.length,
      text: next,
      selectionStart: Math.min(next.length, change.type === "move" ? change.fromStart : change.start),
      selectionEnd: Math.min(next.length, change.type === "move" ? change.fromStart : change.start),
      focus: true
    }, 7000);
    if (!response?.ok) {
      suppressedTargetValue = null;
      suppressedMode = "";
      return;
    }
    removeChangeRecord(change, removeComments);
    updateAcceptedBaseline(change.fileName, next);
    lastValueByFile.set(change.fileName, next);
    currentState = { ...currentState, value: next };
    pushTrackedHistory(change.fileName, next);
    saveState();
    hideChangePopup();
  }

  function detachAllLinkedCommentsForChanges(changes) {
    const ids = new Set(changes.map((change) => change.id));
    for (const comment of reviewState.comments) {
      if (!ids.has(comment.linkedChangeId)) continue;
      comment.linkedChangeId = "";
      comment.updatedAt = nowIso();
    }
  }

  function removeChangesWithoutPrompt(changes) {
    detachAllLinkedCommentsForChanges(changes);
    const ids = new Set(changes.map((change) => change.id));
    for (const change of changes) tombstoneItem(change.id);
    reviewState.changes = reviewState.changes.filter((change) => !ids.has(change.id));
  }

  async function acceptAllChangesForCurrentFile() {
    if (!currentFile) return;
    const changes = reviewState.changes.filter((change) => change.fileName === currentFile);
    if (!changes.length) return;

    // Retained deletions are real editor text until accepted. Remove them from
    // right to left so every individual range transformation stays exact for
    // comments and the remaining review records.
    if (currentState?.fileName === currentFile) {
      const retained = changes
        .flatMap((change) => {
          if (change.type === "delete" && change.retained && change.end > change.start) {
            return [{ change, start: change.start, end: change.end, mode: "accept-retained-delete" }];
          }
          if (change.type === "move" && change.retained && change.fromEnd > change.fromStart) {
            return [{ change, start: change.fromStart, end: change.fromEnd, mode: "accept-retained-move" }];
          }
          return [];
        })
        .sort((left, right) => right.start - left.start);
      for (const item of retained) {
        const source = String(currentState.value || "");
        const start = Math.max(0, Math.min(item.start, source.length));
        const end = Math.max(start, Math.min(item.end, source.length));
        const next = source.slice(0, start) + source.slice(end);
        suppressedTargetValue = next;
        suppressedMode = item.mode;
        const response = await bridgeRequest("replaceRange", {
          start,
          end,
          text: "",
          selectionStart: start,
          selectionEnd: start,
          focus: false
        }, 7000).catch(() => null);
        if (!response?.ok) {
          suppressedTargetValue = null;
          suppressedMode = "";
          return;
        }
        lastValueByFile.set(currentFile, next);
        currentState = { ...currentState, value: next, cursorIndex: Math.min(start, next.length) };
      }
    }

    removeChangesWithoutPrompt(changes);
    if (currentState?.fileName === currentFile) {
      reviewState.baselineByFile[currentFile] = String(currentState.value || "");
      reviewState.baselineUpdatedAtByFile[currentFile] = nowIso();
      pushTrackedHistory(currentFile, currentState.value);
    }
    activeChangeId = "";
    hideChangePopup();
    saveState();
  }

  async function rejectAllChangesForCurrentFile() {
    if (!currentFile || !currentState || currentState.fileName !== currentFile) return;
    const changes = reviewState.changes.filter((change) => change.fileName === currentFile);
    if (!changes.length) return;
    const source = String(currentState.value || "");
    const baseline = Object.prototype.hasOwnProperty.call(reviewState.baselineByFile, currentFile)
      ? String(reviewState.baselineByFile[currentFile] || "")
      : reconstructAcceptedForFile(source, currentFile);
    suppressedTargetValue = baseline;
    const response = await bridgeRequest("replaceRange", {
      start: 0,
      end: source.length,
      text: baseline,
      selectionStart: 0,
      selectionEnd: 0,
      focus: true
    }, 7000).catch(() => null);
    if (!response?.ok) {
      suppressedTargetValue = null;
      return;
    }
    removeChangesWithoutPrompt(changes);
    reviewState.baselineByFile[currentFile] = baseline;
    reviewState.baselineUpdatedAtByFile[currentFile] = nowIso();
    lastValueByFile.set(currentFile, baseline);
    currentState = { ...currentState, value: baseline, cursorIndex: 0 };
    activeChangeId = "";
    hideChangePopup();
    saveState();
  }

  function clearAllReviewReferencesAndChanges() {
    const allChanges = [...reviewState.changes];
    removeChangesWithoutPrompt(allChanges);
    reviewState.baselineByFile = {};
    reviewState.baselineUpdatedAtByFile = {};
    reviewState.baselineClearedAt = nowIso();
    reviewState.sharedTracking.enabled = false;
    reviewState.sharedTracking.updatedAt = nowIso();
    activeChangeId = "";
    hideChangePopup();
    removeOriginalOverlay();
  }

  function requestStopTracking() {
    pruneIneffectiveChanges();
    if (reviewState.changes.some(isEffectiveChange)) {
      window.dispatchEvent(new CustomEvent(REVIEW_STOP_CONFIRM_EVENT));
      dispatchReviewState();
      return;
    }
    stopTrackingWithoutChanges();
  }

  function stopTrackingWithoutChanges() {
    // Query the authoritative review state rather than the pane's last render.
    // Empty/stale zero-length records are pruned so a fully resolved document
    // can stop tracking immediately without an unnecessary confirmation dialog.
    pruneIneffectiveChanges();
    if (reviewState.changes.some(isEffectiveChange)) return;
    clearAllReviewReferencesAndChanges();
    trackedHistoryByFile.clear();
    saveState();
  }

  async function stopTrackingAndAcceptAll() {
    if (currentFile) await acceptAllChangesForCurrentFile();
    clearAllReviewReferencesAndChanges();
    trackedHistoryByFile.clear();
    saveState();
  }

  async function stopTrackingAndRejectAll() {
    if (currentFile && currentState?.fileName === currentFile) {
      const source = String(currentState.value || "");
      const hasBaseline = Object.prototype.hasOwnProperty.call(reviewState.baselineByFile, currentFile);
      const baseline = hasBaseline
        ? String(reviewState.baselineByFile[currentFile] || "")
        : reconstructAcceptedForFile(source, currentFile);
      if (baseline !== source) {
        suppressedTargetValue = baseline;
        const response = await bridgeRequest("replaceRange", {
          start: 0,
          end: source.length,
          text: baseline,
          selectionStart: 0,
          selectionEnd: 0,
          focus: true
        }, 7000).catch(() => null);
        if (!response?.ok) {
          suppressedTargetValue = null;
          return;
        }
        lastValueByFile.set(currentFile, baseline);
        currentState = { ...currentState, value: baseline, cursorIndex: 0 };
      }
    }
    clearAllReviewReferencesAndChanges();
    trackedHistoryByFile.clear();
    saveState();
  }

  function addCommentDraft(start, end, linkedChangeId = "") {
    reviewActivated = true;
    const timestamp = nowIso();
    const comment = {
      id: randomId("comment"),
      fileName: currentFile,
      start: Math.max(0, start),
      end: Math.max(start, end),
      author: identity.name,
      authorId: identityAuthorId,
      color: identity.color,
      kind: "comment",
      linkedChangeId,
      minimized: false,
      draft: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      thread: []
    };
    reviewState.comments.push(comment);
    renderPane();
    scheduleOverlayRender();
    const card = pane?.querySelector(`[data-comment-card="${CSS.escape(comment.id)}"]`);
    card?.scrollIntoView?.({ block: "nearest" });
    return comment;
  }

  function addCommentForChange(changeId) {
    const change = reviewState.changes.find((item) => item.id === changeId);
    if (!change) return;
    const range = changeVisibleRange(change);
    window.dispatchEvent(new CustomEvent(ADD_RANGE_COMMENT_EVENT, {
      detail: { fileName: change.fileName, start: range.start, end: range.end, changeId: change.id }
    }));
    hideChangePopup();
  }

  function saveDraftComment(id, card) {
    const comment = reviewState.comments.find((item) => item.id === id);
    if (!comment?.draft) return;
    const text = String(card.querySelector(".smarttex-review-comment-draft")?.value || "").trim();
    if (!text) return;
    comment.thread = [{
      id: randomId("reply"),
      author: identity.name,
      authorId: identityAuthorId,
      color: identity.color,
      text,
      createdAt: nowIso()
    }];
    comment.author = identity.name;
    comment.authorId = identityAuthorId;
    comment.color = identity.color;
    comment.draft = false;
    comment.updatedAt = nowIso();
    saveState();
  }

  function cancelDraftComment(id) {
    reviewState.comments = reviewState.comments.filter((item) => item.id !== id);
    renderPane();
    scheduleOverlayRender();
  }

  function addHighlight(start, end) {
    if (end <= start) return;
    reviewActivated = true;
    const timestamp = nowIso();
    reviewState.comments.push({
      id: randomId("highlight"),
      fileName: currentFile,
      start,
      end,
      author: identity.name,
      authorId: identityAuthorId,
      color: identity.color,
      kind: "highlight",
      linkedChangeId: "",
      minimized: false,
      draft: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      thread: []
    });
    saveState();
    removeSelectionPopup();
  }

  function toggleCommentMinimized(id) {
    const comment = reviewState.comments.find((item) => item.id === id);
    if (!comment) return;
    comment.minimized = !comment.minimized;
    comment.updatedAt = nowIso();
    saveState();
  }

  function removeComment(id) {
    const comment = reviewState.comments.find((item) => item.id === id);
    if (!comment) return;
    tombstoneItem(id);
    reviewState.comments = reviewState.comments.filter((item) => item.id !== id);
    saveState();
  }

  function showReplyComposer(id, card) {
    const comment = reviewState.comments.find((item) => item.id === id);
    if (!comment) return;
    const body = card.querySelector(".smarttex-review-comment-body");
    if (!body || body.querySelector(".smarttex-review-reply-compose")) return;
    const compose = document.createElement("div");
    compose.className = "smarttex-review-reply-compose";
    compose.innerHTML = `
      <textarea rows="2" placeholder="Reply"></textarea>
      <div class="smarttex-review-comment-compose-actions">
        <button type="button" data-review-action="save-reply">OK</button>
        <button type="button" data-review-action="cancel-reply">Cancel</button>
      </div>`;
    body.appendChild(compose);
    compose.querySelector("textarea")?.focus?.();
  }

  function saveReply(id, card) {
    const comment = reviewState.comments.find((item) => item.id === id);
    if (!comment) return;
    const text = String(card.querySelector(".smarttex-review-reply-compose textarea")?.value || "").trim();
    if (!text) return;
    comment.thread.push({
      id: randomId("reply"),
      author: identity.name,
      authorId: identityAuthorId,
      color: identity.color,
      text,
      createdAt: nowIso()
    });
    comment.updatedAt = nowIso();
    comment.minimized = false;
    saveState();
  }

  function nextAnimationFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  async function jumpToRange(start, end) {
    const anchor = Math.max(0, Number(start) || 0);
    const head = Math.max(anchor, Number(end) || anchor);
    const selection = { anchor, head, focus: true };

    // The editor can finish a pane/layout update one frame after the first
    // selection dispatch. Verify that the requested range is actually visible
    // and repeat the reveal once only when necessary. This makes a single
    // click on a change card reliably navigate to the change.
    await bridgeRequest("setSelection", selection, 3000).catch(() => null);
    await nextAnimationFrame();
    const visible = await bridgeRequest("getRangeRects", { start: anchor, end: head }, 2500)
      .catch(() => ({ rects: [] }));
    if (!Array.isArray(visible?.rects) || visible.rects.length === 0) {
      await bridgeRequest("setSelection", selection, 3000).catch(() => null);
      await nextAnimationFrame();
    }
    flashRange(anchor, head);
  }

  async function jumpToChange(change, location = "") {
    activeChangeId = change.id;
    scheduleOverlayRender();
    const range = change.type === "move" && location === "from"
      ? changeMoveSourceRange(change)
      : changeVisibleRange(change);
    await jumpToRange(range.start, range.end);
  }

  async function flashRange(start, end) {
    ensureOverlayLayers();
    temporaryLayer.replaceChildren();
    try {
      const response = await bridgeRequest("getRangeRects", { start, end }, 3000);
      for (const rect of response.rects || []) {
        const marker = document.createElement("div");
        marker.className = "smarttex-review-temporary-highlight";
        marker.style.left = `${rect.left}px`;
        marker.style.top = `${rect.top}px`;
        marker.style.width = `${Math.max(4, rect.right - rect.left)}px`;
        marker.style.height = `${Math.max(12, rect.bottom - rect.top)}px`;
        temporaryLayer.appendChild(marker);
      }
      window.setTimeout(() => temporaryLayer?.replaceChildren(), 2000);
    } catch (_error) {
      // Selection itself still moves the editor to the requested position.
    }
  }

  function ensureOverlayLayers() {
    if (!commentHighlightLayer?.isConnected) {
      commentHighlightLayer = document.createElement("div");
      commentHighlightLayer.id = "smarttex-review-comment-highlights";
      document.documentElement.appendChild(commentHighlightLayer);
    }
    if (!markupLayer?.isConnected) {
      markupLayer = document.createElement("div");
      markupLayer.id = "smarttex-review-markup-layer";
      document.documentElement.appendChild(markupLayer);
    }
    if (!temporaryLayer?.isConnected) {
      temporaryLayer = document.createElement("div");
      temporaryLayer.id = "smarttex-review-temporary-layer";
      document.documentElement.appendChild(temporaryLayer);
    }
    if (!presenceLayer?.isConnected) {
      presenceLayer = document.createElement("div");
      presenceLayer.id = "smarttex-collaboration-presence-layer";
      document.documentElement.appendChild(presenceLayer);
    }
  }

  function scheduleOverlayRender() {
    if (overlayFrame) return;
    overlayFrame = window.requestAnimationFrame(() => {
      overlayFrame = 0;
      renderOverlays().catch(() => {});
    });
  }

  function rgba(hex, alpha) {
    const value = validColor(hex).slice(1);
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function addRect(layer, rect, className, styles = {}) {
    const node = document.createElement("div");
    node.className = className;
    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    node.style.width = `${Math.max(2, rect.right - rect.left)}px`;
    node.style.height = `${Math.max(2, rect.bottom - rect.top)}px`;
    for (const [property, value] of Object.entries(styles)) {
      if (property.startsWith("--")) node.style.setProperty(property, value);
      else node.style[property] = value;
    }
    layer.appendChild(node);
    return node;
  }

  function clipPresenceRect(rect, bounds) {
    if (!rect || !bounds) return null;
    const clipped = {
      left: Math.max(Number(bounds.left), Number(rect.left)),
      right: Math.min(Number(bounds.right), Number(rect.right)),
      top: Math.max(Number(bounds.top), Number(rect.top)),
      bottom: Math.min(Number(bounds.bottom), Number(rect.bottom))
    };
    if (!Object.values(clipped).every(Number.isFinite)) return null;
    return clipped.right > clipped.left && clipped.bottom > clipped.top ? clipped : null;
  }

  function installChangeHitTarget(rect, change) {
    const hit = addRect(markupLayer, rect, "smarttex-review-change-hit");
    hit.dataset.changeId = change.id;
  }

  function lineRectsForStrike(rects, lineHeightValue) {
    const lineHeight = Math.max(2, Number(lineHeightValue) || 16);
    const result = [];
    for (const rect of rects || []) {
      const height = Math.max(0, rect.bottom - rect.top);
      if (height <= lineHeight * 1.5) {
        result.push(rect);
        continue;
      }

      // getRangeRects intentionally coalesces all fully covered middle lines
      // into one tall rectangle. A strike-through must instead be painted once
      // per visual editor line (including wrapped lines), otherwise a multiline
      // Move shows only one horizontal strike through the middle of the block.
      for (let top = rect.top; top < rect.bottom - 1; top += lineHeight) {
        result.push({
          ...rect,
          top,
          bottom: Math.min(rect.bottom, top + lineHeight)
        });
      }
    }
    return result;
  }

  async function renderChangeMarkup(change, mode, generation) {
    const range = changeVisibleRange(change);
    if (mode === "final" || mode === "original") return;
    const authorColor = validColor(change.color, "#64748b");
    const authorStyles = {
      "--smarttex-review-author-color": authorColor,
      "--smarttex-review-author-soft": rgba(authorColor, 0.14)
    };
    const response = await bridgeRequest("getRangeRects", range, 3000).catch(() => ({ rects: [] }));
    if (generation !== overlayGeneration) return;
    const rects = response.rects || [];
    const pointRect = rects[0] || null;
    const active = change.id === activeChangeId;
    const activeClass = change.type === "move" ? "smarttex-review-active-move"
      : change.type === "delete" ? "smarttex-review-active-delete" : "smarttex-review-active-add";
    if (active) {
      for (const rect of rects) addRect(markupLayer, rect, `smarttex-review-active-change ${activeClass}`, authorStyles);
      if (!rects.length && pointRect) addRect(markupLayer, pointRect, `smarttex-review-active-change ${activeClass}`, authorStyles);
    }

    if (mode === "markup") {
      if (["insert", "replace"].includes(change.type)) {
        for (const rect of lineRectsForStrike(rects, response.lineHeight)) {
          addRect(markupLayer, rect, "smarttex-review-addition-line", authorStyles);
          installChangeHitTarget(rect, change);
        }
      }
      if (change.type === "delete" && change.retained) {
        for (const rect of lineRectsForStrike(rects, response.lineHeight)) {
          addRect(markupLayer, rect, "smarttex-review-deletion-line", authorStyles);
          installChangeHitTarget(rect, change);
        }
      } else if (["delete", "replace"].includes(change.type) && pointRect) {
        const deletion = document.createElement("span");
        deletion.className = `smarttex-review-deleted-text${active ? " smarttex-review-deleted-text-active" : ""}`;
        deletion.textContent = change.originalText;
        deletion.style.left = `${pointRect.left}px`;
        deletion.style.top = `${pointRect.top}px`;
        deletion.style.setProperty("--smarttex-review-author-color", authorColor);
        deletion.style.setProperty("--smarttex-review-author-soft", rgba(authorColor, 0.14));
        deletion.dataset.changeId = change.id;
        markupLayer.appendChild(deletion);
        const hitRect = {
          left: pointRect.left - 3,
          right: Math.max(pointRect.right + 12, pointRect.left + 28),
          top: pointRect.top,
          bottom: pointRect.bottom
        };
        installChangeHitTarget(hitRect, change);
      }
      if (change.type === "move") {
        const sourceRange = changeMoveSourceRange(change);
        const fromResponse = await bridgeRequest("getRangeRects", sourceRange, 3000).catch(() => ({ rects: [] }));
        if (generation !== overlayGeneration) return;
        const fromRects = fromResponse.rects || [];
        if (change.retained && fromRects.length) {
          for (const rect of lineRectsForStrike(fromRects, fromResponse.lineHeight)) {
            addRect(markupLayer, rect, "smarttex-review-move-deletion-line", authorStyles);
            installChangeHitTarget(rect, change);
            if (active) addRect(markupLayer, rect, "smarttex-review-active-change smarttex-review-active-move", authorStyles);
          }
        } else {
          const from = fromRects[0];
          if (from) {
            addRect(markupLayer, { ...from, right: from.left + 4 }, "smarttex-review-move-origin", authorStyles);
            installChangeHitTarget({ ...from, right: from.left + 12 }, change);
          }
        }
        const targetLineRects = lineRectsForStrike(rects, response.lineHeight);
        if (targetLineRects.length) {
          // Draw one continuous green bar whose vertical extent exactly follows
          // the visible moved text. Per-line bars can leave gaps between visual
          // editor rows and make the marker look shorter than the moved block.
          const moveTargetBounds = targetLineRects.reduce((bounds, to) => ({
            top: Math.min(bounds.top, to.top),
            bottom: Math.max(bounds.bottom, to.bottom)
          }), { top: Infinity, bottom: -Infinity });
          const gutterX = Number(response.gutterX);
          const fallbackLeft = Math.min(...targetLineRects.map((to) => to.left)) - 6;
          const markerLeft = Number.isFinite(gutterX) ? gutterX + 1 : fallbackLeft;
          addRect(markupLayer, {
            left: markerLeft,
            right: markerLeft + 4,
            top: moveTargetBounds.top,
            bottom: moveTargetBounds.bottom
          }, "smarttex-review-move-target", authorStyles);
          for (const to of targetLineRects) {
            addRect(markupLayer, to, "smarttex-review-move-destination", authorStyles);
            installChangeHitTarget(to, change);
          }
        }
      }
    } else if (mode === "simple") {
      if (["delete", "replace"].includes(change.type) && pointRect) {
        addRect(markupLayer, { ...pointRect, right: pointRect.left + 4 }, "smarttex-review-simple-deletion", authorStyles);
        installChangeHitTarget({ ...pointRect, right: pointRect.left + 12 }, change);
      } else if (change.type === "move") {
        const fromResponse = await bridgeRequest("getRangeRects", changeMoveSourceRange(change), 3000).catch(() => ({ rects: [] }));
        const from = fromResponse.rects?.[0];
        if (from) {
          addRect(markupLayer, { ...from, right: from.left + 4 }, "smarttex-review-simple-deletion", authorStyles);
          installChangeHitTarget({ ...from, right: from.left + 12 }, change);
        }
      } else {
        for (const rect of rects) installChangeHitTarget(rect, change);
      }
    }
  }

  async function renderCommentHighlight(comment, generation) {
    const response = await bridgeRequest("getRangeRects", {
      start: comment.start,
      end: comment.end
    }, 3000).catch(() => ({ rects: [] }));
    if (generation !== overlayGeneration) return;
    for (const rect of response.rects || []) {
      const node = addRect(commentHighlightLayer, rect, "smarttex-review-comment-highlight", {
        background: rgba(comment.color, 0.28)
      });
      node.dataset.commentId = comment.id;
    }
  }

  async function renderCollaboratorPresence(presence, generation) {
    if (!presence || Date.now() - Number(presence.updatedAt || 0) > 12000) return;
    const currentDocumentId = String(currentState?.documentId || "");
    if (presence.documentId && currentDocumentId && presence.documentId !== currentDocumentId) return;
    const sourceLength = String(currentState?.value || "").length;
    const anchor = Math.max(0, Math.min(sourceLength, Number(presence.selectionAnchor) || 0));
    const head = Math.max(0, Math.min(sourceLength, Number(presence.selectionHead ?? presence.cursorIndex) || 0));
    const color = validColor(presence.color, "#64748b");
    const styles = {
      "--smarttex-collaborator-color": color,
      "--smarttex-collaborator-soft": rgba(color, 0.18)
    };
    if (anchor !== head) {
      const response = await bridgeRequest("getRangeRects", {
        start: Math.min(anchor, head),
        end: Math.max(anchor, head)
      }, 2500).catch(() => ({ rects: [] }));
      if (generation !== overlayGeneration) return;
      for (const rect of response.rects || []) {
        const visibleRect = clipPresenceRect(rect, response.bounds);
        if (visibleRect) {
          addRect(presenceLayer, visibleRect, "smarttex-collaborator-selection", styles);
        }
      }
    }
    const response = await bridgeRequest("getCoordinates", { index: head }, 2500).catch(() => null);
    if (generation !== overlayGeneration || !response?.screen || !response?.bounds) return;
    const screen = response.screen;
    const left = Number(screen.pageX) - window.scrollX;
    const top = Number(screen.pageY) - window.scrollY;
    const lineHeight = Math.max(14, Number(screen.lineHeight) || 16);
    const visibleCursor = clipPresenceRect({
      left,
      right: left + 2,
      top,
      bottom: top + lineHeight
    }, response.bounds);
    // Some editor coordinate APIs return the nearest viewport edge for an
    // off-screen document position. Never turn that into a cursor or a name
    // badge outside the editor (for example in Overleaf's top navigation).
    if (!visibleCursor) return;
    // Always paint the SmartTeX caret and label, including a collapsed range.
    // The host's native cursor remains a transport/fallback layer, but must not
    // decide which identity is displayed: SmartTeX owns the selected name and
    // colour for both a selection and a cursor-only presence update.
    const cursor = addRect(
      presenceLayer,
      visibleCursor,
      "smarttex-collaborator-cursor",
      styles
    );
    cursor.dataset.collaboratorId = presence.id;
    const label = document.createElement("div");
    label.className = "smarttex-collaborator-label";
    label.textContent = presence.name || "Anonymous";
    label.style.left = `${Math.max(Number(response.bounds.left), visibleCursor.right)}px`;
    label.style.top = `${Math.max(Number(response.bounds.top), visibleCursor.top - 18)}px`;
    for (const [property, value] of Object.entries(styles)) {
      label.style.setProperty(property, value);
    }
    presenceLayer.appendChild(label);
  }

  async function renderOverlays() {
    ensureOverlayLayers();
    const generation = ++overlayGeneration;
    markupLayer.replaceChildren();
    commentHighlightLayer.replaceChildren();
    presenceLayer.replaceChildren();
    if (!currentState || !currentFile) {
      removeOriginalOverlay();
      return;
    }

    const comments = reviewState.comments.filter((comment) => comment.fileName === currentFile);
    const changes = reviewState.changes.filter((change) => change.fileName === currentFile);
    const collaborators = [...collaboratorPresence.values()];
    await Promise.all([
      ...comments.map((comment) => renderCommentHighlight(comment, generation)),
      ...collaborators.map((presence) => renderCollaboratorPresence(presence, generation))
    ]);
    if (generation !== overlayGeneration) return;

    if (localUi.markupMode === "original") {
      await showOriginalOverlay();
      return;
    }
    removeOriginalOverlay();
    await Promise.all(changes.map((change) => renderChangeMarkup(change, localUi.markupMode, generation)));
  }

  async function showOriginalOverlay() {
    if (!currentState) return;
    let response;
    try {
      response = await bridgeRequest("getEditorBounds", {}, 3000);
    } catch (_error) {
      return;
    }
    const bounds = response?.bounds;
    if (!bounds) return;
    if (!originalOverlay?.isConnected) {
      originalOverlay = document.createElement("textarea");
      originalOverlay.id = "smarttex-review-original-overlay";
      originalOverlay.readOnly = true;
      originalOverlay.setAttribute("aria-label", "Original accepted version");
      document.documentElement.appendChild(originalOverlay);
    }
    originalOverlay.value = reviewState.baselineByFile[currentFile] ?? currentState.value;
    originalOverlay.style.left = `${bounds.left}px`;
    originalOverlay.style.top = `${bounds.top}px`;
    originalOverlay.style.width = `${Math.max(0, bounds.right - bounds.left)}px`;
    originalOverlay.style.height = `${Math.max(0, bounds.bottom - bounds.top)}px`;
    syncPaneTheme();
  }

  function removeOriginalOverlay() {
    originalOverlay?.remove();
    originalOverlay = null;
  }

  function removeSelectionPopup() {
    selectionPopup?.remove();
    selectionPopup = null;
  }

  async function updateSelectionPopup() {
    removeSelectionPopup();
  }

  function cursorTouchesChange(change, cursor) {
    if (!change || change.fileName !== currentFile) return false;
    const index = Math.max(0, Number(cursor) || 0);
    if (change.type === "delete" && !change.retained) return index === change.start;
    const range = changeVisibleRange(change);
    return index >= range.start && index <= range.end;
  }

  function changeAtCursor() {
    const cursor = Math.max(0, Number(currentState?.cursorIndex) || 0);
    return reviewState.changes
      .filter((change) => cursorTouchesChange(change, cursor))
      .sort((a, b) => {
        const ar = changeVisibleRange(a);
        const br = changeVisibleRange(b);
        return (ar.end - ar.start) - (br.end - br.start);
      })[0] || null;
  }

  async function updateCursorChange() {
    const change = localUi.markupMode === "markup" ? changeAtCursor() : null;
    const nextId = change?.id || "";
    if (nextId === activeChangeId) return;
    activeChangeId = nextId;
    scheduleOverlayRender();
    hideChangePopup();
    if (!change) return;
    const request = ++activeChangePopupRequest;
    const range = changeVisibleRange(change);
    const response = await bridgeRequest("getRangeRects", range, 2500).catch(() => ({ rects: [] }));
    if (request !== activeChangePopupRequest || activeChangeId !== change.id) return;
    const rect = response.rects?.[0];
    if (rect) showChangePopup(change, rect);
  }

  function hideChangePopup() {
    changePopup?.remove();
    changePopup = null;
  }

  function applyReviewAuthorProfile(authorIdValue, nextIdentity, legacyIdentity = null) {
    const targetAuthorId = String(authorIdValue || "");
    if (!targetAuthorId) return false;
    const name = String(nextIdentity?.name || "anonymous").trim().slice(0, 80) || "anonymous";
    const color = validColor(nextIdentity?.color);
    const legacyName = String(legacyIdentity?.name || "");
    const legacyColor = validColor(legacyIdentity?.color, "#000000");
    const timestamp = nowIso();
    let changed = false;
    const matches = (record) => (
      String(record?.authorId || "") === targetAuthorId ||
      (!record?.authorId && legacyName && record?.author === legacyName && validColor(record?.color, "#000000") === legacyColor)
    );
    const update = (record) => {
      if (!matches(record)) return;
      if (record.author === name && record.color === color && record.authorId === targetAuthorId) return;
      record.author = name;
      record.authorId = targetAuthorId;
      record.color = color;
      if ("updatedAt" in record) record.updatedAt = timestamp;
      changed = true;
    };
    for (const change of reviewState.changes) update(change);
    for (const comment of reviewState.comments) {
      update(comment);
      for (const reply of comment.thread || []) update(reply);
    }
    return changed;
  }

  function scrollChangeCardIntoView(changeId) {
    const card = pane?.querySelector(`[data-change-card="${CSS.escape(changeId)}"]`);
    card?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    card?.classList.add("smarttex-review-card-linked");
    window.setTimeout(() => card?.classList.remove("smarttex-review-card-linked"), 900);
  }

  function showChangePopup(change, rect) {
    if (!change || !rect || localUi.markupMode !== "markup") return;
    hideChangePopup();
    changePopup = document.createElement("div");
    changePopup.id = "smarttex-review-change-popup";
    const timestamp = new Date(change.updatedAt || change.createdAt || Date.now());
    const when = Number.isNaN(timestamp.getTime()) ? String(change.updatedAt || "") : timestamp.toLocaleString();
    changePopup.innerHTML = `
      <div class="smarttex-review-change-popup-actions">
        <button type="button" class="smarttex-review-accept" data-change-popup-action="accept" title="Accept change" aria-label="Accept change">✓</button>
        <button type="button" class="smarttex-review-reject" data-change-popup-action="reject" title="Reject change" aria-label="Reject change">×</button>
        <button type="button" class="smarttex-review-info" data-change-popup-action="info" title="Change information" aria-label="Change information">ⓘ</button>
        <button type="button" class="smarttex-review-comment" data-change-popup-action="comment" title="Add comment to this change" aria-label="Add comment to this change">💬</button>
      </div>
      <div class="smarttex-review-change-info" hidden></div>`;
    const info = changePopup.querySelector(".smarttex-review-change-info");
    info.textContent = `${change.author || "anonymous"} · ${when}`;
    changePopup.addEventListener("pointerdown", (event) => event.preventDefault());
    changePopup.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-change-popup-action]");
      if (!button) return;
      const action = button.dataset.changePopupAction;
      if (action === "accept") await acceptChange(change.id);
      else if (action === "reject") await rejectChange(change.id);
      else if (action === "comment") addCommentForChange(change.id);
      else if (action === "info") info.hidden = !info.hidden;
    });
    document.documentElement.appendChild(changePopup);
    const popupWidth = 168;
    changePopup.style.left = `${Math.min(window.innerWidth - popupWidth - 6, Math.max(5, rect.right + 6))}px`;
    changePopup.style.top = `${Math.min(window.innerHeight - 46, Math.max(5, rect.top - 40))}px`;
  }

  async function loadInitialState() {
    const stored = await extensionApi.storage.local.get([
      COMMENT_PROFILE_KEY, REVIEW_USER_KEY, REVIEW_UI_KEY, localReviewKey, AUTHOR_ID_KEY
    ]);
    identity = normalizedIdentity(stored?.[COMMENT_PROFILE_KEY] || stored?.[REVIEW_USER_KEY]);
    identityAuthorId = String(stored?.[AUTHOR_ID_KEY] || "");
    window.dispatchEvent(new CustomEvent(COLLABORATION_PROFILE_EVENT, {
      detail: JSON.stringify({ name: identity.name, color: identity.color, authorId: identityAuthorId })
    }));
    popupTrigger = stored?.[REVIEW_UI_KEY]?.popupTrigger === "click" ? "click" : "hover";
    const local = stored?.[localReviewKey] || {};
    localUi = normalizedLocalUi(local.ui);
    reviewState = normalizeReviewState(local.shared);
    applyReviewAuthorProfile(identityAuthorId, identity, identity);
    reviewActivated = true;
    createPane();
    renderPane();
    dispatchReviewState();

    // Capture editor events during metadata hydration, but do not diff them yet.
    // CollabTeX can transiently expose an empty source buffer during reload.
    try {
      const response = await bridgeRequest("getState", {}, 5000);
      if (response?.state) routeEditorState(response.state);
    } catch (_error) {
      // A later editor-state event or the final state read below will initialize review.
    }

    try {
      const remote = await readRemoteReviewState();
      reviewState = mergeReviewStates(reviewState, remote);
      applyReviewAuthorProfile(identityAuthorId, identity, identity);
      projectFileKnown = true;
      lastFullRemoteReadAt = Date.now();
      scheduleLocalSave(0);
    } catch (_error) {
      // Review metadata does not exist in projects that have not used review yet.
    }

    // Read the live document once more after metadata hydration. This is the only
    // state allowed to seed lastValueByFile on reload; earlier bootstrap states
    // may contain an empty or partially initialized editor buffer.
    let settledState = null;
    try {
      const response = await bridgeRequest("getState", {}, 5000);
      settledState = response?.state || null;
    } catch (_error) {
      settledState = null;
    }
    if (!settledState) settledState = latestInitialEditorState;
    initialEditorHydrationPending = false;
    latestInitialEditorState = null;
    if (settledState) seedInitialEditorState(settledState);
    else {
      renderPane();
      scheduleOverlayRender();
      dispatchReviewState();
    }

    reviewActivated = trackingEnabled() || reviewState.changes.length > 0;
    ensureProjectPolling();
    reviewActivated = true;
    ensureProjectPolling();
  }

  window.addEventListener(COLLABORATION_PRESENCE_EVENT, (event) => {
    let detail = {};
    try { detail = JSON.parse(String(event.detail || "{}")); } catch (_error) { return; }
    const id = String(detail.id || "");
    if (!id) return;
    if (detail.disconnected) collaboratorPresence.delete(id);
    else collaboratorPresence.set(id, {
      id,
      name: String(detail.name || "Anonymous").slice(0, 80),
      color: validColor(detail.color, "#64748b"),
      documentId: String(detail.documentId || ""),
      cursorIndex: Math.max(0, Number(detail.cursorIndex) || 0),
      selectionAnchor: Math.max(0, Number(detail.selectionAnchor) || 0),
      selectionHead: Math.max(0, Number(detail.selectionHead) || 0),
      updatedAt: Number(detail.updatedAt) || Date.now()
    });
    if (!detail.disconnected && applyReviewAuthorProfile(String(detail.authorId || ""), {
      name: detail.name,
      color: detail.color
    })) {
      scheduleLocalSave(0);
      renderPane();
      dispatchReviewState();
    }
    scheduleOverlayRender();
  });

  window.addEventListener(COLLABORATION_SIGNAL_EVENT, (event) => {
    let detail = {};
    try { detail = JSON.parse(String(event.detail || "{}")); } catch (_error) { return; }
    if (detail.kind === "review-live") {
      const remote = normalizeReviewState(detail.payload?.state);
      const merged = mergeReviewStates(reviewState, remote);
      if (remote.sharedTracking.updatedAt) {
        merged.sharedTracking = { ...remote.sharedTracking };
      }
      if (JSON.stringify(merged) !== JSON.stringify(normalizeReviewState(reviewState))) {
        reviewState = merged;
        reviewActivated = true;
        scheduleLocalSave(0);
        ensureProjectPolling();
        renderPane();
        scheduleOverlayRender();
        updateCursorChange();
        dispatchReviewState();
      }
      return;
    }
    if (detail.kind !== "review") return;
    for (const delay of [0, 500, 1500]) {
      window.setTimeout(() => refreshProjectState({
        force: true,
        fileId: String(detail.fileId || ""),
        entityType: String(detail.entityType || "")
      }).catch(() => {}), delay);
    }
  });

  window.addEventListener(RUNTIME_SETTINGS_EVENT, (event) => {
    const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
    if (detail.review?.popupTrigger) {
      popupTrigger = detail.review.popupTrigger === "click" ? "click" : "hover";
    }
    if (detail.review?.user) identity = normalizedIdentity(detail.review.user);
    scheduleOverlayRender();
  });

  extensionApi.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    const previousIdentity = identity;
    if (changes[COMMENT_PROFILE_KEY]?.newValue) {
      identity = normalizedIdentity(changes[COMMENT_PROFILE_KEY].newValue);
    } else if (changes[REVIEW_USER_KEY]?.newValue) {
      identity = normalizedIdentity(changes[REVIEW_USER_KEY].newValue);
    }
    if (changes[AUTHOR_ID_KEY]?.newValue) identityAuthorId = String(changes[AUTHOR_ID_KEY].newValue || "");
    if (changes[REVIEW_UI_KEY]?.newValue) {
      popupTrigger = changes[REVIEW_UI_KEY].newValue.popupTrigger === "click" ? "click" : "hover";
    }
    window.dispatchEvent(new CustomEvent(COLLABORATION_PROFILE_EVENT, {
      detail: JSON.stringify({ name: identity.name, color: identity.color, authorId: identityAuthorId })
    }));
    if (applyReviewAuthorProfile(identityAuthorId, identity, previousIdentity)) saveState();
    else scheduleOverlayRender();
  });

  const uiObserver = new MutationObserver(() => syncPaneTheme());
  uiObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "data-bs-theme"]
  });
  if (document.body) {
    uiObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-bs-theme"]
    });
  }

  window.addEventListener("resize", () => {
    scheduleOverlayRender();
    updateCursorChange();
  }, { passive: true });
  window.addEventListener("scroll", scheduleOverlayRender, true);

  presenceExpiryTimer = window.setInterval(() => {
    const cutoff = Date.now() - 12000;
    let changed = false;
    for (const [id, presence] of collaboratorPresence) {
      if (Number(presence.updatedAt || 0) >= cutoff) continue;
      collaboratorPresence.delete(id);
      changed = true;
    }
    if (changed) scheduleOverlayRender();
  }, 2000);

  window.addEventListener("pagehide", () => {
    window.clearTimeout(trackedStateCaptureTimer);
    window.clearTimeout(localSaveTimer);
    window.clearTimeout(projectSaveTimer);
    window.clearInterval(projectPollTimer);
    window.clearInterval(presenceExpiryTimer);
    if (overlayFrame) cancelAnimationFrame(overlayFrame);
    uiObserver.disconnect();
    commentHighlightLayer?.remove();
    markupLayer?.remove();
    temporaryLayer?.remove();
    presenceLayer?.remove();
    removeOriginalOverlay();
    removeSelectionPopup();
    hideChangePopup();
  });

  dispatchReviewHydrationState(true);
  loadInitialState()
    .catch((error) => {
      console.error("SmartTeX review initialization failed:", error);
    })
    .finally(() => {
      // Signal only after the authoritative remote review state has been merged
      // and the final live editor snapshot has seeded the tracking engine. The
      // MAIN-world bridge uses this as the trigger for one final structure pass.
      dispatchReviewHydrationState(false);
    });
})();
