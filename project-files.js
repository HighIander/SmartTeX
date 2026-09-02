/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (globalThis.__smartTeXProjectFilesLoaded || window.top !== window) return;
  globalThis.__smartTeXProjectFilesLoaded = true;

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const nextcloud = globalThis.SmartTeXNextcloud;
  if (!nextcloud) {
    console.error("SmartTeX: The Nextcloud client could not be loaded.");
    return;
  }

  const PROJECT_STATE_PREFIX = "smarttex:project-nextcloud:v1:";
  const AUTO_UPDATE_INTERVAL_MS = 60 * 1000;
  const SEARCH_DELAY_MS = 500;
  const EDITOR_STATE_EVENT = "smarttex:editor-state";
  const EDITOR_REQUEST_EVENT = "smarttex:citation-editor-request";
  const EDITOR_RESPONSE_EVENT = "smarttex:citation-editor-response";
  const NAVIGATION_PUSH_EVENT = "smarttex:navigation-history-push";
  const FIGURE_FILE_RE = /\.(?:png|jpe?g|gif|webp|svg|pdf|eps|bmp|tiff?)$/i;
  let projectState = null;
  let uiObserver = null;
  let uiTimer = null;
  let autoUpdateTimer = null;
  let updateInProgress = false;
  let toastTimer = null;
  let stateWriteQueue = Promise.resolve();
  let activeConnectionCache = null;
  let currentEditorState = null;
  let editorRequestCounter = 0;
  const pendingEditorRequests = new Map();
  const nativeImageOpenTargets = new WeakSet();

  interactionTasks?.subscribe?.(() => {
    window.clearTimeout(uiTimer);
    uiTimer = null;
  });

  function projectIdentity() {
    const projectMatch = window.location.pathname.match(/\/project\/([^/?#]+)/i);
    const documentId = projectMatch?.[1] || `${window.location.pathname}${window.location.search}`;
    return `${window.location.origin}:${documentId}`;
  }

  function projectStateKey() {
    return `${PROJECT_STATE_PREFIX}${projectIdentity()}`;
  }

  function randomId(prefix = "id") {
    return (
      globalThis.crypto?.randomUUID?.() ||
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  }

  function normalizeLink(value) {
    if (!value || typeof value !== "object") return null;
    const nextcloudPath = nextcloud.normalizePath(value.nextcloudPath);
    const targetName = String(value.targetName || value.targetPath || "")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      .trim();
    if (!nextcloudPath || !targetName) return null;
    return {
      id: String(value.id || randomId("link")),
      targetPath: String(value.targetPath || targetName),
      targetName,
      nextcloudPath,
      nextcloudFileId: String(value.nextcloudFileId || ""),
      etag: String(value.etag || ""),
      size: Number(value.size) || 0,
      lastModified: String(value.lastModified || ""),
      syncedAt: String(value.syncedAt || ""),
      pendingUpload: Boolean(value.pendingUpload)
    };
  }

  function normalizeState(value) {
    const state = value && typeof value === "object" ? value : {};
    return {
      version: 1,
      connectionId: String(state.connectionId || ""),
      autoUpdate: Boolean(state.autoUpdate),
      lastDirectory: nextcloud.normalizePath(state.lastDirectory || ""),
      links: (Array.isArray(state.links) ? state.links : [])
        .map(normalizeLink)
        .filter(Boolean),
      updatedAt: String(state.updatedAt || "")
    };
  }

  async function loadProjectState() {
    const stored = (await extensionApi.storage.local.get(projectStateKey()))
      ?.[projectStateKey()];
    projectState = normalizeState(stored);
    if (projectState.connectionId) {
      const connection = await nextcloud.getConnection(projectState.connectionId);
      if (!connection) {
        projectState.connectionId = "";
        projectState.autoUpdate = false;
        projectState.links = [];
        await saveProjectState();
      } else {
        activeConnectionCache = connection;
      }
    }
    return projectState;
  }

  function saveProjectState() {
    projectState = normalizeState(projectState);
    projectState.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(projectState);
    stateWriteQueue = stateWriteQueue
      .catch(() => {})
      .then(() => extensionApi.storage.local.set({
        [projectStateKey()]: snapshot
      }));
    return stateWriteQueue;
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

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function waitForCondition(check, timeoutMs = 8000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await delay(intervalMs);
    }
    return null;
  }

  function showToast(message, isError = false) {
    let toast = document.querySelector("#smarttex-cloud-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "smarttex-cloud-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(toast);
    }
    window.clearTimeout(toastTimer);
    toast.textContent = String(message || "");
    toast.classList.toggle("smarttex-cloud-toast-error", Boolean(isError));
    toast.classList.add("smarttex-cloud-toast-visible");
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("smarttex-cloud-toast-visible");
    }, isError ? 12000 : 7000);
  }

  function createDialog({ title, message = "", className = "" }) {
    const overlay = document.createElement("div");
    overlay.className = "smarttex-dialog-overlay";
    overlay.innerHTML = `
      <section class="smarttex-dialog-card ${className}" role="dialog" aria-modal="true">
        <header class="smarttex-dialog-header">
          <h2></h2>
          <button type="button" class="smarttex-dialog-close" aria-label="Close">&times;</button>
        </header>
        <div class="smarttex-dialog-message"></div>
        <div class="smarttex-dialog-body"></div>
        <footer class="smarttex-dialog-actions"></footer>
      </section>`;
    overlay.querySelector("h2").textContent = title;
    const messageNode = overlay.querySelector(".smarttex-dialog-message");
    messageNode.textContent = message;
    messageNode.hidden = !message;
    document.documentElement.appendChild(overlay);

    let closed = false;
    let busy = false;
    const close = (value = null) => {
      if (closed || busy) return;
      closed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolvePromise(value);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || closed || busy) return;
      event.preventDefault();
      event.stopPropagation();
      close(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    overlay.querySelector(".smarttex-dialog-close").addEventListener("click", () => close(null));
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) close(null);
    });

    let resolvePromise;
    const result = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    window.setTimeout(() => {
      overlay.querySelector("button, input, select")?.focus();
    }, 0);
    return {
      overlay,
      card: overlay.querySelector(".smarttex-dialog-card"),
      body: overlay.querySelector(".smarttex-dialog-body"),
      actions: overlay.querySelector(".smarttex-dialog-actions"),
      message: messageNode,
      result,
      close,
      setBusy(value) {
        busy = Boolean(value);
        overlay.classList.toggle("smarttex-dialog-busy", busy);
        overlay.querySelectorAll("button, input, select").forEach((control) => {
          if (!control.classList.contains("smarttex-dialog-keep-enabled")) {
            control.disabled = busy;
          }
        });
      }
    };
  }

  function actionButton(label, {
    primary = false,
    danger = false,
    onClick = null
  } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.classList.toggle("smarttex-dialog-primary", primary);
    button.classList.toggle("smarttex-dialog-danger", danger);
    if (onClick) button.addEventListener("click", onClick);
    return button;
  }

  async function confirmAction({ title, message, confirmLabel, danger = false }) {
    const dialog = createDialog({ title, message, className: "smarttex-confirm-dialog" });
    dialog.actions.append(
      actionButton("Cancel", { onClick: () => dialog.close(false) }),
      actionButton(confirmLabel, {
        primary: !danger,
        danger,
        onClick: () => dialog.close(true)
      })
    );
    return Boolean(await dialog.result);
  }

  async function currentConnection() {
    if (!projectState?.connectionId) return null;
    if (activeConnectionCache?.id === projectState.connectionId) {
      return activeConnectionCache;
    }
    activeConnectionCache = await nextcloud.getConnection(projectState.connectionId);
    return activeConnectionCache;
  }

  function connectionLabel(connection) {
    return `${connection.server} — ${connection.loginName}`;
  }

  async function openCloudSettings() {
    if (!projectState) await loadProjectState();
    let connections = await nextcloud.listConnections();
    let selectedId = projectState.connectionId;
    const dialog = createDialog({
      title: "Nextcloud project files",
      message: "Choose the Nextcloud connection used only for this CollabTeX document, or connect another account."
    });
    dialog.card.classList.add("smarttex-cloud-settings-dialog");
    dialog.body.innerHTML = `
      <section class="smarttex-connection-section">
        <h3>Available connections</h3>
        <div class="smarttex-connection-list"></div>
      </section>
      <section class="smarttex-new-connection">
        <h3>Connect another Nextcloud</h3>
        <div class="smarttex-inline-form">
          <input type="url" class="smarttex-nextcloud-server" placeholder="https://cloud.example.org" aria-label="Nextcloud URL">
          <button type="button" class="smarttex-nextcloud-connect">Sign in</button>
        </div>
        <div class="smarttex-nextcloud-status" role="status"></div>
      </section>
      <label class="smarttex-check-row">
        <input type="checkbox" class="smarttex-auto-update">
        <span><strong>Automatically update linked files</strong><small>Check Nextcloud every minute and replace changed CollabTeX files.</small></span>
      </label>`;
    const list = dialog.body.querySelector(".smarttex-connection-list");
    const status = dialog.body.querySelector(".smarttex-nextcloud-status");
    const autoUpdate = dialog.body.querySelector(".smarttex-auto-update");
    autoUpdate.checked = projectState.autoUpdate;

    const setStatus = (message, state = "") => {
      status.textContent = String(message || "");
      status.dataset.state = state;
    };
    const renderConnections = () => {
      list.replaceChildren();
      if (!connections.length) {
        const empty = document.createElement("p");
        empty.className = "smarttex-connection-empty";
        empty.textContent = "No saved Nextcloud connections yet.";
        list.appendChild(empty);
        return;
      }
      for (const connection of connections) {
        const label = document.createElement("label");
        label.className = "smarttex-connection-choice";
        label.innerHTML = `
          <input type="radio" name="smarttex-nextcloud-connection">
          <span><strong></strong><small></small></span>`;
        const radio = label.querySelector("input");
        radio.value = connection.id;
        radio.checked = connection.id === selectedId;
        label.querySelector("strong").textContent = connection.server;
        label.querySelector("small").textContent = connection.loginName;
        radio.addEventListener("change", () => {
          selectedId = radio.value;
          setStatus("");
        });
        list.appendChild(label);
      }
    };
    renderConnections();

    const connectButton = dialog.body.querySelector(".smarttex-nextcloud-connect");
    connectButton.addEventListener(
      "click",
      async () => {
        const serverInput = dialog.body.querySelector(".smarttex-nextcloud-server");
        const server = serverInput.value;
        if (!server.trim()) {
          setStatus("Enter a Nextcloud URL first.", "error");
          return;
        }
        connectButton.disabled = true;
        serverInput.disabled = true;
        try {
          const connection = await nextcloud.connect(server, (message) => {
            setStatus(message, "working");
          });
          connections = await nextcloud.listConnections();
          selectedId = connection.id;
          if (dialog.overlay.isConnected) {
            renderConnections();
            setStatus(`Connected to ${connectionLabel(connection)}.`, "success");
          }
        } catch (error) {
          if (dialog.overlay.isConnected) {
            setStatus(error?.message || String(error), "error");
          }
        } finally {
          if (dialog.overlay.isConnected) {
            connectButton.disabled = false;
            serverInput.disabled = false;
          }
        }
      }
    );

    const disconnect = actionButton("Disconnect document", {
      danger: true,
      onClick: async () => {
        if (projectState.links.length) {
          const confirmed = await confirmAction({
            title: "Disconnect Nextcloud from this document?",
            message: (
              "This breaks the Nextcloud connection for every linked project file. " +
              "The files remain in CollabTeX and will be treated as normal files from then on. This cannot be undone automatically."
            ),
            confirmLabel: "Disconnect and keep files",
            danger: true
          });
          if (!confirmed) return;
        }
        projectState.connectionId = "";
        projectState.autoUpdate = false;
        projectState.links = [];
        activeConnectionCache = null;
        await saveProjectState();
        dialog.close(true);
        scheduleUiRefresh();
        showToast("Nextcloud disconnected. Previously linked files are now normal CollabTeX files.");
      }
    });
    disconnect.hidden = !projectState.connectionId;

    const save = actionButton("Use selected connection", {
      primary: true,
      onClick: async () => {
        if (!selectedId) {
          setStatus("Select or create a Nextcloud connection first.", "error");
          return;
        }
        const connection = connections.find((candidate) => candidate.id === selectedId)
          || await nextcloud.getConnection(selectedId);
        if (!connection) {
          setStatus("The selected Nextcloud connection is no longer available.", "error");
          return;
        }
        const changing = Boolean(
          projectState.connectionId &&
          projectState.connectionId !== selectedId
        );
        if (changing && projectState.links.length) {
          const confirmed = await confirmAction({
            title: "Change this document’s Nextcloud connection?",
            message: (
              "Changing the connection breaks the Nextcloud link for every previously linked file. " +
              "Those files remain in CollabTeX and will be treated as normal files from then on."
            ),
            confirmLabel: "Change connection",
            danger: true
          });
          if (!confirmed) return;
        }
        dialog.setBusy(true);
        try {
          await nextcloud.ensureOriginPermission(connection.server);
          const connected = await nextcloud.checkConnection(connection);
          if (!connected) {
            throw new Error("The selected Nextcloud connection could not be verified.");
          }
          if (changing) projectState.links = [];
          projectState.connectionId = selectedId;
          projectState.autoUpdate = autoUpdate.checked;
          activeConnectionCache = connection;
          await nextcloud.markConnectionUsed(selectedId);
          await saveProjectState();
          dialog.setBusy(false);
          dialog.close(true);
          scheduleUiRefresh();
          showToast(`This document now uses ${connection.server}.`);
        } catch (error) {
          setStatus(error?.message || String(error), "error");
          dialog.setBusy(false);
        }
      }
    });
    dialog.actions.append(
      disconnect,
      actionButton("Cancel", { onClick: () => dialog.close(false) }),
      save
    );
    return dialog.result;
  }

  async function ensureConnection({ prompt = true } = {}) {
    if (!projectState) await loadProjectState();
    let connection = await currentConnection();
    if (connection) {
      const connected = await nextcloud.checkConnection(connection).catch(() => false);
      if (connected) return connection;
    }
    if (!prompt) return null;
    await openCloudSettings();
    connection = await currentConnection();
    if (!connection) return null;
    return (await nextcloud.checkConnection(connection).catch(() => false))
      ? connection
      : null;
  }

  function attachCloudButton() {
    if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;
    const toolbarSlot = document.querySelector("#smarttex-toolbar-slot");
    if (!toolbarSlot) return;
    let button = toolbarSlot.querySelector("#smarttex-cloud-button");
    if (!button) {
      button = document.createElement("button");
      button.id = "smarttex-cloud-button";
      button.type = "button";
      button.className = "smarttex-cloud-toolbar-button";
      button.innerHTML = `
        <svg viewBox="0 0 24 18" aria-hidden="true">
          <path d="M5.2 15.5h12.6a4.2 4.2 0 0 0 .5-8.4A6.6 6.6 0 0 0 5.7 8.8a3.4 3.4 0 0 0-.5 6.7Z"/>
        </svg>`;
      button.setAttribute("aria-label", "Configure Nextcloud project files");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCloudSettings().catch((error) => {
          showToast(error?.message || String(error), true);
        });
      });
      toolbarSlot.insertBefore(
        button,
        toolbarSlot.querySelector("#smarttex-options-button")
      );
    }
    const connected = Boolean(projectState?.connectionId);
    button.classList.toggle("smarttex-cloud-connected", connected);
    button.setAttribute("aria-pressed", connected ? "true" : "false");
    currentConnection().then((connection) => {
      button.title = connection
        ? `Nextcloud for this document: ${connection.server}`
        : "Connect this document to Nextcloud";
    }).catch(() => {});
  }

  function formatFileSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} kB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  }

  async function showNextcloudFilePicker(connection, { multiple = true } = {}) {
    const selected = new Map();
    let currentPath = projectState.lastDirectory || "";
    let entries = [];
    let loading = false;
    let searchQuery = "";
    let searchTimer = null;
    const dialog = createDialog({
      title: "Select files from Nextcloud",
      message: "Browse your Nextcloud files. Selected files are downloaded and passed to CollabTeX’s native upload process.",
      className: "smarttex-nextcloud-picker-dialog"
    });
    dialog.body.innerHTML = `
      <div class="smarttex-nextcloud-picker">
        <div class="smarttex-picker-toolbar">
          <button type="button" class="smarttex-picker-up" title="Parent directory" aria-label="Parent directory">&uarr;</button>
          <div class="smarttex-picker-breadcrumb"></div>
          <input type="search" class="smarttex-picker-search" placeholder="Filter this directory">
        </div>
        <div class="smarttex-picker-list" role="listbox"></div>
        <div class="smarttex-picker-status"></div>
      </div>`;
    const list = dialog.body.querySelector(".smarttex-picker-list");
    const breadcrumb = dialog.body.querySelector(".smarttex-picker-breadcrumb");
    const search = dialog.body.querySelector(".smarttex-picker-search");
    const status = dialog.body.querySelector(".smarttex-picker-status");
    const addButton = actionButton("Add selected", {
      primary: true,
      onClick: () => dialog.close([...selected.values()])
    });
    addButton.disabled = true;
    dialog.actions.append(
      actionButton("Cancel", { onClick: () => dialog.close(null) }),
      addButton
    );

    const updateStatus = (error = "") => {
      status.textContent = loading
        ? "Loading Nextcloud directory…"
        : error || `${selected.size} file${selected.size === 1 ? "" : "s"} selected`;
      status.classList.toggle("smarttex-picker-status-error", Boolean(error));
      addButton.disabled = loading || selected.size === 0;
    };
    const renderBreadcrumb = () => {
      breadcrumb.replaceChildren();
      const root = document.createElement("button");
      root.type = "button";
      root.textContent = "Nextcloud";
      root.addEventListener("click", () => loadDirectory(""));
      breadcrumb.appendChild(root);
      let accumulated = "";
      for (const part of currentPath.split("/").filter(Boolean)) {
        breadcrumb.append(" / ");
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        const path = accumulated;
        const segment = document.createElement("button");
        segment.type = "button";
        segment.textContent = part;
        segment.addEventListener("click", () => loadDirectory(path));
        breadcrumb.appendChild(segment);
      }
    };
    const renderEntries = () => {
      const filter = searchQuery.trim().toLocaleLowerCase();
      const visibleEntries = entries.filter((entry) => (
        !filter || entry.name.toLocaleLowerCase().includes(filter)
      ));
      list.replaceChildren();
      if (!visibleEntries.length && !loading) {
        const empty = document.createElement("div");
        empty.className = "smarttex-picker-empty";
        empty.textContent = filter
          ? "No matching files in this directory."
          : "This directory is empty.";
        list.appendChild(empty);
      }
      for (const entry of visibleEntries) {
        const row = document.createElement("div");
        row.className = "smarttex-picker-row";
        const selection = document.createElement("input");
        selection.type = multiple ? "checkbox" : "radio";
        selection.name = multiple ? "" : "smarttex-nextcloud-file";
        selection.disabled = entry.isDirectory;
        selection.checked = selected.has(entry.path);
        selection.setAttribute("aria-label", `Select ${entry.name}`);
        selection.addEventListener("change", () => {
          if (!multiple) selected.clear();
          if (selection.checked) selected.set(entry.path, entry);
          else selected.delete(entry.path);
          if (!multiple) renderEntries();
          updateStatus();
        });
        const icon = document.createElement("span");
        icon.className = "smarttex-picker-icon";
        icon.textContent = entry.isDirectory ? "📁" : "📄";
        const name = document.createElement("button");
        name.type = "button";
        name.className = "smarttex-picker-name";
        name.textContent = entry.name;
        const selectOrOpen = () => {
          if (entry.isDirectory) {
            loadDirectory(entry.path);
            return;
          }
          if (!multiple) selected.clear();
          if (selected.has(entry.path)) selected.delete(entry.path);
          else selected.set(entry.path, entry);
          renderEntries();
          updateStatus();
        };
        name.addEventListener("click", selectOrOpen);
        row.addEventListener("dblclick", () => {
          if (entry.isDirectory) loadDirectory(entry.path);
        });
        const meta = document.createElement("span");
        meta.className = "smarttex-picker-meta";
        meta.textContent = entry.isDirectory
          ? formatDate(entry.lastModified)
          : [
            formatFileSize(entry.size),
            formatDate(entry.lastModified)
          ].filter(Boolean).join(" · ");
        row.append(selection, icon, name, meta);
        list.appendChild(row);
      }
      updateStatus();
    };
    const loadDirectory = async (path, allowFallback = false) => {
      if (loading) return;
      loading = true;
      currentPath = nextcloud.normalizePath(path);
      renderBreadcrumb();
      renderEntries();
      try {
        entries = await nextcloud.listDirectory(connection, currentPath);
        projectState.lastDirectory = currentPath;
        await saveProjectState();
        updateStatus();
      } catch (error) {
        if (allowFallback && currentPath) {
          loading = false;
          currentPath = "";
          await loadDirectory("", false);
          return;
        }
        entries = [];
        updateStatus(error?.message || String(error));
      } finally {
        loading = false;
        renderEntries();
      }
    };
    dialog.body.querySelector(".smarttex-picker-up").addEventListener("click", () => {
      const parts = currentPath.split("/").filter(Boolean);
      parts.pop();
      loadDirectory(parts.join("/"));
    });
    search.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchQuery = search.value || "";
        renderEntries();
      }, SEARCH_DELAY_MS);
    });
    window.setTimeout(() => loadDirectory(currentPath, true), 0);
    const result = await dialog.result;
    window.clearTimeout(searchTimer);
    return Array.isArray(result) ? result : null;
  }

  function findNativeUploadDialogs() {
    const result = new Map();
    for (const input of document.querySelectorAll('input[type="file"]')) {
      if (input.closest(".smarttex-dialog-overlay, .smarttex-nextcloud-upload-source")) {
        continue;
      }
      const dialog = input.closest(
        '[role="dialog"], .modal, .modal-dialog, .modal-content'
      ) || input.parentElement;
      if (!dialog || dialog.closest(".smarttex-dialog-overlay")) continue;
      if (!isVisible(dialog) && !isVisible(input)) continue;
      const text = [
        dialog.textContent,
        input.getAttribute("aria-label"),
        input.getAttribute("title")
      ].filter(Boolean).join(" ");
      if (!/upload|drop|browse|choose|select files?|hochladen|datei/i.test(text)) continue;
      result.set(dialog, input);
    }
    return [...result.entries()];
  }

  async function closeNativeUploadDialog(dialog) {
    if (!dialog) return;
    const direct = dialog.querySelector(
      '[data-bs-dismiss="modal"], [data-dismiss="modal"], .modal-header .btn-close, ' +
      '.modal-header .close, button[aria-label*="close" i], button[title*="close" i], ' +
      'button[aria-label*="schließ" i], button[title*="schließ" i]'
    );
    const close = direct || [...dialog.querySelectorAll("button")].find((candidate) => {
      const label = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      return /^(close|cancel|dismiss|×|x|schließen|abbrechen)/i.test(label);
    });
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true
    }));
    await waitForCondition(
      () => !dialog.isConnected || !isVisible(dialog),
      1800,
      60
    );
  }

  function findNativeUploadButton() {
    return [...document.querySelectorAll(
      ".toolbar-filetree button, .file-tree-toolbar-action-buttons button, " +
      ".file-tree-toolbar button, button"
    )].find((button) => {
      if (!isVisible(button) || button.closest(".smarttex-dialog-overlay")) return false;
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.textContent
      ].filter(Boolean).join(" ");
      return /upload( files?)?|datei(en)? hochladen/i.test(label);
    }) || null;
  }

  async function openNativeUploadInput() {
    const button = findNativeUploadButton();
    if (!button) {
      throw new Error("The CollabTeX file-upload button could not be found.");
    }
    button.click();
    const input = await waitForCondition(
      () => findNativeUploadDialogs().map((entry) => entry[1]).find(Boolean),
      8000,
      100
    );
    if (!input) {
      throw new Error("The CollabTeX upload dialog did not expose a file input.");
    }
    return input;
  }

  async function importFiles(input, entries, connection) {
    if (!input || !entries.length) return;
    showToast(
      `Downloading ${entries.length} file${entries.length === 1 ? "" : "s"} from Nextcloud…`
    );
    const files = [];
    const links = [];
    for (const entry of entries) {
      const downloaded = await nextcloud.downloadFile(connection, entry.path);
      const info = { ...entry, ...(downloaded.info || {}) };
      const file = new File([downloaded.blob], entry.name, {
        type: info.contentType || downloaded.blob.type || "application/octet-stream",
        lastModified: info.lastModified
          ? (new Date(info.lastModified).getTime() || Date.now())
          : Date.now()
      });
      files.push(file);
      links.push(normalizeLink({
        targetPath: entry.name,
        targetName: entry.name,
        nextcloudPath: entry.path,
        nextcloudFileId: info.fileId,
        etag: info.etag,
        size: info.size || file.size,
        lastModified: info.lastModified,
        syncedAt: new Date().toISOString(),
        pendingUpload: true
      }));
    }
    if (!input.multiple && files.length > 1) {
      files.splice(1);
      links.splice(1);
    }
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    for (const link of links) {
      const index = projectState.links.findIndex((candidate) => (
        candidate.targetName.toLowerCase() === link.targetName.toLowerCase()
      ));
      if (index >= 0) {
        projectState.links[index] = { ...projectState.links[index], ...link };
      } else {
        projectState.links.push(link);
      }
    }
    await saveProjectState();
    window.setTimeout(async () => {
      let changed = false;
      for (const link of projectState.links) {
        if (!link.pendingUpload) continue;
        const item = findTreeItem(link);
        if (!item) continue;
        link.targetPath = treeItemName(item) || link.targetName;
        link.pendingUpload = false;
        changed = true;
      }
      if (changed) await saveProjectState();
      scheduleUiRefresh();
    }, 2500);
    showToast(
      `${files.length} Nextcloud file${files.length === 1 ? "" : "s"} handed to CollabTeX for upload.`
    );
  }

  function injectNextcloudIntoUploadDialogs() {
    for (const [dialog, input] of findNativeUploadDialogs()) {
      if (dialog.querySelector(".smarttex-nextcloud-upload-source")) continue;
      const source = document.createElement("div");
      source.className = "smarttex-nextcloud-upload-source";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "smarttex-nextcloud-upload-source-button";
      button.innerHTML = `
        <svg viewBox="0 0 24 18" aria-hidden="true"><path d="M5.2 15.5h12.6a4.2 4.2 0 0 0 .5-8.4A6.6 6.6 0 0 0 5.7 8.8a3.4 3.4 0 0 0-.5 6.7Z"/></svg>
        <span><strong>From Nextcloud</strong><small>Select files from this document’s Nextcloud connection</small></span>`;
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        try {
          const multiple = input.multiple !== false;
          await closeNativeUploadDialog(dialog);
          const connection = await ensureConnection();
          if (!connection) return;
          const selected = await showNextcloudFilePicker(connection, { multiple });
          if (!selected?.length) return;
          const freshInput = await openNativeUploadInput();
          await importFiles(freshInput, selected, connection);
        } catch (error) {
          showToast(error?.message || String(error), true);
        } finally {
          button.disabled = false;
        }
      });
      source.appendChild(button);
      const anchor = input.closest(".form-group, .upload-area, .dropzone") || input;
      anchor.parentElement?.insertBefore(source, anchor.nextSibling);
    }
  }

  function editorBridgeRequest(type, payload = {}, timeoutMs = 3000) {
    const requestId = `project-files-${Date.now()}-${++editorRequestCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingEditorRequests.delete(requestId);
        reject(new Error(`SmartTeX editor request timed out: ${type}`));
      }, timeoutMs);
      pendingEditorRequests.set(requestId, { resolve, reject, timeout });
      window.dispatchEvent(new CustomEvent(EDITOR_REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, type, ...payload })
      }));
    });
  }

  function normalizeFigureStem(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\.(?:png|jpe?g|gif|webp|svg|pdf|eps|bmp|tiff?)$/i, "")
      .toLowerCase();
  }

  function includegraphicsOccurrences(sourceValue) {
    const source = String(sourceValue || "");
    const results = [];
    const expression = /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g;
    let match;
    while ((match = expression.exec(source))) {
      const lineStart = source.lastIndexOf("\n", match.index - 1) + 1;
      const prefix = source.slice(lineStart, match.index);
      let commented = false;
      for (let index = 0; index < prefix.length; index += 1) {
        if (prefix[index] !== "%") continue;
        let escapes = 0;
        for (let cursor = index - 1; cursor >= 0 && prefix[cursor] === "\\"; cursor -= 1) {
          escapes += 1;
        }
        if (escapes % 2 === 0) {
          commented = true;
          break;
        }
      }
      if (commented) continue;
      results.push({
        path: String(match[1] || "").trim(),
        index: match.index,
        end: expression.lastIndex
      });
    }
    return results;
  }

  function figureOccurrenceForTreeItem(item) {
    const state = currentEditorState;
    if (!state?.value) return null;
    const itemPath = treeItemName(item).replace(/\\/g, "/").replace(/^\/+/, "");
    const itemStem = normalizeFigureStem(itemPath);
    const itemBaseStem = itemStem.split("/").pop();
    if (!itemStem || !itemBaseStem) return null;
    const occurrences = includegraphicsOccurrences(state.value);
    return occurrences.find((occurrence) => {
      const occurrenceStem = normalizeFigureStem(occurrence.path);
      const occurrenceBaseStem = occurrenceStem.split("/").pop();
      return (
        occurrenceStem === itemStem ||
        occurrenceStem.endsWith(`/${itemStem}`) ||
        itemStem.endsWith(`/${occurrenceStem}`) ||
        occurrenceBaseStem === itemBaseStem
      );
    }) || null;
  }

  function figureIconAnchor(item) {
    return item.querySelector(
      ".item-type-icon, .file-tree-icon, .entity-icon, [data-testid*='file-icon'], " +
      "[class*='file-icon'], [class*='entity-icon']"
    ) || item.querySelector("svg, img")?.parentElement || null;
  }

  function decorateIncludedFigures() {
    for (const item of treeItems()) {
      const fileName = treeItemBaseName(item);
      const isFigure = FIGURE_FILE_RE.test(fileName);
      const occurrence = isFigure ? figureOccurrenceForTreeItem(item) : null;
      item.classList.toggle("smarttex-figure-tree-item", isFigure);
      item.classList.toggle("smarttex-figure-included", Boolean(occurrence));
      if (occurrence) item.dataset.smarttexFigureIncludeIndex = String(occurrence.index);
      else delete item.dataset.smarttexFigureIncludeIndex;

      let badge = item.querySelector(".smarttex-figure-included-badge");
      if (!occurrence) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "smarttex-figure-included-badge";
        badge.setAttribute("aria-hidden", "true");
        badge.textContent = "✓";
        let icon = figureIconAnchor(item);
        if (icon instanceof SVGElement) icon = icon.parentElement;
        if (icon) {
          icon.classList.add("smarttex-figure-icon-anchor");
          icon.appendChild(badge);
        } else {
          item.appendChild(badge);
        }
      }
    }
  }

  function treeItemFromImageEvent(event) {
    const item = event.target?.closest?.('.file-tree-list [role="treeitem"]');
    if (!item || !FIGURE_FILE_RE.test(treeItemBaseName(item))) return null;
    return item;
  }

  function nativeImageOpenControl(item, eventTarget) {
    return eventTarget?.closest?.("button, a, [role='button']") || item.querySelector(
      ".item-name-button, button, a, [role='button']"
    ) || item;
  }

  async function jumpToIncludedFigure(item) {
    const occurrence = figureOccurrenceForTreeItem(item);
    if (!occurrence || !currentEditorState) return false;
    const cursorIndex = Math.max(0, Number(currentEditorState.cursorIndex) || 0);
    const anchor = Math.max(
      0,
      Number(currentEditorState.selectionAnchor ?? currentEditorState.selectionFrom ?? cursorIndex) || 0
    );
    const head = Math.max(
      0,
      Number(currentEditorState.selectionHead ?? currentEditorState.selectionTo ?? cursorIndex) || 0
    );
    if (cursorIndex !== occurrence.index) {
      window.dispatchEvent(new CustomEvent(NAVIGATION_PUSH_EVENT, {
        detail: JSON.stringify({
          fileName: String(currentEditorState.fileName || ""),
          cursorIndex,
          anchor,
          head
        })
      }));
    }
    const response = await editorBridgeRequest("setSelection", {
      anchor: occurrence.index,
      head: occurrence.index,
      focus: true
    });
    return Boolean(response?.ok);
  }

  function bindFigureTreeInteractions() {
    if (document.documentElement.dataset.smarttexFigureTreeBound === "true") return;
    document.documentElement.dataset.smarttexFigureTreeBound = "true";

    document.addEventListener("click", (event) => {
      const item = treeItemFromImageEvent(event);
      if (!item) return;
      const control = nativeImageOpenControl(item, event.target);
      if (nativeImageOpenTargets.has(control)) {
        nativeImageOpenTargets.delete(control);
        return;
      }
      // A single click on a figure file is reserved for source navigation. It
      // must not trigger CollabTeX's normal image-open action.
      event.preventDefault();
      event.stopImmediatePropagation();
      const occurrence = figureOccurrenceForTreeItem(item);
      if (!occurrence) return;
      jumpToIncludedFigure(item).catch((error) => {
        console.warn("[SmartTeX] Could not jump to included figure:", error);
      });
    }, true);

    document.addEventListener("dblclick", (event) => {
      const item = treeItemFromImageEvent(event);
      if (!item) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const control = nativeImageOpenControl(item, event.target);
      nativeImageOpenTargets.add(control);
      control.click();
    }, true);
  }

  function treeItems() {
    return [...document.querySelectorAll('.file-tree-list [role="treeitem"]')];
  }

  function treeItemName(item) {
    return String(
      item?.getAttribute("data-path") ||
      item?.getAttribute("data-file-path") ||
      item?.getAttribute("aria-label") ||
      item?.querySelector(
        ".item-name-button span, .item-name span, .entity-name span"
      )?.textContent ||
      ""
    ).trim();
  }

  function treeItemBaseName(item) {
    return treeItemName(item).replace(/\\/g, "/").split("/").pop();
  }

  function findTreeItem(linkOrName) {
    const targetPath = typeof linkOrName === "string"
      ? linkOrName
      : linkOrName?.targetPath;
    const targetName = (
      typeof linkOrName === "string"
        ? linkOrName
        : linkOrName?.targetName
    ) || String(targetPath || "").split("/").pop();
    const normalizedPath = String(targetPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .toLowerCase();
    return treeItems().find((item) => {
      const itemPath = treeItemName(item)
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .toLowerCase();
      return (
        (normalizedPath && itemPath === normalizedPath) ||
        treeItemBaseName(item).toLowerCase() === String(targetName || "").toLowerCase()
      );
    }) || null;
  }

  function linkForTreeItem(item) {
    const itemPath = treeItemName(item)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .toLowerCase();
    const itemName = treeItemBaseName(item).toLowerCase();
    return projectState.links.find((link) => {
      const targetPath = String(link.targetPath || "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .toLowerCase();
      return (
        (targetPath && targetPath === itemPath) ||
        link.targetName.toLowerCase() === itemName
      );
    }) || null;
  }

  function clearLinkedNameClasses(item) {
    item.querySelectorAll(
      ".smarttex-linked-name-region, .smarttex-linked-name-control, .smarttex-linked-name-text"
    ).forEach((element) => {
      element.classList.remove(
        "smarttex-linked-name-region",
        "smarttex-linked-name-control",
        "smarttex-linked-name-text"
      );
    });
  }

  function decorateTreeItemName(item, link) {
    clearLinkedNameClasses(item);
    const expectedName = String(link?.targetName || treeItemBaseName(item)).trim();
    if (!expectedName) return;
    const candidates = [...item.querySelectorAll(
      ".item-name-button span, .item-name, .entity-name span, " +
      "[data-testid*='file-name'], [data-testid*='entity-name']"
    )].filter((element) => String(element.textContent || "").trim() === expectedName);
    const text = candidates.sort(
      (left, right) => left.childElementCount - right.childElementCount
    )[0];
    if (!text) return;
    text.classList.add("smarttex-linked-name-text");
    text.title = expectedName;
    const control = text.closest(".item-name-button, button")
      || text.closest(".item-name, [data-testid*='file-name'], [data-testid*='entity-name']");
    control?.classList.add("smarttex-linked-name-control");
    text.closest(".entity-name")?.classList.add("smarttex-linked-name-region");
  }

  function refreshIconMarkup() {
    return `
      <svg viewBox="0 0 32 20" aria-hidden="true">
        <path class="smarttex-refresh-cloud" d="M2.5 14.5h11.2a3.3 3.3 0 0 0 .5-6.6A5.2 5.2 0 0 0 4.3 9.2a2.8 2.8 0 0 0-1.8 5.3Z"/>
        <path class="smarttex-refresh-arrow" d="M27.5 8.2A6 6 0 1 0 29 14M27.5 4.7v3.5H24"/>
      </svg>`;
  }

  function injectLinkedFileButtons() {
    for (const item of treeItems()) {
      const link = linkForTreeItem(item);
      const existing = item.querySelector(".smarttex-nextcloud-file-refresh");
      if (!link) {
        existing?.remove();
        item.classList.remove("smarttex-nextcloud-linked-tree-item");
        clearLinkedNameClasses(item);
        continue;
      }
      item.classList.add("smarttex-nextcloud-linked-tree-item");
      decorateTreeItemName(item, link);
      if (existing) {
        existing.dataset.linkId = link.id;
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "smarttex-nextcloud-file-refresh";
      button.dataset.linkId = link.id;
      button.innerHTML = refreshIconMarkup();
      button.title = `Update ${link.targetName} from Nextcloud`;
      button.setAttribute("aria-label", `Update ${link.targetName} from Nextcloud`);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshSingleFile(link.id).catch((error) => {
          showToast(error?.message || String(error), true);
        });
      });
      item.appendChild(button);
    }
  }

  function findFileToolbar() {
    if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return null;
    // Prefer the SmartTeX top-toolbar slot so the Nextcloud action is placed
    // immediately to the right of the [S] menu button. Fall back to the file
    // toolbar while the top toolbar is still being initialized.
    return document.querySelector("#smarttex-toolbar-slot") || document.querySelector(
      ".toolbar-filetree, .file-tree-toolbar-action-buttons, .file-tree-toolbar"
    );
  }

  function injectUpdateAllButton() {
    const toolbar = findFileToolbar();
    if (!toolbar) return;
    let button = document.querySelector(".smarttex-nextcloud-update-all");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "smarttex-nextcloud-update-all";
      button.innerHTML = refreshIconMarkup();
      button.title = "Update all linked files from Nextcloud";
      button.setAttribute("aria-label", "Update all linked files from Nextcloud");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        updateAllFiles().catch((error) => {
          showToast(error?.message || String(error), true);
        });
      });
    }

    // Keep the Nextcloud action immediately after the combined SmartTeX
    // [S] + hamburger button. Both modules observe toolbar changes, so using
    // appendChild alone could make their order alternate during reattachment.
    const smartTeXMenuButton = toolbar.querySelector("#smarttex-options-button");
    const desiredNextSibling = smartTeXMenuButton?.nextSibling || null;
    if (smartTeXMenuButton) {
      if (
        button.parentElement !== toolbar ||
        smartTeXMenuButton.nextElementSibling !== button
      ) {
        toolbar.insertBefore(button, desiredNextSibling);
      }
    } else if (button.parentElement !== toolbar) {
      toolbar.appendChild(button);
    }
    button.hidden = projectState.links.length === 0;
    button.disabled = updateInProgress;
  }

  async function acceptOverwritePrompt(fileName) {
    const startedAt = Date.now();
    const deadline = startedAt + 5000;
    while (Date.now() < deadline) {
      const dialogs = [...document.querySelectorAll(
        '[role="dialog"], .modal, .modal-dialog, .modal-content'
      )].filter((dialog) => (
        !dialog.closest(".smarttex-dialog-overlay") &&
        isVisible(dialog)
      ));
      for (const dialog of dialogs) {
        const text = dialog.textContent || "";
        if (!/exist|already|replace|overwrite|conflict|besteh|ersetzen|überschreiben/i.test(text)) {
          continue;
        }
        if (
          fileName &&
          !text.toLowerCase().includes(fileName.toLowerCase()) &&
          dialogs.length > 1
        ) {
          continue;
        }
        const button = [...dialog.querySelectorAll("button")].find((candidate) => (
          /^(replace|overwrite|upload|ersetzen|überschreiben)$/i.test(
            (candidate.textContent || "").trim()
          )
        ));
        if (button) {
          button.click();
          return true;
        }
      }
      if (Date.now() - startedAt > 900 && findNativeUploadDialogs().length === 0) {
        return false;
      }
      await delay(150);
    }
    return false;
  }

  async function uploadReplacement(link, file) {
    const item = findTreeItem(link);
    const selectable = item?.querySelector(
      ".item-name-button, button, [role='button']"
    ) || item;
    selectable?.click?.();
    await delay(150);
    const input = await openNativeUploadInput();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await acceptOverwritePrompt(link.targetName);
    await delay(800);
  }

  async function refreshSingleFile(linkId, {
    skipConfirmation = false,
    knownInfo = null,
    connection: connectionOverride = null
  } = {}) {
    if (updateInProgress && !skipConfirmation) {
      throw new Error("A Nextcloud file update is already running.");
    }
    const link = projectState.links.find((candidate) => candidate.id === linkId);
    if (!link) throw new Error("The Nextcloud link for this file was not found.");
    const connection = connectionOverride || await ensureConnection();
    if (!connection) throw new Error("Nextcloud is not connected for this document.");
    const info = knownInfo || await nextcloud.getFileInfo(
      connection,
      link.nextcloudPath
    );
    if (info.isDirectory) {
      throw new Error("The linked Nextcloud source is a directory.");
    }
    if (link.etag && info.etag && link.etag === info.etag) {
      if (!skipConfirmation) showToast(`${link.targetName} is already up to date.`);
      return "unchanged";
    }
    if (!skipConfirmation) {
      const confirmed = await confirmAction({
        title: "Update linked file from Nextcloud?",
        message: (
          `Replace ${link.targetName} with the latest Nextcloud version?\n\n` +
          `Source: /${link.nextcloudPath}\n` +
          `Modified: ${formatDate(info.lastModified) || "unknown"}\n` +
          `Size: ${formatFileSize(info.size)}`
        ),
        confirmLabel: "Update file"
      });
      if (!confirmed) return "cancelled";
    }
    const downloaded = await nextcloud.downloadFile(connection, link.nextcloudPath);
    const mergedInfo = { ...info, ...(downloaded.info || {}) };
    const file = new File([downloaded.blob], link.targetName, {
      type: mergedInfo.contentType || downloaded.blob.type || "application/octet-stream",
      lastModified: mergedInfo.lastModified
        ? (new Date(mergedInfo.lastModified).getTime() || Date.now())
        : Date.now()
    });
    await uploadReplacement(link, file);
    Object.assign(link, {
      etag: mergedInfo.etag || info.etag || link.etag,
      nextcloudFileId: mergedInfo.fileId || info.fileId || link.nextcloudFileId,
      size: mergedInfo.size || file.size,
      lastModified: mergedInfo.lastModified || info.lastModified,
      syncedAt: new Date().toISOString(),
      pendingUpload: false
    });
    await saveProjectState();
    scheduleUiRefresh();
    if (!skipConfirmation) showToast(`${link.targetName} was updated from Nextcloud.`);
    return "updated";
  }

  async function updateAllFiles({ automatic = false } = {}) {
    if (updateInProgress || !projectState.links.length) {
      if (!automatic && !projectState.links.length) {
        showToast("This project has no files linked to Nextcloud.");
      }
      return;
    }
    if (automatic && findNativeUploadDialogs().length) return;
    const connection = await ensureConnection({ prompt: !automatic });
    if (!connection) {
      if (!automatic) throw new Error("Nextcloud is not connected for this document.");
      return;
    }
    updateInProgress = true;
    injectUpdateAllButton();
    const changed = [];
    let unavailable = 0;
    try {
      if (!automatic) {
        showToast(
          `Checking ${projectState.links.length} linked file${projectState.links.length === 1 ? "" : "s"}…`
        );
      }
      for (const link of projectState.links) {
        try {
          const info = await nextcloud.getFileInfo(connection, link.nextcloudPath);
          if (!link.etag || !info.etag || link.etag !== info.etag) {
            changed.push({ link, info });
          }
        } catch (_error) {
          unavailable += 1;
        }
      }
      if (!changed.length) {
        if (!automatic) {
          showToast(
            unavailable
              ? `All reachable linked files are current; ${unavailable} source${unavailable === 1 ? " is" : "s are"} unavailable.`
              : "All linked Nextcloud files are already current."
          );
        }
        return;
      }
      if (!automatic) {
        const confirmed = await confirmAction({
          title: "Update all linked Nextcloud files?",
          message: (
            `${changed.length} linked file${changed.length === 1 ? " has" : "s have"} changed in Nextcloud. ` +
            `Replace the corresponding CollabTeX files now?` +
            (unavailable
              ? `\n\n${unavailable} source${unavailable === 1 ? " is" : "s are"} unavailable and will be skipped.`
              : "")
          ),
          confirmLabel: `Update ${changed.length} file${changed.length === 1 ? "" : "s"}`
        });
        if (!confirmed) return;
      }
      let updated = 0;
      let failed = 0;
      for (const { link, info } of changed) {
        if (!automatic) {
          showToast(
            `Updating ${link.targetName} from Nextcloud (${updated + failed + 1}/${changed.length})…`
          );
        }
        try {
          const result = await refreshSingleFile(link.id, {
            skipConfirmation: true,
            knownInfo: info,
            connection
          });
          if (result === "updated") updated += 1;
        } catch (error) {
          failed += 1;
          console.warn("[SmartTeX] Could not update a linked Nextcloud file:", {
            file: link.targetName,
            source: link.nextcloudPath,
            error
          });
        }
      }
      if (!automatic || updated || failed) {
        showToast(
          automatic
            ? `Automatic Nextcloud update: ${updated} updated, ${failed + unavailable} unavailable or failed.`
            : `Nextcloud update complete: ${updated} updated, ${failed + unavailable} unavailable or failed.`,
          failed > 0
        );
      }
    } finally {
      updateInProgress = false;
      injectUpdateAllButton();
    }
  }

  function scheduleUiRefresh(delayMs = 80) {
    if (uiTimer) return;
    uiTimer = window.setTimeout(() => {
      uiTimer = null;
      refreshUi();
    }, Math.max(
      Math.max(0, Number(delayMs) || 0),
      Number(interactionTasks?.keyboardIdleRemaining?.()) || 0
    ));
  }

  function refreshUi() {
    if (!projectState) return;
    attachCloudButton();
    injectNextcloudIntoUploadDialogs();
    injectLinkedFileButtons();
    decorateIncludedFigures();
    injectUpdateAllButton();
  }

  function startAutoUpdateTimer() {
    window.clearInterval(autoUpdateTimer);
    autoUpdateTimer = window.setInterval(() => {
      if (!projectState?.autoUpdate || !projectState.links.length) return;
      updateAllFiles({ automatic: true }).catch((error) => {
        console.warn("[SmartTeX] Automatic Nextcloud update failed:", error);
      });
    }, AUTO_UPDATE_INTERVAL_MS);
  }

  async function initialize() {
    await loadProjectState();
    bindFigureTreeInteractions();
    refreshUi();
    uiObserver = new MutationObserver((mutations) => {
      const editorSelector = ".ace_editor, .cm-editor, #ide-redesign-panel-source-editor";
      if (mutations.every((mutation) => (
        mutation.target instanceof Element && mutation.target.closest(editorSelector)
      ))) return;
      scheduleUiRefresh();
    });
    uiObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    startAutoUpdateTimer();
  }

  window.addEventListener(EDITOR_STATE_EVENT, (event) => {
    try {
      currentEditorState = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      currentEditorState = null;
    }
    scheduleUiRefresh(20);
  });

  window.addEventListener(EDITOR_RESPONSE_EVENT, (event) => {
    let response;
    try {
      response = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      return;
    }
    const pending = pendingEditorRequests.get(response.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingEditorRequests.delete(response.requestId);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "SmartTeX editor request failed."));
  });

  extensionApi.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes?.[projectStateKey()]) return;
    projectState = normalizeState(changes[projectStateKey()].newValue);
    if (activeConnectionCache?.id !== projectState.connectionId) {
      activeConnectionCache = null;
    }
    scheduleUiRefresh();
  });

  window.addEventListener("pagehide", () => {
    uiObserver?.disconnect();
    window.clearTimeout(uiTimer);
    window.clearInterval(autoUpdateTimer);
  }, { once: true });

  initialize().catch((error) => {
    console.error("[SmartTeX] Could not initialize Nextcloud project files:", error);
  });
})();
