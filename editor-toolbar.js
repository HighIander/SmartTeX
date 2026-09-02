/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (window.top !== window || globalThis.__smartTeXEditorToolbarLoaded) return;
  globalThis.__smartTeXEditorToolbarLoaded = true;

  const STATE_EVENT = "smarttex:editor-state";
  const REQUEST_EVENT = "smarttex:citation-editor-request";
  const RESPONSE_EVENT = "smarttex:citation-editor-response";
  const NAVIGATION_PUSH_EVENT = "smarttex:navigation-history-push";
  const contextTools = globalThis.SmartTeXLatexContext;
  const tableEditor = globalThis.SmartTeXTableEditor;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;

  function taskCheckpoint(iteration = 0, interval = 128) {
    interactionTasks?.checkpoint?.(iteration, interval);
  }

  if (!contextTools || !tableEditor) {
    globalThis.__smartTeXEditorToolbarLoaded = false;
    console.error("SmartTeX: The editor toolbar dependencies are unavailable.");
    return;
  }

  let currentState = null;
  let editingToolbar = null;
  let navigationBackButton = null;
  let navigationBackDivider = null;
  const navigationHistory = [];
  let activeToolbarDropdown = null;
  let tableDialog = null;
  let doubleTableBorders = false;
  let requestCounter = 0;
  let stateUpdateTimer = 0;
  let attachFrame = 0;
  let attachTimer = 0;
  let overflowFrame = 0;
  let toolbarResizeObserver = null;
  let toolbarResizeTarget = null;
  let toolbarResizeElement = null;
  const pendingRequests = new Map();

  function bridgeRequest(type, payload = {}, timeoutMs = 3000) {
    const requestId = `editor-toolbar-${Date.now()}-${++requestCounter}`;
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

  function updateNavigationBackButton() {
    if (!navigationBackButton) return;
    const available = navigationHistory.length > 0;
    navigationBackButton.hidden = !available;
    navigationBackButton.disabled = !available;
    if (navigationBackDivider) navigationBackDivider.hidden = !available;
    editingToolbar?.classList.toggle("smarttex-document-has-back", available);
    navigationBackButton.title = available
      ? "Back to the previous editor position"
      : "No previous editor position";
    scheduleEditingToolbarOverflowUpdate();
  }

  function pushNavigationOrigin(value) {
    const cursorIndex = Math.max(0, Number(value?.cursorIndex) || 0);
    const anchor = Math.max(0, Number(value?.anchor ?? cursorIndex) || 0);
    const head = Math.max(0, Number(value?.head ?? cursorIndex) || 0);
    const origin = {
      fileName: String(value?.fileName || ""),
      cursorIndex,
      anchor,
      head
    };
    const previous = navigationHistory.at(-1);
    if (
      previous &&
      previous.fileName === origin.fileName &&
      previous.anchor === origin.anchor &&
      previous.head === origin.head
    ) {
      updateNavigationBackButton();
      return;
    }
    navigationHistory.push(origin);
    if (navigationHistory.length > 50) {
      navigationHistory.splice(0, navigationHistory.length - 50);
    }
    updateNavigationBackButton();
  }

  async function navigateBackInEditor() {
    const destination = navigationHistory.pop();
    updateNavigationBackButton();
    if (!destination) return false;
    try {
      const response = await bridgeRequest("setSelection", {
        anchor: destination.anchor,
        head: destination.head,
        focus: true
      });
      if (!response?.ok) throw new Error(response?.error || "Editor navigation failed.");
      return true;
    } catch (error) {
      navigationHistory.push(destination);
      updateNavigationBackButton();
      console.warn("SmartTeX could not return to the previous editor position:", error);
      return false;
    }
  }

  function sourceSelectionRange({ currentLine = false } = {}) {
    const source = String(currentState?.value || "");
    let start = Math.max(
      0,
      Math.min(
        Number(currentState?.selectionFrom ?? currentState?.cursorIndex) || 0,
        source.length
      )
    );
    let end = Math.max(
      start,
      Math.min(
        Number(currentState?.selectionTo ?? currentState?.cursorIndex) || 0,
        source.length
      )
    );
    if (currentLine && start === end) {
      start = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const lineEnd = source.indexOf("\n", end);
      end = lineEnd < 0 ? source.length : lineEnd;
    }
    return { source, start, end, text: source.slice(start, end) };
  }

  async function replaceEditorSource(
    start,
    end,
    text,
    selectionStart,
    selectionEnd,
    focusEditor = false
  ) {
    if (!currentState) return false;
    const source = String(currentState.value || "");
    const replacement = String(text || "");
    const boundedStart = Math.max(0, Math.min(Number(start) || 0, source.length));
    const boundedEnd = Math.max(
      boundedStart,
      Math.min(Number(end) || 0, source.length)
    );
    const nextSelectionStart = Math.max(
      boundedStart,
      Math.min(
        Number(selectionStart ?? boundedStart + replacement.length),
        boundedStart + replacement.length
      )
    );
    const nextSelectionEnd = Math.max(
      boundedStart,
      Math.min(
        Number(selectionEnd ?? nextSelectionStart),
        boundedStart + replacement.length
      )
    );

    const nextValue = (
      source.slice(0, boundedStart) +
      replacement +
      source.slice(boundedEnd)
    );
    currentState = {
      ...currentState,
      value: nextValue,
      cursorIndex: nextSelectionEnd,
      selectionFrom: Math.min(nextSelectionStart, nextSelectionEnd),
      selectionTo: Math.max(nextSelectionStart, nextSelectionEnd),
      selectionAnchor: nextSelectionStart,
      selectionHead: nextSelectionEnd,
      focused: Boolean(focusEditor)
    };
    updateEditingToolbarState();

    const response = await bridgeRequest("replaceRange", {
      start: boundedStart,
      end: boundedEnd,
      text: replacement,
      selectionStart: nextSelectionStart,
      selectionEnd: nextSelectionEnd,
      focus: focusEditor
    });
    return response?.ok === true;
  }

  function closingBraceIndex(source, openIndex) {
    if (source[openIndex] !== "{") return -1;
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
      if (source[index] === "\\" && !/[A-Za-z@]/.test(source[index + 1] || "")) {
        index += 1;
        continue;
      }
      if (source[index] === "{") depth += 1;
      if (source[index] !== "}") continue;
      depth -= 1;
      if (depth === 0) return index;
    }
    return -1;
  }

  function enclosingTextCommand(source, start, end, prefix) {
    let commandStart = source.lastIndexOf(prefix, start);
    while (commandStart >= 0) {
      const contentStart = commandStart + prefix.length;
      const close = closingBraceIndex(source, contentStart - 1);
      if (close >= end && start >= contentStart) {
        return {
          start: commandStart,
          end: close + 1,
          contentStart,
          contentEnd: close
        };
      }
      commandStart = source.lastIndexOf(prefix, commandStart - 1);
    }
    return null;
  }

  function toggleWrappedSource(prefix, suffix) {
    const range = sourceSelectionRange();
    const enclosing = enclosingTextCommand(
      range.source,
      range.start,
      range.end,
      prefix
    );
    if (enclosing && suffix === "}") {
      const content = range.source.slice(enclosing.contentStart, enclosing.contentEnd);
      const selectionStart = (
        enclosing.start +
        Math.max(0, range.start - enclosing.contentStart)
      );
      const selectionEnd = (
        enclosing.start +
        Math.max(0, range.end - enclosing.contentStart)
      );
      return replaceEditorSource(
        enclosing.start,
        enclosing.end,
        content,
        selectionStart,
        selectionEnd
      );
    }
    if (
      range.text.startsWith(prefix) &&
      range.text.endsWith(suffix) &&
      range.text.length >= prefix.length + suffix.length
    ) {
      const content = range.text.slice(prefix.length, -suffix.length);
      return replaceEditorSource(
        range.start,
        range.end,
        content,
        range.start,
        range.start + content.length
      );
    }
    const replacement = `${prefix}${range.text}${suffix}`;
    const selectionStart = range.start + prefix.length;
    const selectionEnd = selectionStart + range.text.length;
    return replaceEditorSource(
      range.start,
      range.end,
      replacement,
      selectionStart,
      selectionEnd
    );
  }

  function environmentContexts(sourceValue, names) {
    const source = String(sourceValue || "");
    const masked = contextTools.maskIgnoredLatex(source);
    const pattern = /\\(begin|end)\s*\{([^{}\r\n]+)\}/g;
    const stack = [];
    const contexts = [];
    let match;
    while ((match = pattern.exec(masked))) {
      const kind = match[1];
      const environment = match[2].trim();
      if (kind === "begin") {
        stack.push({
          environment,
          openStart: match.index,
          contentStart: match.index + match[0].length
        });
        continue;
      }
      let openingIndex = stack.length - 1;
      while (
        openingIndex >= 0 &&
        stack[openingIndex].environment !== environment
      ) {
        openingIndex -= 1;
      }
      if (openingIndex < 0) continue;
      const opening = stack[openingIndex];
      stack.splice(openingIndex);
      if (!names.has(environment)) continue;
      contexts.push({
        ...opening,
        contentEnd: match.index,
        closeEnd: match.index + match[0].length,
        complete: true
      });
    }
    return contexts;
  }

  function enclosingListEnvironment(range) {
    return environmentContexts(
      range.source,
      new Set(["itemize", "enumerate"])
    ).filter((context) => (
      range.start >= context.contentStart &&
      range.end <= context.contentEnd
    )).sort((left, right) => (
      (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart)
    ))[0] || null;
  }

  function listSelectedSource(environment) {
    const range = sourceSelectionRange({ currentLine: true });
    const enclosing = enclosingListEnvironment(range);
    if (enclosing?.environment === environment) {
      const body = range.source
        .slice(enclosing.contentStart, enclosing.contentEnd)
        .replace(
          /(^|\r?\n)[ \t]*\\item(?:\s*\[[^\]]*\])?[ \t]*/g,
          "$1"
        )
        .replace(/^\r?\n/, "")
        .replace(/\r?\n[ \t]*$/, "");
      return replaceEditorSource(
        enclosing.openStart,
        enclosing.closeEnd,
        body,
        enclosing.openStart,
        enclosing.openStart + body.length
      );
    }
    if (enclosing) {
      const body = range.source.slice(enclosing.contentStart, enclosing.contentEnd);
      const opening = `\\begin{${environment}}`;
      const closing = `\\end{${environment}}`;
      return replaceEditorSource(
        enclosing.openStart,
        enclosing.closeEnd,
        opening + body + closing,
        enclosing.openStart + opening.length,
        enclosing.openStart + opening.length + body.length
      );
    }
    const lines = range.text.split(/\r?\n/);
    const items = lines.map((line) => `\\item ${line.trim()}`).join("\n");
    const opening = `\\begin{${environment}}\n`;
    const closing = `\n\\end{${environment}}`;
    return replaceEditorSource(
      range.start,
      range.end,
      opening + items + closing,
      range.start + opening.length + "\\item ".length,
      range.start + opening.length + items.length
    );
  }

  function scheduleToolbarStateUpdate(delay = 100) {
    window.clearTimeout(stateUpdateTimer);
    stateUpdateTimer = window.setTimeout(() => {
      stateUpdateTimer = 0;
      updateEditingToolbarState();
    }, Math.max(
      Math.max(0, Number(delay) || 0),
      Number(interactionTasks?.keyboardIdleRemaining?.()) || 0
    ));
  }

  interactionTasks?.subscribe?.(() => {
    window.clearTimeout(stateUpdateTimer);
    stateUpdateTimer = 0;
    window.clearTimeout(attachTimer);
    attachTimer = 0;
    if (attachFrame) window.cancelAnimationFrame(attachFrame);
    attachFrame = 0;
    // A fresh editor-state event schedules both updates after keyboard idle.
  });

  function updateEditingToolbarState() {
    if (!editingToolbar || !currentState) return;
    if (interactionTasks?.canRunLongTask &&
        !interactionTasks.canRunLongTask(currentState, String(currentState.value || "").length)) return;
    const range = sourceSelectionRange();
    const commandButtons = [...editingToolbar.querySelectorAll(
      "button[data-smarttex-command]"
    )];
    const environmentButtons = [...editingToolbar.querySelectorAll(
      "button[data-smarttex-environment]"
    )];

    let calculated;
    try {
      const analyze = () => {
        const commandStates = commandButtons.map((button, index) => {
          taskCheckpoint(index, 8);
          return Boolean(enclosingTextCommand(
            range.source,
            range.start,
            range.end,
            button.dataset.smarttexCommand
          ));
        });
        const list = enclosingListEnvironment(range);
        const table = tableEditor.analyze(
          range.source,
          currentState.cursorIndex,
          range.start,
          range.end
        );
        return { commandStates, list, table };
      };
      calculated = interactionTasks?.runSync
        ? interactionTasks.runSync("toolbar-state-analysis", analyze)
        : analyze();
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) {
        scheduleToolbarStateUpdate(500);
        return;
      }
      calculated = {
        commandStates: commandButtons.map(() => false),
        list: null,
        table: null
      };
    }

    commandButtons.forEach((button, index) => {
      button.setAttribute(
        "aria-pressed",
        calculated.commandStates[index] ? "true" : "false"
      );
    });
    for (const button of environmentButtons) {
      button.setAttribute(
        "aria-pressed",
        calculated.list?.environment === button.dataset.smarttexEnvironment ? "true" : "false"
      );
    }

    const table = calculated.table;
    for (const button of editingToolbar.querySelectorAll(
      "button[data-smarttex-table-outside]"
    )) {
      button.hidden = Boolean(table);
      button.disabled = false;
    }
    for (const button of document.querySelectorAll(
      "button[data-smarttex-table-required]"
    )) {
      button.hidden = !table;
      let disabled = !table;
      const action = button.dataset.smarttexTableAction || "";
      if (table && action === "remove-row") disabled = table.rows.length <= 1;
      if (table && action === "remove-column") disabled = table.columnCount <= 1;
      if (table && action === "move-column-left") {
        disabled = table.current.logicalColumn <= 0 || table.hasMulticolumn;
      }
      if (table && action === "move-column-right") {
        disabled = (
          table.current.logicalColumn >= table.columnCount - 1 || table.hasMulticolumn
        );
      }
      if (table && action === "move-row-up") {
        disabled = table.current.rowIndex <= 0;
      }
      if (table && action === "move-row-down") {
        disabled = table.current.rowIndex >= table.rows.length - 1;
      }
      button.disabled = disabled;
    }
    if (!table && activeToolbarDropdown?._smarttexAnchor?.dataset.smarttexTableRequired) {
      closeToolbarDropdown();
    }
    scheduleEditingToolbarOverflowUpdate();
  }

  function unusedLabel(prefix, base) {
    const source = String(currentState?.value || "");
    let candidate = `${prefix}:${base}`;
    let number = 2;
    while (source.includes(`\\label{${candidate}}`)) {
      candidate = `${prefix}:${base}-${number}`;
      number += 1;
    }
    return candidate;
  }

  function insertEquationEnvironment() {
    const range = sourceSelectionRange();
    const label = unusedLabel("eq", "equation");
    const body = range.text;
    const opening = "\\begin{equation}\n";
    const beforeLabel = `${body}${body ? "\n" : ""}`;
    const closing = `\\label{${label}}\n\\end{equation}`;
    const replacement = opening + beforeLabel + closing;
    const bodyStart = range.start + opening.length;
    return replaceEditorSource(
      range.start,
      range.end,
      replacement,
      bodyStart,
      bodyStart + body.length
    );
  }

  function insertFigureEnvironment() {
    const range = sourceSelectionRange();
    const label = unusedLabel("fig", "figure");
    const opening = [
      "\\begin{figure}",
      "\\centering",
      "\\includegraphics[width=0.8\\linewidth]{"
    ].join("\n");
    const closing = [
      "}",
      "\\caption{}",
      `\\label{${label}}`,
      "\\end{figure}"
    ].join("\n");
    const replacement = `${opening}${closing}`;
    const pathPosition = range.start + opening.length;
    return replaceEditorSource(
      range.start,
      range.end,
      replacement,
      pathPosition,
      pathPosition,
      true
    );
  }

  function reportTableEditingError(error) {
    const message = error?.message || String(error || "Table editing failed.");
    console.warn("SmartTeX table editing failed:", error);
    globalThis.alert?.(message);
  }

  async function applyTableEdit(action) {
    if (!currentState) return false;
    const range = sourceSelectionRange();
    let edit;
    try {
      edit = action(
        String(currentState.value || ""),
        currentState.cursorIndex,
        range.start,
        range.end
      );
    } catch (error) {
      reportTableEditingError(error);
      return false;
    }
    if (!edit) return false;
    return replaceEditorSource(
      edit.start,
      edit.end,
      edit.text,
      edit.selectionStart,
      edit.selectionEnd,
      edit.focus !== false
    );
  }

  function closeToolbarDropdown({ restoreEditorFocus = false } = {}) {
    const menu = activeToolbarDropdown;
    activeToolbarDropdown = null;
    if (!menu) return;
    menu.hidden = true;
    menu._smarttexAnchor?.setAttribute("aria-expanded", "false");
    if (restoreEditorFocus && currentState) {
      bridgeRequest("setSelection", {
        anchor: Number(currentState.selectionAnchor ?? currentState.cursorIndex) || 0,
        head: Number(currentState.selectionHead ?? currentState.cursorIndex) || 0,
        focus: true
      }).catch(() => {});
    }
  }

  function positionToolbarDropdown(menu, anchor) {
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    const gap = 5;
    const left = Math.min(
      window.innerWidth - menuRect.width - margin,
      Math.max(margin, anchorRect.left)
    );
    let top = anchorRect.bottom + gap;
    if (top + menuRect.height > window.innerHeight - margin) {
      top = Math.max(margin, anchorRect.top - menuRect.height - gap);
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function toolbarDropdown(title, icon, options, { persistent = false, buildHeader = null } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = icon;

    const menu = document.createElement("div");
    menu.className = "smarttex-document-toolbar-dropdown";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu._smarttexAnchor = button;
    if (typeof buildHeader === "function") {
      const header = buildHeader(menu);
      if (header) menu.appendChild(header);
    }
    for (const option of options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "smarttex-document-toolbar-dropdown-item";
      item.setAttribute("role", "menuitem");
      if (option.tableAction) {
        item.dataset.smarttexTableRequired = "true";
        item.dataset.smarttexTableAction = option.tableAction;
      }
      item.innerHTML = option.icon
        ? `<span class="smarttex-document-toolbar-dropdown-icon">${option.icon}</span>` +
          `<span>${option.label}</span>`
        : option.label;
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        Promise.resolve(option.action()).catch(reportTableEditingError);
        if (!persistent && option.keepOpen !== true) closeToolbarDropdown();
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeToolbarDropdown === menu && !menu.hidden) {
        closeToolbarDropdown({ restoreEditorFocus: true });
        return;
      }
      closeToolbarDropdown();
      activeToolbarDropdown = menu;
      button.setAttribute("aria-expanded", "true");
      menu.classList.toggle(
        "smarttex-editor-dark",
        editingToolbar?.classList.contains("smarttex-editor-dark") || false
      );
      positionToolbarDropdown(menu, button);
    });
    return button;
  }

  function closeTableDialog() {
    if (!tableDialog) return;
    tableDialog.remove();
    tableDialog = null;
  }

  function showAddTableDialog() {
    closeToolbarDropdown();
    closeTableDialog();
    const range = sourceSelectionRange();
    const overlay = document.createElement("div");
    overlay.className = "smarttex-table-dialog-overlay";
    overlay.innerHTML = `
      <form class="smarttex-table-dialog" role="dialog" aria-modal="true" aria-label="Add table">
        <div class="smarttex-table-dialog-heading">
          <strong>Add table</strong>
          <button type="button" class="smarttex-table-dialog-close" aria-label="Close">&times;</button>
        </div>
        <label>Rows<input name="rows" type="number" min="1" max="100" value="3" required></label>
        <label>Columns<input name="columns" type="number" min="1" max="50" value="3" required></label>
        <label>Caption<input name="caption" type="text" value=""></label>
        <label>Label<input name="label" type="text" value="${unusedLabel("tab", "table")}"></label>
        <div class="smarttex-table-dialog-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="submit" class="smarttex-table-dialog-primary">Insert</button>
        </div>
      </form>`;
    tableDialog = overlay;
    document.body.appendChild(overlay);
    const form = overlay.querySelector("form");
    form.classList.toggle(
      "smarttex-editor-dark",
      editingToolbar?.classList.contains("smarttex-editor-dark") || false
    );
    const close = () => closeTableDialog();
    overlay.querySelector(".smarttex-table-dialog-close")?.addEventListener("click", close);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", close);
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) close();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const created = tableEditor.createTable({
        rows: data.get("rows"),
        columns: data.get("columns"),
        caption: data.get("caption"),
        label: data.get("label"),
        selectedText: range.text
      });
      close();
      replaceEditorSource(
        range.start,
        range.end,
        created.text,
        range.start + created.selectionStart,
        range.start + created.selectionEnd,
        true
      ).catch(reportTableEditingError);
    });
    window.requestAnimationFrame(() => form.elements.rows?.focus());
  }

  function tableBorderMenuHeader() {
    const header = document.createElement("label");
    header.className = "smarttex-table-border-mode";
    header.innerHTML = `
      <span>Single</span>
      <input type="checkbox" ${doubleTableBorders ? "checked" : ""}>
      <span class="smarttex-table-border-switch" aria-hidden="true"></span>
      <span>Double</span>`;
    const input = header.querySelector("input");
    input.addEventListener("change", () => {
      doubleTableBorders = input.checked;
    });
    return header;
  }

  function toolbarIcon(markup) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${markup}</svg>`;
  }

  function createEditingToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "smarttex-document-editing-toolbar smarttex-document-editing-toolbar-editor";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Format selected LaTeX text");
    toolbar.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    const button = (title, icon, action) => {
      const item = document.createElement("button");
      item.type = "button";
      item.title = title;
      item.setAttribute("aria-label", title);
      item.innerHTML = icon;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        Promise.resolve(action()).catch((error) => {
          console.error(`SmartTeX ${title.toLowerCase()} failed:`, error);
        });
      });
      return item;
    };

    navigationBackButton = button(
      "Back to the previous editor position",
      toolbarIcon('<path d="m14 5-7 7 7 7"/><path d="M8 12h11"/>'),
      navigateBackInEditor
    );
    navigationBackButton.classList.add("smarttex-document-back-button");
    navigationBackButton.hidden = true;
    navigationBackButton.disabled = true;

    const bold = button(
      "Bold",
      '<span class="smarttex-toolbar-letter"><strong>B</strong></span>',
      () => toggleWrappedSource("\\textbf{", "}")
    );
    bold.dataset.smarttexCommand = "\\textbf{";
    bold.setAttribute("aria-pressed", "false");
    const italic = button(
      "Italic",
      '<span class="smarttex-toolbar-letter"><em>I</em></span>',
      () => toggleWrappedSource("\\textit{", "}")
    );
    italic.dataset.smarttexCommand = "\\textit{";
    italic.setAttribute("aria-pressed", "false");
    const underline = button(
      "Underline",
      '<span class="smarttex-toolbar-letter smarttex-toolbar-underlined">U</span>',
      () => toggleWrappedSource("\\underline{", "}")
    );
    underline.dataset.smarttexCommand = "\\underline{";
    underline.setAttribute("aria-pressed", "false");
    const size = document.createElement("select");
    size.title = "Text size";
    size.setAttribute("aria-label", "Text size");
    [
      ["", "Size"],
      ["tiny", "Tiny"],
      ["scriptsize", "Script"],
      ["footnotesize", "Footnote"],
      ["small", "Small"],
      ["normalsize", "Normal"],
      ["large", "Large"],
      ["Large", "Larger"],
      ["LARGE", "Very large"],
      ["huge", "Huge"]
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      size.appendChild(option);
    });
    size.addEventListener("change", () => {
      const command = size.value;
      size.value = "";
      if (!command) return;
      toggleWrappedSource(`{\\${command} `, "}").catch((error) => {
        console.error("SmartTeX text-size formatting failed:", error);
      });
    });
    const comments = button(
      "Comments",
      toolbarIcon(
        '<path d="M4 5.5h11a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H9l-4 3v-3H4a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3Z"/>' +
        '<path d="m14.5 16.5 4.7-4.7 2 2-4.7 4.7-3 .8.8-2.8Z"/>'
      ),
      () => document.dispatchEvent(new CustomEvent("smarttex:comments-toggle-pane", { bubbles: true, composed: true }))
    );
    comments.id = "smarttex-comments-toggle-button";
    comments.setAttribute("aria-pressed", "false");
    comments.classList.toggle(
      "smarttex-review-tracking-active",
      Boolean(globalThis.__smartTeXReviewState?.tracking)
    );
    const updateCommentsUnread = (countValue) => {
      const count = Math.max(0, Number(countValue) || 0);
      comments.classList.toggle("smarttex-comments-has-unread", count > 0);
      comments.dataset.unreadCount = String(count);
      comments.setAttribute("aria-label", count > 0 ? `Comments (${count} unread)` : "Comments");
      comments.title = count > 0 ? `Comments — ${count} unread` : "Comments";
    };
    updateCommentsUnread(globalThis.__smartTeXCommentsUnreadCount || 0);
    window.addEventListener("smarttex:comments-unread-state", (event) => {
      updateCommentsUnread(event.detail?.count);
    });
    window.addEventListener("smarttex:comments-pane-state", (event) => {
      const open = Boolean(event.detail?.open);
      comments.setAttribute("aria-pressed", open ? "true" : "false");
      comments.classList.toggle("smarttex-comments-active", open);
    });
    window.addEventListener("smarttex:review-state", (event) => {
      const tracking = Boolean(event.detail?.tracking);
      comments.classList.toggle("smarttex-review-tracking-active", tracking);
      comments.dataset.trackingChanges = tracking ? "true" : "false";
    });

    const itemize = button(
      "Bulleted list",
      toolbarIcon(
        '<circle cx="4" cy="6" r="1.4"/><circle cx="4" cy="12" r="1.4"/>' +
        '<circle cx="4" cy="18" r="1.4"/><path d="M8 6h12M8 12h12M8 18h12"/>'
      ),
      () => listSelectedSource("itemize")
    );
    itemize.dataset.smarttexEnvironment = "itemize";
    itemize.setAttribute("aria-pressed", "false");
    const enumerate = button(
      "Numbered list",
      toolbarIcon(
        '<text x="2" y="8" font-size="7" font-weight="700">1</text>' +
        '<text x="2" y="15" font-size="7" font-weight="700">2</text>' +
        '<text x="2" y="22" font-size="7" font-weight="700">3</text>' +
        '<path d="M9 6h11M9 12h11M9 18h11"/>'
      ),
      () => listSelectedSource("enumerate")
    );
    enumerate.dataset.smarttexEnvironment = "enumerate";
    enumerate.setAttribute("aria-pressed", "false");
    const addFigure = button(
      "Add figure",
      toolbarIcon(
        '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
        '<circle cx="8" cy="9" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/>'
      ),
      insertFigureEnvironment
    );
    const addEquation = button(
      "Add equation",
      '<span class="smarttex-toolbar-letter smarttex-toolbar-sigma" aria-hidden="true">Σ</span>',
      insertEquationEnvironment
    );
    const tableGridIcon = (extra = "") => toolbarIcon(
      '<rect x="3" y="4" width="18" height="16" rx="1.5"/>' +
      '<path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>' + extra
    );
    const addTable = button(
      "Add table",
      tableGridIcon('<circle cx="19" cy="5" r="4" class="smarttex-toolbar-icon-badge"/>' +
        '<path d="M19 3v4M17 5h4" class="smarttex-toolbar-icon-badge-mark"/>'),
      showAddTableDialog
    );
    addTable.dataset.smarttexTableOutside = "true";

    const tableStructure = toolbarDropdown(
      "Add or remove table rows and columns",
      toolbarIcon(
        '<rect x="8" y="5" width="8" height="14" rx="1" class="smarttex-table-icon-current"/>' +
        '<rect x="2" y="5" width="4" height="14" rx="1" class="smarttex-table-icon-add"/>' +
        '<rect x="18" y="5" width="4" height="14" rx="1" class="smarttex-table-icon-remove"/>' +
        '<path d="M3 12h2M19 12h2" class="smarttex-table-icon-mark"/>'
      ),
      [
        {
          label: "Add row above",
          tableAction: "add-row",
          icon: toolbarIcon(
            '<rect x="4" y="11" width="16" height="7" rx="1" class="smarttex-table-icon-current"/>' +
            '<rect x="4" y="3" width="16" height="6" rx="1" class="smarttex-table-icon-add"/>' +
            '<path d="M12 4.5v3M10.5 6h3" class="smarttex-table-icon-mark"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.addRow(source, cursor, "above", start, end)
          ))
        },
        {
          label: "Add row below",
          tableAction: "add-row",
          icon: toolbarIcon(
            '<rect x="4" y="5" width="16" height="7" rx="1" class="smarttex-table-icon-current"/>' +
            '<rect x="4" y="14" width="16" height="6" rx="1" class="smarttex-table-icon-add"/>' +
            '<path d="M12 15.5v3M10.5 17h3" class="smarttex-table-icon-mark"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.addRow(source, cursor, "below", start, end)
          ))
        },
        {
          label: "Remove current row",
          tableAction: "remove-row",
          icon: toolbarIcon(
            '<rect x="4" y="4" width="16" height="7" rx="1" class="smarttex-table-icon-current"/>' +
            '<rect x="4" y="13" width="16" height="7" rx="1" class="smarttex-table-icon-remove"/>' +
            '<path d="M9 16.5h6" class="smarttex-table-icon-mark"/>'
          ),
          action: () => applyTableEdit(tableEditor.removeRow)
        },
        {
          label: "Add column left",
          tableAction: "add-column",
          icon: toolbarIcon(
            '<rect x="11" y="4" width="7" height="16" rx="1" class="smarttex-table-icon-current"/>' +
            '<rect x="3" y="4" width="6" height="16" rx="1" class="smarttex-table-icon-add"/>' +
            '<path d="M6 9v6M3 12h6" class="smarttex-table-icon-mark"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.addColumn(source, cursor, "left", start, end)
          ))
        },
        {
          label: "Add column right",
          tableAction: "add-column",
          icon: toolbarIcon(
            '<rect x="6" y="4" width="7" height="16" rx="1" class="smarttex-table-icon-current"/>' +
            '<rect x="15" y="4" width="6" height="16" rx="1" class="smarttex-table-icon-add"/>' +
            '<path d="M18 9v6M15 12h6" class="smarttex-table-icon-mark"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.addColumn(source, cursor, "right", start, end)
          ))
        },
        {
          label: "Remove current column",
          tableAction: "remove-column",
          icon: toolbarIcon(
            '<rect x="4" y="4" width="7" height="16" rx="1" class="smarttex-table-icon-current"/>' +
            '<rect x="13" y="4" width="7" height="16" rx="1" class="smarttex-table-icon-remove"/>' +
            '<path d="M15 12h3" class="smarttex-table-icon-mark"/>'
          ),
          action: () => applyTableEdit(tableEditor.removeColumn)
        }
      ]
    );
    tableStructure.dataset.smarttexTableRequired = "true";
    tableStructure.dataset.smarttexTableAction = "structure";

    const moveTablePart = toolbarDropdown(
      "Move table rows or columns",
      toolbarIcon(
        '<rect x="8" y="4" width="8" height="16" rx="1" class="smarttex-table-icon-current"/>' +
        '<path d="M6 8H2m2-2-2 2 2 2M18 16h4m-2-2 2 2-2 2"/>'
      ),
      [
        {
          label: "Move current row up",
          tableAction: "move-row-up",
          icon: toolbarIcon(
            '<rect x="5" y="9" width="14" height="9" rx="1" class="smarttex-table-icon-current"/>' +
            '<path d="M12 7V2M9 5l3-3 3 3"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.moveRow(source, cursor, "up", start, end)
          ))
        },
        {
          label: "Move current row down",
          tableAction: "move-row-down",
          icon: toolbarIcon(
            '<rect x="5" y="5" width="14" height="9" rx="1" class="smarttex-table-icon-current"/>' +
            '<path d="M12 16v5M9 18l3 3 3-3"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.moveRow(source, cursor, "down", start, end)
          ))
        },
        {
          label: "Move current column left",
          tableAction: "move-column-left",
          icon: toolbarIcon(
            '<rect x="10" y="4" width="9" height="16" rx="1" class="smarttex-table-icon-current"/>' +
            '<path d="M8 12H3M6 9l-3 3 3 3"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.moveColumn(source, cursor, "left", start, end)
          ))
        },
        {
          label: "Move current column right",
          tableAction: "move-column-right",
          icon: toolbarIcon(
            '<rect x="5" y="4" width="9" height="16" rx="1" class="smarttex-table-icon-current"/>' +
            '<path d="M16 12h5M18 9l3 3-3 3"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.moveColumn(source, cursor, "right", start, end)
          ))
        }
      ]
    );
    moveTablePart.dataset.smarttexTableRequired = "true";
    moveTablePart.dataset.smarttexTableAction = "move";

    const borderOptionIcon = (sides) => toolbarIcon(
      '<rect x="5" y="5" width="14" height="14" rx="0.5" class="smarttex-border-guide"/>' +
      sides
    );
    const borders = toolbarDropdown(
      "Table borders",
      toolbarIcon(
        '<rect x="3" y="3" width="18" height="18" rx="1" class="smarttex-table-border-toolbar-outline"/>' +
        '<path d="M3 10h18M3 15h18M10 3v18M15 3v18" class="smarttex-border-guide"/>'
      ),
      [
        {
          label: "No borders in selection",
          icon: borderOptionIcon(
            '<path d="M4 4l16 16" class="smarttex-border-remove"/>' +
            '<path d="M20 4 4 20" class="smarttex-border-remove"/>'
          ),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.removeBorders(source, cursor, start, end)
          ))
        },
        {
          label: "Toggle line to left",
          icon: borderOptionIcon('<path d="M5 4v16" class="smarttex-border-active"/>'),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.toggleBorder(source, cursor, "left", doubleTableBorders, start, end)
          ))
        },
        {
          label: "Toggle line to right",
          icon: borderOptionIcon('<path d="M19 4v16" class="smarttex-border-active"/>'),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.toggleBorder(source, cursor, "right", doubleTableBorders, start, end)
          ))
        },
        {
          label: "Toggle line below",
          icon: borderOptionIcon('<path d="M4 19h16" class="smarttex-border-active"/>'),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.toggleBorder(source, cursor, "below", doubleTableBorders, start, end)
          ))
        },
        {
          label: "Toggle line above",
          icon: borderOptionIcon('<path d="M4 5h16" class="smarttex-border-active"/>'),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.toggleBorder(source, cursor, "above", doubleTableBorders, start, end)
          ))
        },
        {
          label: "Toggle line around current cell",
          icon: borderOptionIcon('<rect x="5" y="5" width="14" height="14" class="smarttex-border-active"/>'),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.toggleBorder(source, cursor, "cell", doubleTableBorders, start, end)
          ))
        },
        {
          label: "Toggle line around table",
          icon: borderOptionIcon('<rect x="3" y="3" width="18" height="18" class="smarttex-border-active"/>'),
          action: () => applyTableEdit((source, cursor, start, end) => (
            tableEditor.toggleBorder(source, cursor, "table", doubleTableBorders, start, end)
          ))
        }
      ],
      { persistent: true, buildHeader: tableBorderMenuHeader }
    );
    borders.dataset.smarttexTableRequired = "true";
    borders.dataset.smarttexTableAction = "borders";

    const beautifyTable = button(
      "Beautify table source",
      toolbarIcon(
        '<path d="M4 6h4M11 6h9M4 12h7M14 12h6M4 18h10M17 18h3"/>' +
        '<path d="M8 3v6M11 9V3M11 9h3M14 9V3M14 15v6M17 21v-6M14 15h3"/>'
      ),
      () => applyTableEdit((source, cursor, start, end) => (
        tableEditor.beautify(source, cursor, start, end)
      ))
    );
    beautifyTable.dataset.smarttexTableRequired = "true";
    beautifyTable.dataset.smarttexTableAction = "beautify";

    const divider = () => {
      const item = document.createElement("span");
      item.className = "smarttex-document-toolbar-divider";
      item.setAttribute("aria-hidden", "true");
      return item;
    };
    navigationBackDivider = divider();
    navigationBackDivider.classList.add("smarttex-document-back-divider");
    navigationBackDivider.hidden = true;
    toolbar.append(
      navigationBackButton,
      navigationBackDivider,
      bold,
      italic,
      underline,
      size,
      divider(),
      itemize,
      enumerate,
      divider(),
      addFigure,
      addEquation,
      divider(),
      addTable,
      tableStructure,
      moveTablePart,
      borders,
      beautifyTable,
      divider(),
      comments
    );
    if (!currentState) {
      for (const item of document.querySelectorAll("button[data-smarttex-table-required]")) {
        item.hidden = true;
        item.disabled = true;
      }
    } else {
      updateEditingToolbarState();
    }
    return toolbar;
  }


  function updateEditingToolbarOverflow() {
    overflowFrame = 0;
    if (!editingToolbar?.isConnected) return;
    const overflowing = editingToolbar.scrollWidth > editingToolbar.clientWidth + 1;
    editingToolbar.classList.toggle("smarttex-document-toolbar-overflowing", overflowing);
  }

  function scheduleEditingToolbarOverflowUpdate() {
    if (overflowFrame) return;
    overflowFrame = window.requestAnimationFrame(updateEditingToolbarOverflow);
  }

  function observeEditingToolbarSize(editorToolbar) {
    if (
      toolbarResizeTarget === editorToolbar &&
      toolbarResizeElement === editingToolbar &&
      toolbarResizeObserver
    ) return;
    toolbarResizeObserver?.disconnect?.();
    toolbarResizeObserver = null;
    toolbarResizeTarget = editorToolbar || null;
    toolbarResizeElement = editingToolbar || null;
    if (!editorToolbar || typeof ResizeObserver !== "function") return;
    toolbarResizeObserver = new ResizeObserver(() => scheduleEditingToolbarOverflowUpdate());
    toolbarResizeObserver.observe(editorToolbar);
    if (editingToolbar) toolbarResizeObserver.observe(editingToolbar);
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      (rect.width > 0 || rect.height > 0) &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function editorToolbarCandidates() {
    const selectors = [
      ".toolbar.toolbar-editor",
      "#ide-redesign-panel-editor [role='toolbar']",
      "#ide-redesign-panel-editor .ol-cm-toolbar",
      "#ide-redesign-panel-editor [class*='toolbar']",
      "[data-testid*='editor' i] [role='toolbar']",
      "[data-testid*='editor' i] [class*='toolbar']",
      ".editor-pane [role='toolbar']",
      ".editor-pane [class*='toolbar']"
    ];
    return [...new Set(selectors.flatMap((selector) => (
      [...document.querySelectorAll(selector)]
    )))].filter((candidate) => (
      isVisible(candidate) &&
      !candidate.closest("#ide-redesign-panel-pdf, [data-testid*='pdf' i]") &&
      !candidate.closest(".smarttex-dialog-overlay")
    ));
  }

  function parsedRgb(value) {
    const match = String(value || "").match(
      /rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i
    );
    return match ? match.slice(1, 4).map(Number) : null;
  }

  function visibleBackgroundColor(element) {
    let current = element;
    while (current && current !== document.documentElement) {
      const color = getComputedStyle(current).backgroundColor;
      const rgb = parsedRgb(color);
      if (rgb && color !== "rgba(0, 0, 0, 0)") return rgb;
      current = current.parentElement;
    }
    return parsedRgb(getComputedStyle(document.body).backgroundColor);
  }

  function editorUsesDarkMode(editorToolbar = editorToolbarCandidates()[0] || null) {
    const themeMarker = [
      document.documentElement.className,
      document.body?.className,
      document.documentElement.dataset?.theme,
      document.body?.dataset?.theme
    ].filter(Boolean).join(" ");
    if (/(?:^|[\s_-])dark(?:$|[\s_-])/i.test(themeMarker)) return true;
    if (/(?:^|[\s_-])light(?:$|[\s_-])/i.test(themeMarker)) return false;
    const editorSurface = document.querySelector(
      "#ide-redesign-panel-editor .cm-editor, " +
      "#ide-redesign-panel-editor .cm-scroller, " +
      "#ide-redesign-panel-editor .CodeMirror, " +
      "[data-testid*='editor' i] .cm-editor, " +
      ".editor-pane .cm-editor"
    );
    const rgb = visibleBackgroundColor(editorSurface || editorToolbar);
    if (!rgb) return globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false;
    const [red, green, blue] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.32;
  }

  function attachEditingToolbar() {
    const editorToolbar = editorToolbarCandidates()[0] || null;
    if (!editorToolbar) return;
    if (!editingToolbar || !editingToolbar.isConnected) {
      editingToolbar = createEditingToolbar();
      updateEditingToolbarState();
      updateNavigationBackButton();
    }
    editingToolbar.classList.toggle(
      "smarttex-editor-dark",
      editorUsesDarkMode(editorToolbar)
    );
    if (editingToolbar.parentElement !== editorToolbar) {
      editorToolbar.appendChild(editingToolbar);
    }
    observeEditingToolbarSize(editorToolbar);
    scheduleEditingToolbarOverflowUpdate();
  }

  function scheduleAttachEditingToolbar() {
    const idleDelay = Math.max(0, Number(interactionTasks?.keyboardIdleRemaining?.()) || 0);
    if (idleDelay > 0) {
      if (attachTimer) return;
      attachTimer = window.setTimeout(() => {
        attachTimer = 0;
        scheduleAttachEditingToolbar();
      }, idleDelay);
      return;
    }
    if (attachFrame || attachTimer) return;
    attachFrame = window.requestAnimationFrame(() => {
      attachFrame = 0;
      attachEditingToolbar();
    });
  }

  window.addEventListener(STATE_EVENT, (event) => {
    try {
      currentState = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      currentState = null;
      return;
    }
    scheduleAttachEditingToolbar();
    scheduleToolbarStateUpdate();
  });

  window.addEventListener(NAVIGATION_PUSH_EVENT, (event) => {
    try {
      pushNavigationOrigin(JSON.parse(String(event.detail || "{}")));
    } catch (_error) {
      // Ignore malformed navigation-history events from unrelated page scripts.
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (
      activeToolbarDropdown &&
      !activeToolbarDropdown.contains(event.target) &&
      !activeToolbarDropdown._smarttexAnchor?.contains(event.target)
    ) {
      closeToolbarDropdown();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (activeToolbarDropdown) closeToolbarDropdown({ restoreEditorFocus: true });
    if (tableDialog) closeTableDialog();
  }, true);

  window.addEventListener("resize", () => {
    scheduleEditingToolbarOverflowUpdate();
    if (activeToolbarDropdown && !activeToolbarDropdown.hidden) {
      positionToolbarDropdown(
        activeToolbarDropdown,
        activeToolbarDropdown._smarttexAnchor
      );
    }
  }, { passive: true });

  const observer = new MutationObserver(() => {
    if (editingToolbar?.isConnected) return;
    scheduleAttachEditingToolbar();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleAttachEditingToolbar();
  window.setTimeout(() => {
    bridgeRequest("getState", {}, 1500).then((response) => {
      if (!response?.state) return;
      currentState = response.state;
      scheduleAttachEditingToolbar();
      updateEditingToolbarState();
    }).catch(() => {});
  }, 0);

  window.addEventListener("pagehide", () => {
    observer.disconnect();
    window.clearTimeout(stateUpdateTimer);
    window.clearTimeout(attachTimer);
    if (attachFrame) window.cancelAnimationFrame(attachFrame);
    if (overflowFrame) window.cancelAnimationFrame(overflowFrame);
    toolbarResizeObserver?.disconnect?.();
    toolbarResizeObserver = null;
    toolbarResizeTarget = null;
    toolbarResizeElement = null;
    closeToolbarDropdown();
    closeTableDialog();
    editingToolbar?.remove();
    for (const pending of pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("SmartTeX page closed."));
    }
    pendingRequests.clear();
  }, { once: true });
})();
