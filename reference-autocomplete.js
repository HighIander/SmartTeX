/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (window.top !== window) return;
  const existingReferenceAutocomplete = document.getElementById("smarttex-reference-autocomplete-popup");
  if (globalThis.__smartTeXReferenceAutocompleteLoaded && existingReferenceAutocomplete) return;
  if (globalThis.__smartTeXReferenceAutocompleteLoaded && !existingReferenceAutocomplete) {
    globalThis.__smartTeXReferenceAutocompleteLoaded = false;
  }
  if (globalThis.__smartTeXReferenceAutocompleteLoading) return;
  globalThis.__smartTeXReferenceAutocompleteLoading = true;

  const initializeWhenDependenciesAreReady = async () => {
    const startedAt = Date.now();
    let repairRequested = false;
    while (!(globalThis.SmartTeXLatexContext?.referenceTarget &&
        globalThis.SmartTeXLatexContext?.maskIgnoredLatex &&
        globalThis.SmartTeXTableRenderer?.renderInlineLatex && globalThis.katex?.render)) {
      if (!repairRequested) {
        repairRequested = true;
        try {
          const api = globalThis.browser ?? globalThis.chrome;
          await api?.runtime?.sendMessage?.({ type: "smarttex-reinject-preview-dependencies" });
        } catch (_error) {
          // The normal registered content-script order may still complete without fallback injection.
        }
      }
      if (Date.now() - startedAt > 10000) {
        throw new Error("SmartTeX reference autocomplete could not load its LaTeX context parser.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (globalThis.__smartTeXReferenceAutocompleteLoaded) return;
    globalThis.__smartTeXReferenceAutocompleteLoaded = true;
    globalThis.__smartTeXReferenceAutocompleteLoading = false;

  const STATE_EVENT = "smarttex:editor-state";
  const PREVIEW_STATE_EVENT = "smarttex:preview-editor-state";
  const REQUEST_EVENT = "smarttex:citation-editor-request";
  const RESPONSE_EVENT = "smarttex:citation-editor-response";
  const PREVIEW_EVENT = "smarttex:reference-autocomplete-preview";
  const PREVIEW_HIDE_EVENT = "smarttex:reference-autocomplete-preview-hide";
  const ACTIVE_EVENT = "smarttex:reference-autocomplete-active";
  const SETTINGS_KEY = "smarttex:autocomplete:v1";
  const EQUATION_VIEW_MODE_KEY = "smarttex:equation-reference-list-view:v1";
  const RUNTIME_SETTINGS_EVENT = "smarttex:runtime-settings";
  const OPEN_DELAY_MS = 70;
  const TYPING_CONTEXT_GRACE_MS = 900;
  const REFERENCE_COMMAND = /\\(eqref|ref|pageref|autoref|cref|Cref|vref|Vref|nameref)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)$/;

  function matchingArgumentClose(source, openIndex) {
    let depth = 0;
    for (let index = Math.max(0, Number(openIndex) || 0); index < source.length; index += 1) {
      const character = source[index];
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const contextTools = globalThis.SmartTeXLatexContext;
  const tableRenderer = globalThis.SmartTeXTableRenderer;
  const katex = globalThis.katex;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const popupInteractionReady = () => globalThis.SmartTeXPopupGate?.isReady?.() !== false;


  let currentState = null;
  let currentContext = null;
  let records = [];
  let renderedRecords = [];
  let selectedIndex = 0;
  let lastPopupPosition = null;
  let popupTimer = null;
  let typingContextValidationTimer = null;
  let immediateOpenUntil = 0;
  let dismissedContextId = "";
  let requestCounter = 0;
  let sourceCache = null;
  let sourceCacheFileName = "";
  let targetCache = new Map();
  let configuredOrderMode = "document";
  let orderMode = "document";
  let viewMode = "grid";
  let previewGeneration = 0;
  let listRenderGeneration = 0;
  let listRenderRetryFrame = null;
  let popupRefitFrame = null;
  let targetHydrationFrame = null;
  let targetHydrationQueue = [];
  let scrollSuppressed = false;
  let lastTextInputAt = 0;
  let runtimeSettingsOverrideActive = false;
  let recordIndexWarmTimer = 0;
  let recordIndexWarmGeneration = 0;
  let recordIndexWarmSource = null;
  const pendingRequests = new Map();

  const popup = document.createElement("aside");
  popup.id = "smarttex-reference-autocomplete-popup";
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "SmartTeX reference suggestions");
  popup.innerHTML = `
    <header class="smarttex-reference-autocomplete-header">
      <span class="smarttex-reference-autocomplete-query">Reference</span>
      <button type="button" class="smarttex-reference-autocomplete-order" aria-pressed="false">Sort alphabetically</button>
      <button type="button" class="smarttex-reference-autocomplete-view" aria-pressed="false" aria-label="Switch to equation thumbnail grid view" title="Switch to equation thumbnail grid view" hidden>
        <svg class="smarttex-reference-autocomplete-view-grid-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10"></circle>
          <rect x="7" y="7" width="3" height="3" rx="0.45"></rect>
          <rect x="14" y="7" width="3" height="3" rx="0.45"></rect>
          <rect x="7" y="14" width="3" height="3" rx="0.45"></rect>
          <rect x="14" y="14" width="3" height="3" rx="0.45"></rect>
        </svg>
        <svg class="smarttex-reference-autocomplete-view-list-icon" viewBox="0 0 24 24" aria-hidden="true" hidden>
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="7" y1="8" x2="17" y2="8"></line>
          <line x1="7" y1="12" x2="17" y2="12"></line>
          <line x1="7" y1="16" x2="17" y2="16"></line>
        </svg>
      </button>
      <span class="smarttex-popup-escape-hint" aria-hidden="true">[Esc]</span>
      <button type="button" class="smarttex-reference-autocomplete-close" title="Close (Esc)" aria-label="Close reference suggestions">&times;</button>
    </header>
    <div class="smarttex-reference-autocomplete-list" role="listbox" aria-label="Reference suggestions"></div>`;
  document.documentElement.appendChild(popup);

  const queryLabel = popup.querySelector(".smarttex-reference-autocomplete-query");
  const orderLabel = popup.querySelector(".smarttex-reference-autocomplete-order");
  const viewButton = popup.querySelector(".smarttex-reference-autocomplete-view");
  const gridViewIcon = viewButton.querySelector(".smarttex-reference-autocomplete-view-grid-icon");
  const listViewIcon = viewButton.querySelector(".smarttex-reference-autocomplete-view-list-icon");
  const list = popup.querySelector(".smarttex-reference-autocomplete-list");
  const closeButton = popup.querySelector(".smarttex-reference-autocomplete-close");
  globalThis.SmartTeXPopupUI?.enhance?.(popup, {
    type: "list",
    closeButton,
    onClose: () => hidePopup({ dismiss: true })
  });

  function schedulePopupRefit() {
    if (popup.hidden || popupRefitFrame !== null) return;
    popupRefitFrame = window.requestAnimationFrame(() => {
      popupRefitFrame = null;
      if (!popup.hidden) positionPopup();
    });
  }

  if (typeof ResizeObserver === "function") {
    const popupResizeObserver = new ResizeObserver(schedulePopupRefit);
    popupResizeObserver.observe(popup);
  }
  popup.addEventListener("smarttex:popup-resized", () => {
    const rect = popup.getBoundingClientRect();
    lastPopupPosition = { left: rect.left, top: rect.top };
    positionPopup();
  });

  function normalizeOrder(value) {
    return value === "alphabetical" ? "alphabetical" : "document";
  }

  function normalizeViewMode(value) {
    return value === "list" ? "list" : "grid";
  }

  async function loadSettings() {
    try {
      const [storedSettings, storedViewMode] = await Promise.all([
        extensionApi?.storage?.local?.get?.(SETTINGS_KEY),
        extensionApi?.storage?.local?.get?.(EQUATION_VIEW_MODE_KEY)
      ]);
      configuredOrderMode = normalizeOrder(storedSettings?.[SETTINGS_KEY]?.referenceOrder);
      viewMode = normalizeViewMode(storedViewMode?.[EQUATION_VIEW_MODE_KEY]);
      const runtimeOrder = globalThis.SmartTeXRuntimeSettings?.autocomplete?.referenceOrder;
      runtimeSettingsOverrideActive = globalThis.SmartTeXRuntimeSettings?.usingPresets === false;
      if (runtimeOrder) configuredOrderMode = normalizeOrder(runtimeOrder);
      orderMode = configuredOrderMode;
    } catch (_error) {
      configuredOrderMode = "document";
      orderMode = configuredOrderMode;
      viewMode = "grid";
    }
  }

  function persistEquationViewMode() {
    Promise.resolve(extensionApi?.storage?.local?.set?.({
      [EQUATION_VIEW_MODE_KEY]: viewMode
    })).catch(() => {});
  }

  function contextId(context = currentContext) {
    if (!context) return "";
    return [
      currentState?.fileName || "",
      context.command,
      context.anchorIndex,
      context.fragmentStart
    ].join(":");
  }

  function clearPopupTimer() {
    window.clearTimeout(popupTimer);
    popupTimer = null;
  }

  function clearTypingContextValidation() {
    window.clearTimeout(typingContextValidationTimer);
    typingContextValidationTimer = null;
  }

  function textInputIsRecent() {
    return Date.now() - lastTextInputAt < TYPING_CONTEXT_GRACE_MS;
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 1800) {
    const requestId = `reference-${Date.now()}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`SmartTeX editor request timed out: ${type}`));
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
    else pending.reject(new Error(response.error || "SmartTeX editor request failed."));
  });

  function setBridgeActive(active) {
    window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, {
      detail: JSON.stringify({
        owner: "reference-autocomplete",
        active: Boolean(active)
      })
    }));
    bridgeRequest("setReferenceAutocompleteActive", {
      active: Boolean(active)
    }, 1000).catch(() => {});
  }

  function dispatchPreviewHide({ force = false } = {}) {
    previewGeneration += 1;
    window.dispatchEvent(new CustomEvent(PREVIEW_HIDE_EVENT, {
      detail: JSON.stringify({
        owner: "reference-autocomplete",
        force: Boolean(force)
      })
    }));
  }

  function hidePopup({ dismiss = false } = {}) {
    listRenderGeneration += 1;
    if (listRenderRetryFrame !== null) window.cancelAnimationFrame(listRenderRetryFrame);
    listRenderRetryFrame = null;
    if (targetHydrationFrame !== null) window.cancelAnimationFrame(targetHydrationFrame);
    targetHydrationFrame = null;
    targetHydrationQueue = [];
    clearTypingContextValidation();
    popup.removeAttribute("aria-busy");
    clearPopupTimer();
    if (dismiss && currentContext) dismissedContextId = contextId();
    popup.hidden = true;
    list.replaceChildren();
    renderedRecords = [];
    lastPopupPosition = null;
    popup.classList.remove("smarttex-reference-autocomplete-visible");
    setBridgeActive(false);
    dispatchPreviewHide({ force: true });
  }

  function showPopup() {
    if (!popupInteractionReady() || !currentContext) return;
    popup.hidden = false;
    popup.classList.add("smarttex-reference-autocomplete-visible");
    setBridgeActive(true);
    positionPopup();
  }

  function findReferenceContext(state) {
    if (
      !state?.value ||
      !Number.isInteger(state.cursorIndex) ||
      state.focused === false ||
      !/\.(?:tex|ltx)$/i.test(String(state.fileName || "main.tex"))
    ) {
      return null;
    }
    const cursor = Math.max(0, Math.min(state.cursorIndex, state.value.length));
    const lineStart = state.value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
    const scanStart = Math.max(lineStart, cursor - 4096);
    const sourceWindow = state.value.slice(scanStart, cursor);
    const beforeCursor = (typeof contextTools !== "undefined" && contextTools?.maskIgnoredLatex)
      ? contextTools.maskIgnoredLatex(sourceWindow)
      : sourceWindow;
    const match = beforeCursor.match(REFERENCE_COMMAND);
    if (!match) return null;
    const completeMatch = match[0];
    const command = match[1];
    const argument = match[2];
    const lastComma = argument.lastIndexOf(",");
    const beforeFragment = argument.slice(lastComma + 1);
    const leadingWhitespace = beforeFragment.match(/^\s*/)?.[0] || "";
    const fragmentStart = state.cursorIndex - beforeFragment.length + leadingWhitespace.length;
    const commandStart = scanStart + beforeCursor.length - completeMatch.length;
    const anchorIndex = commandStart + completeMatch.lastIndexOf("{");
    const argumentIsClosed = matchingArgumentClose(state.value, anchorIndex) >= state.cursorIndex;
    // Text to the right of the cursor only belongs to the active completion
    // token when the command argument has a matching closing brace.
    const afterFragment = argumentIsClosed
      ? (state.value.slice(state.cursorIndex).match(/^[^,{}\s]*/)?.[0] || "")
      : "";
    return {
      command,
      fragment: beforeFragment.slice(leadingWhitespace.length) + afterFragment,
      currentLabel: (
        beforeFragment.slice(leadingWhitespace.length) + afterFragment
      ).trim(),
      fragmentStart,
      fragmentEnd: state.cursorIndex + afterFragment.length,
      commandStart,
      anchorIndex
    };
  }

  function rebuildRecords(sourceValue) {
    const source = String(sourceValue || "");
    if (source === sourceCache) return true;
    const calculate = () => {
      const masked = contextTools.maskIgnoredLatex(source);
      const equationRanges = (contextTools.equationContexts?.(source)?.contexts || [])
        .map((context) => ({
          start: Number(context.openStart) || 0,
          end: Number(context.closeEnd) || 0
        }))
        .sort((left, right) => left.start - right.start);
      let equationRangeIndex = 0;
      const seen = new Set();
      const nextRecords = [];
      const pattern = /\\label\s*\{([^{}]+)\}/g;
      let match;
      while ((match = pattern.exec(masked))) {
        interactionTasks?.checkpoint?.(pattern.lastIndex, 64);
        const label = String(match[1] || "").trim();
        if (!label || seen.has(label)) continue;
        while (
          equationRangeIndex < equationRanges.length &&
          equationRanges[equationRangeIndex].end < match.index
        ) equationRangeIndex += 1;
        const equationRange = equationRanges[equationRangeIndex];
        seen.add(label);
        nextRecords.push({
          label,
          sourceIndex: match.index,
          documentOrder: nextRecords.length,
          equation: Boolean(
            equationRange &&
            match.index >= equationRange.start &&
            match.index <= equationRange.end
          )
        });
      }
      return nextRecords;
    };
    try {
      const nextRecords = interactionTasks?.runSync
        ? interactionTasks.runSync("reference-target-index", calculate)
        : calculate();
      sourceCache = source;
      sourceCacheFileName = String(currentState?.fileName || "main.tex");
      targetCache = new Map();
      records = nextRecords;
      return true;
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) return false;
      throw error;
    }
  }

  function scheduleRecordIndexWarm(sourceValue) {
    const source = String(sourceValue || "");
    if (!source || source === sourceCache) return;
    if (recordIndexWarmSource === source && recordIndexWarmTimer) return;
    window.clearTimeout(recordIndexWarmTimer);
    recordIndexWarmSource = source;
    const generation = ++recordIndexWarmGeneration;
    const delay = Math.max(80, Number(interactionTasks?.keyboardIdleRemaining?.()) || 0);
    recordIndexWarmTimer = window.setTimeout(() => {
      recordIndexWarmTimer = 0;
      const run = () => {
        if (
          generation !== recordIndexWarmGeneration ||
          source !== recordIndexWarmSource ||
          source !== String(currentState?.value || "")
        ) return;
        if (
          scrollSuppressed ||
          (interactionTasks?.canRunBackgroundTask &&
            !interactionTasks.canRunBackgroundTask(currentState, source.length))
        ) {
          recordIndexWarmSource = null;
          scheduleRecordIndexWarm(source);
          return;
        }
        rebuildRecords(source);
        recordIndexWarmSource = null;
      };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 500 });
      } else {
        window.setTimeout(run, 0);
      }
    }, delay);
  }

  function targetFor(record) {
    if (!record) return null;
    if (targetCache.has(record.label)) return targetCache.get(record.label);
    let target = null;
    try {
      target = interactionTasks?.runSync
        ? interactionTasks.runSync(
            "reference-target-preview",
            () => contextTools.referenceTarget(sourceCache || "", record.label)
          )
        : contextTools.referenceTarget(sourceCache || "", record.label);
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) throw error;
      target = null;
    }
    targetCache.set(record.label, target);
    return target;
  }

  function targetTypeText(target) {
    return ({
      equation: "Equation",
      figure: "Figure",
      table: "Table",
      section: "Section",
      label: "Label"
    })[target?.type] || "Reference";
  }

  function targetDescription(target) {
    const type = targetTypeText(target);
    const number = String(target?.number || "").trim();
    const title = String(target?.title || target?.caption || "").trim();
    const primary = number ? `${type} ${number}` : type;
    return title ? `${primary} — ${title}` : primary;
  }

  function renderTargetDescription(container, target) {
    const description = targetDescription(target);
    container.replaceChildren();
    container.title = description;
    const title = String(target?.title || "").trim();
    if (target?.type !== "section" || !title) {
      container.textContent = description;
      return;
    }
    const type = targetTypeText(target);
    const number = String(target?.number || "").trim();
    const primary = number ? `${type} ${number}` : type;
    try {
      const prepared = contextTools.prepareDocumentCommands(
        sourceCache || "",
        Number(target.sourceIndex) || 0,
        title
      );
      const rendered = tableRenderer.renderInlineLatex(prepared.body, {
        contextTools,
        document,
        katex,
        macros: prepared.macros,
        trust: false,
        sourceOffset: Number(target.sourceIndex) || 0
      });
      container.append(`${primary} — `, rendered);
    } catch (_error) {
      container.textContent = description;
    }
  }

  function inlineLoadingSpinner(label = "Loading") {
    const spinner = document.createElement("span");
    spinner.className = "smarttex-inline-loading-spinner";
    spinner.setAttribute("aria-label", label);
    spinner.setAttribute("role", "status");
    return spinner;
  }

  function matchRank(record, fragment) {
    const query = String(fragment || "").trim().toLocaleLowerCase();
    if (!query) return 0;
    const label = record.label.toLocaleLowerCase();
    if (label === query) return 0;
    if (label.startsWith(query)) return 1;
    const tokenIndex = label.search(new RegExp(
      `(?:^|[:._/\\-])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    ));
    if (tokenIndex >= 0) return 2 + tokenIndex / 1000;
    const contained = label.indexOf(query);
    if (contained >= 0) return 3 + contained / 1000;
    return Number.POSITIVE_INFINITY;
  }

  function matchingRecords(context) {
    const command = context?.command || "ref";
    const fragment = context?.fragment || "";
    const calculate = () => {
      const matches = [];
      for (let index = 0; index < records.length; index += 1) {
        interactionTasks?.checkpoint?.(index, 32);
        const record = records[index];
        if (command === "eqref" && !record.equation) continue;
        if (!Number.isFinite(matchRank(record, fragment))) continue;
        matches.push(record);
      }
      let comparisonCount = 0;
      matches.sort((left, right) => {
        interactionTasks?.checkpoint?.(comparisonCount++, 32);
        if (orderMode === "alphabetical") {
          return left.label.localeCompare(right.label, undefined, {
            sensitivity: "base",
            numeric: true
          });
        }
        return left.documentOrder - right.documentOrder;
      });
      // Reference lists must remain complete. A hard result cap made labels
      // beyond the first page appear only after the user typed enough text to
      // move them into the truncated result set.
      return matches.map((record, index) => {
        interactionTasks?.checkpoint?.(index, 8);
        return {
          record,
          // Populate expensive target metadata lazily after the complete label
          // list is visible. Cached targets remain available immediately.
          target: targetCache.has(record.label) ? targetCache.get(record.label) : null
        };
      });
    };
    try {
      return interactionTasks?.runSync
        ? interactionTasks.runSync("reference-list-filter", calculate)
        : calculate();
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) return null;
      throw error;
    }
  }

  function selectedItemElement() {
    return list.querySelectorAll(".smarttex-reference-autocomplete-item")[selectedIndex] || null;
  }

  function appendHighlightedLabel(container, value, queryValue) {
    const text = String(value || "");
    const query = String(queryValue || "").trim().toLocaleLowerCase();
    if (!query) {
      container.textContent = text;
      return;
    }
    const searchable = text.toLocaleLowerCase();
    let offset = 0;
    let matchIndex = searchable.indexOf(query, offset);
    if (matchIndex < 0) {
      container.textContent = text;
      return;
    }
    while (matchIndex >= 0) {
      if (matchIndex > offset) {
        container.appendChild(document.createTextNode(text.slice(offset, matchIndex)));
      }
      const match = document.createElement("strong");
      match.className = "smarttex-autocomplete-match";
      match.textContent = text.slice(matchIndex, matchIndex + query.length);
      container.appendChild(match);
      offset = matchIndex + query.length;
      matchIndex = searchable.indexOf(query, offset);
    }
    if (offset < text.length) {
      container.appendChild(document.createTextNode(text.slice(offset)));
    }
  }

  function stopTargetHydration() {
    if (targetHydrationFrame !== null) window.cancelAnimationFrame(targetHydrationFrame);
    targetHydrationFrame = null;
    targetHydrationQueue = [];
  }

  function applyHydratedTarget(task, target) {
    if (
      task.generation !== listRenderGeneration ||
      !task.item.isConnected ||
      renderedRecords[task.index] !== task.entry
    ) return;
    task.entry.target = target;
    renderTargetDescription(task.description, target);
    if (task.thumbnail?.isConnected) {
      task.thumbnail.replaceWith(equationThumbnail(target));
      fitEquationThumbnails();
    }
    if (task.index === selectedIndex) previewSelected();
  }

  function processTargetHydrationQueue() {
    targetHydrationFrame = null;
    const task = targetHydrationQueue.shift();
    if (!task) return;
    if (
      task.generation === listRenderGeneration &&
      task.item.isConnected &&
      renderedRecords[task.index] === task.entry
    ) {
      try {
        applyHydratedTarget(task, targetFor(task.entry.record));
      } catch (error) {
        if (!interactionTasks?.isAbortError?.(error)) throw error;
        // A cooperative cancellation only means that foreground input won the
        // current frame. Keep the still-current item in the queue; dropping it
        // here leaves both of its loading indicators in the DOM forever.
        if (
          task.generation === listRenderGeneration &&
          task.item.isConnected &&
          renderedRecords[task.index] === task.entry
        ) {
          targetHydrationQueue.push(task);
        }
      }
    }
    if (targetHydrationQueue.length) {
      targetHydrationFrame = window.requestAnimationFrame(processTargetHydrationQueue);
    }
  }

  function queueTargetHydration(task, { priority = false } = {}) {
    if (!task?.entry || task.entry.target) return;
    const existingIndex = targetHydrationQueue.findIndex(
      (candidate) => candidate.entry === task.entry
    );
    if (existingIndex >= 0) {
      if (priority && existingIndex > 0) {
        const [existing] = targetHydrationQueue.splice(existingIndex, 1);
        targetHydrationQueue.unshift(existing);
      }
    } else if (priority) {
      targetHydrationQueue.unshift(task);
    } else {
      targetHydrationQueue.push(task);
    }
    if (targetHydrationFrame === null) {
      targetHydrationFrame = window.requestAnimationFrame(processTargetHydrationQueue);
    }
  }

  function equationThumbnailMode() {
    return currentContext?.command === "eqref" && viewMode === "grid";
  }

  function updateViewButton() {
    const available = currentContext?.command === "eqref";
    const gridActive = available && viewMode === "grid";
    viewButton.toggleAttribute("hidden", !available);
    list.classList.toggle("smarttex-reference-autocomplete-grid", gridActive);
    viewButton.setAttribute("aria-pressed", gridActive ? "true" : "false");
    viewButton.setAttribute(
      "aria-label",
      gridActive ? "Switch to list view" : "Switch to equation thumbnail grid view"
    );
    viewButton.title = viewButton.getAttribute("aria-label");
    gridViewIcon.toggleAttribute("hidden", gridActive);
    listViewIcon.toggleAttribute("hidden", !gridActive);
  }

  function equationThumbnail(target) {
    const thumbnail = document.createElement("span");
    thumbnail.className = "smarttex-reference-autocomplete-thumbnail";
    thumbnail.setAttribute("aria-hidden", "true");
    if (!target?.context || target.type !== "equation") {
      thumbnail.textContent = "Equation preview unavailable";
      return thumbnail;
    }
    try {
      const surface = document.createElement("span");
      surface.className = "smarttex-reference-autocomplete-thumbnail-surface";
      const body = contextTools.previewBody(
        target.context,
        null,
        null,
        false
      );
      const prepared = contextTools.prepareDocumentCommands(
        sourceCache || "",
        target.sourceIndex,
        body
      );
      globalThis.katex.render(prepared.body, surface, {
        displayMode: true,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        maxExpand: 1000,
        maxSize: 25,
        macros: {
          ...prepared.macros,
          "\\label": { tokens: [], numArgs: 1 },
          "\\nonumber": "",
          "\\notag": ""
        }
      });
      thumbnail.appendChild(surface);
    } catch (_error) {
      thumbnail.textContent = `Equation ${target.number || target.label || ""}`.trim();
    }
    return thumbnail;
  }

  function fitEquationThumbnails() {
    window.requestAnimationFrame(() => {
      for (const thumbnail of list.querySelectorAll(
        ".smarttex-reference-autocomplete-thumbnail"
      )) {
        const surface = thumbnail.querySelector(
          ".smarttex-reference-autocomplete-thumbnail-surface"
        );
        if (!surface) continue;
        surface.style.transform = "none";
        const availableWidth = Math.max(1, thumbnail.clientWidth - 12);
        const availableHeight = Math.max(1, thumbnail.clientHeight - 10);
        const naturalRect = surface.getBoundingClientRect();
        const naturalWidth = Math.max(1, surface.scrollWidth, naturalRect.width);
        const naturalHeight = Math.max(1, surface.scrollHeight, naturalRect.height);
        const scale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
        // Long matrices and aligned equations still have to fit. A minimum
        // scale clipped precisely the equations for which the grid is useful.
        surface.style.transform = `translate(-50%, -50%) scale(${Math.max(0.01, scale)})`;
      }
    });
  }

  function openEquationThumbnailPreview(entry, item) {
    if (!entry?.record || !item || popup.hidden) return;
    const thumbnail = item.querySelector(
      ".smarttex-reference-autocomplete-thumbnail"
    );
    if (!thumbnail) return;
    const rect = thumbnail.getBoundingClientRect();
    const ownerRect = popup.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, {
      detail: JSON.stringify({
        owner: "reference-autocomplete",
        mode: "click",
        zoomable: true,
        label: entry.record.label,
        command: "eqref",
        sourceIndex: Number(currentContext?.commandStart) || 0,
        anchorRect: {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom
        },
        ownerRect: {
          left: ownerRect.left,
          right: ownerRect.right,
          top: ownerRect.top,
          bottom: ownerRect.bottom
        }
      })
    }));
  }

  function previewSelected() {
    if (equationThumbnailMode()) {
      dispatchPreviewHide({ force: true });
      return;
    }
    const selected = renderedRecords[selectedIndex];
    const item = selectedItemElement();
    if (popup.hidden) return;
    if (selected && !selected.target && item) {
      const description = item.querySelector(
        ".smarttex-reference-autocomplete-description"
      );
      if (description) {
        queueTargetHydration({
          generation: listRenderGeneration,
          index: selectedIndex,
          entry: selected,
          item,
          description,
          thumbnail: item.querySelector(
            ".smarttex-reference-autocomplete-thumbnail"
          )
        }, { priority: true });
      }
    }
    if (!selected?.target || !item) {
      dispatchPreviewHide({ force: true });
      return;
    }
    if (selected.target.type === "section") {
      dispatchPreviewHide({ force: true });
      return;
    }
    const generation = ++previewGeneration;
    window.requestAnimationFrame(() => {
      if (generation !== previewGeneration || popup.hidden || item !== selectedItemElement()) return;
      const rect = item.getBoundingClientRect();
      const ownerRect = popup.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, {
        detail: JSON.stringify({
          owner: "reference-autocomplete",
          label: selected.record.label,
          command: currentContext?.command || "ref",
          sourceIndex: Number(currentContext?.commandStart) || 0,
          anchorRect: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom
          },
          ownerRect: {
            left: ownerRect.left,
            right: ownerRect.right,
            top: ownerRect.top,
            bottom: ownerRect.bottom
          }
        })
      }));
    });
  }

  function updateSelectedItem({ preview = true } = {}) {
    const items = [...list.querySelectorAll(".smarttex-reference-autocomplete-item")];
    items.forEach((item, index) => {
      const selected = index === selectedIndex;
      item.classList.toggle("smarttex-reference-autocomplete-selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
    });
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    if (preview) previewSelected();
  }

  function renderPopupNow() {
    try {
      return interactionTasks?.runSync
        ? interactionTasks.runSync("reference-list-render", renderPopupRows)
        : renderPopupRows();
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) return false;
      throw error;
    }
  }

  function renderPopupRows() {
    stopTargetHydration();
    updateViewButton();
    queryLabel.textContent = currentContext?.fragment
      ? `${currentContext.command} matching “${currentContext.fragment}”`
      : `Select a ${currentContext?.command || "ref"} target`;
    const alphabetical = orderMode === "alphabetical";
    orderLabel.textContent = "Sort alphabetically";
    orderLabel.classList.toggle(
      "smarttex-reference-autocomplete-order-active",
      alphabetical
    );
    orderLabel.setAttribute("aria-pressed", alphabetical ? "true" : "false");
    orderLabel.title = alphabetical
      ? "Alphabetical sorting is enabled for this completion list"
      : "Sort this completion list alphabetically";
    const nextRecords = matchingRecords(currentContext);
    if (!nextRecords) return false;
    const exactIndex = nextRecords.findIndex(
      (entry) => entry.record.label === currentContext?.currentLabel
    );
    if (exactIndex >= 0) selectedIndex = exactIndex;
    if (selectedIndex >= nextRecords.length) selectedIndex = 0;

    const fragment = document.createDocumentFragment();

    if (!nextRecords.length) {
      const empty = document.createElement("p");
      empty.className = "smarttex-reference-autocomplete-empty";
      empty.textContent = currentContext?.command === "eqref"
        ? "No matching equation label was found."
        : "No matching reference label was found.";
      fragment.appendChild(empty);
      renderedRecords = nextRecords;
      list.replaceChildren(fragment);
      dispatchPreviewHide({ force: true });
      schedulePopupRefit();
      return true;
    }

    const hydrationTasks = [];
    nextRecords.forEach((entry, index) => {
      interactionTasks?.checkpoint?.(index, 8);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "smarttex-reference-autocomplete-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
      item.classList.toggle(
        "smarttex-reference-autocomplete-exact",
        Boolean(currentContext?.currentLabel) && entry.record.label === currentContext.currentLabel
      );
      item.classList.toggle("smarttex-reference-autocomplete-selected", index === selectedIndex);

      const label = document.createElement("code");
      label.className = "smarttex-reference-autocomplete-label";
      appendHighlightedLabel(label, entry.record.label, currentContext?.fragment);
      label.title = entry.record.label;
      const description = document.createElement("span");
      description.className = "smarttex-reference-autocomplete-description";
      if (entry.target) {
        renderTargetDescription(description, entry.target);
      } else {
        description.appendChild(inlineLoadingSpinner("Loading reference details"));
      }
      let thumbnail = null;
      let previewButton = null;
      if (equationThumbnailMode()) {
        thumbnail = entry.target
          ? equationThumbnail(entry.target)
          : document.createElement("span");
        if (!entry.target) {
          thumbnail.className = "smarttex-reference-autocomplete-thumbnail";
          thumbnail.setAttribute("aria-hidden", "true");
          thumbnail.appendChild(inlineLoadingSpinner("Rendering equation"));
        }
        item.appendChild(thumbnail);
        previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.className = "smarttex-reference-autocomplete-thumbnail-open";
        previewButton.textContent = "+";
        previewButton.setAttribute("aria-label", "Open zoomable equation preview");
        previewButton.title = "Open zoomable equation preview";
      }
      item.append(label, description);
      item.addEventListener("mouseenter", () => {
        if (selectedIndex === index) {
          previewSelected();
          return;
        }
        selectedIndex = index;
        updateSelectedItem();
      });
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => insertRecord(entry.record));
      if (previewButton) {
        const gridCell = document.createElement("div");
        gridCell.className = "smarttex-reference-autocomplete-grid-cell";
        previewButton.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        previewButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectedIndex = index;
          updateSelectedItem({ preview: false });
          openEquationThumbnailPreview(entry, item);
        });
        gridCell.append(item, previewButton);
        fragment.appendChild(gridCell);
      } else {
        fragment.appendChild(item);
      }
      if (!entry.target) {
        hydrationTasks.push({
          generation: listRenderGeneration,
          index,
          entry,
          item,
          description,
          thumbnail
        });
      }
    });
    renderedRecords = nextRecords;
    list.replaceChildren(fragment);
    if (equationThumbnailMode()) fitEquationThumbnails();
    hydrationTasks.forEach((task) => queueTargetHydration(task, {
      priority: task.index === selectedIndex
    }));
    previewSelected();
    schedulePopupRefit();
    return true;
  }

  function loadingListContent() {
    const row = document.createElement("p");
    row.className = "smarttex-reference-autocomplete-empty smarttex-list-loading";
    const spinner = document.createElement("span");
    spinner.className = "smarttex-inline-loading-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "Gathering reference targets…";
    row.append(spinner, text);
    return row;
  }

  function scheduleListRenderRetry() {
    if (listRenderRetryFrame !== null) return;
    listRenderRetryFrame = window.requestAnimationFrame(() => {
      listRenderRetryFrame = null;
      if (currentContext && !popup.hidden) renderPopup();
    });
  }

  function renderPopup() {
    if (!currentContext || !currentState) return;
    if (listRenderRetryFrame !== null) window.cancelAnimationFrame(listRenderRetryFrame);
    listRenderRetryFrame = null;
    stopTargetHydration();
    const generation = ++listRenderGeneration;
    popup.setAttribute("aria-busy", "true");
    const cachedPointerOpen = currentState.interactionPriority === "pointer" && sourceCache !== null && sourceCacheFileName === String(currentState.fileName || "main.tex");
    if (sourceCache === currentState.value || cachedPointerOpen) {
      if (cachedPointerOpen && sourceCache !== currentState.value) scheduleRecordIndexWarm(currentState.value);
      try {
        if (renderPopupNow() === false) scheduleListRenderRetry();
      } finally {
        if (generation === listRenderGeneration) {
          popup.removeAttribute("aria-busy");
          positionPopup();
        }
      }
      return;
    }
    // Preserve the existing rows while an open list is being filtered. The
    // loading placeholder is only needed for the initial population.
    if (popup.hidden || !list.children.length) {
      list.replaceChildren(loadingListContent());
      schedulePopupRefit();
    }
    window.requestAnimationFrame(() => {
      if (generation !== listRenderGeneration || !currentContext || !currentState) return;
      try {
        if (!rebuildRecords(currentState.value)) {
          scheduleListRenderRetry();
          return;
        }
        if (renderPopupNow() === false) scheduleListRenderRetry();
      } finally {
        if (generation === listRenderGeneration) {
          popup.removeAttribute("aria-busy");
          positionPopup();
        }
      }
    });
  }

  async function insertRecord(record) {
    if (!record || !currentContext) return;
    const dismissedId = contextId();
    hidePopup();
    try {
      await bridgeRequest("replaceReferenceToken", { text: record.label });
      dismissedContextId = dismissedId;
    } catch (error) {
      dismissedContextId = "";
      renderPopup();
      showPopup();
      console.warn("SmartTeX could not insert the reference label:", error);
    }
  }

  function positionPopup() {
    if (popup.hidden || popup.classList.contains("smarttex-popup-resizing")) return;
    const screen = currentState?.screen;
    if (!screen) return;
    const margin = 9;
    const width = Math.max(1, Math.min(640, window.innerWidth - margin * 2));
    if (popup.dataset.smarttexUserSized !== "true") popup.style.width = `${width}px`;
    const cursorLeft = Number(screen.pageX) - window.scrollX;
    const cursorTop = Number(screen.pageY) - window.scrollY;
    const lineHeight = Math.max(14, Number(screen.lineHeight) || 18);
    const gap = lineHeight * 2;
    const belowSpace = window.innerHeight - margin - (cursorTop + lineHeight + gap);
    const aboveSpace = cursorTop - gap - margin;
    const availableSideSpace = Math.max(belowSpace, aboveSpace);
    const popupMaxHeight = Math.max(
      48,
      Math.min(430, window.innerHeight - margin * 2, availableSideSpace)
    );
    if (popup.dataset.smarttexUserSized !== "true") {
      popup.style.maxHeight = `${Math.round(popupMaxHeight)}px`;
    }
    const rect = popup.getBoundingClientRect();
    const cursorRect = {
      left: cursorLeft - 3,
      right: cursorLeft + 3,
      top: cursorTop - 2,
      bottom: cursorTop + lineHeight + 2
    };
    const currentRect = lastPopupPosition
      ? {
          left: lastPopupPosition.left,
          right: lastPopupPosition.left + rect.width,
          top: lastPopupPosition.top,
          bottom: lastPopupPosition.top + rect.height
        }
      : null;
    const blocksCursor = currentRect && !(
      currentRect.right < cursorRect.left ||
      currentRect.left > cursorRect.right ||
      currentRect.bottom < cursorRect.top ||
      currentRect.top > cursorRect.bottom
    );
    const outsideViewport = currentRect && (
      currentRect.left < margin ||
      currentRect.top < margin ||
      currentRect.right > window.innerWidth - margin ||
      currentRect.bottom > window.innerHeight - margin
    );

    // Keep an already-open list stationary while the cursor moves. Reposition
    // it only when it would cover the caret, outgrow the viewport, or after the
    // popup was newly opened.
    if (!lastPopupPosition || blocksCursor || outsideViewport) {
      const fitsBelow = cursorTop + lineHeight + gap + rect.height <= window.innerHeight - margin;
      const fitsAbove = cursorTop - gap - rect.height >= margin;
      const placeAbove = !fitsBelow && (fitsAbove || aboveSpace > belowSpace);
      const top = placeAbove
        ? cursorTop - gap - rect.height
        : cursorTop + lineHeight + gap;
      const left = Math.max(
        margin,
        Math.min(cursorLeft, window.innerWidth - rect.width - margin)
      );
      const boundedTop = Math.max(
        margin,
        Math.min(top, window.innerHeight - rect.height - margin)
      );
      lastPopupPosition = { left, top: boundedTop };
      popup.dataset.smarttexPlacement = placeAbove ? "above" : "below";
    }
    popup.style.left = `${Math.round(lastPopupPosition.left)}px`;
    popup.style.top = `${Math.round(lastPopupPosition.top)}px`;
    previewSelected();
  }

  function openForCurrentContext() {
    popupTimer = null;
    if (!popupInteractionReady() || !currentContext || contextId() === dismissedContextId) return;
    // The toolbar choice is intentionally session-local. Every newly opened
    // completion list starts from the persistent option-page preference.
    orderMode = configuredOrderMode;
    selectedIndex = 0;
    renderPopup();
    showPopup();
    bridgeRequest("getCoordinates", {
      index: currentContext.anchorIndex
    }, 1200).then((response) => {
      if (response.screen && currentState) {
        currentState = { ...currentState, screen: response.screen };
        positionPopup();
      }
    }).catch(() => {});
  }

  function updateFromState() {
    if (!popupInteractionReady()) {
      currentContext = null;
      hidePopup();
      return;
    }
    const keepTypingPopup = !popup.hidden && textInputIsRecent();
    const contextState = keepTypingPopup && currentState?.focused === false
      ? { ...currentState, focused: true }
      : currentState;
    const nextContext = findReferenceContext(contextState);
    if (!nextContext) {
      if (keepTypingPopup && currentContext) {
        // Editors can publish a short-lived, syntactically incomplete state
        // between beforeinput/input and their final document update. Preserve
        // the existing list instead of tearing it down and reopening it.
        setBridgeActive(true);
        clearTypingContextValidation();
        const remaining = Math.max(
          40,
          TYPING_CONTEXT_GRACE_MS - (Date.now() - lastTextInputAt)
        );
        typingContextValidationTimer = window.setTimeout(() => {
          typingContextValidationTimer = null;
          const settledContext = findReferenceContext(currentState);
          if (!settledContext) hidePopup();
          else updateFromState();
        }, remaining);
        positionPopup();
        return;
      }
      currentContext = null;
      dismissedContextId = "";
      hidePopup();
      return;
    }
    clearTypingContextValidation();
    const previousId = contextId();
    currentContext = nextContext;
    const nextId = contextId();
    if (nextId !== dismissedContextId) dismissedContextId = "";
    if (nextId === dismissedContextId) {
      clearPopupTimer();
      popup.hidden = true;
      list.replaceChildren();
      renderedRecords = [];
      popup.classList.remove("smarttex-reference-autocomplete-visible");
      setBridgeActive(false);
      dispatchPreviewHide({ force: true });
      return;
    }
    setBridgeActive(true);
    clearPopupTimer();
    if (!popup.hidden) {
      if (previousId !== nextId) selectedIndex = 0;
      renderPopup();
      positionPopup();
      return;
    }
    if (Date.now() <= immediateOpenUntil) {
      immediateOpenUntil = 0;
      openForCurrentContext();
      return;
    }
    popupTimer = window.setTimeout(openForCurrentContext, OPEN_DELAY_MS);
  }

  interactionTasks?.subscribe?.(() => {
    clearPopupTimer();
    previewGeneration += 1;
  });

  document.addEventListener("pointerdown", (event) => {
    scrollSuppressed = false;
    if (event.target?.closest?.(
      ".cm-content, .cm-line, .cm-scroller, .cm-editor, " +
      ".ace_content, .ace_text-layer, .ace_scroller, .ace_editor"
    )) {
      immediateOpenUntil = Date.now() + 500;
    }
  }, true);

  window.addEventListener(STATE_EVENT, (event) => {
    try {
      currentState = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      hidePopup();
      return;
    }
    if (scrollSuppressed) {
      hidePopup();
      return;
    }
    scheduleRecordIndexWarm(currentState?.value);
    updateFromState();
  });

  window.addEventListener(PREVIEW_STATE_EVENT, (event) => {
    try {
      currentState = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      currentContext = null;
      hidePopup();
      return;
    }
    if (currentState?.interactionPriority === "pointer") {
      scrollSuppressed = false;
      dismissedContextId = "";
    }
    if (scrollSuppressed) {
      hidePopup();
      return;
    }
    if (!findReferenceContext(currentState)) {
      currentContext = null;
      dismissedContextId = "";
      hidePopup();
      return;
    }
    immediateOpenUntil = Date.now() + 500;
    updateFromState();
  });

  orderLabel.addEventListener("mousedown", (event) => event.preventDefault());
  orderLabel.addEventListener("click", () => {
    if (popup.hidden) return;
    const selectedLabel = renderedRecords[selectedIndex]?.record?.label || "";
    orderMode = orderMode === "alphabetical" ? "document" : "alphabetical";
    renderPopup();
    if (selectedLabel) {
      const nextIndex = renderedRecords.findIndex(
        (entry) => entry.record.label === selectedLabel
      );
      if (nextIndex >= 0) {
        selectedIndex = nextIndex;
        updateSelectedItem();
      }
    }
    positionPopup();
  });

  viewButton.addEventListener("mousedown", (event) => event.preventDefault());
  viewButton.addEventListener("click", () => {
    if (popup.hidden || currentContext?.command !== "eqref") return;
    viewMode = viewMode === "grid" ? "list" : "grid";
    persistEquationViewMode();
    if (viewMode === "grid") dispatchPreviewHide({ force: true });
    renderPopup();
    positionPopup();
  });

  closeButton.addEventListener("mousedown", (event) => event.preventDefault());
  closeButton.addEventListener("click", () => {
    hidePopup({ dismiss: true });
    bridgeRequest("focus").catch(() => {});
  });

  document.addEventListener("keydown", (event) => {
    scrollSuppressed = false;
    if (popup.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      hidePopup({ dismiss: true });
      bridgeRequest("focus").catch(() => {});
      return;
    }
    if (!renderedRecords.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (renderedRecords.length === 1) {
        bridgeRequest("moveCursorVertical", { direction: 1 }).catch(() => {});
        return;
      }
      selectedIndex = (selectedIndex + 1) % renderedRecords.length;
      updateSelectedItem();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (renderedRecords.length === 1) {
        bridgeRequest("moveCursorVertical", { direction: -1 }).catch(() => {});
        return;
      }
      selectedIndex = (selectedIndex - 1 + renderedRecords.length) % renderedRecords.length;
      updateSelectedItem();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      insertRecord(renderedRecords[selectedIndex]?.record);
    }
  }, true);

  const noteTextInput = () => {
    lastTextInputAt = Date.now();
    scrollSuppressed = false;
  };
  document.addEventListener("input", noteTextInput, true);

  document.addEventListener("mousedown", (event) => {
    if (popup.hidden || popup.contains(event.target)) return;
    if (event.target?.closest?.(".smarttex-document-reference-popup")) return;
    hidePopup();
  }, true);

  window.addEventListener("resize", positionPopup, { passive: true });
  window.addEventListener("smarttex:editor-scroll-state", (event) => {
    if (event?.detail?.active === true) {
      scrollSuppressed = true;
      hidePopup();
      return;
    }
    scrollSuppressed = false;
    scheduleRecordIndexWarm(currentState?.value);
    hidePopup();
  });
  window.addEventListener("scroll", (event) => {
    if (event.target instanceof Node && popup.contains(event.target)) return;
    if (interactionTasks?.isScrolling?.()) return;
    positionPopup();
  }, true);

  window.addEventListener(RUNTIME_SETTINGS_EVENT, (event) => {
    const detail = event?.detail || {};
    runtimeSettingsOverrideActive = detail.usingPresets === false;
    configuredOrderMode = normalizeOrder(detail.autocomplete?.referenceOrder);
    if (popup.hidden) orderMode = configuredOrderMode;
  });

  extensionApi?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes?.[EQUATION_VIEW_MODE_KEY]) {
      const nextMode = normalizeViewMode(changes[EQUATION_VIEW_MODE_KEY].newValue);
      if (nextMode !== viewMode) {
        viewMode = nextMode;
        if (currentContext?.command === "eqref" && !popup.hidden) {
          if (viewMode === "grid") dispatchPreviewHide({ force: true });
          renderPopup();
          positionPopup();
        } else {
          updateViewButton();
        }
      }
    }
    if (!changes?.[SETTINGS_KEY] || runtimeSettingsOverrideActive) return;
    configuredOrderMode = normalizeOrder(changes[SETTINGS_KEY].newValue?.referenceOrder);
    // A setting change defines the initial state of the next list. It does not
    // overwrite a one-time choice while the current list is already open.
    if (popup.hidden) orderMode = configuredOrderMode;
  });

  loadSettings().then(updateFromState).catch(updateFromState);

  window.addEventListener("pagehide", () => {
    clearPopupTimer();
    clearTypingContextValidation();
    setBridgeActive(false);
    dispatchPreviewHide();
    pendingRequests.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("SmartTeX page closed."));
    });
    pendingRequests.clear();
  }, { once: true });
  };

  initializeWhenDependenciesAreReady().catch((error) => {
    globalThis.__smartTeXReferenceAutocompleteLoading = false;
    console.error(error?.message || "SmartTeX reference autocomplete could not load its LaTeX context parser.", error);
  });
})();
