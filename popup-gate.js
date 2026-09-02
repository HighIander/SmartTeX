/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPopupGate) return;

  // This file is registered origin-wide. The CollabTeX project overview is a
  // highly dynamic React page; observing its entire DOM solely to hide editor
  // popups is unnecessary and can make that page stall while project cards are
  // populated. Only install the popup observer when an actual editor exists.
  const hasEditorSurface = Boolean(document.querySelector(
    "#ide-redesign-panel-source-editor .cm-editor, " +
    "#ide-redesign-panel-source-editor .CodeMirror, " +
    "#ide-redesign-panel-source-editor .ace_editor, " +
    "#ide-redesign-panel-source-editor [contenteditable='true'], " +
    "#ide-redesign-panel-editor .cm-editor, " +
    "#ide-redesign-panel-editor .CodeMirror, " +
    "#ide-redesign-panel-editor .ace_editor, " +
    "#ide-redesign-panel-editor [contenteditable='true'], " +
    ".ide-redesign-editor-container .cm-editor, " +
    ".ide-redesign-editor-container .ace_editor, " +
    "[data-testid*='source-editor' i] .cm-editor, " +
    "[data-testid*='source-editor' i] .ace_editor, " +
    ".editor-pane .cm-editor, .editor-pane .ace_editor, " +
    "#editor.ace_editor, #editor .ace_editor"
  ));
  if (!hasEditorSurface) {
    globalThis.SmartTeXPopupGate = Object.freeze({
      isReady: () => true,
      onReady(listener) {
        if (typeof listener === "function") listener();
        return () => {};
      },
      hideInitialPopups() {}
    });
    return;
  }

  let ready = false;
  const listeners = new Set();
  const popupSelector = [
    "#smarttex-equation-preview",
    "#smarttex-reference-autocomplete-popup",
    "#smarttex-citation-popup",
    ".smarttex-document-reference-popup",
    ".smarttex-popup-loading-spinner"
  ].join(",");

  function hideInitialPopup(element) {
    if (!(element instanceof Element)) return;
    const candidates = element.matches?.(popupSelector)
      ? [element]
      : [...element.querySelectorAll?.(popupSelector) || []];
    for (const popup of candidates) {
      popup.hidden = true;
      popup.classList.remove(
        "smarttex-preview-visible",
        "smarttex-reference-autocomplete-visible",
        "smarttex-citation-visible"
      );
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (ready) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) hideInitialPopup(node);
    }
  });

  function unlock(event) {
    if (ready || event?.isTrusted === false) return;
    ready = true;
    observer.disconnect();
    for (const type of interactionEvents) {
      window.removeEventListener(type, unlock, true);
    }
    window.dispatchEvent(new CustomEvent("smarttex:popup-interaction-ready"));
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn("SmartTeX popup startup listener failed:", error);
      }
    }
    listeners.clear();
  }

  const interactionEvents = [
    "pointerdown",
    "pointermove",
    "keydown",
    "touchstart",
    "wheel"
  ];
  for (const type of interactionEvents) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }

  observer.observe(document.documentElement, { childList: true, subtree: true });
  hideInitialPopup(document.documentElement);

  globalThis.SmartTeXPopupGate = Object.freeze({
    isReady: () => ready,
    onReady(listener) {
      if (typeof listener !== "function") return () => {};
      if (ready) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hideInitialPopups: () => hideInitialPopup(document.documentElement)
  });
})();

/* Popup window chrome lives in this already-registered bootstrap so existing
   dynamic content-script registrations receive it after a normal page reload. */
(() => {
  "use strict";

  if (globalThis.SmartTeXPopupUI) return;

  const STORAGE_KEY = "smarttex:popup-sizes:v1";
  const RELATIVE_SCALE_KEY = "smarttex:popup-scale:v1";
  const TYPES = new Set(["list", "image", "equation", "table"]);
  const MINIMUM_SIZE = {
    list: { width: 280, height: 180 },
    image: { width: 180, height: 140 },
    equation: { width: 220, height: 120 },
    table: { width: 280, height: 180 }
  };
  const DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  const RELATIVE_SCALE_TYPES = new Set(["image", "equation", "table"]);
  const states = new WeakMap();

  /*
   * Popup sizing implementation note: the complete user-facing popup/outline
   * requirements are documented in the "SMARTTEX POPUP / OUTLINE BEHAVIOR
   * CONTRACT" comment near the top of content.js. In this module specifically,
   * slider-relative sizes are persistent defaults, edge/corner drags are
   * temporary for the current popup, intrinsic geometry must never be rebased
   * from an already fitted/scaled rectangle, and scrollbars are not a sizing
   * decision here: content.js first grows the window and then solves a live-DOM
   * auto-fit down to the 75% floor before enabling its scrollbar fallback.
   */

  function readSizes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  let sizes = readSizes();

  function clampRelativeScale(value) {
    return Math.max(0.5, Math.min(2, Number(value) || 1));
  }

  function normalizeRelativeSettings(value = {}) {
    return {
      mode: value?.mode === "separate" ? "separate" : "global",
      global: clampRelativeScale(value?.global),
      image: clampRelativeScale(value?.image),
      equation: clampRelativeScale(value?.equation),
      table: clampRelativeScale(value?.table)
    };
  }

  function readRelativeSettings() {
    try {
      return normalizeRelativeSettings(JSON.parse(localStorage.getItem(RELATIVE_SCALE_KEY) || "{}"));
    } catch (_error) {
      return normalizeRelativeSettings();
    }
  }

  let relativeSettings = readRelativeSettings();

  function writeRelativeSettings() {
    try {
      localStorage.setItem(RELATIVE_SCALE_KEY, JSON.stringify(relativeSettings));
    } catch (_error) {
      // The current tab still uses the selected relative sizes if storage is restricted.
    }
  }

  function relativeScaleFor(type) {
    if (!RELATIVE_SCALE_TYPES.has(type)) return 1;
    return relativeSettings.mode === "separate"
      ? relativeSettings[type]
      : relativeSettings.global;
  }

  function writeSizes() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
    } catch (_error) {
      // A restricted document may not expose localStorage. Resizing still works
      // for the current popup instance in that case.
    }
  }

  function normalizedType(value) {
    return TYPES.has(value) ? value : "equation";
  }

  function viewportBounds() {
    const margin = 9;
    return {
      margin,
      width: Math.max(1, window.innerWidth - margin * 2),
      height: Math.max(1, window.innerHeight - margin * 2)
    };
  }

  function setContentScale(popup, value) {
    const scale = Math.max(0.2, Math.min(4, Number(value) || 1));
    popup.style.setProperty("--smarttex-popup-content-scale", scale.toFixed(4));
  }

  function measurableRect(popup) {
    if (popup.hidden || !popup.isConnected) return null;
    const rect = popup.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 ? rect : null;
  }

  function savedRatios(savedSize, naturalSize) {
    if (!savedSize || !naturalSize) return null;
    const widthRatio = Number(savedSize.widthRatio) || (
      Number(savedSize.width) > 0
        ? Number(savedSize.width) / Math.max(1, naturalSize.width)
        : 0
    );
    const heightRatio = Number(savedSize.heightRatio) || (
      Number(savedSize.height) > 0
        ? Number(savedSize.height) / Math.max(1, naturalSize.height)
        : 0
    );
    if (!(widthRatio > 0) || !(heightRatio > 0)) return null;
    return { widthRatio, heightRatio };
  }

  function resizePopup(
    popup,
    state,
    type,
    requested,
    {
      live = false,
      persist = false,
      contentScaleOverride = null,
      widthLimit = null,
      heightLimit = null
    } = {}
  ) {
    const naturalSize = state.naturalSizes[type];
    if (!naturalSize) return false;

    const bounds = viewportBounds();
    const minimum = MINIMUM_SIZE[type];
    const rect = popup.getBoundingClientRect();
    const maximumWidth = Math.max(
      1,
      Math.min(bounds.width, Number(widthLimit) > 0 ? Number(widthLimit) : bounds.width)
    );
    const maximumHeight = Math.max(
      1,
      Math.min(bounds.height, Number(heightLimit) > 0 ? Number(heightLimit) : bounds.height)
    );
    const width = Math.min(
      maximumWidth,
      Math.max(Math.min(minimum.width, maximumWidth), Number(requested.width) || rect.width)
    );
    const height = Math.min(
      maximumHeight,
      Math.max(Math.min(minimum.height, maximumHeight), Number(requested.height) || rect.height)
    );
    const requestedLeft = Number.isFinite(Number(requested.left)) ? Number(requested.left) : rect.left;
    const requestedTop = Number.isFinite(Number(requested.top)) ? Number(requested.top) : rect.top;
    const left = Math.max(
      bounds.margin,
      Math.min(requestedLeft, window.innerWidth - bounds.margin - width)
    );
    const top = Math.max(
      bounds.margin,
      Math.min(requestedTop, window.innerHeight - bounds.margin - height)
    );

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.width = `${Math.round(width)}px`;
    popup.style.height = `${Math.round(height)}px`;
    popup.style.maxWidth = `${Math.round(bounds.width)}px`;
    popup.style.maxHeight = `${Math.round(bounds.height)}px`;
    popup.dataset.smarttexUserSized = "true";
    delete popup.dataset.smarttexRelativeSized;

    const widthRatio = width / Math.max(1, naturalSize.width);
    const heightRatio = height / Math.max(1, naturalSize.height);
    const contentScale = Number(contentScaleOverride) > 0
      ? Number(contentScaleOverride)
      : Math.min(widthRatio, heightRatio);
    setContentScale(popup, contentScale);

    if (persist) {
      sizes[type] = { widthRatio, heightRatio, scale: contentScale };
      writeSizes();
    }

    popup.dispatchEvent(new CustomEvent("smarttex:popup-resized", {
      detail: { type, width, height, scale: contentScale, live }
    }));
    return true;
  }

  function applySize(popup, state, type, savedSize, options = {}) {
    const naturalSize = state.naturalSizes[type];
    const ratios = savedRatios(savedSize, naturalSize);
    if (!ratios) return false;
    const rect = popup.getBoundingClientRect();
    return resizePopup(popup, state, type, {
      left: rect.left,
      top: rect.top,
      width: naturalSize.width * ratios.widthRatio,
      height: naturalSize.height * ratios.heightRatio
    }, options);
  }

  function scheduleSavedSize(popup, state, type) {
    const token = ++state.restoreToken;
    const restore = () => {
      if (token !== state.restoreToken || state.type !== type) return;
      // During staged opening the popup is mounted only so its final content can
      // be measured. Do not capture or apply size until content.js explicitly
      // commits the fully rendered geometry.
      if (popup.dataset.smarttexStaging === "true") return;
      const rect = measurableRect(popup);
      if (!rect || popup.dataset.smarttexUserSized === "true") return;
      state.naturalSizes[type] = { width: rect.width, height: rect.height };
      const relativeScale = relativeScaleFor(type);
      if (RELATIVE_SCALE_TYPES.has(type) && Math.abs(relativeScale - 1) > 0.001) {
        applySize(popup, state, type, {
          widthRatio: relativeScale,
          heightRatio: relativeScale,
          scale: relativeScale
        });
        popup.dataset.smarttexRelativeSized = "true";
      }
    };
    globalThis.requestAnimationFrame?.(() => globalThis.requestAnimationFrame?.(restore));
  }

  function previewAutoFitLimits(type, popup = null) {
    const bounds = viewportBounds();
    const relativeScale = RELATIVE_SCALE_TYPES.has(type) ? relativeScaleFor(type) : 1;
    // Long, genuinely single-line equations are allowed substantially more
    // horizontal room. All other environment previews retain the normal 40%
    // viewport cap. The slider scales both limits in exactly the same way.
    const wideSingleLineEquation = Boolean(
      type === "equation" &&
      popup?.dataset?.smarttexEquationSingleLine === "true"
    );
    const widthFraction = wideSingleLineEquation ? 0.8 : 0.4;
    // Figures are height-dominated far more often than equations/tables. A
    // fixed 40%-of-viewport height cap made tall figures acquire scrollbars
    // even when the complete media + caption would comfortably fit on screen.
    // Keep the historical 40% target for equations/tables, but let figure
    // previews grow vertically to the full usable viewport before zooming.
    const heightLimit = type === "image"
      ? bounds.height
      : Math.min(bounds.height, Math.max(1, window.innerHeight * 0.4 * relativeScale));
    return {
      width: Math.min(
        bounds.width,
        Math.max(1, window.innerWidth * widthFraction * relativeScale)
      ),
      height: heightLimit,
      relativeScale,
      widthFraction
    };
  }

  function prepareForReveal(popup, state, { rebase = false } = {}) {
    if (!state || popup.hidden) return false;
    const type = state.type;
    state.restoreToken += 1;
    if (rebase) {
      clearSize(popup);
      delete state.naturalSizes[type];
    }

    let naturalSize = state.naturalSizes[type];
    if (!naturalSize) {
      clearSize(popup);
      const rect = measurableRect(popup);
      if (!rect) return false;
      naturalSize = state.naturalSizes[type] = {
        width: rect.width,
        height: rect.height
      };
    }

    const limits = previewAutoFitLimits(type, popup);
    const relativeScale = limits.relativeScale;
    resizePopup(popup, state, type, {
      left: popup.getBoundingClientRect().left,
      top: popup.getBoundingClientRect().top,
      width: naturalSize.width * relativeScale,
      height: naturalSize.height * relativeScale
    }, {
      live: false,
      persist: false,
      contentScaleOverride: relativeScale,
      widthLimit: limits.width,
      heightLimit: limits.height
    });
    popup.dataset.smarttexRelativeSized = "true";
    popup.dataset.smarttexAutoFitMaxWidth = String(limits.width);
    popup.dataset.smarttexAutoFitMaxHeight = String(limits.height);
    return {
      naturalSize: { ...naturalSize },
      relativeScale,
      maxWidth: limits.width,
      maxHeight: limits.height
    };
  }

  function prepareCachedForReveal(popup, state, cached = {}) {
    if (!state || popup.hidden || !cached?.naturalSize) return false;
    const type = state.type;
    state.restoreToken += 1;
    clearSize(popup);
    state.naturalSizes[type] = {
      width: Math.max(1, Number(cached.naturalSize.width) || 1),
      height: Math.max(1, Number(cached.naturalSize.height) || 1)
    };

    const limits = previewAutoFitLimits(type, popup);
    const natural = state.naturalSizes[type];
    const scaledNaturalWidth = natural.width * limits.relativeScale;
    const scaledNaturalHeight = natural.height * limits.relativeScale;
    const hasCompatibleFittedGeometry = Boolean(
      Number(cached.finalSize?.width) > 0 &&
      Number(cached.finalSize?.height) > 0 &&
      Math.abs((Number(cached.relativeScale) || 0) - limits.relativeScale) < 0.001 &&
      Math.abs((Number(cached.viewportWidth) || 0) - window.innerWidth) <= 2 &&
      Math.abs((Number(cached.viewportHeight) || 0) - window.innerHeight) <= 2
    );

    // Fitted cached dimensions are only hints. They can differ subtly from the
    // current live DOM because of font rasterization, device scale, or a newly
    // decoded image. Always start from cached *intrinsic* geometry and let the
    // live fit validator derive the final size exactly as the cold path does.
    const requestedWidth = scaledNaturalWidth;
    const requestedHeight = scaledNaturalHeight;

    resizePopup(popup, state, type, {
      left: popup.getBoundingClientRect().left,
      top: popup.getBoundingClientRect().top,
      width: requestedWidth,
      height: requestedHeight
    }, {
      live: false,
      persist: false,
      contentScaleOverride: limits.relativeScale,
      widthLimit: limits.width,
      heightLimit: limits.height
    });
    popup.dataset.smarttexRelativeSized = "true";
    popup.dataset.smarttexAutoFitMaxWidth = String(limits.width);
    popup.dataset.smarttexAutoFitMaxHeight = String(limits.height);

    // Background-warmed cache entries intentionally do not store viewport-
    // specific final sizing. Derive the grow/zoom result directly from the
    // cached intrinsic geometry so they can still use the no-RAF fast path.
    const widthFit = Math.min(1, limits.width / Math.max(1, scaledNaturalWidth));
    const heightFit = Math.min(1, limits.height / Math.max(1, scaledNaturalHeight));
    const requiredFit = Math.min(1, widthFit, heightFit);
    const autoFitZoom = Math.max(0.75, requiredFit);
    const scrollFallback = requiredFit < 0.75;

    return {
      naturalSize: { ...natural },
      relativeScale: limits.relativeScale,
      maxWidth: limits.width,
      maxHeight: limits.height,
      cacheCompatible: hasCompatibleFittedGeometry,
      autoFitZoom,
      scrollFallback
    };
  }

  function growForContent(popup, state, requested = {}) {
    if (!state || popup.hidden) return false;
    const type = state.type;
    const limits = previewAutoFitLimits(type, popup);
    const rect = popup.getBoundingClientRect();
    return resizePopup(popup, state, type, {
      left: rect.left,
      top: rect.top,
      width: Math.max(rect.width, Number(requested.width) || rect.width),
      height: Math.max(rect.height, Number(requested.height) || rect.height)
    }, {
      live: false,
      persist: false,
      contentScaleOverride: limits.relativeScale,
      widthLimit: Number(requested.maxWidth) > 0 ? Math.min(limits.width, Number(requested.maxWidth)) : limits.width,
      heightLimit: Number(requested.maxHeight) > 0 ? Math.min(limits.height, Number(requested.maxHeight)) : limits.height
    });
  }

  function clearSize(popup) {
    popup.style.removeProperty("width");
    popup.style.removeProperty("height");
    popup.style.removeProperty("max-width");
    popup.style.removeProperty("max-height");
    popup.style.removeProperty("--smarttex-popup-content-scale");
    delete popup.dataset.smarttexUserSized;
    delete popup.dataset.smarttexRelativeSized;
    delete popup.dataset.smarttexTemporarySized;
    delete popup.dataset.smarttexAutoFitMaxWidth;
    delete popup.dataset.smarttexAutoFitMaxHeight;
  }

  function ensureCloseChrome(popup, state) {
    const heading = (
      (state.options.heading instanceof Element ? state.options.heading : null) ||
      popup.querySelector(state.options.headingSelector || (
        ".smarttex-preview-heading, .smarttex-citation-header, " +
        ".smarttex-reference-autocomplete-header, .smarttex-figure-autocomplete-header, " +
        ".smarttex-reference-popup-heading, .smarttex-popup-window-heading"
      ))
    );
    if (!heading) return;
    heading.classList.add("smarttex-popup-window-heading-enhanced");
    ensureMoveHandle(popup, state, heading);

    let close = (
      (state.options.closeButton instanceof Element ? state.options.closeButton : null) ||
      heading.querySelector(
        ".smarttex-preview-close, .smarttex-citation-close, " +
        ".smarttex-reference-autocomplete-close, .smarttex-figure-autocomplete-close, " +
        ".smarttex-reference-popup-close, .smarttex-popup-window-close"
      )
    );
    if (!close) {
      close = document.createElement("button");
      close.type = "button";
      close.className = "smarttex-popup-window-close";
      close.textContent = "×";
      close.title = "Close (Esc)";
      close.setAttribute("aria-label", "Close popup");
      close.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      close.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof state.options.onClose === "function") state.options.onClose();
        else popup.hidden = true;
      });
      heading.appendChild(close);
    }
    close.hidden = false;

    let hint = heading.querySelector(".smarttex-popup-escape-hint");
    if (!hint) {
      hint = document.createElement("span");
      hint.className = "smarttex-popup-escape-hint";
      hint.textContent = "[Esc]";
      hint.setAttribute("aria-hidden", "true");
      close.before(hint);
    } else if (hint.nextElementSibling !== close) {
      close.before(hint);
    }
  }

  function restoreTemporaryMove(popup, state) {
    if (popup.dataset.smarttexTemporaryMoved !== "true") return;
    const original = state.preDragPosition || {};
    if (original.left) popup.style.left = original.left;
    else popup.style.removeProperty("left");
    if (original.top) popup.style.top = original.top;
    else popup.style.removeProperty("top");
    state.preDragPosition = null;
    delete popup.dataset.smarttexTemporaryMoved;
  }

  function startMove(event, popup, state, headingOverride = null) {
    if (event.button !== 0 || popup.hidden) return;
    if (event.target?.closest?.("button, a, input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault();
    event.stopPropagation();

    // The heading can be replaced while a preview is re-rendered. Accept an
    // explicitly resolved live heading so delegated popup handling keeps drag
    // behavior working even after such DOM replacement.
    const heading = headingOverride || event.currentTarget;
    const rect = popup.getBoundingClientRect();
    const bounds = viewportBounds();
    if (popup.dataset.smarttexTemporaryMoved !== "true") {
      state.preDragPosition = {
        left: popup.style.left,
        top: popup.style.top
      };
    }
    const origin = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    popup.classList.add("smarttex-popup-moving");
    popup.dataset.smarttexTemporaryMoved = "true";
    // Keep the direct cursor declaration in sync with the drag state. The
    // inline rule is intentional (see markMoveHandle) because host CSS can be
    // more specific than extension styles.
    heading.style.setProperty("cursor", "grabbing", "important");

    const pointerId = event.pointerId;
    try {
      heading.setPointerCapture?.(pointerId);
    } catch (_error) {
      // Synthetic test pointers may not be capturable.
    }

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const left = Math.max(
        bounds.margin,
        Math.min(
          origin.left + moveEvent.clientX - origin.pointerX,
          window.innerWidth - bounds.margin - origin.width
        )
      );
      const top = Math.max(
        bounds.margin,
        Math.min(
          origin.top + moveEvent.clientY - origin.pointerY,
          window.innerHeight - bounds.margin - origin.height
        )
      );
      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
    };

    const finish = (finishEvent) => {
      if (
        finishEvent?.type !== "blur" &&
        finishEvent?.pointerId !== undefined &&
        finishEvent.pointerId !== pointerId
      ) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish, true);
      try {
        if (heading.hasPointerCapture?.(pointerId)) heading.releasePointerCapture(pointerId);
      } catch (_error) {
        // The pointer may already have been released by the browser.
      }
      popup.classList.remove("smarttex-popup-moving");
      heading.style.setProperty("cursor", "grab", "important");
    };

    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish, true);
  }

  function markMoveHandle(heading) {
    if (!(heading instanceof Element)) return;
    heading.classList.add("smarttex-popup-move-handle");
    heading.dataset.smarttexPopupMoveHandle = "true";

    // Set the cursor on the live header itself as well as through CSS. Some
    // CollabTeX/extension style combinations replace or outrank inherited
    // cursor rules while a popup is being rerendered. The inline important
    // declaration makes the user-visible hand cursor deterministic without
    // changing any interactive child controls such as the Close button.
    // The main editor preview intentionally keeps pointer-events disabled on
    // the outer popup while selectively re-enabling interactive descendants.
    // The header must explicitly opt back in as well; otherwise it is skipped
    // during hit testing, so neither the grab cursor nor pointerdown drag logic
    // can ever run even though the drag handler itself is correctly installed.
    heading.style.setProperty("pointer-events", "auto", "important");
    heading.style.setProperty("cursor", "grab", "important");
    heading.style.setProperty("user-select", "none", "important");
    heading.style.setProperty("touch-action", "none", "important");
  }

  function ensureMoveHandle(popup, state, heading) {
    if (!heading) return;
    markMoveHandle(heading);

    // Use delegated capture-phase handling on the popup. Renderer code or host
    // UI handlers may replace the heading or stop bubbling pointer events; a
    // capture listener sees the press before those handlers and resolves the
    // *current* heading node each time. This keeps header dragging functional
    // after figure/table/equation rerenders instead of depending on a stale DOM
    // node that happened to exist when the popup was first enhanced.
    if (popup.dataset.smarttexPopupMoveDelegated === "true") return;
    popup.dataset.smarttexPopupMoveDelegated = "true";
    popup.addEventListener("pointerdown", (event) => {
      const liveHeading = event.target?.closest?.(
        ".smarttex-popup-move-handle, .smarttex-preview-heading, .smarttex-citation-header, " +
        ".smarttex-reference-autocomplete-header, .smarttex-figure-autocomplete-header, " +
        ".smarttex-reference-popup-heading, .smarttex-popup-window-heading"
      );
      if (!liveHeading || !popup.contains(liveHeading)) return;
      markMoveHandle(liveHeading);
      startMove(event, popup, state, liveHeading);
    }, { capture: true, passive: false });
  }

  function ensureResizeHandles(popup, state) {
    for (const direction of DIRECTIONS) {
      let handle = popup.querySelector(
        `:scope > .smarttex-popup-resize-handle[data-direction="${direction}"]`
      );
      if (handle) continue;
      handle = document.createElement("span");
      handle.className = "smarttex-popup-resize-handle";
      handle.dataset.direction = direction;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => startResize(event, popup, state, direction));
      popup.appendChild(handle);
    }
  }

  function startResize(event, popup, state, direction) {
    if (event.button !== 0 || popup.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const rect = popup.getBoundingClientRect();
    const type = state.type;
    const minimum = MINIMUM_SIZE[type];
    const bounds = viewportBounds();
    delete popup.dataset.smarttexRelativeSized;
    const origin = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      naturalWidth: state.naturalSizes[type]?.width || rect.width,
      naturalHeight: state.naturalSizes[type]?.height || rect.height
    };
    if (!state.naturalSizes[type]) {
      state.naturalSizes[type] = {
        width: origin.naturalWidth,
        height: origin.naturalHeight
      };
    }
    popup.classList.add("smarttex-popup-resizing");
    document.documentElement.dataset.smarttexPopupResizeDirection = direction;
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch (_error) {
      // Synthetic events used by UI harnesses do not represent an active
      // pointer, but can still exercise the resize calculation.
    }

    const pointerId = event.pointerId;
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - origin.pointerX;
      const deltaY = moveEvent.clientY - origin.pointerY;
      let left = origin.left;
      let top = origin.top;
      let width = origin.width;
      let height = origin.height;

      if (direction.includes("e")) width = origin.width + deltaX;
      if (direction.includes("s")) height = origin.height + deltaY;
      if (direction.includes("w")) {
        width = origin.width - deltaX;
        left = origin.left + deltaX;
      }
      if (direction.includes("n")) {
        height = origin.height - deltaY;
        top = origin.top + deltaY;
      }

      width = Math.min(bounds.width, Math.max(Math.min(minimum.width, bounds.width), width));
      height = Math.min(bounds.height, Math.max(Math.min(minimum.height, bounds.height), height));
      if (direction.includes("w")) left = origin.left + origin.width - width;
      if (direction.includes("n")) top = origin.top + origin.height - height;
      left = Math.max(bounds.margin, Math.min(left, window.innerWidth - bounds.margin - width));
      top = Math.max(bounds.margin, Math.min(top, window.innerHeight - bounds.margin - height));

      resizePopup(popup, state, type, { left, top, width, height }, { live: true });
    };

    const finish = (finishEvent) => {
      if (
        finishEvent?.type !== "blur" &&
        finishEvent?.pointerId !== undefined &&
        finishEvent.pointerId !== pointerId
      ) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish, true);
      try {
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      } catch (_error) {
        // The pointer may already have been released by the browser.
      }
      popup.classList.remove("smarttex-popup-resizing");
      delete document.documentElement.dataset.smarttexPopupResizeDirection;
      const finalRect = popup.getBoundingClientRect();
      resizePopup(popup, state, type, {
        left: finalRect.left,
        top: finalRect.top,
        width: finalRect.width,
        height: finalRect.height
      }, { live: false, persist: false });
      popup.dataset.smarttexTemporarySized = "true";
    };

    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish, true);
  }

  function enhance(popup, options = {}) {
    if (!(popup instanceof Element)) return null;
    let state = states.get(popup);
    if (!state) {
      state = {
        popup,
        options: {},
        type: "equation",
        naturalSizes: {},
        restoreToken: 0,
        initialized: false,
        visibilityObserver: null
      };
      states.set(popup, state);
      state.visibilityObserver = new MutationObserver(() => {
        if (popup.hidden) {
          if (popup.dataset.smarttexTemporarySized === "true") clearSize(popup);
          restoreTemporaryMove(popup, state);
          return;
        }
        if (popup.dataset.smarttexStaging === "true") return;
        scheduleSavedSize(popup, state, state.type);
      });
      state.visibilityObserver.observe(popup, {
        attributes: true,
        attributeFilter: ["hidden"]
      });
    }
    state.options = { ...state.options, ...options };
    popup.classList.add("smarttex-popup-resizable");
    ensureCloseChrome(popup, state);
    ensureResizeHandles(popup, state);

    const setType = (nextType) => {
      const type = normalizedType(nextType);
      const firstType = !state.initialized;
      const switchedType = !firstType && type !== state.type;
      const changed = switchedType || popup.dataset.smarttexPopupType !== type;
      state.type = type;
      state.initialized = true;
      state.options.type = type;
      popup.dataset.smarttexPopupType = type;
      if (changed) {
        clearSize(popup);
        if (!firstType && switchedType && !popup.hidden) state.restoreAfterContent = true;
        else scheduleSavedSize(popup, state, type);
      } else if (
        popup.dataset.smarttexUserSized !== "true" || !popup.style.width || !popup.style.height
      ) {
        scheduleSavedSize(popup, state, type);
      }
      ensureCloseChrome(popup, state);
      ensureResizeHandles(popup, state);
    };
    setType(options.type || state.type);
    return {
      setType,
      refresh: ({ rebase = false } = {}) => {
        if (rebase) {
          clearSize(popup);
          delete state.naturalSizes[state.type];
        }
        state.restoreAfterContent = false;
        scheduleSavedSize(popup, state, state.type);
        ensureCloseChrome(popup, state);
        ensureResizeHandles(popup, state);
      },
      resetForMeasurement: () => {
        // A staged preview must start from an unscaled outer popup. Otherwise a
        // figure/table can fit itself to the previous opening's slider-scaled
        // geometry and that already-shrunken inner layout becomes the next
        // measured default, causing cumulative shrink on repeated openings.
        state.restoreToken += 1;
        state.restoreAfterContent = false;
        clearSize(popup);
        delete state.naturalSizes[state.type];
        ensureCloseChrome(popup, state);
        ensureResizeHandles(popup, state);
        return true;
      },
      prepareForReveal: ({ rebase = false } = {}) => {
        state.restoreAfterContent = false;
        const prepared = prepareForReveal(popup, state, { rebase });
        ensureCloseChrome(popup, state);
        ensureResizeHandles(popup, state);
        return prepared;
      },
      prepareCachedForReveal: (cached = {}) => {
        state.restoreAfterContent = false;
        const prepared = prepareCachedForReveal(popup, state, cached);
        ensureCloseChrome(popup, state);
        ensureResizeHandles(popup, state);
        return prepared;
      },
      growForContent: (requested = {}) => {
        const grown = growForContent(popup, state, requested);
        ensureCloseChrome(popup, state);
        ensureResizeHandles(popup, state);
        return grown;
      }
    };
  }

  function fitToViewport(popup) {
    const state = states.get(popup);
    if (!state || popup.dataset.smarttexUserSized !== "true") return;
    const rect = popup.getBoundingClientRect();
    resizePopup(popup, state, state.type, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    }, { live: false, persist: false });
  }

  function rebaseOpenPopups({ reset = false } = {}) {
    document.querySelectorAll(".smarttex-popup-resizable").forEach((popup) => {
      const state = states.get(popup);
      if (state) {
        state.restoreToken += 1;
        state.naturalSizes = {};
      }
      clearSize(popup);
      popup.dispatchEvent(new CustomEvent("smarttex:popup-resized", {
        detail: {
          type: normalizedType(popup.dataset.smarttexPopupType),
          reset,
          relativeScale: relativeScaleFor(normalizedType(popup.dataset.smarttexPopupType)),
          live: false
        }
      }));
      if (state && !popup.hidden) scheduleSavedSize(popup, state, state.type);
    });
  }

  function setRelativeSizeSettings(nextSettings) {
    relativeSettings = normalizeRelativeSettings(nextSettings);
    writeRelativeSettings();

    // The sliders are the only persistent popup-size setting. Their percentages
    // are applied to the popup's measured default width and height. Manual edge
    // dragging never writes this setting and is temporary to the current popup.
    document.querySelectorAll(".smarttex-popup-resizable").forEach((popup) => {
      const state = states.get(popup);
      if (!state || !RELATIVE_SCALE_TYPES.has(state.type)) return;
      state.restoreToken += 1;
      if (popup.hidden) return;

      const naturalSize = state.naturalSizes[state.type];
      if (naturalSize) {
        prepareForReveal(popup, state, { rebase: false });
        delete popup.dataset.smarttexTemporarySized;
        popup.dataset.smarttexRelativeSized = "true";
        return;
      }

      // A popup that has not yet been measured is first returned to its default
      // geometry; the normal restore path then measures that baseline and applies
      // the selected ratio to both dimensions.
      clearSize(popup);
      scheduleSavedSize(popup, state, state.type);
    });
    return { ...relativeSettings };
  }

  function resetSizes() {
    const requestedRelativeSettings = arguments[0]?.relativeSettings;
    sizes = {};
    relativeSettings = normalizeRelativeSettings(requestedRelativeSettings || {
      mode: relativeSettings.mode,
      global: 1,
      image: 1,
      equation: 1,
      table: 1
    });
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(RELATIVE_SCALE_KEY, JSON.stringify(relativeSettings));
    } catch (_error) {
      // Current popup instances can still be reset in restricted documents.
    }
    rebaseOpenPopups({ reset: true });
  }

  window.addEventListener("smarttex:set-popup-relative-size", (event) => {
    setRelativeSizeSettings(event.detail);
  });
  window.addEventListener("smarttex:reset-popup-sizes", (event) => {
    resetSizes(event.detail || {});
  });

  window.addEventListener("resize", () => {
    document.querySelectorAll(".smarttex-popup-resizable").forEach(fitToViewport);
  }, { passive: true });

  globalThis.SmartTeXPopupUI = Object.freeze({
    enhance,
    fitToViewport,
    resetSizes,
    setRelativeSizeSettings,
    getRelativeSizeSettings: () => ({ ...relativeSettings })
  });
})();
