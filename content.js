/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  function isSmartTeXDocumentPage() {
    // Do not classify a page from /project/<id> alone: CollabTeX uses project
    // URLs for views that do not contain an editor. Require either an actual
    // editing surface or the editor-specific source/PDF shell/format toolbar.
    const sourcePanel = document.querySelector(
      "#ide-redesign-panel-source-editor, #ide-redesign-panel-editor, " +
      "[data-testid='source-editor'], [data-testid*='source-editor' i]"
    );
    const pdfPanel = document.querySelector(
      "#ide-redesign-panel-pdf, [data-testid='pdf-preview'], [data-testid*='pdf-preview' i]"
    );
    const editorSurface = document.querySelector(
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
    );
    const editorToolbar = document.querySelector(
      ".toolbar.toolbar-editor, .ol-cm-toolbar, [data-testid*='editor-toolbar' i]"
    );
    return Boolean(editorSurface || editorToolbar || (sourcePanel && pdfPanel));
  }

  // Keep page-type detection available to the other isolated-world modules.
  // CollabTeX's project overview also contains toolbar/action elements that
  // resemble the document toolbar, so toolbar controls must be gated explicitly.
  globalThis.SmartTeXPageContext = Object.freeze({
    isDocumentPage: isSmartTeXDocumentPage
  });
  document.documentElement.classList.toggle(
    "smarttex-document-page",
    isSmartTeXDocumentPage()
  );

  // The extension is registered for the whole CollabTeX origin, including the
  // project overview. Do not start editor parsing, observers, popups, or cache
  // work there. Detection is based on the editor DOM/shell, never on the
  // /project/<id> route alone, because that route is also used by overviews.
  if (!isSmartTeXDocumentPage()) return;

  const existingPreview = document.getElementById("smarttex-equation-preview");
  if (globalThis.__smartTeXPreviewLoaded && existingPreview) return;
  if (globalThis.__smartTeXPreviewLoaded && !existingPreview) {
    globalThis.__smartTeXPreviewLoaded = false;
  }
  if (globalThis.__smartTeXPreviewLoading) return;
  globalThis.__smartTeXPreviewLoading = true;

  const initializeWhenDependenciesAreReady = async () => {
    const startedAt = Date.now();
    let repairRequested = false;
    while (!(globalThis.SmartTeXLatexContext && globalThis.SmartTeXTableRenderer && globalThis.katex?.render)) {
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
        throw new Error("SmartTeX: A preview renderer could not be loaded.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (globalThis.__smartTeXPreviewLoaded) return;
    globalThis.__smartTeXPreviewLoaded = true;
    globalThis.__smartTeXPreviewLoading = false;

  const STATE_EVENT = "smarttex:editor-state";
  const REQUEST_EVENT = "smarttex:citation-editor-request";
  const RESPONSE_EVENT = "smarttex:citation-editor-response";
  const REFERENCE_AUTOCOMPLETE_PREVIEW_EVENT = "smarttex:reference-autocomplete-preview";
  const REFERENCE_AUTOCOMPLETE_PREVIEW_HIDE_EVENT = "smarttex:reference-autocomplete-preview-hide";
  const REFERENCE_AUTOCOMPLETE_ACTIVE_EVENT = "smarttex:reference-autocomplete-active";
  const GRAPHIC_AUTOCOMPLETE_ACTIVE_EVENT = "smarttex:graphic-autocomplete-active";
  const NAVIGATION_PUSH_EVENT = "smarttex:navigation-history-push";
  const CITATION_REFRESH_REQUEST_EVENT = "smarttex:citation-refresh-request";
  const CITATION_REFRESH_RESULT_EVENT = "smarttex:citation-refresh-result";
  const CITATION_CACHE_UPDATED_EVENT = "smarttex:citation-cache-updated";
  const FEATURES_KEY = "smarttex:features:v1";
  const REFERENCE_POPUPS_KEY = "smarttex:reference-popups:v1";
  const STRUCTURE_HIGHLIGHT_KEY = "smarttex:structure-highlight:v1";
  const RUNTIME_SETTINGS_EVENT = "smarttex:runtime-settings";
  const STRUCTURE_ANALYSIS_STATE_EVENT = "smarttex:structure-analysis-state";
  const COMMENTS_INITIALIZATION_STATE_EVENT = "smarttex:comments-initialization-state";
  const REVIEW_HYDRATION_STATE_EVENT = "smarttex:review-hydration-state";
  const SOURCE_RENDER_DELAY_MS = 24;
  const CAPTION_TYPING_RENDER_DELAY_MS = 500;
  const LIVE_CAPTION_UPDATE_DELAY_MS = 48;
  const LIVE_EQUATION_UPDATE_DELAY_MS = 48;
  const POPUP_SELECTION_HIGHLIGHT = "smarttex-popup-selection";
  const LATEX_FILE = /\.(?:tex|ltx|sty|cls)$/i;

  /*
   * SMARTTEX POPUP / OUTLINE BEHAVIOR CONTRACT
   * ------------------------------------------
   * The rules below collect the user-visible requirements that drove the
   * popup, File Outline, and graphics-tree implementation. Keep this block in
   * sync when any of these behaviors is changed; it is intentionally detailed
   * so later refactors do not reintroduce regressions that were fixed earlier.
   *
   * Popup size and movement
   * - The S-button/options sliders are the only persistent popup-size setting.
   *   Their values are relative multipliers of the intrinsic/default width and
   *   height. Mouse edge/corner resizing is deliberately temporary and affects
   *   only the currently open popup; it must never overwrite the slider values.
   *   (An earlier shared-persistence implementation was explicitly superseded.)
   * - Figure/table captions span the complete popup content width independently
   *   of the media/table width or aspect ratio. Caption typography is controlled
   *   by the persistent S-menu caption-font slider (50-200%, with 100% = 11 px);
   *   the default is deliberately compact and auto-fit must never change the
   *   caption font while typing. Changing this typography setting refits an open
   *   popup without invalidating or rerendering the expensive content cache.
   * - Popup headers use a grab/grabbing hand cursor and are drag handles for a
   *   temporary position change. Header buttons such as Close remain clickable.
   * - A visible popup keeps its position. It may relocate only when the cursor
   *   actually approaches/overlaps its safety margin or when initial placement
   *   is being chosen. Typing and arrow-key movement inside the owning
   *   environment use this same rule: content/caret updates never re-anchor the
   *   popup unless the updated caret would otherwise become too close to it.
   * - Resize hit zones live almost entirely on the outer border so they do not
   *   cover content or scrollbar tracks.
   *
   * Popup opening, fitting, and rendering
   * - Cold figure/table/equation previews render invisibly first. SmartTeX waits
   *   for stable media/KaTeX/table DOM, measures intrinsic geometry, applies the
   *   slider scale, computes final position, and reveals only once. A loading
   *   spinner is shown at the initiating pointer/caret during this staged work.
   * - Transient empty equation/table renders are retried internally instead of
   *   requiring the user to trigger the popup two or three times.
   * - Normal fit order is strict: grow the popup first, then uniformly auto-fit
   *   down to no less than 75% of the requested slider-scaled rendering, and
   *   only then enable scrollbars. Cached and freshly rendered previews must use
   *   the same final live-DOM fit solver so cache use cannot cause extra scrollbars.
   * - Normal equation/table width is capped at 40% of the viewport times the
   *   relevant size-slider multiplier. A genuinely one-line equation may use up
   *   to 80% times that multiplier and must never be artificially line-wrapped.
   *   Intrinsically multiline equations stay on the normal 40% policy.
   * - Figure height is special: the required natural height includes all media,
   *   inter-item gaps, and the full caption. A figure popup may grow vertically
   *   to the usable viewport before the 75%-then-scroll fallback is considered;
   *   the image must not be cropped merely to reserve caption space.
   * - Editing an already-open equation or figure/table caption updates that same
   *   popup live. The popup stays open and stationary and grows/refits when the
   *   new rendered content requires more space. Equation edits retain the last
   *   valid rendering through transiently incomplete TeX and replace/refit it as
   *   soon as the next valid render exists. Equation typing is an in-place
   *   edit session: secondary cursor/focus/layout events are absorbed while the
   *   caret remains in the equation, so the generic trigger cannot close/reopen
   *   the popup after the first live update. The rendered equation caret is also
   *   refreshed in-place on arrow-key movement. When the editor caret is inside
   *   a figure/table caption, the same caret is rendered inside the popup caption
   *   and follows both arrow-key movement and typing. Caption text gets a lightweight
   *   near-live update in the same mounted figure/table popup; it must not fall
   *   through into a delayed full-popup render. The independent idle cache
   *   warmer performs the expensive settled-source parse/cache refresh later.
   * - More generally, an environment popup is owned by that environment until
   *   the caret actually leaves it (or the user explicitly closes it). Generic
   *   focus/scroll/layout cleanup and stale queued renders must never tear down
   *   and recreate an equation/figure/table popup while the caret is still inside.
   * - Manually closing an environment preview keeps it dismissed while the user
   *   continues typing inside that environment; source-length changes must not
   *   make the dismissed popup reopen unexpectedly.
   *
   * Caching and responsiveness
   * - Full figure/table/equation popup markup, rendered captions, and structure
   *   hover thumbnails are cached with bounded LRU caches and warmed during idle
   *   time. Cache warming is intentionally nonvisual; the temporary green
   *   cache diagnostic dots in source lines and popup headers have been removed.
   *   Warming starts from the first available document state—even before
   *   popup interaction is enabled—and progressively covers all display-preview
   *   environments, prioritizing those nearest the caret. A full-document source
   *   signature already invalidates entries after any edit, so environment cache
   *   identity is deliberately just kind + opening source position within that
   *   signature; redundant context-body hashes must not make a background-warmed
   *   equation miss on its first opening. Unchanged figure/table cache identity is
   *   independent of caret moves.
   * - Cached DOM is cloned into a fresh display instance; transient selection,
   *   scroll, zoom, drag, and handler state is never reused as live popup state.
   *   Figure cache entries additionally retain references to their already-decoded
   *   media nodes. Keeping those decoded resources alive makes the first popup
   *   opening after background warming paint as quickly as the outline thumbnail
   *   instead of paying a second image/PDF decode cost.
   * - Cache hits reuse expensive rendered content but still validate/recompute
   *   fit from current live DOM/font/media metrics. Warm hits therefore display
   *   quickly without producing dimensions different from the cold render path.
   *
   * CollabTeX graphics tree
   * - Included graphics files receive a green checkmark overlay on the native
   *   file-type icon. Single-click on an included graphic jumps the source editor
   *   to its includegraphics location and pushes the standard Back navigation;
   *   double-click retains CollabTeX's native behavior of opening the image file.
   * - Hovering graphics files shows a cached thumbnail popup. Native title/tooltips
   *   are suppressed while the richer preview is active. Its loading spinner
   *   follows the pointer and is removed only on success/cancel/failure.
   *
   * CollabTeX File Outline
   * - Numbered equations, figures, and tables are merged into the native outline
   *   underneath their deepest active section/subsection, in document order, with
   *   compact labels such as "Fig. 2: [label]" / "Eq. (5): [label]". Entries are
   *   one line only (ellipsis instead of wrapping) and use the normal Back-aware
   *   editor jump path.
   * - Small disclosure arrows on section/subsection headers hide/show only their
   *   SmartTeX numbered entries, not CollabTeX's native subsection hierarchy.
   * - The current-position marker resolves to the deepest visible target: the
   *   latest numbered item when those items are expanded, otherwise the native
   *   section/subsection. Clicking a numbered item updates that marker immediately.
   * - Numbered rows are deliberately one-line/truncated navigation targets. Clicking
   *   a long row may scroll the outline vertically to keep the active item visible,
   *   but it must preserve every outline-pane ancestor's horizontal scroll position;
   *   navigation must never pan the File Outline to the right merely to expose a
   *   truncated label. This includes the immediate active-indicator update, the
   *   next-frame React reconciliation pass, and the asynchronous editor jump.
   * - Hovering numbered outline entries shows a compact cached preview. Figure
   *   thumbnails preserve parsed panel/row layout (including vertical stacking),
   *   equation/table previews are rendered, and figure/table captions render the
   *   same LaTeX/macros/references as normal popups. The full caption must fit;
   *   native browser tooltips are suppressed when the thumbnail preview exists.
   */
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const contextTools = globalThis.SmartTeXLatexContext;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const popupInteractionReady = () => globalThis.SmartTeXPopupGate?.isReady?.() !== false;
  const tableRenderer = globalThis.SmartTeXTableRenderer;
  const katex = globalThis.katex;
  let figureRendererReadyPromise = null;
  function ensureFigureRendererReady() {
    const rendererReady = () => Boolean(
      globalThis.SmartTeXFigureRenderer?.parseFigureLayout &&
      globalThis.SmartTeXFigureRenderer?.createMedia
    );
    if (rendererReady()) return Promise.resolve(globalThis.SmartTeXFigureRenderer);
    if (figureRendererReadyPromise) return figureRendererReadyPromise;
    figureRendererReadyPromise = (async () => {
      try {
        await extensionApi?.runtime?.sendMessage?.({
          type: "smarttex-reinject-preview-dependencies"
        });
      } catch (_error) {
        // The registered dependency script may still finish normally.
      }
      const startedAt = Date.now();
      while (!rendererReady()) {
        if (Date.now() - startedAt > 10000) {
          throw new Error("SmartTeX: The figure renderer could not be loaded.");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      return globalThis.SmartTeXFigureRenderer;
    })().catch((error) => {
      figureRendererReadyPromise = null;
      throw error;
    });
    return figureRendererReadyPromise;
  }
  const katexFontsReady = Promise.resolve(
    globalThis.SmartTeXKatexFonts?.ready
  ).catch(() => ({ loaded: 0, total: 0 }));
  const enabledFeatures = {
    equations: true,
    tables: true,
    figures: true
  };
  let runtimeSettingsOverrideActive = false;

  function taskCheckpoint(iteration = 0, interval = 128, token = undefined) {
    interactionTasks?.checkpoint?.(iteration, interval, token);
  }
  const featureSettingsReady = (
    typeof extensionApi?.storage?.local?.get === "function"
      ? extensionApi.storage.local.get(FEATURES_KEY).then((stored) => {
        const features = stored?.[FEATURES_KEY];
        enabledFeatures.equations = features?.equations !== false;
        enabledFeatures.tables = features?.tables !== false;
        enabledFeatures.figures = features?.figures !== false;
      })
      : Promise.resolve()
  ).catch(() => {});
  let referencePopupTrigger = "cursor";
  let environmentPopupTrigger = "cursor";
  const popupSettingsReady = (
    typeof extensionApi?.storage?.local?.get === "function"
      ? extensionApi.storage.local.get(REFERENCE_POPUPS_KEY).then((stored) => {
        const settings = stored?.[REFERENCE_POPUPS_KEY] || {};
        referencePopupTrigger = settings.trigger === "hover" ? "hover" : "cursor";
        environmentPopupTrigger = settings.environmentTrigger === "hover"
          ? "hover"
          : "cursor";
      })
      : Promise.resolve()
  ).catch(() => {
    referencePopupTrigger = "cursor";
    environmentPopupTrigger = "cursor";
  });

  function dispatchStructureHighlightSettings(value) {
    const validColor = (candidate, fallback) => /^#[0-9a-f]{6}$/i.test(String(candidate || ""))
      ? String(candidate).toLowerCase()
      : fallback;
    const settings = value || {};
    window.dispatchEvent(new CustomEvent("smarttex:structure-highlight-settings", {
      detail: {
        environmentEnabled: settings.environmentEnabled !== undefined
          ? settings.environmentEnabled !== false
          : settings.enabled !== false,
        environmentColor: validColor(settings.environmentColor || settings.color, "#dfedfb"),
        environmentFirstLineEnabled: settings.environmentFirstLineEnabled !== undefined
          ? settings.environmentFirstLineEnabled !== false
          : (settings.environmentEnabled !== undefined ? settings.environmentEnabled !== false : settings.enabled !== false),
        environmentFirstLineColor: validColor(
          settings.environmentFirstLineColor,
          settings.color !== undefined
            ? validColor(settings.environmentColor || settings.color, "#c7e4ff")
            : "#c7e4ff"
        ),
        sectionEnabled: settings.sectionEnabled !== undefined
          ? settings.sectionEnabled !== false
          : (settings.environmentEnabled !== undefined ? settings.environmentEnabled !== false : settings.enabled !== false),
        sectionColor: validColor(
          settings.sectionColor,
          settings.color !== undefined
            ? validColor(settings.environmentColor || settings.color, "#c4a7ff")
            : "#c4a7ff"
        ),
        captionEnabled: settings.captionEnabled === true,
        captionColor: validColor(settings.captionColor, "#70afea"),
        labelEnabled: settings.labelEnabled === true,
        labelColor: validColor(settings.labelColor, "#8fd19e"),
        referenceEnabled: settings.referenceEnabled !== false,
        referenceColor: validColor(settings.referenceColor, "#bcf0c8"),
        nonumberEnabled: settings.nonumberEnabled === true,
        nonumberColor: validColor(settings.nonumberColor, "#ffe69a"),
        inlineMathEnabled: settings.inlineMathEnabled !== false,
        inlineMathColor: validColor(settings.inlineMathColor, "#cce5ff"),
        activeEnabled: settings.activeEnabled !== false,
        activeStrength: Math.max(
          0,
          Math.min(100, Number.isFinite(Number(settings.activeStrength)) ? Number(settings.activeStrength) : 55)
        )
      }
    }));
  }

  const structureHighlightSettingsReady = (
    typeof extensionApi?.storage?.local?.get === "function"
      ? extensionApi.storage.local.get(STRUCTURE_HIGHLIGHT_KEY).then((stored) => {
        dispatchStructureHighlightSettings(stored?.[STRUCTURE_HIGHLIGHT_KEY]);
      })
      : Promise.resolve(dispatchStructureHighlightSettings(null))
  ).catch(() => dispatchStructureHighlightSettings(null));


  const graphicAutocompletePreview = document.createElement("aside");
  graphicAutocompletePreview.id = "smarttex-graphic-autocomplete-preview";
  graphicAutocompletePreview.hidden = true;
  graphicAutocompletePreview.setAttribute("role", "tooltip");
  graphicAutocompletePreview.setAttribute("aria-label", "Selected figure preview");
  graphicAutocompletePreview.innerHTML = `
    <div class="smarttex-preview-heading">
      <span class="smarttex-preview-title">Figure file preview</span>
      <span class="smarttex-preview-heading-actions">
        <span class="smarttex-preview-meta"></span>
        <span class="smarttex-inline-loading-spinner smarttex-graphic-preview-spinner" hidden aria-hidden="true"></span>
        <span class="smarttex-popup-escape-hint" aria-hidden="true">[Esc]</span>
        <button class="smarttex-preview-close smarttex-graphic-autocomplete-close" type="button" title="Close figure preview (Esc)" aria-label="Close figure preview">&times;</button>
      </span>
    </div>
    <div class="smarttex-graphic-autocomplete-output"></div>`;
  document.documentElement.appendChild(graphicAutocompletePreview);
  const graphicAutocompleteOutput = graphicAutocompletePreview.querySelector(
    ".smarttex-graphic-autocomplete-output"
  );
  const graphicAutocompleteMeta = graphicAutocompletePreview.querySelector(
    ".smarttex-preview-meta"
  );
  const graphicAutocompleteSpinner = graphicAutocompletePreview.querySelector(
    ".smarttex-graphic-preview-spinner"
  );
  const graphicAutocompleteClose = graphicAutocompletePreview.querySelector(
    ".smarttex-graphic-autocomplete-close"
  );

  const preview = document.createElement("aside");
  preview.id = "smarttex-equation-preview";
  preview.hidden = true;
  preview.setAttribute("role", "tooltip");
  preview.setAttribute("aria-label", "Live LaTeX preview");
  preview.innerHTML = `
    <div class="smarttex-preview-heading">
      <span class="smarttex-preview-title">Equation preview</span>
      <span class="smarttex-preview-heading-actions">
        <span class="smarttex-inline-loading-spinner smarttex-preview-loading-indicator" hidden aria-hidden="true"></span>
        <span class="smarttex-preview-meta" hidden></span>
        <span class="smarttex-popup-escape-hint" aria-hidden="true">[Esc]</span>
        <button class="smarttex-preview-close" type="button" title="Close preview (Esc)" aria-label="Close preview">&times;</button>
      </span>
    </div>
    <div class="smarttex-equation-output"></div>
    <div class="smarttex-preview-status" hidden></div>
  `;
  document.documentElement.appendChild(preview);

  const output = preview.querySelector(".smarttex-equation-output");
  const status = preview.querySelector(".smarttex-preview-status");
  const previewTitle = preview.querySelector(".smarttex-preview-title");
  const previewMeta = preview.querySelector(".smarttex-preview-meta");
  const previewLoadingIndicator = preview.querySelector(".smarttex-preview-loading-indicator");
  const closeButton = preview.querySelector(".smarttex-preview-close");
  const graphicAutocompletePopupUI = globalThis.SmartTeXPopupUI?.enhance?.(
    graphicAutocompletePreview,
    { type: "image", onClose: dismissGraphicAutocompleteClickPreview }
  );
  const previewPopupUI = globalThis.SmartTeXPopupUI?.enhance?.(
    preview,
    { type: "equation", onClose: dismissPreview }
  );
  const previewZoomControls = document.createElement("div");
  previewZoomControls.className = "smarttex-figure-zoom-controls smarttex-preview-zoom-controls";
  previewZoomControls.setAttribute("role", "group");
  previewZoomControls.setAttribute("aria-label", "Preview zoom");
  const previewZoomOut = document.createElement("button");
  previewZoomOut.type = "button";
  previewZoomOut.textContent = "−";
  previewZoomOut.title = "Zoom out";
  previewZoomOut.setAttribute("aria-label", "Zoom out");
  const previewZoomOutput = document.createElement("output");
  previewZoomOutput.className = "smarttex-figure-zoom-output";
  previewZoomOutput.setAttribute("aria-live", "polite");
  const previewZoomIn = document.createElement("button");
  previewZoomIn.type = "button";
  previewZoomIn.textContent = "+";
  previewZoomIn.title = "Zoom in";
  previewZoomIn.setAttribute("aria-label", "Zoom in");
  previewZoomControls.append(previewZoomOut, previewZoomOutput, previewZoomIn);
  preview.appendChild(previewZoomControls);
  let previewZoom = 1;
  let previewAutoFitZoom = 1;
  let previewZoomKind = "equation";

  function popupContentScale() {
    return Math.max(
      0.2,
      Number.parseFloat(
        globalThis.getComputedStyle?.(preview)?.getPropertyValue(
          "--smarttex-popup-content-scale"
        )
      ) || 1
    );
  }

  function fitTablePreview() {
    if (preview.dataset.previewKind !== "table") return;
    const baseScale = popupContentScale();
    preview.style.setProperty(
      "--smarttex-table-render-scale",
      String(Math.max(0.12, baseScale * previewZoom * previewAutoFitZoom))
    );
  }

  function refreshPreviewZoom() {
    const kind = preview.dataset.previewKind || "equation";
    const zoomable = kind === "equation" || kind === "table";
    previewZoomControls.hidden = !zoomable;
    preview.classList.toggle(
      "smarttex-preview-manually-zoomed",
      zoomable && Math.abs(previewZoom - 1) > 0.01
    );
    previewZoomOutput.value = `${Math.round(previewZoom * 100)}%`;
    previewZoomOutput.textContent = previewZoomOutput.value;
    const baseScale = popupContentScale();
    const effectiveScale = Math.max(0.05, baseScale * previewAutoFitZoom);
    preview.style.setProperty("--smarttex-popup-auto-fit-scale", String(previewAutoFitZoom));
    preview.style.setProperty("--smarttex-popup-effective-scale", String(effectiveScale));
    preview.style.setProperty(
      "--smarttex-equation-render-scale",
      String(baseScale * previewZoom * previewAutoFitZoom)
    );
    fitTablePreview();
  }

  function setPreviewZoom(value) {
    previewZoom = Math.max(0.25, Math.min(5, Number(value) || 1));
    refreshPreviewZoom();
    window.requestAnimationFrame(() => {
      if (preview.hidden || preview.dataset.smarttexStaging === "true") return;
      globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
        output.querySelector(".smarttex-figure-layout")
      );
      const metrics = previewOverflowMetrics();
      preview.classList.toggle(
        "smarttex-preview-scroll-fallback",
        Boolean(metrics.overflowX || metrics.overflowY)
      );
    });
  }

  for (const button of [previewZoomOut, previewZoomIn]) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  previewZoomOut.addEventListener("click", () => setPreviewZoom(previewZoom - 0.25));
  previewZoomIn.addEventListener("click", () => setPreviewZoom(previewZoom + 0.25));
  output.addEventListener("wheel", (event) => {
    if (!["equation", "table"].includes(preview.dataset.previewKind)) return;
    event.preventDefault();
    event.stopPropagation();
    const factor = Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.0025);
    setPreviewZoom(previewZoom * factor);
  }, { passive: false });
  graphicAutocompletePreview.addEventListener("smarttex:popup-resized", () => {
    const figure = graphicAutocompleteOutput.querySelector(".smarttex-figure-popup");
    globalThis.SmartTeXFigureRenderer?.ensurePopupZoom?.(figure)?.refresh?.();
  });
  preview.addEventListener("smarttex:popup-resized", (event) => {
    globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
      output.querySelector(".smarttex-figure-layout")
    );
    refreshPreviewZoom();
    // Slider sizing is also applied while a newly opened popup is staged. Do
    // not run the normal visible-popup reposition callback until staging has
    // completed; the reveal pipeline performs one final position instead.
    if (!event.detail?.live && preview.dataset.smarttexStaging !== "true") {
      positionPreviewAtCursor();
    }
  });
  const optionsButton = document.createElement("button");
  optionsButton.id = "smarttex-options-button";
  optionsButton.type = "button";
  optionsButton.innerHTML = `
    <span class="smarttex-options-mark" aria-hidden="true">S</span>
    <span class="smarttex-options-menu-icon" aria-hidden="true">
      <span></span><span></span><span></span>
    </span>
    <span class="smarttex-toolbar-loading-spinner" aria-hidden="true"></span>`;
  const STRUCTURE_SPINNER_MIN_VISIBLE_MS = 140;
  let structureAnalysisActive =
    document.documentElement.dataset.smarttexStructureAnalysis !== "ready";
  // comments.js is loaded after content.js. Keep the global loading indicator
  // active until its initial collaborative metadata hydration has completed,
  // so the S button accurately covers the period in which comment/mark overlays
  // are still absent after a page reload.
  let commentsInitializationActive =
    globalThis.__smartTeXCommentsInitializationActive !== false;
  // review.js is injected after content.js. Treat its initial hydration as
  // pending until it explicitly reports completion so a pre-review structure
  // paint cannot hide the S-button spinner too early.
  let reviewHydrationActive =
    globalThis.__smartTeXReviewHydrationActive !== false;
  let structureSpinnerShownAt = (structureAnalysisActive || commentsInitializationActive || reviewHydrationActive) ? performance.now() : 0;
  let structureSpinnerHideTimer = 0;
  let commentsInitializationFailSafe = window.setTimeout(() => {
    commentsInitializationActive = false;
    updateToolbarLoadingSpinner();
  }, 15000);
  let reviewHydrationFailSafe = window.setTimeout(() => {
    reviewHydrationActive = false;
    updateToolbarLoadingSpinner();
  }, 15000);

  function updateToolbarLoadingSpinner() {
    const next = Boolean(structureAnalysisActive || commentsInitializationActive || reviewHydrationActive);
    window.clearTimeout(structureSpinnerHideTimer);
    structureSpinnerHideTimer = 0;
    if (next) {
      if (!structureSpinnerShownAt) structureSpinnerShownAt = performance.now();
      optionsButton.classList.add("smarttex-initializing");
      return;
    }
    const elapsed = structureSpinnerShownAt ? performance.now() - structureSpinnerShownAt : STRUCTURE_SPINNER_MIN_VISIBLE_MS;
    const hide = () => {
      structureSpinnerShownAt = 0;
      optionsButton.classList.remove("smarttex-initializing");
    };
    const remaining = Math.max(0, STRUCTURE_SPINNER_MIN_VISIBLE_MS - elapsed);
    if (remaining > 0) structureSpinnerHideTimer = window.setTimeout(hide, remaining);
    else hide();
  }

  function setStructureSpinnerActive(active) {
    structureAnalysisActive = Boolean(active);
    updateToolbarLoadingSpinner();
  }

  optionsButton.title = "Open SmartTeX options";
  optionsButton.setAttribute("aria-label", "Open SmartTeX options");
  let optionsButtonSlot = null;

  function attachOptionsButton() {
    const documentPage = isSmartTeXDocumentPage();
    document.documentElement.classList.toggle("smarttex-document-page", documentPage);
    if (!documentPage) {
      optionsButtonSlot?.remove();
      optionsButton.remove();
      return;
    }

    const shareButton = [...document.querySelectorAll("button, a")].find((candidate) => {
      const style = globalThis.getComputedStyle?.(candidate);
      if (
        candidate.getClientRects().length === 0 ||
        style?.display === "none" ||
        style?.visibility === "hidden"
      ) {
        return false;
      }
      const label = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent
      ].filter(Boolean).join(" ").trim();
      return /(^|\s)(share|teilen)(\s|$)/i.test(label);
    }) || null;
    const fallbackActions = document.querySelector(
      ".ide-redesign-toolbar-actions, " +
      ".toolbar-header .toolbar-right, " +
      ".project-actions, " +
      "[class*='project'][class*='actions']"
    );
    const actions = shareButton?.closest(
      ".ide-redesign-toolbar-actions, " +
      ".toolbar-header .toolbar-right, " +
      ".project-actions, " +
      "[class*='project'][class*='actions']"
    ) || shareButton?.parentElement || fallbackActions;
    if (!actions) {
      if (!optionsButton.isConnected) document.documentElement.appendChild(optionsButton);
      return;
    }
    if (!optionsButtonSlot || !optionsButtonSlot.isConnected) {
      optionsButtonSlot = document.createElement("div");
      optionsButtonSlot.id = "smarttex-toolbar-slot";
      optionsButtonSlot.className = "ide-redesign-toolbar-button-container";
    }
    optionsButton.className = "d-inline-grid btn btn-sm smarttex-toolbar-button";
    optionsButton.classList.toggle(
      "smarttex-initializing",
      structureAnalysisActive || commentsInitializationActive || reviewHydrationActive
    );
    if (optionsButton.parentElement !== optionsButtonSlot) {
      optionsButtonSlot.insertBefore(optionsButton, optionsButtonSlot.firstChild);
    } else if (optionsButtonSlot.firstElementChild !== optionsButton) {
      optionsButtonSlot.insertBefore(optionsButton, optionsButtonSlot.firstChild);
    }

    // The Nextcloud module may have attached its action before this toolbar
    // slot was reconstructed. Preserve one deterministic order: SmartTeX menu
    // first, Nextcloud immediately to its right.
    const nextcloudButton = optionsButtonSlot.querySelector(
      ".smarttex-nextcloud-update-all"
    );
    if (
      nextcloudButton &&
      optionsButton.nextElementSibling !== nextcloudButton
    ) {
      optionsButtonSlot.insertBefore(nextcloudButton, optionsButton.nextSibling);
    }
    if (shareButton) {
      let shareContainer = shareButton;
      while (
        shareContainer.parentElement &&
        shareContainer.parentElement !== actions
      ) {
        shareContainer = shareContainer.parentElement;
      }
      let insertionAnchor = shareContainer;
      while (
        insertionAnchor.previousElementSibling?.matches(
          "#ctca-project-cloud-slot, .ctca-project-cloud-slot"
        )
      ) {
        insertionAnchor = insertionAnchor.previousElementSibling;
      }
      if (
        optionsButtonSlot.parentElement !== actions ||
        optionsButtonSlot.nextSibling !== insertionAnchor
      ) {
        actions.insertBefore(optionsButtonSlot, insertionAnchor);
      }
    } else if (optionsButtonSlot.parentElement !== actions) {
      actions.insertBefore(optionsButtonSlot, actions.firstChild);
    }
  }
  let currentState = null;
  let hoverPreviewState = null;
  let typedEnvironmentPreviewActive = false;
  let activePreviewState = null;
  let environmentHoverTimer = null;
  let environmentHoverGeneration = 0;
  let renderTimer = null;
  let renderGeneration = 0;
  let scheduledPreviewHint = null;
  let activeContextId = "";
  const dismissedPreviewContexts = new Map();
  let caretPlacementState = null;
  let lastSuccessfulMarkup = "";
  let captionPreviewLock = null;
  let liveCaptionUpdateTimer = null;
  let liveEquationUpdateTimer = null;
  // While an equation is being edited, keep one explicit edit session alive
  // until the caret leaves that equation. Generic editor state/focus/layout
  // notifications must not tear down and recreate the popup between keystrokes.
  let liveEquationEditSession = null;
  let activeFloatCaptionRenderInfo = null;
  let previewPositioned = false;
  let activePreviewContext = null;
  let lastFloatPreviewContextHint = null;
  let documentAnalysisCache = {
    fileName: "",
    source: null,
    equations: null,
    equationRenderData: new Map()
  };
  let previewPositionGeneration = 0;
  let lastPointerScreen = null;
  let verticalScrollRepositionPending = false;
  let previewPointerInside = false;
  let previewInteractionUntil = 0;
  let requestCounter = 0;
  let captionReferencePopup = null;
  let captionReferencePopupTimer = null;
  let captionReferencePopupAnchor = null;
  let captionReferencePopupAnchorRect = null;
  let autocompleteReferenceAnchorRect = null;
  let autocompleteReferenceOwnerRect = null;
  let autocompleteReferenceCommandStart = null;
  let autocompleteReferenceTargetKey = "";
  const nestedCaptionReferencePopupStates = [];
  let editorReferenceHoverTimer = null;
  let editorReferenceHoverGeneration = 0;
  let referenceAutocompleteActive = false;
  let graphicAutocompleteActive = false;
  let graphicAutocompleteContextActive = false;
  let graphicAutocompletePath = "";
  let graphicAutocompleteGeneration = 0;
  let graphicAutocompleteUpdateFrame = null;
  let graphicAutocompleteHoveredOwner = null;
  let graphicAutocompleteHoveredEntry = null;
  let customGraphicAutocompleteSelectionPath = "";
  let customGraphicAutocompletePreviewSuppressed = false;
  let graphicAutocompleteClickPreview = false;
  let lastEditorTextInputAt = 0;
  // Text input and CollabTeX editor-state publication are not atomic. Some
  // editor builds briefly report the newly edited source with an old/zero
  // cursor index (and sometimes focus=false/screen=null) before publishing the
  // corrected caret state. Remember which mounted environment owned the actual
  // DOM input event so those transient states cannot close/reopen its popup.
  let activeEnvironmentInputTransaction = null;
  let activeEditorReferenceKey = "";
  let activeEditorReferenceType = "";
  let activeSecondaryEditorReferenceKey = "";
  let captionInnerReferenceActive = false;
  let popupLoadingSpinner = null;
  let popupLoadingSpinnerGeneration = 0;
  let environmentPopupLoadingSpinner = null;
  let environmentPopupLoadingSpinnerGeneration = 0;
  let previewLoadingGeneration = 0;
  let previewLoadingGlobalGeneration = null;
  let referencePopupInteractionUntil = 0;
  let referencePopupPointerDown = false;
  let citationRecords = new Map();
  let citationRecordsPromise = null;
  let citationRecordsLoaded = false;
  let citationRefreshCounter = 0;
  const pendingCitationRefreshes = new Map();
  const pendingRequests = new Map();
  let popupsSuppressedAfterEditorScroll = false;

  interactionTasks?.subscribe?.(() => {
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    renderTimer = null;
    renderGeneration += 1;
    if (environmentHoverTimer !== null) window.clearTimeout(environmentHoverTimer);
    environmentHoverTimer = null;
    environmentHoverGeneration += 1;
    if (editorReferenceHoverTimer !== null) window.clearTimeout(editorReferenceHoverTimer);
    editorReferenceHoverTimer = null;
    editorReferenceHoverGeneration += 1;
    if (captionReferencePopupTimer !== null) window.clearTimeout(captionReferencePopupTimer);
    captionReferencePopupTimer = null;
    if (graphicAutocompleteUpdateFrame !== null) {
      window.cancelAnimationFrame(graphicAutocompleteUpdateFrame);
      graphicAutocompleteUpdateFrame = null;
    }
    graphicAutocompleteGeneration += 1;
    previewPositionGeneration += 1;
    if (previewCacheWarmTimer !== null) window.clearTimeout(previewCacheWarmTimer);
    previewCacheWarmTimer = null;
    previewCacheWarmGeneration += 1;
    if (numberedOutlineUpdateTimer !== null) window.clearTimeout(numberedOutlineUpdateTimer);
    numberedOutlineUpdateTimer = null;
  });

  preview.addEventListener("pointerenter", () => {
    previewPointerInside = true;
    previewInteractionUntil = Date.now() + 900;
  });
  preview.addEventListener("pointermove", () => {
    previewPointerInside = true;
    previewInteractionUntil = Date.now() + 900;
  }, { passive: true });
  preview.addEventListener("pointerleave", () => {
    previewPointerInside = false;
    // Keep a short bridge interval while the pointer crosses the gap to a
    // nested reference popup opened from a figure or table caption.
    previewInteractionUntil = Date.now() + 650;
  });
  preview.addEventListener("focusin", () => {
    previewInteractionUntil = Date.now() + 900;
  });

  function referencePopupUsesHover() {
    return referencePopupTrigger !== "cursor";
  }

  function environmentPopupUsesHover() {
    return environmentPopupTrigger === "hover";
  }

  function announceNavigationOrigin(destinationIndex = null) {
    if (!currentState) return;
    const cursorIndex = Math.max(0, Number(currentState.cursorIndex) || 0);
    if (Number.isFinite(Number(destinationIndex)) && cursorIndex === Number(destinationIndex)) {
      return;
    }
    const anchor = Math.max(
      0,
      Number(currentState.selectionAnchor ?? currentState.selectionFrom ?? cursorIndex) || 0
    );
    const head = Math.max(
      0,
      Number(currentState.selectionHead ?? currentState.selectionTo ?? cursorIndex) || 0
    );
    window.dispatchEvent(new CustomEvent(NAVIGATION_PUSH_EVENT, {
      detail: JSON.stringify({
        fileName: String(currentState.fileName || ""),
        cursorIndex,
        anchor,
        head
      })
    }));
  }

  let numberedOutlineUpdateTimer = null;
  let numberedOutlinePaneObserver = null;
  let numberedOutlineObservedPane = null;
  let numberedOutlineDiscoveryObserver = null;
  let numberedOutlineCacheFileName = "";
  let numberedOutlineCacheSource = null;
  let numberedOutlineCacheEntries = [];
  const numberedOutlineCollapsedSections = new Set();
  let numberedOutlinePendingCursorIndex = null;
  let numberedOutlinePendingCursorTimer = null;
  let numberedOutlineActiveSourceIndex = null;

  const STRUCTURE_HOVER_PREVIEW_DELAY_MS = 180;
  let structureHoverPreviewTimer = null;
  let structureHoverPreviewGeneration = 0;
  let structureHoverPreviewAnchor = null;
  let structureHoverSpinner = null;
  let structureHoverSpinnerVisible = false;
  let structureHoverPointer = null;
  let structureHoverTooltipRoot = null;
  const structureHoverSuppressedTitles = new Map();

  const PREVIEW_RENDER_CACHE_LIMIT = 256;
  const STRUCTURE_HOVER_CACHE_LIMIT = 96;
  const CAPTION_RENDER_CACHE_LIMIT = 160;
  const previewRenderCache = new Map();
  const previewBaseRenderCache = new Map();
  const structureHoverRenderCache = new Map();
  const captionRenderCache = new Map();
  let previewCacheWarmTimer = null;
  let previewCacheWarmGeneration = 0;
  let previewSourceSignatureCacheSource = null;
  let previewSourceSignatureCacheFileName = "";
  let previewSourceSignatureCacheValue = "";

  function previewElementKind(context) {
    // Equation parser contexts describe their TeX syntax as "environment" or
    // "delimiter" because latex-context.js needs that distinction to build the
    // rendered body. Popup/cache code, however, has only three logical preview
    // types: figure, table and equation. Always normalize through this helper
    // before constructing cache keys or making popup-lifecycle decisions.
    //
    // This distinction is critical for proactive equation caching: the idle
    // warmer explicitly labels its entry as "equation", whereas the context
    // found later under the editor cursor still has kind "environment". Using
    // context.kind directly therefore produced two keys for the same unchanged
    // equation and made its first visible opening miss a genuinely warm cache.
    const kind = String(context?.kind || context?.type || "");
    if (kind === "figure") return "figure";
    if (kind === "table") return "table";
    return "equation";
  }


  function setPopupOpenedFromCache(cached) {
    // Keep a nonvisual cache-origin flag for internal debugging/tests, but do
    // not expose cache diagnostics as green dots in source or popup chrome.
    preview.dataset.smarttexOpenedFromCache = Boolean(cached) ? "true" : "false";
  }

  function fastPreviewHash(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function lruCacheGet(cache, key) {
    if (!cache.has(key)) return null;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function lruCacheSet(cache, key, value, limit) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    return value;
  }

  function htmlNodeClone(markup) {
    const template = document.createElement("template");
    template.innerHTML = String(markup || "").trim();
    return template.content.firstElementChild || null;
  }

  function normalizedPreviewCacheEntry(value) {
    if (!value) return null;
    if (typeof value === "string") return { markup: value, metrics: null };
    if (typeof value === "object" && typeof value.markup === "string") return value;
    return null;
  }

  function previewCacheSet(cache, key, markup, metrics = null, extras = null) {
    const previous = normalizedPreviewCacheEntry(cache.get(key));
    // Background figure warming fully decodes raster/PDF preview images. Keep
    // those detached media nodes referenced by the LRU entry so the browser's
    // decoded-image cache stays hot until eviction. The visible popup still gets
    // fresh DOM markup, so no live scroll/drag/event state is shared.
    const mediaKeepalive = extras?.mediaKeepalive ?? previous?.mediaKeepalive ?? null;
    return lruCacheSet(
      cache,
      key,
      {
        markup: String(markup || ""),
        metrics: metrics || null,
        ...(mediaKeepalive ? { mediaKeepalive } : {})
      },
      PREVIEW_RENDER_CACHE_LIMIT
    );
  }

  function canonicalPreviewBaseMarkup(markup) {
    const template = document.createElement("template");
    template.innerHTML = String(markup || "");
    for (const caret of template.content.querySelectorAll(
      ".smarttex-rendered-caret, .smarttex-rendered-operator-caret"
    )) {
      caret.remove();
    }
    // Selection highlighting is applied to the live popup after the cached
    // rendering has been installed. Never let such transient UI state become
    // part of the cursor-independent base cache.
    for (const selected of template.content.querySelectorAll(".smarttex-popup-selection")) {
      selected.classList.remove("smarttex-popup-selection");
    }
    return template.innerHTML;
  }

  function stabilizeCachedPreviewMedia(root) {
    if (!(root instanceof Element)) return;
    for (const image of root.querySelectorAll("img")) {
      const width = Number(image.naturalWidth) || Number(image.getAttribute("width")) || 0;
      const height = Number(image.naturalHeight) || Number(image.getAttribute("height")) || 0;
      if (!(width > 0 && height > 0)) continue;
      // Width/height attributes preserve the decoded aspect ratio even for a
      // freshly cloned cached <img> whose resource has not completed its first
      // layout turn yet. CSS still controls the actual display width.
      image.setAttribute("width", String(Math.round(width)));
      image.setAttribute("height", String(Math.round(height)));
      image.style.aspectRatio = `${width} / ${height}`;
    }
  }

  function cachedPreviewMediaGeometryReady(root) {
    return [...root.querySelectorAll("img")].every((image) => {
      if (image.complete && Number(image.naturalWidth) > 0) return true;
      return (
        Number(image.getAttribute("width")) > 0 &&
        Number(image.getAttribute("height")) > 0
      );
    });
  }

  function measuredPreviewCacheEntry(cache, key) {
    const entry = normalizedPreviewCacheEntry(cache.get(key));
    return entry?.markup && entry?.metrics?.naturalSize ? entry : null;
  }

  function previewSourceSignature(state = currentState) {
    const fileName = String(state?.fileName || "");
    const source = String(state?.value || "");
    if (
      source === previewSourceSignatureCacheSource &&
      fileName === previewSourceSignatureCacheFileName
    ) {
      return previewSourceSignatureCacheValue;
    }
    previewSourceSignatureCacheSource = source;
    previewSourceSignatureCacheFileName = fileName;
    previewSourceSignatureCacheValue = `${fileName}::${fastPreviewHash(source)}`;
    return previewSourceSignatureCacheValue;
  }

  function previewBaseCacheKey(state, context) {
    // previewSourceSignature() hashes the complete LaTeX source. Therefore a
    // second hash of context.source is redundant and, more importantly, can
    // differ between the proactive equation analyzer and the cursor-local
    // context finder even though they refer to the same unchanged environment.
    // Use the stable environment identity inside the document signature so a
    // background-warmed equation is guaranteed to hit on its very first open.
    return [
      previewSourceSignature(state),
      previewElementKind(context),
      Number(context?.openStart ?? context?.sourceIndex ?? 0)
    ].join("::");
  }

  function previewExactCacheKey(state, context) {
    const kind = previewElementKind(context);
    let cursorIndex = Number(state?.cursorIndex ?? -1);
    let selectionFrom = Number(state?.selectionFrom ?? state?.cursorIndex ?? -1);
    let selectionTo = Number(state?.selectionTo ?? state?.cursorIndex ?? -1);

    // Figure/table rendering is structurally cursor-independent for a collapsed
    // selection. The visual caret is transient UI and is stripped before the
    // base/exact cache is stored. Keeping a single key for the whole float
    // prevents cache misses merely because the caret moved inside its caption
    // or table body.
    if ((kind === "figure" || kind === "table") && selectionFrom === selectionTo) {
      cursorIndex = -1;
      selectionFrom = -1;
      selectionTo = -1;
    }

    return [
      previewBaseCacheKey(state, context),
      cursorIndex,
      selectionFrom,
      selectionTo
    ].join("::");
  }

  function structureHoverCacheKey(entry) {
    return [
      previewSourceSignature(currentState),
      String(entry?.type || ""),
      Number(entry?.sourceIndex || 0),
      String(entry?.number || ""),
      String(entry?.label || ""),
      fastPreviewHash(entry?.caption || "")
    ].join("::");
  }

  function ensureStructureHoverPreview() {
    let popup = document.getElementById("smarttex-structure-hover-preview");
    if (popup) return popup;
    popup = document.createElement("div");
    popup.id = "smarttex-structure-hover-preview";
    popup.className = "smarttex-structure-hover-preview";
    popup.hidden = true;
    popup.setAttribute("aria-hidden", "true");
    document.body.appendChild(popup);
    return popup;
  }

  function ensureStructureHoverSpinner() {
    if (structureHoverSpinner?.isConnected) return structureHoverSpinner;
    structureHoverSpinner = document.createElement("span");
    structureHoverSpinner.className =
      "smarttex-popup-loading-spinner smarttex-structure-hover-loading-spinner";
    structureHoverSpinner.hidden = true;
    structureHoverSpinner.setAttribute("role", "status");
    structureHoverSpinner.setAttribute("aria-label", "Loading preview");
    document.body.appendChild(structureHoverSpinner);
    return structureHoverSpinner;
  }

  function updateStructureHoverPointer(event) {
    if (!event || !Number.isFinite(Number(event.clientX)) || !Number.isFinite(Number(event.clientY))) return;
    structureHoverPointer = { x: Number(event.clientX), y: Number(event.clientY) };
    if (!structureHoverSpinnerVisible) return;
    const spinner = ensureStructureHoverSpinner();
    spinner.style.left = `${Math.round(structureHoverPointer.x + 12)}px`;
    spinner.style.top = `${Math.round(structureHoverPointer.y + 12)}px`;
  }

  function showStructureHoverSpinner() {
    const spinner = ensureStructureHoverSpinner();
    const point = structureHoverPointer;
    if (!point) return;
    structureHoverSpinnerVisible = true;
    spinner.style.left = `${Math.round(point.x + 12)}px`;
    spinner.style.top = `${Math.round(point.y + 12)}px`;
    spinner.hidden = false;
  }

  function hideStructureHoverSpinner() {
    structureHoverSpinnerVisible = false;
    if (structureHoverSpinner) structureHoverSpinner.hidden = true;
  }

  function restoreStructureHoverTooltips() {
    for (const [node, title] of structureHoverSuppressedTitles) {
      if (!(node instanceof Element) || !node.isConnected) continue;
      if (title === null) node.removeAttribute("title");
      else node.setAttribute("title", title);
    }
    structureHoverSuppressedTitles.clear();
    structureHoverTooltipRoot = null;
  }

  function suppressStructureHoverTooltips(root) {
    if (!(root instanceof Element)) return;
    if (structureHoverTooltipRoot === root) return;
    restoreStructureHoverTooltips();
    structureHoverTooltipRoot = root;
    const nodes = [root, ...root.querySelectorAll("[title]")];
    for (const node of nodes) {
      if (!(node instanceof Element) || !node.hasAttribute("title")) continue;
      structureHoverSuppressedTitles.set(node, node.getAttribute("title"));
      node.removeAttribute("title");
    }
  }

  function hideStructureHoverPreview({ invalidate = true } = {}) {
    if (structureHoverPreviewTimer !== null) {
      window.clearTimeout(structureHoverPreviewTimer);
      structureHoverPreviewTimer = null;
    }
    if (invalidate) structureHoverPreviewGeneration += 1;
    structureHoverPreviewAnchor = null;
    hideStructureHoverSpinner();
    const popup = document.getElementById("smarttex-structure-hover-preview");
    if (!popup) return;
    popup.hidden = true;
    popup.setAttribute("aria-hidden", "true");
    popup.classList.remove("smarttex-structure-hover-preview-measuring");
    popup.replaceChildren();
  }

  function positionStructureHoverPreview(anchor, popup) {
    if (!(anchor instanceof Element) || !(popup instanceof Element)) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const margin = 10;
    const gap = 9;
    const width = Math.min(popupRect.width || 280, Math.max(120, window.innerWidth - margin * 2));
    const height = Math.min(popupRect.height || 180, Math.max(80, window.innerHeight - margin * 2));
    let left = anchorRect.right + gap;
    if (left + width > window.innerWidth - margin) {
      left = anchorRect.left - gap - width;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    let top = anchorRect.top + Math.min(4, Math.max(0, anchorRect.height * 0.2));
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  async function resolveStructureHoverMedia(pathValue) {
    const path = String(pathValue || "").trim();
    if (!path) throw new Error("Figure path is empty.");
    const renderer = await ensureFigureRendererReady();
    let file = directFigureFile(path);
    if (!file?.url) {
      const response = await bridgeRequest("resolveProjectFile", { path });
      file = response?.file || null;
    }
    if (!file?.url) throw new Error("Figure URL is unavailable.");
    const media = await renderer.createMedia(file.path || path, file.url, {
      imageClass: "smarttex-structure-hover-image",
      pdfClass: "smarttex-structure-hover-image smarttex-structure-hover-pdf"
    });
    if (typeof media.decode === "function") {
      try { await media.decode(); } catch (_error) {
        if (!media.complete || !media.naturalWidth) throw _error;
      }
    }
    return media;
  }

  function numberedOutlinePreviewContext(entry) {
    const source = String(currentState?.value || "");
    const sourceIndex = Math.max(0, Number(entry?.sourceIndex) || 0);
    if (!source) return null;

    // Background warming can pass a context that was already obtained from the
    // document-analysis cache. Reuse it directly instead of locating the same
    // environment again from a synthetic cursor position. Besides reducing the
    // warm-up cost, this also lets unnumbered display equations/float contexts
    // participate in the full-popup cache even though they have no outline row.
    if (entry?.context) {
      const type = String(entry.type || entry.context.kind || "equation");
      return {
        type,
        number: String(entry.number || ""),
        sourceIndex,
        context: entry.context,
        caption: String(entry.caption || ""),
        numbering: type === "equation"
          ? (entry.numbering || contextTools.equationPreviewNumbering?.(source, entry.context) || null)
          : null
      };
    }
    if (entry?.label) {
      const labelled = contextTools.referenceTarget?.(source, entry.label);
      if (labelled) return labelled;
    }
    if (entry?.type === "equation") {
      const context = contextTools.findEquationContext?.(source, sourceIndex + 1);
      if (!context) return null;
      return {
        type: "equation",
        number: String(entry.number || ""),
        sourceIndex,
        context,
        numbering: contextTools.equationPreviewNumbering?.(source, context) || null
      };
    }
    if (entry?.type === "figure") {
      const context = contextTools.findFigureContext?.(source, sourceIndex + 1);
      return context ? { type: "figure", sourceIndex, context, caption: entry.caption || "" } : null;
    }
    if (entry?.type === "table") {
      const context = contextTools.findTableFloatContext?.(source, sourceIndex + 1) ||
        contextTools.findTableContext?.(source, sourceIndex + 1);
      return context ? { type: "table", sourceIndex, context, caption: entry.caption || "" } : null;
    }
    return null;
  }

  function appendStructureHoverCaption(
    container,
    source,
    sourceIndex,
    captionText,
    captionSourceOffset = null
  ) {
    const text = String(captionText || "").trim();
    if (!text) return null;
    const prepared = contextTools.prepareDocumentCommands(
      source,
      Math.max(0, Number(sourceIndex) || 0),
      text
    );
    const captionNode = document.createElement("div");
    captionNode.className = "smarttex-structure-hover-caption";
    captionNode.appendChild(tableRenderer.renderInlineLatex(prepared.body, {
      contextTools,
      document,
      katex,
      macros: prepared.macros,
      trust: trustedKatexCommand,
      sourceOffset: Number.isFinite(Number(captionSourceOffset))
        ? Number(captionSourceOffset)
        : undefined,
      renderReference: createCaptionReferenceLink
    }));
    container.appendChild(captionNode);
    return captionNode;
  }

  async function buildNumberedOutlineHoverPreview(entry) {
    const source = String(currentState?.value || "");
    const target = numberedOutlinePreviewContext(entry);
    if (!target) throw new Error("Preview source is unavailable.");
    const wrapper = document.createElement("div");
    wrapper.className = `smarttex-structure-hover-content smarttex-structure-hover-${entry.type}`;

    const title = document.createElement("div");
    title.className = "smarttex-structure-hover-title";
    title.textContent = numberedOutlineEntryText(entry);
    wrapper.appendChild(title);

    const body = document.createElement("div");
    body.className = "smarttex-structure-hover-body";
    wrapper.appendChild(body);

    if (entry.type === "figure") {
      const renderer = await ensureFigureRendererReady();
      const layout = renderer.parseFigureLayout?.(target.context.source || "", {
        environment: target.context.environment
      });
      const figureLayout = document.createElement("div");
      figureLayout.className = "smarttex-structure-hover-figure-layout";
      const mediaTasks = [];
      let imageCount = 0;

      for (const rowModel of layout?.rows || []) {
        const row = document.createElement("div");
        row.className = "smarttex-structure-hover-figure-row";
        const items = rowModel.items || [];
        const relativeTotal = Math.max(
          0,
          Number(rowModel.relativeWidthRatio) || items.reduce(
            (sum, item) => sum + Math.max(0, Number(item.widthRatio) || 1),
            0
          )
        ) || 1;
        for (const itemModel of items) {
          const panel = document.createElement("div");
          panel.className = "smarttex-structure-hover-figure-panel";
          const widthRatio = Math.max(0.05, Number(itemModel.widthRatio) || 1);
          const fraction = rowModel.normalizeRelativeWidths === false
            ? Math.min(1, widthRatio)
            : Math.min(1, widthRatio / relativeTotal);
          panel.style.flex = `${fraction} 1 0`;

          for (const imageModel of itemModel.images || []) {
            const path = String(imageModel.path || "").trim();
            if (!path) continue;
            imageCount += 1;
            const slot = document.createElement("div");
            slot.className = "smarttex-structure-hover-figure-image-slot";
            panel.appendChild(slot);
            mediaTasks.push((async () => {
              try {
                const media = await resolveStructureHoverMedia(path);
                slot.replaceChildren(media);
              } catch (_error) {
                const missing = document.createElement("div");
                missing.className = "smarttex-structure-hover-missing";
                missing.textContent = "Preview unavailable";
                slot.replaceChildren(missing);
              }
            })());
          }
          if (panel.childElementCount) row.appendChild(panel);
        }
        if (row.childElementCount) figureLayout.appendChild(row);
      }

      // Older or unusual figure syntax may not be represented by the layout
      // parser. Preserve source order and stack those graphics vertically.
      if (!imageCount) {
        const matches = [...String(target.context.source || "").matchAll(
          /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/gi
        )];
        for (const match of matches) {
          const path = String(match[1] || "").trim();
          if (!path) continue;
          imageCount += 1;
          const row = document.createElement("div");
          row.className = "smarttex-structure-hover-figure-row";
          const panel = document.createElement("div");
          panel.className = "smarttex-structure-hover-figure-panel";
          const slot = document.createElement("div");
          slot.className = "smarttex-structure-hover-figure-image-slot";
          panel.appendChild(slot);
          row.appendChild(panel);
          figureLayout.appendChild(row);
          mediaTasks.push((async () => {
            try { slot.replaceChildren(await resolveStructureHoverMedia(path)); }
            catch (_error) {
              const missing = document.createElement("div");
              missing.className = "smarttex-structure-hover-missing";
              missing.textContent = "Preview unavailable";
              slot.replaceChildren(missing);
            }
          })());
        }
      }

      await Promise.all(mediaTasks);
      if (!imageCount) {
        const missing = document.createElement("div");
        missing.className = "smarttex-structure-hover-missing";
        missing.textContent = "Preview unavailable";
        figureLayout.appendChild(missing);
      }
      body.appendChild(figureLayout);
      appendStructureHoverCaption(
        body,
        source,
        target.sourceIndex,
        entry.caption || target.caption || "",
        entry.captionSourceIndex
      );
      return wrapper;
    }

    if (entry.type === "table") {
      const tableContext = target.context?.environment?.match?.(/^table\*?$/i)
        ? popupTableContext(target, source)
        : target.context;
      if (!tableContext) throw new Error("Table body is unavailable.");
      const prepared = contextTools.prepareDocumentCommands(
        source,
        target.sourceIndex,
        tableContext.source
      );
      const rendered = tableRenderer.renderTable({ ...tableContext, source: prepared.body }, {
        commandSide: null,
        includeCaret: false,
        contextTools,
        document,
        katex,
        macros: prepared.macros,
        trust: trustedKatexCommand
      });
      if (!rendered) throw new Error("Table preview is empty.");
      body.appendChild(rendered);
      appendStructureHoverCaption(
        body,
        source,
        target.sourceIndex,
        entry.caption || target.caption || "",
        entry.captionSourceIndex
      );
      return wrapper;
    }

    const context = target.context;
    const numbering = target.numbering || contextTools.equationPreviewNumbering?.(source, context);
    const equationBody = contextTools.previewBody(context, null, numbering, false);
    const prepared = contextTools.prepareDocumentCommands(source, target.sourceIndex, equationBody);
    const equation = document.createElement("div");
    equation.className = "smarttex-structure-hover-equation-render";
    katex.render(prepared.body, equation, {
      displayMode: true,
      throwOnError: false,
      strict: "ignore",
      trust: trustedKatexCommand,
      maxExpand: 1000,
      maxSize: 25,
      macros: {
        ...prepared.macros,
        "\\label": { tokens: [], numArgs: 1 },
        "\\nonumber": "",
        "\\notag": ""
      }
    });
    body.appendChild(equation);
    return wrapper;
  }

  async function buildFileTreeHoverPreview(item) {
    const path = String(
      item?.getAttribute("data-path") ||
      item?.getAttribute("data-file-path") ||
      item?.getAttribute("aria-label") ||
      item?.querySelector(".item-name-button span, .item-name span, .entity-name span")?.textContent ||
      ""
    ).trim();
    const wrapper = document.createElement("div");
    wrapper.className = "smarttex-structure-hover-content smarttex-structure-hover-file";
    const title = document.createElement("div");
    title.className = "smarttex-structure-hover-title";
    title.textContent = path.replace(/\\/g, "/").split("/").pop() || "Figure";
    const body = document.createElement("div");
    body.className = "smarttex-structure-hover-body smarttex-structure-hover-file-body";
    body.appendChild(await resolveStructureHoverMedia(path));
    wrapper.append(title, body);
    return wrapper;
  }

  function fileTreeHoverCacheKey(item) {
    const path = String(
      item?.getAttribute("data-path") ||
      item?.getAttribute("data-file-path") ||
      item?.getAttribute("aria-label") ||
      item?.querySelector(".item-name-button span, .item-name span, .entity-name span")?.textContent ||
      ""
    ).trim();
    const directUrl = directFigureFile(path)?.url || "";
    return `file::${path}::${directUrl}`;
  }

  async function cachedFileTreeHoverPreview(item) {
    const key = fileTreeHoverCacheKey(item);
    const cached = lruCacheGet(structureHoverRenderCache, key);
    if (cached) {
      const clone = htmlNodeClone(cached);
      if (clone) return clone;
    }
    const built = await buildFileTreeHoverPreview(item);
    if (built?.outerHTML) {
      lruCacheSet(structureHoverRenderCache, key, built.outerHTML, STRUCTURE_HOVER_CACHE_LIMIT);
    }
    return built;
  }

  function scheduleStructureHoverPreview(anchor, builder, pointerEvent = null) {
    if (!(anchor instanceof Element) || typeof builder !== "function") return;
    updateStructureHoverPointer(pointerEvent);
    if (structureHoverPreviewTimer !== null) window.clearTimeout(structureHoverPreviewTimer);
    const generation = ++structureHoverPreviewGeneration;
    structureHoverPreviewAnchor = anchor;
    const popup = ensureStructureHoverPreview();
    popup.hidden = true;
    structureHoverPreviewTimer = window.setTimeout(async () => {
      structureHoverPreviewTimer = null;
      try {
        if (generation !== structureHoverPreviewGeneration || structureHoverPreviewAnchor !== anchor || !anchor.isConnected) return;
        showStructureHoverSpinner();
        // Let the spinner paint before decoding images or invoking KaTeX/table
        // rendering. Pointer movement continues to update its position.
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        const content = await builder();
        if (generation !== structureHoverPreviewGeneration || structureHoverPreviewAnchor !== anchor || !anchor.isConnected) {
          hideStructureHoverSpinner();
          return;
        }
        popup.replaceChildren(content);
        popup.classList.add("smarttex-structure-hover-preview-measuring");
        popup.hidden = false;
        popup.setAttribute("aria-hidden", "false");
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        if (generation !== structureHoverPreviewGeneration || structureHoverPreviewAnchor !== anchor || !anchor.isConnected) {
          hideStructureHoverPreview({ invalidate: false });
          return;
        }
        positionStructureHoverPreview(anchor, popup);
        popup.classList.remove("smarttex-structure-hover-preview-measuring");
        hideStructureHoverSpinner();
      } catch (_error) {
        if (generation === structureHoverPreviewGeneration) hideStructureHoverPreview({ invalidate: false });
      }
    }, STRUCTURE_HOVER_PREVIEW_DELAY_MS);
  }

  async function cachedNumberedOutlineHoverPreview(entry) {
    const key = structureHoverCacheKey(entry);
    const cached = lruCacheGet(structureHoverRenderCache, key);
    if (cached) {
      const clone = htmlNodeClone(cached);
      if (clone) return clone;
    }
    const built = await buildNumberedOutlineHoverPreview(entry);
    if (built?.outerHTML) {
      lruCacheSet(
        structureHoverRenderCache,
        key,
        built.outerHTML,
        STRUCTURE_HOVER_CACHE_LIMIT
      );
    }
    return built;
  }

  function scheduleNumberedOutlineHoverPreview(link, entry, pointerEvent = null) {
    scheduleStructureHoverPreview(link, () => cachedNumberedOutlineHoverPreview(entry), pointerEvent);
  }

  function fileTreeGraphicItemFromNode(node) {
    const item = node?.closest?.('.file-tree-list [role="treeitem"]');
    if (!(item instanceof Element)) return null;
    if (item.classList.contains("smarttex-figure-tree-item")) return item;
    const name = String(
      item.getAttribute("data-path") ||
      item.getAttribute("data-file-path") ||
      item.getAttribute("aria-label") ||
      item.querySelector(".item-name-button span, .item-name span, .entity-name span")?.textContent ||
      ""
    );
    return /\.(?:png|jpe?g|gif|webp|svg|pdf|eps|bmp|tiff?)$/i.test(name.trim()) ? item : null;
  }

  function numberedOutlineSectionCollapseKey(section, state = currentState) {
    const fileName = String(state?.fileName || "");
    const level = Math.max(0, Number(section?.level) || 0);
    const number = String(section?.number || "").trim();
    const title = normalizedOutlineText(section?.title);
    const sourceIndex = Math.max(0, Number(section?.sourceIndex) || 0);
    return [fileName, level, number, title, sourceIndex].join("|");
  }

  function numberedOutlineEntriesForState(state = currentState) {
    const source = String(state?.value || "");
    const fileName = String(state?.fileName || "");
    if (
      source === numberedOutlineCacheSource &&
      fileName === numberedOutlineCacheFileName
    ) {
      return numberedOutlineCacheEntries;
    }
    numberedOutlineCacheSource = source;
    numberedOutlineCacheFileName = fileName;
    numberedOutlineCacheEntries = contextTools.numberedOutlineElements?.(source) || [];
    return numberedOutlineCacheEntries;
  }

  function numberedOutlineEntryText(entry) {
    const label = String(entry?.label || "").trim();
    const number = String(entry?.number || "?").trim() || "?";
    const prefix = entry?.type === "figure"
      ? `Fig. ${number}`
      : entry?.type === "table"
        ? `Table ${number}`
        : `Eq. (${number})`;
    return label ? `${prefix}: [${label}]` : prefix;
  }

  function numberedOutlineEntryTitle(entry) {
    const text = numberedOutlineEntryText(entry);
    const caption = String(entry?.caption || "").replace(/\s+/g, " ").trim();
    return caption ? `${text} — ${caption}` : `${text} — jump to source`;
  }

  function numberedOutlineSignature(entries) {
    return entries.map((entry) => [
      entry.type,
      entry.number,
      entry.label,
      entry.sourceIndex
    ].join(":" )).join("|");
  }

  function clearNumberedOutlinePendingCursor() {
    if (numberedOutlinePendingCursorTimer !== null) {
      window.clearTimeout(numberedOutlinePendingCursorTimer);
      numberedOutlinePendingCursorTimer = null;
    }
    numberedOutlinePendingCursorIndex = null;
  }

  function setNumberedOutlinePendingCursor(indexValue) {
    clearNumberedOutlinePendingCursor();
    numberedOutlinePendingCursorIndex = Math.max(0, Number(indexValue) || 0);
    numberedOutlinePendingCursorTimer = window.setTimeout(() => {
      numberedOutlinePendingCursorTimer = null;
      numberedOutlinePendingCursorIndex = null;
      updateNumberedOutlineActiveIndicator();
    }, 900);
  }

  function numberedOutlineHorizontalScrollSnapshot(body) {
    // CollabTeX may place horizontal overflow on the outline body, an inner tree
    // wrapper, or the pane itself depending on deployment/version. Capture every
    // ancestor inside the outline pane rather than assuming a single scroll owner.
    // The numbered labels are intentionally ellipsized; a navigation click must not
    // pan any of these containers sideways just because scrollIntoView() wants to
    // reveal the hidden tail of a long label.
    if (!(body instanceof Element)) return [];
    const pane = body.closest(".outline-pane");
    const snapshot = [];
    let node = body;
    while (node instanceof HTMLElement) {
      snapshot.push({ element: node, left: Number(node.scrollLeft) || 0 });
      if (node === pane) break;
      node = node.parentElement;
    }
    return snapshot;
  }

  function restoreNumberedOutlineHorizontalScroll(snapshot) {
    for (const entry of snapshot || []) {
      if (!(entry?.element instanceof HTMLElement) || !entry.element.isConnected) continue;
      entry.element.scrollLeft = Number(entry.left) || 0;
    }
  }

  function preserveNumberedOutlineHorizontalScroll(body, action) {
    const snapshot = numberedOutlineHorizontalScrollSnapshot(body);
    const result = typeof action === "function" ? action() : undefined;
    restoreNumberedOutlineHorizontalScroll(snapshot);
    // CollabTeX's outline highlight is React-owned and can commit after SmartTeX's
    // synchronous click handler. Restore once more on the next paint so that late
    // focus/scrollIntoView work cannot move the pane horizontally after the click.
    window.requestAnimationFrame?.(() => restoreNumberedOutlineHorizontalScroll(snapshot));
    return { result, snapshot };
  }

  function jumpFromNumberedOutline(entry) {
    const sourceIndex = Math.max(0, Number(entry?.sourceIndex) || 0);
    const body = document.querySelector(".outline-pane .outline-body");
    const horizontalSnapshot = numberedOutlineHorizontalScrollSnapshot(body);
    announceNavigationOrigin(sourceIndex);
    // Move the outline indicator synchronously. CollabTeX updates its own
    // highlighted section only after its editor-selection observer runs; the
    // SmartTeX row should become current at the instant it is clicked.
    setNumberedOutlinePendingCursor(sourceIndex);
    preserveNumberedOutlineHorizontalScroll(body, () => {
      updateNumberedOutlineActiveIndicator(sourceIndex);
    });
    window.requestAnimationFrame?.(() => {
      preserveNumberedOutlineHorizontalScroll(body, () => {
        updateNumberedOutlineActiveIndicator(sourceIndex);
      });
    });
    bridgeRequest("setCursor", {
      index: sourceIndex,
      focus: true
    }).then(() => {
      // Focusing the editor can trigger a delayed native-outline reconciliation.
      // Preserve the exact pre-click horizontal position across that final commit.
      restoreNumberedOutlineHorizontalScroll(horizontalSnapshot);
      window.requestAnimationFrame?.(() => {
        restoreNumberedOutlineHorizontalScroll(horizontalSnapshot);
      });
    }).catch((error) => {
      restoreNumberedOutlineHorizontalScroll(horizontalSnapshot);
      clearNumberedOutlinePendingCursor();
      updateNumberedOutlineActiveIndicator();
      console.warn("SmartTeX could not navigate from the file outline:", error);
    });
  }

  function numberedOutlineSectionGroups(state = currentState) {
    const source = String(state?.value || "");
    const entries = numberedOutlineEntriesForState(state);
    const sections = contextTools.sectionNumbering?.(source) || [];
    const groups = new Map();
    const topLevel = [];
    const active = [];
    let sectionCursor = 0;

    for (const entry of entries) {
      const entryIndex = Math.max(0, Number(entry?.sourceIndex) || 0);
      while (
        sectionCursor < sections.length &&
        (Number(sections[sectionCursor]?.sourceIndex) || 0) <= entryIndex
      ) {
        const section = sections[sectionCursor];
        const level = Math.max(0, Number(section?.level) || 0);
        active.length = level;
        active[level] = section;
        sectionCursor += 1;
      }
      const owner = active.filter(Boolean).at(-1) || null;
      if (!owner) {
        topLevel.push(entry);
        continue;
      }
      const key = String(Math.max(0, Number(owner.sourceIndex) || 0));
      if (!groups.has(key)) groups.set(key, { section: owner, entries: [] });
      groups.get(key).entries.push(entry);
    }
    return { sections, groups, topLevel };
  }

  function normalizedOutlineText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .trim();
  }

  function nativeOutlineItemControl(item) {
    if (!(item instanceof Element)) return null;
    return item.querySelector(
      ":scope > button, :scope > a, :scope > [role='button'], " +
      ":scope > div > button, :scope > div > a, :scope > div > [role='button']"
    );
  }

  function nativeOutlineItemText(item) {
    if (!(item instanceof Element)) return "";
    const ownControl = nativeOutlineItemControl(item);
    if (ownControl) return normalizedOutlineText(ownControl.textContent);

    const clone = item.cloneNode(true);
    clone.querySelectorAll?.(".smarttex-numbered-outline-list").forEach((node) => node.remove());
    clone.querySelectorAll?.("ul, ol, [role='group']").forEach((node) => node.remove());
    return normalizedOutlineText(clone.textContent);
  }

  function nativeOutlineItems(body) {
    const selectors = [
      ".outline-item",
      "[role='treeitem']",
      "li",
      "[data-testid*='outline']"
    ];
    const seen = new Set();
    const items = [];
    for (const selector of selectors) {
      for (const candidate of body.querySelectorAll(selector)) {
        if (!(candidate instanceof Element)) continue;
        const item = candidate.matches("button, a, [role='button']")
          ? candidate.closest(".outline-item, [role='treeitem'], li") || candidate.parentElement
          : candidate;
        if (
          !(item instanceof Element) ||
          item.closest(".smarttex-numbered-outline-list") ||
          seen.has(item)
        ) continue;
        seen.add(item);
        items.push(item);
      }
    }
    return items;
  }

  function outlineSectionMatchesItem(section, item) {
    const title = normalizedOutlineText(section?.title);
    if (!title) return false;
    const text = nativeOutlineItemText(item);
    if (!text) return false;
    if (text === title) return true;

    const number = normalizedOutlineText(section?.number);
    const candidates = [
      number ? `${number} ${title}` : "",
      number ? `${number}. ${title}` : "",
      number ? `${number}\u00a0${title}` : ""
    ].filter(Boolean);
    return candidates.some((candidate) => text === normalizedOutlineText(candidate)) ||
      text.endsWith(` ${title}`);
  }

  function findNativeOutlineSectionItem(body, section, usedItems) {
    const items = nativeOutlineItems(body);
    for (const item of items) {
      if (usedItems.has(item)) continue;
      if (outlineSectionMatchesItem(section, item)) return item;
    }
    return null;
  }

  function restoreSuppressedNativeOutlineHighlight(body) {
    if (!(body instanceof Element)) return;
    for (const control of body.querySelectorAll("[data-smarttex-outline-highlight-suppressed='true']")) {
      if (control.closest(".smarttex-numbered-outline-list")) continue;
      control.classList.add("outline-item-link-highlight");
      delete control.dataset.smarttexOutlineHighlightSuppressed;
    }
    for (const item of body.querySelectorAll("[data-smarttex-outline-current-suppressed='true']")) {
      if (item.closest(".smarttex-numbered-outline-list")) continue;
      item.setAttribute("aria-current", "true");
      delete item.dataset.smarttexOutlineCurrentSuppressed;
    }
  }

  function suppressNativeOutlineHighlight(body) {
    if (!(body instanceof Element)) return;
    for (const control of body.querySelectorAll(".outline-item-link.outline-item-link-highlight")) {
      if (control.closest(".smarttex-numbered-outline-list")) continue;
      control.classList.remove("outline-item-link-highlight");
      control.dataset.smarttexOutlineHighlightSuppressed = "true";
    }
    for (const item of body.querySelectorAll("[role='treeitem'][aria-current='true']")) {
      if (item.closest(".smarttex-numbered-outline-list")) continue;
      item.setAttribute("aria-current", "false");
      item.dataset.smarttexOutlineCurrentSuppressed = "true";
    }
  }

  function numberedOutlineLinkForEntry(body, entry) {
    if (!(body instanceof Element)) return null;
    const sourceIndex = String(Math.max(0, Number(entry?.sourceIndex) || 0));
    const links = body.querySelectorAll(".smarttex-numbered-outline-link[data-smarttex-source-index]");
    for (const link of links) {
      if (link.dataset.smarttexSourceIndex !== sourceIndex) continue;
      const list = link.closest(".smarttex-numbered-outline-list");
      if (list?.hidden) return null;
      return link;
    }
    return null;
  }

  function numberedOutlineActiveEntryForCursor(cursorValue, state = currentState, body = null) {
    const cursorIndex = Math.max(0, Number(cursorValue) || 0);
    const sections = contextTools.sectionNumbering?.(String(state?.value || "")) || [];
    const entries = numberedOutlineEntriesForState(state);
    let latestSectionIndex = -1;
    for (const section of sections) {
      const sectionIndex = Math.max(0, Number(section?.sourceIndex) || 0);
      if (sectionIndex > cursorIndex) break;
      latestSectionIndex = sectionIndex;
    }

    let activeEntry = null;
    for (const entry of entries) {
      const entryIndex = Math.max(0, Number(entry?.sourceIndex) || 0);
      if (entryIndex > cursorIndex) break;
      // A newer section/subsection supersedes numbered items from the previous
      // structural scope. Within the current scope, the last visible numbered
      // item becomes the deepest outline target.
      if (entryIndex < latestSectionIndex) continue;
      if (body && !numberedOutlineLinkForEntry(body, entry)) continue;
      activeEntry = entry;
    }
    return activeEntry;
  }

  function updateNumberedOutlineActiveIndicator(cursorOverride = null) {
    const body = document.querySelector(".outline-pane .outline-body");
    if (!(body instanceof Element)) return;

    for (const link of body.querySelectorAll(".smarttex-numbered-outline-link")) {
      link.classList.remove("smarttex-numbered-outline-link-active", "outline-item-link-highlight");
      link.removeAttribute("aria-current");
    }

    // Undo only the native highlight state SmartTeX suppressed on the previous
    // pass. If there is a new active numbered row it is suppressed again below.
    restoreSuppressedNativeOutlineHighlight(body);

    const effectiveCursor = cursorOverride !== null && cursorOverride !== undefined
      ? Math.max(0, Number(cursorOverride) || 0)
      : numberedOutlinePendingCursorIndex !== null
        ? numberedOutlinePendingCursorIndex
        : Math.max(0, Number(currentState?.cursorIndex) || 0);
    const entry = numberedOutlineActiveEntryForCursor(effectiveCursor, currentState, body);
    if (!entry) {
      numberedOutlineActiveSourceIndex = null;
      return;
    }

    const link = numberedOutlineLinkForEntry(body, entry);
    if (!(link instanceof Element)) {
      numberedOutlineActiveSourceIndex = null;
      return;
    }

    // Reuse CollabTeX's own highlight class so the numbered row receives the
    // exact same current-location treatment as a native section heading.
    suppressNativeOutlineHighlight(body);
    link.classList.add("smarttex-numbered-outline-link-active", "outline-item-link-highlight");
    link.setAttribute("aria-current", "location");

    const sourceIndex = Math.max(0, Number(entry.sourceIndex) || 0);
    if (numberedOutlineActiveSourceIndex !== sourceIndex) {
      numberedOutlineActiveSourceIndex = sourceIndex;
      // Vertical auto-scrolling is useful when the active numbered item is outside
      // the visible outline viewport, but horizontal panning is never useful because
      // labels are intentionally single-line with ellipsis. Preserve all horizontal
      // outline scroll offsets around scrollIntoView(), including the next paint.
      preserveNumberedOutlineHorizontalScroll(body, () => {
        link.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      });
    }
  }

  function scheduleNumberedOutlineActiveIndicator() {
    updateNumberedOutlineActiveIndicator();
    // CollabTeX's React outline may commit its native section highlight just
    // after the editor state event. Re-apply on the next paint so the current
    // marker remains on the deeper SmartTeX numbered row instead of briefly
    // returning to the containing subsection.
    window.requestAnimationFrame?.(() => updateNumberedOutlineActiveIndicator());
  }

  function setNumberedOutlineCollapsed(toggle, list, collapsed) {
    if (!(list instanceof Element)) return;
    list.hidden = Boolean(collapsed);
    if (!(toggle instanceof Element)) return;
    toggle.classList.toggle("smarttex-numbered-outline-toggle-collapsed", Boolean(collapsed));
    toggle.dataset.smarttexCollapsed = collapsed ? "true" : "false";
    toggle.title = collapsed ? "Show numbered elements" : "Hide numbered elements";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  function attachNumberedOutlineToggle(nativeItem, section, list) {
    const control = nativeOutlineItemControl(nativeItem);
    if (!(control instanceof Element)) return null;

    const collapseKey = numberedOutlineSectionCollapseKey(section);
    const toggle = document.createElement("span");
    toggle.className = "smarttex-numbered-outline-toggle";
    toggle.dataset.smarttexSectionCollapseKey = collapseKey;
    toggle.setAttribute("aria-hidden", "true");

    const collapsed = numberedOutlineCollapsedSections.has(collapseKey);
    setNumberedOutlineCollapsed(toggle, list, collapsed);

    const stopNativeOutlineActivation = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    toggle.addEventListener("pointerdown", stopNativeOutlineActivation);
    toggle.addEventListener("mousedown", stopNativeOutlineActivation);
    toggle.addEventListener("click", (event) => {
      stopNativeOutlineActivation(event);
      const nextCollapsed = !list.hidden;
      if (nextCollapsed) numberedOutlineCollapsedSections.add(collapseKey);
      else numberedOutlineCollapsedSections.delete(collapseKey);
      setNumberedOutlineCollapsed(toggle, list, nextCollapsed);
      scheduleNumberedOutlineActiveIndicator();
    });

    // Keep the disclosure arrow visually inside the native section header,
    // but do not add another button/treeitem/role that CollabTeX could mistake
    // for a real outline node when it determines the current section.
    control.prepend(toggle);
    return toggle;
  }

  function createNumberedOutlineList(entries, section = null) {
    // Deliberately use plain divs rather than ul/li/treeitem/button elements.
    // CollabTeX's outline code scans those native structures to determine the
    // active section; SmartTeX rows must not participate in that indexing.
    const list = document.createElement("div");
    list.className = "smarttex-numbered-outline-list";
    if (section) {
      list.dataset.smarttexSectionIndex = String(Math.max(0, Number(section.sourceIndex) || 0));
      list.dataset.smarttexSectionLevel = String(Math.max(0, Number(section.level) || 0));
    } else {
      list.classList.add("smarttex-numbered-outline-root");
    }

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = `smarttex-numbered-outline-item smarttex-numbered-outline-${entry.type}`;

      const link = document.createElement("div");
      link.className = "smarttex-numbered-outline-link outline-item-link";
      link.setAttribute("aria-label", numberedOutlineEntryTitle(entry));
      link.dataset.smarttexSourceIndex = String(Math.max(0, Number(entry.sourceIndex) || 0));

      const number = document.createElement("span");
      number.className = "smarttex-numbered-outline-number";
      number.textContent = entry.type === "figure"
        ? `Fig. ${entry.number}`
        : entry.type === "table"
          ? `Table ${entry.number}`
          : `Eq. (${entry.number})`;
      link.appendChild(number);

      if (entry.label) {
        const separator = document.createElement("span");
        separator.className = "smarttex-numbered-outline-separator";
        separator.textContent = ":";
        const label = document.createElement("span");
        label.className = "smarttex-numbered-outline-label";
        label.textContent = `[${entry.label}]`;
        link.append(separator, label);
      }

      link.addEventListener("pointerenter", (event) => {
        updateStructureHoverPointer(event);
        scheduleNumberedOutlineHoverPreview(link, entry, event);
      });
      link.addEventListener("pointerleave", () => {
        hideStructureHoverPreview();
      });
      link.addEventListener("pointerdown", (event) => {
        hideStructureHoverPreview();
        // Prevent the native outline header from receiving activation/focus.
        event.stopPropagation();
      });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        jumpFromNumberedOutline(entry);
      });
      item.appendChild(link);
      list.appendChild(item);
    }
    return list;
  }

  function renderNumberedOutlineNow() {
    const body = document.querySelector(".outline-pane .outline-body");
    if (!body || !currentState?.value) return;

    const entries = numberedOutlineEntriesForState(currentState);
    const signature = numberedOutlineSignature(entries);
    const { groups, topLevel } = numberedOutlineSectionGroups(currentState);
    const expectedSectionKeys = [...groups.keys()];
    const hasCompleteMerge = (
      body.dataset.smarttexNumberedOutlineSignature === signature &&
      (!topLevel.length || body.querySelector(
        ":scope > .smarttex-numbered-outline-list.smarttex-numbered-outline-root"
      )) &&
      expectedSectionKeys.every((key) => (
        body.querySelector(
          `.smarttex-numbered-outline-list[data-smarttex-section-index="${CSS.escape(key)}"]`
        ) &&
        body.querySelector(
          `.smarttex-numbered-outline-toggle[data-smarttex-section-index="${CSS.escape(key)}"]`
        )
      ))
    );
    if (hasCompleteMerge) {
      updateNumberedOutlineActiveIndicator();
      return;
    }

    body.querySelectorAll(".smarttex-numbered-outline-list").forEach((node) => node.remove());
    body.querySelectorAll(".smarttex-numbered-outline-toggle").forEach((node) => node.remove());
    delete body.dataset.smarttexNumberedOutlineSignature;
    if (!entries.length) {
      updateNumberedOutlineActiveIndicator();
      return;
    }

    const usedItems = new Set();

    if (topLevel.length) {
      body.prepend(createNumberedOutlineList(topLevel));
    }

    for (const { section, entries: sectionEntries } of groups.values()) {
      const nativeItem = findNativeOutlineSectionItem(body, section, usedItems);
      if (!nativeItem) continue;
      usedItems.add(nativeItem);
      const list = createNumberedOutlineList(sectionEntries, section);
      const nestedStructure = nativeItem.querySelector(
        ":scope > ul:not(.smarttex-numbered-outline-list), " +
        ":scope > ol:not(.smarttex-numbered-outline-list), " +
        ":scope > [role='group']:not(.smarttex-numbered-outline-list)"
      );
      nativeItem.insertBefore(list, nestedStructure || null);
      const toggle = attachNumberedOutlineToggle(nativeItem, section, list);
      if (toggle) {
        toggle.dataset.smarttexSectionIndex = String(
          Math.max(0, Number(section.sourceIndex) || 0)
        );
      }
    }

    body.dataset.smarttexNumberedOutlineSignature = signature;
    updateNumberedOutlineActiveIndicator();
  }

  function renderNumberedOutline() {
    numberedOutlineUpdateTimer = null;
    try {
      if (interactionTasks?.runSync) {
        interactionTasks.runSync("numbered-outline-render", renderNumberedOutlineNow);
      } else {
        renderNumberedOutlineNow();
      }
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) {
        scheduleNumberedOutlineUpdate(500);
        return;
      }
      throw error;
    }
  }

  function scheduleNumberedOutlineUpdate(delay = 80) {
    if (numberedOutlineUpdateTimer !== null) {
      window.clearTimeout(numberedOutlineUpdateTimer);
    }
    numberedOutlineUpdateTimer = window.setTimeout(
      renderNumberedOutline,
      Math.max(
        Math.max(0, Number(delay) || 0),
        Number(interactionTasks?.keyboardIdleRemaining?.()) || 0
      )
    );
  }

  function ensureNumberedOutlineObserver() {
    const pane = document.querySelector(".outline-pane");
    if (pane && pane !== numberedOutlineObservedPane) {
      numberedOutlinePaneObserver?.disconnect();
      numberedOutlineObservedPane = pane;
      numberedOutlinePaneObserver = new MutationObserver(() => {
        scheduleNumberedOutlineUpdate(40);
      });
      numberedOutlinePaneObserver.observe(pane, { childList: true, subtree: true });
      scheduleNumberedOutlineUpdate(0);
    }
    if (pane) {
      numberedOutlineDiscoveryObserver?.disconnect();
      numberedOutlineDiscoveryObserver = null;
      return;
    }
    if (!numberedOutlineDiscoveryObserver && document.body) {
      numberedOutlineDiscoveryObserver = new MutationObserver(() => {
        if (document.querySelector(".outline-pane")) ensureNumberedOutlineObserver();
      });
      numberedOutlineDiscoveryObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function previewStateForRender() {
    return environmentPopupUsesHover() && hoverPreviewState
      ? hoverPreviewState
      : currentState;
  }


  function ensurePopupLoadingSpinner() {
    if (popupLoadingSpinner?.isConnected) return popupLoadingSpinner;
    popupLoadingSpinner = document.createElement("span");
    popupLoadingSpinner.className = "smarttex-popup-loading-spinner";
    popupLoadingSpinner.hidden = true;
    popupLoadingSpinner.setAttribute("role", "status");
    popupLoadingSpinner.setAttribute("aria-label", "Opening preview");
    document.body.appendChild(popupLoadingSpinner);
    return popupLoadingSpinner;
  }

  function popupSpinnerButtonPosition() {
    const rect = optionsButton?.getBoundingClientRect?.();
    if (
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth
    ) {
      return {
        left: rect.left + rect.width / 2 - 9,
        top: rect.top + rect.height / 2 - 9
      };
    }
    return { left: Math.max(8, window.innerWidth - 42), top: 17 };
  }

  function popupSpinnerAnchorPosition(event = null, anchor = null) {
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      return { left: clientX - 9, top: clientY - 9 };
    }

    const candidate = anchor?.getBoundingClientRect?.() || anchor;
    if (candidate) {
      const pageX = Number(candidate.pageX);
      const pageY = Number(candidate.pageY);
      if (Number.isFinite(pageX) && Number.isFinite(pageY)) {
        return {
          left: pageX - window.scrollX - 9,
          top: pageY - window.scrollY - 9
        };
      }
      const left = Number(candidate.left);
      const top = Number(candidate.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        const width = Math.max(0, Number(candidate.width) || 0);
        const height = Math.max(0, Number(candidate.height) || 0);
        return {
          left: left + width / 2 - 9,
          top: top + height / 2 - 9
        };
      }
    }
    return null;
  }

  function showPopupLoadingSpinner(event, anchor = null) {
    if (!popupInteractionReady()) return null;
    const spinner = ensurePopupLoadingSpinner();
    const position = popupSpinnerAnchorPosition(event, anchor) || popupSpinnerButtonPosition();
    const generation = ++popupLoadingSpinnerGeneration;
    spinner.style.left = `${Math.round(position.left)}px`;
    spinner.style.top = `${Math.round(position.top)}px`;
    spinner.hidden = false;
    return generation;
  }

  function hidePopupLoadingSpinner(generation = null) {
    if (
      generation !== null &&
      generation !== undefined &&
      generation !== popupLoadingSpinnerGeneration
    ) return;
    popupLoadingSpinnerGeneration += 1;
    if (popupLoadingSpinner) popupLoadingSpinner.hidden = true;
  }

  function ensureEnvironmentPopupLoadingSpinner() {
    if (environmentPopupLoadingSpinner?.isConnected) return environmentPopupLoadingSpinner;
    environmentPopupLoadingSpinner = document.createElement("span");
    environmentPopupLoadingSpinner.className =
      "smarttex-popup-loading-spinner smarttex-environment-popup-loading-spinner";
    environmentPopupLoadingSpinner.hidden = true;
    environmentPopupLoadingSpinner.setAttribute("role", "status");
    environmentPopupLoadingSpinner.setAttribute("aria-label", "Opening preview");
    document.body.appendChild(environmentPopupLoadingSpinner);
    return environmentPopupLoadingSpinner;
  }

  function showEnvironmentPopupLoadingSpinner(anchor = null) {
    if (!popupInteractionReady()) return null;
    const spinner = ensureEnvironmentPopupLoadingSpinner();
    const position = popupSpinnerAnchorPosition(null, anchor) || popupSpinnerButtonPosition();
    const generation = ++environmentPopupLoadingSpinnerGeneration;
    spinner.style.left = `${Math.round(position.left)}px`;
    spinner.style.top = `${Math.round(position.top)}px`;
    spinner.hidden = false;
    return generation;
  }

  function hideEnvironmentPopupLoadingSpinner(generation = null) {
    if (
      generation !== null &&
      generation !== undefined &&
      generation !== environmentPopupLoadingSpinnerGeneration
    ) return;
    environmentPopupLoadingSpinnerGeneration += 1;
    if (environmentPopupLoadingSpinner) environmentPopupLoadingSpinner.hidden = true;
  }

  function equationPreviewIsSingleLine(context, renderedRoot = null) {
    if (!context || context.kind === "table" || context.kind === "figure") return false;

    const source = String(context.source || "");
    // Explicit TeX row breaks always make the rendered equation multi-line,
    // irrespective of the surrounding math environment. This also catches
    // nested aligned/gathered/matrix-style constructs with multiple rows.
    if (/\\\\/.test(source) || /\\(?:newline|linebreak)\b/.test(source)) {
      return false;
    }

    if (renderedRoot?.querySelectorAll) {
      // KaTeX represents aligned, gathered, cases, arrays and matrices as
      // mtables. More than one rendered row is definitive evidence that the
      // equation is not a one-liner. A one-row aligned environment is still
      // allowed to use the wider popup.
      const rowCount = renderedRoot.querySelectorAll(".mtable .mtr").length;
      if (rowCount > 1) return false;
    }

    return true;
  }

  function updateEquationPreviewLineMode(context, renderedRoot = null) {
    if (!context || context.kind === "table" || context.kind === "figure") {
      delete preview.dataset.smarttexEquationSingleLine;
      return false;
    }
    const singleLine = equationPreviewIsSingleLine(context, renderedRoot);
    preview.dataset.smarttexEquationSingleLine = singleLine ? "true" : "false";
    return singleLine;
  }

  function applyPreviewPresentation(context) {
    const isTable = context?.kind === "table";
    const isFigure = context?.kind === "figure";
    const nextKind = isFigure ? "figure" : isTable ? "table" : "equation";
    preview.dataset.previewKind = nextKind;
    if (previewZoomKind !== nextKind) {
      previewZoomKind = nextKind;
      previewZoom = 1;
      previewAutoFitZoom = 1;
    }
    previewPopupUI?.setType(isFigure ? "image" : isTable ? "table" : "equation");
    previewTitle.textContent = isFigure
      ? "Figure preview"
      : isTable
        ? "Table preview"
        : "Equation preview";
    preview.setAttribute(
      "aria-label",
      isFigure
        ? "Live figure preview"
        : isTable
          ? "Live table preview"
          : "Live equation preview"
    );
    // Set a source-level line-mode immediately so cached previews already use
    // the correct cap. After KaTeX is mounted this is refined from rendered DOM.
    updateEquationPreviewLineMode(context);
    refreshPreviewZoom();
  }

  function showPreviewLoading(state, context) {
    const generation = ++previewLoadingGeneration;
    const contextId = previewContextId(state, context);
    const openingNewContext = (
      preview.hidden ||
      preview.dataset.smarttexStaging === "true" ||
      contextId !== activeContextId
    );
    preview.setAttribute("aria-busy", "true");
    if (previewLoadingGlobalGeneration !== null) {
      hideEnvironmentPopupLoadingSpinner(previewLoadingGlobalGeneration);
      previewLoadingGlobalGeneration = null;
    }
    if (openingNewContext) {
      output.replaceChildren();
      previewMeta.textContent = "";
      previewMeta.hidden = true;
      status.textContent = "";
      status.hidden = true;
      preview.classList.remove(
        "smarttex-preview-stale",
        "smarttex-preview-visible",
        "smarttex-preview-staging"
      );
      delete preview.dataset.smarttexStaging;
      caretPlacementState = null;
      lastSuccessfulMarkup = "";
      previewPositioned = false;
      // The header diagnostic describes how this opening was populated. Reset it
      // before a new environment opens; revealCachedPreviewMarkup() turns it on
      // only when cached content actually supplies the opening frame.
      setPopupOpenedFromCache(false);
      // Keep the popup completely hidden while its content is prepared. The
      // only visible feedback during a cold/opening render is the cursor-local
      // spinner.
      preview.hidden = true;
      const loadingAnchor = state?.smarttexHoverPreview === true
        ? (lastPointerScreen || state?.screen)
        : state?.screen;
      previewLoadingGlobalGeneration = showEnvironmentPopupLoadingSpinner(loadingAnchor);
    }
    applyPreviewPresentation(context);
    activePreviewContext = context;
    activePreviewState = state;
    previewLoadingIndicator.hidden = openingNewContext;
    status.hidden = true;
    if (!openingNewContext) {
      preview.hidden = false;
      preview.classList.add("smarttex-preview-visible");
    }
    refreshCaptionPreviewLock(state);
    return generation;
  }

  function hidePreviewLoading(generation = null) {
    if (generation !== null && generation !== previewLoadingGeneration) return;
    previewLoadingGeneration += 1;
    preview.removeAttribute("aria-busy");
    previewLoadingIndicator.hidden = true;
    if (previewLoadingGlobalGeneration !== null) {
      hideEnvironmentPopupLoadingSpinner(previewLoadingGlobalGeneration);
      previewLoadingGlobalGeneration = null;
    }
  }

  function contextRangeContainsState(range, state) {
    if (!range || !state) return false;
    if (String(state.fileName || "") !== String(range.fileName || "")) return false;
    const index = Number(state.cursorIndex);
    if (!Number.isInteger(index)) return false;
    return index >= Number(range.openStart) && index <= Number(range.closeEnd);
  }

  function dismissedRangeContainsState(range, state) {
    if (!range || !state) return false;
    if (String(state.fileName || "") !== String(range.fileName || "")) return false;
    const index = Number(state.cursorIndex);
    if (!Number.isInteger(index)) return false;
    const sourceLengthDelta = String(state.value || "").length -
      Number(range.sourceLength || String(state.value || "").length);
    const adjustedCloseEnd = Math.max(
      Number(range.openStart) || 0,
      (Number(range.closeEnd) || 0) + sourceLengthDelta
    );
    return index >= Number(range.openStart) && index <= adjustedCloseEnd;
  }

  function pruneDismissedPreviewContexts(state = previewStateForRender()) {
    for (const [contextId, range] of dismissedPreviewContexts) {
      if (!dismissedRangeContainsState(range, state)) {
        dismissedPreviewContexts.delete(contextId);
      }
    }
  }

  function previewContextIsDismissed(state, context) {
    if (!state || !context) return false;
    const contextId = previewContextId(state, context);
    const dismissed = dismissedPreviewContexts.get(contextId);
    if (dismissed) {
      const range = contextEnvironmentRange(context);
      dismissed.openStart = range.openStart;
      dismissed.closeEnd = range.closeEnd;
      dismissed.sourceLength = String(state.value || "").length;
      return true;
    }
    pruneDismissedPreviewContexts(state);
    return false;
  }

  function stateIsInsideDismissedPreview(state) {
    if (!state) return false;
    for (const range of dismissedPreviewContexts.values()) {
      if (dismissedRangeContainsState(range, state)) return true;
    }
    pruneDismissedPreviewContexts(state);
    return false;
  }


  function activeEnvironmentInputTransactionContainsState(state) {
    const transaction = activeEnvironmentInputTransaction;
    if (
      !transaction || !state || preview.hidden ||
      Date.now() > Number(transaction.expiresAt || 0) ||
      transaction.contextId !== activeContextId ||
      String(state.fileName || "") !== transaction.fileName
    ) {
      if (transaction && Date.now() > Number(transaction.expiresAt || 0)) {
        activeEnvironmentInputTransaction = null;
      }
      return false;
    }
    return true;
  }

  function refreshCaptionLockFromInputTransaction(state) {
    const transaction = activeEnvironmentInputTransaction;
    if (!transaction?.captionLocked || !captionPreviewLock || !state) return false;
    if (
      transaction.contextId !== activeContextId ||
      captionPreviewLock.contextId !== activeContextId ||
      captionPreviewLock.fileName !== String(state.fileName || "")
    ) return false;
    const sourceLength = String(state.value || "").length;
    const delta = sourceLength - Number(captionPreviewLock.sourceLength || sourceLength);
    captionPreviewLock.end = Math.max(
      Number(captionPreviewLock.start) || 0,
      Number(captionPreviewLock.end) + delta
    );
    captionPreviewLock.sourceLength = sourceLength;
    return true;
  }

  function hidePreview({ clearDismissal = true, force = false } = {}) {
    // Automatic lifecycle cleanup must never close a popup while the caret is
    // still inside the environment that owns it. CollabTeX emits independent
    // focus, scroll, hover and layout notifications around every keypress; any
    // one of them can otherwise tear down a popup after the live renderer has
    // already updated it, producing the visible close/reopen cycle. Use the
    // lightweight range ownership check first so this remains true even while
    // the edited TeX is temporarily unparsable. Explicit user closes and
    // settings/feature shutdowns pass force=true and remain authoritative.
    if (!force && activeEnvironmentInputTransactionContainsState(currentState)) {
      hidePreviewLoading();
      return false;
    }
    if (!force && activeEnvironmentPreviewContainsState(currentState)) {
      hidePreviewLoading();
      return false;
    }
    if (!force && liveEquationEditSessionContainsState(currentState)) {
      hidePreviewLoading();
      return false;
    }
    if (!force && captionPreviewIsLocked()) {
      hidePreviewLoading();
      return false;
    }
    captionPreviewLock = null;
    if (liveCaptionUpdateTimer !== null) {
      window.clearTimeout(liveCaptionUpdateTimer);
      liveCaptionUpdateTimer = null;
    }
    if (liveEquationUpdateTimer !== null) {
      window.clearTimeout(liveEquationUpdateTimer);
      liveEquationUpdateTimer = null;
    }
    activeFloatCaptionRenderInfo = null;
    liveEquationEditSession = null;
    activeEnvironmentInputTransaction = null;
    hidePreviewLoading();
    if (renderTimer !== null) {
      window.clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderGeneration += 1;
    preview.hidden = true;
    preview.classList.remove(
      "smarttex-preview-visible",
      "smarttex-preview-stale",
      "smarttex-preview-staging",
      "smarttex-preview-measuring",
      "smarttex-preview-intrinsic-measure",
      "smarttex-preview-scroll-fallback"
    );
    previewAutoFitZoom = 1;
    refreshPreviewZoom();
    delete preview.dataset.smarttexStaging;
    activeContextId = "";
    caretPlacementState = null;
    lastSuccessfulMarkup = "";
    previewPositioned = false;
    activePreviewContext = null;
    activePreviewState = null;
    previewPositionGeneration += 1;
    verticalScrollRepositionPending = false;
    clearPopupSelectionHighlight();
    // Environment previews and editor reference popups have independent
    // lifecycles. Only close a reference popup when its anchor belongs to the
    // environment preview that is being hidden; otherwise a pending editor
    // hover lookup would be cancelled before it can open.
    if (
      !activeEditorReferenceKey &&
      !referenceAutocompleteActive &&
      popupChainOriginatesInPreview()
    ) {
      hideCaptionReferencePopup();
    }
    status.hidden = true;
    if (clearDismissal) pruneDismissedPreviewContexts(previewStateForRender());
    return true;
  }

  function dismissPreview() {
    if (preview.hidden) return;
    if (activeContextId && activePreviewContext && activePreviewState) {
      const range = contextEnvironmentRange(activePreviewContext);
      dismissedPreviewContexts.set(activeContextId, {
        fileName: String(activePreviewState.fileName || ""),
        openStart: range.openStart,
        closeEnd: range.closeEnd,
        sourceLength: String(activePreviewState.value || "").length,
        hover: activePreviewState.smarttexHoverPreview === true
      });
    }
    hidePreview({ clearDismissal: false, force: true });
  }

  function stateCanShowPreview(state) {
    if (
      !popupInteractionReady() ||
      graphicAutocompleteActive ||
      graphicAutocompleteContextActive
    ) return false;
    const popupInteraction = (
      previewPointerInside ||
      Date.now() < previewInteractionUntil ||
      elementIsHovered(preview) ||
      preview.contains(document.activeElement) ||
      popupChainOriginatesInPreview() ||
      popupChainIsHovered()
    );
    if (
      !state ||
      (!state.focused && !popupInteraction) ||
      !Number.isInteger(state.cursorIndex) ||
      !state.screen
    ) {
      return false;
    }
    const fileName = String(state.fileName || "").trim();
    return !fileName || LATEX_FILE.test(fileName);
  }

  function contextEnvironmentRange(context) {
    const openStart = Number.isFinite(Number(context?.floatOpenStart))
      ? Number(context.floatOpenStart)
      : Number(context?.openStart) || 0;
    const closeEnd = Number.isFinite(Number(context?.floatCloseEnd))
      ? Number(context.floatCloseEnd)
      : Number(context?.closeEnd) || openStart;
    return {
      openStart: Math.max(0, openStart),
      closeEnd: Math.max(Math.max(0, openStart), closeEnd)
    };
  }

  function previewContextId(state, context) {
    const range = contextEnvironmentRange(context);
    return [
      state.fileName || "",
      range.openStart,
      context.kind,
      context.environment || context.delimiter || ""
    ].join(":");
  }

  function captionBounds(caption) {
    if (!caption) return null;
    const start = Number.isFinite(Number(caption.rawStart))
      ? Number(caption.rawStart)
      : Number(caption.start);
    const end = Number.isFinite(Number(caption.rawEnd))
      ? Number(caption.rawEnd)
      : Number(caption.end);
    return Number.isFinite(start) && Number.isFinite(end)
      ? { start, end: Math.max(start, end) }
      : null;
  }

  function setCaptionPreviewLockFromCaption(state, context, caption) {
    const bounds = captionBounds(caption);
    if (!state || !context || !bounds) return false;
    const contextId = previewContextId(state, context);
    captionPreviewLock = {
      contextId,
      fileName: String(state.fileName || ""),
      start: bounds.start,
      end: bounds.end,
      sourceLength: String(state.value || "").length
    };
    return true;
  }

  function captionPreviewIsLocked() {
    if (
      !captionPreviewLock ||
      preview.hidden ||
      !["figure", "table"].includes(activePreviewContext?.kind) ||
      !activePreviewState
    ) return false;
    return previewContextId(activePreviewState, activePreviewContext) ===
      captionPreviewLock.contextId;
  }

  function refreshCaptionPreviewLock(state) {
    if (
      !state ||
      state.focused === false ||
      !["figure", "table"].includes(activePreviewContext?.kind) ||
      preview.hidden
    ) {
      captionPreviewLock = null;
      return false;
    }
    // Caption typing is latency-sensitive. If the popup is already locked to
    // this figure, source edits normally only shift the caption end. Use the
    // stored bounds first and avoid rescanning the whole figure/table tree on
    // every keystroke. A full parse is still performed after typing settles.
    if (
      captionPreviewLock &&
      captionPreviewLock.contextId === activeContextId &&
      captionPreviewLock.fileName === String(state.fileName || "") &&
      Number.isInteger(Number(state.cursorIndex))
    ) {
      const lengthDelta = String(state.value || "").length -
        Number(captionPreviewLock.sourceLength || 0);
      const cursor = Number(state.cursorIndex);
      const adjustedEnd = Math.max(
        captionPreviewLock.start,
        captionPreviewLock.end + lengthDelta
      );
      if (cursor >= captionPreviewLock.start && cursor <= adjustedEnd) {
        captionPreviewLock.end = adjustedEnd;
        captionPreviewLock.sourceLength = String(state.value || "").length;
        return true;
      }
    }
    const container = captionContainerAtIndex(state);
    const bounds = captionBounds(container?.caption);
    const containerId = container
      ? previewContextId(state, container.context)
      : "";
    const activeId = previewContextId(activePreviewState || state, activePreviewContext);
    if (container?.kind === activePreviewContext?.kind && bounds && containerId === activeId) {
      captionPreviewLock = {
        contextId: activeId,
        fileName: String(state.fileName || ""),
        start: bounds.start,
        end: bounds.end,
        sourceLength: String(state.value || "").length
      };
      return true;
    }
    if (
      captionPreviewLock?.contextId === activeId &&
      captionPreviewLock.fileName === String(state.fileName || "") &&
      Number.isInteger(Number(state.cursorIndex))
    ) {
      const lengthDelta = String(state.value || "").length -
        Number(captionPreviewLock.sourceLength || 0);
      const cursor = Number(state.cursorIndex);
      if (
        cursor >= captionPreviewLock.start &&
        cursor <= Math.max(captionPreviewLock.start, captionPreviewLock.end + lengthDelta)
      ) return true;
    }
    captionPreviewLock = null;
    return false;
  }

  function stateContinuesActiveEnvironmentPreview(state) {
    if (
      preview.hidden ||
      !activePreviewContext ||
      !activePreviewState ||
      String(state?.fileName || "") !== String(activePreviewState.fileName || "") ||
      !Number.isInteger(Number(state?.cursorIndex)) ||
      includeGraphicsArgumentAtCursor(state) ||
      captionReferenceSuppressesEnvironmentPreview(state)
    ) return false;
    try {
      const context = findPreviewContext(state);
      if (context && previewContextId(state, context) === activeContextId) return true;
    } catch (_error) {
      // Fall through to the old environment range while the parser sees an
      // intermediate source state from the editor.
    }
    const range = contextEnvironmentRange(activePreviewContext);
    const lengthDelta = String(state.value || "").length -
      String(activePreviewState.value || "").length;
    const cursor = Number(state.cursorIndex);
    return (
      cursor >= range.openStart &&
      cursor <= Math.max(range.openStart, range.closeEnd + lengthDelta)
    );
  }

  function activeEnvironmentPreviewContainsState(state) {
    // The mounted preview belongs to its source environment until the caret
    // actually leaves that environment. This deliberately avoids reparsing: a
    // half-typed equation/caption can temporarily be invalid LaTeX, but that is
    // not a reason to close and reopen the popup. The old environment range is
    // adjusted by the document-length delta so insertions/deletions made inside
    // the environment keep the ownership interval in sync. Explicit user
    // closes still use force=true and therefore remain authoritative.
    if (
      preview.hidden ||
      !activePreviewContext ||
      !activePreviewState ||
      !state ||
      String(state.fileName || "") !== String(activePreviewState.fileName || "") ||
      !Number.isInteger(Number(state.cursorIndex))
    ) return false;
    const range = contextEnvironmentRange(activePreviewContext);
    const lengthDelta = String(state.value || "").length -
      String(activePreviewState.value || "").length;
    const cursor = Number(state.cursorIndex);
    return (
      cursor >= range.openStart &&
      cursor <= Math.max(range.openStart, range.closeEnd + lengthDelta)
    );
  }

  function activeEquationTypingContext(state) {
    if (
      preview.hidden ||
      previewElementKind(activePreviewContext) !== "equation" ||
      !activePreviewState ||
      !state ||
      state.focused === false ||
      String(state.fileName || "") !== String(activePreviewState.fileName || "") ||
      !Number.isInteger(Number(state.cursorIndex))
    ) return null;

    const oldRange = contextEnvironmentRange(activePreviewContext);
    const sourceDelta = String(state.value || "").length -
      String(activePreviewState.value || "").length;
    const adjustedCloseEnd = Math.max(oldRange.openStart, oldRange.closeEnd + sourceDelta);
    const cursor = Number(state.cursorIndex);
    if (cursor < oldRange.openStart || cursor > adjustedCloseEnd) return null;

    // Prefer a newly parsed context when the current keystroke still forms valid
    // LaTeX. While the editor is between tokens (for example just after typing a
    // backslash or brace), retain a range-adjusted copy of the previous equation
    // context. This prevents the popup lifecycle from interpreting a transient
    // parser miss as "the cursor left the equation".
    try {
      const parsed = findPreviewContext(state);
      if (previewElementKind(parsed) === "equation" && previewContextId(state, parsed) === activeContextId) {
        return parsed;
      }
    } catch (_error) {
      // The stable context below intentionally covers transient parse failures.
    }

    const next = { ...activePreviewContext };
    const shiftField = (name) => {
      if (Number.isFinite(Number(next[name])) && Number(next[name]) > oldRange.openStart) {
        next[name] = Number(next[name]) + sourceDelta;
      }
    };
    for (const name of ["contentEnd", "closeStart", "closeEnd", "floatCloseEnd"]) shiftField(name);
    const contentStart = Math.max(0, Number(next.contentStart) || oldRange.openStart);
    const contentEnd = Math.max(
      contentStart,
      Math.min(String(state.value || "").length, Number(next.contentEnd) || adjustedCloseEnd)
    );
    next.source = String(state.value || "").slice(contentStart, contentEnd);
    next.cursorOffset = Math.max(0, Math.min(next.source.length, cursor - contentStart));
    return next;
  }

  function refreshLiveEquationEditSession(state, context) {
    if (!state || !context || previewElementKind(context) !== "equation") return false;
    const range = contextEnvironmentRange(context);
    liveEquationEditSession = {
      fileName: String(state.fileName || ""),
      openStart: range.openStart,
      closeEnd: range.closeEnd,
      sourceLength: String(state.value || "").length,
      contextId: previewContextId(state, context)
    };
    return true;
  }

  function liveEquationEditSessionContainsState(state) {
    const session = liveEquationEditSession;
    if (
      !session || !state || preview.hidden || previewElementKind(activePreviewContext) !== "equation" ||
      String(state.fileName || "") !== session.fileName ||
      !Number.isInteger(Number(state.cursorIndex))
    ) return false;

    // All edits in this session occur while the caret is inside the equation,
    // so the opening position stays fixed and only the closing boundary moves
    // with the document-length delta. This inexpensive range check is robust to
    // transient parser/focus/screen notifications emitted by CollabTeX.
    const delta = String(state.value || "").length - Number(session.sourceLength || 0);
    const adjustedClose = Math.max(session.openStart, session.closeEnd + delta);
    const cursor = Number(state.cursorIndex);
    if (cursor < session.openStart || cursor > adjustedClose) {
      liveEquationEditSession = null;
      return false;
    }
    session.closeEnd = adjustedClose;
    session.sourceLength = String(state.value || "").length;
    return true;
  }

  function cancelPendingEnvironmentPreviewRender() {
    // Live editing/caret movement inside an already mounted environment preview
    // must never race a previously queued generic render transaction. A stale
    // scheduleRender() job can otherwise finish after the in-place update and
    // replace the popup DOM, which looks exactly like a close/reopen cycle.
    // Invalidate both queued and already-running generic render generations,
    // but deliberately keep the mounted popup itself untouched.
    if (renderTimer !== null) {
      window.clearTimeout(renderTimer);
      renderTimer = null;
    }
    scheduledPreviewHint = null;
    renderGeneration += 1;
    hidePreviewLoading();
  }

  function advanceActiveEnvironmentRangeForSourceEdit(state) {
    // Figure/table caption updates are intentionally lightweight and do not
    // rebuild the complete environment context on every keystroke. Keep the
    // stored closing boundaries in step with the edited document so the next
    // state notification still belongs to the same mounted popup. Without this
    // adjustment, activePreviewState would contain the new source length while
    // activePreviewContext retained the old close position, causing the very
    // next keypress to be misclassified as leaving/re-entering the environment.
    if (!activePreviewContext || !activePreviewState || !state) return;
    const delta = String(state.value || "").length -
      String(activePreviewState.value || "").length;
    if (!delta) return;
    const openStart = contextEnvironmentRange(activePreviewContext).openStart;
    const next = { ...activePreviewContext };
    for (const name of ["contentEnd", "closeStart", "closeEnd", "floatContentEnd", "floatCloseEnd"]) {
      if (Number.isFinite(Number(next[name])) && Number(next[name]) > openStart) {
        next[name] = Number(next[name]) + delta;
      }
    }
    activePreviewContext = next;
  }

  async function renderLiveEquationInPlace(state, context) {
    // Keyboard input intentionally aborts older expensive SmartTeX work. A
    // generic popup render can therefore remain on the interaction-task stack
    // in an aborted state for a short time while its async transaction unwinds.
    // latex-context.js checkpoints against the newest active task; without a
    // fresh task here, the in-place equation update inherits that stale aborted
    // task and immediately throws "SmartTeX task aborted: keyboard". Give every
    // live equation refresh its own current-generation task so cancellation
    // kills stale work but never the update caused by the same keypress.
    const liveTaskToken = interactionTasks?.begin?.("popup-live-equation") || null;
    try {
    if (
      !state || !context || previewElementKind(context) !== "equation" || preview.hidden ||
      previewElementKind(activePreviewContext) !== "equation" ||
      String(state.fileName || "") !== String(activePreviewState?.fileName || "")
    ) return false;

    const expectedContextId = activeContextId;
    const nextContextId = previewContextId(state, context);
    if (expectedContextId && nextContextId !== expectedContextId) return false;

    const numbering = contextTools.equationPreviewNumbering?.(state.value, context) || null;
    const hasSelection = Number(state.selectionFrom) !== Number(state.selectionTo);
    if (!hasSelection) {
      // The live path must update the visual caret as well as the equation text.
      // The 2.1.42 cursor-only shortcut kept the popup stable but skipped this
      // caret-placement calculation, so arrow-key movement stopped moving the
      // caret marker in the preview. Reuse the same command-aware placement
      // logic as a cold render while keeping the existing popup DOM mounted.
      caretPlacementState = contextTools.resolveCaretPlacement(
        context.source,
        context.cursorOffset,
        caretPlacementState
      );
    }
    const commandSide = hasSelection ? null : (caretPlacementState?.commandSide || null);
    const body = contextTools.previewBody(context, commandSide, numbering, !hasSelection);
    let prepared;
    try {
      prepared = contextTools.prepareDocumentCommands(
        state.value,
        Number(context.openStart) || 0,
        body
      );
    } catch (_error) {
      // Keep the last valid popup rendering while document-level macros are in
      // an intermediate state; the next keystroke will retry this transaction.
      return false;
    }

    const cursorInsideOperator = Boolean(
      !hasSelection &&
      (
        contextTools.cursorInsideControlSequence?.(context.source, context.cursorOffset) ||
        contextTools.cursorAtProtectedAtomBoundary?.(context.source, context.cursorOffset)
      )
    );
    const liveMacros = {
      ...prepared.macros,
      "\\label": { tokens: [], numArgs: 1 },
      "\\nonumber": "",
      "\\notag": "",
      "\\SmartTeXCaret": `\\htmlClass{${
        cursorInsideOperator
          ? "smarttex-rendered-operator-caret"
          : "smarttex-rendered-caret"
      }}{\\vphantom{|}}`,
      "\\SmartTeXOperatorCaret":
        "\\htmlClass{smarttex-rendered-operator-caret}{\\vphantom{|}}"
    };

    const staging = document.createElement("div");
    try {
      katex.render(prepared.body, staging, {
        displayMode: Boolean(context.display ?? true),
        throwOnError: true,
        strict: "ignore",
        trust: trustedKatexCommand,
        maxExpand: 1000,
        maxSize: 25,
        macros: liveMacros
      });
      if (!staging.firstElementChild && !String(staging.textContent || "").trim()) {
        return false;
      }
    } catch (_error) {
      // A caret marker can be temporarily illegal inside a document-specific
      // macro. Retry the unchanged equation without the marker; this keeps the
      // popup mounted and the equation current instead of falling back to the
      // generic close/open renderer. The next cursor/key event retries the caret.
      try {
        const fallbackBody = contextTools.previewBody(context, null, numbering, false);
        const fallbackPrepared = contextTools.prepareDocumentCommands(
          state.value,
          Number(context.openStart) || 0,
          fallbackBody
        );
        staging.replaceChildren();
        katex.render(fallbackPrepared.body, staging, {
          displayMode: Boolean(context.display ?? true),
          throwOnError: true,
          strict: "ignore",
          trust: trustedKatexCommand,
          maxExpand: 1000,
          maxSize: 25,
          macros: {
            ...fallbackPrepared.macros,
            "\\label": { tokens: [], numArgs: 1 },
            "\\nonumber": "",
            "\\notag": ""
          }
        });
      } catch (_fallbackError) {
        // Deliberately retain the previous valid equation for incomplete TeX.
        return false;
      }
    }

    if (preview.hidden || activeContextId !== expectedContextId) return false;

    // Preserve the exact popup screen position. The live fit may change width,
    // height, or equation scale, but typing must never invoke the positioning
    // policy or make the popup jump to another side of the caret.
    const pinnedRect = preview.getBoundingClientRect();
    const pinnedLeftStyle = preview.style.left;
    const pinnedTopStyle = preview.style.top;
    const pinnedLeft = pinnedRect.left;
    const pinnedTop = pinnedRect.top;

    output.replaceChildren(...staging.childNodes);
    activePreviewContext = context;
    activePreviewState = { ...state };
    refreshLiveEquationEditSession(state, context);
    updateEquationPreviewLineMode(context, output);
    lastSuccessfulMarkup = output.innerHTML;
    status.hidden = true;
    status.removeAttribute("title");
    preview.hidden = false;
    preview.classList.add("smarttex-preview-visible");

    const preparedFit = {
      maxWidth: Number(preview.dataset.smarttexAutoFitMaxWidth) || undefined,
      maxHeight: Number(preview.dataset.smarttexAutoFitMaxHeight) || undefined
    };
    applyPreviewAutoFitPolicyNow(preparedFit, {
      allowGrow: preview.dataset.smarttexTemporarySized !== "true"
    });
    preview.style.left = pinnedLeftStyle || `${Math.round(pinnedLeft)}px`;
    preview.style.top = pinnedTopStyle || `${Math.round(pinnedTop)}px`;
    previewPositioned = true;
    // Refitting can enlarge the popup toward the caret. Preserve the top-left
    // position unless that new rectangle enters the cursor safety margin.
    positionPreviewAtCursor();

    // Store the newly valid source rendering immediately. Geometry can be
    // measured later by the idle warmer; the markup itself is enough to make a
    // subsequent opening a cache hit; background warming may add geometry later.
    const markup = canonicalPreviewBaseMarkup(lastSuccessfulMarkup);
    if (markup) {
      const baseKey = previewBaseCacheKey(state, context);
      previewCacheSet(previewBaseRenderCache, baseKey, markup, null);
      previewCacheSet(previewRenderCache, previewExactCacheKey(state, context), markup, null);
    }
    return true;
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) return false;
      throw error;
    } finally {
      if (liveTaskToken) interactionTasks?.end?.(liveTaskToken);
    }
  }

  function scheduleLiveEquationUpdate(state, context, { immediate = false } = {}) {
    if (liveEquationUpdateTimer !== null) window.clearTimeout(liveEquationUpdateTimer);
    if (!context || preview.hidden) return;
    cancelPendingEnvironmentPreviewRender();
    refreshLiveEquationEditSession(state, context);

    // Do not route equation typing/caret movement through scheduleRender(). That
    // generic path owns cold opening, spinner staging, context switching and
    // hide/reopen decisions. Live editing mutates the already-open popup in
    // place. Cursor-only moves are dispatched in a microtask so the rendered
    // caret tracks arrow keys without the 48 ms typing debounce.
    const run = () => {
      liveEquationUpdateTimer = null;
      if (preview.hidden || previewElementKind(activePreviewContext) !== "equation") return;
      void renderLiveEquationInPlace(state, context);
    };
    if (immediate) {
      queueMicrotask(run);
      return;
    }
    liveEquationUpdateTimer = window.setTimeout(run, LIVE_EQUATION_UPDATE_DELAY_MS);
  }


  function documentAnalysisForState(state) {
    const source = String(state?.value || "");
    const fileName = String(state?.fileName || "");
    if (
      documentAnalysisCache.source !== source ||
      documentAnalysisCache.fileName !== fileName
    ) {
      documentAnalysisCache = {
        fileName,
        source,
        equations: null,
        equationRenderData: new Map()
      };
    }
    return documentAnalysisCache;
  }

  function activeEquationContextForState(state) {
    const context = activePreviewContext;
    const previousState = activePreviewState;
    if (
      !state ||
      !context ||
      !previousState ||
      context.kind === "table" ||
      context.kind === "figure" ||
      String(previousState.fileName || "") !== String(state.fileName || "") ||
      String(previousState.value || "") !== String(state.value || "")
    ) {
      return null;
    }
    const cursor = Number(state.cursorIndex);
    const contentStart = Number(context.contentStart);
    const contentEnd = Number(context.contentEnd);
    if (
      !Number.isInteger(cursor) ||
      !Number.isFinite(contentStart) ||
      !Number.isFinite(contentEnd) ||
      cursor < contentStart ||
      cursor > contentEnd
    ) {
      return null;
    }
    return {
      ...context,
      cursorOffset: cursor - contentStart
    };
  }

  function cachedEquationContextForState(state) {
    if (!state || !enabledFeatures.equations) return null;
    const cache = documentAnalysisForState(state);
    if (!cache.equations) {
      cache.equations = typeof contextTools.analyzeEquations === "function"
        ? contextTools.analyzeEquations(cache.source)
        : contextTools.equationContexts(cache.source);
    }
    if (typeof contextTools.findEquationContextFromAnalysis === "function") {
      return contextTools.findEquationContextFromAnalysis(
        cache.source,
        state.cursorIndex,
        cache.equations
      );
    }
    return contextTools.findEquationContext(cache.source, state.cursorIndex);
  }

  function equationRenderDataForState(state, context) {
    const cache = documentAnalysisForState(state);
    const key = Number(context?.openStart);
    if (cache.equationRenderData.has(key)) {
      return cache.equationRenderData.get(key);
    }
    if (!cache.equations) {
      cache.equations = typeof contextTools.analyzeEquations === "function"
        ? contextTools.analyzeEquations(cache.source)
        : contextTools.equationContexts(cache.source);
    }
    const numbering = cache.equations?.numberingByOpenStart?.get?.(key) ||
      contextTools.equationPreviewNumbering(cache.source, context);
    const commandContext = typeof contextTools.prepareDocumentCommandContext === "function"
      ? contextTools.prepareDocumentCommandContext(cache.source, context.openStart)
      : null;
    const data = { numbering, commandContext };
    cache.equationRenderData.set(key, data);
    return data;
  }

  function captionContainerAtIndex(state, indexValue = state?.cursorIndex) {
    if (!state) return null;
    const source = String(state.value || "");
    const index = Math.max(0, Math.min(Number(indexValue) || 0, source.length));
    const candidates = [];

    if (enabledFeatures.figures) {
      const figure = contextTools.findFigureContext?.(source, index);
      if (figure) candidates.push({ context: figure, kind: "figure" });
    }
    if (enabledFeatures.tables) {
      const table = (
        contextTools.findTableFloatContext?.(source, index) ||
        contextTools.findTableContext?.(source, index)
      );
      if (table) candidates.push({ context: table, kind: "table" });
    }

    return candidates
      .map((candidate) => ({
        ...candidate,
        caption: contextTools.floatCaption?.(
          source,
          candidate.context,
          candidate.kind
        ) || null
      }))
      .filter((candidate) => (
        candidate.caption &&
        index >= Number(candidate.caption.rawStart ?? candidate.caption.start) &&
        index <= Number(candidate.caption.rawEnd ?? candidate.caption.end)
      ))
      .sort((left, right) => (
        (left.context.closeEnd - left.context.openStart) -
        (right.context.closeEnd - right.context.openStart)
      ))[0] || null;
  }

  function captionReferenceSuppressesEnvironmentPreview(state) {
    if (!captionContainerAtIndex(state)) return false;
    if (referenceAutocompleteActive || captionInnerReferenceActive) return true;
    const interaction = editorReferenceInteractionAtIndex(
      state.value,
      state.cursorIndex
    );
    if (!interaction) return false;
    return state.smarttexHoverPreview === true
      ? referencePopupUsesHover()
      : !referencePopupUsesHover();
  }

  function lastFloatContextForState(state) {
    const hint = lastFloatPreviewContextHint;
    if (!hint || !state) return null;
    if (String(hint.fileName || "") !== String(state.fileName || "")) return null;
    if (String(hint.source || "") !== String(state.value || "")) return null;
    const context = hint.context;
    const cursor = Number(state.cursorIndex);
    const range = contextEnvironmentRange(context);
    return Number.isInteger(cursor) && cursor >= range.openStart && cursor <= range.closeEnd
      ? context
      : null;
  }

  function rememberFloatPreviewContext(state, context) {
    if (!state || !context || !["figure", "table"].includes(context.kind)) return context;
    lastFloatPreviewContextHint = {
      fileName: String(state.fileName || ""),
      source: String(state.value || ""),
      context
    };
    return context;
  }

  function findPreviewContext(state) {
    if (!state) return null;
    // The includegraphics filename argument owns this interaction. Its
    // SmartTeX list and (when enabled) selected-file preview are the only
    // surfaces that may be shown while the caret is between these braces.
    if (includeGraphicsArgumentAtCursor(state)) return null;
    const equation = enabledFeatures.equations
      ? (activeEquationContextForState(state) || cachedEquationContextForState(state))
      : null;

    // Equation cursor motion is the latency-critical path. Return immediately
    // instead of scanning tables and figures that cannot be the more specific
    // context while the cursor is already inside an equation.
    if (equation) return equation;

    // A reference popup or autocomplete list inside a caption is the inner
    // interaction. Hide the enclosing figure/table preview until the cursor or
    // hover position leaves that reference.
    if (captionReferenceSuppressesEnvironmentPreview(state)) return null;

    const cachedFloat = lastFloatContextForState(state);
    if (cachedFloat) return cachedFloat;

    const floatContext = [
      enabledFeatures.tables
        ? (
          contextTools.findTableContext(state.value, state.cursorIndex) ||
          contextTools.findTableFloatContext?.(state.value, state.cursorIndex)
        )
        : null,
      enabledFeatures.figures
        ? contextTools.findFigureContext(state.value, state.cursorIndex)
        : null
    ]
      .filter(Boolean)
      .sort((left, right) => (
        (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart)
      ))[0] || null;
    return rememberFloatPreviewContext(state, floatContext);
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 5000) {
    const requestId = `figure-preview-${Date.now()}-${++requestCounter}`;
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

  function figurePathStem(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      .replace(/\.[a-z0-9]{1,8}$/i, "")
      .toLowerCase();
  }

  function directFigureFile(pathValue) {
    const path = String(pathValue || "").trim();
    const targetName = path.replace(/\\/g, "/").split("/").pop();
    const item = [...document.querySelectorAll('.file-tree-list [role="treeitem"]')]
      .find((candidate) => {
        const candidatePath = String(
          candidate.getAttribute("data-path") ||
          candidate.getAttribute("data-file-path") ||
          candidate.getAttribute("aria-label") ||
          candidate.querySelector(
            ".item-name-button span, .item-name span, .entity-name span"
          )?.textContent ||
          ""
        ).trim();
        const candidateName = candidatePath.replace(/\\/g, "/").split("/").pop();
        return (
          figurePathStem(candidatePath) === figurePathStem(path) ||
          figurePathStem(candidateName) === figurePathStem(targetName)
        );
      });
    if (!item) return null;
    const resolvedPath = String(
      item.getAttribute("data-path") ||
      item.getAttribute("data-file-path") ||
      item.getAttribute("aria-label") ||
      path
    ).trim();
    const explicit = (
      item.getAttribute("data-download-url") ||
      item.getAttribute("data-url") ||
      item.querySelector("a[href]")?.href ||
      ""
    ).trim();
    if (explicit) {
      return {
        path: resolvedPath,
        url: new URL(explicit, window.location.href).href
      };
    }
    const fileId = (
      item.getAttribute("data-file-id") ||
      item.getAttribute("data-entity-id") ||
      item.getAttribute("data-id") ||
      ""
    ).trim();
    const projectId = window.location.pathname.match(/\/project\/([^/?#]+)/i)?.[1] || "";
    return fileId && projectId ? {
      path: resolvedPath,
      url: `${window.location.origin}/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`
    } : null;
  }

  function figurePopupPlaceholder(path, resolving = false) {
    const placeholder = document.createElement("div");
    placeholder.className = "smarttex-figure-popup-placeholder";
    if (resolving) placeholder.classList.add("smarttex-figure-popup-resolving");
    placeholder.textContent = resolving ? `Locating ${path}…` : path;
    return placeholder;
  }

  async function replaceFigurePopupMedia(placeholder, path, url) {
    const renderer = globalThis.SmartTeXFigureRenderer;
    if (!renderer?.createMedia) throw new Error("The figure renderer is unavailable.");
    const media = await renderer.createMedia(path, url, {
      imageClass: "smarttex-figure-popup-image",
      pdfClass: "smarttex-figure-popup-image smarttex-figure-popup-pdf"
    });
    try {
      await media.decode?.();
    } catch (error) {
      // A cold image must remain behind its visible resolving placeholder until
      // it has real intrinsic geometry. Replacing the placeholder earlier made
      // the first popup collapse to a caption-only box while a second opening
      // worked from the decoded cache.
      if (!(media.complete && Number(media.naturalWidth) > 0)) {
        renderer.invalidateMediaUrl?.(url);
        throw error;
      }
    }
    if ("naturalWidth" in media && !(Number(media.naturalWidth) > 0)) {
      renderer.invalidateMediaUrl?.(url);
      throw new Error("The resolved figure did not decode as an image.");
    }
    if (!placeholder.parentNode) return;
    for (const attribute of [
      "data-smarttex-local-width-ratio",
      "data-smarttex-fixed-width-px",
      "data-smarttex-image-scale"
    ]) {
      if (placeholder.hasAttribute(attribute)) {
        media.setAttribute(attribute, placeholder.getAttribute(attribute));
      }
    }
    const layout = placeholder.closest(".smarttex-figure-layout");
    placeholder.replaceWith(media);
    renderer.observePopupLayout?.(layout);
    window.requestAnimationFrame(() => {
      positionPreview();
      repositionReferencePopups();
    });
  }

  async function resolveFigurePopupFile(
    path,
    placeholder,
    attempt = 0,
    forceProjectResolution = false
  ) {
    try {
      const direct = directFigureFile(path);
      if (!forceProjectResolution && direct?.url) {
        await replaceFigurePopupMedia(placeholder, direct.path || path, direct.url);
        return true;
      }

      const response = await bridgeRequest("resolveProjectFile", { path });
      if (!placeholder.parentNode) return false;
      const file = response?.file;
      if (!file?.url) throw new Error("Figure URL is unavailable.");
      await replaceFigurePopupMedia(placeholder, file.path || path, file.url);
      return true;
    } catch (_error) {
      if (!placeholder.parentNode) return false;
      if (attempt < 2) {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 160 * (attempt + 1));
        });
        if (!placeholder.parentNode) return false;
        return resolveFigurePopupFile(path, placeholder, attempt + 1, true);
      }
      placeholder.classList.remove("smarttex-figure-popup-resolving");
      placeholder.textContent = path;
      placeholder.title = "The figure file could not be resolved from the CollabTeX project.";
      return false;
    }
  }



  function includeGraphicsArgumentAtCursor(state) {
    if (!state || !Number.isInteger(state.cursorIndex)) return null;
    const source = String(state.value || "");
    const cursor = Math.max(0, Math.min(state.cursorIndex, source.length));

    // Autocomplete detection runs on editor-state updates. Restrict the regex
    // to the current logical line instead of scanning the complete document
    // prefix after every keystroke. An includegraphics argument cannot legally
    // cross an unescaped line break in this completion context.
    const scanStart = Math.max(0, cursor - 4096);
    const masked = contextTools.maskIgnoredLatex(source);
    const before = masked.slice(scanStart, cursor);
    const command = before.match(/\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^{}]*)$/i);
    if (!command) return null;
    const argumentStart = cursor - String(command[1] || "").length;
    const closingBrace = source.indexOf("}", cursor);
    return {
      fragment: String(command[1] || ""),
      start: argumentStart,
      end: closingBrace >= 0 ? closingBrace : cursor
    };
  }

  function visibleNativeGraphicAutocomplete() {
    const candidates = [
      ...document.querySelectorAll(
        ".ace_autocomplete, .ace_autocomplete_popup, [role='listbox']"
      )
    ];
    return candidates.find((candidate) => {
      if (candidate.id === "smarttex-reference-autocomplete-popup" ||
          candidate.id === "smarttex-citation-autocomplete-popup") return false;
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rect.width > 40 && rect.height > 20 &&
        Boolean(candidate.querySelector(
          ".ace_selected, [aria-selected='true'], .selected, [class*='selected']"
        ));
    }) || null;
  }

  function nativeGraphicAutocompleteOwnerFromNode(node) {
    const owner = node?.closest?.(
      ".ace_autocomplete, .ace_autocomplete_popup, [role='listbox']"
    ) || null;
    if (!owner || owner.id === "smarttex-reference-autocomplete-popup" ||
        owner.id === "smarttex-citation-autocomplete-popup") return null;
    const style = getComputedStyle(owner);
    const rect = owner.getBoundingClientRect();
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      rect.width <= 40 ||
      rect.height <= 20
    ) return null;
    return owner;
  }

  function hoveredNativeGraphicEntry(node, owner) {
    if (!owner || !node) return null;
    const entry = node.closest?.(
      ".ace_line, [role='option'], .autocomplete-entry, " +
      "[class*='completion'][class*='item'], [class*='option']"
    ) || null;
    return entry && entry !== owner && owner.contains(entry) ? entry : null;
  }

  function selectedNativeGraphicEntry(owner) {
    if (!owner) return null;
    return owner.querySelector(
      ".ace_line.ace_selected, .ace_selected, [role='option'][aria-selected='true'], " +
      ".selected[role='option'], [class*='option'][class*='selected']"
    );
  }

  function graphicPathFromSuggestion(entry) {
    const explicitPath = String(entry?.dataset?.smarttexFigurePath || "").trim();
    if (explicitPath) return explicitPath;
    const text = String(entry?.textContent || "").replace(/\u00a0/g, " ").trim();
    if (!text) return "";
    const command = text.match(/\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/i);
    if (command) return String(command[1] || "").trim();
    const path = text.match(/(?:^|\s)((?:[^\s{}]+\/)*[^\s{}]+?\.(?:png|jpe?g|gif|svg|pdf|eps|webp))(?:\s|$)/i);
    if (path) return String(path[1] || "").trim();
    return "";
  }

  function positionGraphicAutocompletePreview(owner) {
    if (!owner || graphicAutocompletePreview.hidden) return;
    const ownerRect = owner.getBoundingClientRect();
    const popupRect = graphicAutocompletePreview.getBoundingClientRect();
    const margin = 10;
    const gap = 10;
    const rightSpace = window.innerWidth - ownerRect.right - gap - margin;
    const leftSpace = ownerRect.left - gap - margin;
    let left;
    if (rightSpace >= Math.min(popupRect.width, 260) || rightSpace >= leftSpace) {
      left = Math.min(window.innerWidth - popupRect.width - margin, ownerRect.right + gap);
    } else {
      left = Math.max(margin, ownerRect.left - popupRect.width - gap);
    }
    const top = Math.max(
      margin,
      Math.min(ownerRect.top, window.innerHeight - popupRect.height - margin)
    );
    graphicAutocompletePreview.style.left = `${Math.round(left)}px`;
    graphicAutocompletePreview.style.top = `${Math.round(top)}px`;
  }

  function hideGraphicAutocompletePreview() {
    graphicAutocompleteGeneration += 1;
    graphicAutocompleteActive = false;
    graphicAutocompleteClickPreview = false;
    graphicAutocompletePath = "";
    graphicAutocompleteSpinner.hidden = true;
    graphicAutocompletePreview.removeAttribute("aria-busy");
    graphicAutocompletePreview.hidden = true;
    graphicAutocompletePreview.classList.remove("smarttex-preview-visible");
    graphicAutocompletePreview.classList.remove(
      "smarttex-graphic-autocomplete-click-preview"
    );
    graphicAutocompleteClose.hidden = false;
    graphicAutocompleteOutput.replaceChildren();
  }

  function dismissGraphicAutocompleteClickPreview() {
    customGraphicAutocompleteSelectionPath = "";
    customGraphicAutocompletePreviewSuppressed = true;
    hideGraphicAutocompletePreview();
  }

  graphicAutocompleteClose.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  graphicAutocompleteClose.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissGraphicAutocompleteClickPreview();
  });
  graphicAutocompletePreview.addEventListener("pointerleave", () => {
    if (graphicAutocompletePreview.classList.contains("smarttex-popup-resizing")) return;
    if (graphicAutocompleteClickPreview) {
      dismissGraphicAutocompleteClickPreview();
    }
  });

  function graphicAutocompleteMediaAspect(media) {
    if (!media) return null;
    const width = Number(media.naturalWidth) ||
      Number(media.dataset?.smarttexPdfPreviewWidth) ||
      Number(media.width) || 0;
    const height = Number(media.naturalHeight) ||
      Number(media.dataset?.smarttexPdfPreviewHeight) ||
      Number(media.height) || 0;
    if (!(width > 0 && height > 0)) return null;
    const aspect = width / height;
    return Number.isFinite(aspect) && aspect > 0 ? aspect : null;
  }

  function fitGraphicAutocompletePreviewToMedia(media) {
    const aspect = graphicAutocompleteMediaAspect(media);
    if (!aspect || !graphicAutocompletePreview || !graphicAutocompleteOutput) return;

    // Size the preview's media box to the actual figure aspect ratio instead
    // of keeping a fixed, nearly-square preview area.  The heading remains
    // outside this box, while the figure itself receives no unused letterbox
    // space except for the normal 12 px preview padding.
    const viewportMargin = 12;
    const outputPadding = 24;
    const maxPopupWidth = Math.max(120, Math.min(520, window.innerWidth - viewportMargin * 2));
    const maxPopupHeight = Math.max(
      150,
      Math.min(560, window.innerHeight - viewportMargin * 2, window.innerHeight * 0.68)
    );
    const heading = graphicAutocompletePreview.querySelector(".smarttex-preview-heading");
    const headingHeight = Math.max(0, heading?.getBoundingClientRect?.().height || 0);
    const maxMediaWidth = Math.max(40, maxPopupWidth - outputPadding);
    const maxMediaHeight = Math.max(40, maxPopupHeight - headingHeight - outputPadding);

    let mediaWidth = maxMediaWidth;
    let mediaHeight = mediaWidth / aspect;
    if (mediaHeight > maxMediaHeight) {
      mediaHeight = maxMediaHeight;
      mediaWidth = mediaHeight * aspect;
    }

    const popupWidth = Math.max(80, Math.ceil(mediaWidth + outputPadding));
    const outputHeight = Math.max(80, Math.ceil(mediaHeight + outputPadding));
    if (graphicAutocompletePreview.dataset.smarttexUserSized !== "true") {
      graphicAutocompletePreview.style.width = `${popupWidth}px`;
      graphicAutocompletePreview.style.maxHeight = `${Math.ceil(maxPopupHeight)}px`;
      graphicAutocompleteOutput.style.height = `${outputHeight}px`;
    }
  }

  function renderGraphicAutocompletePreview(path, owner) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath || normalizedPath === graphicAutocompletePath && !graphicAutocompletePreview.hidden) {
      positionGraphicAutocompletePreview(owner);
      return;
    }
    const generation = ++graphicAutocompleteGeneration;
    graphicAutocompletePath = normalizedPath;
    // Reset sizing while a different file is resolving; the final dimensions
    // are set from the resolved media's intrinsic aspect ratio below.
    if (graphicAutocompletePreview.dataset.smarttexUserSized !== "true") {
      graphicAutocompletePreview.style.width = "";
      graphicAutocompletePreview.style.maxHeight = "";
      graphicAutocompleteOutput.style.height = "";
    }
    graphicAutocompleteMeta.textContent = normalizedPath;
    graphicAutocompleteMeta.title = normalizedPath;

    const figure = document.createElement("figure");
    figure.className = "smarttex-figure-popup smarttex-graphic-autocomplete-figure";
    const viewport = document.createElement("div");
    viewport.className = "smarttex-figure-popup-viewport smarttex-graphic-autocomplete-viewport";
    const media = document.createElement("div");
    media.className = "smarttex-figure-popup-media smarttex-graphic-autocomplete-media";
    const placeholder = figurePopupPlaceholder(normalizedPath, true);
    media.appendChild(placeholder);
    viewport.appendChild(media);
    figure.appendChild(viewport);
    graphicAutocompleteOutput.replaceChildren(figure);
    graphicAutocompleteSpinner.hidden = false;
    graphicAutocompletePreview.setAttribute("aria-busy", "true");
    graphicAutocompletePreview.hidden = false;
    graphicAutocompletePreview.classList.add("smarttex-preview-visible");
    graphicAutocompletePreview.classList.toggle(
      "smarttex-graphic-autocomplete-click-preview",
      graphicAutocompleteClickPreview
    );
    graphicAutocompleteClose.hidden = false;
    positionGraphicAutocompletePreview(owner);

    const showFailure = () => {
      if (generation !== graphicAutocompleteGeneration || !placeholder.isConnected) return;
      graphicAutocompleteSpinner.hidden = true;
      graphicAutocompletePreview.removeAttribute("aria-busy");
      placeholder.classList.remove("smarttex-figure-popup-resolving");
      placeholder.textContent = normalizedPath;
      placeholder.title = "The selected figure could not be previewed.";
      // Permit a later selection/state notification for the same path to try
      // again instead of treating the failed placeholder as a completed cache.
      graphicAutocompletePath = "";
    };
    const watchdog = window.setTimeout(() => {
      if (generation !== graphicAutocompleteGeneration) return;
      graphicAutocompleteGeneration += 1;
      graphicAutocompleteSpinner.hidden = true;
      graphicAutocompletePreview.removeAttribute("aria-busy");
      if (placeholder.isConnected) {
        placeholder.classList.remove("smarttex-figure-popup-resolving");
        placeholder.textContent = normalizedPath;
        placeholder.title = "The selected figure preview timed out.";
      }
      graphicAutocompletePath = "";
    }, 12000);

    const resolveAndRender = async (attempt = 0) => {
      try {
        const direct = directFigureFile(normalizedPath);
        const file = direct?.url
          ? direct
          : (await bridgeRequest("resolveProjectFile", { path: normalizedPath })).file;
        if (!file?.url) throw new Error("Figure URL is unavailable.");
        if (generation !== graphicAutocompleteGeneration || !placeholder.isConnected) return;
        const renderer = globalThis.SmartTeXFigureRenderer;
        if (!renderer?.createMedia) throw new Error("The figure renderer is unavailable.");
        const resolvedMedia = await renderer.createMedia(file.path || normalizedPath, file.url, {
          imageClass: "smarttex-graphic-autocomplete-image",
          pdfClass: "smarttex-graphic-autocomplete-image smarttex-figure-popup-pdf"
        });
        if (!resolvedMedia) throw new Error("Figure media could not be created.");
        if (generation !== graphicAutocompleteGeneration || !placeholder.isConnected) return;
        try {
          await resolvedMedia.decode?.();
        } catch (_error) {
          // Some browsers reject decode() for an already available/cached image;
          // natural dimensions are still usable in that case.
        }
        if (generation !== graphicAutocompleteGeneration || !placeholder.isConnected) return;
        window.clearTimeout(watchdog);
        placeholder.replaceWith(resolvedMedia);
        fitGraphicAutocompletePreviewToMedia(resolvedMedia);
        graphicAutocompleteSpinner.hidden = true;
        graphicAutocompletePreview.removeAttribute("aria-busy");
        window.requestAnimationFrame(() => {
          const baseWidth = Math.max(1, resolvedMedia.getBoundingClientRect?.().width || resolvedMedia.clientWidth || 1);
          resolvedMedia.dataset.smarttexBaseWidthPx = String(baseWidth);
          if (graphicAutocompletePreview.dataset.smarttexUserSized === "true") {
            resolvedMedia.style.width = "100%";
            resolvedMedia.style.height = "100%";
          } else {
            resolvedMedia.style.width = `${baseWidth}px`;
            resolvedMedia.style.removeProperty("height");
          }
          renderer.ensurePopupZoom?.(figure)?.refresh?.();
          positionGraphicAutocompletePreview(owner);
        });
      } catch (_error) {
        if (generation !== graphicAutocompleteGeneration || !placeholder.isConnected) return;
        if (attempt < 2) {
          window.setTimeout(() => resolveAndRender(attempt + 1), 160 * (attempt + 1));
          return;
        }
        window.clearTimeout(watchdog);
        showFailure();
      }
    };
    resolveAndRender();
  }

  function updateGraphicAutocompletePreview() {
    graphicAutocompleteUpdateFrame = null;
    if (!enabledFeatures.figures) {
      hideGraphicAutocompletePreview();
      return;
    }
    const argument = includeGraphicsArgumentAtCursor(currentState);
    const hoveredOwner = argument && graphicAutocompleteHoveredOwner?.isConnected
      ? nativeGraphicAutocompleteOwnerFromNode(graphicAutocompleteHoveredOwner)
      : null;
    const customOwner = argument
      ? document.querySelector(
        "#smarttex-figure-autocomplete-popup:not([hidden]) " +
        ".smarttex-figure-autocomplete-list"
      )
      : null;
    if (popupsSuppressedAfterEditorScroll && !customOwner) {
      hideGraphicAutocompletePreview();
      return;
    }
    const owner = hoveredOwner || customOwner || (argument ? visibleNativeGraphicAutocomplete() : null);
    const hoveredEntry = owner && owner === hoveredOwner &&
      graphicAutocompleteHoveredEntry?.isConnected &&
      owner.contains(graphicAutocompleteHoveredEntry)
      ? graphicAutocompleteHoveredEntry
      : null;
    const entry = hoveredEntry || (owner ? selectedNativeGraphicEntry(owner) : null);
    const path = owner === customOwner && customGraphicAutocompletePreviewSuppressed
      ? ""
      : (
          graphicPathFromSuggestion(entry) ||
          (owner === customOwner ? customGraphicAutocompleteSelectionPath : "")
        );
    if (!argument || !owner || !path) {
      const wasActive = graphicAutocompleteActive;
      hideGraphicAutocompletePreview();
      if (wasActive && stateCanShowPreview(currentState)) scheduleRender();
      return;
    }
    graphicAutocompleteActive = true;
    hidePreview();
    hideCaptionReferencePopup();
    renderGraphicAutocompletePreview(path, owner);
  }

  function scheduleGraphicAutocompletePreviewUpdate() {
    if (popupsSuppressedAfterEditorScroll) return;
    if (graphicAutocompleteUpdateFrame !== null) return;
    graphicAutocompleteUpdateFrame = window.requestAnimationFrame(() => {
      try {
        updateGraphicAutocompletePreview();
      } catch (error) {
        // Keyboard input may abort an older interaction task that is still
        // unwinding. Autocomplete probing is optional background UI work, so an
        // inherited AbortError should simply defer it to the next state/frame
        // instead of becoming an unhandled page error that competes with live
        // environment preview updates.
        graphicAutocompleteUpdateFrame = null;
        if (!interactionTasks?.isAbortError?.(error)) throw error;
      }
    });
  }

  function appendPopupCaption(
    container,
    labelText,
    number,
    captionText,
    macros,
    sourceOffset = null
  ) {
    const text = String(captionText || "").trim();
    if (!text) return null;
    const caption = document.createElement("figcaption");
    caption.className = "smarttex-float-popup-caption";
    const label = document.createElement("strong");
    label.textContent = `${labelText} ${number ?? "?"}:`;
    // A caret-bearing caption is a transient cursor-specific rendering. Avoid
    // caching it: otherwise every arrow-key position would consume an LRU entry
    // and a stale cached caret could later reappear at the wrong caption offset.
    const captionHasCaret = text.includes("\uE001") || text.includes("\uE002");
    const captionCacheKey = captionHasCaret ? null : [
      previewSourceSignature(currentState),
      fastPreviewHash(text),
      Number.isFinite(Number(sourceOffset)) ? Number(sourceOffset) : -1
    ].join("::");
    let renderedCaption = null;
    const cachedCaptionMarkup = captionCacheKey
      ? lruCacheGet(captionRenderCache, captionCacheKey)
      : null;
    if (cachedCaptionMarkup) {
      renderedCaption = htmlNodeClone(cachedCaptionMarkup);
    }
    if (!renderedCaption) {
      renderedCaption = tableRenderer.renderInlineLatex(text, {
        contextTools,
        document,
        katex,
        macros,
        trust: trustedKatexCommand,
        sourceOffset: Number.isFinite(Number(sourceOffset))
          ? Number(sourceOffset)
          : undefined,
        renderReference: createCaptionReferenceLink
      });
      if (captionCacheKey && renderedCaption?.outerHTML) {
        lruCacheSet(
          captionRenderCache,
          captionCacheKey,
          renderedCaption.outerHTML,
          CAPTION_RENDER_CACHE_LIMIT
        );
      }
    }
    caption.append(label, " ", renderedCaption);
    container.appendChild(caption);
    return caption;
  }

  function collapsedCaretIsInsideCaption(state, caption) {
    if (!state || !caption) return false;
    const cursor = Number(state.cursorIndex);
    const selectionFrom = Number(state.selectionFrom ?? cursor);
    const selectionTo = Number(state.selectionTo ?? cursor);
    const bounds = captionBounds(caption);
    return Boolean(
      bounds &&
      Number.isInteger(cursor) &&
      selectionFrom === selectionTo &&
      cursor >= bounds.start &&
      cursor <= bounds.end
    );
  }

  function updateFloatCaptionInPlace(
    floatElement,
    labelText,
    number,
    captionText,
    macros,
    captionSourceOffset
  ) {
    const staging = document.createElement("div");
    const nextCaption = appendPopupCaption(
      staging,
      labelText,
      number,
      captionText,
      macros,
      captionSourceOffset
    );
    const currentCaption = floatElement.querySelector(
      ":scope > .smarttex-float-popup-caption"
    );
    if (!nextCaption) {
      currentCaption?.remove();
      return;
    }
    if (!currentCaption) {
      floatElement.appendChild(nextCaption);
      return;
    }
    const scrollTop = currentCaption.scrollTop;
    currentCaption.replaceChildren(...nextCaption.childNodes);
    currentCaption.scrollTop = scrollTop;
  }

  function liveCaptionTextFromLock(state) {
    if (!state || !captionPreviewLock) return null;
    const source = String(state.value || "");
    const start = Math.max(0, Math.min(source.length, Number(captionPreviewLock.start) || 0));
    const end = Math.max(
      start,
      Math.min(source.length, Number(captionPreviewLock.end) || start)
    );
    let captionText = source.slice(start, end);
    if (typeof contextTools.removeLatexCommentsPreservingLength === "function") {
      captionText = contextTools.removeLatexCommentsPreservingLength(captionText);
    }

    // Mirror the editor caret inside the rendered figure/table caption. The
    // private markers are understood by table-renderer.js in ordinary text and
    // converted to the same SmartTeXCaret KaTeX macros when they occur in math.
    // This updates only the caption DOM; the surrounding float stays mounted.
    const cursor = Number(state.cursorIndex);
    const selectionFrom = Number(state.selectionFrom ?? cursor);
    const selectionTo = Number(state.selectionTo ?? cursor);
    if (
      Number.isInteger(cursor) &&
      selectionFrom === selectionTo &&
      cursor >= start &&
      cursor <= end
    ) {
      const literalOffset = Math.max(0, Math.min(captionText.length, cursor - start));
      caretPlacementState = contextTools.resolveCaretPlacement(
        captionText,
        literalOffset,
        caretPlacementState
      );
      const caretOffset = contextTools.commandAwareCaretOffset(
        captionText,
        literalOffset,
        caretPlacementState?.commandSide || null
      );
      const operatorCaret = Boolean(
        contextTools.cursorInsideControlSequence?.(captionText, literalOffset) ||
        contextTools.cursorAtProtectedAtomBoundary?.(captionText, literalOffset)
      );
      const marker = operatorCaret ? "\uE002" : "\uE001";
      captionText = captionText.slice(0, caretOffset) + marker + captionText.slice(caretOffset);
    }
    return captionText.trim();
  }

  function ensureLiveCaptionRenderInfo(state, floatElement) {
    if (
      activeFloatCaptionRenderInfo?.contextId === activeContextId &&
      activeFloatCaptionRenderInfo?.macros
    ) return activeFloatCaptionRenderInfo;
    if (!state || !activePreviewContext || !["figure", "table"].includes(activePreviewContext.kind)) {
      return null;
    }
    const captionText = liveCaptionTextFromLock(state) || "";
    let prepared;
    try {
      prepared = contextTools.prepareDocumentCommands(
        state.value,
        activePreviewContext.openStart,
        captionText
      );
    } catch (_error) {
      prepared = { macros: { "\\ensuremath": "#1" } };
    }
    const existingLabel = String(
      floatElement?.querySelector?.(":scope > .smarttex-float-popup-caption > strong")?.textContent || ""
    ).trim();
    const labelMatch = existingLabel.match(/^(.*?)[\s]+([^:]+):$/);
    const isTable = activePreviewContext.kind === "table";
    activeFloatCaptionRenderInfo = {
      contextId: activeContextId,
      labelText: labelMatch?.[1] || (isTable ? "Table" : "Fig."),
      number: labelMatch?.[2] || "?",
      macros: {
        ...(prepared?.macros || {}),
        "\\label": { tokens: [], numArgs: 1 },
        "\\nonumber": "",
        "\\notag": "",
        "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}",
        "\\SmartTeXOperatorCaret": "\\htmlClass{smarttex-rendered-operator-caret}{\\vphantom{|}}"
      },
      sourceOffset: Number(captionPreviewLock?.start) || null
    };
    return activeFloatCaptionRenderInfo;
  }

  function applyLiveCaptionUpdate(state) {
    liveCaptionUpdateTimer = null;
    cancelPendingEnvironmentPreviewRender();
    // Caption rendering uses the same LaTeX-context helpers as equations. Run
    // it under a fresh interaction task as well; otherwise a keyboard-aborted
    // generic render still on the stack can abort the caption update and force
    // a later cold reopen.
    const liveTaskToken = interactionTasks?.begin?.("popup-live-caption") || null;
    try {
    if (
      !captionPreviewLock ||
      preview.hidden ||
      captionPreviewLock.contextId !== activeContextId ||
      !["figure", "table"].includes(activePreviewContext?.kind)
    ) return false;
    const floatElement = output.querySelector(
      activePreviewContext.kind === "figure"
        ? ":scope > .smarttex-figure-popup"
        : ":scope > .smarttex-table-popup"
    );
    if (!floatElement) return false;
    const info = ensureLiveCaptionRenderInfo(state, floatElement);
    if (!info || info.contextId !== activeContextId) return false;
    const captionText = liveCaptionTextFromLock(state);
    if (captionText === null) return false;

    // Preserve the mounted popup's exact top-left coordinates while the caption
    // DOM and fit are updated. The fit solver is allowed to change width/height,
    // but it must not turn an ordinary caption keypress into a new placement.
    // After restoring these coordinates we run only the cursor safety-margin
    // check, which may relocate the popup if the newly enlarged box would
    // actually collide with the caret.
    const pinnedRect = preview.getBoundingClientRect();
    const pinnedLeftStyle = preview.style.left;
    const pinnedTopStyle = preview.style.top;
    const pinnedLeft = pinnedRect.left;
    const pinnedTop = pinnedRect.top;

    updateFloatCaptionInPlace(
      floatElement,
      info.labelText,
      info.number,
      captionText,
      info.macros,
      Number(captionPreviewLock.start)
    );
    advanceActiveEnvironmentRangeForSourceEdit(state);

    // Keep the already-visible popup and its position. Only rerun the common
    // live fit solver so a longer caption can grow the current window and a
    // shorter/changed caption can shed an unnecessary scrollbar/auto-fit scale.
    activePreviewState = {
      ...activePreviewState,
      value: state.value,
      cursorIndex: state.cursorIndex,
      selectionFrom: state.selectionFrom,
      selectionTo: state.selectionTo,
      screen: state.screen || activePreviewState?.screen
    };
    const prepared = {
      maxWidth: Number(preview.dataset.smarttexAutoFitMaxWidth) || undefined,
      maxHeight: Number(preview.dataset.smarttexAutoFitMaxHeight) || undefined
    };
    applyPreviewAutoFitPolicyNow(prepared, {
      allowGrow: preview.dataset.smarttexTemporarySized !== "true"
    });
    preview.style.left = pinnedLeftStyle || `${Math.round(pinnedLeft)}px`;
    preview.style.top = pinnedTopStyle || `${Math.round(pinnedTop)}px`;
    previewPositioned = true;
    positionPreviewAtCursor();
    return true;
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) return false;
      throw error;
    } finally {
      if (liveTaskToken) interactionTasks?.end?.(liveTaskToken);
    }
  }

  function scheduleLiveCaptionUpdate(state, { immediate = false } = {}) {
    if (liveCaptionUpdateTimer !== null) {
      window.clearTimeout(liveCaptionUpdateTimer);
      liveCaptionUpdateTimer = null;
    }
    if (!captionPreviewIsLocked() || preview.hidden) return;
    liveCaptionUpdateTimer = window.setTimeout(
      () => applyLiveCaptionUpdate(state),
      immediate ? 0 : LIVE_CAPTION_UPDATE_DELAY_MS
    );
  }

  function boundedPopupText(value, maximum) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
  }

  function citationCacheKey() {
    const project = window.location.pathname.match(/\/project\/([^/?#]+)/i)?.[1]
      || window.location.pathname;
    return `smarttex:citation-cache:v1:${window.location.origin}:${project}`;
  }

  function loadCitationRecords({ force = false } = {}) {
    if (force) {
      citationRecordsPromise = null;
      citationRecordsLoaded = false;
    }
    if (citationRecordsPromise) return citationRecordsPromise;
    citationRecordsPromise = Promise.resolve(
      extensionApi?.storage?.local?.get?.(citationCacheKey())
    ).then((stored) => {
      const records = stored?.[citationCacheKey()]?.records;
      citationRecords = new Map(
        (Array.isArray(records) ? records : []).map((record) => [
          String(record?.key || "").trim(),
          record
        ]).filter(([key]) => key)
      );
      citationRecordsLoaded = true;
      return citationRecords;
    }).catch((error) => {
      citationRecordsLoaded = true;
      console.warn("SmartTeX could not load citation previews:", error);
      return citationRecords;
    });
    return citationRecordsPromise;
  }

  function requestCitationRefresh(button) {
    if (!button || button.disabled) return Promise.resolve(false);
    const requestId = `content-${Date.now()}-${++citationRefreshCounter}`;
    button.disabled = true;
    button.classList.add("smarttex-citation-popup-refreshing");
    button.innerHTML = '<span class="smarttex-citation-refresh-spinner" aria-hidden="true"></span> Refreshing…';
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingCitationRefreshes.delete(requestId);
        button.disabled = false;
        button.classList.remove("smarttex-citation-popup-refreshing");
        button.innerHTML = '<span aria-hidden="true">↻</span> Refresh';
        resolve(false);
      }, 30000);
      pendingCitationRefreshes.set(requestId, { button, resolve, timeout });
      window.dispatchEvent(new CustomEvent(CITATION_REFRESH_REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, source: "editor-popup" })
      }));
    });
  }

  function appendCitationRefreshControl(container, onRefreshed) {
    const bar = document.createElement("div");
    bar.className = "smarttex-citation-popup-toolbar";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "smarttex-citation-popup-refresh";
    button.title = "Re-parse bibliography files";
    button.setAttribute("aria-label", "Refresh bibliography");
    button.innerHTML = '<span aria-hidden="true">↻</span> Refresh';
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      requestCitationRefresh(button).then((ok) => {
        if (!ok) return;
        return loadCitationRecords({ force: true }).then(() => onRefreshed?.());
      });
    });
    bar.appendChild(button);
    container.appendChild(bar);
  }

  function localCitationTarget(sourceValue, labelValue) {
    const source = String(sourceValue || "");
    const label = String(labelValue || "").trim();
    const pattern = /\\bibitem(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g;
    let match;
    while ((match = pattern.exec(source))) {
      if (match[1].trim() !== label) continue;
      const next = source.slice(pattern.lastIndex).search(
        /\\bibitem\b|\\end\s*\{thebibliography\}/
      );
      const end = next < 0 ? source.length : pattern.lastIndex + next;
      const text = source.slice(pattern.lastIndex, end)
        .replace(/%[^\r\n]*/g, " ")
        .replace(/\\(?:newblock|emph|textit|textbf|url|href)\b/g, " ")
        .replace(/[{}~]+/g, " ")
        .replace(/\\[A-Za-z@]+\*?/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        label,
        type: "citation",
        sourceIndex: match.index,
        text
      };
    }
    return {
      label,
      type: "citation",
      sourceIndex: undefined,
      text: ""
    };
  }

  function citationPublicationText(record) {
    if (!record) return "";
    const journal = String(record.journal || "").trim();
    const volumeIssue = [
      String(record.volume || "").trim(),
      String(record.number || "").trim()
    ].filter(Boolean).join("(") + (
      record.volume && record.number ? ")" : ""
    );
    const pages = String(record.pages || "").trim();
    const year = String(record.year || "").trim();
    return [journal, volumeIssue, pages, year].filter(Boolean).join(", ");
  }

  function citationPopupCard(record, target) {
    const card = document.createElement("article");
    card.className = "smarttex-reference-popup-citation";

    const heading = document.createElement("div");
    heading.className = "smarttex-reference-popup-citation-heading";
    const title = document.createElement("strong");
    title.className = "smarttex-reference-popup-citation-title";
    title.textContent = boundedPopupText(
      record?.title || target?.text || target?.label,
      280
    );
    const key = document.createElement("code");
    key.className = "smarttex-reference-popup-citation-key";
    key.textContent = String(record?.key || target?.label || "?");
    heading.append(title, key);

    const authors = document.createElement("span");
    authors.className = "smarttex-reference-popup-citation-authors";
    authors.textContent = boundedPopupText(
      (Array.isArray(record?.authors) ? record.authors : []).join(", ")
        || (record ? "Unknown author" : `Citation key: ${target?.label || "?"}`),
      700
    );

    const publication = document.createElement("span");
    publication.className = "smarttex-reference-popup-citation-publication";
    publication.textContent = boundedPopupText(
      citationPublicationText(record) || (!record ? target?.text : ""),
      520
    );

    card.append(heading, authors);
    if (publication.textContent) card.appendChild(publication);
    if (record?.doi) {
      const doi = document.createElement("span");
      doi.className = "smarttex-reference-popup-citation-doi";
      doi.textContent = `DOI: ${boundedPopupText(record.doi, 240)}`;
      card.appendChild(doi);
    }
    return card;
  }

  function elementIsHovered(element) {
    try {
      return Boolean(element?.isConnected && element.matches(":hover"));
    } catch (_error) {
      return false;
    }
  }

  function noteReferencePopupInteraction(durationMs = 500) {
    referencePopupInteractionUntil = Math.max(
      referencePopupInteractionUntil,
      Date.now() + Math.max(0, Number(durationMs) || 0)
    );
  }

  function referencePopupInteractionRemaining() {
    if (referencePopupPointerDown) return 250;
    return Math.max(0, referencePopupInteractionUntil - Date.now());
  }

  function popupDepthForElement(element) {
    const popup = element?.closest?.(".smarttex-document-reference-popup");
    if (!popup) return -1;
    const depth = Number(popup.dataset.smarttexReferencePopupDepth);
    return Number.isInteger(depth) && depth >= 0 ? depth : 0;
  }

  function referencePopupContains(element) {
    if (captionReferencePopup?.contains(element)) return true;
    return nestedCaptionReferencePopupStates.some(
      (state) => state.popup?.contains(element)
    );
  }

  function nestedPopupState(depth, create = false) {
    if (!Number.isInteger(depth) || depth < 1) return null;
    const index = depth - 1;
    if (!nestedCaptionReferencePopupStates[index] && create) {
      nestedCaptionReferencePopupStates[index] = {
        popup: null,
        timer: null,
        anchor: null,
        anchorRect: null
      };
    }
    return nestedCaptionReferencePopupStates[index] || null;
  }

  function clearReferencePopupTimer(depth) {
    if (depth === 0) {
      window.clearTimeout(captionReferencePopupTimer);
      captionReferencePopupTimer = null;
      return;
    }
    const state = nestedPopupState(depth);
    if (!state) return;
    window.clearTimeout(state.timer);
    state.timer = null;
  }

  function clearReferencePopupTimersThrough(depth) {
    for (let currentDepth = 0; currentDepth <= depth; currentDepth += 1) {
      clearReferencePopupTimer(currentDepth);
    }
  }

  function hideNestedReferencePopupsFromDepth(depth) {
    const firstIndex = Math.max(0, depth - 1);
    for (let index = firstIndex; index < nestedCaptionReferencePopupStates.length; index += 1) {
      const state = nestedCaptionReferencePopupStates[index];
      if (!state) continue;
      window.clearTimeout(state.timer);
      state.timer = null;
      state.anchor = null;
      state.anchorRect = null;
      if (state.popup) {
        state.popup.hidden = true;
        state.popup.classList.remove("smarttex-reference-popup-compact");
        state.popup.style.removeProperty("width");
        state.popup.style.removeProperty("max-width");
        state.popup.removeAttribute("data-smarttex-content-kind");
        state.popup.__smarttexTargetKeys = new Set();
      }
    }
  }

  function hideCaptionReferencePopup() {
    const restoreCaptionPreview = captionInnerReferenceActive;
    captionInnerReferenceActive = false;
    hidePopupLoadingSpinner();
    referencePopupInteractionUntil = 0;
    referencePopupPointerDown = false;
    window.clearTimeout(captionReferencePopupTimer);
    captionReferencePopupTimer = null;
    window.clearTimeout(editorReferenceHoverTimer);
    editorReferenceHoverGeneration += 1;
    activeEditorReferenceKey = "";
    activeEditorReferenceType = "";
    activeSecondaryEditorReferenceKey = "";
    captionReferencePopupAnchor = null;
    captionReferencePopupAnchorRect = null;
    autocompleteReferenceAnchorRect = null;
    autocompleteReferenceOwnerRect = null;
    hideNestedReferencePopupsFromDepth(1);
    if (captionReferencePopup) {
      captionReferencePopup.hidden = true;
      captionReferencePopup.classList.remove(
        "smarttex-editor-reference-popup",
        "smarttex-reference-popup-compact",
        "smarttex-reference-popup-click-preview"
      );
      captionReferencePopup.removeAttribute("data-smarttex-autocomplete-owner");
      captionReferencePopup.style.removeProperty("width");
      captionReferencePopup.style.removeProperty("max-width");
      captionReferencePopup.removeAttribute("data-smarttex-content-kind");
      captionReferencePopup.__smarttexTargetKeys = new Set();
    }
    if (restoreCaptionPreview) {
      window.requestAnimationFrame(() => {
        const state = previewStateForRender();
        if (stateCanShowPreview(state)) scheduleRender();
      });
    }
  }

  function popupChainIsHovered() {
    if (elementIsHovered(captionReferencePopupAnchor)) return true;
    if (elementIsHovered(captionReferencePopup)) return true;
    if (captionReferencePopup?.contains(document.activeElement)) return true;
    return nestedCaptionReferencePopupStates.some((state) => (
      !state?.popup?.hidden && (
        elementIsHovered(state.anchor) ||
        elementIsHovered(state.popup) ||
        state.popup?.contains(document.activeElement)
      )
    ));
  }

  function popupChainOriginatesInPreview() {
    if (
      captionReferencePopup &&
      !captionReferencePopup.hidden &&
      captionReferencePopupAnchor?.closest?.("#smarttex-equation-preview")
    ) {
      return true;
    }
    return nestedCaptionReferencePopupStates.some((state) => (
      state?.popup &&
      !state.popup.hidden &&
      state.anchor?.closest?.("#smarttex-equation-preview")
    ));
  }

  function keepReferencePopupOpen(event) {
    const depth = Math.max(0, popupDepthForElement(event?.target));
    const interactionDuration = /^(?:wheel|scroll)$/.test(String(event?.type || ""))
      ? 900
      : 450;
    noteReferencePopupInteraction(interactionDuration);
    if (event?.type === "pointerdown" || event?.type === "mousedown") {
      referencePopupPointerDown = true;
    }
    clearReferencePopupTimersThrough(depth);
    window.clearTimeout(editorReferenceHoverTimer);
  }

  function bindReferencePopupInteractionGuards(popup) {
    popup.addEventListener("pointerenter", keepReferencePopupOpen);
    popup.addEventListener("pointermove", keepReferencePopupOpen, { passive: true });
    popup.addEventListener("pointerdown", keepReferencePopupOpen, true);
    popup.addEventListener("mousedown", keepReferencePopupOpen, true);
    popup.addEventListener("wheel", keepReferencePopupOpen, { passive: true });
    popup.addEventListener("scroll", keepReferencePopupOpen, { passive: true, capture: true });
  }

  function enhanceReferencePopup(popup, contentKind = "equation") {
    const type = contentKind === "figure"
      ? "image"
      : contentKind === "table"
        ? "table"
        : "equation";
    return globalThis.SmartTeXPopupUI?.enhance?.(popup, {
      type,
      headingSelector: ".smarttex-reference-popup-heading",
      onClose: hideCaptionReferencePopup
    });
  }

  const POPUP_SCROLL_SELECTOR = [
    ".smarttex-reference-popup-target",
    ".smarttex-reference-popup-equation",
    ".smarttex-equation-output",
    ".smarttex-figure-popup-viewport",
    ".smarttex-table-scroll"
  ].join(",");

  function capturePopupScrollState(root) {
    if (!root) return [];
    return [root, ...root.querySelectorAll(POPUP_SCROLL_SELECTOR)].map(
      (element, index) => ({
        index,
        left: Number(element.scrollLeft) || 0,
        top: Number(element.scrollTop) || 0
      })
    );
  }

  function restorePopupScrollState(root, state) {
    if (!root || !Array.isArray(state) || !state.length) return;
    const restore = () => {
      const elements = [root, ...root.querySelectorAll(POPUP_SCROLL_SELECTOR)];
      state.forEach((entry) => {
        const element = elements[entry.index];
        if (!element) return;
        element.scrollLeft = Math.max(0, Number(entry.left) || 0);
        element.scrollTop = Math.max(0, Number(entry.top) || 0);
      });
    };
    restore();
    window.requestAnimationFrame(restore);
  }

  function scheduleHideCaptionReferencePopup(delayMs = 180) {
    window.clearTimeout(captionReferencePopupTimer);
    captionReferencePopupTimer = window.setTimeout(() => {
      if (
        referenceAutocompleteActive &&
        captionReferencePopup?.dataset.smarttexAutocompleteOwner === "reference"
      ) {
        return;
      }
      const remaining = referencePopupInteractionRemaining();
      if (remaining > 0) {
        scheduleHideCaptionReferencePopup(Math.min(950, remaining + 35));
        return;
      }
      if (popupChainIsHovered()) return;
      hideCaptionReferencePopup();
    }, delayMs);
  }

  function scheduleHideNestedReferencePopup(depth, delayMs = 180) {
    const state = nestedPopupState(depth);
    if (!state) return;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      const remaining = referencePopupInteractionRemaining();
      if (remaining > 0) {
        scheduleHideNestedReferencePopup(depth, Math.min(950, remaining + 35));
        return;
      }
      const descendantHovered = nestedCaptionReferencePopupStates
        .slice(depth - 1)
        .some((candidate) => (
          !candidate?.popup?.hidden && (
            elementIsHovered(candidate.anchor) ||
            elementIsHovered(candidate.popup)
          )
        ));
      if (descendantHovered) return;
      hideNestedReferencePopupsFromDepth(depth);
    }, delayMs);
  }

  function schedulePopupChainHideThrough(depth) {
    scheduleHideCaptionReferencePopup();
    for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
      scheduleHideNestedReferencePopup(currentDepth);
    }
  }

  function ensureCaptionReferencePopup() {
    if (captionReferencePopup?.isConnected) return captionReferencePopup;
    captionReferencePopup = document.createElement("aside");
    captionReferencePopup.className =
      "smarttex-document-reference-popup smarttex-caption-reference-popup";
    captionReferencePopup.dataset.smarttexReferencePopupDepth = "0";
    captionReferencePopup.hidden = true;
    captionReferencePopup.setAttribute("role", "tooltip");
    bindReferencePopupInteractionGuards(captionReferencePopup);
    captionReferencePopup.addEventListener("pointerleave", () => {
      scheduleHideCaptionReferencePopup();
    });
    document.body.appendChild(captionReferencePopup);
    return captionReferencePopup;
  }

  function ensureNestedCaptionReferencePopup(depth) {
    const state = nestedPopupState(depth, true);
    if (state.popup?.isConnected) return state.popup;
    const popup = document.createElement("aside");
    popup.className =
      "smarttex-document-reference-popup smarttex-caption-reference-popup smarttex-nested-reference-popup";
    popup.dataset.smarttexReferencePopupDepth = String(depth);
    popup.hidden = true;
    popup.setAttribute("role", "tooltip");
    bindReferencePopupInteractionGuards(popup);
    popup.addEventListener("pointerleave", () => {
      schedulePopupChainHideThrough(depth);
    });
    document.body.appendChild(popup);
    state.popup = popup;
    return popup;
  }

  function referenceLinkText(command, target, label) {
    const number = String(target?.number || label || "?");
    if (command === "eqref") return `(${number})`;
    if (/^(?:autoref|cref|Cref|vref|Vref)$/.test(command)) {
      const type = {
        equation: "Equation",
        figure: "Figure",
        table: "Table",
        section: "Section"
      }[target?.type] || "Reference";
      return `${type} ${number}`;
    }
    return number;
  }

  function referencePopupTitle(target, label) {
    const number = target?.number || label || "?";
    if (target?.type === "equation") return `Equation ${number}`;
    if (target?.type === "figure") return `Figure ${number}`;
    if (target?.type === "table") return `Table ${number}`;
    if (target?.type === "section") return `Section ${number}`;
    if (target?.type === "citation") return `Citation ${target.label || label || "?"}`;
    return `Reference ${number}`;
  }

  function appendReferencePopupHeading(container, target, label) {
    const heading = document.createElement("div");
    heading.className = "smarttex-reference-popup-heading";
    const titleText = referencePopupTitle(target, label);
    const sourceIndex = Number(target?.sourceIndex);
    if (Number.isFinite(sourceIndex)) {
      const link = document.createElement("a");
      link.className = "smarttex-reference-popup-title";
      link.href = "#";
      link.textContent = titleText;
      link.title = "Jump to this element in the editor";
      const consumePress = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      link.addEventListener("pointerdown", consumePress);
      link.addEventListener("mousedown", consumePress);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        announceNavigationOrigin(sourceIndex);
        hideCaptionReferencePopup();
        bridgeRequest("setCursor", {
          index: sourceIndex,
          focus: true
        }).catch((error) => {
          console.warn("SmartTeX could not navigate to the reference target:", error);
        });
      });
      heading.appendChild(link);
    } else {
      const title = document.createElement("strong");
      title.className = "smarttex-reference-popup-title";
      title.textContent = titleText;
      heading.appendChild(title);
    }
    container.appendChild(heading);
  }

  function popupAnchorRect(anchorValue) {
    if (!anchorValue) return null;
    const rect = typeof anchorValue.getBoundingClientRect === "function"
      ? anchorValue.getBoundingClientRect()
      : anchorValue;
    return {
      left: Number(rect.left) || 0,
      right: Number(rect.right ?? rect.left) || 0,
      top: Number(rect.top) || 0,
      bottom: Number(rect.bottom ?? rect.top) || 0
    };
  }

  function positionCaptionReferencePopup(anchorValue) {
    if (!captionReferencePopup || captionReferencePopup.hidden || !anchorValue) return;
    captionReferencePopupAnchorRect = popupAnchorRect(anchorValue);
    if (!captionReferencePopupAnchorRect) return;
    const popupRect = captionReferencePopup.getBoundingClientRect();
    const margin = 10;
    const left = Math.max(
      margin,
      Math.min(
        captionReferencePopupAnchorRect.left,
        window.innerWidth - popupRect.width - margin
      )
    );
    const anchorLineHeight = Math.max(16, captionReferencePopupAnchorRect.bottom - captionReferencePopupAnchorRect.top);
    const verticalGap = anchorLineHeight * 2;
    const below = captionReferencePopupAnchorRect.bottom + verticalGap;
    const top = below + popupRect.height <= window.innerHeight - margin
      ? below
      : Math.max(
        margin,
        captionReferencePopupAnchorRect.top - popupRect.height - verticalGap
      );
    captionReferencePopup.style.left = `${Math.round(left)}px`;
    captionReferencePopup.style.top = `${Math.round(top)}px`;
  }

  function positionNestedCaptionReferencePopup(depth, anchorValue) {
    const state = nestedPopupState(depth);
    if (!state?.popup || state.popup.hidden || !anchorValue) return;
    state.anchorRect = popupAnchorRect(anchorValue);
    if (!state.anchorRect) return;

    const popupRect = state.popup.getBoundingClientRect();
    const parentPopup = depth === 1
      ? captionReferencePopup
      : nestedPopupState(depth - 1)?.popup;
    const parentRect = parentPopup?.getBoundingClientRect();
    const margin = 10;
    const gap = 8;
    const maximumLeft = Math.max(margin, window.innerWidth - popupRect.width - margin);
    let left;

    if (parentRect && parentRect.right + gap + popupRect.width <= window.innerWidth - margin) {
      left = parentRect.right + gap;
    } else if (parentRect && parentRect.left - gap - popupRect.width >= margin) {
      left = parentRect.left - gap - popupRect.width;
    } else {
      left = Math.max(margin, Math.min(state.anchorRect.left, maximumLeft));
    }

    const preferredTop = state.anchorRect.top - 12;
    const top = Math.max(
      margin,
      Math.min(preferredTop, window.innerHeight - popupRect.height - margin)
    );
    state.popup.style.left = `${Math.round(left)}px`;
    state.popup.style.top = `${Math.round(top)}px`;
  }

  function repositionReferencePopups() {
    if (
      captionReferencePopup?.dataset.smarttexAutocompleteOwner?.startsWith("reference") &&
      autocompleteReferenceAnchorRect &&
      autocompleteReferenceOwnerRect
    ) {
      positionAutocompleteReferencePopup(
        autocompleteReferenceAnchorRect,
        autocompleteReferenceOwnerRect
      );
    } else if (captionReferencePopupAnchorRect && captionReferencePopup && !captionReferencePopup.hidden) {
      positionCaptionReferencePopup(
        captionReferencePopupAnchor?.isConnected
          ? captionReferencePopupAnchor
          : captionReferencePopupAnchorRect
      );
    }
    nestedCaptionReferencePopupStates.forEach((state, index) => {
      if (!state?.anchorRect || !state.popup || state.popup.hidden) return;
      positionNestedCaptionReferencePopup(
        index + 1,
        state.anchor?.isConnected ? state.anchor : state.anchorRect
      );
    });
  }

  function popupTableContext(target, source) {
    const start = Math.max(0, Number(target?.context?.contentStart) || 0);
    const end = Math.max(start, Number(target?.context?.contentEnd) || source.length);
    let position = source.indexOf("\\begin", start);
    while (position >= 0 && position < end) {
      const context = contextTools.findTableContext(source, position + 1);
      if (
        context &&
        context.openStart >= start &&
        context.closeEnd <= end
      ) {
        return context;
      }
      position = source.indexOf("\\begin", position + 6);
    }
    return null;
  }

  function referenceTargetPreviewEnabled(target) {
    if (!target) return false;
    if (target.type === "equation") return enabledFeatures.equations;
    if (target.type === "table") return enabledFeatures.tables;
    if (target.type === "figure") return enabledFeatures.figures;
    return true;
  }

  function appendReferenceTargetPreview(container, target, source) {
    if (!referenceTargetPreviewEnabled(target)) return false;
    if (target.type === "equation" && target.context) {
      const body = contextTools.previewBody(
        target.context,
        null,
        target.numbering,
        false
      );
      const prepared = contextTools.prepareDocumentCommands(
        source,
        target.sourceIndex,
        body
      );
      const equation = document.createElement("div");
      equation.className =
        "smarttex-reference-popup-target smarttex-reference-popup-equation";
      try {
        katex.render(prepared.body, equation, {
          displayMode: true,
          throwOnError: true,
          strict: "ignore",
          trust: trustedKatexCommand,
          maxExpand: 1000,
          maxSize: 25,
          macros: {
            ...prepared.macros,
            "\\label": { tokens: [], numArgs: 1 },
            "\\nonumber": "",
            "\\notag": ""
          }
        });
      } catch (_error) {
        equation.textContent = `Equation ${target.number || target.label}`;
      }
      container.appendChild(equation);
      return true;
    }

    if (target.type === "figure" && target.context) {
      const prepared = contextTools.prepareDocumentCommands(
        source,
        target.sourceIndex,
        target.caption || ""
      );
      const figure = renderFigurePopup(
        target.context,
        target.number,
        prepared.body,
        prepared.macros
      );
      figure.classList.add("smarttex-reference-popup-target");
      container.appendChild(figure);
      globalThis.SmartTeXFigureRenderer?.observePopupLayout?.(
        figure.querySelector(".smarttex-figure-layout")
      );
      return true;
    }

    if (target.type === "table") {
      const card = document.createElement("figure");
      card.className = "smarttex-reference-popup-target smarttex-table-popup";
      const tableContext = popupTableContext(target, source);
      const caption = contextTools.prepareDocumentCommands(
        source,
        target.sourceIndex,
        target.caption || ""
      );
      if (tableContext) {
        const preparedTable = contextTools.prepareDocumentCommands(
          source,
          target.sourceIndex,
          tableContext.source
        );
        try {
          card.appendChild(tableRenderer.renderTable({
            ...tableContext,
            source: preparedTable.body
          }, {
            commandSide: null,
            includeCaret: false,
            contextTools,
            document,
            katex,
            macros: preparedTable.macros,
            trust: trustedKatexCommand
          }));
        } catch (_error) {
          const missing = document.createElement("div");
          missing.className = "smarttex-reference-popup-missing";
          missing.textContent = "The table body could not be rendered.";
          card.appendChild(missing);
        }
      }
      appendPopupCaption(
        card,
        "Table",
        target.number,
        caption.body,
        caption.macros
      );
      container.appendChild(card);
      return true;
    }

    const card = document.createElement("div");
    card.className = "smarttex-reference-popup-target";
    if (target.title) card.textContent = target.title;
    else card.textContent = referencePopupTitle(target, target.label);
    container.appendChild(card);
    return true;
  }

  function renderCaptionReferencePopup(anchor, target) {
    if (!popupInteractionReady()) return -1;
    const parentDepth = popupDepthForElement(anchor);
    const depth = parentDepth + 1;
    if (!target || !currentState) return depth;
    if (!referenceTargetPreviewEnabled(target)) {
      if (depth <= 0) hideCaptionReferencePopup();
      else hideNestedReferencePopupsFromDepth(depth);
      return depth;
    }
    const targetKey = referenceTargetKey(target, target.label);
    const targetKeys = new Set([targetKey]);
    const parentPopup = parentDepth < 0
      ? null
      : (parentDepth === 0
        ? captionReferencePopup
        : nestedPopupState(parentDepth)?.popup);
    if (popupSharesTarget(parentPopup, targetKeys)) {
      hideNestedReferencePopupsFromDepth(Math.max(1, depth));
      return Math.max(0, parentDepth);
    }
    const popup = depth === 0
      ? ensureCaptionReferencePopup()
      : ensureNestedCaptionReferencePopup(depth);

    if (depth === 0) {
      popup.removeAttribute("data-smarttex-autocomplete-owner");
      autocompleteReferenceAnchorRect = null;
      autocompleteReferenceOwnerRect = null;
      activeEditorReferenceKey = "";
      activeEditorReferenceType = "";
      captionReferencePopupAnchor = anchor?.isConnected ? anchor : null;
      popup.classList.remove("smarttex-editor-reference-popup");
    } else {
      const state = nestedPopupState(depth, true);
      state.anchor = anchor?.isConnected ? anchor : null;
      popup.classList.remove("smarttex-editor-reference-popup");
    }

    const popupKey = [
      target.type || "reference",
      target.label || "",
      Number(target.sourceIndex) || 0
    ].join(":");
    if (!popup.hidden && popup.__smarttexKey === popupKey) {
      if (depth === 0) positionCaptionReferencePopup(anchor);
      else positionNestedCaptionReferencePopup(depth, anchor);
      return depth;
    }

    hideNestedReferencePopupsFromDepth(depth + 1);
    clearReferencePopupTimersThrough(depth);
    const scrollState = capturePopupScrollState(popup);
    popup.replaceChildren();
    const entry = document.createElement("section");
    entry.className = "smarttex-reference-popup-entry";
    appendReferencePopupHeading(entry, target, target.label);
    appendReferenceTargetPreview(entry, target, String(currentState.value || ""));
    popup.appendChild(entry);
    globalThis.SmartTeXFigureRenderer?.observePopupLayout?.(
      entry.querySelector(".smarttex-figure-layout")
    );
    popup.__smarttexKey = popupKey;
    popup.__smarttexTargetKeys = targetKeys;
    popup.dataset.smarttexContentKind = target.type === "figure"
      ? "figure"
      : target.type || "reference";
    enhanceReferencePopup(popup, popup.dataset.smarttexContentKind);
    popup.hidden = false;
    restorePopupScrollState(popup, scrollState);

    if (depth === 0) positionCaptionReferencePopup(anchor);
    else positionNestedCaptionReferencePopup(depth, anchor);
    return depth;
  }

  function editorReferenceInteractionAtIndex(sourceValue, indexValue) {
    const source = String(sourceValue || "");
    const masked = contextTools.maskIgnoredLatex(source);
    const index = Math.max(0, Math.min(Number(indexValue) || 0, source.length));
    const pattern = /\\(eqref|ref|pageref|autoref|cref|Cref|vref|Vref|nameref|cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]+)\}/g;
    let match;
    while ((match = pattern.exec(masked))) {
      if (index < match.index || index > pattern.lastIndex) continue;
      return {
        command: match[1],
        labels: match[2].split(",").map((label) => label.trim()).filter(Boolean),
        sourceIndex: match.index,
        sourceEnd: pattern.lastIndex,
        type: /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)$/i
          .test(match[1])
          ? "citation"
          : "reference"
      };
    }
    return null;
  }

  function cursorIsInsideCitationCommand(state = currentState) {
    if (!state || !Number.isInteger(state.cursorIndex)) return false;
    return editorReferenceInteractionAtIndex(
      state.value,
      state.cursorIndex
    )?.type === "citation";
  }

  function autocompleteOwnerAtCursor(state = currentState) {
    if (!state || !Number.isInteger(state.cursorIndex)) return "";
    const source = String(state.value || "");
    const index = Math.max(0, Math.min(state.cursorIndex, source.length));
    const masked = contextTools.maskIgnoredLatex(source);
    const beforeCursor = masked.slice(0, index);
    const match = beforeCursor.match(
      /\\(eqref|ref|pageref|autoref|cref|Cref|vref|Vref|nameref|cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{[^{}]*$/i
    );
    if (!match) return "";
    return /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)$/i.test(match[1])
      ? "citation"
      : "reference";
  }

  function autocompleteListAvailableAtCursor(state = currentState) {
    const owner = autocompleteOwnerAtCursor(state);
    if (owner === "reference") {
      return Boolean(document.getElementById("smarttex-reference-autocomplete-popup"));
    }
    if (owner === "citation") {
      return Boolean(document.querySelector(
        "#smarttex-citation-popup, #ctca-popup, #ctca-bib-manager"
      ));
    }
    return false;
  }

  function editorReferenceKey(interaction, state = currentState) {
    if (!interaction) return "";
    return [
      state?.fileName || "",
      interaction.sourceIndex,
      interaction.sourceEnd,
      interaction.labels?.join(",") || ""
    ].join(":");
  }

  function referenceTargetKey(target, labelValue = "") {
    const label = String(labelValue || target?.label || "").trim();
    const type = String(target?.type || "reference").trim() || "reference";
    if (label) return `${type}:${label}`;
    return `${type}:@${Math.max(0, Number(target?.sourceIndex) || 0)}`;
  }

  function interactionTargetKeys(interaction, sourceValue = currentState?.value) {
    const source = String(sourceValue || "");
    const keys = new Set();
    for (const label of interaction?.labels || []) {
      const target = interaction?.type === "citation"
        ? localCitationTarget(source, label)
        : contextTools.referenceTarget?.(source, label);
      keys.add(referenceTargetKey(target, label));
    }
    return keys;
  }

  function popupSharesTarget(popup, keys) {
    if (!popup || popup.hidden || !(keys instanceof Set) || !keys.size) return false;
    const popupKeys = popup.__smarttexTargetKeys;
    if (!(popupKeys instanceof Set)) return false;
    return [...keys].some((key) => popupKeys.has(key));
  }

  function editorReferenceEntry(popup, target, label, source, record = null) {
    if (target && !referenceTargetPreviewEnabled(target)) return false;
    const entry = document.createElement("section");
    entry.className = "smarttex-reference-popup-entry";
    appendReferencePopupHeading(entry, target, label);
    if (target.type === "citation") {
      entry.appendChild(citationPopupCard(record, target));
    } else {
      appendReferenceTargetPreview(entry, target, source);
    }
    popup.appendChild(entry);
    globalThis.SmartTeXFigureRenderer?.observePopupLayout?.(
      entry.querySelector(".smarttex-figure-layout")
    );
    return true;
  }

  function updateReferencePopupContentKind(popup) {
    const targets = [...popup.querySelectorAll(".smarttex-reference-popup-target")];
    const figureOnly = targets.length === 1 &&
      targets[0].classList.contains("smarttex-figure-popup");
    popup.dataset.smarttexContentKind = figureOnly ? "figure" : "mixed";
  }

  function renderEditorReferencePopup(
    anchorRect,
    interaction,
    { allowCitationAtCursor = false, force = false } = {}
  ) {
    if (!popupInteractionReady() || !currentState || !interaction?.labels?.length) return;
    if (
      interaction.type === "citation" &&
      cursorIsInsideCitationCommand() &&
      !allowCitationAtCursor
    ) {
      hideCaptionReferencePopup();
      return;
    }
    const source = String(currentState.value || "");
    const key = editorReferenceKey(interaction);
    activeEditorReferenceKey = key;
    activeEditorReferenceType = interaction.type;
    captionInnerReferenceActive = Boolean(
      captionContainerAtIndex(currentState, interaction.sourceIndex)
    );
    if (captionInnerReferenceActive && !preview.hidden) {
      hidePreview({ clearDismissal: false });
    }
    captionReferencePopupAnchor = null;
    hideNestedReferencePopupsFromDepth(1);
    clearReferencePopupTimer(0);
    const popup = ensureCaptionReferencePopup();
    popup.removeAttribute("data-smarttex-autocomplete-owner");
    autocompleteReferenceAnchorRect = null;
    autocompleteReferenceOwnerRect = null;
    popup.classList.add("smarttex-editor-reference-popup");
    if (!force && !popup.hidden && popup.__smarttexKey === key) {
      positionCaptionReferencePopup(anchorRect);
      return;
    }
    const scrollState = capturePopupScrollState(popup);
    popup.replaceChildren();

    if (interaction.type === "citation") {
      appendCitationRefreshControl(popup, () => {
        if (
          activeEditorReferenceKey === key &&
          popup.isConnected &&
          !popup.hidden
        ) {
          renderEditorReferencePopup(anchorRect, interaction, {
            allowCitationAtCursor,
            force: true
          });
        }
      });
      for (const label of interaction.labels.slice(0, 8)) {
        const target = localCitationTarget(source, label);
        editorReferenceEntry(
          popup,
          target,
          label,
          source,
          citationRecords.get(label) || null
        );
      }
    } else {
      for (const label of interaction.labels.slice(0, 8)) {
        const target = contextTools.referenceTarget?.(source, label);
        if (target) {
          editorReferenceEntry(popup, target, label, source);
        } else {
          const missing = document.createElement("div");
          missing.className = "smarttex-reference-popup-missing";
          missing.textContent = `Reference target “${label}” was not found.`;
          popup.appendChild(missing);
        }
      }
    }

    if (!popup.children.length) {
      hideCaptionReferencePopup();
      return;
    }
    popup.__smarttexKey = key;
    popup.__smarttexTargetKeys = interactionTargetKeys(interaction, source);
    updateReferencePopupContentKind(popup);
    enhanceReferencePopup(popup, popup.dataset.smarttexContentKind);
    popup.hidden = false;
    restorePopupScrollState(popup, scrollState);
    positionCaptionReferencePopup(anchorRect);

    if (interaction.type === "citation" && !citationRecordsLoaded) {
      loadCitationRecords().then(() => {
        if (
          activeEditorReferenceKey !== key ||
          popup.hidden ||
          !currentState
        ) return;
        renderEditorReferencePopup(anchorRect, interaction, {
          allowCitationAtCursor,
          force: true
        });
      });
    }
  }

  function renderSecondaryEditorReferencePopup(
    anchorRect,
    interaction,
    { allowCitationAtCursor = false, force = false } = {}
  ) {
    if (!popupInteractionReady() || !currentState || !interaction?.labels?.length) return;
    if (
      interaction.type === "citation" &&
      cursorIsInsideCitationCommand() &&
      !allowCitationAtCursor
    ) {
      hideNestedReferencePopupsFromDepth(1);
      activeSecondaryEditorReferenceKey = "";
      return;
    }

    const source = String(currentState.value || "");
    const key = `secondary:${editorReferenceKey(interaction)}`;
    const popup = ensureNestedCaptionReferencePopup(1);
    const state = nestedPopupState(1, true);
    state.anchor = null;
    state.anchorRect = normalizedPopupRect(anchorRect);
    hideNestedReferencePopupsFromDepth(2);
    clearReferencePopupTimer(1);
    popup.classList.add("smarttex-editor-reference-popup");

    if (!force && !popup.hidden && popup.__smarttexKey === key) {
      positionNestedCaptionReferencePopup(1, anchorRect);
      return;
    }

    const scrollState = capturePopupScrollState(popup);
    popup.replaceChildren();
    if (interaction.type === "citation") {
      appendCitationRefreshControl(popup, () => {
        if (
          activeSecondaryEditorReferenceKey === key &&
          popup.isConnected &&
          !popup.hidden
        ) {
          renderSecondaryEditorReferencePopup(anchorRect, interaction, {
            allowCitationAtCursor,
            force: true
          });
        }
      });
      for (const label of interaction.labels.slice(0, 8)) {
        const target = localCitationTarget(source, label);
        editorReferenceEntry(
          popup,
          target,
          label,
          source,
          citationRecords.get(label) || null
        );
      }
    } else {
      for (const label of interaction.labels.slice(0, 8)) {
        const target = contextTools.referenceTarget?.(source, label);
        if (target) {
          editorReferenceEntry(popup, target, label, source);
        } else {
          const missing = document.createElement("div");
          missing.className = "smarttex-reference-popup-missing";
          missing.textContent = `Reference target “${label}” was not found.`;
          popup.appendChild(missing);
        }
      }
    }

    if (!popup.children.length) {
      hideNestedReferencePopupsFromDepth(1);
      activeSecondaryEditorReferenceKey = "";
      return;
    }
    popup.__smarttexKey = key;
    popup.__smarttexTargetKeys = interactionTargetKeys(interaction, source);
    updateReferencePopupContentKind(popup);
    enhanceReferencePopup(popup, popup.dataset.smarttexContentKind);
    popup.hidden = false;
    activeSecondaryEditorReferenceKey = key;
    restorePopupScrollState(popup, scrollState);
    positionNestedCaptionReferencePopup(1, anchorRect);

    if (interaction.type === "citation" && !citationRecordsLoaded) {
      loadCitationRecords().then(() => {
        if (
          activeSecondaryEditorReferenceKey !== key ||
          popup.hidden ||
          !currentState
        ) return;
        renderSecondaryEditorReferencePopup(anchorRect, interaction, {
          allowCitationAtCursor,
          force: true
        });
      });
    }
  }

  function editorCursorAnchorRect(state = currentState) {
    const screen = state?.screen;
    if (!screen) return null;
    const left = Number(screen.pageX) - window.scrollX;
    const top = Number(screen.pageY) - window.scrollY;
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    const lineHeight = Math.max(14, Number(screen.lineHeight) || 18);
    return {
      left,
      right: left + 2,
      top,
      bottom: top + lineHeight
    };
  }

  function updateCursorTriggeredReferencePopup(state = currentState) {
    if (referencePopupUsesHover()) return false;
    if (
      !state ||
      !state.focused ||
      !Number.isInteger(state.cursorIndex) ||
      state.selectionFrom !== state.selectionTo
    ) {
      hideCaptionReferencePopup();
      return false;
    }
    if (autocompleteListAvailableAtCursor(state)) {
      hideCaptionReferencePopup();
      return true;
    }
    const interaction = editorReferenceInteractionAtIndex(
      state.value,
      state.cursorIndex
    );
    const anchorRect = editorCursorAnchorRect(state);
    if (!interaction || !anchorRect) {
      hideCaptionReferencePopup();
      return false;
    }
    const key = editorReferenceKey(interaction, state);
    if (
      key &&
      activeEditorReferenceKey === key &&
      captionReferencePopup &&
      !captionReferencePopup.hidden
    ) {
      positionCaptionReferencePopup(anchorRect);
      return true;
    }
    const spinnerGeneration = showPopupLoadingSpinner(null, anchorRect);
    window.requestAnimationFrame(() => {
      try {
        if (
          referencePopupUsesHover() ||
          currentState !== state ||
          editorReferenceInteractionAtIndex(state.value, state.cursorIndex)?.sourceIndex !==
            interaction.sourceIndex
        ) return;
        renderEditorReferencePopup(anchorRect, interaction, {
          allowCitationAtCursor: true
        });
      } finally {
        hidePopupLoadingSpinner(spinnerGeneration);
      }
    });
    return true;
  }

  function editorSurface(element) {
    return element?.closest?.(
      ".cm-content, .cm-line, .cm-scroller, .cm-editor, " +
      ".ace_content, .ace_text-layer, .ace_scroller, .ace_editor"
    ) || null;
  }

  function autocompleteSurface(element) {
    return element?.closest?.(
      "#smarttex-reference-autocomplete-popup, #smarttex-citation-popup, #smarttex-citation-autocomplete-popup"
    ) || null;
  }

  function hideNormalReferencePopupForAutocomplete() {
    const popup = captionReferencePopup;
    if (!popup || popup.hidden) return;
    if (popup.dataset.smarttexAutocompleteOwner === "reference") return;
    hideCaptionReferencePopup();
  }

  function autocompleteOwnsInteraction(interaction) {
    if (!referenceAutocompleteActive || !interaction) return false;
    if (
      Number.isInteger(autocompleteReferenceCommandStart) &&
      interaction.sourceIndex === autocompleteReferenceCommandStart
    ) return true;
    const cursorInteraction = editorReferenceInteractionAtIndex(
      currentState?.value,
      currentState?.cursorIndex
    );
    if (
      cursorInteraction?.type === "reference" &&
      interaction.type === "reference" &&
      cursorInteraction.sourceIndex === interaction.sourceIndex
    ) return true;
    const keys = interactionTargetKeys(interaction);
    if (autocompleteReferenceTargetKey && keys.has(autocompleteReferenceTargetKey)) {
      return true;
    }
    return popupSharesTarget(
      captionReferencePopup,
      keys
    );
  }

  function scheduleEditorReferenceHover(event) {
    hidePopupLoadingSpinner();
    if (referencePopupContains(event.target)) {
      const depth = popupDepthForElement(event.target);
      clearReferencePopupTimersThrough(Math.max(0, depth));
      window.clearTimeout(editorReferenceHoverTimer);
      return;
    }
    if (autocompleteSurface(event.target)) {
      window.clearTimeout(captionReferencePopupTimer);
      window.clearTimeout(editorReferenceHoverTimer);
      clearReferencePopupTimersThrough(1);
      return;
    }
    if (!referencePopupUsesHover()) {
      window.clearTimeout(editorReferenceHoverTimer);
      return;
    }
    const surface = editorSurface(event.target);
    if (!surface || !currentState) {
      if (referenceAutocompleteActive) {
        if (activeSecondaryEditorReferenceKey) {
          scheduleHideNestedReferencePopup(1);
        }
      } else if (activeEditorReferenceKey) {
        scheduleHideCaptionReferencePopup();
      }
      return;
    }

    window.clearTimeout(captionReferencePopupTimer);
    window.clearTimeout(editorReferenceHoverTimer);
    const generation = ++editorReferenceHoverGeneration;
    const clientX = event.clientX;
    const clientY = event.clientY;
    const lineHeight = Math.max(
      14,
      parseFloat(getComputedStyle(surface).lineHeight) || 18
    );
    const anchorRect = {
      left: clientX,
      right: clientX + 1,
      top: clientY - lineHeight * 0.45,
      bottom: clientY + lineHeight * 0.55
    };

    editorReferenceHoverTimer = window.setTimeout(() => {
      const spinnerGeneration = showPopupLoadingSpinner(
        { clientX, clientY },
        anchorRect
      );
      window.requestAnimationFrame(() => {
        if (generation !== editorReferenceHoverGeneration) {
          hidePopupLoadingSpinner(spinnerGeneration);
          return;
        }
        bridgeRequest("getIndexAtCoordinates", { clientX, clientY }, 1200)
          .then((response) => {
            if (generation !== editorReferenceHoverGeneration || !currentState) return;
            const interaction = editorReferenceInteractionAtIndex(
              currentState.value,
              response.index
            );
            if (
              !interaction ||
              (interaction.type === "citation" && cursorIsInsideCitationCommand())
            ) {
              if (referenceAutocompleteActive) {
                hideNestedReferencePopupsFromDepth(1);
                activeSecondaryEditorReferenceKey = "";
              } else {
                hideCaptionReferencePopup();
              }
              return;
            }
            if (referenceAutocompleteActive) {
              if (autocompleteOwnsInteraction(interaction)) {
                hideNestedReferencePopupsFromDepth(1);
                activeSecondaryEditorReferenceKey = "";
                clearReferencePopupTimer(0);
                return;
              }
              renderSecondaryEditorReferencePopup(anchorRect, interaction);
              return;
            }
            renderEditorReferencePopup(anchorRect, interaction);
          })
          .catch(() => {
            if (generation === editorReferenceHoverGeneration) {
              if (referenceAutocompleteActive) {
                scheduleHideNestedReferencePopup(1);
              } else {
                scheduleHideCaptionReferencePopup();
              }
            }
          })
          .finally(() => {
            hidePopupLoadingSpinner(spinnerGeneration);
          });
      });
    }, 75);
  }

  function createCaptionReferenceLink(reference) {
    const label = String(reference?.label || "").trim();
    const command = String(reference?.command || "ref");
    const target = contextTools.referenceTarget?.(currentState?.value, label);
    const link = document.createElement("a");
    link.className = "smarttex-document-reference smarttex-caption-reference";
    link.href = "#";
    link.textContent = referenceLinkText(command, target, label);
    link.title = target
      ? `Show ${target.type} ${target.number || label}`
      : `Reference ${label}`;
    // Consume the press before it reaches the editor below the transient popup.
    // Otherwise the editor may update its cursor state and rebuild the popup
    // between pointerdown and click, so the link disappears before its click
    // handler can run.
    link.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    link.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideCaptionReferencePopup();
      if (target?.sourceIndex === undefined) return;
      announceNavigationOrigin(target.sourceIndex);
      bridgeRequest("setCursor", {
        index: target.sourceIndex,
        focus: true
      }).catch((error) => {
        console.warn("SmartTeX could not navigate to the caption reference:", error);
      });
    });
    let hoverPopupDepth = null;
    const show = (event) => {
      if (!referencePopupUsesHover() || !referenceTargetPreviewEnabled(target)) return;
      const spinnerGeneration = showPopupLoadingSpinner(event, link);
      window.requestAnimationFrame(() => {
        try {
          hoverPopupDepth = renderCaptionReferencePopup(link, target);
        } finally {
          hidePopupLoadingSpinner(spinnerGeneration);
        }
      });
    };
    const scheduleHide = () => {
      const depth = Number.isInteger(hoverPopupDepth)
        ? hoverPopupDepth
        : popupDepthForElement(link) + 1;
      if (depth <= 0) scheduleHideCaptionReferencePopup();
      else scheduleHideNestedReferencePopup(depth);
    };
    link.addEventListener("pointerenter", show);
    link.addEventListener("focus", show);
    link.addEventListener("pointerleave", scheduleHide);
    link.addEventListener("blur", scheduleHide);
    return link;
  }

  function normalizedPopupRect(value) {
    if (!value) return null;
    return {
      left: Number(value.left) || 0,
      right: Number(value.right ?? value.left) || 0,
      top: Number(value.top) || 0,
      bottom: Number(value.bottom ?? value.top) || 0
    };
  }

  function positionAutocompleteReferencePopup(anchorValue, ownerValue) {
    if (!captionReferencePopup || captionReferencePopup.hidden) return;
    const anchor = normalizedPopupRect(anchorValue);
    const owner = normalizedPopupRect(ownerValue);
    if (!anchor || !owner) return;
    autocompleteReferenceAnchorRect = anchor;
    autocompleteReferenceOwnerRect = owner;
    captionReferencePopupAnchorRect = anchor;

    captionReferencePopup.classList.remove("smarttex-reference-popup-compact");
    captionReferencePopup.style.removeProperty("width");
    captionReferencePopup.style.removeProperty("max-width");
    let popupRect = captionReferencePopup.getBoundingClientRect();
    const margin = 10;
    const gap = 10;
    const availableRight = Math.max(0, window.innerWidth - margin - owner.right - gap);
    const availableLeft = Math.max(0, owner.left - gap - margin);
    let left;

    if (popupRect.width <= availableRight) {
      left = owner.right + gap;
    } else if (popupRect.width <= availableLeft) {
      left = owner.left - gap - popupRect.width;
    } else {
      // Keep the selected-item preview next to the completion list rather than
      // covering it. When neither side has enough room, compact the preview and
      // use the wider side. Figures, tables, equations, and text scale down with it.
      const useRight = availableRight >= availableLeft;
      const available = Math.max(180, useRight ? availableRight : availableLeft);
      const compactWidth = Math.min(430, available);
      captionReferencePopup.classList.add("smarttex-reference-popup-compact");
      captionReferencePopup.style.width = `${Math.round(compactWidth)}px`;
      captionReferencePopup.style.maxWidth = `${Math.round(compactWidth)}px`;
      globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
        captionReferencePopup.querySelector(".smarttex-figure-layout")
      );
      popupRect = captionReferencePopup.getBoundingClientRect();
      left = useRight
        ? Math.min(window.innerWidth - margin - popupRect.width, owner.right + gap)
        : Math.max(margin, owner.left - gap - popupRect.width);
    }

    const top = Math.max(
      margin,
      Math.min(anchor.top - 8, window.innerHeight - popupRect.height - margin)
    );
    captionReferencePopup.style.left = `${Math.round(Math.max(margin, left))}px`;
    captionReferencePopup.style.top = `${Math.round(top)}px`;
  }

  function addEquationReferencePopupZoom(popup, anchorRect, ownerRect) {
    const equation = popup.querySelector(".smarttex-reference-popup-equation");
    const heading = popup.querySelector(".smarttex-reference-popup-heading");
    if (!equation || !heading) return;

    popup.classList.add("smarttex-reference-popup-click-preview");
    const actions = document.createElement("span");
    actions.className = "smarttex-reference-popup-actions";
    const zoomControls = document.createElement("span");
    zoomControls.className = "smarttex-equation-popup-zoom-controls";
    const zoomOut = document.createElement("button");
    zoomOut.type = "button";
    zoomOut.textContent = "−";
    zoomOut.setAttribute("aria-label", "Zoom equation out");
    const zoomValue = document.createElement("output");
    zoomValue.textContent = "100%";
    zoomValue.setAttribute("aria-label", "Equation zoom level");
    const zoomIn = document.createElement("button");
    zoomIn.type = "button";
    zoomIn.textContent = "+";
    zoomIn.setAttribute("aria-label", "Zoom equation in");
    zoomControls.append(zoomOut, zoomValue, zoomIn);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "smarttex-reference-popup-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close equation preview");
    close.title = "Close equation preview";
    actions.append(zoomControls, close);
    heading.appendChild(actions);

    const surface = document.createElement("div");
    surface.className = "smarttex-equation-popup-zoom-surface";
    surface.append(...equation.childNodes);
    const stage = document.createElement("div");
    stage.className = "smarttex-equation-popup-zoom-stage";
    stage.appendChild(surface);
    equation.appendChild(stage);

    let scale = 1;
    let naturalWidth = 1;
    let naturalHeight = 1;
    const applyZoom = () => {
      const viewportWidth = Math.max(1, equation.clientWidth - 8);
      const scaledWidth = naturalWidth * scale;
      const scaledHeight = naturalHeight * scale;
      const stageWidth = Math.max(viewportWidth, scaledWidth);
      stage.style.width = `${Math.ceil(stageWidth)}px`;
      stage.style.height = `${Math.ceil(scaledHeight)}px`;
      surface.style.left = `${Math.max(0, (stageWidth - scaledWidth) / 2)}px`;
      surface.style.transform = `scale(${scale})`;
      zoomValue.textContent = `${Math.round(scale * 100)}%`;
      window.requestAnimationFrame(() => {
        if (!popup.hidden) positionAutocompleteReferencePopup(anchorRect, ownerRect);
      });
    };
    const setZoom = (nextScale) => {
      scale = Math.max(0.5, Math.min(4, Number(nextScale) || 1));
      applyZoom();
    };
    const consumePress = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    for (const control of [zoomOut, zoomIn, close]) {
      control.addEventListener("pointerdown", consumePress);
      control.addEventListener("mousedown", consumePress);
    }
    zoomOut.addEventListener("click", (event) => {
      consumePress(event);
      setZoom(scale - 0.25);
    });
    zoomIn.addEventListener("click", (event) => {
      consumePress(event);
      setZoom(scale + 0.25);
    });
    popup.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.metaKey || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      setZoom(scale + (event.deltaY < 0 ? 0.25 : -0.25));
    }, { passive: false });
    close.addEventListener("click", (event) => {
      consumePress(event);
      hideCaptionReferencePopup();
    });
    enhanceReferencePopup(popup, "equation");

    window.requestAnimationFrame(() => {
      const rect = surface.getBoundingClientRect();
      naturalWidth = Math.max(1, surface.scrollWidth, rect.width);
      naturalHeight = Math.max(1, surface.scrollHeight, rect.height);
      applyZoom();
    });
  }

  function showReferenceAutocompletePreview(detailValue) {
    let detail = detailValue;
    if (typeof detailValue === "string") {
      try {
        detail = JSON.parse(detailValue);
      } catch (_error) {
        return;
      }
    }
    const label = String(detail?.label || "").trim();
    autocompleteReferenceCommandStart = Number.isFinite(Number(detail?.sourceIndex))
      ? Number(detail.sourceIndex)
      : null;
    const anchorRect = normalizedPopupRect(detail?.anchorRect);
    const ownerRect = normalizedPopupRect(detail?.ownerRect);
    const clickMode = detail?.mode === "click" && detail?.zoomable === true;
    if (!currentState || !label || !anchorRect || !ownerRect) return;
    const target = contextTools.referenceTarget?.(currentState.value, label);
    if (!target || !referenceTargetPreviewEnabled(target)) {
      autocompleteReferenceTargetKey = "";
      hideCaptionReferencePopup();
      return;
    }
    autocompleteReferenceTargetKey = referenceTargetKey(target, label);
    const spinnerGeneration = showPopupLoadingSpinner({
      clientX: (anchorRect.left + anchorRect.right) / 2,
      clientY: (anchorRect.top + anchorRect.bottom) / 2
    }, anchorRect);
    window.requestAnimationFrame(() => {
      try {
        const popup = ensureCaptionReferencePopup();
        renderEditorReferencePopup(anchorRect, {
          command: String(detail?.command || "ref"),
          labels: [label],
          sourceIndex: Number(target.sourceIndex) || 0,
          sourceEnd: Number(target.sourceIndex) || 0,
          type: "reference"
        }, {
          force: clickMode || popup.classList.contains(
            "smarttex-reference-popup-click-preview"
          )
        });
        popup.classList.toggle("smarttex-reference-popup-click-preview", clickMode);
        popup.dataset.smarttexAutocompleteOwner = clickMode
          ? "reference-click"
          : "reference";
        if (clickMode) addEquationReferencePopupZoom(popup, anchorRect, ownerRect);
        positionAutocompleteReferencePopup(anchorRect, ownerRect);
      } finally {
        hidePopupLoadingSpinner(spinnerGeneration);
      }
    });
  }

  function hideReferenceAutocompletePreview() {
    if (
      captionReferencePopup?.dataset.smarttexAutocompleteOwner === "reference"
    ) {
      hideCaptionReferencePopup();
    }
    autocompleteReferenceTargetKey = "";
  }

  function configureFigurePopupImage(node, imageModel) {
    const localRatio = Number(imageModel?.width?.localRatio);
    const fixedWidth = Number(imageModel?.width?.fixedPx);
    const scale = Number(imageModel?.scale);
    node.dataset.smarttexLocalWidthRatio = String(
      Number.isFinite(localRatio) && localRatio > 0 ? localRatio : 1
    );
    if (Number.isFinite(fixedWidth) && fixedWidth > 0) {
      node.dataset.smarttexFixedWidthPx = String(fixedWidth);
    }
    const imageScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    node.dataset.smarttexImageScale = String(imageScale);
    if (Number.isFinite(fixedWidth) && fixedWidth > 0) {
      node.style.width = `${fixedWidth * imageScale}px`;
    } else {
      const widthPercent = Math.max(
        5,
        (Number.isFinite(localRatio) && localRatio > 0 ? localRatio : 1) * imageScale * 100
      );
      node.style.width = `${widthPercent}%`;
    }
  }

  function renderFigurePopup(
    context,
    figureNumber,
    captionText,
    macros,
    captionSourceOffset = null
  ) {
    const figure = document.createElement("figure");
    figure.className = "smarttex-figure-popup";
    const renderer = globalThis.SmartTeXFigureRenderer;
    const layoutModel = renderer?.parseFigureLayout?.(context.source || "", { environment: context.environment }) || {
      desiredWidthPx: 520,
      rows: []
    };
    const viewport = document.createElement("div");
    viewport.className = "smarttex-figure-popup-viewport";
    const media = document.createElement("div");
    media.className = "smarttex-figure-popup-media smarttex-figure-layout";
    const desiredWidth = Math.max(40, Number(layoutModel.desiredWidthPx) || 520);
    media.dataset.smarttexDesiredWidthPx = String(desiredWidth);
    // Give resolving placeholders real first-frame geometry. Percentage-width
    // panels inside a max-content container otherwise have no intrinsic width,
    // making the initial popup look like it contains only its caption until a
    // cached image supplies dimensions on a later opening.
    media.style.width = `${desiredWidth}px`;

    let imageCount = 0;
    const mediaReadyPromises = [];
    for (const rowModel of layoutModel.rows || []) {
      const row = document.createElement("div");
      row.className = "smarttex-figure-layout-row";
      const rowItems = rowModel.items || [];
      const relativeTotal = Math.max(
        0,
        Number(rowModel.relativeWidthRatio) || rowItems.reduce(
          (sum, item) => sum + (
            item.fixedWidthPx ? 0 : Math.max(0, Number(item.widthRatio) || 1)
          ),
          0
        )
      );
      const normalizeRelativeWidths = Boolean(
        rowModel.normalizeRelativeWidths ?? (
          !rowItems.some((item) => Number(item.fixedWidthPx) > 0) &&
          relativeTotal > 0
        )
      );
      for (const panelModel of rowItems) {
        const panel = document.createElement("div");
        panel.className = "smarttex-figure-layout-panel";
        const widthRatio = Math.max(0.05, Number(panelModel.widthRatio) || 1);
        panel.dataset.smarttexWidthRatio = String(widthRatio);
        panel.style.setProperty("--smarttex-panel-width-ratio", String(widthRatio));
        const rowFraction = normalizeRelativeWidths
          ? widthRatio / relativeTotal
          : widthRatio;
        panel.style.flexBasis = `${Math.min(135, rowFraction * 100)}%`;
        const fixedPanelWidth = Number(panelModel.fixedWidthPx);
        if (Number.isFinite(fixedPanelWidth) && fixedPanelWidth > 0) {
          panel.dataset.smarttexFixedPanelWidthPx = String(fixedPanelWidth);
          panel.style.setProperty(
            "--smarttex-panel-fixed-width",
            `${fixedPanelWidth}px`
          );
          panel.classList.add("smarttex-figure-layout-panel-fixed");
        }
        for (const imageModel of panelModel.images || []) {
          imageCount += 1;
          const placeholder = figurePopupPlaceholder(imageModel.path, true);
          configureFigurePopupImage(placeholder, imageModel);
          panel.appendChild(placeholder);
          mediaReadyPromises.push(resolveFigurePopupFile(imageModel.path, placeholder));
        }
        row.appendChild(panel);
      }
      media.appendChild(row);
    }
    if (!imageCount) {
      const row = document.createElement("div");
      row.className = "smarttex-figure-layout-row";
      const panel = document.createElement("div");
      panel.className = "smarttex-figure-layout-panel";
      panel.dataset.smarttexWidthRatio = "1";
      panel.style.setProperty("--smarttex-panel-width-ratio", "1");
      panel.style.flexBasis = "100%";
      panel.appendChild(figurePopupPlaceholder("No image in this figure"));
      row.appendChild(panel);
      media.appendChild(row);
    }
    viewport.appendChild(media);
    figure.appendChild(viewport);
    appendPopupCaption(
      figure,
      "Fig.",
      figureNumber,
      captionText,
      macros,
      captionSourceOffset
    );
    renderer?.observePopupLayout?.(media);
    // The opening pipeline waits for cold image/PDF resolution before it ever
    // measures or reveals this figure. Failed files resolve to their stable
    // placeholder, so one missing asset cannot block the whole popup.
    figure.__smarttexReadyPromise = Promise.allSettled(mediaReadyPromises);
    return figure;
  }

  function trustedKatexCommand(context) {
    return (
      context?.command === "\\htmlClass" &&
      [
        "smarttex-rendered-caret",
        "smarttex-rendered-operator-caret",
        "smarttex-popup-selection"
      ].includes(
        context?.class
      )
    );
  }


  function clearPopupSelectionHighlight(root = output) {
    try {
      globalThis.CSS?.highlights?.delete?.(POPUP_SELECTION_HIGHLIGHT);
    } catch (_error) {
      // CSS Highlights are optional; class-based fallbacks are removed below.
    }
    root?.querySelectorAll?.(".smarttex-popup-source-selected").forEach((node) => {
      node.classList.remove("smarttex-popup-source-selected");
    });
  }

  function sourceSelectionForContext(state, context) {
    const range = contextEnvironmentRange(context);
    return sourceSelectionForRange(state, range.openStart, range.closeEnd);
  }

  function sourceSelectionForRange(state, rangeStartValue, rangeEndValue) {
    const start = Math.min(
      Number(state?.selectionFrom ?? state?.cursorIndex) || 0,
      Number(state?.selectionTo ?? state?.cursorIndex) || 0
    );
    const end = Math.max(
      Number(state?.selectionFrom ?? state?.cursorIndex) || 0,
      Number(state?.selectionTo ?? state?.cursorIndex) || 0
    );
    if (end <= start) return null;
    const rangeStart = Math.max(0, Number(rangeStartValue) || 0);
    const rangeEnd = Math.max(rangeStart, Number(rangeEndValue) || 0);
    if (end <= rangeStart || start >= rangeEnd) return null;
    return { start, end };
  }

  function textNodeSelectionRange(node, selectionStart, selectionEnd) {
    const boundaries = node?.smarttexSourceBoundaries;
    if (!Array.isArray(boundaries) || boundaries.length !== node.length + 1) return null;
    let first = -1;
    let last = -1;
    for (let index = 0; index < node.length; index += 1) {
      const sourceStart = Math.min(boundaries[index], boundaries[index + 1]);
      const sourceEnd = Math.max(boundaries[index], boundaries[index + 1]);
      if (sourceEnd <= selectionStart || sourceStart >= selectionEnd) continue;
      if (first < 0) first = index;
      last = index + 1;
    }
    if (first < 0 || last <= first) return null;
    const range = document.createRange();
    range.setStart(node, first);
    range.setEnd(node, last);
    return range;
  }

  function applyPopupSelectionHighlight(root, state, context) {
    clearPopupSelectionHighlight(root);
    const selection = sourceSelectionForContext(state, context);
    if (!selection || !root) return;
    const ranges = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const range = textNodeSelectionRange(node, selection.start, selection.end);
      if (range) ranges.push(range);
    }
    if (ranges.length && globalThis.CSS?.highlights && globalThis.Highlight) {
      try {
        globalThis.CSS.highlights.set(
          POPUP_SELECTION_HIGHLIGHT,
          new Highlight(...ranges)
        );
      } catch (_error) {
        // Fall through to coarse element highlighting below.
      }
    }
    root.querySelectorAll("*").forEach((element) => {
      const sourceRange = element.smarttexSourceRange;
      if (!sourceRange) return;
      const overlaps = (
        Number(sourceRange.end) > selection.start &&
        Number(sourceRange.start) < selection.end
      );
      if (overlaps && ![...element.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && child.smarttexSourceBoundaries
      )) {
        element.classList.add("smarttex-popup-source-selected");
      }
    });
  }

  function errorMessage(error) {
    return String(error?.message || error || "The equation is temporarily incomplete.")
      .replace(/^KaTeX parse error:\s*/i, "")
      .slice(0, 500);
  }

  function previewPinnedDuringEditorTyping() {
    if (
      preview.hidden ||
      !previewPositioned ||
      !activePreviewContext ||
      !activePreviewState ||
      !currentState ||
      currentState.focused === false ||
      Date.now() - lastEditorTextInputAt >= 650 ||
      String(currentState.fileName || "") !== String(activePreviewState.fileName || "")
    ) return false;
    const range = contextEnvironmentRange(activePreviewContext);
    const sourceLengthDelta = String(currentState.value || "").length -
      String(activePreviewState.value || "").length;
    const cursor = Number(currentState.cursorIndex);
    const adjustedCloseEnd = Math.max(
      range.openStart,
      range.closeEnd + sourceLengthDelta
    );
    return Number.isInteger(cursor) && cursor >= range.openStart && cursor <= adjustedCloseEnd;
  }

  function positionPreviewAtCursor({ force = false, preferPointer = false } = {}) {
    const anchor = (preferPointer && lastPointerScreen) || activePreviewState?.screen || currentState?.screen;
    if (preview.hidden || !anchor) return;
    preview.dataset.anchorMode = preferPointer && lastPointerScreen
      ? "pointer"
      : "cursor";
    const margin = 12;
    const cursorLeft = Number(anchor.pageX) - window.scrollX;
    const cursorTop = Number(anchor.pageY) - window.scrollY;
    const lineHeight = Math.max(14, Number(anchor.lineHeight) || 16);
    const gap = lineHeight * 2;
    const cursorRect = {
      left: cursorLeft - 1,
      right: cursorLeft + 3,
      top: cursorTop,
      bottom: cursorTop + lineHeight
    };

    preview.classList.add("smarttex-preview-measuring");
    const rect = preview.getBoundingClientRect();
    const width = Math.min(rect.width || 360, window.innerWidth - margin * 2);
    const height = Math.min(rect.height || 100, window.innerHeight - margin * 2);

    // Typing and cursor movement do not pin the popup unconditionally. They use
    // the same safety-margin rule as every other editor update: keep the exact
    // coordinates while the caret is safely away, but relocate when the caret
    // would otherwise run into the popup. This avoids per-key wandering without
    // allowing the popup to cover the text being edited.

    const cursorClearance = Math.max(12, Math.round(lineHeight * 1.25));
    const popupTooCloseToCursor = (
      rect.left < cursorRect.right + cursorClearance &&
      rect.right > cursorRect.left - cursorClearance &&
      rect.top < cursorRect.bottom + cursorClearance &&
      rect.bottom > cursorRect.top - cursorClearance
    );
    if (!force && previewPositioned && !popupTooCloseToCursor) {
      // Once visible, cursor proximity is the *only* automatic relocation
      // trigger. Arrow-key movement, typing, cache refreshes, image decoding,
      // editor scrolling and layout/viewport changes must leave the popup at
      // exactly the same coordinates while the caret remains safely away. The
      // popup is already size-limited to the usable viewport by the fit policy,
      // so silently re-anchoring it for unrelated viewport changes is both
      // unnecessary and visually disruptive.
      verticalScrollRepositionPending = false;
      preview.classList.remove("smarttex-preview-measuring");
      return;
    }

    const preferredLeft = previewPositioned && !force
      ? rect.left
      : cursorLeft - Math.min(48, width * 0.12);
    const left = Math.max(
      margin,
      Math.min(preferredLeft, window.innerWidth - width - margin)
    );
    const spaceAbove = cursorTop - gap - margin;
    const spaceBelow = window.innerHeight - (cursorTop + lineHeight + gap) - margin;
    const fitsAbove = spaceAbove >= height;
    const fitsBelow = spaceBelow >= height;
    let placeAbove;

    if (popupTooCloseToCursor && preview.dataset.placement === "above") {
      placeAbove = !fitsBelow && fitsAbove;
    } else if (popupTooCloseToCursor && preview.dataset.placement === "below") {
      placeAbove = fitsAbove || !fitsBelow;
    } else if (fitsAbove !== fitsBelow) {
      placeAbove = fitsAbove;
    } else {
      placeAbove = spaceAbove >= spaceBelow;
    }

    const top = placeAbove
      ? Math.max(margin, cursorTop - gap - height)
      : Math.min(window.innerHeight - height - margin, cursorTop + lineHeight + gap);

    preview.dataset.placement = placeAbove ? "above" : "below";
    preview.style.left = `${Math.round(left)}px`;
    preview.style.top = `${Math.round(Math.max(margin, top))}px`;
    previewPositioned = true;
    verticalScrollRepositionPending = false;
    preview.classList.remove("smarttex-preview-measuring");
  }

  function environmentPopupContext(context) {
    if (!context?.environment) return false;
    return (
      context.kind === "environment" ||
      context.kind === "table" ||
      context.kind === "figure"
    );
  }

  function environmentBoundaryIndex(context, closing = false) {
    if (!closing && Number.isFinite(Number(context?.floatOpenStart))) {
      return Math.max(0, Number(context.floatOpenStart));
    }
    if (closing && Number.isFinite(Number(context?.floatContentEnd))) {
      return Math.max(0, Number(context.floatContentEnd));
    }
    if (!closing) return Math.max(0, Number(context?.openStart) || 0);
    const contentEnd = Number(context?.contentEnd);
    if (Number.isFinite(contentEnd)) return Math.max(0, contentEnd);
    return Math.max(0, Number(context?.closeEnd) || 0);
  }

  async function editorCoordinateAt(index) {
    try {
      const response = await bridgeRequest("getCoordinates", { index }, 1200);
      return response?.screen || null;
    } catch (_error) {
      return null;
    }
  }

  function positionPreviewAtEnvironment(openingScreen, closingScreen) {
    if (preview.hidden || (!openingScreen && !closingScreen)) return false;
    const margin = 12;
    const defaultLineHeight = Math.max(
      14,
      Number(activePreviewState?.screen?.lineHeight || currentState?.screen?.lineHeight) || 16
    );
    const opening = openingScreen ? {
      left: Number(openingScreen.pageX) - window.scrollX,
      top: Number(openingScreen.pageY) - window.scrollY,
      lineHeight: Math.max(14, Number(openingScreen.lineHeight) || defaultLineHeight)
    } : null;
    const closing = closingScreen ? {
      left: Number(closingScreen.pageX) - window.scrollX,
      top: Number(closingScreen.pageY) - window.scrollY,
      lineHeight: Math.max(14, Number(closingScreen.lineHeight) || defaultLineHeight)
    } : null;

    preview.classList.add("smarttex-preview-measuring");
    const rect = preview.getBoundingClientRect();
    const width = Math.min(rect.width || 360, window.innerWidth - margin * 2);
    const height = Math.min(rect.height || 100, window.innerHeight - margin * 2);
    const openingGap = Math.max(12, Math.round((opening?.lineHeight || defaultLineHeight) * 0.75));
    const closingGap = Math.max(12, Math.round((closing?.lineHeight || defaultLineHeight) * 0.75));
    const spaceAbove = opening ? opening.top - openingGap - margin : -Infinity;
    const closingBottom = closing ? closing.top + closing.lineHeight : Infinity;
    const spaceBelow = closing
      ? window.innerHeight - closingBottom - closingGap - margin
      : -Infinity;
    const fitsAbove = Boolean(opening) && spaceAbove >= height;
    const fitsBelow = Boolean(closing) && spaceBelow >= height;

    if (!fitsAbove && !fitsBelow) {
      preview.classList.remove("smarttex-preview-measuring");
      return false;
    }

    const placeAbove = fitsAbove && (!fitsBelow || spaceAbove >= spaceBelow);
    const anchor = placeAbove ? opening : closing;
    const preferredLeft = anchor.left - Math.min(48, width * 0.12);
    const left = Math.max(
      margin,
      Math.min(preferredLeft, window.innerWidth - width - margin)
    );
    const top = placeAbove
      ? opening.top - openingGap - height
      : closingBottom + closingGap;

    preview.dataset.placement = placeAbove ? "above" : "below";
    preview.dataset.anchorMode = "environment";
    preview.style.left = `${Math.round(left)}px`;
    preview.style.top = `${Math.round(Math.max(
      margin,
      Math.min(top, window.innerHeight - height - margin)
    ))}px`;
    previewPositioned = true;
    verticalScrollRepositionPending = false;
    preview.classList.remove("smarttex-preview-measuring");
    return true;
  }

  function positionPreview() {
    if (preview.hidden) return;

    // Environment-boundary positioning is an opening-time decision only. Once
    // visible, keep the popup exactly where it is and let the cursor-proximity
    // guard move it only when the cursor approaches/overlaps the popup. This
    // prevents image-load, cache,
    // and background-refresh callbacks from making a stationary popup wander.
    if (
      previewPositioned &&
      preview.dataset.smarttexStaging !== "true" &&
      preview.classList.contains("smarttex-preview-visible")
    ) {
      previewPositionGeneration += 1;
      positionPreviewAtCursor({
        preferPointer: activePreviewState?.smarttexHoverPreview === true
      });
      return;
    }

    const context = activePreviewContext;
    if (!environmentPopupContext(context)) {
      previewPositionGeneration += 1;
      positionPreviewAtCursor();
      return;
    }

    const generation = ++previewPositionGeneration;
    const contextId = activeContextId;
    Promise.all([
      editorCoordinateAt(environmentBoundaryIndex(context, false)),
      editorCoordinateAt(environmentBoundaryIndex(context, true))
    ]).then(([openingScreen, closingScreen]) => {
      if (
        generation !== previewPositionGeneration ||
        preview.hidden ||
        contextId !== activeContextId
      ) return;
      // If the environment extends so far that the popup fits neither above
      // its \\begin line nor below its \\end line, the cursor is the only
      // useful visible anchor.
      if (!positionPreviewAtEnvironment(openingScreen, closingScreen)) {
        positionPreviewAtCursor({ force: true, preferPointer: true });
      }
    });
  }

  function nextPreviewFrame() {
    return new Promise((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
      } else {
        window.setTimeout(resolve, 0);
      }
    });
  }

  async function positionPreviewForReveal() {
    if (preview.hidden) return false;
    const context = activePreviewContext;
    if (!environmentPopupContext(context)) {
      previewPositionGeneration += 1;
      positionPreviewAtCursor({
        force: true,
        preferPointer: activePreviewState?.smarttexHoverPreview === true
      });
      return true;
    }

    const generation = ++previewPositionGeneration;
    const contextId = activeContextId;
    const [openingScreen, closingScreen] = await Promise.all([
      editorCoordinateAt(environmentBoundaryIndex(context, false)),
      editorCoordinateAt(environmentBoundaryIndex(context, true))
    ]);
    if (
      generation !== previewPositionGeneration ||
      preview.hidden ||
      contextId !== activeContextId
    ) return false;
    if (!positionPreviewAtEnvironment(openingScreen, closingScreen)) {
      positionPreviewAtCursor({ force: true, preferPointer: true });
    }
    return true;
  }

  function previewOverflowMetrics() {
    const popupRect = preview.getBoundingClientRect();
    const outputRect = output.getBoundingClientRect();

    // The output element can be taller/wider than the fixed outer popup while
    // the outer popup clips it with overflow:hidden. Looking only at
    // output.clientHeight/scrollHeight therefore misses precisely the case in
    // which a figure caption falls below the popup bottom. Measure the actual
    // space remaining inside the outer popup as well.
    const availableWidth = Math.max(
      1,
      Math.min(
        output.clientWidth || outputRect.width || 1,
        popupRect.right - outputRect.left - 1
      )
    );
    const availableHeight = Math.max(
      1,
      Math.min(
        output.clientHeight || outputRect.height || 1,
        popupRect.bottom - outputRect.top - 1
      )
    );
    const figurePopup = preview.dataset.previewKind === "figure"
      ? output.querySelector(":scope > .smarttex-figure-popup")
      : null;
    const figureViewport = figurePopup?.querySelector(":scope > .smarttex-figure-popup-viewport") || null;
    const figureMedia = figureViewport?.querySelector(".smarttex-figure-popup-media") || null;
    const viewportRect = figureViewport?.getBoundingClientRect?.() || null;
    const mediaRect = figureMedia?.getBoundingClientRect?.() || null;
    const mediaOverflowWidth = figureViewport && figureMedia
      ? Math.max(0, Math.max(figureMedia.scrollWidth || 0, mediaRect?.width || 0) -
        Math.max(1, figureViewport.clientWidth || viewportRect?.width || 1))
      : 0;
    const mediaOverflowHeight = figureViewport && figureMedia
      ? Math.max(0, Math.max(figureMedia.scrollHeight || 0, mediaRect?.height || 0) -
        Math.max(1, figureViewport.clientHeight || viewportRect?.height || 1))
      : 0;

    // A fixed figure viewport intentionally clips oversized media so that the
    // caption can keep its own row. Include that hidden media excess in the
    // fit calculation; otherwise the outer output looks non-overflowing and
    // the policy would enable a scrollbar instead of shrinking the image.
    const contentWidth = Math.max(
      output.scrollWidth || 0,
      outputRect.width || 0,
      availableWidth + mediaOverflowWidth,
      availableWidth
    );
    const outputStyle = globalThis.getComputedStyle?.(output);
    const outputVerticalPadding = (parseFloat(outputStyle?.paddingTop) || 0) +
      (parseFloat(outputStyle?.paddingBottom) || 0);
    const figureRequiredHeight = figurePopup
      ? Math.max(
          Number(figurePopup.dataset.smarttexRequiredHeightPx) || 0,
          figurePopup.scrollHeight || 0,
          figurePopup.getBoundingClientRect?.().height || 0
        ) + outputVerticalPadding
      : 0;
    const contentHeight = Math.max(
      output.scrollHeight || 0,
      outputRect.height || 0,
      availableHeight + mediaOverflowHeight,
      figureRequiredHeight,
      availableHeight
    );
    return {
      clientWidth: availableWidth,
      clientHeight: availableHeight,
      scrollWidth: contentWidth,
      scrollHeight: contentHeight,
      widthRatio: availableWidth / contentWidth,
      heightRatio: availableHeight / contentHeight,
      overflowX: contentWidth > availableWidth + 1,
      overflowY: contentHeight > availableHeight + 1,
      mediaOverflowWidth,
      mediaOverflowHeight
    };
  }

  function setPreviewAutoFitZoomAndMeasure(value) {
    previewAutoFitZoom = Math.max(0.75, Math.min(1, Number(value) || 1));
    refreshPreviewZoom();
    globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
      output.querySelector(".smarttex-figure-layout")
    );
    return previewOverflowMetrics();
  }

  function finishPreviewAutoFitNow() {
    let metrics = previewOverflowMetrics();
    if (!metrics.overflowX && !metrics.overflowY) {
      preview.classList.remove("smarttex-preview-scroll-fallback");
      return metrics;
    }

    // Do not decide that scrollbars are necessary from a single proportional
    // estimate. Cached DOM in particular can have slightly different live font
    // or image metrics than the geometry stored with the cache entry. Probe the
    // actual 75% floor first; if it fits, binary-search back upward to the
    // largest no-scroll zoom. This exact live-DOM solver is shared by cold and
    // warm paths so cached previews cannot acquire scrollbars that a fresh
    // render would avoid by shrinking a little more.
    const floorMetrics = setPreviewAutoFitZoomAndMeasure(0.75);
    if (floorMetrics.overflowX || floorMetrics.overflowY) {
      preview.classList.add("smarttex-preview-scroll-fallback");
      return floorMetrics;
    }

    let lowerFit = 0.75;
    let upperOverflow = 1;
    let bestMetrics = floorMetrics;
    for (let iteration = 0; iteration < 7; iteration += 1) {
      const candidate = (lowerFit + upperOverflow) / 2;
      const candidateMetrics = setPreviewAutoFitZoomAndMeasure(candidate);
      if (candidateMetrics.overflowX || candidateMetrics.overflowY) {
        upperOverflow = candidate;
      } else {
        lowerFit = candidate;
        bestMetrics = candidateMetrics;
      }
    }
    // Stay a few thousandths below the binary boundary to absorb integer-pixel
    // scrollbar/rounding differences. If that boundary is still unstable,
    // fall back to the already-proven 75% fit rather than enabling scrollbars.
    bestMetrics = setPreviewAutoFitZoomAndMeasure(Math.max(0.75, lowerFit - 0.003));
    if (bestMetrics.overflowX || bestMetrics.overflowY) {
      bestMetrics = setPreviewAutoFitZoomAndMeasure(0.75);
    }
    preview.classList.remove("smarttex-preview-scroll-fallback");
    return bestMetrics;
  }

  function applyPreviewAutoFitPolicyNow(prepared, { allowGrow = true } = {}) {
    previewAutoFitZoom = 1;
    preview.classList.remove("smarttex-preview-scroll-fallback");
    refreshPreviewZoom();
    globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
      output.querySelector(".smarttex-figure-layout")
    );

    let metrics = previewOverflowMetrics();
    if (allowGrow && (metrics.overflowX || metrics.overflowY)) {
      const popupRect = preview.getBoundingClientRect();
      previewPopupUI?.growForContent?.({
        width: popupRect.width + Math.max(0, metrics.scrollWidth - metrics.clientWidth),
        height: popupRect.height + Math.max(0, metrics.scrollHeight - metrics.clientHeight),
        maxWidth: prepared?.maxWidth,
        maxHeight: prepared?.maxHeight
      });
      previewAutoFitZoom = 1;
      refreshPreviewZoom();
      globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
        output.querySelector(".smarttex-figure-layout")
      );
      metrics = previewOverflowMetrics();
    }

    if (metrics.overflowX || metrics.overflowY) {
      return finishPreviewAutoFitNow();
    }
    preview.classList.remove("smarttex-preview-scroll-fallback");
    return metrics;
  }

  async function applyPreviewAutoFitPolicy(prepared, { allowGrow = true } = {}) {
    previewAutoFitZoom = 1;
    preview.classList.remove("smarttex-preview-scroll-fallback");
    refreshPreviewZoom();
    globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
      output.querySelector(".smarttex-figure-layout")
    );
    await nextPreviewFrame();

    let metrics = previewOverflowMetrics();
    if (allowGrow && (metrics.overflowX || metrics.overflowY)) {
      const popupRect = preview.getBoundingClientRect();
      previewPopupUI?.growForContent?.({
        width: popupRect.width + Math.max(0, metrics.scrollWidth - metrics.clientWidth),
        height: popupRect.height + Math.max(0, metrics.scrollHeight - metrics.clientHeight),
        maxWidth: prepared?.maxWidth,
        maxHeight: prepared?.maxHeight
      });
      await nextPreviewFrame();
      previewAutoFitZoom = 1;
      refreshPreviewZoom();
      globalThis.SmartTeXFigureRenderer?.fitPopupLayout?.(
        output.querySelector(".smarttex-figure-layout")
      );
      await nextPreviewFrame();
      metrics = previewOverflowMetrics();
    }

    // Once geometry is stable, finish with the same synchronous live-DOM
    // convergence used by the warm-cache fast path. Avoiding another sequence
    // of animation frames keeps cold opening responsive while preserving exact
    // grow -> >=75% shrink -> scrollbar semantics.
    if (metrics.overflowX || metrics.overflowY) {
      return finishPreviewAutoFitNow();
    }
    preview.classList.remove("smarttex-preview-scroll-fallback");
    return metrics;
  }

  async function revealStagedPreview(generation, contextId, { rebase = true } = {}) {
    if (generation !== renderGeneration || contextId !== activeContextId) return false;

    preview.dataset.smarttexStaging = "true";
    preview.classList.add("smarttex-preview-staging", "smarttex-preview-intrinsic-measure");
    preview.classList.remove("smarttex-preview-visible", "smarttex-preview-scroll-fallback");
    preview.hidden = false;
    previewLoadingIndicator.hidden = true;
    previewAutoFitZoom = 1;
    refreshPreviewZoom();

    if (rebase) previewPopupUI?.resetForMeasurement?.();

    await nextPreviewFrame();
    if (generation !== renderGeneration || contextId !== activeContextId) return false;

    // Measure completely unconstrained rendered content first. Only after that
    // do we apply the persistent slider scale and the viewport-dependent cap.
    const prepared = previewPopupUI?.prepareForReveal?.({ rebase: false });
    preview.classList.remove("smarttex-preview-intrinsic-measure");
    if (!prepared) return false;

    await nextPreviewFrame();
    if (generation !== renderGeneration || contextId !== activeContextId) return false;

    await applyPreviewAutoFitPolicy(prepared);
    if (generation !== renderGeneration || contextId !== activeContextId) return false;

    previewPositioned = false;
    await positionPreviewForReveal();
    if (generation !== renderGeneration || contextId !== activeContextId) return false;

    delete preview.dataset.smarttexStaging;
    preview.classList.remove(
      "smarttex-preview-staging",
      "smarttex-preview-measuring",
      "smarttex-preview-intrinsic-measure"
    );
    preview.classList.add("smarttex-preview-visible");
    return { prepared, metrics: previewCacheMetricsFromReveal(prepared) };
  }

  async function renderWithTransientRetries(operation, attempts = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (interactionTasks?.isAbortError?.(error)) throw error;
        lastError = error;
        if (attempt + 1 >= attempts) break;
        // A newly opened table/equation can race one browser layout/font turn.
        // Retry internally instead of requiring another user hover/click.
        await new Promise((resolve) => window.setTimeout(resolve, 45 * (attempt + 1)));
      }
    }
    throw lastError || new Error("Preview rendering failed.");
  }

  function showRenderError(contextId, context, error) {
    if (contextId !== activeContextId) return;
    preview.classList.toggle("smarttex-preview-stale", Boolean(lastSuccessfulMarkup));
    status.textContent = lastSuccessfulMarkup
      ? "Preview paused while the LaTeX source is incomplete."
      : "Waiting for valid LaTeX…";
    status.title = errorMessage(error);
    status.hidden = false;

    if (lastSuccessfulMarkup) {
      output.innerHTML = lastSuccessfulMarkup;
    } else {
      output.replaceChildren();
      const fallback = document.createElement("code");
      fallback.className = "smarttex-equation-source-fallback";
      fallback.textContent = context.source.trim() || " ";
      output.appendChild(fallback);
    }
    delete preview.dataset.smarttexStaging;
    preview.classList.remove("smarttex-preview-staging", "smarttex-preview-measuring");
    preview.hidden = false;
    preview.classList.add("smarttex-preview-visible");
    window.requestAnimationFrame(() => {
      if (previewPositioned) positionPreviewAtCursor();
      else positionPreview();
    });
  }

  async function waitForCachedPreviewMedia(root) {
    const images = [...root.querySelectorAll("img")];
    await Promise.all(images.map(async (image) => {
      if (image.complete && image.naturalWidth) return;
      try { await image.decode?.(); } catch (_error) {
        if (!image.complete) {
          await new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          });
        }
      }
    }));
  }

  async function measureBackgroundPreviewMarkup(markup, kind, equationSingleLine = false) {
    if (!markup) return null;
    await katexFontsReady;
    const shell = preview.cloneNode(true);
    shell.hidden = false;
    shell.removeAttribute("style");
    shell.classList.remove("smarttex-preview-visible", "smarttex-preview-scroll-fallback");
    shell.classList.add("smarttex-preview-staging", "smarttex-preview-intrinsic-measure");
    shell.dataset.previewKind = kind;
    shell.dataset.smarttexPopupType = kind === "figure" ? "image" : kind;
    if (kind === "equation") {
      shell.dataset.smarttexEquationSingleLine = equationSingleLine ? "true" : "false";
    } else {
      delete shell.dataset.smarttexEquationSingleLine;
    }
    shell.style.setProperty("left", "-10000px", "important");
    shell.style.setProperty("top", "-10000px", "important");
    const shellOutput = shell.querySelector(".smarttex-equation-output");
    if (!shellOutput) return null;
    shellOutput.innerHTML = markup;
    const shellStatus = shell.querySelector(".smarttex-preview-status");
    if (shellStatus) shellStatus.hidden = true;
    document.documentElement.appendChild(shell);
    try {
      // Background figure warming has already decoded the source media and
      // stabilizeCachedPreviewMedia() serializes intrinsic width/height into the
      // cached markup. Those dimensions are sufficient for layout measurement;
      // waiting for cloned <img> elements to decode again only delays the cache
      // without improving geometry. Fall back to decode only for legacy/partial
      // cache markup that lacks stable intrinsic dimensions.
      if (!cachedPreviewMediaGeometryReady(shellOutput)) {
        await waitForCachedPreviewMedia(shellOutput);
      }
      await nextPreviewFrame();
      const rect = shell.getBoundingClientRect();
      const contentRect = shellOutput.getBoundingClientRect();
      if (!(rect.width > 1) || !(rect.height > 1)) return null;
      return {
        naturalSize: { width: rect.width, height: rect.height },
        contentNaturalSize: {
          width: Math.max(contentRect.width || 0, shellOutput.scrollWidth || 0),
          height: Math.max(contentRect.height || 0, shellOutput.scrollHeight || 0)
        },
        equationSingleLine: Boolean(equationSingleLine),
        kind,
        mediaReady: true
      };
    } finally {
      shell.remove();
    }
  }

  function previewCacheMetricsFromReveal(prepared) {
    if (!prepared?.naturalSize) return null;
    const rect = preview.getBoundingClientRect();
    return {
      naturalSize: { ...prepared.naturalSize },
      contentNaturalSize: {
        width: Math.max(output.clientWidth || 0, output.scrollWidth || 0),
        height: Math.max(output.clientHeight || 0, output.scrollHeight || 0)
      },
      equationSingleLine: preview.dataset.smarttexEquationSingleLine === "true",
      kind: preview.dataset.previewKind || "equation",
      mediaReady: true,
      relativeScale: Number(prepared.relativeScale) || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      maxWidth: Number(prepared.maxWidth) || 0,
      maxHeight: Number(prepared.maxHeight) || 0,
      finalSize: { width: rect.width, height: rect.height },
      autoFitZoom: previewAutoFitZoom,
      scrollFallback: preview.classList.contains("smarttex-preview-scroll-fallback")
    };
  }

  function applyCachedEquationLineMode(context, metrics) {
    if (context?.kind === "table" || context?.kind === "figure") {
      delete preview.dataset.smarttexEquationSingleLine;
      return;
    }
    if (typeof metrics?.equationSingleLine === "boolean") {
      preview.dataset.smarttexEquationSingleLine = metrics.equationSingleLine ? "true" : "false";
    } else {
      updateEquationPreviewLineMode(context, output);
    }
  }

  function cachedPreviewMediaReady(root) {
    return [...root.querySelectorAll("img")].every((image) => (
      image.complete && Number(image.naturalWidth) > 0
    ));
  }

  async function revealCachedPreviewMarkup(cachedValue, generation, contextId, { fast = false } = {}) {
    const cached = normalizedPreviewCacheEntry(cachedValue);
    if (!cached?.markup || generation !== renderGeneration || contextId !== activeContextId) return false;
    const openingFromCache = preview.hidden || preview.dataset.smarttexStaging === "true" || !previewPositioned;
    // Cache refreshes can happen while the popup is already visible (for
    // example after an arrow key or a background cache promotion). Preserve the
    // existing top-left position in that case. Only a genuinely new opening is
    // allowed to run the initial placement policy.
    const stablePosition = !openingFromCache ? preview.getBoundingClientRect() : null;
    if (openingFromCache) setPopupOpenedFromCache(true);
    output.innerHTML = cached.markup;
    applyCachedEquationLineMode(activePreviewContext, cached.metrics);

    // A fast cache hit is valid only when any media in the cloned markup is
    // already decoded. Otherwise use the normal staged path, which waits for
    // stable image geometry before measuring.
    if (fast && cached.metrics?.naturalSize && cachedPreviewMediaGeometryReady(output)) {
      lastSuccessfulMarkup = cached.markup;
      status.hidden = true;
      status.removeAttribute("title");
      preview.classList.remove("smarttex-preview-stale", "smarttex-preview-visible", "smarttex-preview-scroll-fallback");
      preview.classList.add("smarttex-preview-staging");
      preview.dataset.smarttexStaging = "true";
      preview.hidden = false;
      previewLoadingIndicator.hidden = true;
      const prepared = previewPopupUI?.prepareCachedForReveal?.(cached.metrics);
      if (prepared) {
        // Cached markup and intrinsic geometry are reusable, but the *fitted*
        // dimensions are not authoritative. Revalidate against the live DOM and
        // current font metrics so a warm equation fits identically to a freshly
        // parsed one. This is synchronous: layout reads force only the minimal
        // browser layout work and still avoid parsing/KaTeX/image decoding.
        applyPreviewAutoFitPolicyNow(prepared);
        if (generation !== renderGeneration || contextId !== activeContextId) return false;
        const liveMetrics = previewCacheMetricsFromReveal(prepared);
        if (liveMetrics) cached.metrics = liveMetrics;
        if (stablePosition) {
          preview.style.left = `${Math.round(stablePosition.left)}px`;
          preview.style.top = `${Math.round(stablePosition.top)}px`;
          previewPositioned = true;
          // A changed popup size can bring its edge closer to the caret. Apply
          // the normal safety-margin check, but do not otherwise move it.
          positionPreviewAtCursor({
            preferPointer: activePreviewState?.smarttexHoverPreview === true
          });
        } else {
          previewPositioned = false;
          positionPreviewAtCursor({
            force: true,
            preferPointer: activePreviewState?.smarttexHoverPreview === true
          });
        }
        delete preview.dataset.smarttexStaging;
        preview.classList.remove("smarttex-preview-staging", "smarttex-preview-measuring");
        preview.classList.add("smarttex-preview-visible");
        if (previewLoadingGlobalGeneration !== null) {
          hideEnvironmentPopupLoadingSpinner(previewLoadingGlobalGeneration);
          previewLoadingGlobalGeneration = null;
        }
        return true;
      }
    }

    await waitForCachedPreviewMedia(output);
    if (generation !== renderGeneration || contextId !== activeContextId) return false;
    lastSuccessfulMarkup = cached.markup;
    globalThis.SmartTeXFigureRenderer?.observePopupLayout?.(
      output.querySelector(".smarttex-figure-layout")
    );
    status.hidden = true;
    status.removeAttribute("title");
    preview.classList.remove("smarttex-preview-stale");
    const revealed = await revealStagedPreview(generation, contextId, { rebase: true });
    if (revealed?.metrics) {
      // A markup-only cache entry can arise from an in-place cursor/caption
      // refresh. Promote it to a measured warm entry after this one staged
      // measurement so subsequent openings do not repeat the measurement path.
      cached.metrics = revealed.metrics;
    }
    if (revealed && previewLoadingGlobalGeneration !== null) {
      hideEnvironmentPopupLoadingSpinner(previewLoadingGlobalGeneration);
      previewLoadingGlobalGeneration = null;
    }
    return revealed;
  }

  async function buildBackgroundPopupCache(entry, sourceSignature) {
    if (sourceSignature !== previewSourceSignature(currentState)) return;
    const target = numberedOutlinePreviewContext(entry);
    if (!target) return;
    const source = String(currentState?.value || "");
    const context = target.context || target;
    if (!context?.source) return;
    const kind = String(entry?.type || context.kind || context.type || "equation");
    const baseKey = previewBaseCacheKey(currentState, { ...context, kind });
    const existingWarmEntry = normalizedPreviewCacheEntry(previewBaseRenderCache.get(baseKey));
    // A source diagnostic should mean "ready for the fast opening path", not
    // merely that some markup exists. Partial legacy entries are rebuilt here
    // until they contain measured natural geometry.
    if (existingWarmEntry?.markup && existingWarmEntry?.metrics?.naturalSize) return;

    const staging = document.createElement("div");
    if (kind === "figure") {
      await ensureFigureRendererReady();
      const caption = contextTools.floatCaption(source, context, "figure");
      const prepared = contextTools.prepareDocumentCommands(
        source,
        Number(context.openStart ?? entry.sourceIndex ?? 0),
        caption?.text || entry.caption || ""
      );
      const figure = renderFigurePopup(
        context,
        entry.number || contextTools.figurePreviewNumber(source, context),
        prepared.body,
        prepared.macros,
        caption?.start ?? entry.captionSourceIndex
      );
      staging.appendChild(figure);
      if (figure.__smarttexReadyPromise) await figure.__smarttexReadyPromise;
    } else if (kind === "table") {
      const tableContext = context?.environment?.match?.(/^table\*?$/i)
        ? popupTableContext({ context }, source)
        : context;
      if (!tableContext) return;
      const caption = contextTools.floatCaption(source, context, "table");
      const preparedTable = contextTools.prepareDocumentCommands(
        source,
        Number(context.openStart ?? entry.sourceIndex ?? 0),
        tableContext.source
      );
      const tablePopup = document.createElement("figure");
      tablePopup.className = "smarttex-table-popup";
      const rendered = tableRenderer.renderTable({ ...tableContext, source: preparedTable.body }, {
        commandSide: null,
        includeCaret: false,
        contextTools,
        document,
        katex,
        macros: preparedTable.macros,
        trust: trustedKatexCommand,
        sourceOffset: tableContext.contentStart
      });
      if (!rendered) return;
      tablePopup.appendChild(rendered);
      const preparedCaption = contextTools.prepareDocumentCommands(
        source,
        Number(context.openStart ?? entry.sourceIndex ?? 0),
        caption?.text || entry.caption || ""
      );
      appendPopupCaption(
        tablePopup,
        "Table",
        entry.number || contextTools.tablePreviewNumber(source, context),
        preparedCaption.body,
        preparedCaption.macros,
        caption?.start ?? entry.captionSourceIndex
      );
      staging.appendChild(tablePopup);
    } else {
      const numbering = target.numbering || contextTools.equationPreviewNumbering?.(source, context);
      const body = contextTools.previewBody(context, null, numbering, false);
      const prepared = contextTools.prepareDocumentCommands(
        source,
        Number(context.openStart ?? entry.sourceIndex ?? 0),
        body
      );
      katex.render(prepared.body, staging, {
        displayMode: Boolean(context.display ?? true),
        throwOnError: false,
        strict: "ignore",
        trust: trustedKatexCommand,
        maxExpand: 1000,
        maxSize: 25,
        macros: {
          ...prepared.macros,
          "\\label": { tokens: [], numArgs: 1 },
          "\\nonumber": "",
          "\\notag": ""
        }
      });
    }
    if (staging.innerHTML) {
      stabilizeCachedPreviewMedia(staging);
      const stableMarkup = staging.innerHTML;
      const equationSingleLine = kind === "equation"
        ? equationPreviewIsSingleLine(context, staging)
        : false;
      const metrics = await measureBackgroundPreviewMarkup(
        stableMarkup,
        kind,
        equationSingleLine
      );
      if (sourceSignature !== previewSourceSignature(currentState)) return;
      if (!metrics?.naturalSize) return;
      const mediaKeepalive = kind === "figure"
        ? [...staging.querySelectorAll("img")].filter((image) => (
            image.complete && Number(image.naturalWidth) > 0
          ))
        : null;
      previewCacheSet(
        previewBaseRenderCache,
        baseKey,
        stableMarkup,
        metrics,
        { mediaKeepalive }
      );
      // The source-line diagnostic represents a fully measured cache entry for
      // the current source signature. It therefore predicts the actual fast
      // opening path rather than a slower markup-only staged reuse.
    }
  }

  function backgroundPreviewEntriesForState(state = currentState) {
    const source = String(state?.value || "");
    if (!source) return [];

    const numbered = numberedOutlineEntriesForState(state).map((entry) => ({
      ...entry,
      smarttexOutlineEntry: true
    }));
    const entries = [...numbered];
    const seen = new Set(numbered.map((entry) => (
      `${String(entry.type || "")}::${Math.max(0, Number(entry.sourceIndex) || 0)}`
    )));

    // The File Outline only exposes numbered elements, but editor popups also
    // exist for unnumbered display equations and captionless/starred floats.
    // Populate their full-popup cache as well so "first open" does not become
    // a cold render merely because an element has no outline row.
    if (enabledFeatures.equations) {
      const analysis = documentAnalysisForState(state);
      if (!analysis.equations) {
        analysis.equations = typeof contextTools.analyzeEquations === "function"
          ? contextTools.analyzeEquations(source)
          : contextTools.equationContexts(source);
      }
      for (const context of analysis.equations?.contexts || []) {
        // Inline math is intentionally excluded from eager warming: documents
        // can contain thousands of inline fragments, while the expensive popup
        // latency reported by the user concerns display equation environments.
        if (context?.display === false) continue;
        const sourceIndex = Math.max(0, Number(context?.openStart) || 0);
        const key = `equation::${sourceIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          type: "equation",
          sourceIndex,
          context,
          numbering: analysis.equations?.numberingByOpenStart?.get?.(sourceIndex) || null,
          smarttexOutlineEntry: false
        });
      }
    }

    const addFloatStarts = (kind, expression, finder) => {
      if (!finder) return;
      expression.lastIndex = 0;
      let match;
      while ((match = expression.exec(source))) {
        const context = finder(source, match.index + match[0].length);
        if (!context) continue;
        const sourceIndex = Math.max(0, Number(context.openStart ?? match.index) || 0);
        const key = `${kind}::${sourceIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const caption = contextTools.floatCaption?.(source, context, kind);
        entries.push({
          type: kind,
          sourceIndex,
          context,
          caption: caption?.text || "",
          captionSourceIndex: caption?.start,
          smarttexOutlineEntry: false
        });
      }
    };

    if (enabledFeatures.figures) {
      addFloatStarts(
        "figure",
        /\\begin\s*\{figure\*?\}/gi,
        contextTools.findFigureContext?.bind(contextTools)
      );
    }
    if (enabledFeatures.tables) {
      addFloatStarts(
        "table",
        /\\begin\s*\{table\*?\}/gi,
        (value, index) => (
          contextTools.findTableFloatContext?.(value, index) ||
          contextTools.findTableContext?.(value, index)
        )
      );
    }
    return entries;
  }

  function previewWarmYield(timeout = 800) {
    return new Promise((resolve) => {
      const keyboardDelay = Math.max(0, Number(interactionTasks?.keyboardIdleRemaining?.()) || 0);
      if (keyboardDelay > 0) {
        window.setTimeout(() => previewWarmYield(timeout).then(resolve), keyboardDelay);
        return;
      }
      // Each environment can require KaTeX/layout/image work. Yield between
      // entries so proactive warming never turns into a long main-thread task
      // that competes with editor typing or scrolling.
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => resolve(), { timeout });
      } else {
        window.setTimeout(resolve, 0);
      }
    });
  }

  function schedulePreviewCacheWarm({ initial = false } = {}) {
    if (previewCacheWarmTimer !== null) window.clearTimeout(previewCacheWarmTimer);
    const generation = ++previewCacheWarmGeneration;
    const signature = previewSourceSignature(currentState);

    // Initial document load gets a shorter delay because the whole purpose of
    // this pass is to have likely previews ready *before* their first opening.
    // Subsequent edits use a calmer delay so typing remains the priority.
    const startDelay = Math.max(
      initial ? 40 : 500,
      Number(interactionTasks?.keyboardIdleRemaining?.()) || 0
    );
    previewCacheWarmTimer = window.setTimeout(() => {
      previewCacheWarmTimer = null;
      const run = async () => {
        if (generation !== previewCacheWarmGeneration || signature !== previewSourceSignature(currentState)) return;
        const sourceLength = String(currentState?.value || "").length;
        if (interactionTasks?.canRunBackgroundTask &&
            !interactionTasks.canRunBackgroundTask(currentState, sourceLength)) return;
        const cursorIndex = Number(currentState?.cursorIndex) || 0;
        let entries;
        try {
          const collect = () => backgroundPreviewEntriesForState(currentState)
              .slice()
              .sort((left, right) => (
                Math.abs((Number(left?.sourceIndex) || 0) - cursorIndex) -
                Math.abs((Number(right?.sourceIndex) || 0) - cursorIndex)
              ));
          entries = interactionTasks?.runSync
            ? interactionTasks.runSync("preview-cache-index", collect)
            : collect();
        } catch (error) {
          // A just-received keyboard event may have invalidated the interaction
          // task that background analysis inherited. Warming is opportunistic;
          // abort this pass quietly and let the already-scheduled post-edit warm
          // pass retry against the settled source instead of surfacing an
          // unhandled AbortError.
          if (interactionTasks?.isAbortError?.(error)) return;
          throw error;
        }

        // Warm all previewable display environments progressively, not only a
        // fixed first-N subset. Nearby elements are sorted first, so the likely
        // next popup becomes hot quickly, while the remainder fills during idle
        // periods without blocking the editor.
        for (let index = 0; index < entries.length; index += 1) {
          if (generation !== previewCacheWarmGeneration || signature !== previewSourceSignature(currentState)) return;
          const entry = entries[index];
          const taskToken = interactionTasks?.begin?.("preview-cache-entry") || null;
          try {
            taskCheckpoint(0, 1, taskToken);
            const jobs = [buildBackgroundPopupCache(entry, signature)];
            if (entry.smarttexOutlineEntry) jobs.push(cachedNumberedOutlineHoverPreview(entry));
            await Promise.all(jobs);
            taskCheckpoint(0, 1, taskToken);
          } catch (_error) {
            // A malformed/incomplete element is simply retried after the next
            // source-state update; one bad environment must not abort warming.
          } finally {
            if (taskToken) interactionTasks?.end?.(taskToken);
          }
          await previewWarmYield(index < 6 ? 250 : 900);
        }

        const graphicItems = [...document.querySelectorAll('.file-tree-list [role="treeitem"]')]
          .filter((item) => fileTreeGraphicItemFromNode(item))
          .slice(0, 48);
        for (let index = 0; index < graphicItems.length; index += 1) {
          if (generation !== previewCacheWarmGeneration || signature !== previewSourceSignature(currentState)) return;
          try { await cachedFileTreeHoverPreview(graphicItems[index]); } catch (_error) {
            // Unavailable project files remain cold and are retried on hover.
          }
          if (index % 4 === 3) await previewWarmYield(900);
        }

        // Project-file resolution can lag the first editor-state event while
        // CollabTeX is still constructing its file model. Repeat the initial
        // warm pass once after it completes. Existing cache entries are skipped,
        // so this retry is cheap and primarily fills figures whose assets were
        // not resolvable during the very first background pass.
        if (initial && generation === previewCacheWarmGeneration && signature === previewSourceSignature(currentState)) {
          window.setTimeout(() => {
            if (generation === previewCacheWarmGeneration && signature === previewSourceSignature(currentState)) {
              schedulePreviewCacheWarm({ initial: false });
            }
          }, 750);
        }
      };

      // Start in an idle period when available. A bounded timeout ensures that
      // quiet documents actually become warm even if the browser never reports
      // a perfectly idle frame because CollabTeX keeps background work active.
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => void run(), { timeout: initial ? 180 : 500 });
      } else {
        window.setTimeout(() => void run(), 0);
      }
    }, startDelay);
  }

  function warmPreviewCacheForStateContext(state, context) {
    const exactKey = previewExactCacheKey(state, context);
    // A cache entry is useful even before its geometry has been measured.
    // Reusing cached markup and doing only the hidden measurement is still much
    // cheaper than reparsing/rerendering the environment. Previously such
    // markup-only entries were ignored here, which made cache use appear
    // intermittent even though rendered content was already available.
    const exact = normalizedPreviewCacheEntry(lruCacheGet(previewRenderCache, exactKey));
    if (exact?.markup) {
      return {
        entry: exact,
        exact: true,
        measured: Boolean(exact.metrics?.naturalSize),
        exactKey,
        baseKey: previewBaseCacheKey(state, context)
      };
    }
    const baseKey = previewBaseCacheKey(state, context);
    const base = normalizedPreviewCacheEntry(lruCacheGet(previewBaseRenderCache, baseKey));
    if (base?.markup) {
      return {
        entry: base,
        exact: false,
        measured: Boolean(base.metrics?.naturalSize),
        exactKey,
        baseKey
      };
    }
    return null;
  }

  function previewHintMatchesState(hint, state) {
    const previous = hint?.state;
    return Boolean(
      previous && state &&
      String(previous.fileName || "") === String(state.fileName || "") &&
      String(previous.value || "") === String(state.value || "") &&
      Number(previous.cursorIndex) === Number(state.cursorIndex) &&
      Number(previous.selectionFrom ?? previous.cursorIndex) === Number(state.selectionFrom ?? state.cursorIndex) &&
      Number(previous.selectionTo ?? previous.cursorIndex) === Number(state.selectionTo ?? state.cursorIndex) &&
      Boolean(previous.smarttexHoverPreview) === Boolean(state.smarttexHoverPreview)
    );
  }

  async function tryFastWarmPreview(generation, hint = null) {
    const state = previewStateForRender();
    if (generation !== renderGeneration || !stateCanShowPreview(state)) return null;
    const usableHint = hint?.generation === generation && previewHintMatchesState(hint, state)
      ? hint
      : null;
    let context = usableHint?.context || null;
    if (!context) {
      try { context = findPreviewContext(state); } catch (_error) { return null; }
    }
    if (!context || previewContextIsDismissed(state, context)) return null;
    const warm = usableHint?.warm || warmPreviewCacheForStateContext(state, context);
    if (!warm) return null;

    const contextId = previewContextId(state, context);
    const contextChanged = contextId !== activeContextId;
    if (contextChanged) {
      activeContextId = contextId;
      caretPlacementState = null;
      lastSuccessfulMarkup = "";
      activeFloatCaptionRenderInfo = null;
      previewPositioned = false;
      verticalScrollRepositionPending = false;
      output.replaceChildren();
    }
    activePreviewContext = context;
    activePreviewState = state;
    applyPreviewPresentation(context);

    if (context.kind === "figure") {
      const number = contextTools.figurePreviewNumber(state.value, context);
      previewMeta.textContent = number !== null ? `Figure ${number}` : "";
      previewMeta.hidden = number === null;
    } else if (context.kind === "table") {
      const number = contextTools.tablePreviewNumber(state.value, context);
      previewMeta.textContent = number !== null ? `Table ${number}` : "";
      previewMeta.hidden = number === null;
    } else {
      previewMeta.textContent = "";
      previewMeta.hidden = true;
    }

    const revealed = await revealCachedPreviewMarkup(
      warm.entry, generation, contextId, { fast: true }
    );
    if (!revealed) return null;
    return { ...warm, state, context, contextId };
  }

  async function renderPreview(generation, loadingGeneration = null) {
    const taskToken = interactionTasks?.begin?.("popup-preview-render") || null;
    try {
    renderTimer = null;
    // A measured warm cache can be shown immediately: no spinner-paint delay,
    // LaTeX rendering, media decode, intrinsic measurement, or fit pass is
    // needed. Base (cursor-independent) equation caches are shown immediately
    // and then refined below with the cursor-specific markup in the background.
    await Promise.all([featureSettingsReady, popupSettingsReady]);
    const renderHint = scheduledPreviewHint?.generation === generation
      ? scheduledPreviewHint
      : null;
    if (renderHint) scheduledPreviewHint = null;
    const warmPreview = await tryFastWarmPreview(generation, renderHint);
    if (warmPreview) {
      // Background warming stores cursor-independent equation markup. Once that
      // base cache has populated the opening frame, do not immediately continue
      // into a cold cursor-specific KaTeX render; doing so defeated first-open
      // caching and made the popup diagnostic appear uncached. Cursor/source
      // changes can update the already-visible equation in place later.
      return;
    }
    if (!warmPreview && loadingGeneration !== null && loadingGeneration !== undefined) {
      await nextPreviewFrame();
      await nextPreviewFrame();
      if (generation !== renderGeneration) return;
    }
    await katexFontsReady;
    taskCheckpoint(0, 1, taskToken);
    const state = previewStateForRender();
    // A superseded async render must never hide or invalidate the newer one.
    // This is common while the first equation keystrokes are waiting for fonts
    // or settings: the stale job simply yields ownership to the latest job.
    if (generation !== renderGeneration) return;
    if (!stateCanShowPreview(state)) {
      hidePreview();
      return;
    }

    const context = renderHint && previewHintMatchesState(renderHint, state)
      ? renderHint.context
      : findPreviewContext(state);
    taskCheckpoint(0, 1, taskToken);
    if (!context) {
      hidePreview();
      return;
    }

    const contextId = previewContextId(state, context);
    activePreviewContext = context;
    activePreviewState = state;
    if (previewContextIsDismissed(state, context)) {
      hidePreview({ clearDismissal: false });
      return;
    }
    const contextChanged = contextId !== activeContextId;
    const previewScrollState = contextChanged
      ? []
      : capturePopupScrollState(preview);
    if (contextChanged) {
      activeContextId = contextId;
      caretPlacementState = null;
      lastSuccessfulMarkup = "";
      previewPositioned = false;
      verticalScrollRepositionPending = false;
      output.replaceChildren();
    }
    const isTable = context.kind === "table";
    const isFigure = context.kind === "figure";
    applyPreviewPresentation(context);
    if (isFigure) {
      await ensureFigureRendererReady();
      // Loading the renderer may have overlapped another keystroke or cursor
      // state. Only the newest render may populate the already-visible popup.
      if (generation !== renderGeneration || contextId !== activeContextId) return;
    }
    const equationRenderData = !isFigure && !isTable
      ? equationRenderDataForState(state, context)
      : null;
    taskCheckpoint(0, 1, taskToken);
    const numbering = isFigure
      ? { figureNumber: contextTools.figurePreviewNumber(state.value, context) }
      : isTable
        ? { tableNumber: contextTools.tablePreviewNumber(state.value, context) }
        : equationRenderData.numbering;
    const floatCaption = isFigure || isTable
      ? contextTools.floatCaption(
        state.value,
        context,
        isTable ? "table" : "figure"
      )
      : null;
    if (isFigure && numbering.figureNumber !== null) {
      previewMeta.textContent = `Figure ${numbering.figureNumber}`;
      previewMeta.title = "Figure number inferred from this LaTeX file";
      previewMeta.hidden = false;
    } else if (isTable && numbering.tableNumber !== null) {
      previewMeta.textContent = `Table ${numbering.tableNumber}`;
      previewMeta.title = "Table number inferred from this LaTeX file";
      previewMeta.hidden = false;
    } else {
      previewMeta.textContent = "";
      previewMeta.removeAttribute("title");
      previewMeta.hidden = true;
    }

    const activeSelection = (
      sourceSelectionForContext(state, context) ||
      (floatCaption
        ? sourceSelectionForRange(state, floatCaption.start, floatCaption.end)
        : null)
    );
    const hasSelection = Boolean(activeSelection);
    const caretInFloatCaption = Boolean(
      (isFigure || isTable) &&
      !hasSelection &&
      collapsedCaretIsInsideCaption(state, floatCaption)
    );
    if (caretInFloatCaption) {
      // Establish caption ownership during the opening render itself. Waiting
      // for a later editor-state callback leaves a race where the first real
      // beforeinput event sees no caption lock and falls back to the generic
      // popup lifecycle. Capturing the bounds now makes the first caption key
      // behave exactly like subsequent in-place updates.
      setCaptionPreviewLockFromCaption(state, context, floatCaption);
      caretPlacementState = contextTools.resolveCaretPlacement(
        floatCaption.text,
        Number(state.cursorIndex) - Number(floatCaption.start),
        caretPlacementState
      );
    } else {
      caretPlacementState = (isFigure || isTable || hasSelection)
        ? null
        : contextTools.resolveCaretPlacement(
          context.source,
          context.cursorOffset,
          caretPlacementState
        );
    }
    const exactRenderCacheKey = previewExactCacheKey(state, context);
    const cachedExactEntry = normalizedPreviewCacheEntry(
      lruCacheGet(previewRenderCache, exactRenderCacheKey)
    );
    let cachedOpeningRevealed = false;
    const needsFloatCaretRefresh = Boolean(
      caretInFloatCaption ||
      (isTable && !hasSelection && context.cursorInsideTable !== false)
    );
    if (cachedExactEntry) {
      const revealed = await revealCachedPreviewMarkup(
        cachedExactEntry,
        generation,
        contextId
      );
      if (revealed) {
        // Float caches deliberately strip transient caret DOM so one cached
        // rendering can serve every caret position. A cache hit must therefore
        // remain visible immediately but continue into the lightweight caret
        // refresh when the editor caret is in a caption (or table body), rather
        // than returning with a caret-less cached caption.
        cachedOpeningRevealed = true;
        if (!needsFloatCaretRefresh) return;
      }
    }

    const baseRenderCacheKey = previewBaseCacheKey(state, context);
    const cachedBaseEntry = contextChanged
      ? normalizedPreviewCacheEntry(lruCacheGet(previewBaseRenderCache, baseRenderCacheKey))
      : null;
    if (cachedBaseEntry) {
      const revealed = await revealCachedPreviewMarkup(cachedBaseEntry, generation, contextId);
      if (generation !== renderGeneration || contextId !== activeContextId) return;
      cachedOpeningRevealed ||= Boolean(revealed);
      // Continue below to add cursor/selection-specific state without discarding
      // the already-visible cached frame. For figure captions this becomes a
      // caption-only DOM update, so cached media remains untouched.
    }

    let equationRenderContext = context;
    if (!isTable && !isFigure && hasSelection) {
      const relativeStart = Math.max(
        0,
        Math.min(context.source.length, activeSelection.start - context.contentStart)
      );
      const relativeEnd = Math.max(
        relativeStart,
        Math.min(context.source.length, activeSelection.end - context.contentStart)
      );
      equationRenderContext = {
        ...context,
        source: (
          context.source.slice(0, relativeStart) +
          "\\htmlClass{smarttex-popup-selection}{" +
          context.source.slice(relativeStart, relativeEnd) +
          "}" +
          context.source.slice(relativeEnd)
        )
      };
    }
    let unpreparedBody;
    if (caretInFloatCaption) {
      const captionSource = String(floatCaption.text || "");
      const literalOffset = Math.max(
        0,
        Math.min(
          captionSource.length,
          Number(state.cursorIndex) - Number(floatCaption.start)
        )
      );
      const caretOffset = contextTools.commandAwareCaretOffset(
        captionSource,
        literalOffset,
        caretPlacementState?.commandSide || null
      );
      const operatorCaret = Boolean(
        contextTools.cursorInsideControlSequence?.(captionSource, literalOffset) ||
        contextTools.cursorAtProtectedAtomBoundary?.(captionSource, literalOffset)
      );
      const marker = operatorCaret ? "\uE002" : "\uE001";
      unpreparedBody = (
        captionSource.slice(0, caretOffset) +
        marker +
        captionSource.slice(caretOffset)
      );
    } else if (isTable || isFigure) {
      unpreparedBody = floatCaption?.text || "";
    } else {
      unpreparedBody = contextTools.previewBody(
        equationRenderContext,
        caretPlacementState?.commandSide || null,
        numbering,
        !hasSelection
      );
    }
    let documentCommands;
    try {
      documentCommands = (
        equationRenderData?.commandContext &&
        typeof contextTools.applyPreparedDocumentCommands === "function"
      )
        ? contextTools.applyPreparedDocumentCommands(
          equationRenderData.commandContext,
          unpreparedBody
        )
        : contextTools.prepareDocumentCommands(
          state.value,
          context.openStart,
          unpreparedBody
        );
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) throw error;
      console.warn(
        "SmartTeX could not prepare all document commands; rendering with the compatible subset:",
        error
      );
      documentCommands = {
        body: unpreparedBody,
        macros: { "\\ensuremath": "#1" },
        count: 0
      };
    }
    const staging = document.createElement("div");
    taskCheckpoint(0, 1, taskToken);
    const cursorInsideOperator = Boolean(
      !isFigure &&
      !hasSelection &&
      (
        contextTools.cursorInsideControlSequence?.(
          context.source,
          context.cursorOffset
        ) ||
        contextTools.cursorAtProtectedAtomBoundary?.(
          context.source,
          context.cursorOffset
        )
      )
    );
    const macros = {
      ...documentCommands.macros,
      "\\label": { tokens: [], numArgs: 1 },
      "\\nonumber": "",
      "\\notag": "",
      "\\SmartTeXCaret": `\\htmlClass{${
        cursorInsideOperator
          ? "smarttex-rendered-operator-caret"
          : "smarttex-rendered-caret"
      }}{\\vphantom{|}}`,
      "\\SmartTeXOperatorCaret":
        "\\htmlClass{smarttex-rendered-operator-caret}{\\vphantom{|}}"
    };
    activeFloatCaptionRenderInfo = (isFigure || isTable)
      ? {
          contextId,
          labelText: isTable ? "Table" : "Fig.",
          number: isTable ? numbering.tableNumber : numbering.figureNumber,
          macros: { ...macros },
          sourceOffset: floatCaption?.start ?? null
        }
      : null;

    const renderedFigure = isFigure && (!contextChanged || cachedOpeningRevealed)
      ? output.querySelector(":scope > .smarttex-figure-popup")
      : null;
    const renderedTable = isTable && (!contextChanged || cachedOpeningRevealed)
      ? output.querySelector(":scope > .smarttex-table-popup")
      : null;
    const renderedFloat = renderedFigure || renderedTable;
    const updateCaptionOnly = Boolean(
      renderedFloat &&
      caretInFloatCaption
    );

    try {
      if (updateCaptionOnly) {
        updateFloatCaptionInPlace(
          renderedFloat,
          isTable ? "Table" : "Fig.",
          isTable ? numbering.tableNumber : numbering.figureNumber,
          documentCommands.body,
          macros,
          floatCaption?.start
        );
      } else if (isFigure) {
        staging.appendChild(renderFigurePopup(
          context,
          numbering.figureNumber,
          documentCommands.body,
          macros,
          floatCaption?.start
        ));
      } else if (isTable) {
        await renderWithTransientRetries(() => {
          staging.replaceChildren();
          const tablePopup = document.createElement("figure");
          tablePopup.className = "smarttex-table-popup";
          const renderedTableNode = tableRenderer.renderTable(context, {
            commandSide: caretPlacementState?.commandSide || null,
            includeCaret: !hasSelection && context.cursorInsideTable !== false,
            contextTools,
            document,
            katex,
            macros,
            trust: trustedKatexCommand,
            sourceOffset: context.contentStart
          });
          if (!renderedTableNode) {
            throw new Error("Table renderer returned no preview content.");
          }
          tablePopup.appendChild(renderedTableNode);
          appendPopupCaption(
            tablePopup,
            "Table",
            numbering.tableNumber,
            documentCommands.body,
            macros,
            floatCaption?.start
          );
          staging.appendChild(tablePopup);
        });
      } else {
        await renderWithTransientRetries(() => {
          staging.replaceChildren();
          katex.render(documentCommands.body, staging, {
            displayMode: Boolean(context.display),
            throwOnError: true,
            strict: "ignore",
            trust: trustedKatexCommand,
            maxExpand: 1000,
            maxSize: 25,
            macros
          });
          if (!staging.firstElementChild && !String(staging.textContent || "").trim()) {
            throw new Error("Equation renderer returned no preview content.");
          }
        });
      }
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) throw error;

      // The rendered caret is represented by an injected KaTeX macro. Most
      // syntax-sensitive regions are relocated to a safe boundary by
      // SmartTeXLatexContext, but a document-specific macro may still reject a
      // marker inside one of its arguments. The source equation itself must
      // never become unrenderable merely because of the cursor position, so
      // retry the unchanged equation without the visual caret before showing
      // an error.
      if (!isFigure && !isTable && !hasSelection) {
        try {
          const fallbackBody = contextTools.previewBody(
            equationRenderContext,
            null,
            numbering,
            false
          );
          const fallbackCommands = (
            equationRenderData?.commandContext &&
            typeof contextTools.applyPreparedDocumentCommands === "function"
          )
            ? contextTools.applyPreparedDocumentCommands(
              equationRenderData.commandContext,
              fallbackBody
            )
            : contextTools.prepareDocumentCommands(
              state.value,
              context.openStart,
              fallbackBody
            );
          const fallbackMacros = {
            ...fallbackCommands.macros,
            "\\label": { tokens: [], numArgs: 1 },
            "\\nonumber": "",
            "\\notag": "",
            "\\SmartTeXCaret": macros["\\SmartTeXCaret"],
            "\\SmartTeXOperatorCaret": macros["\\SmartTeXOperatorCaret"]
          };
          await renderWithTransientRetries(() => {
            staging.replaceChildren();
            katex.render(fallbackCommands.body, staging, {
              displayMode: Boolean(context.display),
              throwOnError: true,
              strict: "ignore",
              trust: trustedKatexCommand,
              maxExpand: 1000,
              maxSize: 25,
              macros: fallbackMacros
            });
            if (!staging.firstElementChild && !String(staging.textContent || "").trim()) {
              throw new Error("Equation fallback returned no preview content.");
            }
          }, 2);
        } catch (fallbackError) {
          if (interactionTasks?.isAbortError?.(fallbackError)) throw fallbackError;
          showRenderError(contextId, context, fallbackError);
          return;
        }
      } else {
        showRenderError(contextId, context, error);
        return;
      }
    }

    if (isFigure && !updateCaptionOnly) {
      const stagedFigure = staging.querySelector(":scope > .smarttex-figure-popup");
      if (stagedFigure?.__smarttexReadyPromise) {
        await stagedFigure.__smarttexReadyPromise;
      }
    }

    taskCheckpoint(0, 1, taskToken);
    if (generation !== renderGeneration || contextId !== activeContextId) return;
    if (renderedTable && !updateCaptionOnly) {
      const nextTable = staging.querySelector(":scope > .smarttex-table-popup");
      if (nextTable) {
        const scrollState = capturePopupScrollState(renderedTable);
        renderedTable.replaceChildren(...nextTable.childNodes);
        restorePopupScrollState(renderedTable, scrollState);
      }
    } else if (!updateCaptionOnly) {
      output.replaceChildren(...staging.childNodes);
    }
    updateEquationPreviewLineMode(context, output);
    stabilizeCachedPreviewMedia(output);
    lastSuccessfulMarkup = output.innerHTML;
    const cacheableMarkup = (!hasSelection)
      ? canonicalPreviewBaseMarkup(lastSuccessfulMarkup)
      : lastSuccessfulMarkup;
    if (cacheableMarkup) {
      previewCacheSet(
        previewRenderCache,
        exactRenderCacheKey,
        cacheableMarkup,
        normalizedPreviewCacheEntry(previewRenderCache.get(exactRenderCacheKey))?.metrics || null
      );
    }
    restorePopupScrollState(preview, previewScrollState);
    applyPopupSelectionHighlight(output, state, context);
    if (!updateCaptionOnly) {
      globalThis.SmartTeXFigureRenderer?.observePopupLayout?.(
        output.querySelector(".smarttex-figure-layout")
      );
    }
    status.hidden = true;
    status.removeAttribute("title");
    preview.classList.remove("smarttex-preview-stale");
    const stagedOpening = (
      contextChanged ||
      preview.hidden ||
      preview.dataset.smarttexStaging === "true"
    );
    if (stagedOpening) {
      const revealed = await revealStagedPreview(generation, contextId, { rebase: true });
      if (!revealed) return;
      if (cacheableMarkup && revealed.metrics) {
        previewCacheSet(previewRenderCache, exactRenderCacheKey, cacheableMarkup, revealed.metrics);
        // Keep one cursor-independent measured rendering for every unselected
        // environment. This is the fast path used when the caret later moves
        // inside the same figure/table/equation without a source change.
        if (!hasSelection) {
          previewCacheSet(
            previewBaseRenderCache,
            baseRenderCacheKey,
            cacheableMarkup,
            revealed.metrics
          );
        }
      }
    } else {
      preview.hidden = false;
      preview.classList.add("smarttex-preview-visible");
      // Do not schedule popup-gate's visibility-size restore on every live
      // equation/caption update. That asynchronous restore can reinterpret the
      // already-fitted rectangle as a new natural size and is one source of
      // cache/fresh-path divergence. The live fit below owns resizing here.
      refreshPreviewZoom();
      const prepared = {
        maxWidth: Number(preview.dataset.smarttexAutoFitMaxWidth) || undefined,
        maxHeight: Number(preview.dataset.smarttexAutoFitMaxHeight) || undefined
      };
      await applyPreviewAutoFitPolicy(prepared, {
        allowGrow: preview.dataset.smarttexTemporarySized !== "true"
      });
      window.requestAnimationFrame(() => {
        if (!previewPositioned) positionPreview();
        else positionPreviewAtCursor();
      });
    }
    } finally {
      hidePreviewLoading(loadingGeneration);
      if (taskToken) interactionTasks?.end?.(taskToken);
    }
  }

  function runScheduledRender(generation, loadingGeneration = null) {
    Promise.resolve(renderPreview(generation, loadingGeneration)).catch((error) => {
      if (interactionTasks?.isAbortError?.(error)) return;
      console.error("SmartTeX editor popup rendering failed:", error);
      const state = previewStateForRender();
      if (generation !== renderGeneration || !stateCanShowPreview(state)) {
        return;
      }
      let context = null;
      try {
        context = findPreviewContext(state);
      } catch (_contextError) {
        // Without a context there is no meaningful source fallback to display.
      }
      if (!context) {
        hidePreview();
        return;
      }
      const contextId = previewContextId(state, context);
      activeContextId = contextId;
      showRenderError(contextId, context, error);
    });
  }

  function scheduleRender({
    immediate = false,
    preserveExisting = false,
    delayMs = SOURCE_RENDER_DELAY_MS,
    deferContextLookup = false,
    contextHint = null
  } = {}) {
    if (renderTimer !== null) {
      window.clearTimeout(renderTimer);
      renderTimer = null;
    }
    hidePreviewLoading();
    const state = previewStateForRender();
    if (!stateCanShowPreview(state)) {
      if (preserveExisting && !preview.hidden) return;
      hidePreview();
      return;
    }

    // Defense in depth for the mounted-environment ownership invariant above.
    // Other extension subsystems can request scheduleRender() independently of
    // the editor-state listener. If the caret still belongs to the currently
    // mounted environment, a generic render of that same environment is never
    // appropriate: equations/captions have dedicated in-place update paths and
    // focus/layout events need no rerender at all. Refusing the redundant job
    // here prevents a stale asynchronous transaction from staging/revealing the
    // popup a second time after a live update.
    if (
      !preview.hidden &&
      (
        activeEnvironmentPreviewContainsState(state) ||
        activeEnvironmentInputTransactionContainsState(state)
      )
    ) {
      let requestedContext = contextHint || null;
      if (!requestedContext && !deferContextLookup) {
        try { requestedContext = findPreviewContext(state); } catch (_error) {
          requestedContext = null;
        }
      }
      if (!requestedContext || previewContextId(state, requestedContext) === activeContextId) {
        hidePreviewLoading();
        return;
      }
    }
    // A manually dismissed environment stays dismissed while edits occur
    // inside it. This check intentionally avoids parsing the environment on
    // every keystroke and also accounts for the source-length change.
    if (stateIsInsideDismissedPreview(state)) {
      hidePreview({ clearDismissal: false, force: true });
      return;
    }
    if (deferContextLookup && !immediate) {
      renderGeneration += 1;
      const generation = renderGeneration;
      renderTimer = window.setTimeout(
        () => runScheduledRender(generation, null),
        Math.max(0, Number(delayMs) || 0)
      );
      return;
    }
    const context = contextHint || findPreviewContext(state);
    if (!context) {
      if (preserveExisting && !preview.hidden) return;
      hidePreview();
      return;
    }
    if (previewContextIsDismissed(state, context)) {
      hidePreview({ clearDismissal: false, force: true });
      return;
    }
    renderGeneration += 1;
    const generation = renderGeneration;
    const warm = warmPreviewCacheForStateContext(state, context);
    scheduledPreviewHint = { generation, state, context, warm };
    const loadingGeneration = showPreviewLoading(state, context);
    const warmCacheReady = Boolean(warm);
    if (immediate || warmCacheReady) {
      // The page bridge already coalesces duplicate cursor callbacks in a
      // microtask. Do not add a timeout before moving the rendered caret.
      queueMicrotask(() => {
        if (generation === renderGeneration) {
          runScheduledRender(generation, loadingGeneration);
        } else {
          hidePreviewLoading(loadingGeneration);
        }
      });
      return;
    }
    renderTimer = window.setTimeout(
      () => runScheduledRender(generation, loadingGeneration),
      Math.max(0, Number(delayMs) || 0)
    );
  }



  function clearEnvironmentHoverPreview({ hide = true } = {}) {
    window.clearTimeout(environmentHoverTimer);
    environmentHoverTimer = null;
    environmentHoverGeneration += 1;
    hoverPreviewState = null;
    for (const [contextId, range] of dismissedPreviewContexts) {
      if (range?.hover) dismissedPreviewContexts.delete(contextId);
    }
    if (hide && environmentPopupUsesHover()) hidePreview();
  }

  function pointerIsInsidePreviewSurface(element) {
    return Boolean(
      preview.contains(element) ||
      referencePopupContains(element) ||
      autocompleteSurface(element)
    );
  }

  function pointerIsInsideEditorControl(element) {
    return Boolean(element?.closest?.(
      ".ace_search, .cm-panels, .cm-panel, " +
      "[class*='search-panel'], [class*='searchPanel']"
    ));
  }

  function scheduleEnvironmentPreviewHover(event) {
    if (!environmentPopupUsesHover()) return;
    if (typedEnvironmentPreviewActive) return;
    if (pointerIsInsidePreviewSurface(event.target)) {
      window.clearTimeout(environmentHoverTimer);
      environmentHoverTimer = null;
      return;
    }

    const surface = editorSurface(event.target);
    if (pointerIsInsideEditorControl(event.target) || !currentState) {
      clearEnvironmentHoverPreview();
      return;
    }
    if (!surface) {
      window.clearTimeout(environmentHoverTimer);
      const generation = ++environmentHoverGeneration;
      environmentHoverTimer = window.setTimeout(() => {
        if (
          generation !== environmentHoverGeneration ||
          previewPointerInside ||
          elementIsHovered(preview) ||
          popupChainIsHovered()
        ) return;
        clearEnvironmentHoverPreview();
      }, 180);
      return;
    }

    window.clearTimeout(environmentHoverTimer);
    const generation = ++environmentHoverGeneration;
    const clientX = Number(event.clientX);
    const clientY = Number(event.clientY);
    const lineHeight = Math.max(
      14,
      parseFloat(getComputedStyle(surface).lineHeight) ||
      Number(currentState?.screen?.lineHeight) ||
      18
    );
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

    environmentHoverTimer = window.setTimeout(() => {
      bridgeRequest("getIndexAtCoordinates", { clientX, clientY }, 1200)
        .then((response) => {
          if (
            generation !== environmentHoverGeneration ||
            !environmentPopupUsesHover() ||
            !currentState ||
            !Number.isInteger(Number(response?.index))
          ) return;

          const index = Math.max(
            0,
            Math.min(Number(response.index), String(currentState.value || "").length)
          );
          hoverPreviewState = {
            ...currentState,
            smarttexHoverPreview: true,
            focused: true,
            cursorIndex: index,
            selectionFrom: index,
            selectionTo: index,
            selectionAnchor: index,
            selectionHead: index,
            screen: {
              pageX: clientX + window.scrollX,
              pageY: clientY + window.scrollY - lineHeight * 0.45,
              lineHeight
            }
          };
          scheduleRender();
        })
        .catch(() => {
          if (generation === environmentHoverGeneration) {
            clearEnvironmentHoverPreview();
          }
        });
    }, 65);
  }

  window.addEventListener(REFERENCE_AUTOCOMPLETE_PREVIEW_EVENT, (event) => {
    showReferenceAutocompletePreview(event.detail);
  });
  window.addEventListener(REFERENCE_AUTOCOMPLETE_PREVIEW_HIDE_EVENT, (event) => {
    let detail = null;
    try {
      detail = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      detail = null;
    }
    if (referenceAutocompleteActive && !detail?.force) return;
    hideReferenceAutocompletePreview();
  });
  window.addEventListener(REFERENCE_AUTOCOMPLETE_ACTIVE_EVENT, (event) => {
    let detail = null;
    try {
      detail = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      detail = null;
    }
    referenceAutocompleteActive = Boolean(detail?.active);
    if (referenceAutocompleteActive) {
      window.clearTimeout(editorReferenceHoverTimer);
      editorReferenceHoverGeneration += 1;
      // Opening or updating the reference list should close a pre-existing
      // editor-hover popup, but it must not close the preview that belongs to
      // the selected autocomplete entry.
      hideNormalReferencePopupForAutocomplete();
    } else {
      autocompleteReferenceCommandStart = null;
      autocompleteReferenceTargetKey = "";
      activeSecondaryEditorReferenceKey = "";
      hideNestedReferencePopupsFromDepth(1);
    }
    if (popupsSuppressedAfterEditorScroll) {
      hidePreview();
      return;
    }
    const previewState = previewStateForRender();
    if (stateCanShowPreview(previewState)) scheduleRender();
    else hidePreview();
  });
  window.addEventListener(GRAPHIC_AUTOCOMPLETE_ACTIVE_EVENT, (event) => {
    const wasActive = graphicAutocompleteContextActive;
    graphicAutocompleteContextActive = Boolean(event?.detail?.active);
    if (graphicAutocompleteContextActive) {
      captionPreviewLock = null;
      hidePreview({ force: true });
      return;
    }
    if (wasActive && stateCanShowPreview(currentState)) scheduleRender();
  });

  ensureNumberedOutlineObserver();

  window.addEventListener(STATE_EVENT, (event) => {
    const previousState = currentState;
    const previousSource = String(previousState?.value || "");
    const previousFileName = String(previousState?.fileName || "");
    try {
      currentState = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      hoverPreviewState = null;
      hidePreview();
      hideCaptionReferencePopup();
      return;
    }

    if (
      numberedOutlinePendingCursorIndex !== null &&
      Math.max(0, Number(currentState?.cursorIndex) || 0) === numberedOutlinePendingCursorIndex
    ) {
      clearNumberedOutlinePendingCursor();
    }
    ensureNumberedOutlineObserver();
    // CollabTeX may replace the outline subtree while it reconciles the current
    // section after a cursor move. The pane observer normally notices that, but
    // its pending repair is deliberately cancelled by keyboard activity. Every
    // post-input editor state therefore gets one idle-time reconciliation as the
    // guaranteed retry, even when the source itself did not change.
    scheduleNumberedOutlineUpdate(20);
    scheduleNumberedOutlineActiveIndicator();

    const currentSource = String(currentState?.value || "");
    const currentFileName = String(currentState?.fileName || "");
    const sourceChanged = (
      previousSource !== currentSource ||
      previousFileName !== currentFileName
    );
    if (sourceChanged) {
      // Every preview cache key includes the source signature. Once the source
      // changes, old diagnostic dots would be misleading even though their LRU
      // entries may remain allocated until eviction. Clear the visible cache map
      // immediately; the idle warmer repopulates dots as new entries complete.

      // Cache warming is deliberately independent of popup-interaction gating.
      // The previous implementation returned here during initial page load, so
      // no full popup cache existed until the user edited the document. That
      // made the first figure/equation/table opening cold even after the page
      // had been idle for a long time. Start warming as soon as source state is
      // available; display gating still prevents any popup from appearing early.
      schedulePreviewCacheWarm({
        initial: !previousState || previousFileName !== currentFileName
      });
    }

    if (!popupInteractionReady()) {
      hoverPreviewState = null;
      hidePreview();
      hideCaptionReferencePopup();
      return;
    }
    const recentEditorTyping = Boolean(
      sourceChanged &&
      Date.now() - lastEditorTextInputAt < 500 &&
      previousState?.focused !== false &&
      previousFileName === currentFileName
    );
    const cheapCaptionContinuation = Boolean(
      recentEditorTyping &&
      captionPreviewLock &&
      !preview.hidden &&
      ["figure", "table"].includes(activePreviewContext?.kind)
    );
    const inputTransactionContinuesPreview = Boolean(
      !preview.hidden &&
      sourceChanged &&
      activeEnvironmentInputTransactionContainsState(currentState)
    );
    const continuingActivePreview = Boolean(
      !preview.hidden &&
      (
        cheapCaptionContinuation ||
        activeEnvironmentPreviewContainsState(currentState) ||
        inputTransactionContinuesPreview
      )
    );
    if (recentEditorTyping || (sourceChanged && continuingActivePreview)) {
      // CodeMirror/Ace can publish the document change before the next layout
      // pass has produced caret coordinates, and some versions briefly report
      // focus=false while replacing the hidden input value. If the caret range
      // still belongs to the already-open environment, neither transient state
      // ends that interaction—even when the state notification arrives later
      // than the generic 500 ms "recent typing" heuristic.
      currentState.focused = true;
      if (!currentState.screen && previousState?.screen) {
        currentState.screen = previousState.screen;
      }
    } else if (continuingActivePreview) {
      if (!currentState.screen && previousState?.screen) {
        currentState.screen = previousState.screen;
      }
    } else if (
      sourceChanged &&
      !currentState?.screen &&
      previousState?.screen &&
      currentState?.focused !== false &&
      previousFileName === currentFileName
    ) {
      currentState.screen = previousState.screen;
    }
    const cursorChanged = (
      Number(previousState?.cursorIndex) !== Number(currentState?.cursorIndex) ||
      Number(previousState?.selectionFrom) !== Number(currentState?.selectionFrom) ||
      Number(previousState?.selectionTo) !== Number(currentState?.selectionTo)
    );
    const focusChanged = Boolean(previousState?.focused) !== Boolean(currentState?.focused);

    // If the state belongs to the input transaction but carries a transient
    // out-of-range cursor, do not let a parser-based caption lookup clear the
    // existing caption lock. The DOM input event already proved that the edit
    // started inside this caption; only its end offset needs to track the source
    // length change until the corrected caret state arrives.
    if (inputTransactionContinuesPreview && activeEnvironmentInputTransaction?.captionLocked) {
      refreshCaptionLockFromInputTransaction(currentState);
    } else {
      refreshCaptionPreviewLock(currentState);
    }

    // Once an environment popup is mounted, that environment exclusively owns
    // the popup until the caret actually leaves its source range. Handle every
    // editor state mutation for the owned environment here and RETURN before any
    // generic popup scheduling below. This single ownership gate is deliberately
    // stronger than separate typing/focus/scroll heuristics: CollabTeX can emit
    // several state notifications for one keypress and their order differs
    // between editor versions. Allowing even one of those notifications to reach
    // scheduleRender() is enough to create the observed update -> close -> reopen
    // cycle. It also used to let the equation-session guard swallow arrow-key
    // caret updates.
    if (continuingActivePreview && (sourceChanged || cursorChanged)) {
      cancelPendingEnvironmentPreviewRender();
      const activeKind = previewElementKind(activePreviewContext);

      if (activeKind === "equation") {
        // Reconstruct the equation against the latest source before updating the
        // active state snapshot. activeEquationTypingContext() falls back to the
        // retained environment range when the just-typed TeX is temporarily
        // unparsable, so the mounted popup never needs to disappear between
        // intermediate keystrokes. Cursor-only changes run immediately so the
        // SmartTeX caret marker follows every arrow key.
        const liveContext = activeEquationTypingContext(currentState);
        if (liveContext) {
          activePreviewContext = liveContext;
          activePreviewState = {
            ...activePreviewState,
            ...currentState,
            focused: true,
            screen: currentState.screen || activePreviewState?.screen
          };
          refreshLiveEquationEditSession(currentState, liveContext);
          typedEnvironmentPreviewActive = environmentPopupUsesHover();
          hoverPreviewState = null;
          scheduleLiveEquationUpdate(currentState, liveContext, {
            immediate: !sourceChanged
          });
        } else {
          // Even an unexpected parser failure must not hand control back to the
          // generic lifecycle while the retained environment range says the
          // caret is still inside this equation. In particular, do not replace
          // activePreviewState.value with a transient input-transaction state
          // whose cursor is outside the environment: the corrected state needs
          // the old source length to reconstruct the edited equation reliably.
          if (!inputTransactionContinuesPreview) {
            activePreviewState = {
              ...activePreviewState,
              ...currentState,
              focused: true,
              screen: currentState.screen || activePreviewState?.screen
            };
          }
          hidePreviewLoading();
        }
        return;
      }

      if (activeKind === "figure" || activeKind === "table") {
        if (sourceChanged) {
          // Keep the retained float boundary synchronized before replacing the
          // active source snapshot. Caption edits then update only the caption DOM
          // and common fit solver; edits elsewhere in the same float deliberately
          // leave the last valid popup mounted rather than closing/reopening it.
          advanceActiveEnvironmentRangeForSourceEdit(currentState);
          if (
            captionPreviewIsLocked() ||
            (inputTransactionContinuesPreview && activeEnvironmentInputTransaction?.captionLocked)
          ) {
            scheduleLiveCaptionUpdate(currentState);
          }
        } else if (cursorChanged && captionPreviewIsLocked()) {
          // Arrow-key movement inside a caption updates the rendered caption
          // caret immediately, matching the equation-preview caret behavior.
          // The mounted figure/table and popup position are preserved.
          scheduleLiveCaptionUpdate(currentState, { immediate: true });
        }
        activePreviewState = {
          ...activePreviewState,
          ...currentState,
          focused: true,
          screen: currentState.screen || activePreviewState?.screen
        };
        hidePreviewLoading();
        if (!sourceChanged) {
          // Cursor-only movement uses the proximity rule but never re-anchors an
          // already visible popup. Source edits are positioned by the live
          // caption updater after it has finished resizing the same DOM.
          const rect = preview.getBoundingClientRect();
          if (!previewPositioned && rect.width > 0 && rect.height > 0) {
            previewPositioned = true;
          }
          window.requestAnimationFrame(() => positionPreviewAtCursor());
        }
        return;
      }
    }

    if (continuingActivePreview && !sourceChanged && !cursorChanged) {
      // Focus/screen/layout notifications belonging to the same mounted
      // environment are bookkeeping, not popup-open requests. Absorb them here
      // so they cannot trigger a redundant generic render after an in-place edit.
      activePreviewState = {
        ...activePreviewState,
        ...currentState,
        focused: true,
        screen: currentState.screen || activePreviewState?.screen
      };
      hidePreviewLoading();
      window.requestAnimationFrame(() => positionPreviewAtCursor());
      return;
    }

    // The legacy live variables below are kept only for non-owned fallback
    // paths. Owned environments have already returned above.
    const liveEquationContext = null;
    const liveCaptionEditing = false;

    if (popupsSuppressedAfterEditorScroll) {
      if (sourceChanged || cursorChanged || focusChanged) {
        popupsSuppressedAfterEditorScroll = false;
      } else {
        // A screen-coordinate-only state update is the normal consequence of
        // scrolling. Keep every popup closed instead of restoring it at the new
        // location. Source highlights and badges are handled independently.
        return;
      }
    }

    scheduleGraphicAutocompletePreviewUpdate();

    if (referencePopupUsesHover()) {
      if (
        activeEditorReferenceKey &&
        (
          sourceChanged ||
          (
            activeEditorReferenceType === "citation" &&
            cursorIsInsideCitationCommand(currentState)
          )
        )
      ) {
        hideCaptionReferencePopup();
      }
    } else {
      updateCursorTriggeredReferencePopup(currentState);
    }

    if (liveEquationContext) {
      // Equation typing is an in-place update transaction. It must not fall
      // through the ordinary cursor-trigger lifecycle, because a transient
      // parser miss there can hide the popup. Keep its position and last valid
      // rendering, then replace/refit the content when KaTeX accepts the edit.
      typedEnvironmentPreviewActive = environmentPopupUsesHover();
      hoverPreviewState = null;
      scheduleLiveEquationUpdate(currentState, liveEquationContext);
      return;
    }

    if (liveCaptionEditing) {
      // Advance the retained float boundaries before replacing activePreviewState
      // with the new source snapshot. applyLiveCaptionUpdate() runs 48 ms later;
      // if the state were replaced first its length delta would be zero and the
      // stored environment close position would remain stale on the next key.
      advanceActiveEnvironmentRangeForSourceEdit(currentState);
      activePreviewState = {
        ...activePreviewState,
        ...currentState,
        screen: currentState.screen || activePreviewState?.screen
      };
      hidePreviewLoading();
      window.requestAnimationFrame(() => positionPreviewAtCursor());
      return;
    }

    if (liveEquationEditSessionContainsState(currentState)) {
      // CollabTeX often emits a second state notification after the text-change
      // event (focus/screen/cursor bookkeeping). Previously that notification
      // fell into the generic hover/cursor trigger and closed/reopened the popup.
      // While the caret remains in the active equation, absorb those secondary
      // notifications and leave the live popup untouched. hidePreview() carries
      // the same session veto so later scroll/hover cleanup cannot undo this
      // decision after this state callback has returned.
      currentState.focused = true;
      if (!currentState.screen && previousState?.screen) currentState.screen = previousState.screen;
      activePreviewState = { ...activePreviewState, ...currentState };
      hidePreviewLoading();
      window.requestAnimationFrame(() => positionPreviewAtCursor());
      return;
    }

    if (!sourceChanged && cursorChanged && continuingActivePreview) {
      // Arrow-key/caret movement inside an already-open environment is not a
      // new popup request. Equations additionally need an in-place KaTeX refresh
      // so the rendered caret marker follows the editor caret; figure/table
      // captions keep their existing content and only run the safety relocation
      // check. Neither case is allowed to enter the generic reopen pipeline.
      activePreviewState = { ...activePreviewState, ...currentState };
      hidePreviewLoading();
      if (previewElementKind(activePreviewContext) === "equation") {
        const hasSelection = Number(currentState.selectionFrom) !== Number(currentState.selectionTo);
        if (!hasSelection) {
          const cursorContext = activeEquationTypingContext(currentState);
          if (cursorContext) {
            scheduleLiveEquationUpdate(currentState, cursorContext, { immediate: true });
            return;
          }
        }
      }
      window.requestAnimationFrame(() => positionPreviewAtCursor());
      return;
    }

    if (environmentPopupUsesHover()) {
      const typedEnvironmentContext = (
        typedEnvironmentPreviewActive || sourceChanged
      ) ? findPreviewContext(currentState) : null;
      if (sourceChanged && typedEnvironmentContext) {
        typedEnvironmentPreviewActive = true;
      } else if (
        typedEnvironmentPreviewActive &&
        ((!typedEnvironmentContext && !continuingActivePreview) ||
          (currentState?.focused === false && !recentEditorTyping))
      ) {
        typedEnvironmentPreviewActive = false;
      }

      if (typedEnvironmentPreviewActive) {
        if (hoverPreviewState) clearEnvironmentHoverPreview({ hide: false });
        if (stateCanShowPreview(currentState)) {
          scheduleRender({
            immediate: !sourceChanged,
            preserveExisting: recentEditorTyping || continuingActivePreview
          });
        } else if (continuingActivePreview) {
          hidePreviewLoading();
        } else {
          hidePreview();
        }
        return;
      }

      if (hoverPreviewState) {
        hoverPreviewState = {
          ...hoverPreviewState,
          value: currentState.value,
          fileName: currentState.fileName,
          focused: true
        };
        if (stateCanShowPreview(hoverPreviewState)) {
          scheduleRender({ immediate: !sourceChanged });
        } else {
          clearEnvironmentHoverPreview();
        }
        return;
      }
      hidePreview();
      return;
    }

    typedEnvironmentPreviewActive = false;
    hoverPreviewState = null;
    if (!stateCanShowPreview(currentState)) {
      if (continuingActivePreview) {
        hidePreviewLoading();
        return;
      }
      hidePreview();
      return;
    }

    // A scroll/layout update can emit a new screen position without changing
    // source, cursor, or selection. Re-anchor the existing popup only; do not
    // invoke KaTeX or any document analysis for that event.
    if (
      !sourceChanged &&
      !cursorChanged &&
      !focusChanged &&
      activePreviewContext &&
      activePreviewState
    ) {
      activePreviewState = currentState;
      window.requestAnimationFrame(() => positionPreviewAtCursor());
      return;
    }

    const captionTypingActive = Boolean(
      recentEditorTyping &&
      captionPreviewLock &&
      !preview.hidden &&
      ["figure", "table"].includes(activePreviewContext?.kind)
    );
    scheduleRender({
      immediate: !sourceChanged,
      preserveExisting: recentEditorTyping || continuingActivePreview,
      delayMs: captionTypingActive
        ? CAPTION_TYPING_RENDER_DELAY_MS
        : SOURCE_RENDER_DELAY_MS,
      deferContextLookup: captionTypingActive
    });
  });

  closeButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });
  closeButton.addEventListener("click", dismissPreview);

  document.addEventListener("keydown", (event) => {
    popupsSuppressedAfterEditorScroll = false;
    if (event.key !== "Escape") return;
    if (!preview.hidden) dismissPreview();
    if (!graphicAutocompletePreview.hidden) dismissGraphicAutocompleteClickPreview();
    if (captionReferencePopup && !captionReferencePopup.hidden) {
      hideCaptionReferencePopup();
    }
  }, true);
  document.addEventListener("pointermove", (event) => {
    popupsSuppressedAfterEditorScroll = false;
    const clientX = Number(event.clientX);
    const clientY = Number(event.clientY);
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      lastPointerScreen = {
        pageX: clientX + window.scrollX,
        pageY: clientY + window.scrollY,
        lineHeight: Math.max(14, Number(currentState?.screen?.lineHeight) || 16)
      };
    }
    scheduleEditorReferenceHover(event);
    scheduleEnvironmentPreviewHover(event);
  }, true);
  document.addEventListener("pointerdown", (event) => {
    popupsSuppressedAfterEditorScroll = false;
    // Pointer navigation is explicit and therefore ends any short input-state
    // bridge immediately; subsequent state is allowed to close/switch previews.
    activeEnvironmentInputTransaction = null;
    if (
      referencePopupContains(event.target) ||
      autocompleteSurface(event.target) ||
      editorSurface(event.target)
    ) return;
    hideCaptionReferencePopup();
  }, true);

  window.addEventListener("pointerup", () => {
    if (!referencePopupPointerDown) return;
    referencePopupPointerDown = false;
    noteReferencePopupInteraction(400);
  }, true);
  window.addEventListener("pointercancel", () => {
    referencePopupPointerDown = false;
    noteReferencePopupInteraction(250);
  }, true);
  window.addEventListener("blur", () => {
    referencePopupPointerDown = false;
  });

  window.addEventListener(COMMENTS_INITIALIZATION_STATE_EVENT, (event) => {
    const detail = event?.detail && typeof event.detail === "object" ? event.detail : {};
    commentsInitializationActive = detail.active === true;
    if (!commentsInitializationActive) {
      window.clearTimeout(commentsInitializationFailSafe);
      commentsInitializationFailSafe = 0;
    }
    updateToolbarLoadingSpinner();
  });

  window.addEventListener(REVIEW_HYDRATION_STATE_EVENT, (event) => {
    let detail = {};
    try {
      detail = typeof event?.detail === "string"
        ? JSON.parse(event.detail)
        : (event?.detail || {});
    } catch (_error) {
      detail = {};
    }
    reviewHydrationActive = detail.active === true;
    if (!reviewHydrationActive) {
      window.clearTimeout(reviewHydrationFailSafe);
      reviewHydrationFailSafe = 0;
    }
    updateToolbarLoadingSpinner();
  });

  window.addEventListener(STRUCTURE_ANALYSIS_STATE_EVENT, (event) => {
    let detail = {};
    try {
      detail = typeof event?.detail === "string"
        ? JSON.parse(event.detail)
        : (event?.detail || {});
    } catch (_error) {
      detail = {};
    }
    setStructureSpinnerActive(detail.active === true);
  });

  const structureAnalysisStateObserver = new MutationObserver(() => {
    setStructureSpinnerActive(
      document.documentElement.dataset.smarttexStructureAnalysis === "pending"
    );
  });
  structureAnalysisStateObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-smarttex-structure-analysis"]
  });

  updateToolbarLoadingSpinner();

  optionsButton.addEventListener("click", () => {
    if (typeof extensionApi?.runtime?.sendMessage === "function") {
      Promise.resolve(
        extensionApi.runtime.sendMessage({ type: "smarttex-open-options" })
      ).catch(() => {});
      return;
    }
    extensionApi?.runtime?.openOptionsPage?.();
  });
  popupSettingsReady.then(() => {
    if (popupsSuppressedAfterEditorScroll) return;
    if (!referencePopupUsesHover()) updateCursorTriggeredReferencePopup(currentState);
    if (!environmentPopupUsesHover() && stateCanShowPreview(currentState)) {
      scheduleRender();
    }
  });
  attachOptionsButton();
  const optionsButtonObserver = new MutationObserver(() => {
    if (optionsButton.isConnected && optionsButtonSlot?.isConnected) return;
    attachOptionsButton();
  });
  optionsButtonObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  // Observe only insertion/removal of autocomplete DOM. Watching class and
  // style attributes across the complete application causes the callback to
  // run for every caret repaint and editor layout update. The resulting global
  // query plus computed-style/layout reads blocked ordinary typing. Keyboard
  // and pointer selection changes are already handled by the listeners below.
  const GRAPHIC_AUTOCOMPLETE_DOM_SELECTOR = [
    ".ace_autocomplete",
    ".ace_autocomplete_popup",
    "#smarttex-figure-autocomplete-popup",
    "[role='listbox']"
  ].join(",");
  const graphicAutocompleteMutation = (mutation) => {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
    if (target?.closest?.(GRAPHIC_AUTOCOMPLETE_DOM_SELECTOR)) return true;
    return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => (
      node instanceof Element && (
        node.matches(GRAPHIC_AUTOCOMPLETE_DOM_SELECTOR) ||
        node.querySelector(GRAPHIC_AUTOCOMPLETE_DOM_SELECTOR)
      )
    ));
  };
  const graphicAutocompleteObserver = new MutationObserver((mutations) => {
    if (mutations.some(graphicAutocompleteMutation)) scheduleGraphicAutocompletePreviewUpdate();
  });
  graphicAutocompleteObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  document.addEventListener("keyup", scheduleGraphicAutocompletePreviewUpdate, true);
  window.addEventListener("smarttex:graphic-autocomplete-selection-change", (event) => {
    customGraphicAutocompleteSelectionPath = String(event?.detail?.path || "").trim();
    customGraphicAutocompletePreviewSuppressed = event?.detail?.suppressPreview === true;
    graphicAutocompleteClickPreview = event?.detail?.mode === "click";
    graphicAutocompletePreview.classList.toggle(
      "smarttex-graphic-autocomplete-click-preview",
      graphicAutocompleteClickPreview
    );
    graphicAutocompleteClose.hidden = false;
    scheduleGraphicAutocompletePreviewUpdate();
  });
  const noteEditorTextInput = (event) => {
    if (!editorSurface(event.target)) return;
    const now = Date.now();
    lastEditorTextInputAt = now;
    if (!preview.hidden && activeEnvironmentPreviewContainsState(currentState)) {
      // Capture ownership from the real DOM input event, before CollabTeX emits
      // any potentially transient editor-state snapshots. This transaction is
      // intentionally short-lived; it only bridges the non-atomic input/state
      // publication window and never changes normal arrow-key/pointer navigation.
      activeEnvironmentInputTransaction = {
        contextId: activeContextId,
        fileName: String(currentState?.fileName || ""),
        kind: previewElementKind(activePreviewContext),
        captionLocked: captionPreviewIsLocked(),
        sourceLength: String(currentState?.value || "").length,
        expiresAt: now + 900
      };
    } else {
      activeEnvironmentInputTransaction = null;
    }
  };
  document.addEventListener("beforeinput", noteEditorTextInput, true);
  document.addEventListener("input", noteEditorTextInput, true);
  document.addEventListener("pointermove", (event) => {
    const owner = nativeGraphicAutocompleteOwnerFromNode(event.target);
    const entry = hoveredNativeGraphicEntry(event.target, owner);
    const changed = (
      graphicAutocompleteHoveredOwner !== owner ||
      graphicAutocompleteHoveredEntry !== entry
    );
    graphicAutocompleteHoveredOwner = owner;
    graphicAutocompleteHoveredEntry = entry;
    if (owner || changed) scheduleGraphicAutocompletePreviewUpdate();
  }, { capture: true, passive: true });

  document.addEventListener("pointermove", (event) => {
    updateStructureHoverPointer(event);
  }, { capture: true, passive: true });
  document.addEventListener("pointerover", (event) => {
    const item = fileTreeGraphicItemFromNode(event.target);
    if (!item) return;
    if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) return;
    updateStructureHoverPointer(event);
    // Native CollabTeX file entries often expose the path through title
    // attributes. Suppress those browser tooltips for as long as SmartTeX's
    // richer thumbnail hover target is active.
    suppressStructureHoverTooltips(item);
    scheduleStructureHoverPreview(item, () => cachedFileTreeHoverPreview(item), event);
  }, true);
  document.addEventListener("pointerout", (event) => {
    const item = fileTreeGraphicItemFromNode(event.target);
    if (!item) return;
    if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) return;
    hideStructureHoverPreview();
    if (structureHoverTooltipRoot === item) restoreStructureHoverTooltips();
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!event.target?.closest?.("#smarttex-structure-hover-preview")) {
      hideStructureHoverPreview();
    }
  }, true);
  window.addEventListener("scroll", () => hideStructureHoverPreview(), true);
  window.addEventListener("blur", () => {
    hideStructureHoverPreview();
    restoreStructureHoverTooltips();
  });

  window.addEventListener(RUNTIME_SETTINGS_EVENT, (event) => {
    const detail = event?.detail || {};
    const figuresWereEnabled = enabledFeatures.figures;
    runtimeSettingsOverrideActive = detail.usingPresets === false;
    const features = detail.features || {};
    enabledFeatures.equations = features.equations !== false;
    enabledFeatures.tables = features.tables !== false;
    enabledFeatures.figures = features.figures !== false;

    const popupSettings = detail.referencePopups || {};
    referencePopupTrigger = popupSettings.trigger === "hover" ? "hover" : "cursor";
    environmentPopupTrigger = popupSettings.environmentTrigger === "hover" ? "hover" : "cursor";
    dispatchStructureHighlightSettings(detail.highlights || {});

    if (figuresWereEnabled && !enabledFeatures.figures) {
      captionPreviewLock = null;
      hidePreview({ force: true });
    } else {
      hidePreview();
    }
    hideCaptionReferencePopup();
    hideNestedReferencePopupsFromDepth(1);
    if (!enabledFeatures.figures) hideGraphicAutocompletePreview();
    window.clearTimeout(editorReferenceHoverTimer);
    editorReferenceHoverGeneration += 1;
    window.clearTimeout(environmentHoverTimer);
    environmentHoverTimer = null;
    environmentHoverGeneration += 1;
    hoverPreviewState = null;

    if (!referencePopupUsesHover()) updateCursorTriggeredReferencePopup(currentState);
    const previewState = previewStateForRender();
    if (!environmentPopupUsesHover() && stateCanShowPreview(previewState)) scheduleRender();
  });

  extensionApi?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!runtimeSettingsOverrideActive && changes?.[FEATURES_KEY]) {
      const features = changes[FEATURES_KEY].newValue;
      enabledFeatures.equations = features?.equations !== false;
      enabledFeatures.tables = features?.tables !== false;
      enabledFeatures.figures = features?.figures !== false;
      if (!enabledFeatures.figures) {
        captionPreviewLock = null;
        hidePreview({ force: true });
      } else {
        hidePreview();
      }
      hideCaptionReferencePopup();
      hideNestedReferencePopupsFromDepth(1);
      if (!enabledFeatures.figures) hideGraphicAutocompletePreview();
      const previewState = previewStateForRender();
      if (stateCanShowPreview(previewState)) scheduleRender();
    }
    if (!runtimeSettingsOverrideActive && changes?.[REFERENCE_POPUPS_KEY]) {
      const settings = changes[REFERENCE_POPUPS_KEY].newValue || {};
      referencePopupTrigger = settings.trigger === "hover" ? "hover" : "cursor";
      environmentPopupTrigger = settings.environmentTrigger === "hover"
        ? "hover"
        : "cursor";
      hideCaptionReferencePopup();
      window.clearTimeout(editorReferenceHoverTimer);
      editorReferenceHoverGeneration += 1;
      window.clearTimeout(environmentHoverTimer);
      environmentHoverTimer = null;
      environmentHoverGeneration += 1;
      hoverPreviewState = null;
      hidePreview();
      if (!referencePopupUsesHover()) {
        updateCursorTriggeredReferencePopup(currentState);
      }
      if (!environmentPopupUsesHover() && stateCanShowPreview(currentState)) {
        scheduleRender();
      }
    }
    if (!runtimeSettingsOverrideActive && changes?.[STRUCTURE_HIGHLIGHT_KEY]) {
      dispatchStructureHighlightSettings(changes[STRUCTURE_HIGHLIGHT_KEY].newValue);
    }
  });

  window.addEventListener("smarttex:set-popup-caption-font-scale", () => {
    // The settings menu updates a root CSS variable immediately. Re-fit an open
    // figure/table synchronously so a larger caption gets enough popup space,
    // but do not rerender LaTeX/media or move a popup that is already positioned.
    if (preview.hidden || !["figure", "table"].includes(preview.dataset.previewKind || "")) return;
    const prepared = {
      maxWidth: Number(preview.dataset.smarttexAutoFitMaxWidth) || undefined,
      maxHeight: Number(preview.dataset.smarttexAutoFitMaxHeight) || undefined
    };
    window.requestAnimationFrame(() => {
      if (preview.hidden) return;
      applyPreviewAutoFitPolicyNow(prepared, {
        allowGrow: preview.dataset.smarttexTemporarySized !== "true"
      });
    });
  });

  window.addEventListener("resize", () => {
    positionPreview();
    repositionReferencePopups();
    scheduleGraphicAutocompletePreviewUpdate();
  }, { passive: true });
  window.addEventListener("smarttex:editor-scroll-state", (event) => {
    if (event?.detail?.active === true) {
      const activeCaptionEdit = Boolean(
        !preview.hidden &&
        captionContainerAtIndex(currentState) &&
        stateContinuesActiveEnvironmentPreview(currentState)
      );
      // Typing can make CollabTeX auto-scroll the editor to keep the caret in
      // view. An equation edit session is stronger evidence of an ongoing edit
      // than the short generic input-time window, so never let that auto-scroll
      // close the live equation popup merely because the scroll event arrives
      // a few hundred milliseconds after the key event.
      const activeEquationEdit = liveEquationEditSessionContainsState(currentState);
      const activeEnvironmentEdit = activeEnvironmentPreviewContainsState(currentState);
      const keepTypingOverlays = Boolean(
        activeCaptionEdit ||
        activeEquationEdit ||
        activeEnvironmentEdit ||
        (
          Date.now() - lastEditorTextInputAt < 350 &&
          currentState?.focused !== false
        )
      );
      if (keepTypingOverlays) {
        popupsSuppressedAfterEditorScroll = false;
        // An editor auto-scroll caused by typing belongs to the same editing
        // interaction. Keep all active previews mounted and refresh only their
        // content/position from the state updates already in flight.
        window.requestAnimationFrame(() => {
          positionPreviewAtCursor();
          repositionReferencePopups();
          scheduleGraphicAutocompletePreviewUpdate();
        });
        return;
      }
      popupsSuppressedAfterEditorScroll = true;
      window.clearTimeout(editorReferenceHoverTimer);
      editorReferenceHoverGeneration += 1;
      window.clearTimeout(environmentHoverTimer);
      environmentHoverTimer = null;
      environmentHoverGeneration += 1;
      hoverPreviewState = null;
      hidePreview();
      hideCaptionReferencePopup();
      hideNestedReferencePopupsFromDepth(1);
      hideGraphicAutocompletePreview();
      return;
    }
    // Highlights and source-number badges are repositioned by page-bridge.js.
    // Popups are intentionally not restored after scrolling. They may open again
    // only after a subsequent cursor, keyboard, pointer or hover interaction.
  });
  window.addEventListener("scroll", (event) => {
    if (referencePopupContains(event.target)) {
      keepReferencePopupOpen(event);
      return;
    }
    if (environmentPopupUsesHover() && editorSurface(event.target)) {
      clearEnvironmentHoverPreview();
    }
    if (activeEditorReferenceKey) hideCaptionReferencePopup();
    if (preview.hidden || !previewPositioned) return;
    verticalScrollRepositionPending = true;

    // A document scroll changes the viewport-relative cursor position without
    // requiring a fresh editor state. Editor scrollers dispatch an updated
    // state through the page bridge, which positions the preview afterwards.
    if (
      event.target === window ||
      event.target === document ||
      event.target === document.scrollingElement ||
      event.target === document.documentElement
    ) {
      window.requestAnimationFrame(() => positionPreview());
    }
  }, { passive: true, capture: true });
  window.addEventListener(CITATION_REFRESH_RESULT_EVENT, (event) => {
    let detail = {};
    try {
      detail = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      return;
    }
    const pending = pendingCitationRefreshes.get(String(detail.requestId || ""));
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingCitationRefreshes.delete(String(detail.requestId || ""));
    if (pending.button?.isConnected) {
      pending.button.disabled = false;
      pending.button.classList.remove("smarttex-citation-popup-refreshing");
      pending.button.innerHTML = detail.ok
        ? '<span aria-hidden="true">✓</span> Refreshed'
        : '<span aria-hidden="true">↻</span> Refresh';
      pending.button.title = detail.message || "Re-parse bibliography files";
    }
    pending.resolve(detail.ok === true);
  });

  window.addEventListener(CITATION_CACHE_UPDATED_EVENT, () => {
    citationRecordsPromise = null;
    citationRecordsLoaded = false;
  });

  window.addEventListener("pagehide", () => {
    hideCaptionReferencePopup();
    hidePreview({ force: true });
    for (const pending of pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("SmartTeX page closed."));
    }
    pendingRequests.clear();
  }, { once: true });
  window.addEventListener("pagehide", () => {
    optionsButtonObserver.disconnect();
    graphicAutocompleteObserver.disconnect();
    structureAnalysisStateObserver.disconnect();
    window.clearTimeout(structureSpinnerHideTimer);
    if (graphicAutocompleteUpdateFrame !== null) {
      window.cancelAnimationFrame(graphicAutocompleteUpdateFrame);
    }
    hideGraphicAutocompletePreview();
  }, { once: true });
  };

  initializeWhenDependenciesAreReady().catch((error) => {
    globalThis.__smartTeXPreviewLoading = false;
    console.error(error?.message || "SmartTeX: A preview renderer could not be loaded.", error);
  });
})();
