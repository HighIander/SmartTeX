/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

((global) => {
  "use strict";

  if (global.SmartTeXInteractionTasks) return;

  const ACTIVITY_EVENT = "smarttex:user-activity";
  const KEYBOARD_IDLE_EVENT = "smarttex:keyboard-idle";
  const SCROLL_STATE_EVENT = "smarttex:editor-scroll-state";
  const SCROLLING_CLASS = "smarttex-editor-scrolling";
  const SCROLL_IDLE_MS = 500;
  const KEYBOARD_IDLE_MS = 500;
  const KEYBOARD_TRANSACTION_MS = 120;
  const SMARTTEX_SCROLLABLE_SELECTOR = [
    "#smarttex-reference-autocomplete-popup",
    "#smarttex-citation-popup",
    "#smarttex-figure-autocomplete-popup",
    ".smarttex-document-reference-popup",
    ".smarttex-label-guard-dialog",
    ".smarttex-label-guard-preview",
    "#smarttex-equation-preview"
  ].join(",");
  const EDITOR_SELECTOR = [
    ".ace_editor",
    ".ace_scroller",
    ".ace_content",
    ".ace_text-input",
    ".ace_scrollbar",
    ".ace_scrollbar-v",
    ".ace_scrollbar-h",
    ".cm-editor",
    ".cm-scroller",
    ".cm-content",
    "[data-smarttex-editor-surface]"
  ].join(",");
  const SIDEBAR_SELECTOR = "aside,[role='complementary'],.sidebar,.file-tree-list,.outline-pane,#smarttex-comments-pane,#smarttex-review-pane,[data-smarttex-sidebar]";
  const activeTasks = [];
  const subscribers = new Set();
  const scheduledTimeouts = new Map();
  const scheduledFrames = new Map();
  let generation = 0;
  let lastReason = "initial";
  let nextScheduledId = 1;
  let scrollSettleTimer = 0;
  let continuousCancellationResetTimer = 0;
  let scrollActive = false;
  let pointerActive = false;
  let continuousInteractionCancelled = false;
  let keyboardIdleDeadline = -Infinity;
  let lastKeyboardSubscriberAt = -Infinity;
  let keyboardSettleTimer = 0;
  let deferredNotificationTimer = 0;
  let deferredNotificationDetail = null;
  let cachedEditorStateText = "";
  let cachedEditorState = null;
  const rememberedScrollPositions = new WeakMap();
  let rememberedWindowScroll = null;


  function numericScrollPosition(target) {
    if (!target) return null;
    if (target === global || target === global.document ||
        target === global.document?.documentElement ||
        target === global.document?.scrollingElement) {
      return {
        left: Number(global.scrollX ?? global.pageXOffset ?? 0) || 0,
        top: Number(global.scrollY ?? global.pageYOffset ?? 0) || 0
      };
    }
    if (typeof target !== "object") return null;
    const left = Number(target.scrollLeft);
    const top = Number(target.scrollTop);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function rememberScrollPosition(target) {
    const position = numericScrollPosition(target);
    if (!position) return;
    if (target === global || target === global.document ||
        target === global.document?.documentElement ||
        target === global.document?.scrollingElement) {
      rememberedWindowScroll = position;
      return;
    }
    try { rememberedScrollPositions.set(target, position); } catch (_error) {}
  }

  function editorScrollerForTarget(target) {
    if (!target) return null;
    if (typeof target.matches === "function" &&
        target.matches(".ace_scroller,.cm-scroller,[data-smarttex-editor-surface]")) return target;
    if (Number.isFinite(Number(target.scrollTop)) &&
        Number.isFinite(Number(target.scrollLeft)) &&
        closestEditorSurface(target)) return target;
    if (typeof target.closest === "function") {
      const direct = target.closest(".ace_scroller,.cm-scroller,[data-smarttex-editor-surface]");
      if (direct) return direct;
      const root = target.closest(".ace_editor,.cm-editor");
      const nested = root?.querySelector?.(".ace_scroller,.cm-scroller,[data-smarttex-editor-surface]");
      if (nested) return nested;
    }
    return null;
  }

  function rememberPotentialEditorScroll(event) {
    const candidates = new Set();
    const direct = editorScrollerForTarget(event?.target);
    if (direct) candidates.add(direct);
    const active = editorScrollerForTarget(global.document?.activeElement);
    if (active) candidates.add(active);
    if (typeof event?.composedPath === "function") {
      for (const node of event.composedPath()) {
        const scroller = editorScrollerForTarget(node);
        if (scroller) candidates.add(scroller);
      }
    }
    for (const target of candidates) rememberScrollPosition(target);
  }

  function scrollPositionChanged(event) {
    const target = event?.target || global;
    const position = numericScrollPosition(target);
    if (!position) return true;
    let previous = null;
    const isWindowTarget = target === global || target === global.document ||
      target === global.document?.documentElement || target === global.document?.scrollingElement;
    if (isWindowTarget) previous = rememberedWindowScroll;
    else {
      try { previous = rememberedScrollPositions.get(target) || null; } catch (_error) {}
    }
    rememberScrollPosition(target);
    if (!previous) return true;
    return previous.left !== position.left || previous.top !== position.top;
  }

  function setScrollingClass(active) {
    try {
      global.document?.documentElement?.classList?.toggle?.(SCROLLING_CLASS, Boolean(active));
    } catch (_error) {
      // Some test DOMs expose no classList implementation.
    }
  }

  function emitScrollState(active, reason = "scroll") {
    try {
      global.dispatchEvent?.(new CustomEvent(SCROLL_STATE_EVENT, {
        detail: Object.freeze({
          active: Boolean(active),
          reason: String(reason || "scroll")
        })
      }));
    } catch (_error) {
      // CustomEvent is unavailable in some tests and worker-like environments.
    }
  }

  function finishEditorScroll() {
    scrollSettleTimer = 0;
    if (continuousCancellationResetTimer) global.clearTimeout?.(continuousCancellationResetTimer);
    continuousCancellationResetTimer = 0;
    scrollActive = false;
    continuousInteractionCancelled = false;
    // Keep overlays hidden while subscribers calculate their final geometry.
    // Their requestAnimationFrame callbacks are queued before the class-removal
    // callback below, preventing a one-frame flash at the old position.
    emitScrollState(false, "settled");
    const reveal = () => setScrollingClass(false);
    if (typeof global.requestAnimationFrame === "function") global.requestAnimationFrame(reveal);
    else global.setTimeout?.(reveal, 0);
  }

  function beginEditorScroll(reason = "scroll") {
    if (continuousCancellationResetTimer) global.clearTimeout?.(continuousCancellationResetTimer);
    continuousCancellationResetTimer = 0;
    if (scrollSettleTimer) global.clearTimeout?.(scrollSettleTimer);
    scrollSettleTimer = 0;
    if (!scrollActive) {
      scrollActive = true;
      setScrollingClass(true);
      emitScrollState(true, reason);
    }
    scrollSettleTimer = global.setTimeout?.(finishEditorScroll, SCROLL_IDLE_MS) || 0;
  }

  function resetContinuousCancellationAfterIdle() {
    if (continuousCancellationResetTimer) global.clearTimeout?.(continuousCancellationResetTimer);
    continuousCancellationResetTimer = global.setTimeout?.(() => {
      continuousCancellationResetTimer = 0;
      if (!scrollActive) continuousInteractionCancelled = false;
    }, SCROLL_IDLE_MS) || 0;
  }

  function abortError(reason = "User interaction") {
    const error = new Error(`SmartTeX task aborted: ${reason}`);
    error.name = "AbortError";
    error.smarttexCancelled = true;
    return error;
  }

  function pendingUserInput() {
    try {
      return Boolean(global.navigator?.scheduling?.isInputPending?.({
        includeContinuous: true
      }));
    } catch (_error) {
      return false;
    }
  }

  function keyboardIdleRemaining() {
    return Math.max(0, keyboardIdleDeadline - Date.now());
  }

  function setKeyboardTyping(active) {
    try {
      const root = global.document?.documentElement;
      if (!root) return;
      if (active) {
        if (root.getAttribute("data-smarttex-editor-typing") !== "true") {
          root.setAttribute("data-smarttex-source-overlays-pending", "true");
          root.setAttribute("data-smarttex-editor-typing", "true");
        }
      } else if (root.hasAttribute("data-smarttex-editor-typing")) {
        root.removeAttribute("data-smarttex-editor-typing");
      }
    } catch (_error) {}
  }

  function finishKeyboardActivity() {
    keyboardSettleTimer = 0;
    const remaining = keyboardIdleRemaining();
    if (remaining > 0) {
      keyboardSettleTimer = global.setTimeout?.(finishKeyboardActivity, remaining) || 0;
      return;
    }
    setKeyboardTyping(false);
    try {
      global.dispatchEvent?.(new CustomEvent(KEYBOARD_IDLE_EVENT, {
        detail: Object.freeze({ generation, reason: "keyboard-idle" })
      }));
    } catch (_error) {}
  }

  function noteKeyboardActivity(now = Date.now(), hideDecorations = true) {
    // Navigation needs a short settled-state retry, while actual edits retain
    // the full typing debounce. Moving the caret must not shorten a pending edit.
    const idleMs = hideDecorations ? KEYBOARD_IDLE_MS : KEYBOARD_TRANSACTION_MS;
    keyboardIdleDeadline = Math.max(keyboardIdleDeadline, now + idleMs);
    if (hideDecorations) setKeyboardTyping(true);
    if (keyboardSettleTimer) global.clearTimeout?.(keyboardSettleTimer);
    keyboardSettleTimer = global.setTimeout?.(finishKeyboardActivity, keyboardIdleRemaining()) || 0;
  }

  function endKeyboardActivity() {
    if (keyboardSettleTimer) global.clearTimeout?.(keyboardSettleTimer);
    keyboardSettleTimer = 0;
    keyboardIdleDeadline = -Infinity;
    setKeyboardTyping(false);
  }

  function parseEditorState(value) {
    const text = String(value || "null");
    if (text !== cachedEditorStateText) {
      cachedEditorStateText = text;
      cachedEditorState = JSON.parse(text);
    }
    if (!cachedEditorState || typeof cachedEditorState !== "object") return cachedEditorState;
    return {
      ...cachedEditorState,
      cursor: cachedEditorState.cursor ? { ...cachedEditorState.cursor } : cachedEditorState.cursor,
      screen: cachedEditorState.screen ? { ...cachedEditorState.screen } : cachedEditorState.screen
    };
  }

  function canRunLongTask(state, sourceLength = 0) {
    if (pointerActive || scrollActive || keyboardIdleRemaining() > 0 || pendingUserInput()) return false;
    return true;
  }

  function canRunBackgroundTask(state, sourceLength = 0) {
    if (!canRunLongTask(state, sourceLength)) return false;
    // Large focused documents need the proactive cache most. Callers already
    // enter through an idle callback and yield between individual entries, so
    // document length must not disable the cache completely.
    return true;
  }

  function closestEditorSurface(target) {
    if (!target) return null;
    if (typeof target.closest === "function") return target.closest(EDITOR_SELECTOR);
    const parent = target.parentElement;
    return typeof parent?.closest === "function" ? parent.closest(EDITOR_SELECTOR) : null;
  }

  function eventBelongsToEditor(event) {
    const documentRef = global.document;
    // Unit tests and non-DOM environments intentionally treat injected events as editor activity.
    if (!documentRef) return true;
    const continuous = ["wheel", "scroll", "touchmove"].includes(event?.type);
    const target = event?.target;
    if (event?.type === "pointerdown" && target?.closest?.(SIDEBAR_SELECTOR)) return true;
    if (
      continuous &&
      typeof target?.closest === "function" &&
      target.closest(SMARTTEX_SCROLLABLE_SELECTOR)
    ) return false;
    if (closestEditorSurface(target)) return true;
    if (typeof event?.composedPath === "function") {
      for (const node of event.composedPath()) {
        if (event?.type === "pointerdown" && node?.closest?.(SIDEBAR_SELECTOR)) return true;
        if (
          continuous &&
          typeof node?.closest === "function" &&
          node.closest(SMARTTEX_SCROLLABLE_SELECTOR)
        ) return false;
        if (closestEditorSurface(node)) return true;
      }
    }
    if (continuous) {
      if (target === global || target === documentRef || target === documentRef.documentElement) {
        return Boolean(closestEditorSurface(documentRef.activeElement));
      }
      return false;
    }
    return Boolean(closestEditorSurface(documentRef.activeElement));
  }

  function cancelScheduledWork() {
    for (const [id, entry] of scheduledTimeouts) {
      global.clearTimeout?.(entry.nativeId);
      scheduledTimeouts.delete(id);
    }
    for (const [id, entry] of scheduledFrames) {
      global.cancelAnimationFrame?.(entry.nativeId);
      scheduledFrames.delete(id);
    }
  }

  function dispatchNotification(detail) {
    for (const callback of [...subscribers]) {
      try {
        callback(detail);
      } catch (error) {
        console.error("SmartTeX interaction-cancellation subscriber failed:", error);
      }
    }
    try {
      global.dispatchEvent?.(new CustomEvent(ACTIVITY_EVENT, { detail }));
    } catch (_error) {
      // CustomEvent is unavailable in some tests and worker-like environments.
    }
  }

  function flushDeferredNotification(afterPointer = false) {
    deferredNotificationTimer = 0;
    const pending = deferredNotificationDetail;
    if (pointerActive && pending?.reason === "pointer") return;
    if (pending?.reason === "pointer" && !afterPointer) {
      scheduleDeferredNotification(true);
      return;
    }
    deferredNotificationDetail = null;
    if (pending) dispatchNotification(pending);
  }

  function scheduleDeferredNotification(afterPointer = false) {
    if (deferredNotificationTimer) return;
    deferredNotificationTimer = 1;
    if (!afterPointer && typeof global.queueMicrotask === "function") global.queueMicrotask(flushDeferredNotification);
    else deferredNotificationTimer = global.setTimeout(() => flushDeferredNotification(afterPointer), 0);
  }

  function releasePointerActivity() {
    if (!pointerActive) return;
    pointerActive = false;
    // The bridge publishes the committed caret/popup transaction in a microtask
    // before this next task fans cancellation out to background subscribers.
    if (deferredNotificationDetail?.reason === "pointer") scheduleDeferredNotification(true);
  }

  function notify(reason, originalEvent = null, {
    notifySubscribers = true,
    deferSubscribers = false
  } = {}) {
    generation += 1;
    lastReason = String(reason || "user-activity");
    const keyboardCancellation = lastReason === "keyboard" || lastReason === "cursor";
    for (const task of activeTasks) {
      if (keyboardCancellation && task.surviveKeyboard) task.keyboardInterrupted = true;
      else task.aborted = true;
    }
    cancelScheduledWork();
    if (!notifySubscribers) return;
    const detail = Object.freeze({
      generation,
      reason: lastReason,
      eventType: String(originalEvent?.type || "")
    });
    if (deferSubscribers && global.document && typeof global.setTimeout === "function") {
      deferredNotificationDetail = detail;
      if (!pointerActive || lastReason !== "pointer") scheduleDeferredNotification();
      return;
    }
    dispatchNotification(detail);
  }

  function eventReason(event) {
    if (event?.type === "keydown" && !event.isComposing && [
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
      "Shift", "Control", "Alt", "Meta", "Escape"
    ].includes(event.key)) return "cursor";
    if (["keydown", "beforeinput", "input"].includes(event?.type)) return "keyboard";
    if (event?.type === "pointerdown") return "pointer";
    if (event?.type === "wheel") return "wheel";
    if (event?.type === "scroll") return "scroll";
    if (event?.type === "touchmove") return "touch-scroll";
    return String(event?.type || "user-activity");
  }

  function onUserActivity(event) {
    if (!eventBelongsToEditor(event)) return;
    const reason = eventReason(event);
    let notifySubscribers = true;
    if (reason === "keyboard" || reason === "cursor") {
      const now = Date.now();
      // Navigation still needs the settled-keyboard state transaction: an
      // immediate preview can be cancelled while the host processes the key.
      // Only text input hides decorations; cursor keys retain mounted highlights.
      noteKeyboardActivity(now, reason !== "cursor");
      // A normal edit produces keydown, beforeinput, and input in quick
      // succession. Invalidating shared tasks on all three preserves immediate
      // cancellation, but the module subscriber fan-out only needs to happen
      // once. An input without a recent keydown (paste, speech, IME, etc.) still
      // receives a full cancellation pass.
      notifySubscribers = event?.type === "keydown" ||
        now - lastKeyboardSubscriberAt > KEYBOARD_TRANSACTION_MS;
      if (notifySubscribers) lastKeyboardSubscriberAt = now;
    }
    if (reason === "pointer") {
      pointerActive = true;
      endKeyboardActivity();
      if (scrollActive) {
        global.clearTimeout?.(scrollSettleTimer);
        finishEditorScroll();
        setScrollingClass(false);
      }
    }

    // Keyboard, wheel and touch events only establish a before-movement baseline
    // and cancel background work. They must not hide overlays by themselves.
    // Overlays are hidden only after the editor emits a scroll event whose
    // scrollTop/scrollLeft actually changed. This also covers automatic editor
    // scrolling when typing moves the caret outside the current viewport.
    if (reason !== "scroll" && reason !== "keyboard") rememberPotentialEditorScroll(event);
    if (reason === "wheel" || reason === "touch-scroll") {
      const notifySubscribers = !continuousInteractionCancelled;
      continuousInteractionCancelled = true;
      notify(reason, event, { notifySubscribers });
      resetContinuousCancellationAfterIdle();
      return;
    }
    if (reason === "scroll") {
      if (!scrollPositionChanged(event)) return;
      beginEditorScroll(reason);
      const notifySubscribers = !continuousInteractionCancelled;
      continuousInteractionCancelled = true;
      notify(reason, event, { notifySubscribers });
      return;
    }

    // This handler never prevents default or stops propagation. It only invalidates
    // SmartTeX work, allowing the host editor to process the event immediately.
    notify(reason, event, {
      notifySubscribers,
      deferSubscribers: ["cursor", "pointer"].includes(reason)
    });
  }

  for (const type of ["keydown", "beforeinput", "input", "pointerdown", "wheel", "scroll", "touchmove"]) {
    global.addEventListener?.(type, onUserActivity, {
      capture: true,
      passive: type === "wheel" || type === "scroll" || type === "touchmove"
    });
  }
  for (const type of ["pointerup", "pointercancel", "blur"]) {
    global.addEventListener?.(type, releasePointerActivity, { capture: true });
  }

  function begin(label, { isCurrent = null, surviveKeyboard = false } = {}) {
    const token = {
      label: String(label || "smarttex-task"),
      generation,
      aborted: scrollActive || pointerActive,
      isCurrent: typeof isCurrent === "function" ? isCurrent : null,
      surviveKeyboard: Boolean(surviveKeyboard),
      keyboardInterrupted: false,
      checkpointCalls: 0
    };
    activeTasks.push(token);
    return token;
  }

  function end(token) {
    const index = activeTasks.lastIndexOf(token);
    if (index >= 0) activeTasks.splice(index, 1);
  }

  function shouldAbort(token = activeTasks[activeTasks.length - 1]) {
    if (!token) return false;
    if (scrollActive || pointerActive) {
      token.aborted = true;
      return true;
    }
    if (token.isCurrent) {
      if (token.aborted || !token.isCurrent()) return true;
      if (!token.surviveKeyboard && pendingUserInput()) {
        notify("pending-input");
        return true;
      }
      return false;
    }
    if (token.aborted || token.generation !== generation) return true;
    if (!pendingUserInput()) return false;
    notify("pending-input");
    return true;
  }

  function checkpoint(_iteration = 0, interval = 256, token = activeTasks[activeTasks.length - 1]) {
    if (!token) return;
    // An async task can resume underneath a different suspended task. Restore
    // its scope so nested parser checkpoints use the resumed task's policy.
    if (activeTasks[activeTasks.length - 1] !== token) {
      const index = activeTasks.indexOf(token);
      if (index >= 0) {
        activeTasks.splice(index, 1);
        activeTasks.push(token);
      }
    }
    if (token.isCurrent) {
      if (shouldAbort(token)) throw abortError("environment-exit");
      return;
    }
    if (token.aborted || token.generation !== generation) throw abortError(lastReason);
    token.checkpointCalls = (Number(token.checkpointCalls) || 0) + 1;
    const requestedInterval = Math.max(1, Number(interval) || 1);
    const normalizedInterval = Math.min(32, requestedInterval);
    if (token.checkpointCalls % normalizedInterval !== 0 && requestedInterval !== 1) return;
    if (shouldAbort(token)) throw abortError(lastReason);
  }

  function runSync(label, callback) {
    if (typeof callback !== "function") return undefined;
    const token = begin(label);
    try {
      checkpoint(0, 1, token);
      const result = callback(token);
      checkpoint(0, 1, token);
      return result;
    } finally {
      end(token);
    }
  }

  function scheduleTimeout(label, callback, delay = 0) {
    if (typeof callback !== "function") return 0;
    const id = nextScheduledId++;
    const scheduledGeneration = generation;
    const nativeId = global.setTimeout?.(() => {
      scheduledTimeouts.delete(id);
      if (scheduledGeneration !== generation) return;
      try {
        runSync(label, callback);
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
    }, Math.max(0, Number(delay) || 0));
    scheduledTimeouts.set(id, { nativeId, label: String(label || "timeout") });
    return id;
  }

  function clearScheduledTimeout(id) {
    const entry = scheduledTimeouts.get(id);
    if (!entry) return;
    global.clearTimeout?.(entry.nativeId);
    scheduledTimeouts.delete(id);
  }

  function scheduleAnimationFrame(label, callback) {
    if (typeof callback !== "function" || typeof global.requestAnimationFrame !== "function") return 0;
    const id = nextScheduledId++;
    const scheduledGeneration = generation;
    const nativeId = global.requestAnimationFrame(() => {
      scheduledFrames.delete(id);
      if (scheduledGeneration !== generation) return;
      try {
        runSync(label, callback);
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
    });
    scheduledFrames.set(id, { nativeId, label: String(label || "frame") });
    return id;
  }

  function clearScheduledAnimationFrame(id) {
    const entry = scheduledFrames.get(id);
    if (!entry) return;
    global.cancelAnimationFrame?.(entry.nativeId);
    scheduledFrames.delete(id);
  }

  function isAbortError(error) {
    return Boolean(error && (error.name === "AbortError" || error.smarttexCancelled === true));
  }

  global.SmartTeXInteractionTasks = Object.freeze({
    eventName: ACTIVITY_EVENT,
    keyboardIdleEventName: KEYBOARD_IDLE_EVENT,
    scrollStateEventName: SCROLL_STATE_EVENT,
    scrollIdleMs: SCROLL_IDLE_MS,
    keyboardIdleMs: KEYBOARD_IDLE_MS,
    keyboardIdleRemaining,
    endKeyboardActivity,
    parseEditorState,
    canRunLongTask,
    canRunBackgroundTask,
    isKeyboardIdle: () => keyboardIdleRemaining() === 0,
    isScrolling: () => scrollActive,
    generation: () => generation,
    reason: () => lastReason,
    cancel: notify,
    checkpoint,
    shouldAbort,
    runSync,
    begin,
    end,
    scheduleTimeout,
    clearScheduledTimeout,
    scheduleAnimationFrame,
    clearScheduledAnimationFrame,
    isAbortError,
    throwIfGenerationChanged(expectedGeneration) {
      if (Number(expectedGeneration) !== generation) throw abortError(lastReason);
      if (pendingUserInput()) {
        notify("pending-input");
        throw abortError(lastReason);
      }
    },
    subscribe(callback) {
      if (typeof callback !== "function") return () => {};
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    }
  });
})(globalThis);
