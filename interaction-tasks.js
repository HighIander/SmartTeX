/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

((global) => {
  "use strict";

  if (global.SmartTeXInteractionTasks) return;

  const ACTIVITY_EVENT = "smarttex:user-activity";
  const KEYBOARD_IDLE_EVENT = "smarttex:keyboard-idle";
  const SCROLL_STATE_EVENT = "smarttex:editor-scroll-state";
  const SCROLLING_CLASS = "smarttex-editor-scrolling";
  const KEYBOARD_IDLE_MS = 500;
  const KEYBOARD_TRANSACTION_MS = 120;
  const FOCUSED_SYNC_SOURCE_LIMIT = 20000;
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
  const activeTasks = [];
  const subscribers = new Set();
  const scheduledTimeouts = new Map();
  const scheduledFrames = new Map();
  let generation = 0;
  let lastReason = "initial";
  let nextScheduledId = 1;
  let scrollSettleTimer = 0;
  let scrollActive = false;
  let lastKeyboardActivityAt = -Infinity;
  let lastKeyboardSubscriberAt = -Infinity;
  let keyboardSettleTimer = 0;
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
        detail: Object.freeze({ active: Boolean(active), reason: String(reason || "scroll") })
      }));
    } catch (_error) {
      // CustomEvent is unavailable in some tests and worker-like environments.
    }
  }

  function finishEditorScroll() {
    scrollSettleTimer = 0;
    scrollActive = false;
    // Keep overlays hidden while subscribers calculate their final geometry.
    // Their requestAnimationFrame callbacks are queued before the class-removal
    // callback below, preventing a one-frame flash at the old position.
    emitScrollState(false, "settled");
    const reveal = () => setScrollingClass(false);
    if (typeof global.requestAnimationFrame === "function") global.requestAnimationFrame(reveal);
    else global.setTimeout?.(reveal, 0);
  }

  function beginEditorScroll(reason = "scroll") {
    if (scrollSettleTimer) global.clearTimeout?.(scrollSettleTimer);
    scrollSettleTimer = 0;
    if (!scrollActive) {
      scrollActive = true;
      setScrollingClass(true);
      emitScrollState(true, reason);
    }
    scrollSettleTimer = global.setTimeout?.(finishEditorScroll, 140) || 0;
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
    return Math.max(0, KEYBOARD_IDLE_MS - (Date.now() - lastKeyboardActivityAt));
  }

  function setKeyboardTyping(active) {
    try {
      const root = global.document?.documentElement;
      if (!root) return;
      if (active) {
        if (root.getAttribute("data-smarttex-editor-typing") !== "true") {
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

  function noteKeyboardActivity(now = Date.now()) {
    lastKeyboardActivityAt = now;
    setKeyboardTyping(true);
    if (keyboardSettleTimer) global.clearTimeout?.(keyboardSettleTimer);
    keyboardSettleTimer = global.setTimeout?.(finishKeyboardActivity, KEYBOARD_IDLE_MS) || 0;
  }

  function endKeyboardActivity() {
    if (keyboardSettleTimer) global.clearTimeout?.(keyboardSettleTimer);
    keyboardSettleTimer = 0;
    lastKeyboardActivityAt = -Infinity;
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
    if (keyboardIdleRemaining() > 0 || pendingUserInput()) return false;
    return true;
  }

  function canRunBackgroundTask(state, sourceLength = 0) {
    if (!canRunLongTask(state, sourceLength)) return false;
    if (state?.focused === false) return true;
    return Math.max(0, Number(sourceLength) || 0) <= FOCUSED_SYNC_SOURCE_LIMIT;
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
    if (
      continuous &&
      typeof target?.closest === "function" &&
      target.closest(SMARTTEX_SCROLLABLE_SELECTOR)
    ) return false;
    if (closestEditorSurface(target)) return true;
    if (typeof event?.composedPath === "function") {
      for (const node of event.composedPath()) {
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

  function notify(reason, originalEvent = null, { notifySubscribers = true } = {}) {
    generation += 1;
    lastReason = String(reason || "user-activity");
    for (const task of activeTasks) task.aborted = true;
    cancelScheduledWork();
    if (!notifySubscribers) return;
    const detail = Object.freeze({
      generation,
      reason: lastReason,
      eventType: String(originalEvent?.type || "")
    });
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

  function eventReason(event) {
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
    if (reason === "keyboard") {
      const now = Date.now();
      noteKeyboardActivity(now);
      // A normal edit produces keydown, beforeinput, and input in quick
      // succession. Invalidating shared tasks on all three preserves immediate
      // cancellation, but the module subscriber fan-out only needs to happen
      // once. An input without a recent keydown (paste, speech, IME, etc.) still
      // receives a full cancellation pass.
      notifySubscribers = event?.type === "keydown" ||
        now - lastKeyboardSubscriberAt > KEYBOARD_TRANSACTION_MS;
      if (notifySubscribers) lastKeyboardSubscriberAt = now;
    }
    if (reason === "pointer") endKeyboardActivity();

    // Keyboard, wheel and touch events only establish a before-movement baseline
    // and cancel background work. They must not hide overlays by themselves.
    // Overlays are hidden only after the editor emits a scroll event whose
    // scrollTop/scrollLeft actually changed. This also covers automatic editor
    // scrolling when typing moves the caret outside the current viewport.
    if (reason !== "scroll" && reason !== "keyboard") rememberPotentialEditorScroll(event);
    if (reason === "scroll") {
      if (!scrollPositionChanged(event)) {
        notify(reason, event);
        return;
      }
      beginEditorScroll(reason);
    }

    // This handler never prevents default or stops propagation. It only invalidates
    // SmartTeX work, allowing the host editor to process the event immediately.
    notify(reason, event, { notifySubscribers });
  }

  for (const type of ["keydown", "beforeinput", "input", "pointerdown", "wheel", "scroll", "touchmove"]) {
    global.addEventListener?.(type, onUserActivity, {
      capture: true,
      passive: type === "wheel" || type === "scroll" || type === "touchmove"
    });
  }

  function begin(label) {
    const token = {
      label: String(label || "smarttex-task"),
      generation,
      aborted: false,
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
    if (token.aborted || token.generation !== generation) return true;
    if (!pendingUserInput()) return false;
    notify("pending-input");
    return true;
  }

  function checkpoint(_iteration = 0, interval = 256, token = activeTasks[activeTasks.length - 1]) {
    if (!token) return;
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
