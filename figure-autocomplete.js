/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (window.top !== window) return;
  const existing = document.getElementById("smarttex-figure-autocomplete-popup");
  if (globalThis.__smartTeXFigureAutocompleteLoaded && existing) return;
  if (globalThis.__smartTeXFigureAutocompleteLoaded && !existing) {
    globalThis.__smartTeXFigureAutocompleteLoaded = false;
  }
  if (globalThis.__smartTeXFigureAutocompleteLoading) return;
  globalThis.__smartTeXFigureAutocompleteLoading = true;

  const initializeWhenDependenciesAreReady = async () => {
    const startedAt = Date.now();
    while (!globalThis.SmartTeXLatexContext?.maskIgnoredLatex) {
      if (Date.now() - startedAt > 10000) {
        throw new Error("SmartTeX figure autocomplete could not load its LaTeX parser.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (globalThis.__smartTeXFigureAutocompleteLoaded) return;
    globalThis.__smartTeXFigureAutocompleteLoaded = true;
    globalThis.__smartTeXFigureAutocompleteLoading = false;

    const STATE_EVENT = "smarttex:editor-state";
    const PREVIEW_STATE_EVENT = "smarttex:preview-editor-state";
    const REQUEST_EVENT = "smarttex:citation-editor-request";
    const RESPONSE_EVENT = "smarttex:citation-editor-response";
    const SELECTION_EVENT = "smarttex:graphic-autocomplete-selection-change";
    const ACTIVE_EVENT = "smarttex:graphic-autocomplete-active";
    const VIEW_MODE_KEY = "smarttex:figure-list-view:v1";
    const MAX_RESULTS = 300;
    const FIGURE_PATTERN = /\.(?:png|jpe?g|gif|svg|pdf|eps|webp)$/i;
    const extensionApi = globalThis.browser ?? globalThis.chrome;
    const contextTools = globalThis.SmartTeXLatexContext;
    const interactionTasks = globalThis.SmartTeXInteractionTasks;
    const popupInteractionReady = () => globalThis.SmartTeXPopupGate?.isReady?.() !== false;

    let currentState = null;
    let currentContext = null;
    let figures = [];
    let figuresLoaded = false;
    let fullLoadStarted = false;
    let fullLoadRequested = false;
    let quickLoadPromise = null;
    let quickLoadedAt = 0;
    let selectedIndex = 0;
    let renderedRecords = [];
    let onlyUnused = false;
    let viewMode = "grid";
    let browseDirectory = "";
    let lastPopupPosition = null;
    let autocompleteContextActive = false;
    let requestCounter = 0;
    let loadingGeneration = 0;
    let scrollSuppressed = false;
    let lastTextInputAt = 0;
    let listRenderRetryFrame = null;
    let popupRefitFrame = null;
    let thumbnailObserver = null;
    let thumbnailRenderGeneration = 0;
    const thumbnailFilePromises = new Map();
    const currentPathResolution = new Map();
    const pendingRequests = new Map();

    function normalizeViewMode(value) {
      return value === "list" ? "list" : "grid";
    }

    async function loadViewMode() {
      try {
        const stored = await extensionApi?.storage?.local?.get?.(VIEW_MODE_KEY);
        viewMode = normalizeViewMode(stored?.[VIEW_MODE_KEY]);
      } catch (_error) {
        viewMode = "grid";
      }
      if (currentContext && !popup.hidden) {
        renderPopup();
        positionPopup();
      } else {
        updateViewButton();
      }
    }

    function persistViewMode() {
      Promise.resolve(extensionApi?.storage?.local?.set?.({
        [VIEW_MODE_KEY]: viewMode
      })).catch(() => {});
    }

    const popup = document.createElement("aside");
    popup.id = "smarttex-figure-autocomplete-popup";
    popup.hidden = true;
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "SmartTeX figure suggestions");
    popup.innerHTML = `
      <header class="smarttex-figure-autocomplete-header">
        <span class="smarttex-figure-autocomplete-query">Figures</span>
        <button type="button" class="smarttex-figure-autocomplete-unused" aria-pressed="false">Only show figures not yet included</button>
        <button type="button" class="smarttex-figure-autocomplete-view" aria-pressed="false" aria-label="Switch to thumbnail grid view" title="Switch to thumbnail grid view">
          <svg class="smarttex-figure-autocomplete-view-grid-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <rect x="7" y="7" width="3" height="3" rx="0.45"></rect>
            <rect x="14" y="7" width="3" height="3" rx="0.45"></rect>
            <rect x="7" y="14" width="3" height="3" rx="0.45"></rect>
            <rect x="14" y="14" width="3" height="3" rx="0.45"></rect>
          </svg>
          <svg class="smarttex-figure-autocomplete-view-list-icon" viewBox="0 0 24 24" aria-hidden="true" hidden>
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="7" y1="8" x2="17" y2="8"></line>
            <line x1="7" y1="12" x2="17" y2="12"></line>
            <line x1="7" y1="16" x2="17" y2="16"></line>
          </svg>
        </button>
        <span class="smarttex-popup-escape-hint" aria-hidden="true">[Esc]</span>
        <button type="button" class="smarttex-figure-autocomplete-close" title="Close (Esc)" aria-label="Close figure suggestions">&times;</button>
      </header>
      <div class="smarttex-figure-autocomplete-list" role="listbox" aria-label="Figure suggestions"></div>`;
    document.documentElement.appendChild(popup);

    const queryLabel = popup.querySelector(".smarttex-figure-autocomplete-query");
    const unusedButton = popup.querySelector(".smarttex-figure-autocomplete-unused");
    const viewButton = popup.querySelector(".smarttex-figure-autocomplete-view");
    const gridViewIcon = viewButton.querySelector(".smarttex-figure-autocomplete-view-grid-icon");
    const listViewIcon = viewButton.querySelector(".smarttex-figure-autocomplete-view-list-icon");
    const list = popup.querySelector(".smarttex-figure-autocomplete-list");
    const closeButton = popup.querySelector(".smarttex-figure-autocomplete-close");
    globalThis.SmartTeXPopupUI?.enhance?.(popup, {
      type: "list",
      closeButton,
      onClose: hidePopup
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

    function bridgeRequest(type, payload = {}, timeoutMs = 5000) {
      const requestId = `figure-${Date.now()}-${++requestCounter}`;
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
      bridgeRequest("setFigureAutocompleteActive", {
        active: Boolean(active)
      }, 1200).catch(() => {});
    }

    function setAutocompleteContextActive(active) {
      const nextActive = Boolean(active);
      // Suppress CollabTeX's native filename completer immediately in this
      // isolated-world script. The MAIN-world bridge also detaches Ace's
      // completer, but that request is asynchronous and used to leave a small
      // window in which the native list could flash or remain visible.
      document.body?.classList.toggle(
        "smarttex-figure-autocomplete-context-active",
        nextActive
      );
      if (autocompleteContextActive === nextActive) return;
      autocompleteContextActive = nextActive;
      window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, {
        detail: { active: nextActive }
      }));
      setBridgeActive(nextActive);
    }

    function normalizePath(value) {
      return String(value || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/{2,}/g, "/")
        .toLocaleLowerCase();
    }

    function cleanProjectPath(value) {
      return String(value || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+|\/+$/g, "");
    }

    function directoryForFragment(value) {
      const path = String(value || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+/, "");
      if (path.endsWith("/")) return cleanProjectPath(path);
      const separator = path.lastIndexOf("/");
      return separator < 0 ? "" : cleanProjectPath(path.slice(0, separator));
    }

    function parentDirectory(value) {
      const path = cleanProjectPath(value);
      const separator = path.lastIndexOf("/");
      return separator < 0 ? "" : path.slice(0, separator);
    }

    function appendHighlightedPath(container, value, queryValue) {
      const text = String(value || "");
      const query = normalizePath(queryValue);
      if (!query) {
        container.textContent = text;
        return;
      }
      const searchable = text.replace(/\\/g, "/").toLocaleLowerCase();
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

    function pathStem(value) {
      return normalizePath(value).replace(/\.(?:png|jpe?g|gif|svg|pdf|eps|webp)$/i, "");
    }

    function includedFigureKeys(sourceValue, ignoredCommandStart = -1) {
      const source = String(sourceValue || "");
      const masked = contextTools.maskIgnoredLatex(source);
      const keys = new Set();
      const pattern = /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/gi;
      let match;
      while ((match = pattern.exec(masked))) {
        // The command currently being edited is not an independently used
        // figure. Keeping it in this set made its own exact match disappear
        // whenever "only unused" was active.
        if (match.index === ignoredCommandStart) continue;
        const path = normalizePath(match[1]);
        if (!path) continue;
        keys.add(path);
        keys.add(pathStem(path));
      }
      return keys;
    }

    function isIncluded(path, keys) {
      const normalized = normalizePath(path);
      const stem = pathStem(normalized);
      return keys.has(normalized) || keys.has(stem);
    }

    function matchingArgumentClose(source, openIndex) {
      let depth = 0;
      for (let index = Math.max(0, Number(openIndex) || 0); index < source.length; index += 1) {
        const character = source[index];
        if (character === "\\") {
          index += 1;
          continue;
        }
        if (character === "{") depth += 1;
        else if (character === "}" && --depth === 0) return index;
      }
      return -1;
    }

    function findFigureContext(state) {
      if (
        !state?.value || !Number.isInteger(state.cursorIndex) || state.focused === false ||
        !/\.(?:tex|ltx)$/i.test(String(state.fileName || "main.tex"))
      ) return null;
      const cursor = Math.max(0, Math.min(state.cursorIndex, state.value.length));
      const lineStart = state.value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
      const scanStart = Math.max(lineStart, cursor - 4096);
      const beforeCursor = contextTools.maskIgnoredLatex(state.value.slice(scanStart, cursor));
      const match = beforeCursor.match(/\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^{}]*)$/i);
      if (!match) return null;
      const beforeFragment = String(match[1] || "");
      const commandStart = cursor - match[0].length;
      const openIndex = commandStart + match[0].lastIndexOf("{");
      const closeIndex = matchingArgumentClose(state.value, openIndex);

      // The exact-match highlight must describe the complete includegraphics
      // argument, not only the text on the caret's left side.  In particular,
      // moving the caret through an already complete filename must not make the
      // matching list entry lose its light-blue "current file" highlight.
      const argumentEnd = closeIndex >= 0 ? closeIndex : cursor;
      const fullArgument = state.value.slice(openIndex + 1, argumentEnd).trim();
      return {
        commandStart,
        openIndex,
        fragment: closeIndex >= 0 ? fullArgument : beforeFragment.trim(),
        currentPath: fullArgument
      };
    }

    function contextId(context = currentContext) {
      if (!context) return "";
      return [currentState?.fileName || "", context.commandStart, context.openIndex].join(":");
    }

    function isExactCurrentPath(path) {
      const currentPath = String(currentContext?.currentPath || "").trim();
      return Boolean(currentPath) && String(path || "").trim() === currentPath;
    }

    function matchRank(path, fragment) {
      const query = normalizePath(fragment);
      if (!query) return 0;
      const candidate = normalizePath(path);
      if (candidate === query) return 0;
      if (candidate.startsWith(query)) return 1;
      const contained = candidate.indexOf(query);
      if (contained >= 0) return 2 + contained / 1000;
      return Number.POSITIVE_INFINITY;
    }

    function matchingRecords() {
      const calculate = () => {
        const keys = includedFigureKeys(
          currentState?.value || "",
          Number(currentContext?.commandStart)
        );
        const directoryKey = normalizePath(browseDirectory).replace(/\/$/, "");
        const directoryPrefix = directoryKey ? `${directoryKey}/` : "";
        const globalSearch = Boolean(String(currentContext?.fragment || "").trim());
        const directories = new Map();
        const files = [];
        for (let index = 0; index < figures.length; index += 1) {
          interactionTasks?.checkpoint?.(index, 32);
          const path = figures[index];
          const record = { path, included: isIncluded(path, keys) };
          if (onlyUnused && record.included) continue;
          if (!Number.isFinite(matchRank(path, currentContext?.fragment || ""))) continue;
          if (globalSearch) {
            files.push({
              ...record,
              kind: "file",
              name: cleanProjectPath(path).split("/").pop() || cleanProjectPath(path)
            });
            continue;
          }
          const normalized = normalizePath(path);
          if (!normalized.startsWith(directoryPrefix)) continue;
          const relativePath = cleanProjectPath(path).slice(directoryPrefix.length);
          if (!relativePath) continue;
          const separator = relativePath.indexOf("/");
          if (separator >= 0) {
            const name = relativePath.slice(0, separator);
            const fullPath = cleanProjectPath(path).slice(
              0,
              directoryPrefix.length + name.length
            );
            directories.set(normalizePath(fullPath), {
              kind: "directory",
              name,
              path: fullPath,
              included: false
            });
            continue;
          }
          files.push({ ...record, kind: "file", name: relativePath });
        }
        let comparisons = 0;
        const comparePaths = (left, right) => {
          interactionTasks?.checkpoint?.(comparisons++, 32);
          return left.path.localeCompare(right.path, undefined, {
            sensitivity: "base", numeric: true
          });
        };
        const directoryRecords = [...directories.values()].sort(comparePaths);
        files.sort(comparePaths);
        const parentRecord = directoryKey && !globalSearch ? [{
          kind: "parent",
          name: "..",
          path: parentDirectory(browseDirectory),
          included: false
        }] : [];
        return [...parentRecord, ...directoryRecords, ...files].slice(0, MAX_RESULTS);
      };
      try {
        return interactionTasks?.runSync
          ? interactionTasks.runSync("figure-list-filter", calculate)
          : calculate();
      } catch (error) {
        if (interactionTasks?.isAbortError?.(error)) return null;
        throw error;
      }
    }

    function finishCurrentFigureResolution(expectedContextId) {
      if (currentContext && contextId() === expectedContextId && !popup.hidden) {
        renderPopup();
        positionPopup();
      }
    }

    function resolveCurrentFigureCandidate(path, normalized, expectedContextId, attempt = 0) {
      bridgeRequest("resolveProjectFile", { path }, 5000).then((response) => {
        const resolvedPath = String(response?.file?.path || path).trim();
        if (!response?.file || !resolvedPath || !FIGURE_PATTERN.test(resolvedPath)) {
          throw new Error("Figure file is not available yet.");
        }
        // The resolver may return only a basename for a file found through
        // the tree. The queried project-relative path was verified by this
        // response as well, so retain it as the exact autocomplete entry.
        mergeFigures([
          path,
          ...(resolvedPath.includes("/") || !path.includes("/") ? [resolvedPath] : [])
        ]);
        currentPathResolution.set(normalized, "found");
        finishCurrentFigureResolution(expectedContextId);
      }).catch(() => {
        if (attempt < 2) {
          window.setTimeout(() => {
            resolveCurrentFigureCandidate(
              path,
              normalized,
              expectedContextId,
              attempt + 1
            );
          }, 160 * (attempt + 1));
          return;
        }
        currentPathResolution.set(normalized, "missing");
        finishCurrentFigureResolution(expectedContextId);
      });
    }

    function ensureCurrentFigureCandidate() {
      const path = String(currentContext?.currentPath || "").trim();
      if (!path || !FIGURE_PATTERN.test(path)) return false;
      const normalized = normalizePath(path);
      if (figures.some((candidate) => normalizePath(candidate) === normalized)) return false;
      const state = currentPathResolution.get(normalized);
      if (state === "pending") return true;
      if (state === "missing") return false;
      const expectedContextId = contextId();
      currentPathResolution.set(normalized, "pending");
      resolveCurrentFigureCandidate(path, normalized, expectedContextId);
      return true;
    }

    function selectedItemElement() {
      return list.querySelectorAll(".smarttex-figure-autocomplete-item")[selectedIndex] || null;
    }

    function notifyPreviewSelection() {
      const selectedRecord = renderedRecords[selectedIndex];
      window.dispatchEvent(new CustomEvent(SELECTION_EVENT, {
        detail: {
          // Grid cells already contain their own thumbnail. Supplying an empty
          // selection closes/suppresses the separate floating file preview.
          path: viewMode === "grid"
            ? ""
            : (selectedRecord?.kind === "file" ? selectedRecord.path : ""),
          suppressPreview: viewMode === "grid" || selectedRecord?.kind !== "file"
        }
      }));
    }

    function openThumbnailPreview(record, item) {
      if (
        record?.kind !== "file" || !record.path || !item ||
        popup.hidden || viewMode !== "grid"
      ) return;
      window.dispatchEvent(new CustomEvent(SELECTION_EVENT, {
        detail: {
          path: record.path,
          suppressPreview: false,
          mode: "click"
        }
      }));
    }

    function updateSelectedItem() {
      const items = [...list.querySelectorAll(".smarttex-figure-autocomplete-item")];
      items.forEach((item, index) => {
        const selected = index === selectedIndex;
        item.classList.toggle("smarttex-figure-autocomplete-selected", selected);
        item.setAttribute("aria-selected", selected ? "true" : "false");
      });
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
      notifyPreviewSelection();
    }

    function updateViewButton() {
      const gridActive = viewMode === "grid";
      list.classList.toggle("smarttex-figure-autocomplete-grid", gridActive);
      viewButton.setAttribute("aria-pressed", gridActive ? "true" : "false");
      viewButton.setAttribute(
        "aria-label",
        gridActive ? "Switch to list view" : "Switch to thumbnail grid view"
      );
      viewButton.title = viewButton.getAttribute("aria-label");
      gridViewIcon.toggleAttribute("hidden", gridActive);
      listViewIcon.toggleAttribute("hidden", !gridActive);
    }

    function stopThumbnailLoading() {
      thumbnailRenderGeneration += 1;
      thumbnailObserver?.disconnect?.();
      thumbnailObserver = null;
    }

    function resolveThumbnailFile(path) {
      const key = normalizePath(path);
      if (!thumbnailFilePromises.has(key)) {
        thumbnailFilePromises.set(key, bridgeRequest(
          "resolveProjectFile",
          { path },
          5000
        ).then((response) => {
          if (!response.file?.url) throw new Error("Figure URL is unavailable.");
          return response.file;
        }).catch((error) => {
          thumbnailFilePromises.delete(key);
          throw error;
        }));
      }
      return thumbnailFilePromises.get(key);
    }

    async function renderThumbnail(stage, path, generation, attempt = 0) {
      if (
        generation !== thumbnailRenderGeneration ||
        viewMode !== "grid" ||
        !stage.isConnected
      ) return;
      stage.setAttribute("aria-busy", "true");
      try {
        const file = await resolveThumbnailFile(path);
        const renderer = globalThis.SmartTeXFigureRenderer;
        if (!renderer?.createMedia) throw new Error("The figure renderer is unavailable.");
        const media = await renderer.createMedia(file.path || path, file.url, {
          imageClass: "smarttex-figure-autocomplete-thumbnail-image",
          pdfClass: "smarttex-figure-autocomplete-thumbnail-image"
        });
        if (!media) throw new Error("Figure thumbnail could not be created.");
        try {
          await media.decode?.();
        } catch (_error) {
          // Cached and SVG images can reject decode() despite being displayable.
        }
        if (
          generation !== thumbnailRenderGeneration ||
          viewMode !== "grid" ||
          !stage.isConnected ||
          stage.dataset.smarttexFigurePath !== path
        ) return;
        stage.replaceChildren(media);
        stage.removeAttribute("aria-busy");
      } catch (_error) {
        if (
          generation !== thumbnailRenderGeneration ||
          viewMode !== "grid" ||
          !stage.isConnected
        ) return;
        if (attempt < 2) {
          window.setTimeout(() => renderThumbnail(stage, path, generation, attempt + 1), 140 * (attempt + 1));
          return;
        }
        const unavailable = document.createElement("span");
        unavailable.className = "smarttex-figure-autocomplete-thumbnail-unavailable";
        unavailable.textContent = "No preview";
        stage.replaceChildren(unavailable);
        stage.removeAttribute("aria-busy");
      }
    }

    function observeThumbnail(stage, path, generation) {
      if (typeof IntersectionObserver !== "function") {
        renderThumbnail(stage, path, generation);
        return;
      }
      if (!thumbnailObserver) {
        thumbnailObserver = new IntersectionObserver((entries, observer) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            renderThumbnail(
              entry.target,
              entry.target.dataset.smarttexFigurePath || "",
              Number(entry.target.dataset.smarttexThumbnailGeneration)
            );
          }
        }, { root: list, rootMargin: "80px" });
      }
      stage.dataset.smarttexFigurePath = path;
      stage.dataset.smarttexThumbnailGeneration = String(generation);
      thumbnailObserver.observe(stage);
    }

    function renderPopup() {
      if (!currentContext) return;
      stopThumbnailLoading();
      updateViewButton();
      const thumbnailGeneration = thumbnailRenderGeneration;
      const directoryLabel = browseDirectory || "project root";
      queryLabel.textContent = currentContext.fragment
        ? `Figures matching “${currentContext.fragment}”`
        : `Figures in ${directoryLabel}`;
      unusedButton.classList.toggle("smarttex-figure-autocomplete-unused-active", onlyUnused);
      unusedButton.setAttribute("aria-pressed", onlyUnused ? "true" : "false");
      unusedButton.title = onlyUnused
        ? "Showing only figure files that are not yet included"
        : "Hide figure files that are already included";
      const resolvingCurrentPath = ensureCurrentFigureCandidate();
      const nextRecords = matchingRecords();
      if (!nextRecords) {
        // Never leave rows from the previous query visible after a cancelled
        // filter pass. Clear their preview immediately, show a short updating
        // state, and retry against the newest editor context next frame.
        const loading = document.createElement("p");
        loading.className = "smarttex-figure-autocomplete-empty smarttex-list-loading";
        const spinner = document.createElement("span");
        spinner.className = "smarttex-inline-loading-spinner";
        spinner.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = "Updating figure matches…";
        loading.append(spinner, text);
        renderedRecords = [];
        list.replaceChildren(loading);
        popup.setAttribute("aria-busy", "true");
        notifyPreviewSelection();
        schedulePopupRefit();
        if (listRenderRetryFrame !== null) window.cancelAnimationFrame(listRenderRetryFrame);
        listRenderRetryFrame = window.requestAnimationFrame(() => {
          listRenderRetryFrame = null;
          if (currentContext && !popup.hidden) renderPopup();
        });
        return;
      }
      const exactIndex = nextRecords.findIndex((record) => (
        record.kind === "file" && isExactCurrentPath(record.path)
      ));
      if (exactIndex >= 0) selectedIndex = exactIndex;
      if (selectedIndex >= nextRecords.length) selectedIndex = 0;
      const fragment = document.createDocumentFragment();

      if (!nextRecords.length) {
        const empty = document.createElement("p");
        empty.className = "smarttex-figure-autocomplete-empty";
        if (!figuresLoaded || resolvingCurrentPath) {
          empty.classList.add("smarttex-list-loading");
          const spinner = document.createElement("span");
          spinner.className = "smarttex-inline-loading-spinner";
          spinner.setAttribute("aria-hidden", "true");
          const text = document.createElement("span");
          text.textContent = resolvingCurrentPath
            ? "Checking figure file…"
            : "Gathering figure files…";
          empty.append(spinner, text);
          popup.setAttribute("aria-busy", "true");
        } else {
          empty.textContent = onlyUnused
            ? "No matching figure that has not yet been included was found."
            : "No matching figure file was found.";
          popup.removeAttribute("aria-busy");
        }
        fragment.appendChild(empty);
        renderedRecords = nextRecords;
        list.replaceChildren(fragment);
        notifyPreviewSelection();
        schedulePopupRefit();
        return;
      }

      popup.removeAttribute("aria-busy");
      nextRecords.forEach((record, index) => {
        interactionTasks?.checkpoint?.(index, 8);
        const item = document.createElement("button");
        item.type = "button";
        item.className = "smarttex-figure-autocomplete-item";
        item.classList.add(`smarttex-figure-autocomplete-${record.kind}`);
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
        item.classList.toggle("smarttex-figure-autocomplete-selected", index === selectedIndex);
        item.classList.toggle(
          "smarttex-figure-autocomplete-exact",
          record.kind === "file" && isExactCurrentPath(record.path)
        );
        item.classList.toggle(
          "smarttex-figure-autocomplete-included",
          record.kind === "file" && record.included
        );
        item.dataset.smarttexFigurePath = record.path;
        item.dataset.smarttexFigureKind = record.kind;

        const thumbnail = document.createElement("span");
        thumbnail.className = "smarttex-figure-autocomplete-thumbnail";
        thumbnail.setAttribute("aria-hidden", "true");
        if (record.kind === "file") {
          const thumbnailSpinner = document.createElement("span");
          thumbnailSpinner.className = "smarttex-inline-loading-spinner";
          thumbnail.appendChild(thumbnailSpinner);
        } else {
          thumbnail.classList.add("smarttex-figure-autocomplete-folder-thumbnail");
          thumbnail.textContent = record.kind === "parent" ? ".." : "▰";
        }

        const check = document.createElement("span");
        check.className = "smarttex-figure-autocomplete-check";
        check.textContent = record.kind === "file"
          ? (record.included ? "✓" : "")
          : (record.kind === "parent" ? "↰" : "▸");
        check.setAttribute("aria-hidden", "true");
        const path = document.createElement("code");
        path.className = "smarttex-figure-autocomplete-path";
        const visiblePath = record.kind === "file"
          ? record.path
          : (record.kind === "parent" ? ".." : `${record.path}/`);
        appendHighlightedPath(path, visiblePath, currentContext.fragment);
        path.title = record.kind === "parent"
          ? (browseDirectory ? `Back from ${browseDirectory}` : "Project root")
          : record.path;
        const status = document.createElement("span");
        status.className = "smarttex-figure-autocomplete-status";
        status.textContent = record.kind === "file"
          ? (record.included ? "Already included" : "")
          : (record.kind === "parent"
              ? (record.path ? `Back to ${record.path}` : "Back to project root")
              : "Directory");
        item.append(thumbnail, check, path, status);
        item.addEventListener("mouseenter", () => {
          if (selectedIndex !== index) {
            selectedIndex = index;
            updateSelectedItem();
          } else {
            notifyPreviewSelection();
          }
        });
        item.addEventListener("mousedown", (event) => event.preventDefault());
        item.addEventListener("click", () => activateRecord(record));
        if (viewMode === "grid") {
          const gridCell = document.createElement("div");
          gridCell.className = "smarttex-figure-autocomplete-grid-cell";
          gridCell.appendChild(item);
          if (record.kind === "file") {
            const previewButton = document.createElement("button");
            previewButton.type = "button";
            previewButton.className = "smarttex-figure-autocomplete-thumbnail-open";
            previewButton.textContent = "+";
            previewButton.setAttribute("aria-label", "Open zoomable figure preview");
            previewButton.title = "Open zoomable figure preview";
            previewButton.addEventListener("mousedown", (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            previewButton.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              selectedIndex = index;
              updateSelectedItem();
              openThumbnailPreview(record, item);
            });
            gridCell.appendChild(previewButton);
          }
          fragment.appendChild(gridCell);
        } else {
          fragment.appendChild(item);
        }
        if (viewMode === "grid" && record.kind === "file") {
          observeThumbnail(thumbnail, record.path, thumbnailGeneration);
        }
      });
      renderedRecords = nextRecords;
      list.replaceChildren(fragment);
      notifyPreviewSelection();
      schedulePopupRefit();
    }

    function positionPopup() {
      if (
        popup.hidden ||
        popup.classList.contains("smarttex-popup-resizing") ||
        !currentState?.screen
      ) return;
      const margin = 9;
      const width = Math.max(1, Math.min(560, window.innerWidth - margin * 2));
      if (popup.dataset.smarttexUserSized !== "true") popup.style.width = `${width}px`;
      const cursorLeft = Number(currentState.screen.pageX) - window.scrollX;
      const cursorTop = Number(currentState.screen.pageY) - window.scrollY;
      const lineHeight = Math.max(14, Number(currentState.screen.lineHeight) || 18);
      const gap = lineHeight * 2;
      const belowSpace = window.innerHeight - margin - (cursorTop + lineHeight + gap);
      const aboveSpace = cursorTop - gap - margin;
      const availableSideSpace = Math.max(belowSpace, aboveSpace);
      if (popup.dataset.smarttexUserSized !== "true") {
        popup.style.maxHeight = `${Math.round(Math.max(
          48,
          Math.min(470, window.innerHeight - margin * 2, availableSideSpace)
        ))}px`;
      }
      const rect = popup.getBoundingClientRect();
      const cursorRect = {
        left: cursorLeft - 3,
        right: cursorLeft + 3,
        top: cursorTop - 2,
        bottom: cursorTop + lineHeight + 2
      };
      const currentRect = lastPopupPosition ? {
        left: lastPopupPosition.left,
        right: lastPopupPosition.left + rect.width,
        top: lastPopupPosition.top,
        bottom: lastPopupPosition.top + rect.height
      } : null;
      const blocksCursor = currentRect && !(
        currentRect.right < cursorRect.left || currentRect.left > cursorRect.right ||
        currentRect.bottom < cursorRect.top || currentRect.top > cursorRect.bottom
      );
      const outsideViewport = currentRect && (
        currentRect.left < margin ||
        currentRect.top < margin ||
        currentRect.right > window.innerWidth - margin ||
        currentRect.bottom > window.innerHeight - margin
      );
      if (!lastPopupPosition || blocksCursor || outsideViewport) {
        const fitsBelow = cursorTop + lineHeight + gap + rect.height <= window.innerHeight - margin;
        const fitsAbove = cursorTop - gap - rect.height >= margin;
        const placeAbove = !fitsBelow && (fitsAbove || aboveSpace > belowSpace);
        const top = placeAbove
          ? cursorTop - gap - rect.height
          : cursorTop + lineHeight + gap;
        lastPopupPosition = {
          left: Math.max(margin, Math.min(cursorLeft, window.innerWidth - rect.width - margin)),
          top: Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin))
        };
        popup.dataset.smarttexPlacement = placeAbove ? "above" : "below";
      }
      popup.style.left = `${Math.round(lastPopupPosition.left)}px`;
      popup.style.top = `${Math.round(lastPopupPosition.top)}px`;
      // A grid-position-only update must not close a zoom preview opened with
      // the tile's + button. Grid rendering/toggling already suppresses the
      // automatic hover preview explicitly.
      if (viewMode !== "grid") notifyPreviewSelection();
    }

    function showPopup() {
      if (!popupInteractionReady() || !currentContext) return;
      popup.hidden = false;
      popup.classList.add("smarttex-figure-autocomplete-visible");
      positionPopup();
    }

    function hidePopup() {
      if (listRenderRetryFrame !== null) window.cancelAnimationFrame(listRenderRetryFrame);
      listRenderRetryFrame = null;
      stopThumbnailLoading();
      popup.hidden = true;
      list.replaceChildren();
      renderedRecords = [];
      popup.removeAttribute("aria-busy");
      popup.classList.remove("smarttex-figure-autocomplete-visible");
      lastPopupPosition = null;
      // Do not release native-autocomplete suppression here. Temporary popup
      // hiding (scrolling, Escape, or a click elsewhere) must not allow
      // CollabTeX's filename list to take over while the caret is still in the
      // includegraphics argument. updateFromState() owns that lifecycle.
      notifyPreviewSelection();
    }

    function navigateToDirectory(record) {
      if (!record || !["directory", "parent"].includes(record.kind)) return;
      browseDirectory = cleanProjectPath(record.path);
      selectedIndex = 0;
      renderPopup();
      list.scrollTop = 0;
      positionPopup();
    }

    function activateRecord(record) {
      if (!record) return;
      if (record.kind === "file") {
        insertRecord(record);
        return;
      }
      navigateToDirectory(record);
    }

    async function insertRecord(record) {
      if (record?.kind !== "file" || !currentContext) return;
      hidePopup();
      try {
        await bridgeRequest("replaceFigureToken", { text: record.path });
      } catch (error) {
        renderPopup();
        showPopup();
        console.warn("SmartTeX could not insert the figure path:", error);
      }
    }

    function mergeFigures(values) {
      const merged = new Map(figures.map((path) => [normalizePath(path), path]));
      for (const value of Array.isArray(values) ? values : []) {
        const path = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
        if (!path || !FIGURE_PATTERN.test(path)) continue;
        merged.set(normalizePath(path), path);
      }
      removeBasenameAliases(merged);
      figures = [...merged.values()].sort((left, right) => left.localeCompare(right, undefined, {
        sensitivity: "base", numeric: true
      }));
    }

    function removeBasenameAliases(records) {
      const nestedBasenames = new Set([...records.values()]
        .filter((path) => cleanProjectPath(path).includes("/"))
        .map((path) => normalizePath(path).split("/").pop()));
      for (const [key, path] of records) {
        const cleaned = cleanProjectPath(path);
        if (!cleaned.includes("/") && nestedBasenames.has(normalizePath(cleaned))) {
          records.delete(key);
        }
      }
    }

    function replaceFigures(values) {
      const replaced = new Map();
      for (const value of Array.isArray(values) ? values : []) {
        const path = cleanProjectPath(value);
        if (!path || !FIGURE_PATTERN.test(path)) continue;
        replaced.set(normalizePath(path), path);
      }
      removeBasenameAliases(replaced);
      figures = [...replaced.values()].sort((left, right) => left.localeCompare(right, undefined, {
        sensitivity: "base", numeric: true
      }));
    }

    function startFullFigureLoad() {
      if (fullLoadStarted || !fullLoadRequested) return;
      fullLoadStarted = true;
      bridgeRequest("listProjectFigures", { full: true }, 20000).then((response) => {
        if (response.complete === true) replaceFigures(response.figures);
        else mergeFigures(response.figures);
        figuresLoaded = true;
        if (currentContext && !popup.hidden) renderPopup();
      }).catch(() => {
        figuresLoaded = true;
        if (currentContext && !popup.hidden) renderPopup();
      });
    }

    function ensureFigures({ requestFull = false, force = false } = {}) {
      if (requestFull) fullLoadRequested = true;
      const quickIsFresh = Date.now() - quickLoadedAt < 10000;
      if (!force && quickIsFresh && (figuresLoaded || figures.length)) {
        startFullFigureLoad();
        return;
      }
      if (quickLoadPromise) return;
      const generation = ++loadingGeneration;
      quickLoadPromise = bridgeRequest("listProjectFigures", { full: false }, 2500)
        .then((response) => {
          if (generation !== loadingGeneration) return;
          mergeFigures(response.figures);
          quickLoadedAt = Date.now();
          if (currentContext && !popup.hidden) renderPopup();
        })
        .catch(() => {})
        .finally(() => {
          quickLoadPromise = null;
          startFullFigureLoad();
        });
    }

    function updateFromState() {
      if (!popupInteractionReady()) {
        currentContext = null;
        setAutocompleteContextActive(false);
        hidePopup();
        return;
      }
      const nextContext = findFigureContext(currentState);
      setAutocompleteContextActive(Boolean(nextContext));
      if (!nextContext) {
        currentContext = null;
        hidePopup();
        return;
      }
      const previousId = contextId();
      const previousFragment = currentContext?.fragment || "";
      currentContext = nextContext;
      const nextId = contextId();
      if (previousId !== nextId || previousFragment !== nextContext.fragment) {
        browseDirectory = directoryForFragment(nextContext.fragment);
        selectedIndex = 0;
      }
      renderPopup();
      showPopup();
      ensureFigures({ requestFull: true });
      bridgeRequest("getCoordinates", { index: currentContext.openIndex }, 1200).then((response) => {
        if (response.screen && currentState) {
          currentState = { ...currentState, screen: response.screen };
          positionPopup();
        }
      }).catch(() => {});
    }

    window.addEventListener(STATE_EVENT, (event) => {
      try {
        currentState = interactionTasks?.parseEditorState
          ? interactionTasks.parseEditorState(event.detail)
          : JSON.parse(String(event.detail || "null"));
      } catch (_error) {
        currentContext = null;
        setAutocompleteContextActive(false);
        hidePopup();
        return;
      }
      if (scrollSuppressed) {
        hidePopup();
        return;
      }
      updateFromState();
    });

    window.addEventListener(PREVIEW_STATE_EVENT, (event) => {
      try {
        currentState = interactionTasks?.parseEditorState
          ? interactionTasks.parseEditorState(event.detail)
          : JSON.parse(String(event.detail || "null"));
      } catch (_error) {
        currentContext = null;
        setAutocompleteContextActive(false);
        hidePopup();
        return;
      }
      if (scrollSuppressed || !findFigureContext(currentState)) {
        currentContext = null;
        setAutocompleteContextActive(false);
        hidePopup();
        return;
      }
      updateFromState();
    });

    interactionTasks?.subscribe?.(() => {
      loadingGeneration += 1;
    });

    unusedButton.addEventListener("mousedown", (event) => event.preventDefault());
    unusedButton.addEventListener("click", () => {
      if (popup.hidden) return;
      const selectedRecord = renderedRecords[selectedIndex];
      onlyUnused = !onlyUnused;
      renderPopup();
      if (selectedRecord) {
        const nextIndex = renderedRecords.findIndex((record) => (
          record.kind === selectedRecord.kind && record.path === selectedRecord.path
        ));
        if (nextIndex >= 0) selectedIndex = nextIndex;
      }
      updateSelectedItem();
      positionPopup();
    });

    viewButton.addEventListener("mousedown", (event) => event.preventDefault());
    viewButton.addEventListener("click", () => {
      if (popup.hidden) return;
      const selectedRecord = renderedRecords[selectedIndex];
      viewMode = viewMode === "grid" ? "list" : "grid";
      persistViewMode();
      renderPopup();
      if (selectedRecord) {
        const nextIndex = renderedRecords.findIndex((record) => (
          record.kind === selectedRecord.kind && record.path === selectedRecord.path
        ));
        if (nextIndex >= 0) selectedIndex = nextIndex;
      }
      updateSelectedItem();
      positionPopup();
    });

    closeButton.addEventListener("mousedown", (event) => event.preventDefault());
    closeButton.addEventListener("click", () => {
      hidePopup();
      bridgeRequest("focus").catch(() => {});
    });

    document.addEventListener("keydown", (event) => {
      scrollSuppressed = false;
      if (popup.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        hidePopup();
        bridgeRequest("focus").catch(() => {});
        return;
      }
      if (!renderedRecords.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (renderedRecords.length === 1) {
          // A one-item includegraphics list has no alternative selection.
          // Keep the list visible while preserving normal editor navigation.
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
        activateRecord(renderedRecords[selectedIndex]);
      }
    }, true);

    const noteTextInput = () => {
      lastTextInputAt = Date.now();
      scrollSuppressed = false;
    };
    document.addEventListener("input", noteTextInput, true);

    document.addEventListener("mousedown", (event) => {
      scrollSuppressed = false;
      if (popup.hidden || popup.contains(event.target)) return;
      if (event.target?.closest?.(
        ".cm-content, .cm-line, .cm-scroller, .cm-editor, " +
        ".ace_content, .ace_text-layer, .ace_scroller, .ace_editor"
      )) return;
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
      // Scrolling only suppresses the list while the viewport is moving. Once
      // it settles, an includegraphics argument must immediately regain the
      // SmartTeX list even if the editor emits no further text/cursor update.
      updateFromState();
    });
    window.addEventListener("scroll", (event) => {
      if (event.target instanceof Node && popup.contains(event.target)) return;
      if (interactionTasks?.isScrolling?.()) return;
      positionPopup();
    }, true);

    extensionApi?.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes?.[VIEW_MODE_KEY]) return;
      const nextMode = normalizeViewMode(changes[VIEW_MODE_KEY].newValue);
      if (nextMode === viewMode) return;
      viewMode = nextMode;
      if (currentContext && !popup.hidden) {
        renderPopup();
        positionPopup();
      } else {
        updateViewButton();
      }
    });

    loadViewMode();
    ensureFigures();

    window.addEventListener("pagehide", () => {
      setAutocompleteContextActive(false);
      pendingRequests.forEach((pending) => {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error("SmartTeX page closed."));
      });
      pendingRequests.clear();
    }, { once: true });
  };

  initializeWhenDependenciesAreReady().catch((error) => {
    globalThis.__smartTeXFigureAutocompleteLoading = false;
    console.error(error?.message || "SmartTeX figure autocomplete could not load.", error);
  });
})();
