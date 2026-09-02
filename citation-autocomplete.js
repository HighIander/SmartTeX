/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (globalThis.__smartTeXCitationAutocompleteLoaded || window.top !== window) return;
  globalThis.__smartTeXCitationAutocompleteLoaded = true;

  const STATE_EVENT = "smarttex:editor-state";
  const REQUEST_EVENT = "smarttex:citation-editor-request";
  const RESPONSE_EVENT = "smarttex:citation-editor-response";
  const REFRESH_REQUEST_EVENT = "smarttex:citation-refresh-request";
  const REFRESH_RESULT_EVENT = "smarttex:citation-refresh-result";
  const CACHE_UPDATED_EVENT = "smarttex:citation-cache-updated";
  const CACHE_PREFIX = "smarttex:citation-cache:v1:";
  const OPEN_DELAY_MS = 220;
  const MAX_RESULTS = 8;
  const CITE_COMMAND = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)$/i;

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
  const SMART_CITATIONS_SELECTOR = "#ctca-popup, #ctca-bib-manager";
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const parser = globalThis.SmartTeXBibTeX;
  const contextTools = globalThis.SmartTeXLatexContext;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const popupInteractionReady = () => globalThis.SmartTeXPopupGate?.isReady?.() !== false;

  if (!parser?.parseBibTeX) {
    console.error("SmartTeX citation autocomplete could not load its BibTeX parser.");
    return;
  }

  let currentState = null;
  let currentContext = null;
  let records = [];
  let renderedRecords = [];
  let selectedIndex = 0;
  let lastPopupPosition = null;
  let parseState = "unparsed";
  let parseMessage = "";
  let cachedFiles = [];
  let cacheKey = "";
  let cacheGeneration = 0;
  let parsing = false;
  let popupTimer = null;
  let immediateOpenUntil = 0;
  let dismissedContextId = "";
  let requestCounter = 0;
  let smartCitationsPresent = false;
  let initialParseAttemptedKey = "";
  let backgroundLoadParseAttemptedKey = "";
  let ownershipRefreshTimer = 0;
  let lastOpenedFileName = "";
  let backgroundParseTimer = null;
  let scrollSuppressed = false;
  let lastTextInputAt = 0;
  const pendingRequests = new Map();

  const popup = document.createElement("aside");
  popup.id = "smarttex-citation-popup";
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "SmartTeX citation suggestions");
  popup.innerHTML = `
    <header class="smarttex-citation-header">
      <span class="smarttex-citation-query">Citation</span>
      <span class="smarttex-citation-header-actions">
        <button type="button" class="smarttex-citation-refresh" title="Re-parse bibliography files" aria-label="Refresh bibliography">
          <span aria-hidden="true">↻</span> Refresh
        </button>
        <span class="smarttex-popup-escape-hint" aria-hidden="true">[Esc]</span>
        <button type="button" class="smarttex-citation-close" title="Close (Esc)" aria-label="Close citation suggestions">&times;</button>
      </span>
    </header>
    <div class="smarttex-citation-status" hidden role="status" aria-live="polite"></div>
    <div class="smarttex-citation-list" role="listbox" aria-label="Citation suggestions"></div>
    <footer class="smarttex-citation-promotion">
      <span>Want a full reference manager, PDF tools, and synchronization?</span>
      <a href="https://github.com/HighIander/Smart-Citations" target="_blank" rel="noopener noreferrer">Try Smart Citations</a>
    </footer>`;
  document.documentElement.appendChild(popup);

  const queryLabel = popup.querySelector(".smarttex-citation-query");
  const status = popup.querySelector(".smarttex-citation-status");
  const list = popup.querySelector(".smarttex-citation-list");
  const closeButton = popup.querySelector(".smarttex-citation-close");
  const refreshButton = popup.querySelector(".smarttex-citation-refresh");
  globalThis.SmartTeXPopupUI?.enhance?.(popup, {
    type: "list",
    closeButton,
    onClose: () => hidePopup({ dismiss: true })
  });
  popup.addEventListener("smarttex:popup-resized", () => {
    const rect = popup.getBoundingClientRect();
    lastPopupPosition = { left: rect.left, top: rect.top };
    positionPopup();
  });

  function smartCitationsIsPresent() {
    return Boolean(document.querySelector(SMART_CITATIONS_SELECTOR));
  }

  function projectIdentity() {
    const projectMatch = window.location.pathname.match(/\/project\/([^/?#]+)/i);
    return `${window.location.origin}:${projectMatch?.[1] || window.location.pathname}`;
  }

  function projectCacheKey() {
    return `${CACHE_PREFIX}${projectIdentity()}`;
  }

  function contextId(context = currentContext) {
    if (!context) return "";
    return [
      currentState?.fileName || "",
      context.anchorIndex,
      context.fragmentStart
    ].join(":");
  }

  function clearPopupTimer() {
    window.clearTimeout(popupTimer);
    popupTimer = null;
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 3000) {
    const requestId = `${Date.now()}-${++requestCounter}`;
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
    bridgeRequest("setCitationAutocompleteActive", {
      active: Boolean(active) && !smartCitationsPresent
    }, 1200).catch(() => {});
  }

  function hidePopup({ dismiss = false } = {}) {
    clearPopupTimer();
    if (dismiss && currentContext) dismissedContextId = contextId();
    popup.hidden = true;
    lastPopupPosition = null;
    popup.classList.remove("smarttex-citation-visible");
    setBridgeActive(false);
  }

  function showPopup() {
    if (!popupInteractionReady() || smartCitationsPresent || !currentContext) return;
    popup.hidden = false;
    popup.classList.add("smarttex-citation-visible");
    setBridgeActive(true);
    positionPopup();
  }

  function findCitationContext(state) {
    if (
      !state?.value ||
      !Number.isInteger(state.cursorIndex) ||
      !/\.(?:tex|ltx)$/i.test(String(state.fileName || "main.tex"))
    ) {
      return null;
    }
    const masked = (typeof contextTools !== "undefined" && contextTools?.maskIgnoredLatex)
      ? contextTools.maskIgnoredLatex(state.value)
      : state.value;
    const beforeCursor = masked.slice(0, state.cursorIndex);
    const match = beforeCursor.match(CITE_COMMAND);
    if (!match) return null;
    const completeMatch = match[0];
    const argument = match[1];
    const lastComma = argument.lastIndexOf(",");
    const beforeFragment = argument.slice(lastComma + 1);
    const leadingWhitespace = beforeFragment.match(/^\s*/)?.[0] || "";
    const fragmentStart =
      state.cursorIndex - beforeFragment.length + leadingWhitespace.length;
    const anchorIndex =
      beforeCursor.length - completeMatch.length + completeMatch.lastIndexOf("{");
    const argumentIsClosed = matchingArgumentClose(state.value, anchorIndex) >= state.cursorIndex;
    // Ignore text after the cursor while the citation argument is still open.
    const afterFragment = argumentIsClosed
      ? (state.value.slice(state.cursorIndex).match(/^[^,{}\s]*/)?.[0] || "")
      : "";
    return {
      fragment: beforeFragment.slice(leadingWhitespace.length) + afterFragment,
      fragmentStart,
      fragmentEnd: state.cursorIndex + afterFragment.length,
      anchorIndex
    };
  }

  async function loadProjectCache() {
    const nextKey = projectCacheKey();
    if (nextKey === cacheKey) return;
    cacheKey = nextKey;
    initialParseAttemptedKey = "";
    backgroundLoadParseAttemptedKey = "";
    records = [];
    cachedFiles = [];
    parseState = "loading";
    parseMessage = "";
    const generation = ++cacheGeneration;
    try {
      const stored = await extensionApi?.storage?.local?.get?.(cacheKey);
      if (generation !== cacheGeneration || nextKey !== cacheKey) return;
      const cached = stored?.[cacheKey];
      if (Array.isArray(cached?.records) && cached.parsedAt) {
        records = cached.records;
        cachedFiles = Array.isArray(cached.files) ? cached.files : [];
        parseState = records.length ? "ready" : "empty";
      } else {
        parseState = "unparsed";
      }
    } catch (error) {
      if (generation !== cacheGeneration) return;
      parseState = "unparsed";
      console.warn("SmartTeX could not load its citation cache:", error);
    }
    if (!popup.hidden) {
      renderPopup();
      positionPopup();
    }
  }

  async function saveProjectCache() {
    if (!cacheKey || !extensionApi?.storage?.local?.set) return;
    const parsedAt = new Date().toISOString();
    await extensionApi.storage.local.set({
      [cacheKey]: {
        records,
        files: cachedFiles,
        parsedAt
      }
    });
    window.dispatchEvent(new CustomEvent(CACHE_UPDATED_EVENT, {
      detail: JSON.stringify({
        cacheKey,
        parsedAt,
        recordCount: records.length,
        files: cachedFiles
      })
    }));
  }

  function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase();
  }

  function recordSearchText(record) {
    return [
      record.key,
      record.title,
      ...(record.authors || []),
      record.journal,
      record.year,
      record.keywords,
      record.doi
    ].filter(Boolean).join("\n");
  }

  function termScore(value, term) {
    const text = normalizeSearch(value);
    const query = normalizeSearch(term);
    if (!query) return 100;
    if (text === query) return 0;
    if (text.startsWith(query)) return 1;
    const token = text.search(
      new RegExp(`(?:^|[\\s,;:_./()\\-])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    if (token >= 0) return 10 + token / 1000;
    const contained = text.indexOf(query);
    return contained >= 0 ? 20 + contained / 1000 : Number.POSITIVE_INFINITY;
  }

  function matchingRecords(fragment) {
    const terms = String(fragment || "").trim().split(/\s+/).filter(Boolean);
    const calculate = () => {
      const scored = [];
      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        interactionTasks?.checkpoint?.(recordIndex, 32);
        const record = records[recordIndex];
        let score = terms.length ? 0 : 100;
        for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
          interactionTasks?.checkpoint?.(termIndex, 8);
          const term = terms[termIndex];
          const termResult = Math.min(
            termScore(record.key, term),
            termScore(record.title, term) + 30,
            termScore((record.authors || []).join("; "), term) + 60,
            termScore(record.journal, term) + 90,
            termScore(record.year, term) + 100,
            termScore(recordSearchText(record), term) + 120
          );
          if (!Number.isFinite(termResult)) {
            score = Number.POSITIVE_INFINITY;
            break;
          }
          score += termResult;
        }
        if (Number.isFinite(score)) scored.push({ record, score });
      }
      let comparisons = 0;
      scored.sort((left, right) => {
        interactionTasks?.checkpoint?.(comparisons++, 32);
        return left.score - right.score ||
          left.record.key.localeCompare(right.record.key, undefined, {
            sensitivity: "base"
          });
      });
      return scored.slice(0, MAX_RESULTS).map((item) => item.record);
    };
    try {
      return interactionTasks?.runSync
        ? interactionTasks.runSync("citation-list-filter", calculate)
        : calculate();
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) return null;
      throw error;
    }
  }

  function abbreviatedAuthors(record) {
    const authors = record.authors || [];
    if (!authors.length) return "Unknown author";
    const first = authors.slice(0, 2).join(", ");
    return authors.length > 2 ? `${first} et al.` : first;
  }

  function publicationText(record) {
    const parts = [
      record.journal,
      record.volume,
      record.pages,
      record.year ? `(${record.year})` : ""
    ].filter(Boolean);
    return parts.join(", ") || "Publication details unavailable";
  }

  function appendHighlightedText(container, value, queryValue) {
    const text = String(value || "");
    const terms = [...new Set(
      String(queryValue || "").trim().split(/\s+/).filter(Boolean)
    )].sort((left, right) => right.length - left.length);
    if (!terms.length) {
      container.textContent = text;
      return;
    }
    const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      const index = Number(match.index) || 0;
      if (index > offset) container.appendChild(document.createTextNode(text.slice(offset, index)));
      const highlighted = document.createElement("strong");
      highlighted.className = "smarttex-autocomplete-match";
      highlighted.textContent = match[0];
      container.appendChild(highlighted);
      offset = index + match[0].length;
    }
    if (offset < text.length) container.appendChild(document.createTextNode(text.slice(offset)));
    if (!container.childNodes.length) container.textContent = text;
  }

  function setStatus(message, error = false) {
    status.hidden = !message;
    status.textContent = message || "";
    status.classList.toggle("smarttex-citation-status-error", error);
  }

  function createParsePrompt() {
    const card = document.createElement("section");
    card.className = "smarttex-citation-parse-card";
    const heading = document.createElement("strong");
    heading.textContent = parseState === "empty"
      ? "No citation entries were found"
      : "Bibliography not parsed";
    const description = document.createElement("p");
    description.textContent = parseState === "empty"
      ? "Parse the project bibliography again after checking that it contains valid BibTeX entries."
      : "SmartTeX reads the bibliography files directly from the project without opening them in the editor.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "smarttex-citation-parse";
    button.textContent = parsing
      ? "Parsing…"
      : parseState === "loading"
        ? "Checking cache…"
        : "Parse bibliography now";
    button.disabled = parsing || parseState === "loading";
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => parseBibliography());
    card.append(heading, description, button);
    list.appendChild(card);
  }

  function prependParsingIndicator() {
    const indicator = document.createElement("div");
    indicator.className = "smarttex-citation-list-parsing";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    indicator.innerHTML = `
      <span class="smarttex-citation-list-spinner" aria-hidden="true"></span>
      <span>Parsing bibliography…</span>`;
    list.prepend(indicator);
  }

  function renderPopup() {
    refreshButton.disabled = parsing || parseState === "loading";
    refreshButton.classList.toggle("smarttex-citation-refreshing", parsing);
    refreshButton.innerHTML = '<span aria-hidden="true">↻</span> Refresh';
    const query = currentContext?.fragment || "";
    queryLabel.textContent = query
      ? `Citations matching “${query}”`
      : "Select a citation";
    setStatus(parsing ? "" : parseMessage, false);

    if (parseState !== "ready") {
      list.replaceChildren();
      renderedRecords = [];
      if (!parsing) createParsePrompt();
      if (parsing) prependParsingIndicator();
      return;
    }

    const nextRecords = matchingRecords(query);
    if (!nextRecords) return;
    if (selectedIndex >= nextRecords.length) selectedIndex = 0;
    const fragment = document.createDocumentFragment();
    if (!nextRecords.length) {
      const empty = document.createElement("p");
      empty.className = "smarttex-citation-empty";
      empty.textContent = "No citation matches the current text.";
      fragment.appendChild(empty);
      renderedRecords = nextRecords;
      list.replaceChildren(fragment);
      if (parsing) prependParsingIndicator();
      return;
    }

    const exactKey = query.trim();
    nextRecords.forEach((record, index) => {
      interactionTasks?.checkpoint?.(index, 8);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "smarttex-citation-item";
      item.classList.toggle("smarttex-citation-exact", Boolean(exactKey) && record.key === exactKey);
      item.classList.toggle("smarttex-citation-selected", index === selectedIndex);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");

      const title = document.createElement("strong");
      title.className = "smarttex-citation-title";
      appendHighlightedText(title, record.title || record.key, query);
      title.title = title.textContent;
      const key = document.createElement("code");
      key.className = "smarttex-citation-key";
      appendHighlightedText(key, record.key, query);
      const authors = document.createElement("span");
      authors.className = "smarttex-citation-authors";
      appendHighlightedText(authors, abbreviatedAuthors(record), query);
      const publication = document.createElement("span");
      publication.className = "smarttex-citation-publication";
      appendHighlightedText(publication, publicationText(record), query);
      item.append(title, key, authors, publication);
      item.addEventListener("mouseenter", () => {
        selectedIndex = index;
        updateSelectedItem();
      });
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => insertRecord(record));
      fragment.appendChild(item);
    });
    renderedRecords = nextRecords;
    list.replaceChildren(fragment);
    if (parsing) prependParsingIndicator();
  }

  function updateSelectedItem() {
    [...list.querySelectorAll(".smarttex-citation-item")].forEach((item, index) => {
      const selected = index === selectedIndex;
      item.classList.toggle("smarttex-citation-selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
    });
    list.querySelectorAll(".smarttex-citation-item")[selectedIndex]
      ?.scrollIntoView({ block: "nearest" });
  }

  async function insertRecord(record) {
    if (!record || !currentContext || smartCitationsPresent) return;
    const dismissedId = contextId();
    hidePopup();
    try {
      await bridgeRequest("replaceCitationToken", { text: record.key });
      dismissedContextId = dismissedId;
    } catch (error) {
      dismissedContextId = "";
      renderPopup();
      showPopup();
      setStatus(error.message || String(error), true);
    }
  }

  function positionPopup() {
    if (popup.hidden || popup.classList.contains("smarttex-popup-resizing")) return;
    const screen = currentState?.screen;
    if (!screen) return;
    const margin = 9;
    const width = Math.max(1, Math.min(540, window.innerWidth - margin * 2));
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
      Math.min(460, window.innerHeight - margin * 2, availableSideSpace)
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

    // Keep an open citation list fixed while the caret moves within the citation.
    // Reposition it only if the caret would be covered or the viewport changed so
    // that the existing popup position is no longer usable.
    if (!lastPopupPosition || blocksCursor || outsideViewport) {
      const fitsBelow =
        cursorTop + lineHeight + gap + rect.height <= window.innerHeight - margin;
      const fitsAbove = cursorTop - gap - rect.height >= margin;
      const placeAbove = !fitsBelow && (fitsAbove || aboveSpace > belowSpace);
      const proposedTop = placeAbove
        ? cursorTop - gap - rect.height
        : cursorTop + lineHeight + gap;
      const left = Math.max(
        margin,
        Math.min(cursorLeft, window.innerWidth - rect.width - margin)
      );
      const top = Math.max(
        margin,
        Math.min(proposedTop, window.innerHeight - rect.height - margin)
      );
      lastPopupPosition = { left, top };
      popup.dataset.smarttexPlacement = placeAbove ? "above" : "below";
    }

    popup.style.left = `${Math.round(lastPopupPosition.left)}px`;
    popup.style.top = `${Math.round(lastPopupPosition.top)}px`;
  }

  function openForCurrentContext() {
    popupTimer = null;
    if (
      !popupInteractionReady() ||
      smartCitationsPresent ||
      parsing ||
      !currentContext ||
      contextId() === dismissedContextId
    ) {
      return;
    }
    selectedIndex = 0;
    renderPopup();
    showPopup();
    maybeStartInitialParse();
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
    if (parsing) return;
    if (smartCitationsPresent) {
      currentContext = null;
      hidePopup();
      return;
    }
    const nextContext = findCitationContext(currentState);
    if (!nextContext) {
      currentContext = null;
      dismissedContextId = "";
      hidePopup();
      return;
    }
    currentContext = nextContext;
    if (contextId() !== dismissedContextId) dismissedContextId = "";
    if (contextId() === dismissedContextId) {
      clearPopupTimer();
      popup.hidden = true;
      popup.classList.remove("smarttex-citation-visible");
      setBridgeActive(false);
      return;
    }
    setBridgeActive(true);
    clearPopupTimer();
    if (!popup.hidden) {
      selectedIndex = 0;
      renderPopup();
      positionPopup();
      maybeStartInitialParse();
      return;
    }
    if (Date.now() <= immediateOpenUntil) {
      immediateOpenUntil = 0;
      openForCurrentContext();
      return;
    }
    popupTimer = window.setTimeout(openForCurrentContext, OPEN_DELAY_MS);
  }

  document.addEventListener("pointerdown", (event) => {
    if (event.target?.closest?.(
      ".cm-content, .cm-line, .cm-scroller, .cm-editor, " +
      ".ace_content, .ace_text-layer, .ace_scroller, .ace_editor"
    )) {
      immediateOpenUntil = Date.now() + 500;
    }
  }, true);

  function bibliographyFiles(tex, cursorIndex = 0) {
    const searchable = contextTools?.maskIgnoredLatex?.(tex) || String(tex || "");
    const found = [];
    const add = (value, position) => {
      let name = String(value || "").trim().replace(/^['"]|['"]$/g, "");
      if (!name) return;
      if (!/\.bib$/i.test(name)) name += ".bib";
      found.push({ name, position });
    };
    let match;
    const traditional = /\\bibliography\s*\{([^{}]+)\}/gi;
    while ((match = traditional.exec(searchable)) !== null) {
      match[1].split(",").forEach((name) => add(name, match.index));
    }
    const biblatex = /\\(?:addbibresource|addglobalbib|addsectionbib)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/gi;
    while ((match = biblatex.exec(searchable)) !== null) add(match[1], match.index);
    const unique = new Map();
    found.sort((left, right) => (
      Number(left.position < cursorIndex) - Number(right.position < cursorIndex) ||
      left.position - right.position
    )).forEach((entry) => {
      const identity = entry.name.replace(/\\/g, "/").split("/").at(-1).toLowerCase();
      if (!unique.has(identity)) unique.set(identity, entry.name);
    });
    return [...unique.values()];
  }

  function treeItemName(item) {
    return String(
      item.getAttribute("aria-label") ||
      item.querySelector(".item-name-button span")?.textContent ||
      item.querySelector(".item-name span")?.textContent ||
      item.querySelector(".entity-name span")?.textContent ||
      ""
    ).trim();
  }

  function visibleBibFiles() {
    const names = new Set();
    document.querySelectorAll('.file-tree-list [role="treeitem"]').forEach((item) => {
      const name = treeItemName(item);
      if (/\.bib$/i.test(name)) names.add(name);
    });
    return [...names];
  }

  async function fetchBibliographyFile(fileName) {
    try {
      const read = await bridgeRequest("readProjectTextFile", {
        path: fileName
      }, 30000);
      if (typeof read?.file?.value !== "string") {
        throw new Error("The background reader returned no text.");
      }
      return {
        value: read.file.value,
        fileName: read.file.fileName || fileName
      };
    } catch (error) {
      throw new Error(`Background read failed: ${error.message || String(error)}`);
    }
  }

  function bibliographyDisplayName(value) {
    const normalized = String(value || "").replace(/\\/g, "/").trim();
    return normalized || "unnamed bibliography file";
  }

  function noEntriesMessage(fileResults) {
    const details = fileResults.map((result) => {
      const name = bibliographyDisplayName(result.fileName);
      return result.hasEntryMarker
        ? `${name} (BibTeX markers detected, but no entries parsed)`
        : name;
    });
    return `The detected bibliography file${details.length === 1 ? "" : "s"} contain${details.length === 1 ? "s" : ""} no parseable entries: ${details.join(", ")}.`;
  }

  async function parseBibliography({ showAutocomplete = true } = {}) {
    if (parsing) {
      return { ok: false, message: "Bibliography parsing is already in progress." };
    }
    if (smartCitationsPresent) {
      return { ok: false, message: "Smart Citations currently owns citation completion." };
    }

    const previousParseState = parseState;
    const previousRecords = records;
    const previousFiles = cachedFiles;
    const interactionGeneration = interactionTasks?.generation?.() ?? 0;
    let cancelledByEditorActivity = false;
    parsing = true;
    parseMessage = "";
    if (!records.length) parseState = "loading";

    const keepAutocompleteVisible = Boolean(showAutocomplete && currentContext);
    if (keepAutocompleteVisible) {
      renderPopup();
      positionPopup();
    }

    const originalState = currentState;
    let succeeded = false;
    try {
      const liveState = (await bridgeRequest("getState", {}, 2500)).state;
      interactionTasks?.throwIfGenerationChanged?.(interactionGeneration);
      let files = bibliographyFiles(liveState.value, liveState.cursorIndex);
      const activeBibFile = /\.bib$/i.test(String(liveState.fileName || ""))
        ? String(liveState.fileName)
        : "";
      if (activeBibFile) files.unshift(activeBibFile);
      if (!files.length) files = visibleBibFiles();
      files = [...new Map(files.map((fileName) => [
        String(fileName).replace(/\\/g, "/").toLocaleLowerCase(),
        fileName
      ])).values()];
      if (!files.length) {
        throw new Error(
          "No \\bibliography{…}, \\addbibresource{…}, or visible .bib file was found."
        );
      }

      const parsed = [];
      const failures = [];
      const fileResults = [];
      for (const fileName of files) {
        try {
          const normalizedRequested = String(fileName).replace(/\\/g, "/").toLocaleLowerCase();
          const normalizedActive = String(activeBibFile).replace(/\\/g, "/").toLocaleLowerCase();
          const useLiveEditorValue = activeBibFile && (
            normalizedRequested === normalizedActive ||
            normalizedRequested.split("/").at(-1) === normalizedActive.split("/").at(-1)
          );
          let bibState = useLiveEditorValue
            ? { value: liveState.value, fileName: liveState.fileName }
            : await fetchBibliographyFile(fileName);
          interactionTasks?.throwIfGenerationChanged?.(interactionGeneration);
          let fileRecords = interactionTasks?.runSync
            ? interactionTasks.runSync(
                "bibtex-parse",
                () => parser.parseBibTeX(bibState.value, bibState.fileName || fileName)
              )
            : parser.parseBibTeX(bibState.value, bibState.fileName || fileName);

          // CollabTeX can briefly expose the old editor session after changing
          // files. Retry a zero-result project read once before reporting a
          // valid bibliography as empty.
          if (!fileRecords.length && !useLiveEditorValue) {
            await new Promise((resolve) => window.setTimeout(resolve, 140));
            interactionTasks?.throwIfGenerationChanged?.(interactionGeneration);
            const retryState = await fetchBibliographyFile(fileName);
            interactionTasks?.throwIfGenerationChanged?.(interactionGeneration);
            const retryRecords = interactionTasks?.runSync
              ? interactionTasks.runSync(
                  "bibtex-parse-retry",
                  () => parser.parseBibTeX(retryState.value, retryState.fileName || fileName)
                )
              : parser.parseBibTeX(retryState.value, retryState.fileName || fileName);
            if (
              retryRecords.length ||
              String(retryState.value || "") !== String(bibState.value || "")
            ) {
              bibState = retryState;
              fileRecords = retryRecords;
            }
          }

          parsed.push(...fileRecords);
          fileResults.push({
            fileName: bibState.fileName || fileName,
            count: fileRecords.length,
            hasEntryMarker: /^[\t \u00a0\ufeff]*@[A-Za-z][A-Za-z0-9_-]*\s*[({]/m.test(
              String(bibState.value || "")
            )
          });
        } catch (error) {
          if (interactionTasks?.isAbortError?.(error)) throw error;
          failures.push(`${bibliographyDisplayName(fileName)}: ${error.message || String(error)}`);
        }
        // Yield between files so large projects never monopolize the editor UI.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        interactionTasks?.throwIfGenerationChanged?.(interactionGeneration);
      }

      const unique = new Map();
      parsed.forEach((record) => {
        if (!unique.has(record.key.toLocaleLowerCase())) {
          unique.set(record.key.toLocaleLowerCase(), record);
        }
      });

      const nextRecords = [...unique.values()];
      if (!nextRecords.length) {
        const readableFiles = fileResults.filter((result) => result.count === 0);
        throw new Error(
          failures.length
            ? `No BibTeX entries were parsed. ${failures.join("; ")}`
            : noEntriesMessage(readableFiles.length ? readableFiles : files.map((fileName) => ({
              fileName,
              count: 0,
              hasEntryMarker: false
            })))
        );
      }

      records = nextRecords;
      cachedFiles = files;
      parseState = "ready";
      parseMessage = failures.length
        ? `Some bibliography files could not be read: ${failures.join("; ")}`
        : "";
      await saveProjectCache();
      succeeded = true;
    } catch (error) {
      cancelledByEditorActivity = interactionTasks?.isAbortError?.(error) === true;
      records = previousRecords;
      cachedFiles = previousFiles;
      parseState = records.length ? "ready" : (previousParseState === "empty" ? "empty" : "unparsed");
      parseMessage = cancelledByEditorActivity ? "" : (error.message || String(error));
    } finally {
      parsing = false;
      try {
        currentState = (await bridgeRequest("getState", {}, 2200)).state || originalState;
      } catch (_error) {
        currentState = originalState;
      }
      currentContext = findCitationContext(currentState);
      if (smartCitationsIsPresent()) {
        updateSmartCitationsPresence();
      } else if (!cancelledByEditorActivity && keepAutocompleteVisible && currentContext) {
        renderPopup();
        showPopup();
        if (parseMessage) setStatus(parseMessage, !succeeded);
      }
    }

    return {
      ok: succeeded,
      cancelled: cancelledByEditorActivity,
      message: parseMessage || (
        succeeded
          ? `Parsed ${records.length} citation entr${records.length === 1 ? "y" : "ies"}.`
          : "Bibliography parsing failed."
      ),
      recordCount: records.length,
      files: cachedFiles
    };
  }


  function scheduleBackgroundParse(reason = "load") {
    if (smartCitationsPresent) return;
    const currentKey = projectCacheKey();
    if (reason === "load") {
      if (backgroundLoadParseAttemptedKey === currentKey) return;
      backgroundLoadParseAttemptedKey = currentKey;
    }
    window.clearTimeout(backgroundParseTimer);
    backgroundParseTimer = window.setTimeout(() => {
      backgroundParseTimer = null;
      if (smartCitationsPresent || parsing) {
        if (!smartCitationsPresent) scheduleBackgroundParse(reason);
        return;
      }
      parseBibliography({ showAutocomplete: false }).catch((error) => {
        parseMessage = error.message || String(error);
      });
    }, reason === "bib-opened" ? 450 : 900);
  }

  interactionTasks?.subscribe?.(() => {
    clearPopupTimer();
    window.clearTimeout(backgroundParseTimer);
    backgroundParseTimer = null;
    window.clearTimeout(ownershipRefreshTimer);
    ownershipRefreshTimer = 0;
    initialParseAttemptedKey = "";
    backgroundLoadParseAttemptedKey = "";
  });

  function maybeStartInitialParse() {
    if (
      parsing ||
      smartCitationsPresent ||
      !currentContext ||
      !["unparsed", "empty"].includes(parseState) ||
      initialParseAttemptedKey === cacheKey
    ) {
      return;
    }
    initialParseAttemptedKey = cacheKey;
    parseBibliography({ showAutocomplete: true }).catch((error) => {
      parseMessage = error.message || String(error);
      if (!popup.hidden) {
        renderPopup();
        setStatus(parseMessage, true);
      }
    });
  }

  function updateSmartCitationsPresence() {
    const present = smartCitationsIsPresent();
    if (present === smartCitationsPresent) return;
    smartCitationsPresent = present;
    if (present) {
      clearPopupTimer();
      currentContext = null;
      hidePopup();
    } else {
      updateFromState();
    }
  }

  window.addEventListener(STATE_EVENT, (event) => {
    try {
      currentState = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      return;
    }
    if (scrollSuppressed) {
      hidePopup();
      return;
    }
    updateSmartCitationsPresence();
    const openedFileName = String(currentState?.fileName || "");
    const bibWasJustOpened = /\.bib$/i.test(openedFileName) && openedFileName !== lastOpenedFileName;
    lastOpenedFileName = openedFileName;
    if (cacheKey !== projectCacheKey()) {
      loadProjectCache().then(() => {
        updateFromState();
        scheduleBackgroundParse("load");
        if (bibWasJustOpened) scheduleBackgroundParse("bib-opened");
      }).catch(() => {
        updateFromState();
        scheduleBackgroundParse("load");
        if (bibWasJustOpened) scheduleBackgroundParse("bib-opened");
      });
    } else {
      updateFromState();
      scheduleBackgroundParse("load");
      if (bibWasJustOpened) scheduleBackgroundParse("bib-opened");
    }
  });

  refreshButton.addEventListener("mousedown", (event) => event.preventDefault());
  refreshButton.addEventListener("click", () => {
    parseBibliography({ showAutocomplete: true }).catch((error) => {
      parseMessage = error.message || String(error);
      renderPopup();
      setStatus(parseMessage, true);
    });
  });

  window.addEventListener(REFRESH_REQUEST_EVENT, (event) => {
    let detail = {};
    try {
      detail = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      detail = {};
    }
    const requestId = String(detail.requestId || "");
    parseBibliography({ showAutocomplete: false }).then((result) => {
      window.dispatchEvent(new CustomEvent(REFRESH_RESULT_EVENT, {
        detail: JSON.stringify({ requestId, ...result })
      }));
    }).catch((error) => {
      window.dispatchEvent(new CustomEvent(REFRESH_RESULT_EVENT, {
        detail: JSON.stringify({
          requestId,
          ok: false,
          message: error.message || String(error)
        })
      }));
    });
  });

  closeButton.addEventListener("mousedown", (event) => event.preventDefault());
  closeButton.addEventListener("click", () => hidePopup({ dismiss: true }));

  document.addEventListener("keydown", (event) => {
    scrollSuppressed = false;
    if (smartCitationsPresent || popup.hidden || parsing) return;
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
        // With a single visible citation there is no alternative selection.
        // Preserve normal editor navigation instead of repeatedly selecting
        // the same autocomplete item.
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
      selectedIndex = (
        selectedIndex - 1 + renderedRecords.length
      ) % renderedRecords.length;
      updateSelectedItem();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      insertRecord(renderedRecords[selectedIndex]);
    }
  }, true);

  const noteTextInput = () => {
    lastTextInputAt = Date.now();
    scrollSuppressed = false;
  };
  document.addEventListener("input", noteTextInput, true);

  document.addEventListener("mousedown", (event) => {
    scrollSuppressed = false;
    if (!popup.hidden && !popup.contains(event.target)) {
      hidePopup();
    }
  }, true);

  window.addEventListener("resize", positionPopup, { passive: true });
  window.addEventListener("smarttex:editor-scroll-state", (event) => {
    if (event?.detail?.active !== true) return;
    if (currentContext && Date.now() - lastTextInputAt < 350) {
      scrollSuppressed = false;
      positionPopup();
      return;
    }
    scrollSuppressed = true;
    hidePopup();
  });
  window.addEventListener("scroll", (event) => {
    if (event.target instanceof Node && popup.contains(event.target)) return;
    positionPopup();
  }, true);

  const scheduleSmartCitationsPresenceUpdate = () => {
    if (ownershipRefreshTimer) return;
    ownershipRefreshTimer = window.setTimeout(() => {
      ownershipRefreshTimer = 0;
      updateSmartCitationsPresence();
    }, Math.max(0, Number(interactionTasks?.keyboardIdleRemaining?.()) || 0));
  };
  const smartCitationsMutation = (mutation) => {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
    if (target?.closest?.(SMART_CITATIONS_SELECTOR)) return true;
    return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => (
      node instanceof Element && (
        node.matches(SMART_CITATIONS_SELECTOR) || node.querySelector(SMART_CITATIONS_SELECTOR)
      )
    ));
  };
  const ownershipObserver = new MutationObserver((mutations) => {
    if (mutations.some(smartCitationsMutation)) scheduleSmartCitationsPresenceUpdate();
  });
  ownershipObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  updateSmartCitationsPresence();
  loadProjectCache().catch(() => {});

  window.addEventListener("pagehide", () => {
    clearPopupTimer();
    window.clearTimeout(backgroundParseTimer);
    window.clearTimeout(ownershipRefreshTimer);
    ownershipObserver.disconnect();
    setBridgeActive(false);
    pendingRequests.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("SmartTeX page closed."));
    });
    pendingRequests.clear();
  }, { once: true });
})();
