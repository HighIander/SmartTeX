/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  function isSmartTeXEditorPage() {
    // CollabTeX project overview routes can also be /project/<id>. Only load
    // the MAIN-world bridge for the editor-specific shell or editing surface.
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

  // The bridge is origin-wide but editor-only. On the project overview this
  // avoids installing the editor polling, mutation observers, geometry work,
  // and structure parser that otherwise continue scanning a page with no editor.
  if (!isSmartTeXEditorPage()) return;

  const staleStackingStyle = document.getElementById("smarttex-overlay-stacking-style");
  if (staleStackingStyle?.textContent?.includes(".ace_editor .ace_scroller")) {
    staleStackingStyle.remove();
  }
  if (globalThis.__smartTeXEditorBridgeLoaded) return;
  globalThis.__smartTeXEditorBridgeLoaded = true;

  const STATE_EVENT = "smarttex:editor-state";
  const PREVIEW_STATE_EVENT = "smarttex:preview-editor-state";
  const CITATION_REQUEST_EVENT = "smarttex:citation-editor-request";
  const CITATION_RESPONSE_EVENT = "smarttex:citation-editor-response";
  const STRUCTURE_ANALYSIS_STATE_EVENT = "smarttex:structure-analysis-state";
  const REVIEW_HYDRATION_STATE_EVENT = "smarttex:review-hydration-state";
  const COMMENT_OVERLAY_STATE_EVENT = "smarttex:comment-overlay-state";
  const COMMENT_ANCHOR_ACTIVATE_EVENT = "smarttex:comment-anchor-activate";
  const COLLABORATION_PRESENCE_EVENT = "smarttex:collaboration-presence";
  const COLLABORATION_PROFILE_EVENT = "smarttex:collaboration-local-profile";
  const COLLABTEX_IDENTITY_EVENT = "smarttex:collabtex-local-identity";
  const COLLABTEX_IDENTITY_REFRESH_EVENT = "smarttex:collabtex-identity-refresh";
  const COLLABORATION_DIRTY_EVENT = "smarttex:collaboration-metadata-dirty";
  const COLLABORATION_SIGNAL_EVENT = "smarttex:collaboration-signal";
  const CITE_COMMAND = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)$/i;
  const REFERENCE_COMMAND = /\\(?:eqref|ref|pageref|autoref|cref|Cref|vref|Vref|nameref)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)$/;
  const INCLUDEGRAPHICS_COMMAND = /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^{}]*)$/i;
  const FIGURE_FILE_PATTERN = /\.(?:png|jpe?g|gif|svg|pdf|eps|webp)$/i;
  let editorKind = "";
  let editor = null;
  let boundSession = null;
  let scheduledState = false;
  let stateTimer = 0;
  let stateScheduleRevision = 0;
  let previewStateFrame = 0;
  let lastPreviewSnapshot = null;
  let pointerStateFrame = 0;
  let pointerStateRevision = 0;
  let pointerSelectionActive = false;
  let lastFingerprint = "";
  let codeMirrorCleanup = null;
  let citationAutocompleteActive = false;
  let referenceAutocompleteActive = false;
  let figureAutocompleteActive = false;
  let numberBadgeLayer = null;
  let structureHighlightLayer = null;
  let commentHighlightLayer = null;
  let commentIconLayer = null;
  let commentOverlayAnchors = [];
  let commentIconsVisible = true;
  let commentIconOpacity = 1;
  let commentMarksVisible = true;
  let commentMarkOpacity = 0.30;
  let collaborationSocket = null;
  let collaborationSocketCleanup = null;
  let collaborationPresenceTimer = 0;
  let collaborationPresenceHeartbeat = 0;
  let collaborationSocketPoll = 0;
  let collaborationSocketSearchMisses = 0;
  const pendingCollaborationSignals = new Map();
  let lastCollaborationPresenceFingerprint = "";
  let collaborationProfile = { name: "Anonymous", color: "#268bd2", authorId: "" };
  let lastCollabtexIdentityName = "";
  let collabtexIdentityDiscoveryTimer = 0;
  let collabtexSettingsIdentityFetchAttempted = false;
  let selectedDocumentCache = { fileName: "", documentId: "", at: 0 };
  let lastPointerClientX = -10000;
  let lastPointerClientY = -10000;
  const markerConvertHoverUntil = new Map();
  document.addEventListener("pointermove", (event) => {
    lastPointerClientX = Number(event.clientX);
    lastPointerClientY = Number(event.clientY);
  }, { capture: true, passive: true });

  let structureHighlightSettings = {
    environmentEnabled: true,
    environmentColor: "#dfedfb",
    environmentFirstLineEnabled: true,
    environmentFirstLineColor: "#c7e4ff",
    sectionEnabled: true,
    sectionColor: "#c4a7ff",
    captionEnabled: false,
    captionColor: "#70afea",
    labelEnabled: false,
    labelColor: "#8fd19e",
    referenceEnabled: true,
    referenceColor: "#bcf0c8",
    nonumberEnabled: false,
    nonumberColor: "#ffe69a",
    inlineMathEnabled: true,
    inlineMathColor: "#cce5ff",
    activeEnabled: true,
    activeStrength: 55
  };
  let lastEditorState = null;
  let cachedStructureSource = null;
  let cachedStructures = { badges: [], highlights: [] };
  let structureRefreshTimer = 0;
  let overlayFramePending = false;
  let overlayFrameId = 0;
  let overlayIdleTimer = 0;
  let lastOverlayScrollPosition = null;
  let lastStructurePaint = null;
  let editorDiscoveryTimer = 0;
  let structureAnalysisActive =
    document.documentElement.dataset.smarttexStructureAnalysis === "pending";
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const OCCLUDING_OVERLAY_SELECTOR = [
    "[role='listbox']",
    "[role='menu']",
    "[role='dialog']",
    "[role='tooltip']",
    "[class*='popover']",
    "[class*='popup']",
    "[class*='tooltip']",
    "[class*='spellcheck']",
    "[class*='suggestion']"
  ].join(",");

  function taskCheckpoint(iteration = 0, interval = 128) {
    interactionTasks?.checkpoint?.(iteration, interval);
  }

  function keyboardIdleDelay() {
    return Math.max(0, Number(interactionTasks?.keyboardIdleRemaining?.()) || 0);
  }

  function textInputIsActive() {
    return document.documentElement.getAttribute("data-smarttex-editor-typing") === "true";
  }

  function sourceOverlaysPending() {
    return document.documentElement.getAttribute(
      "data-smarttex-source-overlays-pending"
    ) === "true";
  }

  function setSourceOverlaysPending(active) {
    if (active) {
      document.documentElement.setAttribute("data-smarttex-source-overlays-pending", "true");
    } else {
      document.documentElement.removeAttribute("data-smarttex-source-overlays-pending");
    }
  }

  function setStructureAnalysisState(active) {
    const next = Boolean(active);
    const state = next ? "pending" : "ready";
    if (structureAnalysisActive === next && document.documentElement.dataset.smarttexStructureAnalysis === state) {
      return;
    }
    structureAnalysisActive = next;
    document.documentElement.dataset.smarttexStructureAnalysis = state;
    window.dispatchEvent(new CustomEvent(STRUCTURE_ANALYSIS_STATE_EVENT, {
      detail: JSON.stringify({ active: next })
    }));
  }

  function normalizedHighlightColor(value) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#dfedfb";
  }

  function colorWithAlpha(hexColor, alpha) {
    const normalized = normalizedHighlightColor(hexColor).slice(1);
    const red = Number.parseInt(normalized.slice(0, 2), 16);
    const green = Number.parseInt(normalized.slice(2, 4), 16);
    const blue = Number.parseInt(normalized.slice(4, 6), 16);
    return `rgba(${red},${green},${blue},${alpha})`;
  }

  function boundedPercent(value, fallback = 55) {
    const numeric = Number(value);
    return Math.max(0, Math.min(100, Number.isFinite(numeric) ? numeric : fallback));
  }

  function activeAlpha(normalAlpha, maximumAlpha, active, categoryEnabled, configuredStrengthMultiplier = 1) {
    if (!active) return normalAlpha;
    const strength = boundedPercent(structureHighlightSettings.activeStrength) / 100;
    if (!categoryEnabled) return (0.10 + strength * 0.42) / 3;
    const effectiveStrength = Math.min(1, strength * Math.max(0, Number(configuredStrengthMultiplier) || 0));
    return normalAlpha + (maximumAlpha - normalAlpha) * effectiveStrength;
  }

  function ensureNumberBadgeLayer() {
    if (numberBadgeLayer?.isConnected) return numberBadgeLayer;
    numberBadgeLayer = document.createElement("div");
    numberBadgeLayer.id = "smarttex-source-number-badges";
    numberBadgeLayer.style.cssText = [
      "position:fixed", "pointer-events:none", "overflow:hidden", "z-index:40",
      "font:12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif", "color:#7b8493"
    ].join(";");
    document.documentElement.appendChild(numberBadgeLayer);
    return numberBadgeLayer;
  }

  function ensureOverlayStackingStyle() {
    let style = document.getElementById("smarttex-overlay-stacking-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "smarttex-overlay-stacking-style";
      document.documentElement.appendChild(style);
    }
    style.textContent = `
      /* Keep SmartTeX colour fields in the editor's own isolated stacking
         context. Marker/selection layers remain above the colour fields, and
         glyphs/carets remain above every translucent background. */
      .ace_editor,
      .cm-editor {
        isolation: isolate;
      }
      .ace_editor .ace_marker-layer,
      .cm-editor .cm-selectionLayer {
        z-index: 2 !important;
      }
      .ace_editor .ace_content,
      .ace_editor .ace_text-layer,
      .cm-editor .cm-content {
        z-index: 3 !important;
      }
      .ace_editor .ace_cursor-layer,
      .cm-editor .cm-cursorLayer {
        z-index: 4 !important;
      }
      /* CollabTeX/Overleaf already transports collaborator cursors over its
         realtime socket. Keep that native, zero-extra-traffic layer above all
         SmartTeX editor-local colour fields. */
      .cm-editor .ol-cm-cursorHighlightsLayer,
      .ace_editor [class*="remote-cursor"],
      .ace_editor [class*="remote_cursor"] {
        z-index: 1000 !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      .ace_editor .ace_gutter,
      .cm-editor .cm-gutters {
        z-index: 5 !important;
      }
      .cm-editor .cm-panels,
      .cm-editor .cm-panel,
      .ace_search,
      [class*="search-panel"],
      [class*="searchPanel"] {
        z-index: 2147483644 !important;
      }
    `;
  }

  function ensureStructureHighlightLayer() {
    const host = editorRootElement();
    if (!host) return structureHighlightLayer;
    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
    if (!structureHighlightLayer) {
      structureHighlightLayer = document.createElement("div");
      structureHighlightLayer.id = "smarttex-source-structure-highlights";
      structureHighlightLayer.style.cssText = [
        "position:absolute", "pointer-events:none", "overflow:hidden", "z-index:1"
      ].join(";");
    }
    if (structureHighlightLayer.parentElement !== host) {
      host.appendChild(structureHighlightLayer);
    }
    ensureOverlayStackingStyle();
    return structureHighlightLayer;
  }

  function ensureCommentHighlightLayer() {
    const host = editorRootElement();
    if (!host) return commentHighlightLayer;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    if (!commentHighlightLayer) {
      commentHighlightLayer = document.createElement("div");
      commentHighlightLayer.id = "smarttex-comment-highlights";
      commentHighlightLayer.style.cssText = [
        "position:absolute", "pointer-events:none", "overflow:hidden", "z-index:1"
      ].join(";");
    }
    if (commentHighlightLayer.parentElement !== host) host.appendChild(commentHighlightLayer);
    ensureOverlayStackingStyle();
    return commentHighlightLayer;
  }

  function ensureCommentIconLayer() {
    if (commentIconLayer?.isConnected) return commentIconLayer;
    commentIconLayer = document.createElement("div");
    commentIconLayer.id = "smarttex-comment-icons";
    commentIconLayer.style.cssText = [
      "position:fixed", "inset:0", "pointer-events:none", "z-index:2147483600", "overflow:hidden"
    ].join(";");
    document.documentElement.appendChild(commentIconLayer);
    return commentIconLayer;
  }

  function lineStartIndex(source, index) {
    return source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  }

  function lineEndIndex(source, index) {
    const newline = source.indexOf("\n", Math.max(0, index));
    return newline < 0 ? source.length : newline;
  }

  function isEscaped(source, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
    return (slashes % 2) === 1;
  }

  function balancedGroupEnd(source, openIndex, openChar = "{", closeChar = "}") {
    if (source[openIndex] !== openChar) return -1;
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
      if (isEscaped(source, index)) continue;
      if (source[index] === openChar) depth += 1;
      else if (source[index] === closeChar && --depth === 0) return index + 1;
    }
    return -1;
  }

  function appendCommandRanges(source, highlights, maskedSource = null) {
    const searchable = maskedSource || globalThis.SmartTeXLatexContext?.maskIgnoredLatex?.(source) || source;
    const simple = [
      { pattern: /\\(?:nonumber|notag)\b/g, kind: "nonumber" },
      { pattern: /\\label\s*\{/g, kind: "label", group: true },
      { pattern: /\\(?:eqref|ref|pageref|autoref|cref|Cref|vref|Vref|nameref)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{/g, kind: "reference", group: true },
      { pattern: /\\caption\*?\s*(?:\[[^\]]*\]\s*)?\{/g, kind: "caption", group: true }
    ];
    for (const entry of simple) {
      let match;
      while ((match = entry.pattern.exec(searchable))) {
        taskCheckpoint(entry.pattern.lastIndex);
        let end = match.index + match[0].length;
        if (entry.group) {
          const open = searchable.lastIndexOf("{", end - 1);
          const groupEnd = balancedGroupEnd(searchable, open);
          if (groupEnd > 0) end = groupEnd;
        }
        highlights.push({ start: match.index, end, firstLineEnd: end, kind: entry.kind, inline: true });
      }
    }

    // Inline mathematics: unescaped $...$ and \\(...\\). Display $$...$$ is intentionally omitted.
    for (let index = 0; index < searchable.length; index += 1) {
      taskCheckpoint(index);
      if (searchable[index] === "$" && !isEscaped(searchable, index) && searchable[index + 1] !== "$" && searchable[index - 1] !== "$" ) {
        let end = index + 1;
        while (end < searchable.length) {
          if (searchable[end] === "$" && !isEscaped(searchable, end) && searchable[end + 1] !== "$" ) break;
          end += 1;
        }
        if (end < searchable.length) {
          highlights.push({ start: index, end: end + 1, firstLineEnd: end + 1, kind: "inlineMath", inline: true });
          index = end;
        }
      } else if (searchable.startsWith("\\(", index) && !isEscaped(searchable, index)) {
        const end = searchable.indexOf("\\)", index + 2);
        if (end >= 0) {
          highlights.push({ start: index, end: end + 2, firstLineEnd: end + 2, kind: "inlineMath", inline: true });
          index = end + 1;
        }
      }
    }
  }

  function sourceNumberBadges(sourceValue) {
    const source = String(sourceValue || "");
    const badges = [];
    const highlights = [];
    const sectionTokens = [];
    const latexContext = globalThis.SmartTeXLatexContext;
    const masked = latexContext?.maskIgnoredLatex?.(source) || source;
    const numberedSections = latexContext?.sectionNumbering?.(source) || [];
    const sectionByStart = new Map(
      numberedSections.map((section) => [section.sourceIndex, section])
    );
    const tokenPattern = /\\begin\s*\{(equation\*?|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|eqnarray\*?|figure\*?|table\*?)\}|\\(section|subsection|subsubsection|paragraph)(\*)?\s*\{/g;
    const equationContexts = latexContext?.equationContexts?.(source)?.contexts || [];
    const equationByStart = new Map(equationContexts.map((context) => [context.openStart, context]));
    const figureByStart = new Map(
      (latexContext?.figureContexts?.(source) || []).map((context) => [context.openStart, context])
    );
    const tableByStart = new Map(
      (latexContext?.tableFloatContexts?.(source) || []).map((context) => [context.openStart, context])
    );
    let match;

    while ((match = tokenPattern.exec(masked))) {
      taskCheckpoint(tokenPattern.lastIndex);
      if (match[2]) {
        const section = sectionByStart.get(match.index);
        if (!section || section.starred) continue;
        const level = section.level;
        const number = section.number;
        const start = lineStartIndex(source, match.index);
        badges.push({ index: start, label: `Sec. ${number}` });
        sectionTokens.push({ start, level });
        continue;
      }

      const environment = match[1];
      const base = environment.replace(/\*$/, "");
      const starred = environment.endsWith("*");
      const endPattern = new RegExp(`\\\\end\\s*\\{${environment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "g");
      endPattern.lastIndex = tokenPattern.lastIndex;
      const endMatch = endPattern.exec(masked);
      const bodyEnd = endMatch ? endMatch.index : source.length;
      const body = masked.slice(tokenPattern.lastIndex, bodyEnd);

      const start = lineStartIndex(source, match.index);
      const environmentHighlight = {
        start,
        end: lineEndIndex(source, endMatch ? endMatch.index + endMatch[0].length : bodyEnd),
        firstLineEnd: lineEndIndex(source, start),
        kind: "environment"
      };

      if (base === "figure" || base === "table") {
        const context = base === "figure"
          ? figureByStart.get(match.index)
          : tableByStart.get(match.index);
        const number = context
          ? (base === "figure"
            ? latexContext?.figurePreviewNumber?.(source, context)
            : latexContext?.tablePreviewNumber?.(source, context))
          : null;
        if (number !== null && number !== undefined && String(number)) {
          badges.push({
            index: start,
            label: `${base === "figure" ? "Fig." : "Tab."} ${number}`
          });
        }
        highlights.push(environmentHighlight);
        continue;
      }

      highlights.push(environmentHighlight);
      const context = equationByStart.get(match.index);
      if (!context || !latexContext?.equationPreviewNumbering) continue;
      const completeContext = { ...context, source: source.slice(context.contentStart, context.contentEnd) };
      const numbering = latexContext.equationPreviewNumbering(source, completeContext);
      const values = (numbering?.numbers || []).map((number) => number?.value).filter(Boolean);
      if (!values.length) continue;
      const numberText = values.length > 1 ? `${values[0]}–${values[values.length - 1]}` : values[0];
      badges.push({ index: start, label: `Eqn. (${numberText})` });
    }

    for (const section of sectionTokens) {
      // A section highlight is deliberately limited to the command line itself.
      // Highlighting until the next peer section would tint nearly the entire document.
      highlights.push({
        start: section.start,
        end: lineEndIndex(source, section.start),
        firstLineEnd: lineEndIndex(source, section.start),
        kind: "section"
      });
    }

    appendCommandRanges(source, highlights, masked);
    return { badges, highlights };
  }

  function editorViewportBounds() {
    if (editorKind === "codemirror") {
      const root = editor?.dom || codeMirrorContent(editor)?.closest?.(".cm-editor");
      const scroller = editor?.scrollDOM || root?.querySelector?.(".cm-scroller");
      const rect = scroller?.getBoundingClientRect?.() || root?.getBoundingClientRect?.();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
    }
    const rect = editor?.renderer?.container?.getBoundingClientRect?.();
    return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
  }

  function editorScrollPosition() {
    const scroller = editorKind === "codemirror"
      ? (editor?.scrollDOM || editorRootElement()?.querySelector?.(".cm-scroller"))
      : (editor?.renderer?.scroller || editorRootElement()?.querySelector?.(".ace_scroller"));
    if (!scroller) return null;
    const left = Number(scroller.scrollLeft);
    const top = Number(scroller.scrollTop);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function editorViewportRight() {
    return editorViewportBounds()?.right || null;
  }

  function editorGutterBoundaryX() {
    const root = editorRootElement();
    if (!root) return null;

    // Place review move markers in the stable gutter/content boundary instead
    // of deriving x from range rectangles. Multiline ranges contain coalesced
    // rectangles whose left edge can be the full editor viewport, which made
    // the marker jump into the far-left gutter or appear as broken segments.
    if (editorKind === "codemirror") {
      const gutters = root.querySelector?.(".cm-gutters");
      const gutterRect = gutters?.getBoundingClientRect?.();
      if (gutterRect && gutterRect.width > 0) return gutterRect.right;
      const contentRect = codeMirrorContent(editor)?.getBoundingClientRect?.();
      return contentRect ? contentRect.left : null;
    }

    const gutter = root.querySelector?.(".ace_gutter");
    const gutterRect = gutter?.getBoundingClientRect?.();
    if (gutterRect && gutterRect.width > 0) return gutterRect.right;
    const scrollerRect = editor?.renderer?.scroller?.getBoundingClientRect?.();
    return scrollerRect ? scrollerRect.left : null;
  }

  function editorRangeRects(startValue, endValue) {
    const state = getEditorState();
    const source = String(state?.value || "");
    const start = Math.max(0, Math.min(Number(startValue) || 0, source.length));
    const end = Math.max(start, Math.min(Number(endValue) || start, source.length));
    const bounds = editorViewportBounds();
    const first = editorScreenPosition(start);
    if (!bounds || !first) return [];
    const firstX = first.pageX - window.scrollX;
    const firstY = first.pageY - window.scrollY;
    const firstHeight = Math.max(2, Number(first.lineHeight) || 16);
    if (end === start) {
      // A zero-width review anchor (for example a deletion or move origin)
      // must disappear completely when its source position is outside the
      // visible editor viewport. Clamping it to the viewport edge makes the
      // marker appear to "stick" to the top/bottom while the source text is
      // scrolled away.
      const rawLeft = firstX;
      const rawRight = firstX + 2;
      const rawTop = firstY;
      const rawBottom = firstY + firstHeight;
      if (
        rawRight <= bounds.left || rawLeft >= bounds.right ||
        rawBottom <= bounds.top || rawTop >= bounds.bottom
      ) {
        return [];
      }
      const rect = {
        left: Math.max(bounds.left, rawLeft),
        right: Math.min(bounds.right, rawRight),
        top: Math.max(bounds.top, rawTop),
        bottom: Math.min(bounds.bottom, rawBottom)
      };
      return rect.right > rect.left && rect.bottom > rect.top ? [rect] : [];
    }
    const last = editorScreenPosition(end);
    if (!last) return [];
    const lastX = last.pageX - window.scrollX;
    const lastY = last.pageY - window.scrollY;
    const lastHeight = Math.max(2, Number(last.lineHeight) || firstHeight);
    const sameVisualLine = Math.abs(firstY - lastY) < Math.max(firstHeight, lastHeight) * 0.5;
    const rects = [];
    const push = (left, top, right, bottom) => {
      const clipped = {
        left: Math.max(bounds.left, left), top: Math.max(bounds.top, top),
        right: Math.min(bounds.right, right), bottom: Math.min(bounds.bottom, bottom)
      };
      if (clipped.right > clipped.left && clipped.bottom > clipped.top) rects.push(clipped);
    };
    if (sameVisualLine) {
      push(firstX, firstY, Math.max(firstX + 2, lastX), firstY + firstHeight);
      return rects;
    }
    push(firstX, firstY, bounds.right, firstY + firstHeight);
    const middleTop = firstY + firstHeight;
    if (lastY > middleTop) push(bounds.left, middleTop, bounds.right, lastY);
    push(bounds.left, lastY, Math.max(bounds.left + 2, lastX), lastY + lastHeight);
    return rects;
  }

  function editorScreenPosition(index) {
    if (editorKind === "codemirror") return codeMirrorScreenPosition(index);
    const session = editor?.getSession?.();
    const position = session?.doc?.indexToPosition?.(index, 0);
    return aceScreenPosition(position);
  }

  function updateOverlayBounds(layer, bounds) {
    const localToEditor = (layer === structureHighlightLayer || layer === commentHighlightLayer) &&
      layer.parentElement === editorRootElement();
    const hostRect = localToEditor
      ? layer.parentElement.getBoundingClientRect()
      : { left: 0, top: 0 };
    layer.style.left = `${Math.round(bounds.left - hostRect.left)}px`;
    layer.style.top = `${Math.round(bounds.top - hostRect.top)}px`;
    layer.style.width = `${Math.max(0, Math.round(bounds.right - bounds.left))}px`;
    layer.style.height = `${Math.max(0, Math.round(bounds.bottom - bounds.top))}px`;
  }

  function shiftOverlayChildrenVertically(layer, threshold, delta, resizeCrossing = false) {
    if (!layer?.isConnected || !Number.isFinite(delta) || Math.abs(delta) < 0.5) return false;
    let changed = false;
    for (const child of layer.children) {
      const top = Number.parseFloat(child.style.top);
      const height = Number.parseFloat(child.style.height);
      if (!Number.isFinite(top)) continue;
      const bottom = top + (Number.isFinite(height) ? height : 0);
      if (top >= threshold - 0.5) {
        child.style.top = `${Math.round(top + delta)}px`;
        changed = true;
      } else if (resizeCrossing && Number.isFinite(height) && bottom > threshold + 0.5) {
        child.style.height = `${Math.max(1, Math.round(height + delta))}px`;
        changed = true;
      }
    }
    return changed;
  }

  function shiftMountedSourceOverlaysAfterScroll() {
    const current = editorScrollPosition();
    if (!current || !lastOverlayScrollPosition) {
      lastOverlayScrollPosition = current;
      return false;
    }
    const deltaY = current.top - lastOverlayScrollPosition.top;
    lastOverlayScrollPosition = current;
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 0.5) return false;
    const highlightsChanged = shiftOverlayChildrenVertically(
      structureHighlightLayer,
      -Infinity,
      -deltaY,
      false
    );
    const badgesChanged = shiftOverlayChildrenVertically(numberBadgeLayer, -Infinity, -deltaY, false);
    return highlightsChanged || badgesChanged;
  }

  function finishSourceOverlayPaint() {
    lastOverlayScrollPosition = editorScrollPosition();
    if (
      sourceOverlaysPending() &&
      lastEditorState &&
      cachedStructureSource === String(lastEditorState.value || "")
    ) setSourceOverlaysPending(false);
  }

  function editorRootElement() {
    if (editorKind === "codemirror") {
      return editor?.dom || editor?.contentDOM?.closest?.(".cm-editor") || null;
    }
    return editor?.container || document.querySelector(".ace_editor");
  }

  function opaqueEditorBackground() {
    const root = editorRootElement();
    const candidates = [
      root?.querySelector?.(".ace_scroller"),
      root?.querySelector?.(".ace_content"),
      root?.querySelector?.(".cm-scroller"),
      root,
      root?.parentElement,
      document.body
    ].filter(Boolean);
    for (const candidate of candidates) {
      const color = getComputedStyle(candidate).backgroundColor;
      const match = String(color || "").match(/^rgba?\(([^)]+)\)$/i);
      if (!match) continue;
      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      const alpha = parts.length > 3 ? parts[3] : 1;
      if (Number.isFinite(alpha) && alpha >= 0.98) return color;
    }
    return "rgb(255, 255, 255)";
  }

  function effectiveOverlaySurface(element) {
    if (!(element instanceof Element)) return null;
    // SmartTeX figure media contains class names such as "figure-popup-media".
    // Those transformed descendants are not independent occluding surfaces:
    // only the outer tooltip/list/dialog window covers editor highlights.
    const semanticSurface = element.closest?.(
      "[role='listbox'], [role='menu'], [role='dialog'], [role='tooltip']"
    );
    if (semanticSurface) return semanticSurface;
    return element;
  }

  const SMARTTEX_FLOATING_SELECTOR = "#smarttex-equation-preview,.smarttex-document-reference-popup,#smarttex-reference-autocomplete-popup,#smarttex-citation-popup,#smarttex-figure-autocomplete-popup,#smarttex-structure-hover-preview,#smarttex-review-change-popup,#smarttex-comment-selection-popup,.smarttex-label-guard-dialog,.smarttex-label-guard-preview";

  function isSmartTeXFloatingOverlay(element) {
    return Boolean(element?.closest?.(SMARTTEX_FLOATING_SELECTOR));
  }

  function nativeEditorOverlayRects(bounds) {
    const root = editorRootElement();
    if (!root) return [];
    const editorSelectors = [
      ".ace_search",
      ".cm-panel.cm-search",
      ".cm-search",
      "[class*='search-panel']",
      "[class*='searchPanel']"
    ];
    const pageOverlaySelectors = [
      "[role='listbox']",
      "[role='menu']",
      "[role='dialog']",
      "[role='tooltip']",
      "[class*='popover']",
      "[class*='popup']",
      "[class*='tooltip']",
      "[class*='spellcheck']",
      "[class*='suggestion']"
    ];
    const overlays = new Set();
    for (const selector of editorSelectors) {
      for (const element of root.querySelectorAll(selector)) overlays.add(element);
    }
    // Host-editor popovers, spelling suggestions, and browser-integrated menus
    // can be mounted outside the editor subtree. Treat every visible floating
    // UI element that intersects the editor as an exclusion region so the
    // source highlight remains a true background layer.
    for (const selector of pageOverlaySelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (element === root || root.contains(element)) continue;
        const surface = effectiveOverlaySurface(element);
        if (!surface || surface === root || root.contains(surface)) continue;
        overlays.add(surface);
      }
    }
    const result = [];
    for (const element of overlays) {
      // SmartTeX popups already paint above the source layer. Opening one must
      // not clip/rebuild the mounted environment rectangles underneath it.
      if (isSmartTeXFloatingOverlay(element)) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(bounds.left, rect.left - 2);
      const top = Math.max(bounds.top, rect.top - 2);
      const right = Math.min(bounds.right, rect.right + 2);
      const bottom = Math.min(bounds.bottom, rect.bottom + 2);
      if (right <= left || bottom <= top) continue;
      result.push({ left, top, right, bottom });
    }
    return result;
  }

  function subtractRect(rect, cutout) {
    if (!rectsOverlap(rect, cutout)) return [rect];
    const intersection = {
      left: Math.max(rect.left, cutout.left),
      top: Math.max(rect.top, cutout.top),
      right: Math.min(rect.right, cutout.right),
      bottom: Math.min(rect.bottom, cutout.bottom)
    };
    const pieces = [];
    if (intersection.top > rect.top) {
      pieces.push({ left: rect.left, top: rect.top, right: rect.right, bottom: intersection.top });
    }
    if (intersection.bottom < rect.bottom) {
      pieces.push({ left: rect.left, top: intersection.bottom, right: rect.right, bottom: rect.bottom });
    }
    if (intersection.left > rect.left) {
      pieces.push({ left: rect.left, top: intersection.top, right: intersection.left, bottom: intersection.bottom });
    }
    if (intersection.right < rect.right) {
      pieces.push({ left: intersection.right, top: intersection.top, right: rect.right, bottom: intersection.bottom });
    }
    return pieces.filter((piece) => piece.right > piece.left && piece.bottom > piece.top);
  }

  function visibleHighlightPieces(rect, overlayRects) {
    let pieces = [rect];
    for (const cutout of overlayRects) {
      pieces = pieces.flatMap((piece) => subtractRect(piece, cutout));
      if (!pieces.length) break;
    }
    return pieces;
  }

  function sourceHighlightBackground(highlight, color, normalAlpha, maximumAlpha, active, enabled, multiplier = 1) {
    const inactiveColor = enabled ? colorWithAlpha(color, normalAlpha) : "transparent";
    const activeColor = colorWithAlpha(color, activeAlpha(normalAlpha, maximumAlpha, true, enabled, multiplier));
    return { start: highlight.start, end: highlight.end, inactiveColor, activeColor, color: active ? activeColor : inactiveColor };
  }

  function updateMountedSourceHighlightActivity(layer, cursorIndex) {
    for (const child of layer?.children || []) {
      const activity = child.smarttexSourceHighlight;
      if (!activity) continue;
      const active = structureHighlightSettings.activeEnabled !== false && cursorIndex >= activity.start && cursorIndex < activity.end;
      const color = active ? activity.activeColor : activity.inactiveColor;
      if (child.style.background !== color) child.style.background = color;
    }
  }

  function appendHighlightRect(layer, bounds, rect, background, borderRadius, overlayRects) {
    for (const piece of visibleHighlightPieces(rect, overlayRects)) {
      const element = document.createElement("div");
      element.style.cssText = [
        "position:absolute",
        `left:${Math.round(piece.left - bounds.left)}px`,
        `top:${Math.round(piece.top - bounds.top)}px`,
        `width:${Math.max(1, Math.round(piece.right - piece.left))}px`,
        `height:${Math.max(1, Math.round(piece.bottom - piece.top))}px`,
        `background:${typeof background === "object" ? background.color : background}`,
        `border-radius:${borderRadius || "0"}`
      ].join(";");
      if (typeof background === "object") element.smarttexSourceHighlight = background;
      layer.appendChild(element);
    }
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function renderSourceNumberBadges(state = lastEditorState) {
    if (keyboardIdleDelay() > 0) return false;
    if (sourceOverlaysPending()) {
      // The pending flag stays up until a full viewport paint below succeeds.
      // Reusing the previous key would expose coordinates from before scrolling.
      lastStructurePaint = null;
    }
    const layer = ensureNumberBadgeLayer();
    const highlightLayer = ensureStructureHighlightLayer();
    if (!state || !editor || !highlightLayer) return false;
    const bounds = editorViewportBounds();
    if (!bounds || !Number.isFinite(bounds.right)) return false;
    const nativeOverlayRects = nativeEditorOverlayRects(bounds);
    const cursorIndex = Math.max(0, Number(state.cursorIndex) || 0);
    // Cursor-only transactions reuse the mounted rectangles. Include actual
    // source coordinates so scrolling, wrapping and folding still repaint.
    const positions = new Map();
    const screenPosition = (index) => {
      taskCheckpoint(positions.size, 16);
      if (!positions.has(index)) positions.set(index, editorScreenPosition(index));
      return positions.get(index);
    };
    const paintKey = JSON.stringify([
      bounds, window.scrollX, window.scrollY, nativeOverlayRects, structureHighlightSettings,
      cachedStructures.highlights.map((highlight) => [
        screenPosition(highlight.start), screenPosition(highlight.end),
        screenPosition(highlight.firstLineEnd ?? highlight.start)
      ]),
      cachedStructures.badges.map((badge) => screenPosition(badge.index))
    ]);
    if (lastStructurePaint?.structures === cachedStructures &&
        lastStructurePaint.layer === layer && lastStructurePaint.highlightLayer === highlightLayer &&
        lastStructurePaint.key === paintKey) {
      updateMountedSourceHighlightActivity(highlightLayer, cursorIndex);
      renderCommentOverlays();
      finishSourceOverlayPaint();
      return true;
    }
    const badgeFragment = document.createDocumentFragment();
    const highlightFragment = document.createDocumentFragment();
    updateOverlayBounds(layer, bounds);
    updateOverlayBounds(highlightLayer, bounds);

    for (let highlightIndex = 0; highlightIndex < cachedStructures.highlights.length; highlightIndex += 1) {
      taskCheckpoint(highlightIndex, 16);
      const highlight = cachedStructures.highlights[highlightIndex];
      const active = structureHighlightSettings.activeEnabled !== false &&
        cursorIndex >= Number(highlight.start || 0) &&
        cursorIndex < Number(highlight.end || highlight.start || 0);
      const start = screenPosition(highlight.start);
      const end = screenPosition(highlight.end);
      const firstLineEnd = screenPosition(highlight.firstLineEnd ?? highlight.start);
      if (!start || !end || !firstLineEnd) continue;
      const rawTop = start.pageY - window.scrollY;
      const rawBottom = end.pageY - window.scrollY + (end.lineHeight || start.lineHeight || 16);
      const top = Math.max(bounds.top, rawTop);
      const bottom = Math.min(bounds.bottom, rawBottom);
      if (bottom <= top) continue;

      if (highlight.kind === "environment") {
        const bodyEnabled = structureHighlightSettings.environmentEnabled !== false;
        const firstLineEnabled = structureHighlightSettings.environmentFirstLineEnabled !== false;
        const firstLineBottom = Math.min(
          bounds.bottom,
          firstLineEnd.pageY - window.scrollY +
            (firstLineEnd.lineHeight || start.lineHeight || 16)
        );

        if (firstLineBottom < bottom) {
          const bodyColor = bodyEnabled
            ? structureHighlightSettings.environmentColor
            : "#8b949e";
          appendHighlightRect(
            highlightFragment,
            bounds,
            { left: bounds.left, top: Math.max(top, firstLineBottom), right: bounds.right, bottom },
            sourceHighlightBackground(highlight, bodyColor, 0.18, 0.52, active, bodyEnabled, 3),
            "2px",
            nativeOverlayRects
          );
        }

        if (firstLineBottom > top) {
          const firstLineColor = firstLineEnabled
            ? structureHighlightSettings.environmentFirstLineColor
            : "#8b949e";
          appendHighlightRect(
            highlightFragment,
            bounds,
            { left: bounds.left, top, right: bounds.right, bottom: firstLineBottom },
            sourceHighlightBackground(highlight, firstLineColor, 0.34, 0.72, active, firstLineEnabled, 3),
            "2px",
            nativeOverlayRects
          );
        }
        continue;
      }

      if (highlight.kind === "section") {
        const categoryEnabled = structureHighlightSettings.sectionEnabled !== false;
        const baseColor = categoryEnabled
          ? structureHighlightSettings.sectionColor
          : "#8b949e";
        appendHighlightRect(
          highlightFragment,
          bounds,
          { left: bounds.left, top, right: bounds.right, bottom },
          sourceHighlightBackground(highlight, baseColor, 0.34, 0.72, active, categoryEnabled),
          "2px",
          nativeOverlayRects
        );
        continue;
      }

      const enabledKey = `${highlight.kind}Enabled`;
      const categoryEnabled = !(enabledKey in structureHighlightSettings) ||
        structureHighlightSettings[enabledKey] !== false;
      const baseColor = categoryEnabled
        ? (structureHighlightSettings[`${highlight.kind}Color`] || structureHighlightSettings.environmentColor)
        : "#8b949e";

      if (highlight.inline) {
        const startLineHeight = start.lineHeight || 16;
        const endLineHeight = end.lineHeight || startLineHeight;
        const sameLine = Math.abs(start.pageY - end.pageY) < startLineHeight * 0.5;
        const startLeft = Math.max(bounds.left, start.pageX - window.scrollX);
        const endRight = Math.min(bounds.right, end.pageX - window.scrollX);

        if (sameLine) {
          appendHighlightRect(
            highlightFragment,
            bounds,
            {
              left: startLeft,
              top,
              right: endRight,
              bottom: Math.min(bottom, top + startLineHeight)
            },
            sourceHighlightBackground(highlight, baseColor, 0.34, 0.74, active, categoryEnabled),
            "2px",
            nativeOverlayRects
          );
          continue;
        }

        const endLineTop = Math.max(bounds.top, end.pageY - window.scrollY);
        appendHighlightRect(
          highlightFragment,
          bounds,
          {
            left: startLeft,
            top,
            right: bounds.right,
            bottom: Math.min(bounds.bottom, top + startLineHeight)
          },
          sourceHighlightBackground(highlight, baseColor, 0.34, 0.74, active, categoryEnabled),
          "2px",
          nativeOverlayRects
        );

        const middleTop = top + startLineHeight;
        if (endLineTop > middleTop) {
          appendHighlightRect(
            highlightFragment,
            bounds,
            {
              left: bounds.left,
              top: middleTop,
              right: bounds.right,
              bottom: Math.min(bounds.bottom, endLineTop)
            },
            sourceHighlightBackground(highlight, baseColor, 0.24, 0.60, active, categoryEnabled),
            "2px",
            nativeOverlayRects
          );
        }

        appendHighlightRect(
          highlightFragment,
          bounds,
          {
            left: bounds.left,
            top: endLineTop,
            right: endRight,
            bottom: Math.min(bounds.bottom, endLineTop + endLineHeight)
          },
          sourceHighlightBackground(highlight, baseColor, 0.34, 0.74, active, categoryEnabled),
          "2px",
          nativeOverlayRects
        );
      }
    }

    // Highlight rectangles are geometrically clipped around native search
    // panels. The host panel keeps its own appearance and no covering mask or
    // forced background is needed.

    for (let badgeIndex = 0; badgeIndex < cachedStructures.badges.length; badgeIndex += 1) {
      taskCheckpoint(badgeIndex, 16);
      const badge = cachedStructures.badges[badgeIndex];
      const screen = screenPosition(badge.index);
      if (!screen || !Number.isFinite(screen.pageY)) continue;
      const top = screen.pageY - window.scrollY;
      const lineHeight = screen.lineHeight || 16;
      if (top + lineHeight < bounds.top || top > bounds.bottom) continue;
      const badgeRect = {
        left: bounds.right - 150,
        right: bounds.right,
        top,
        bottom: top + lineHeight
      };
      if (nativeOverlayRects.some((rect) => rectsOverlap(rect, badgeRect))) continue;
      const element = document.createElement("span");
      element.textContent = badge.label;
      // Keep source badges just inside the editor edge while aligning them with
      // the text row rather than slightly below its visual center.
      element.style.cssText = ["position:absolute", "right:16px", `top:${Math.round(top - bounds.top - 1)}px`, "padding:1px 4px", "border-radius:3px", "background:rgba(255,255,255,.72)", "color:#7b8493", "white-space:nowrap", "font-variant-numeric:tabular-nums"].join(";");
      badgeFragment.appendChild(element);
    }

    taskCheckpoint(0, 1);
    highlightLayer.replaceChildren(highlightFragment);
    layer.replaceChildren(badgeFragment);
    lastStructurePaint = { structures: cachedStructures, editor, layer, highlightLayer, key: paintKey };
    renderCommentOverlays();
    finishSourceOverlayPaint();
    return true;
  }

  function commentIconMarkup() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-8l-5 3v-3H5a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Z"/></svg>';
  }

  function markerIconMarkup() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 18 8.8-12.2 5.4 3.9L9.4 22H4v-4Z"/><path d="m13.8 4.4 1.8-2.5 5.4 3.9-1.8 2.5"/><path d="M2 22h20"/></svg>';
  }

  function appendCommentRange(fragment, bounds, anchor, nativeOverlayRects) {
    const start = editorScreenPosition(anchor.start);
    const end = editorScreenPosition(anchor.end);
    if (!start || !end) return null;
    const color = normalizedHighlightColor(anchor.color || "#268bd2");
    if (!commentMarksVisible) return end;
    const rawTop = start.pageY - window.scrollY;
    const rawBottom = end.pageY - window.scrollY + (end.lineHeight || start.lineHeight || 16);
    const top = Math.max(bounds.top, rawTop);
    const bottom = Math.min(bounds.bottom, rawBottom);
    if (bottom <= top) return end;
    const startLineHeight = start.lineHeight || 16;
    const endLineHeight = end.lineHeight || startLineHeight;
    const sameLine = Math.abs(start.pageY - end.pageY) < startLineHeight * 0.5;
    const startLeft = Math.max(bounds.left, start.pageX - window.scrollX);
    const endRight = Math.min(bounds.right, end.pageX - window.scrollX);
    const background = colorWithAlpha(color, commentMarkOpacity);
    if (sameLine) {
      appendHighlightRect(fragment, bounds, {
        left: startLeft, top, right: Math.max(startLeft + 2, endRight),
        bottom: Math.min(bottom, top + startLineHeight)
      }, background, "2px", nativeOverlayRects);
      return end;
    }
    const endLineTop = Math.max(bounds.top, end.pageY - window.scrollY);
    appendHighlightRect(fragment, bounds, {
      left: startLeft, top, right: bounds.right,
      bottom: Math.min(bounds.bottom, top + startLineHeight)
    }, background, "2px", nativeOverlayRects);
    const middleTop = top + startLineHeight;
    if (endLineTop > middleTop) {
      appendHighlightRect(fragment, bounds, {
        left: bounds.left, top: middleTop, right: bounds.right,
        bottom: Math.min(bounds.bottom, endLineTop)
      }, colorWithAlpha(color, Math.max(0.02, commentMarkOpacity * 0.78)), "2px", nativeOverlayRects);
    }
    appendHighlightRect(fragment, bounds, {
      left: bounds.left, top: endLineTop, right: Math.max(bounds.left + 2, endRight),
      bottom: Math.min(bounds.bottom, endLineTop + endLineHeight)
    }, background, "2px", nativeOverlayRects);
    return end;
  }

  function commentAnchorScreenVisible(screen, bounds, margin = 0) {
    if (!screen || !bounds) return false;
    const x = Number(screen.pageX) - window.scrollX;
    const y = Number(screen.pageY) - window.scrollY;
    const lineHeight = Math.max(1, Number(screen.lineHeight) || 16);
    return (
      x >= bounds.left - margin &&
      x <= bounds.right + margin &&
      y + lineHeight >= bounds.top - margin &&
      y <= bounds.bottom + margin
    );
  }

  function moveCommentIconAwayFromCaret(x, y, width, height, bounds) {
    const caretScreen = lastEditorState?.screen ||
      (Number.isFinite(Number(lastEditorState?.cursorIndex)) ? editorScreenPosition(lastEditorState.cursorIndex) : null);
    if (!caretScreen) return { x, y };
    const caretX = Number(caretScreen.pageX) - window.scrollX;
    const caretY = Number(caretScreen.pageY) - window.scrollY;
    const caretHeight = Math.max(2, Number(caretScreen.lineHeight) || 16);
    const near = (
      caretX >= x - 7 && caretX <= x + width + 7 &&
      caretY + caretHeight >= y - 5 && caretY <= y + height + 5
    );
    if (!near) return { x, y };

    const gap = 7;
    const left = x - width - gap;
    if (left >= bounds.left + 2) return { x: left, y };
    const right = x + width + gap;
    if (right + width <= bounds.right - 2) return { x: right, y };
    const above = y - height - gap;
    if (above >= bounds.top + 1) return { x, y: above };
    return { x, y: Math.min(bounds.bottom - height - 1, y + height + gap) };
  }

  function appendCommentIcon(fragment, bounds, nativeOverlayRects, anchor, screen, point = false, surfaceBackground = "rgb(255, 255, 255)") {
    if (!commentIconsVisible || !anchor.threadId || !screen || !commentAnchorScreenVisible(screen, bounds, 1)) return;
    const lineHeight = screen.lineHeight || 16;
    let x = Math.max(bounds.left + 2, Math.min(bounds.right - 21, screen.pageX - window.scrollX + (point ? -8 : 3)));
    let y = Math.max(bounds.top + 1, Math.min(bounds.bottom - 21, screen.pageY - window.scrollY - (point ? 20 : 15)));
    ({ x, y } = moveCommentIconAwayFromCaret(x, y, 20, 20, bounds));
    const rect = { left: x, top: y, right: x + 20, bottom: y + 20 };
    if (nativeOverlayRects.some((overlay) => rectsOverlap(rect, overlay))) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "smarttex-comment-anchor-icon";
    button.dataset.threadId = String(anchor.threadId);
    button.title = "Open comment";
    button.setAttribute("aria-label", "Open comment");
    button.innerHTML = commentIconMarkup();
    button.style.cssText = [
      "position:fixed", `left:${Math.round(x)}px`, `top:${Math.round(y)}px`,
      "width:20px", "height:20px", "padding:2px", "border:0", "border-radius:5px",
      `color:${normalizedHighlightColor(anchor.color || "#268bd2")}`,
      `background:${surfaceBackground}`, "box-shadow:0 1px 4px rgba(0,0,0,.18)",
      `opacity:${commentIconOpacity}`, "pointer-events:auto", "cursor:pointer"
    ].join(";");
    button.querySelector("svg").style.cssText = "width:16px;height:16px;fill:currentColor;stroke:currentColor;stroke-width:1.2";
    let handledAt = -Infinity;
    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(COMMENT_ANCHOR_ACTIVATE_EVENT, {
        detail: JSON.stringify({ threadId: String(anchor.threadId) })
      }));
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      handledAt = performance.now();
      activate(event);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() - handledAt < 750) return;
      activate(event);
    });
    fragment.appendChild(button);
  }

  function appendMarkerIcon(fragment, bounds, nativeOverlayRects, anchor, screen, surfaceBackground = "rgb(255, 255, 255)") {
    if (!commentIconsVisible || !anchor.markId || !screen || !commentAnchorScreenVisible(screen, bounds, 1)) return;
    const x = Math.max(bounds.left + 2, Math.min(bounds.right - 43, screen.pageX - window.scrollX + 3));
    const y = Math.max(bounds.top + 1, Math.min(bounds.bottom - 21, screen.pageY - window.scrollY - 15));
    const rect = { left: x, top: y, right: x + 43, bottom: y + 20 };
    if (nativeOverlayRects.some((overlay) => rectsOverlap(rect, overlay))) return;

    const group = document.createElement("span");
    group.className = "smarttex-marker-anchor-group";
    group.style.cssText = [
      "position:fixed", `left:${Math.round(x)}px`, `top:${Math.round(y)}px`,
      "height:20px", "display:flex", "align-items:center", "gap:2px",
      "pointer-events:auto"
    ].join(";");

    const makeButton = (className, title, markup, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.innerHTML = markup;
      button.style.cssText = [
        "width:20px", "height:20px", "padding:2px", "border:0", "border-radius:5px",
        `color:${normalizedHighlightColor(anchor.color || "#268bd2")}`,
        `background:${surfaceBackground}`, "box-shadow:0 1px 4px rgba(0,0,0,.18)",
        "cursor:pointer"
      ].join(";");
      const svg = button.querySelector("svg");
      if (svg) svg.style.cssText = "width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round";
      let handledAt = -Infinity;
      const dispatchAction = (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent(COMMENT_ANCHOR_ACTIVATE_EVENT, {
          detail: JSON.stringify({ markId: String(anchor.markId), action })
        }));
      };
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        // Act on the first physical press. CollabTeX can otherwise consume the
        // click while changing editor focus/caret state, which made removal seem
        // to require a second click.
        handledAt = performance.now();
        dispatchAction(event);
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() - handledAt < 750) return;
        dispatchAction(event);
      });
      return button;
    };

    const marker = makeButton("smarttex-marker-anchor-icon", "Remove marking", markerIconMarkup(), "toggle-mark");
    marker.style.opacity = String(commentIconOpacity);
    const convert = makeButton("smarttex-marker-to-comment-icon", "Turn marking into comment", commentIconMarkup(), "convert-to-comment");
    convert.style.transform = "translateX(-4px)";
    convert.style.transition = "opacity 90ms ease, transform 90ms ease";
    group.dataset.markId = String(anchor.markId);

    let hideTimer = 0;
    const markId = String(anchor.markId);
    const pointerInside = (
      lastPointerClientX >= x && lastPointerClientX <= x + 43 &&
      lastPointerClientY >= y && lastPointerClientY <= y + 20
    );
    if (pointerInside) markerConvertHoverUntil.set(markId, Date.now() + 1000);
    const setConvertVisible = (visible) => {
      convert.style.opacity = visible ? String(commentIconOpacity) : "0";
      convert.style.pointerEvents = visible ? "auto" : "none";
      convert.style.transform = visible ? "translateX(0)" : "translateX(-4px)";
    };
    setConvertVisible(pointerInside || Number(markerConvertHoverUntil.get(markId) || 0) > Date.now());

    const reveal = () => {
      window.clearTimeout(hideTimer);
      markerConvertHoverUntil.set(markId, Date.now() + 1000);
      setConvertVisible(true);
    };
    const keepAlive = () => {
      markerConvertHoverUntil.set(markId, Date.now() + 1000);
      setConvertVisible(true);
    };
    const hideLater = () => {
      markerConvertHoverUntil.set(markId, Date.now() + 1000);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (Number(markerConvertHoverUntil.get(markId) || 0) > Date.now()) return;
        setConvertVisible(false);
      }, 1010);
    };
    group.addEventListener("pointerenter", reveal);
    group.addEventListener("pointermove", keepAlive, { passive: true });
    group.addEventListener("pointerleave", hideLater);
    group.append(marker, convert);
    fragment.appendChild(group);
  }

  function renderCommentOverlays() {
    const highlightLayer = ensureCommentHighlightLayer();
    const iconLayer = ensureCommentIconLayer();
    if (!highlightLayer || !iconLayer || !editor) return;
    const bounds = editorViewportBounds();
    if (!bounds) return;
    updateOverlayBounds(highlightLayer, bounds);
    const nativeOverlayRects = nativeEditorOverlayRects(bounds);
    const highlights = document.createDocumentFragment();
    const icons = document.createDocumentFragment();
    const iconBackground = opaqueEditorBackground();
    for (const anchor of commentOverlayAnchors) {
      const startIndex = Math.max(0, Number(anchor?.start) || 0);
      const endIndex = Math.max(startIndex, Number(anchor?.end) || startIndex);
      const normalized = { ...anchor, start: startIndex, end: endIndex };
      if (endIndex > startIndex) {
        const endScreen = appendCommentRange(highlights, bounds, normalized, nativeOverlayRects);
        if (normalized.kind === "mark") {
          appendMarkerIcon(icons, bounds, nativeOverlayRects, normalized, endScreen, iconBackground);
        } else {
          appendCommentIcon(icons, bounds, nativeOverlayRects, normalized, endScreen, false, iconBackground);
        }
        continue;
      }
      if (!normalized.threadId) continue;
      const screen = editorScreenPosition(startIndex);
      if (!screen || !commentAnchorScreenVisible(screen, bounds, 1)) continue;
      const x = Math.max(bounds.left, Math.min(bounds.right - 3, screen.pageX - window.scrollX));
      const y = Math.max(bounds.top, screen.pageY - window.scrollY);
      const bottom = Math.min(bounds.bottom, y + (screen.lineHeight || 16));
      if (commentMarksVisible && bottom > y) {
        appendHighlightRect(highlights, bounds, {
          left: x, top: y, right: Math.min(bounds.right, x + 4), bottom
        }, colorWithAlpha(normalizedHighlightColor(normalized.color || "#268bd2"), commentMarkOpacity), "2px", nativeOverlayRects);
      }
      appendCommentIcon(icons, bounds, nativeOverlayRects, normalized, screen, true, iconBackground);
    }
    highlightLayer.replaceChildren(highlights);
    iconLayer.replaceChildren(icons);
  }

  function scheduleOverlayRender() {
    if (interactionTasks?.isScrolling?.()) return;
    const idleDelay = keyboardIdleDelay();
    if (idleDelay > 0) {
      if (overlayIdleTimer) return;
      overlayIdleTimer = window.setTimeout(() => {
        overlayIdleTimer = 0;
        scheduleOverlayRender();
      }, idleDelay);
      return;
    }
    if (overlayFramePending) return;
    overlayFramePending = true;
    overlayFrameId = window.requestAnimationFrame(() => {
      overlayFramePending = false;
      overlayFrameId = 0;
      if (interactionTasks?.isScrolling?.()) return;
      try {
        const painted = interactionTasks?.runSync
          ? interactionTasks.runSync("source-overlay-render", () => renderSourceNumberBadges())
          : renderSourceNumberBadges();
        if (structureAnalysisActive) {
          if (painted) {
            // Keep the global S-button spinner active through the paint in which
            // the freshly computed badges/highlights first become visible.
            window.requestAnimationFrame(() => setStructureAnalysisState(false));
          } else {
            // The editor shell can exist before its viewport is measurable. Do
            // not declare structure hydration complete until an actual overlay
            // paint has succeeded.
            window.setTimeout(() => {
              if (structureAnalysisActive) scheduleOverlayRender();
            }, 120);
          }
        }
      } catch (error) {
        if (interactionTasks?.isAbortError?.(error)) {
          setStructureAnalysisState(false);
          return;
        }
        setStructureAnalysisState(false);
        console.warn("SmartTeX source overlay rendering failed:", error);
      }
    });
  }

  function nodeContainsOccludingOverlay(node) {
    if (!(node instanceof Element)) return false;
    if (isSmartTeXFloatingOverlay(node)) return false;
    if (node.matches?.(OCCLUDING_OVERLAY_SELECTOR)) return true;
    return [...node.querySelectorAll(OCCLUDING_OVERLAY_SELECTOR)].some(element => !isSmartTeXFloatingOverlay(element));
  }

  function occludingOverlayMutation(mutation) {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
    if (isSmartTeXFloatingOverlay(target) || target?.closest?.(
      "#smarttex-source-structure-highlights, #smarttex-source-number-badges"
    )) return false;
    if (mutation.type === "attributes") {
      if (!target?.matches?.(OCCLUDING_OVERLAY_SELECTOR)) return false;
      // Ignore attribute churn inside an already-detected popup, such as zoom
      // state or selected-row classes. Only the outer occluding surface changes
      // whether source highlights need to be clipped or restored.
      return !target.parentElement?.closest?.(OCCLUDING_OVERLAY_SELECTOR);
    }
    return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsOccludingOverlay);
  }

  // Highlight rectangles are clipped around visible menus and popups. Repaint
  // the cached geometry whenever such an overlay opens or closes so the source
  // colour is restored immediately after the overlay disappears.
  const overlayOcclusionObserver = new MutationObserver((mutations) => {
    if (!mutations.some(occludingOverlayMutation)) return;
    if (keyboardIdleDelay() > 0) {
      scheduleOverlayRender();
      return;
    }
    scheduleOverlayRender();
  });
  overlayOcclusionObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "style", "open", "aria-hidden"]
  });

  function refreshStructureCache(state, immediate = false) {
    lastEditorState = state || lastEditorState;
    if (!lastEditorState) return;
    const source = lastEditorState.value;
    if (source === cachedStructureSource) {
      if (!sourceOverlaysPending() && lastStructurePaint?.structures === cachedStructures && lastStructurePaint.editor === editor) {
        updateMountedSourceHighlightActivity(structureHighlightLayer, Math.max(0, Number(lastEditorState.cursorIndex) || 0));
      } else scheduleOverlayRender();
      return;
    }
    window.clearTimeout(structureRefreshTimer);
    const update = () => {
      structureRefreshTimer = 0;
      if (!lastEditorState) return;
      const sourceAtStart = lastEditorState.value;
      if (interactionTasks?.canRunLongTask &&
          !interactionTasks.canRunLongTask(lastEditorState, sourceAtStart.length)) {
        setStructureAnalysisState(false);
        window.clearTimeout(structureRefreshTimer);
        structureRefreshTimer = window.setTimeout(
          () => refreshStructureCache(lastEditorState, false),
          Math.max(80, keyboardIdleDelay())
        );
        return;
      }
      let readyForOverlayPaint = false;
      setStructureAnalysisState(true);
      try {
        const nextStructures = interactionTasks?.runSync
          ? interactionTasks.runSync(
              "structure-highlight-analysis",
              () => sourceNumberBadges(sourceAtStart)
            )
          : sourceNumberBadges(sourceAtStart);
        if (lastEditorState?.value !== sourceAtStart) return;
        cachedStructureSource = sourceAtStart;
        cachedStructures = nextStructures;
        readyForOverlayPaint = true;
        scheduleOverlayRender();
      } catch (error) {
        if (interactionTasks?.isAbortError?.(error)) {
          structureRefreshTimer = window.setTimeout(
            () => refreshStructureCache(lastEditorState, false),
            180
          );
          return;
        }
        console.warn("SmartTeX structure highlighting failed without disabling previews:", error);
      } finally {
        // Successful analyses stay pending until scheduleOverlayRender() has
        // painted their new badges/highlights. Aborted, stale, or failed runs
        // must clear the spinner immediately so a retry cannot leave it latched.
        if (!readyForOverlayPaint) setStructureAnalysisState(false);
      }
    };
    if (immediate || cachedStructureSource === null || sourceOverlaysPending()) update();
    else structureRefreshTimer = window.setTimeout(update, 140);
  }

  interactionTasks?.subscribe?.((activity) => {
    if (activity?.reason !== "pointer") {
      window.clearTimeout(stateTimer);
      stateTimer = 0;
      scheduledState = false;
      stateScheduleRevision += 1;
      pointerStateFrame = 0;
    }
    window.clearTimeout(structureRefreshTimer);
    structureRefreshTimer = 0;
    window.clearTimeout(overlayIdleTimer);
    overlayIdleTimer = 0;
    window.clearTimeout(editorDiscoveryTimer);
    editorDiscoveryTimer = 0;
    if (overlayFrameId) window.cancelAnimationFrame(overlayFrameId);
    overlayFrameId = 0;
    overlayFramePending = false;
    // The editor's own input/selection listeners schedule the single post-idle
    // state refresh. Do not create replacement timers inside the capture-phase
    // cancellation path; emitState() also restores any cancelled overlay paint.
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
    if (detail.active === true) {
      // Review hydration can rewrite/re-anchor tracked text after the first
      // editor snapshot. Keep the structure lifecycle pending until that work
      // has settled.
      setStructureAnalysisState(true);
      return;
    }

    // Always make one authoritative structure pass after review hydration.
    // This decouples section/environment badges from the earlier bootstrap
    // editor buffer and fixes reloads with Track Changes already enabled.
    const state = getEditorState();
    if (state) {
      lastEditorState = state;
      cachedStructureSource = null;
      refreshStructureCache(state, true);
    } else {
      setStructureAnalysisState(true);
      scheduleState();
    }
  });

  window.addEventListener("smarttex:editor-scroll-state", (event) => {
    if (event?.detail?.active === true) {
      setSourceOverlaysPending(true);
      return;
    }
    if (event?.detail?.active !== false || textInputIsActive()) return;
    // Reconcile scroll geometry only after scrolling and typing have settled.
    shiftMountedSourceOverlaysAfterScroll();
    scheduleOverlayRender();
    scheduleState();
  });

  window.addEventListener(
    interactionTasks?.keyboardIdleEventName || "smarttex:keyboard-idle",
    () => {
      // Keep the fade gate closed until the new source and viewport are painted.
      scheduleState();
      scheduleOverlayRender();
    }
  );

  window.addEventListener("smarttex:structure-highlight-settings", (event) => {
    const detail = event?.detail || {};
    structureHighlightSettings = {
      ...structureHighlightSettings,
      ...detail,
      environmentEnabled: detail.environmentEnabled !== undefined
        ? detail.environmentEnabled !== false
        : (detail.enabled !== undefined
          ? detail.enabled !== false
          : structureHighlightSettings.environmentEnabled),
      environmentColor: normalizedHighlightColor(detail.environmentColor || detail.color || structureHighlightSettings.environmentColor),
      environmentFirstLineEnabled: detail.environmentFirstLineEnabled !== undefined
        ? detail.environmentFirstLineEnabled !== false
        : structureHighlightSettings.environmentFirstLineEnabled,
      environmentFirstLineColor: normalizedHighlightColor(
        detail.environmentFirstLineColor || structureHighlightSettings.environmentFirstLineColor
      ),
      sectionEnabled: detail.sectionEnabled !== undefined
        ? detail.sectionEnabled !== false
        : structureHighlightSettings.sectionEnabled,
      sectionColor: normalizedHighlightColor(
        detail.sectionColor || structureHighlightSettings.sectionColor
      ),
      captionColor: normalizedHighlightColor(detail.captionColor || structureHighlightSettings.captionColor),
      labelColor: normalizedHighlightColor(detail.labelColor || structureHighlightSettings.labelColor),
      referenceColor: normalizedHighlightColor(detail.referenceColor || structureHighlightSettings.referenceColor),
      nonumberColor: normalizedHighlightColor(detail.nonumberColor || structureHighlightSettings.nonumberColor),
      inlineMathColor: normalizedHighlightColor(detail.inlineMathColor || structureHighlightSettings.inlineMathColor),
      activeEnabled: detail.activeEnabled !== undefined
        ? detail.activeEnabled !== false
        : structureHighlightSettings.activeEnabled,
      activeStrength: boundedPercent(detail.activeStrength, structureHighlightSettings.activeStrength)
    };
    scheduleOverlayRender();
  });

  function looksLikeCodeMirrorView(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      value.state?.doc &&
      typeof value.state.doc.toString === "function" &&
      typeof value.dispatch === "function"
    );
  }

  function discoverCodeMirrorView(value, depth = 0, seen = new Set()) {
    if (!value || depth > 3 || (typeof value !== "object" && typeof value !== "function")) {
      return null;
    }
    if (looksLikeCodeMirrorView(value)) return value;
    if (seen.has(value)) return null;
    seen.add(value);

    const preferredKeys = [
      "view",
      "editorView",
      "cmView",
      "editor",
      "_view",
      "rootView",
      "docView"
    ];
    for (const key of preferredKeys) {
      try {
        const found = discoverCodeMirrorView(value[key], depth + 1, seen);
        if (found) return found;
      } catch (_error) {
        // Framework-owned properties may use guarded accessors.
      }
    }

    if (depth >= 2) return null;
    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(value).slice(0, 80);
    } catch (_error) {
      return null;
    }
    for (const key of keys) {
      if (preferredKeys.includes(key)) continue;
      try {
        const found = discoverCodeMirrorView(value[key], depth + 1, seen);
        if (found) return found;
      } catch (_error) {
        // Continue with the next discoverable property.
      }
    }
    return null;
  }

  function findCodeMirrorEditor() {
    const roots = [
      document.querySelector("#ide-redesign-panel-source-editor .cm-editor"),
      document.querySelector(".ide-redesign-editor-container .cm-editor"),
      document.querySelector(".cm-editor")
    ].filter(Boolean);

    for (const root of roots) {
      const content = root.querySelector(".cm-content");
      const candidates = [
        root.cmView?.view,
        root.cmView,
        root.editorView,
        root.view,
        content?.cmView?.view,
        content?.cmView,
        content?.editorView,
        content?.view
      ];
      for (const candidate of candidates) {
        if (looksLikeCodeMirrorView(candidate)) return candidate;
      }
      const discovered = discoverCodeMirrorView(content || root);
      if (discovered) return discovered;
    }
    return null;
  }

  function findAceEditor() {
    const candidates = [
      document.querySelector("#editor .ace_editor:not(.ace_autocomplete)"),
      document.querySelector("#editor.ace_editor"),
      document.querySelector(".ace-editor-body.ace_editor:not(.ace_autocomplete)")
    ].filter(Boolean);

    for (const element of candidates) {
      if (element.env?.editor) return element.env.editor;
      if (window.ace?.edit) {
        try {
          return window.ace.edit(element);
        } catch (_error) {
          // The next element may be the actual editor.
        }
      }
    }
    return null;
  }

  function findEditor() {
    const codeMirror = findCodeMirrorEditor();
    if (codeMirror) return { kind: "codemirror", editor: codeMirror };
    const ace = findAceEditor();
    return ace ? { kind: "ace", editor: ace } : null;
  }

  function selectedFileName() {
    const selected = document.querySelector(
      '.file-tree-list [role="treeitem"][aria-selected="true"], ' +
      '.file-tree-list li.selected[role="treeitem"]'
    );
    const fileName = (
      selected?.getAttribute("aria-label") ||
      selected?.querySelector(".item-name-button span")?.textContent ||
      selected?.querySelector(".item-name span")?.textContent ||
      selected?.querySelector(".entity-name span")?.textContent ||
      ""
    ).trim();
    if (fileName) return fileName;

    const breadcrumb = document.querySelector(".ol-cm-breadcrumbs > div");
    return breadcrumb?.textContent?.trim() || "";
  }

  function normalizedProjectPath(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      .replace(/\/+/g, "/")
      .toLowerCase();
  }

  function pathStem(value) {
    return normalizedProjectPath(value).replace(/\.[a-z0-9]{1,8}$/i, "");
  }

  function projectPathMatches(leftValue, rightValue) {
    const left = normalizedProjectPath(leftValue);
    const right = normalizedProjectPath(rightValue);
    if (!left || !right) return false;
    const leftName = left.split("/").pop();
    const rightName = right.split("/").pop();
    return (
      left === right ||
      leftName === rightName ||
      pathStem(left) === pathStem(right) ||
      pathStem(leftName) === pathStem(rightName)
    );
  }

  function treeItemPath(item) {
    return String(
      item?.getAttribute("data-path") ||
      item?.getAttribute("data-file-path") ||
      item?.getAttribute("aria-label") ||
      item?.querySelector(
        ".item-name-button span, .item-name span, .entity-name span, [data-testid*='file-name']"
      )?.textContent ||
      ""
    ).trim();
  }

  function treeItemProjectPath(item) {
    const explicit = String(
      item?.getAttribute("data-path") ||
      item?.getAttribute("data-file-path") ||
      ""
    ).trim();
    if (explicit.includes("/") || explicit.includes("\\")) return explicit;
    const ownName = explicit || treeItemPath(item);
    if (!ownName || ownName.includes("/")) return ownName;
    const segments = [ownName];
    let parentItem = item?.parentElement?.closest?.('[role="treeitem"]') || null;
    while (parentItem) {
      const parentPath = treeItemPath(parentItem).replace(/\\/g, "/").replace(/\/+$/, "");
      if (parentPath) {
        if (parentPath.includes("/")) return `${parentPath}/${segments.join("/")}`;
        segments.unshift(parentPath);
      }
      parentItem = parentItem.parentElement?.closest?.('[role="treeitem"]') || null;
    }
    return segments.join("/");
  }

  function treeItemVisualIndent(item) {
    const content = item?.querySelector?.(
      ".item-name-button, .item-name, .entity-name, [data-testid*='file-name']"
    ) || item;
    const rectLeft = Number(content?.getBoundingClientRect?.().left);
    if (Number.isFinite(rectLeft) && rectLeft > 0) return rectLeft;
    let indent = 0;
    for (const element of [item, content]) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) continue;
      const style = getComputedStyle(element);
      indent += Number.parseFloat(style.paddingLeft) || 0;
      indent += Number.parseFloat(style.marginLeft) || 0;
    }
    return indent;
  }

  function treeItemIsFolder(item, name) {
    if (!item || FIGURE_FILE_PATTERN.test(String(name || ""))) return false;
    return (
      item.hasAttribute("aria-expanded") ||
      /(?:^|[\s_-])folder(?:[\s_-]|$)/i.test(String(item.className || "")) ||
      Boolean(item.querySelector(
        "[class*='folder' i], [data-testid*='folder' i], " +
        "[aria-label*='folder' i], [aria-label*='expand' i], [aria-label*='collapse' i]"
      ))
    );
  }

  function likelyFileId(value) {
    const text = String(value || "").trim();
    if (/^[a-f0-9]{24}$/i.test(text) || /^[a-f0-9-]{32,40}$/i.test(text)) {
      return text;
    }
    const embedded = text.match(/[a-f0-9]{24}/i)?.[0];
    return embedded || "";
  }

  function textFromProjectEntity(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return "";
    }
    const candidates = [];
    try {
      candidates.push(
        value.lines,
        value.content,
        value.text,
        value.source,
        value.doc?.lines,
        value.doc?.content,
        value.doc?.text,
        value.document?.lines,
        value.document?.content,
        value.document?.text
      );
    } catch (_error) {
      return "";
    }
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.every((line) => typeof line === "string")) {
        return candidate.join("\n");
      }
      if (typeof candidate === "string" && candidate.length) return candidate;
      if (candidate && typeof candidate.toString === "function") {
        const typeName = String(candidate.constructor?.name || "");
        if (!/(?:Text|Doc|Rope|Content)/i.test(typeName)) continue;
        try {
          const text = candidate.toString();
          if (typeof text === "string" && text && text !== "[object Object]") return text;
        } catch (_error) {
          // Continue with the remaining representations.
        }
      }
    }
    return "";
  }

  function entityFromReactValue(root, targetPath) {
    const seen = new Set();
    const budget = { remaining: 5000 };
    const visit = (value, depth) => {
      if (
        !value ||
        depth > 8 ||
        budget.remaining-- <= 0 ||
        (typeof value !== "object" && typeof value !== "function") ||
        seen.has(value)
      ) {
        return null;
      }
      seen.add(value);
      let name = "";
      let id = "";
      let url = "";
      try {
        name = value.path || value.filePath || value.name || value.fileName || "";
        id = (
          value._id ||
          value.fileId ||
          value.entityId ||
          value.id ||
          value.file?._id ||
          value.entity?._id ||
          ""
        );
        url = value.downloadUrl || value.downloadURL || value.url || "";
      } catch (_error) {
        // Continue through accessible child properties.
      }
      if (projectPathMatches(name, targetPath)) {
        const fileId = likelyFileId(id);
        const text = textFromProjectEntity(value);
        let entityType = "";
        try {
          entityType = String(
            value.type || value.kind || value.entityType || value._type || ""
          );
        } catch (_error) {
          // Type metadata is optional.
        }
        if (fileId || url || text) {
          return { fileId, url: String(url || ""), text, entityType };
        }
      }

      let keys = [];
      try {
        keys = Object.getOwnPropertyNames(value).slice(0, 120);
      } catch (_error) {
        return null;
      }
      const preferred = [
        "file",
        "entity",
        "item",
        "node",
        "data",
        "props",
        "memoizedProps",
        "pendingProps",
        "memoizedState",
        "children",
        "rootFolder",
        "child",
        "sibling"
      ];
      keys.sort((left, right) => (
        (
          preferred.indexOf(left) < 0
            ? preferred.length
            : preferred.indexOf(left)
        ) - (
          preferred.indexOf(right) < 0
            ? preferred.length
            : preferred.indexOf(right)
        )
      ));
      for (const key of keys) {
        if (["window", "ownerDocument", "parentNode"].includes(key)) continue;
        try {
          const found = visit(value[key], depth + 1);
          if (found) return found;
        } catch (_error) {
          // React-owned properties can contain guarded accessors.
        }
      }
      return null;
    };
    return visit(root, 0);
  }

  function visibleProjectFile(targetPath) {
    const items = [...document.querySelectorAll('.file-tree-list [role="treeitem"]')];
    const normalizedTarget = normalizedProjectPath(targetPath);
    return items.find((candidate) => (
      normalizedProjectPath(treeItemPath(candidate)) === normalizedTarget
    )) || items.find((candidate) => (
      projectPathMatches(treeItemPath(candidate), targetPath)
    )) || null;
  }

  function reactProjectFile(targetPath, item = null) {
    const roots = [
      item,
      item?.closest(".file-tree-list"),
      document.querySelector(".file-tree-list"),
      document.querySelector("#ide-root"),
      document.querySelector("[data-testid='ide-root']")
    ].filter(Boolean);
    for (const root of roots) {
      const reactKeys = Object.getOwnPropertyNames(root).filter((key) => (
        /^__(?:react|preact|vue)/i.test(key) || /fiber|props/i.test(key)
      ));
      for (const key of reactKeys) {
        const entity = entityFromReactValue(root[key], targetPath);
        if (entity) return entity;
      }
    }
    const globalNames = Object.getOwnPropertyNames(window).filter((key) => (
      /^(?:project|ide|editor|fileTree|fileStore|rootFolder)$/i.test(key) ||
      /^OLProject/i.test(key)
    ));
    for (const key of globalNames) {
      try {
        const entity = entityFromReactValue(window[key], targetPath);
        if (entity) return entity;
      } catch (_error) {
        // Some page globals expose guarded accessors.
      }
    }
    return null;
  }

  function selectedDocumentId() {
    const fileName = selectedFileName();
    if (
      selectedDocumentCache.fileName === fileName &&
      Date.now() - selectedDocumentCache.at < 1500
    ) {
      return selectedDocumentCache.documentId;
    }
    const item = document.querySelector(
      '.file-tree-list [role="treeitem"][aria-selected="true"], ' +
      '.file-tree-list li.selected[role="treeitem"]'
    );
    const entity = fileName ? reactProjectFile(fileName, item) : null;
    const documentId = likelyFileId(
      item?.getAttribute?.("data-doc-id") ||
      item?.getAttribute?.("data-document-id") ||
      item?.getAttribute?.("data-file-id") ||
      item?.getAttribute?.("data-entity-id") ||
      item?.getAttribute?.("data-id") ||
      item?.id ||
      entity?.fileId ||
      ""
    );
    selectedDocumentCache = { fileName, documentId, at: Date.now() };
    return documentId;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function revealProjectFile(targetPath) {
    let item = visibleProjectFile(targetPath);
    if (item) return item;
    for (let pass = 0; pass < 4; pass += 1) {
      const collapsedItems = [...document.querySelectorAll(
        '.file-tree-list [role="treeitem"][aria-expanded="false"]'
      )];
      const expandButtons = collapsedItems.map((collapsed) => (
        collapsed.querySelector(
          'button[aria-label*="Expand" i], button[title*="Expand" i], ' +
          '[data-testid*="expand"]'
        )
      )).filter(Boolean);
      if (!expandButtons.length) break;
      for (const button of expandButtons) button.click();
      await delay(120);
      item = visibleProjectFile(targetPath);
      if (item) return item;
    }
    return null;
  }

  async function resolveProjectFile(pathValue) {
    const targetPath = String(pathValue || "").trim();
    if (!targetPath) return null;
    let item = visibleProjectFile(targetPath);
    let reactEntity = reactProjectFile(targetPath, item);
    if (!item && !reactEntity) {
      item = await revealProjectFile(targetPath);
      reactEntity = reactProjectFile(targetPath, item);
    }
    const explicit = (
      item?.getAttribute("data-download-url") ||
      item?.getAttribute("data-url") ||
      item?.querySelector("a[href]")?.href ||
      ""
    ).trim();
    if (explicit) {
      return {
        url: new URL(explicit, window.location.href).href,
        path: treeItemPath(item),
        text: reactEntity?.text || "",
        entityType: reactEntity?.entityType || ""
      };
    }
    const attributeId = likelyFileId(
      item?.getAttribute("data-file-id") ||
      item?.getAttribute("data-entity-id") ||
      item?.getAttribute("data-id") ||
      item?.getAttribute("data-rbd-draggable-id") ||
      item?.id ||
      ""
    );
    const fileId = attributeId || reactEntity?.fileId || "";
    const explicitReactUrl = String(reactEntity?.url || "").trim();
    if (explicitReactUrl) {
      return {
        url: new URL(explicitReactUrl, window.location.href).href,
        fileId,
        path: treeItemPath(item) || targetPath,
        text: reactEntity?.text || "",
        entityType: reactEntity?.entityType || ""
      };
    }
    const projectId = window.location.pathname.match(/\/project\/([^/?#]+)/i)?.[1] || "";
    if (!projectId || !fileId) {
      return reactEntity?.text ? {
        url: "",
        fileId,
        path: treeItemPath(item) || targetPath,
        text: reactEntity.text,
        entityType: reactEntity.entityType || ""
      } : null;
    }
    return {
      url: `${window.location.origin}/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`,
      fileId,
      path: treeItemPath(item) || targetPath,
      text: reactEntity?.text || "",
      entityType: reactEntity?.entityType || ""
    };
  }

  function projectModelRoots() {
    const roots = [
      document.querySelector(".file-tree-list"),
      document.querySelector("#ide-root"),
      document.querySelector("[data-testid='ide-root']")
    ].filter(Boolean);
    for (const root of [...roots]) {
      if (!(root instanceof Element)) continue;
      for (const key of Object.getOwnPropertyNames(root).filter((name) => (
        /^__(?:react|preact|vue)/i.test(name) || /fiber|props/i.test(name)
      ))) {
        try { roots.push(root[key]); } catch (_error) { /* optional framework internals */ }
      }
    }
    for (const key of Object.getOwnPropertyNames(window).filter((name) => (
      /^(?:project|ide|editor|fileTree|fileStore|rootFolder)$/i.test(name) || /^OLProject/i.test(name)
    ))) {
      try { roots.push(window[key]); } catch (_error) { /* guarded globals */ }
    }
    return roots;
  }

  function looksLikeCollaborationSocket(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
    try {
      return Boolean(
        typeof value.on === "function" &&
        typeof value.emit === "function" &&
        (typeof value.removeListener === "function" || typeof value.off === "function") &&
        value.socket &&
        typeof value.socket === "object" &&
        (
          "publicId" in value ||
          typeof value.socket.sessionid === "string" ||
          typeof value.socket.connect === "function"
        )
      );
    } catch (_error) {
      return false;
    }
  }

  function cleanCollabtexIdentityName(value) {
    const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name || /^anonymous$/i.test(name) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) return "";
    return name;
  }

  function collabtexDisplayName(record) {
    if (!record || typeof record !== "object") return "";
    const first = String(record.first_name || record.firstName || "").trim();
    const last = String(record.last_name || record.lastName || "").trim();
    const combined = cleanCollabtexIdentityName(`${first} ${last}`);
    if (combined) return combined;
    for (const key of ["display_name", "displayName", "full_name", "fullName", "name"]) {
      const candidate = cleanCollabtexIdentityName(record[key]);
      if (candidate) return candidate;
    }
    for (const key of ["user", "profile", "userInfo", "user_info", "cursorData"]) {
      const candidate = collabtexDisplayName(record[key]);
      if (candidate) return candidate;
    }
    return "";
  }

  function socketIdentityIds(socket) {
    return new Set([
      socket?.publicId, socket?.id, socket?.socket?.id, socket?.socket?.sessionid
    ].map((value) => String(value || "")).filter(Boolean));
  }

  function recordIdentityIds(record) {
    if (!record || typeof record !== "object") return [];
    return [record.client_id, record.clientId, record.id, record.publicId, record.socket_id, record.socketId]
      .map((value) => String(value || "")).filter(Boolean);
  }

  function findLocalCollabtexUser(users, socket) {
    if (!Array.isArray(users) || !users.length) return null;
    const ownIds = socketIdentityIds(socket);
    for (const user of users) {
      if (!user || typeof user !== "object") continue;
      if (user.isSelf === true || user.self === true || user.isCurrentUser === true || user.current === true) {
        if (collabtexDisplayName(user)) return user;
      }
      if (recordIdentityIds(user).some((id) => ownIds.has(id)) && collabtexDisplayName(user)) return user;
    }
    return null;
  }

  function publishLocalCollabtexIdentity(record) {
    const name = collabtexDisplayName(record);
    if (!name || name === lastCollabtexIdentityName) return false;
    lastCollabtexIdentityName = name;
    window.dispatchEvent(new CustomEvent(COLLABTEX_IDENTITY_EVENT, {
      detail: JSON.stringify({
        name,
        userId: String(record?.user_id || record?.userId || record?.user?._id || record?.user?.id || "")
      })
    }));
    return true;
  }

  function parseCollabtexIdentityPayload(value) {
    if (!value) return null;
    if (typeof value === "object") return value;
    const text = String(value || "").trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_error) { return null; }
  }

  function explicitCurrentUserRoots() {
    const roots = [];
    const push = (value) => { if (value && (typeof value === "object" || typeof value === "string")) roots.push(value); };
    for (const value of [
      globalThis.currentUser,
      globalThis.user,
      globalThis.userInfo,
      globalThis.user_info,
      globalThis.OL?.currentUser,
      globalThis.OL?.user,
      globalThis.OL?.userInfo,
      globalThis.OL?.user_info,
      globalThis.__INITIAL_STATE__?.currentUser,
      globalThis.__INITIAL_STATE__?.user,
      globalThis.__PRELOADED_STATE__?.currentUser,
      globalThis.__PRELOADED_STATE__?.user,
      globalThis.__NEXT_DATA__?.props?.pageProps?.currentUser,
      globalThis.__NEXT_DATA__?.props?.pageProps?.user
    ]) push(value);

    for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
      for (const key of ["ol-user", "ol-current-user", "currentUser"]) {
        try { push(store?.getItem?.(key)); } catch (_error) {}
      }
    }

    for (const selector of [
      'meta[name="ol-user"]',
      'meta[name="ol-current-user"]',
      'meta[name="ol-userInfo"]',
      'meta[name="ol-user-info"]',
      '[data-ol-user]',
      '[data-current-user]',
      'script#ol-user[type="application/json"]',
      'script[data-ol-user][type="application/json"]'
    ]) {
      for (const node of document.querySelectorAll?.(selector) || []) {
        push(node.getAttribute?.("content"));
        push(node.getAttribute?.("data-ol-user"));
        push(node.getAttribute?.("data-current-user"));
        push(node.textContent);
      }
    }
    return roots;
  }

  function findIdentityInExplicitState(root) {
    const seen = new Set();
    const preferredKeys = /^(?:current_?user|user|user_?info|profile|account|identity|session)$/i;
    const visit = (value, depth = 0) => {
      const parsed = parseCollabtexIdentityPayload(value);
      if (!parsed || typeof parsed !== "object" || depth > 4 || seen.has(parsed)) return null;
      seen.add(parsed);
      const name = collabtexDisplayName(parsed);
      if (name) return parsed;
      let keys = [];
      try { keys = Object.keys(parsed).filter((key) => preferredKeys.test(key)).slice(0, 24); } catch (_error) { return null; }
      for (const key of keys) {
        try {
          const found = visit(parsed[key], depth + 1);
          if (found) return found;
        } catch (_error) {}
      }
      return null;
    };
    return visit(root);
  }

  function identityFromPageBootstrap() {
    for (const root of explicitCurrentUserRoots()) {
      const record = findIdentityInExplicitState(root);
      if (record && collabtexDisplayName(record)) return record;
    }
    return null;
  }

  function cleanAccountMenuText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 120) return "";
    const labeled = text.match(/^(?:account|user|profile)(?:\s+menu)?(?:\s+for|\s*:)?\s+(.+)$/i);
    const candidate = cleanCollabtexIdentityName(labeled?.[1] || text);
    if (!candidate) return "";
    if (/^(?:account|user|profile|menu|settings|account settings|user settings|log ?out|sign ?out)$/i.test(candidate)) return "";
    if (/^[A-Z]{1,3}$/i.test(candidate)) return "";
    return candidate;
  }

  function identityFromAccountUi() {
    const selectors = [
      '[data-testid="user-menu-button"]',
      '[data-testid="account-menu-button"]',
      '[data-testid*="user-menu" i]',
      '[data-testid*="account-menu" i]',
      'button[aria-label*="account" i]',
      'button[aria-label*="profile" i]',
      '[data-user-name]',
      '[data-display-name]'
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll?.(selector) || []) {
        for (const raw of [
          node.getAttribute?.("data-user-name"),
          node.getAttribute?.("data-display-name"),
          node.getAttribute?.("aria-label"),
          node.getAttribute?.("title"),
          node.textContent
        ]) {
          const name = cleanAccountMenuText(raw);
          if (name) return { name };
        }
      }
    }
    return null;
  }

  function identityFromDocument(documentRoot) {
    if (!documentRoot?.querySelectorAll) return null;
    for (const selector of [
      'meta[name="ol-user"]',
      'meta[name="ol-current-user"]',
      'meta[name="ol-userInfo"]',
      'meta[name="ol-user-info"]',
      '[data-ol-user]',
      '[data-current-user]'
    ]) {
      for (const node of documentRoot.querySelectorAll(selector)) {
        for (const raw of [
          node.getAttribute?.("content"),
          node.getAttribute?.("data-ol-user"),
          node.getAttribute?.("data-current-user"),
          node.textContent
        ]) {
          const record = findIdentityInExplicitState(raw);
          if (record && collabtexDisplayName(record)) return record;
        }
      }
    }
    return null;
  }

  async function identityFromSettingsPage() {
    if (collabtexSettingsIdentityFetchAttempted || lastCollabtexIdentityName) return null;
    collabtexSettingsIdentityFetchAttempted = true;
    try {
      const response = await fetch(new URL("/user/settings", location.origin), {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        cache: "no-store"
      });
      if (!response.ok) return null;
      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      return identityFromDocument(parsed);
    } catch (_error) {
      return null;
    }
  }

  async function discoverLocalCollabtexIdentity({ allowSettingsFetch = false } = {}) {
    if (lastCollabtexIdentityName) return true;
    const direct = identityFromPageBootstrap() || identityFromAccountUi();
    if (direct && publishLocalCollabtexIdentity(direct)) return true;
    if (allowSettingsFetch) {
      const fromSettings = await identityFromSettingsPage();
      if (fromSettings && publishLocalCollabtexIdentity(fromSettings)) return true;
    }
    return false;
  }

  function scheduleCollabtexIdentityDiscovery(delay = 0, allowSettingsFetch = false) {
    if (lastCollabtexIdentityName) return;
    window.clearTimeout(collabtexIdentityDiscoveryTimer);
    collabtexIdentityDiscoveryTimer = window.setTimeout(() => {
      collabtexIdentityDiscoveryTimer = 0;
      discoverLocalCollabtexIdentity({ allowSettingsFetch }).catch(() => {});
    }, Math.max(0, Number(delay) || 0));
  }

  function findCollaborationSocket() {
    const seen = new Set();
    const budget = { remaining: 9000 };
    const visit = (value, depth = 0) => {
      if (
        !value || depth > 10 || budget.remaining-- <= 0 || seen.has(value) ||
        (typeof value !== "object" && typeof value !== "function")
      ) return null;
      seen.add(value);
      if (looksLikeCollaborationSocket(value)) return value;
      let keys = [];
      try { keys = Object.getOwnPropertyNames(value).slice(0, 180); } catch (_error) { return null; }
      const preferred = [
        "socket", "connectionManager", "connection", "manager", "ide", "data",
        "props", "memoizedProps", "memoizedState", "stateNode", "child", "sibling"
      ];
      keys.sort((left, right) => {
        const leftIndex = preferred.indexOf(left);
        const rightIndex = preferred.indexOf(right);
        return (leftIndex < 0 ? preferred.length : leftIndex) -
          (rightIndex < 0 ? preferred.length : rightIndex);
      });
      for (const key of keys) {
        if (["window", "document", "ownerDocument", "parentNode"].includes(key)) continue;
        try {
          const found = visit(value[key], depth + 1);
          if (found) return found;
        } catch (_error) {
          // Framework and socket internals may expose guarded accessors.
        }
      }
      return null;
    };
    const roots = [
      globalThis.io,
      globalThis.OL,
      document.querySelector("#ide-root"),
      document.querySelector("[data-testid='ide-root']"),
      document.querySelector(".cm-editor"),
      ...projectModelRoots()
    ].filter(Boolean);
    for (const root of roots) {
      const found = visit(root);
      if (found) return found;
    }
    return null;
  }

  function editorPositionAtIndex(indexValue) {
    const index = Math.max(0, Number(indexValue) || 0);
    if (editorKind === "codemirror" && editor?.state?.doc) {
      const bounded = Math.min(index, editor.state.doc.length);
      const line = editor.state.doc.lineAt(bounded);
      return { row: line.number - 1, column: bounded - line.from };
    }
    const session = editor?.getSession?.();
    const position = session?.doc?.indexToPosition?.(
      Math.min(index, session.getValue().length),
      0
    );
    return position ? { row: Number(position.row) || 0, column: Number(position.column) || 0 } : null;
  }

  function editorIndexAtPosition(position) {
    if (!position) return 0;
    const row = Math.max(0, Number(position.row) || 0);
    const column = Math.max(0, Number(position.column) || 0);
    if (editorKind === "codemirror" && editor?.state?.doc) {
      const lineNumber = Math.max(1, Math.min(editor.state.doc.lines, row + 1));
      const line = editor.state.doc.line(lineNumber);
      return Math.min(line.to, line.from + column);
    }
    const session = editor?.getSession?.();
    return Math.max(0, Number(session?.doc?.positionToIndex?.({ row, column }, 0)) || 0);
  }

  function dispatchCollaborationPresence(raw) {
    if (!raw || typeof raw !== "object") return;
    const cursorData = raw.cursorData && typeof raw.cursorData === "object"
      ? raw.cursorData
      : raw;
    const id = String(raw.id || raw.client_id || "");
    if (!id || id === String(collaborationSocket?.publicId || "")) return;
    const documentId = String(raw.doc_id || cursorData.doc_id || "");
    const cursorPosition = cursorData;
    const selectionValue = raw.smarttexSelection || cursorData.smarttexSelection;
    const selection = selectionValue && typeof selectionValue === "object"
      ? selectionValue
      : null;
    const cursorIndex = editorIndexAtPosition(cursorPosition);
    const selectionAnchor = selection ? editorIndexAtPosition(selection.anchor) : cursorIndex;
    const selectionHead = selection ? editorIndexAtPosition(selection.head) : cursorIndex;
    const detail = {
      id,
      userId: String(raw.user_id || ""),
      authorId: String(raw.smarttexAuthorId || cursorData.smarttexAuthorId || ""),
      name: String(raw.smarttexName || cursorData.smarttexName || raw.name || "Anonymous").slice(0, 80),
      color: normalizedHighlightColor(raw.smarttexColor || cursorData.smarttexColor || "#64748b"),
      documentId,
      cursorIndex,
      selectionAnchor,
      selectionHead,
      updatedAt: Date.now()
    };
    window.dispatchEvent(new CustomEvent(COLLABORATION_PRESENCE_EVENT, {
      detail: JSON.stringify(detail)
    }));
    const signals = Array.isArray(raw.smarttexSignals || cursorData.smarttexSignals)
      ? (raw.smarttexSignals || cursorData.smarttexSignals)
      : Array.isArray(selection?.smarttexSignals)
        ? selection.smarttexSignals
        : ((raw.smarttexSignal || cursorData.smarttexSignal) &&
            typeof (raw.smarttexSignal || cursorData.smarttexSignal) === "object"
          ? [raw.smarttexSignal || cursorData.smarttexSignal]
          : (selection?.smarttexSignal && typeof selection.smarttexSignal === "object"
            ? [selection.smarttexSignal]
            : []));
    for (const signal of signals) {
      if (!signal || typeof signal !== "object") continue;
      window.dispatchEvent(new CustomEvent(COLLABORATION_SIGNAL_EVENT, {
        detail: JSON.stringify({
          kind: String(signal.kind || ""),
          nonce: String(signal.nonce || ""),
          path: String(signal.path || ""),
          fileId: String(signal.fileId || ""),
          entityType: String(signal.entityType || ""),
          payload: signal.payload && typeof signal.payload === "object" ? signal.payload : null,
          sourceId: id
        })
      }));
    }
  }

  function bindCollaborationSocket(socket) {
    if (!socket || socket === collaborationSocket) return Boolean(socket);
    collaborationSocketCleanup?.();
    collaborationSocket = socket;
    const updated = (payload) => dispatchCollaborationPresence(payload);
    const disconnected = (idValue) => {
      window.dispatchEvent(new CustomEvent(COLLABORATION_PRESENCE_EVENT, {
        detail: JSON.stringify({ id: String(idValue || ""), disconnected: true })
      }));
    };
    const remove = (eventName, handler) => {
      try {
        if (typeof socket.removeListener === "function") socket.removeListener(eventName, handler);
        else socket.off?.(eventName, handler);
      } catch (_error) {}
    };
    socket.on("clientTracking.clientUpdated", updated);
    socket.on("clientTracking.clientDisconnected", disconnected);
    collaborationSocketCleanup = () => {
      remove("clientTracking.clientUpdated", updated);
      remove("clientTracking.clientDisconnected", disconnected);
    };
    try {
      socket.emit("clientTracking.getConnectedUsers", (error, users) => {
        if (error || !Array.isArray(users)) return;
        const localUser = findLocalCollabtexUser(users, socket);
        if (localUser) publishLocalCollabtexIdentity(localUser);
        for (const user of users) {
          if (!user?.cursorData) continue;
          dispatchCollaborationPresence({ ...user.cursorData, ...user, id: user.client_id });
        }
      });
    } catch (_error) {}
    scheduleCollaborationPresence(true);
    return true;
  }

  function ensureCollaborationSocket() {
    if (looksLikeCollaborationSocket(collaborationSocket)) return true;
    const socket = findCollaborationSocket();
    if (socket) {
      collaborationSocketSearchMisses = 0;
      return bindCollaborationSocket(socket);
    }
    collaborationSocketSearchMisses += 1;
    return false;
  }

  function emitCollaborationPresence() {
    collaborationPresenceTimer = 0;
    const idleDelay = keyboardIdleDelay();
    if (idleDelay > 0) {
      scheduleCollaborationPresence();
      return false;
    }
    if (!ensureCollaborationSocket()) return false;
    const state = lastEditorState;
    const documentId = selectedDocumentId();
    if (!state || !documentId) return false;
    const cursor = editorPositionAtIndex(state.cursorIndex);
    const anchor = editorPositionAtIndex(state.selectionAnchor ?? state.selectionFrom ?? state.cursorIndex);
    const head = editorPositionAtIndex(state.selectionHead ?? state.selectionTo ?? state.cursorIndex);
    if (!cursor || !anchor || !head) return false;
    const signals = [...pendingCollaborationSignals.values()];
    pendingCollaborationSignals.clear();
    const payload = {
      row: cursor.row,
      column: cursor.column,
      doc_id: documentId,
      smarttexSelection: { anchor, head },
      smarttexName: collaborationProfile.name,
      smarttexColor: collaborationProfile.color,
      smarttexAuthorId: collaborationProfile.authorId
    };
    if (signals.length) {
      // Keep the original single-signal field for CollabTeX deployments that
      // preserve custom cursor-data objects but discard arrays. The array lets
      // newer deployments carry simultaneous comments/review updates.
      payload.smarttexSignal = signals[0];
      payload.smarttexSignals = signals;
      // smarttexSelection is already known to survive the host's client
      // tracking relay. Mirror the compact signal there for deployments that
      // whitelist that object while pruning other custom top-level fields.
      payload.smarttexSelection.smarttexSignal = signals[0];
      payload.smarttexSelection.smarttexSignals = signals;
    }
    const fingerprint = JSON.stringify(payload);
    if (!signals.length && fingerprint === lastCollaborationPresenceFingerprint) return true;
    lastCollaborationPresenceFingerprint = fingerprint;
    try {
      collaborationSocket.emit("clientTracking.updatePosition", payload, () => {});
      return true;
    } catch (_error) {
      for (const signal of signals) pendingCollaborationSignals.set(signal.kind, signal);
      return false;
    }
  }

  function scheduleCollaborationPresence(immediate = false) {
    window.clearTimeout(collaborationPresenceTimer);
    window.clearTimeout(collabtexIdentityDiscoveryTimer);
    collaborationPresenceTimer = window.setTimeout(
      emitCollaborationPresence,
      Math.max(immediate ? 0 : 90, keyboardIdleDelay())
    );
  }

  function rootFolderIdFromProjectModel() {
    const seen = new Set();
    const budget = { remaining: 10000 };
    const idFromCandidate = (candidate, depth = 0) => {
      if (!candidate || depth > 3) return "";
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          const id = idFromCandidate(item, depth + 1);
          if (id) return id;
        }
        return "";
      }
      if (typeof candidate !== "object" && typeof candidate !== "function") return "";
      let id = "";
      try { id = likelyFileId(candidate._id || candidate.id || candidate.folderId || ""); } catch (_error) {}
      let looksLikeFolder = false;
      try {
        looksLikeFolder = Boolean(
          /root/i.test(String(candidate.name || candidate.type || candidate.kind || "")) ||
          Array.isArray(candidate.docs) || Array.isArray(candidate.files) || Array.isArray(candidate.folders)
        );
      } catch (_error) {}
      if (id && looksLikeFolder) return id;
      for (const key of ["rootFolder", "folder", "data", "entity", "item"]) {
        try {
          const nested = idFromCandidate(candidate[key], depth + 1);
          if (nested) return nested;
        } catch (_error) {}
      }
      return "";
    };
    const visit = (value, depth = 0) => {
      if (!value || depth > 9 || budget.remaining-- <= 0 ||
          (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return "";
      seen.add(value);
      try {
        if (Object.prototype.hasOwnProperty.call(value, "rootFolder")) {
          const id = idFromCandidate(value.rootFolder);
          if (id) return id;
        }
        if (/root/i.test(String(value.name || ""))) {
          const id = idFromCandidate(value);
          if (id) return id;
        }
      } catch (_error) {}
      let keys = [];
      try { keys = Object.getOwnPropertyNames(value).slice(0, 140); } catch (_error) { return ""; }
      keys.sort((a, b) => (a === "rootFolder" ? -1 : b === "rootFolder" ? 1 : 0));
      for (const key of keys) {
        if (["window", "document", "ownerDocument", "parentNode"].includes(key)) continue;
        try {
          const found = visit(value[key], depth + 1);
          if (found) return found;
        } catch (_error) {}
      }
      return "";
    };
    for (const root of projectModelRoots()) {
      const id = visit(root);
      if (id) return id;
    }
    return "";
  }

  function csrfToken() {
    const selectors = [
      'meta[name="ol-csrfToken"]', 'meta[name="csrf-token"]', 'meta[name="csrfToken"]',
      'input[name="_csrf"]'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = String(element?.content || element?.value || "").trim();
      if (value) return value;
    }
    for (const candidate of [globalThis.csrfToken, globalThis._csrf, globalThis.OL?.csrfToken]) {
      const value = String(candidate || "").trim();
      if (value) return value;
    }
    return "";
  }

  function writeRequestHeaders(extra = {}) {
    const token = csrfToken();
    return token ? { ...extra, "X-CSRF-Token": token } : extra;
  }

  async function fetchProjectFileText(projectId, fileId) {
    const response = await fetch(
      `/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`,
      { credentials: "include", cache: "no-store", headers: { Accept: "text/plain, application/json;q=0.9, */*;q=0.1" } }
    );
    if (!response.ok) throw new Error(`Could not read SmartTeX comment data (HTTP ${response.status}).`);
    return response.text();
  }

  const projectMetadataEntityCache = new Map();

  function projectMetadataCacheKey(pathValue) {
    return `${projectIdFromLocation() || "project"}:${normalizedProjectPath(pathValue)}`;
  }

  function projectMetadataEntity(pathValue) {
    const targetPath = normalizedProjectPath(pathValue);
    const item = visibleProjectFile(targetPath);
    const entity = reactProjectFile(targetPath, item);
    let fileId = likelyFileId(
      item?.getAttribute?.("data-file-id") || item?.getAttribute?.("data-entity-id") ||
      item?.getAttribute?.("data-id") || item?.id || entity?.fileId || ""
    );
    let entityType = String(entity?.entityType || "").toLowerCase();
    if (fileId) {
      projectMetadataEntityCache.set(projectMetadataCacheKey(targetPath), { fileId, entityType });
    } else {
      const cached = projectMetadataEntityCache.get(projectMetadataCacheKey(targetPath));
      fileId = likelyFileId(cached?.fileId || "");
      entityType = entityType || String(cached?.entityType || "").toLowerCase();
    }
    return { targetPath, item, entity, fileId, entityType };
  }

  async function fetchMetadataEntityText(projectId, fileId, entityType) {
    const preferred = String(entityType || "").includes("doc") ? ["doc", "file"] : ["file", "doc"];
    let lastError = null;
    for (const type of preferred) {
      try {
        const value = type === "doc"
          ? await fetchProjectDocumentText(projectId, fileId)
          : await fetchProjectFileText(projectId, fileId);
        if (value || type === "file") return { value, entityType: type };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return { value: "", entityType: String(entityType || "") };
  }

  async function readProjectMetadataFile(pathValue, options = {}) {
    const targetPath = String(pathValue || "").trim();
    if (!targetPath) throw new Error("No metadata-file path was supplied.");
    const projectId = projectIdFromLocation();
    const hintedFileId = likelyFileId(options.fileId || "");
    const hintedEntityType = String(options.entityType || "");

    // Realtime invalidations carry the id returned by the writer's upload.
    // Reading that immutable version directly avoids waiting for this tab's
    // hidden file-tree model to notice the delete-and-reupload operation.
    if (projectId && hintedFileId) {
      try {
        const fetched = await fetchMetadataEntityText(projectId, hintedFileId, hintedEntityType);
        projectMetadataEntityCache.set(projectMetadataCacheKey(targetPath), {
          fileId: hintedFileId,
          entityType: fetched.entityType
        });
        return {
          exists: true,
          value: fetched.value,
          fileName: targetPath,
          fileId: hintedFileId,
          entityType: fetched.entityType
        };
      } catch (_error) {
        // Fall through to normal tree/model resolution. This also preserves
        // compatibility with deployments whose upload response omits a type.
      }
    }

    // The editor can become usable before CollabTeX has populated the project
    // tree/model. Do not interpret that short bootstrap window as proof that a
    // hidden SmartTeX metadata file does not exist; that used to erase comments
    // and marks from the first render after a page reload.
    let resolved = projectMetadataEntity(targetPath);
    for (let attempt = 0; attempt < 6 && !resolved.item && !resolved.entity && !resolved.fileId; attempt += 1) {
      await delay(180);
      resolved = projectMetadataEntity(targetPath);
    }
    const { item, entity, fileId } = resolved;
    if (!item && !entity && !fileId) {
      if (!rootFolderIdFromProjectModel()) {
        throw new Error("Could not determine the CollabTeX project root folder.");
      }
      return { exists: false, value: "", fileName: targetPath };
    }
    if (!projectId || !fileId) {
      if (typeof entity?.text === "string") {
        return {
          exists: true, value: entity.text, fileName: treeItemPath(item) || targetPath,
          fileId, entityType: entity.entityType || resolved.entityType || ""
        };
      }
      return { exists: false, value: "", fileName: targetPath };
    }
    try {
      // React's file-tree entity keeps the text that existed when the hidden
      // metadata file was first observed. Fetch by id even when that cached
      // entity has text; otherwise collaborators can keep seeing the initial
      // comments forever after another client replaces the file.
      const fetched = await fetchMetadataEntityText(projectId, fileId, resolved.entityType);
      projectMetadataEntityCache.set(projectMetadataCacheKey(targetPath), { fileId, entityType: fetched.entityType });
      return {
        exists: true, value: fetched.value, fileName: treeItemPath(item) || targetPath,
        fileId, entityType: fetched.entityType
      };
    } catch (error) {
      // A recent delete-and-reupload can leave our short-lived cache stale until
      // the project tree refreshes. Drop it and retry once against a newly
      // resolved id so realtime invalidation signals do not race that refresh.
      projectMetadataEntityCache.delete(projectMetadataCacheKey(targetPath));
      await delay(180);
      const refreshed = projectMetadataEntity(targetPath);
      if (refreshed.fileId && refreshed.fileId !== fileId) {
        const fetched = await fetchMetadataEntityText(projectId, refreshed.fileId, refreshed.entityType);
        projectMetadataEntityCache.set(projectMetadataCacheKey(targetPath), {
          fileId: refreshed.fileId,
          entityType: fetched.entityType
        });
        return {
          exists: true,
          value: fetched.value,
          fileName: treeItemPath(refreshed.item) || targetPath,
          fileId: refreshed.fileId,
          entityType: fetched.entityType
        };
      }
      if (!item && !entity) return { exists: false, value: "", fileName: targetPath };
      throw error;
    }
  }

  function probeProjectMetadataFile(pathValue) {
    const targetPath = String(pathValue || "").trim();
    if (!targetPath) return { exists: false, token: "missing" };
    const resolved = projectMetadataEntity(targetPath);
    const { item, entity, fileId } = resolved;
    const exists = Boolean(item || entity || fileId);
    if (!exists) return { exists: false, token: "missing" };

    // Build a cheap revision token from CollabTeX's already-loaded project
    // model. SmartTeX's metadata writes replace the file, so the entity id is
    // normally sufficient; common revision/mtime fields make the probe robust
    // for deployments that update metadata files in place. No file body is
    // fetched here.
    const values = [String(fileId || ""), String(resolved.entityType || "")];
    const addRevisionFields = (candidate) => {
      if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) return;
      for (const key of ["version", "rev", "revision", "updatedAt", "updated_at", "lastModified", "last_modified", "mtime", "modified"]) {
        try {
          const value = candidate[key];
          if (value !== undefined && value !== null && value !== "") values.push(`${key}:${String(value)}`);
        } catch (_error) {}
      }
    };
    addRevisionFields(entity);
    addRevisionFields(item);
    if (item instanceof Element) {
      for (const name of ["data-file-id", "data-entity-id", "data-version", "data-revision", "data-updated-at"]) {
        const value = item.getAttribute(name);
        if (value) values.push(`${name}:${value}`);
      }
    }
    return { exists: true, token: values.join("|") || `present:${targetPath}` };
  }

  let projectMetadataWriteQueue = Promise.resolve();

  async function deleteProjectMetadataEntity(projectId, existingId, entityTypeHint) {
    if (!existingId) return false;
    const hint = String(entityTypeHint || "").toLowerCase();
    const candidates = hint.includes("doc") ? ["doc", "file"] : hint.includes("file") ? ["file", "doc"] : ["file", "doc"];
    let sawNotFound = false;
    for (const entityType of candidates) {
      const response = await fetch(
        `/project/${encodeURIComponent(projectId)}/${entityType}/${encodeURIComponent(existingId)}`,
        { method: "DELETE", credentials: "include", headers: writeRequestHeaders({ Accept: "application/json, */*;q=0.1" }) }
      );
      if (response.ok) return true;
      if (response.status === 404) {
        sawNotFound = true;
        continue;
      }
      throw new Error(`Could not replace SmartTeX comment data (delete HTTP ${response.status}).`);
    }
    return !sawNotFound;
  }

  async function writeProjectMetadataFileNow(pathValue, textValue) {
    const targetPath = normalizedProjectPath(pathValue);
    if (!targetPath || targetPath.includes("/")) {
      throw new Error("SmartTeX comment metadata must be stored in the project root.");
    }
    const projectId = projectIdFromLocation();
    if (!projectId) throw new Error("Could not determine the current CollabTeX project.");
    let rootFolderId = rootFolderIdFromProjectModel();
    if (!rootFolderId) {
      // The project tree/model can lag the editor by a short time after load or
      // a remote file-tree update. Retry quietly before surfacing a failure.
      for (let attempt = 0; attempt < 5 && !rootFolderId; attempt += 1) {
        await delay(220);
        rootFolderId = rootFolderIdFromProjectModel();
      }
    }
    if (!rootFolderId) throw new Error("Could not determine the CollabTeX project root folder.");

    const resolved = projectMetadataEntity(targetPath);
    if (resolved.fileId) {
      await deleteProjectMetadataEntity(projectId, resolved.fileId, resolved.entityType);
      projectMetadataEntityCache.delete(projectMetadataCacheKey(targetPath));
      await delay(80);
    }

    const text = String(textValue ?? "");
    const form = new FormData();
    form.append("name", targetPath);
    form.append("qqfile", new File([text], targetPath, { type: "application/json;charset=utf-8" }));
    const uploadResponse = await fetch(
      `/Project/${encodeURIComponent(projectId)}/upload?folder_id=${encodeURIComponent(rootFolderId)}`,
      { method: "POST", credentials: "include", headers: writeRequestHeaders({ Accept: "application/json" }), body: form }
    );
    let payload = null;
    try { payload = await uploadResponse.json(); } catch (_error) {}
    if (!uploadResponse.ok || payload?.success === false) {
      const reason = payload?.error || `HTTP ${uploadResponse.status}`;
      throw new Error(`Could not write SmartTeX comment data (${reason}).`);
    }
    const fileId = String(payload?.entity_id || "");
    const entityType = String(payload?.entity_type || "file").toLowerCase();
    if (fileId) projectMetadataEntityCache.set(projectMetadataCacheKey(targetPath), { fileId, entityType });
    projectArchiveCache = null;
    projectFigureListCache = null;
    return { ok: true, fileId, entityType };
  }

  function writeProjectMetadataFile(pathValue, textValue) {
    const operation = projectMetadataWriteQueue.then(
      () => writeProjectMetadataFileNow(pathValue, textValue),
      () => writeProjectMetadataFileNow(pathValue, textValue)
    );
    projectMetadataWriteQueue = operation.catch(() => {});
    return operation;
  }

  function collectProjectFigurePaths() {
    const paths = new Set();
    const add = (value) => {
      const path = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (!path || !FIGURE_FILE_PATTERN.test(path)) return false;
      paths.add(path);
      return true;
    };
    const hierarchyNames = [];
    const visualFolders = [];
    for (const item of document.querySelectorAll('.file-tree-list [role="treeitem"]')) {
      const ownPath = treeItemPath(item).replace(/\\/g, "/").replace(/^\.\//, "");
      const ownName = ownPath.split("/").filter(Boolean).pop() || "";
      const level = Number(item.getAttribute("aria-level"));
      const visualIndent = treeItemVisualIndent(item);
      while (
        visualFolders.length &&
        visualFolders[visualFolders.length - 1].indent >= visualIndent - 0.5
      ) {
        visualFolders.pop();
      }
      let projectPath = treeItemProjectPath(item);
      if (
        ownName &&
        Number.isInteger(level) &&
        level > 1 &&
        !String(projectPath || "").replace(/\\/g, "/").includes("/")
      ) {
        const parents = hierarchyNames.slice(0, level - 1);
        if (parents.length === level - 1 && parents.every(Boolean)) {
          projectPath = [...parents, ownName].join("/");
        }
      }
      if (
        ownName &&
        !String(projectPath || "").replace(/\\/g, "/").includes("/") &&
        visualFolders.length
      ) {
        projectPath = [...visualFolders.map((folder) => folder.name), ownName].join("/");
      }
      if (Number.isInteger(level) && level > 0 && ownName) {
        hierarchyNames[level - 1] = ownName;
        hierarchyNames.length = level;
      }
      add(projectPath);
      if (ownName && treeItemIsFolder(item, ownName)) {
        visualFolders.push({ indent: visualIndent, name: ownName });
      }
    }

    const roots = [
      document.querySelector(".file-tree-list"),
      document.querySelector("#ide-root"),
      document.querySelector("[data-testid='ide-root']")
    ].filter(Boolean);
    const globalNames = Object.getOwnPropertyNames(window).filter((key) => (
      /^(?:project|ide|editor|fileTree|fileStore|rootFolder)$/i.test(key) ||
      /^OLProject/i.test(key)
    ));
    for (const key of globalNames) {
      try { roots.push(window[key]); } catch (_error) { /* Guarded page globals are optional. */ }
    }

    const seen = new Set();
    const budget = { remaining: 12000 };
    const visit = (value, depth = 0) => {
      if (
        !value || depth > 10 || budget.remaining-- <= 0 ||
        (typeof value !== "object" && typeof value !== "function") ||
        seen.has(value) || value === window || value === document
      ) return;
      seen.add(value);
      try {
        // A model object often exposes both `path: "fig/plot.png"` and
        // `name: "plot.png"`. Adding both creates a phantom root-level file
        // and loses the distinction between equal basenames in two folders.
        // Prefer the complete project-relative path whenever it is available.
        // Names without directory information are ambiguous: the same model
        // shape is used for root files and children of collapsed folders.
        // The visible tree and project archive cover those cases with real
        // hierarchy, so never promote a model basename to the project root.
        for (const candidate of [value.path, value.filePath]) {
          const path = String(candidate || "").replace(/\\/g, "/");
          if (path.includes("/")) add(path);
        }
      } catch (_error) {
        // Continue through accessible child values.
      }
      let keys = [];
      try { keys = Object.getOwnPropertyNames(value).slice(0, 160); } catch (_error) { return; }
      for (const key of keys) {
        if (["window", "document", "ownerDocument", "parentNode"].includes(key)) continue;
        try { visit(value[key], depth + 1); } catch (_error) { /* Ignore guarded accessors. */ }
      }
    };
    for (const root of roots) {
      if (root instanceof Element) {
        for (const key of Object.getOwnPropertyNames(root).filter((name) => (
          /^__(?:react|preact|vue)/i.test(name) || /fiber|props/i.test(name)
        ))) {
          try { visit(root[key]); } catch (_error) { /* Ignore framework internals that reject access. */ }
        }
      } else {
        visit(root);
      }
    }
    return withoutFigureBasenameAliases(paths);
  }

  function withoutFigureBasenameAliases(values) {
    const paths = [...values].map((value) => (
      String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "")
    )).filter(Boolean);
    const nestedBasenames = new Set(paths.filter((path) => path.includes("/")).map((path) => (
      path.split("/").pop().toLocaleLowerCase()
    )));
    return paths.filter((path) => (
      path.includes("/") || !nestedBasenames.has(path.toLocaleLowerCase())
    ));
  }

  function listProjectZipPaths(buffer, pattern) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findZipEndOfCentralDirectory(bytes);
    if (eocd < 0) throw new Error("The downloaded project archive is not a valid ZIP file.");
    const entryCount = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const paths = [];
    for (let entry = 0; entry < entryCount; entry += 1) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("The project ZIP central directory is malformed.");
      }
      const flags = view.getUint16(offset + 8, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      const name = decodeZipName(bytes.subarray(nameStart, nameEnd), Boolean(flags & 0x0800))
        .replace(/\\/g, "/")
        .replace(/^\.\//, "");
      if (name && !name.endsWith("/") && pattern.test(name)) paths.push(name);
      offset = nameEnd + extraLength + commentLength;
    }
    return paths;
  }

  let projectFigureListCache = null;

  async function listProjectFigures({ full = false } = {}) {
    const quickPaths = collectProjectFigurePaths();
    if (!full) {
      return {
        figures: quickPaths.sort((left, right) => left.localeCompare(right, undefined, {
          sensitivity: "base", numeric: true
        })),
        complete: false
      };
    }
    const projectId = projectIdFromLocation();
    const cacheKey = `${window.location.origin}:${projectId}`;
    const now = Date.now();
    if (
      projectFigureListCache?.key === cacheKey &&
      now - projectFigureListCache.createdAt < 30000
    ) {
      return projectFigureListCache.value;
    }
    let paths = new Set(quickPaths);
    if (projectId) {
      try {
        const archive = await fetchProjectArchive(projectId);
        // The archive contains authoritative project-relative paths. Do not
        // retain basename-only aliases collected from a collapsed file tree.
        paths = new Set(withoutFigureBasenameAliases(
          listProjectZipPaths(archive, FIGURE_FILE_PATTERN)
        ));
      } catch (_error) {
        // The visible/project-model list remains usable when archive download is unavailable.
      }
    }
    const value = {
      figures: withoutFigureBasenameAliases(paths).sort((left, right) => left.localeCompare(right, undefined, {
        sensitivity: "base", numeric: true
      })),
      complete: true
    };
    projectFigureListCache = { key: cacheKey, createdAt: now, value };
    return value;
  }

  function projectIdFromLocation() {
    return window.location.pathname.match(/\/project\/([^/?#]+)/i)?.[1] || "";
  }

  function documentTextFromPayload(payload) {
    const seen = new Set();
    const budget = { remaining: 800 };
    const visit = (value, depth = 0) => {
      if (
        value == null ||
        depth > 8 ||
        budget.remaining-- <= 0 ||
        (typeof value === "object" && seen.has(value))
      ) {
        return "";
      }
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        if (value.every((line) => typeof line === "string")) return value.join("\n");
        for (const item of value) {
          const text = visit(item, depth + 1);
          if (text) return text;
        }
        return "";
      }
      if (typeof value !== "object") return "";
      seen.add(value);
      const preferred = [
        "lines", "content", "text", "source", "snapshot", "doc", "document",
        "data", "value"
      ];
      for (const key of preferred) {
        let child;
        try {
          child = value[key];
        } catch (_error) {
          continue;
        }
        const text = visit(child, depth + 1);
        if (text) return text;
      }
      return "";
    };
    return visit(payload);
  }

  function responseIsHtml(contentType, text) {
    return (
      /text\/html/i.test(String(contentType || "")) ||
      /^\s*<!doctype\s+html/i.test(String(text || "")) ||
      /^\s*<html[\s>]/i.test(String(text || ""))
    );
  }

  async function fetchProjectDocumentText(projectId, documentId) {
    if (!projectId || !documentId) return "";
    const urls = [
      `/project/${encodeURIComponent(projectId)}/doc/${encodeURIComponent(documentId)}`,
      `/project/${encodeURIComponent(projectId)}/doc/${encodeURIComponent(documentId)}?format=json`
    ];
    for (const url of urls) {
      let response;
      try {
        response = await fetch(url, {
          credentials: "include",
          cache: "no-store",
          headers: {
            Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
            "Cache-Control": "no-cache",
            Pragma: "no-cache"
          }
        });
      } catch (_error) {
        continue;
      }
      if (!response.ok) continue;
      const contentType = String(response.headers?.get?.("content-type") || "");
      const raw = await response.text();
      if (!raw || responseIsHtml(contentType, raw)) continue;
      if (/json/i.test(contentType) || /^[\s\ufeff]*[\[{]/.test(raw)) {
        try {
          const text = documentTextFromPayload(JSON.parse(raw));
          if (text) return text;
        } catch (_error) {
          // Some installations return the source directly despite a JSON-like prefix.
        }
      }
      if (raw) return raw;
    }
    return "";
  }

  function findZipEndOfCentralDirectory(bytes) {
    const minimum = Math.max(0, bytes.length - 0xffff - 22);
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
      if (
        bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
        bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06
      ) {
        return offset;
      }
    }
    return -1;
  }

  function decodeZipName(bytes, utf8) {
    try {
      return new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(bytes);
    } catch (_error) {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }

  async function inflateZipEntry(compressed, method) {
    if (method === 0) return compressed;
    if (method !== 8) {
      throw new Error(`Unsupported ZIP compression method ${method}.`);
    }
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser cannot decompress the project ZIP in the background.");
    }
    const stream = new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("deflate-raw")
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function extractProjectZipText(buffer, targetPath) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findZipEndOfCentralDirectory(bytes);
    if (eocd < 0) throw new Error("The downloaded project archive is not a valid ZIP file.");
    const entryCount = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const normalizedTarget = normalizedProjectPath(targetPath);
    const targetName = normalizedTarget.split("/").pop();
    const candidates = [];

    for (let entry = 0; entry < entryCount; entry += 1) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("The project ZIP central directory is malformed.");
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      if (
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        throw new Error("ZIP64 project archives are not supported for background parsing.");
      }
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      const name = decodeZipName(bytes.subarray(nameStart, nameEnd), Boolean(flags & 0x0800));
      const normalizedName = normalizedProjectPath(name);
      if (normalizedName && !normalizedName.endsWith("/")) {
        const exact = normalizedName === normalizedTarget;
        const basename = normalizedName.split("/").pop() === targetName;
        if (exact || basename) {
          candidates.push({
            exact,
            name,
            normalizedName,
            method,
            compressedSize,
            uncompressedSize,
            localOffset
          });
        }
      }
      offset = nameEnd + extraLength + commentLength;
    }

    const exact = candidates.find((candidate) => candidate.exact);
    const basenameCandidates = candidates.filter((candidate) => !candidate.exact);
    const selected = exact || (basenameCandidates.length === 1 ? basenameCandidates[0] : null);
    if (!selected) {
      if (basenameCandidates.length > 1) {
        throw new Error(`Several project files match ${targetPath}; use its full project path.`);
      }
      throw new Error(`Project file not found in the background archive: ${targetPath}.`);
    }
    const localOffset = selected.localOffset;
    if (
      localOffset + 30 > bytes.length ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new Error(`The ZIP entry for ${selected.name} is malformed.`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + selected.compressedSize;
    if (dataEnd > bytes.length) throw new Error(`The ZIP entry for ${selected.name} is truncated.`);
    const inflated = await inflateZipEntry(bytes.subarray(dataStart, dataEnd), selected.method);
    if (selected.uncompressedSize && inflated.length !== selected.uncompressedSize) {
      throw new Error(`The ZIP entry for ${selected.name} has an unexpected size.`);
    }
    return {
      value: new TextDecoder("utf-8").decode(inflated),
      fileName: selected.name
    };
  }

  let projectArchiveCache = null;

  async function fetchProjectArchive(projectId) {
    const cacheKey = `${window.location.origin}:${projectId}`;
    const now = Date.now();
    if (
      projectArchiveCache?.key === cacheKey &&
      now - projectArchiveCache.createdAt < 5000
    ) {
      return projectArchiveCache.promise;
    }
    const promise = (async () => {
      const url = `/project/${encodeURIComponent(projectId)}/download/zip`;
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.1",
          "Cache-Control": "no-cache",
          Pragma: "no-cache"
        }
      });
      if (!response.ok) {
        throw new Error(`Could not download the project archive (HTTP ${response.status}).`);
      }
      const buffer = await response.arrayBuffer();
      const signature = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
      if (
        signature.length < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b
      ) {
        throw new Error("The project archive endpoint did not return a ZIP file.");
      }
      return buffer;
    })();
    projectArchiveCache = { key: cacheKey, createdAt: now, promise };
    try {
      return await promise;
    } catch (error) {
      if (projectArchiveCache?.promise === promise) projectArchiveCache = null;
      throw error;
    }
  }

  let projectTextReadQueue = Promise.resolve();

  async function readProjectTextFileNow(pathValue) {
    const targetPath = String(pathValue || "").trim();
    if (!targetPath) throw new Error("No project-file path was supplied.");

    const current = getEditorState();
    if (current && projectPathMatches(current.fileName, targetPath)) {
      return { value: current.value, fileName: current.fileName || targetPath };
    }

    // Read from the page's project model when it already contains a snapshot.
    // This is entirely passive and never selects or opens the target document.
    const item = visibleProjectFile(targetPath);
    const entity = reactProjectFile(targetPath, item);
    if (typeof entity?.text === "string" && entity.text) {
      return { value: entity.text, fileName: treeItemPath(item) || targetPath };
    }

    const projectId = projectIdFromLocation();
    if (!projectId) throw new Error(`Could not determine the project for ${targetPath}.`);

    // Editable CollabTeX files are collaborative documents, not binary files.
    // Try the document endpoint first; unlike selecting the tree item, this
    // leaves the active editor document and cursor completely untouched.
    const documentId = likelyFileId(entity?.fileId || "");
    if (documentId) {
      const text = await fetchProjectDocumentText(projectId, documentId);
      if (text) return { value: text, fileName: treeItemPath(item) || targetPath };
    }

    // Some deployments do not expose a readable document endpoint. Download
    // the project archive in memory and extract only the requested text file.
    // No project-tree item is clicked and the editor is never switched.
    const archive = await fetchProjectArchive(projectId);
    return extractProjectZipText(archive, targetPath);
  }

  function readProjectTextFile(pathValue) {
    const operation = projectTextReadQueue.then(
      () => readProjectTextFileNow(pathValue),
      () => readProjectTextFileNow(pathValue)
    );
    projectTextReadQueue = operation.catch(() => {});
    return operation;
  }

  function acePositionToIndex(session, position) {
    return session?.doc?.positionToIndex?.(position, 0) || 0;
  }

  function aceScreenPosition(position) {
    if (!editor || !position) return null;
    const coordinates = editor.renderer?.textToScreenCoordinates?.(
      position.row,
      position.column
    );
    if (!coordinates) return null;
    return {
      pageX: Number(coordinates.pageX) || 0,
      pageY: Number(coordinates.pageY) || 0,
      lineHeight: Number(editor.renderer?.lineHeight) || 16
    };
  }

  function codeMirrorScreenPosition(index) {
    if (!editor || editorKind !== "codemirror") return null;
    const bounded = Math.max(0, Math.min(Number(index) || 0, editor.state.doc.length));
    const coordinates = editor.coordsAtPos?.(bounded, 1) || editor.coordsAtPos?.(bounded);
    if (!coordinates) return null;
    return {
      pageX: coordinates.left + window.scrollX,
      pageY: coordinates.top + window.scrollY,
      lineHeight: Math.max(14, coordinates.bottom - coordinates.top)
    };
  }

  function handleBoundEditorScroll() {
    if (textInputIsActive() || interactionTasks?.isScrolling?.()) return;
    scheduleOverlayRender();
  }

  function editorIndexAtCoordinates(clientXValue, clientYValue) {
    if (!editor) return null;
    const clientX = Number(clientXValue) || 0;
    const clientY = Number(clientYValue) || 0;
    if (editorKind === "codemirror") {
      const index = editor.posAtCoords?.({ x: clientX, y: clientY }, true);
      if (!Number.isFinite(index)) return null;
      return Math.max(0, Math.min(index, editor.state.doc.length));
    }

    const coordinates = editor.renderer?.screenToTextCoordinates?.(
      clientX + window.scrollX,
      clientY + window.scrollY
    );
    const session = editor.getSession?.();
    if (!coordinates || !session) return null;
    return Math.max(
      0,
      Math.min(
        acePositionToIndex(session, coordinates),
        session.getValue().length
      )
    );
  }

  function codeMirrorContent(view) {
    return view?.contentDOM || view?.dom?.querySelector?.(".cm-content") || null;
  }

  function getEditorState() {
    if (!editor) return null;

    if (editorKind === "codemirror") {
      const value = editor.state.doc.toString();
      const selection = editor.state.selection?.main;
      const cursorIndex = Number(selection?.head ?? 0);
      const line = editor.state.doc.lineAt(
        Math.max(0, Math.min(cursorIndex, editor.state.doc.length))
      );
      const content = codeMirrorContent(editor);
      return {
        value,
        cursorIndex,
        cursor: {
          row: line.number - 1,
          column: cursorIndex - line.from
        },
        selectionFrom: Number(selection?.from ?? cursorIndex),
        selectionTo: Number(selection?.to ?? cursorIndex),
        selectionAnchor: Number(selection?.anchor ?? selection?.from ?? cursorIndex),
        selectionHead: Number(selection?.head ?? cursorIndex),
        screen: codeMirrorScreenPosition(cursorIndex),
        fileName: selectedFileName(),
        documentId: selectedDocumentId(),
        focused: Boolean(editor.hasFocus || (content && content.contains(document.activeElement))),
        editorKind
      };
    }

    const session = editor.getSession();
    const cursor = editor.getCursorPosition();
    const selection = editor.getSelectionRange?.();
    const cursorIndex = acePositionToIndex(session, cursor);
    return {
      value: session.getValue(),
      cursorIndex,
      cursor,
      selectionFrom: selection ? acePositionToIndex(session, selection.start) : cursorIndex,
      selectionTo: selection ? acePositionToIndex(session, selection.end) : cursorIndex,
      selectionAnchor: selection
        ? acePositionToIndex(
          session,
          editor.selection?.isBackwards?.() ? selection.end : selection.start
        )
        : cursorIndex,
      selectionHead: cursorIndex,
      screen: aceScreenPosition(cursor),
      fileName: selectedFileName(),
      documentId: selectedDocumentId(),
      focused: Boolean(editor.isFocused?.()),
      editorKind
    };
  }

  function codeMirrorReadOnly(view) {
    const content = codeMirrorContent(view);
    return content?.getAttribute?.("contenteditable") !== "true";
  }

  function replaceRange(startValue, endValue, textValue, options = {}) {
    if (!editor) return false;
    const text = String(textValue ?? "");
    if (editorKind === "codemirror") {
      if (codeMirrorReadOnly(editor)) return false;
      const docLength = editor.state.doc.length;
      const start = Math.max(0, Math.min(Number(startValue) || 0, docLength));
      const end = Math.max(start, Math.min(Number(endValue) || 0, docLength));
      const selectionStart = Math.max(
        start,
        Math.min(
          Number(options.selectionStart ?? start + text.length),
          start + text.length
        )
      );
      const selectionEnd = Math.max(
        start,
        Math.min(
          Number(options.selectionEnd ?? selectionStart),
          start + text.length
        )
      );
      editor.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: { anchor: selectionStart, head: selectionEnd },
        scrollIntoView: true
      });
      if (options.focus !== false) editor.focus();
      scheduleState();
      return true;
    }

    if (editor.getReadOnly?.()) return false;
    const session = editor.getSession();
    const start = Math.max(0, Math.min(Number(startValue) || 0, session.getValue().length));
    const end = Math.max(start, Math.min(Number(endValue) || 0, session.getValue().length));
    const startPosition = session.doc.indexToPosition(start, 0);
    const endPosition = session.doc.indexToPosition(end, 0);
    const Range = window.ace?.require?.("ace/range")?.Range;
    if (!Range) return false;
    session.replace(
      new Range(startPosition.row, startPosition.column, endPosition.row, endPosition.column),
      text
    );
    const selectionStart = Math.max(
      start,
      Math.min(
        Number(options.selectionStart ?? start + text.length),
        start + text.length
      )
    );
    const selectionEnd = Math.max(
      start,
      Math.min(
        Number(options.selectionEnd ?? selectionStart),
        start + text.length
      )
    );
    const nextStart = session.doc.indexToPosition(selectionStart, 0);
    const nextEnd = session.doc.indexToPosition(selectionEnd, 0);
    editor.selection.setSelectionRange(
      new Range(nextStart.row, nextStart.column, nextEnd.row, nextEnd.column)
    );
    if (options.focus !== false) editor.focus();
    scheduleState();
    return true;
  }

  function setCursorIndex(indexValue, focusEditor = true) {
    if (!editor) return false;
    if (editorKind === "codemirror") {
      const index = Math.max(
        0,
        Math.min(Number(indexValue) || 0, editor.state.doc.length)
      );
      editor.dispatch({
        selection: { anchor: index },
        scrollIntoView: true
      });
      if (focusEditor) editor.focus();
      scheduleState();
      return true;
    }

    const session = editor.getSession();
    const index = Math.max(
      0,
      Math.min(Number(indexValue) || 0, session.getValue().length)
    );
    const position = session.doc.indexToPosition(index, 0);
    editor.selection.moveCursorToPosition(position);
    editor.clearSelection();
    if (focusEditor) editor.focus();
    editor.renderer?.scrollCursorIntoView?.(position, 0.5);
    scheduleState();
    return true;
  }

  function moveCursorVertical(directionValue) {
    if (!editor) return false;
    const direction = Number(directionValue) < 0 ? -1 : 1;
    if (editorKind === "codemirror") {
      const selection = editor.state.selection?.main;
      const head = Number(selection?.head ?? 0);
      const currentLine = editor.state.doc.lineAt(
        Math.max(0, Math.min(head, editor.state.doc.length))
      );
      const targetNumber = Math.max(
        1,
        Math.min(editor.state.doc.lines, currentLine.number + direction)
      );
      if (targetNumber === currentLine.number) return true;
      const targetLine = editor.state.doc.line(targetNumber);
      const column = head - currentLine.from;
      const target = Math.min(targetLine.to, targetLine.from + column);
      editor.dispatch({
        selection: { anchor: target },
        scrollIntoView: true
      });
      editor.focus?.();
      scheduleState();
      return true;
    }

    editor.clearSelection?.();
    if (direction < 0) editor.navigateUp?.(1);
    else editor.navigateDown?.(1);
    editor.focus?.();
    editor.renderer?.scrollCursorIntoView?.(editor.getCursorPosition?.(), 0.5);
    scheduleState();
    return true;
  }

  function setSelectionRange(anchorValue, headValue, focusEditor = true) {
    if (!editor) return false;
    if (editorKind === "codemirror") {
      const length = editor.state.doc.length;
      const anchor = Math.max(0, Math.min(Number(anchorValue) || 0, length));
      const head = Math.max(0, Math.min(Number(headValue) || 0, length));
      editor.dispatch({
        selection: { anchor, head },
        scrollIntoView: true
      });
      if (focusEditor) editor.focus();
      scheduleState();
      return true;
    }

    const session = editor.getSession();
    const length = session.getValue().length;
    const anchor = Math.max(0, Math.min(Number(anchorValue) || 0, length));
    const head = Math.max(0, Math.min(Number(headValue) || 0, length));
    const Range = window.ace?.require?.("ace/range")?.Range;
    if (!Range) return false;
    const startIndex = Math.min(anchor, head);
    const endIndex = Math.max(anchor, head);
    const start = session.doc.indexToPosition(startIndex, 0);
    const end = session.doc.indexToPosition(endIndex, 0);
    editor.selection.setSelectionRange(
      new Range(start.row, start.column, end.row, end.column),
      anchor > head
    );
    if (focusEditor) editor.focus();
    editor.renderer?.scrollCursorIntoView?.(
      session.doc.indexToPosition(head, 0),
      0.5
    );
    scheduleState();
    return true;
  }

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

  function completionTokenAtCursor(pattern) {
    const state = getEditorState();
    if (!state) return null;
    const masked = globalThis.SmartTeXLatexContext?.maskIgnoredLatex?.(state.value) || state.value;
    const beforeCursor = masked.slice(0, state.cursorIndex);
    const match = beforeCursor.match(pattern);
    if (!match) return null;
    const argument = match[1];
    const lastComma = argument.lastIndexOf(",");
    const beforeFragment = argument.slice(lastComma + 1);
    const leadingWhitespace = beforeFragment.match(/^\s*/)?.[0] || "";
    const start = state.cursorIndex - beforeFragment.length + leadingWhitespace.length;
    const commandStart = beforeCursor.length - match[0].length;
    const openIndex = commandStart + match[0].lastIndexOf("{");
    const argumentIsClosed = matchingArgumentClose(state.value, openIndex) >= state.cursorIndex;
    const afterFragment = argumentIsClosed
      ? (state.value.slice(state.cursorIndex).match(/^[^,{}\s]*/)?.[0] || "")
      : "";
    return {
      start,
      end: state.cursorIndex + afterFragment.length,
      fragment: beforeFragment.slice(leadingWhitespace.length) + afterFragment
    };
  }

  function replaceCompletionToken(pattern, text) {
    const token = completionTokenAtCursor(pattern);
    if (!token || !replaceRange(token.start, token.end, text)) return null;
    return token;
  }

  function figureCompletionTokenAtCursor() {
    const state = getEditorState();
    if (!state) return null;
    const masked = globalThis.SmartTeXLatexContext?.maskIgnoredLatex?.(state.value) || state.value;
    const beforeCursor = masked.slice(0, state.cursorIndex);
    const match = beforeCursor.match(INCLUDEGRAPHICS_COMMAND);
    if (!match) return null;
    const argument = String(match[1] || "");
    const start = state.cursorIndex - argument.length;
    const commandStart = beforeCursor.length - match[0].length;
    const openIndex = commandStart + match[0].lastIndexOf("{");
    const argumentIsClosed = matchingArgumentClose(state.value, openIndex) >= state.cursorIndex;
    const afterFragment = argumentIsClosed
      ? (state.value.slice(state.cursorIndex).match(/^[^{}\s]*/)?.[0] || "")
      : "";
    return {
      start,
      end: state.cursorIndex + afterFragment.length,
      fragment: argument + afterFragment
    };
  }

  function replaceFigureToken(text) {
    const token = figureCompletionTokenAtCursor();
    if (!token || !replaceRange(token.start, token.end, text)) return null;
    return token;
  }

  function nativeAutocompleteSuppressed() {
    return citationAutocompleteActive || referenceAutocompleteActive || figureAutocompleteActive;
  }

  function hideNativeAutocomplete() {
    if (!nativeAutocompleteSuppressed()) return;
    if (editorKind === "ace") {
      try {
        editor?.completer?.detach?.();
        editor?.completer?.popup?.hide?.();
      } catch (_error) {
        // ACE autocomplete APIs vary between editor releases.
      }
    }
    document.body?.classList.add(
      "smarttex-citation-autocomplete-active",
      "smarttex-custom-autocomplete-active"
    );
  }

  function synchronizeAutocompleteSuppression() {
    const active = nativeAutocompleteSuppressed();
    document.body?.classList.toggle("smarttex-citation-autocomplete-active", active);
    document.body?.classList.toggle("smarttex-custom-autocomplete-active", active);
    if (active) hideNativeAutocomplete();
  }

  function setCitationAutocompleteActive(value) {
    citationAutocompleteActive = Boolean(value);
    synchronizeAutocompleteSuppression();
  }

  function setReferenceAutocompleteActive(value) {
    referenceAutocompleteActive = Boolean(value);
    synchronizeAutocompleteSuppression();
  }

  function setFigureAutocompleteActive(value) {
    figureAutocompleteActive = Boolean(value);
    synchronizeAutocompleteSuppression();
  }

  function citationResponse(requestId, ok, payload = {}) {
    window.dispatchEvent(new CustomEvent(CITATION_RESPONSE_EVENT, {
      detail: JSON.stringify({ requestId, ok, ...payload })
    }));
  }

  function stateFingerprint(state) {
    if (!state) return "";
    return [
      state.fileName,
      state.cursorIndex,
      state.selectionFrom,
      state.selectionTo,
      state.focused ? "1" : "0",
      state.value.length,
      state.value.slice(Math.max(0, state.cursorIndex - 220), state.cursorIndex + 120)
    ].join("\n");
  }

  function emitState(expectedRevision = stateScheduleRevision, preparedState = null) {
    if (expectedRevision !== stateScheduleRevision) return;
    scheduledState = false;
    stateTimer = 0;
    const state = preparedState || getEditorState();
    if (!state) return;
    lastFingerprint = stateFingerprint(state);
    lastEditorState = state;
    window.dispatchEvent(new CustomEvent(STATE_EVENT, {
      detail: JSON.stringify(state)
    }));
    scheduleCollaborationPresence();
    refreshStructureCache(state);
  }

  function emitPreviewState({ allowDuringTyping = false, state: preparedState = null, priority = "" } = {}) {
    if (pointerSelectionActive || (!allowDuringTyping && textInputIsActive())) return;
    const state = preparedState || getEditorState();
    if (!state) return;
    const previous = lastPreviewSnapshot;
    if (!priority && previous && previous.value === state.value &&
        previous.fileName === state.fileName && previous.cursorIndex === state.cursorIndex &&
        previous.selectionFrom === state.selectionFrom && previous.selectionTo === state.selectionTo &&
        previous.focused === state.focused && previous.screen?.pageX === state.screen?.pageX &&
        previous.screen?.pageY === state.screen?.pageY) return;
    lastPreviewSnapshot = state;
    const previewState = priority ? { ...state, interactionPriority: priority } : state;
    window.dispatchEvent(new CustomEvent(PREVIEW_STATE_EVENT, { detail: JSON.stringify(previewState) }));
  }

  function schedulePreviewState() {
    if (previewStateFrame || pointerSelectionActive || textInputIsActive()) return;
    previewStateFrame = window.requestAnimationFrame(() => {
      previewStateFrame = 0;
      emitPreviewState();
    });
  }

  function scheduleKeyupState(event) {
    scheduleState();
    if (![
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"
    ].includes(event?.key)) return;
    if (previewStateFrame) window.cancelAnimationFrame(previewStateFrame);
    previewStateFrame = 0;
    emitPreviewState({ allowDuringTyping: true });
  }

  function scheduleState() {
    if (pointerSelectionActive) return;
    schedulePreviewState();
    if (scheduledState) return;
    scheduledState = true;
    const revision = ++stateScheduleRevision;
    const idleDelay = keyboardIdleDelay();
    if (idleDelay > 0) {
      stateTimer = window.setTimeout(() => emitState(revision), idleDelay);
      return;
    }
    // Outside active typing, a microtask coalesces duplicate editor callbacks.
    queueMicrotask(() => emitState(revision));
  }

  function schedulePointerState() {
    window.clearTimeout(stateTimer);
    stateTimer = 0;
    scheduledState = false;
    pointerStateRevision = ++stateScheduleRevision;
    if (pointerStateFrame) return;
    pointerStateFrame = 1;
    queueMicrotask(() => {
      pointerStateFrame = 0;
      if (pointerStateRevision !== stateScheduleRevision) return;
      // The editor has committed the clicked caret. Publish the lightweight
      // cursor/popup transaction first, then leave the expensive general state
      // consumers to a later browser task so they cannot delay native feedback.
      const state = getEditorState();
      if (!state) return;
      // A suspended background parser can remain on the shared task stack after
      // cancellation. Give the cursor/list transaction its own scope so its
      // small context lookups never inherit that aborted background token.
      const popupTask = interactionTasks?.begin?.("cursor-popup-state", {
        isCurrent: () => pointerStateRevision === stateScheduleRevision,
        surviveKeyboard: true
      });
      try {
        emitPreviewState({ allowDuringTyping: true, state, priority: "pointer" });
      } finally {
        if (popupTask) interactionTasks.end(popupTask);
      }
      window.setTimeout(() => emitState(pointerStateRevision, state), 0);
    });
  }

  document.addEventListener("pointerdown", () => {
    window.clearTimeout(stateTimer);
    stateTimer = 0;
    scheduledState = false;
    stateScheduleRevision += 1;
    pointerSelectionActive = true;
    interactionTasks?.endKeyboardActivity?.();
  }, true);
  document.addEventListener("pointerup", () => {
    pointerSelectionActive = false;
    schedulePointerState();
  }, true);
  document.addEventListener("pointercancel", () => {
    pointerSelectionActive = false;
    schedulePointerState();
  }, true);

  function cleanupCodeMirrorBinding() {
    if (typeof codeMirrorCleanup === "function") codeMirrorCleanup();
    codeMirrorCleanup = null;
  }

  function bindCodeMirror(view) {
    cleanupCodeMirrorBinding();
    const content = codeMirrorContent(view);
    const root = view.dom || content?.closest?.(".cm-editor");
    const scroller = view.scrollDOM || root?.querySelector?.(".cm-scroller");
    const events = [
      "input",
      "keydown",
      "focus",
      "blur",
      "paste",
      "cut",
      "compositionend"
    ];
    for (const eventName of events) {
      content?.addEventListener(eventName, scheduleState, true);
    }
    content?.addEventListener("keyup", scheduleKeyupState, true);
    scroller?.addEventListener("scroll", scheduleOverlayRender, { passive: true });

    const selectionListener = () => {
      const selection = document.getSelection();
      if (selection?.anchorNode && content?.contains(selection.anchorNode)) scheduleState();
    };
    document.addEventListener("selectionchange", selectionListener, true);

    const observer = new MutationObserver(scheduleState);
    if (root) {
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-selected"]
      });
    }

    codeMirrorCleanup = () => {
      for (const eventName of events) {
        content?.removeEventListener(eventName, scheduleState, true);
      }
      content?.removeEventListener("keyup", scheduleKeyupState, true);
      scroller?.removeEventListener("scroll", scheduleOverlayRender);
      document.removeEventListener("selectionchange", selectionListener, true);
      observer.disconnect();
    };
  }

  function bindAceSession(session) {
    if (!session || session === boundSession) return;
    if (boundSession) {
      try {
        boundSession.off("change", scheduleState);
      } catch (_error) {
        // The old editor session may already be disposed.
      }
    }
    boundSession = session;
    boundSession.on("change", scheduleState);
  }

  function bindEditor(found) {
    if (!found?.editor) return;
    if (found.editor === editor && found.kind === editorKind) return;

    cleanupCodeMirrorBinding();
    editor = found.editor;
    editorKind = found.kind;
    boundSession = null;

    if (editorKind === "codemirror") {
      bindCodeMirror(editor);
      scheduleState();
      return;
    }

    bindAceSession(editor.getSession());
    editor.selection?.on?.("changeCursor", scheduleState);
    editor.selection?.on?.("changeSelection", scheduleState);
    editor.on?.("changeSession", () => {
      bindAceSession(editor.getSession());
      scheduleState();
    });
    editor.on?.("focus", scheduleState);
    editor.on?.("blur", scheduleState);
    editor.renderer?.on?.("afterRender", scheduleOverlayRender);
    scheduleState();
  }

  window.addEventListener(COLLABORATION_PROFILE_EVENT, (event) => {
    let detail = {};
    try {
      detail = typeof event.detail === "string"
        ? JSON.parse(event.detail || "{}")
        : (event.detail && typeof event.detail === "object" ? event.detail : {});
    } catch (_error) {
      return;
    }
    collaborationProfile = {
      name: String(detail.name || "Anonymous").trim().slice(0, 80) || "Anonymous",
      color: normalizedHighlightColor(detail.color || "#268bd2"),
      authorId: String(detail.authorId || "")
    };
    scheduleCollaborationPresence(true);
  });

  window.addEventListener(COLLABORATION_DIRTY_EVENT, (event) => {
    let detail = {};
    try {
      detail = typeof event.detail === "string"
        ? JSON.parse(event.detail || "{}")
        : (event.detail && typeof event.detail === "object" ? event.detail : {});
    } catch (_error) {
      return;
    }
    const kind = String(detail.kind || "");
    if (!kind) return;
    pendingCollaborationSignals.set(kind, {
      kind,
      nonce: String(detail.nonce || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      path: String(detail.path || ""),
      fileId: String(detail.fileId || ""),
      entityType: String(detail.entityType || ""),
      payload: detail.payload && typeof detail.payload === "object" ? detail.payload : null
    });
    scheduleCollaborationPresence(true);
  });

  window.addEventListener(COMMENT_OVERLAY_STATE_EVENT, (event) => {
    try {
      const detail = JSON.parse(String(event.detail || "{}"));
      commentOverlayAnchors = Array.isArray(detail?.anchors) ? detail.anchors : [];
      commentIconsVisible = detail?.icons?.visible !== false;
      commentIconOpacity = Math.max(0.15, Math.min(1, Number(detail?.icons?.opacity) || 1));
      commentMarksVisible = detail?.marks?.visible !== false;
      commentMarkOpacity = Math.max(0.05, Math.min(1, Number(detail?.marks?.opacity) || 0.30));
    } catch (_error) {
      commentOverlayAnchors = [];
      commentIconsVisible = true;
      commentIconOpacity = 1;
      commentMarksVisible = true;
      commentMarkOpacity = 0.30;
    }
    scheduleOverlayRender();
  });

  window.addEventListener(CITATION_REQUEST_EVENT, async (event) => {
    let request = {};
    try {
      request = JSON.parse(String(event.detail || "{}"));
    } catch (_error) {
      return;
    }
    const requestId = request.requestId;
    try {
      if (!editor) bindEditor(findEditor());
      if (request.type === "getState") {
        const state = getEditorState();
        citationResponse(requestId, Boolean(state), { state });
        return;
      }
      if (request.type === "getRangeRects") {
        const rects = editorRangeRects(request.start, request.end);
        const anchor = editorScreenPosition(Math.max(0, Number(request.start) || 0));
        const lineHeight = Math.max(2, Number(anchor?.lineHeight) || 16);
        const gutterX = editorGutterBoundaryX();
        const bounds = editorViewportBounds();
        citationResponse(requestId, Boolean(editor), { rects, lineHeight, gutterX, bounds });
        return;
      }
      if (request.type === "getEditorBounds") {
        const bounds = editorViewportBounds();
        citationResponse(requestId, Boolean(bounds), bounds ? { bounds } : {});
        return;
      }
      if (request.type === "getCoordinates") {
        const screen = editorKind === "codemirror"
          ? codeMirrorScreenPosition(Number(request.index))
          : (() => {
            const session = editor?.getSession?.();
            const position = session?.doc?.indexToPosition?.(
              Math.max(0, Math.min(Number(request.index) || 0, session.getValue().length)),
              0
            );
            return aceScreenPosition(position);
          })();
        const bounds = editorViewportBounds();
        citationResponse(requestId, Boolean(screen && bounds), { screen, bounds });
        return;
      }
      if (request.type === "getIndexAtCoordinates") {
        const index = editorIndexAtCoordinates(request.clientX, request.clientY);
        citationResponse(requestId, Number.isFinite(index), { index });
        return;
      }
      if (request.type === "replaceCitationToken") {
        const token = replaceCompletionToken(CITE_COMMAND, String(request.text ?? ""));
        citationResponse(requestId, Boolean(token), token ? { token } : {});
        return;
      }
      if (request.type === "replaceReferenceToken") {
        const token = replaceCompletionToken(REFERENCE_COMMAND, String(request.text ?? ""));
        citationResponse(requestId, Boolean(token), token ? { token } : {});
        return;
      }
      if (request.type === "replaceFigureToken") {
        const token = replaceFigureToken(String(request.text ?? ""));
        citationResponse(requestId, Boolean(token), token ? { token } : {});
        return;
      }
      if (request.type === "setCitationAutocompleteActive") {
        setCitationAutocompleteActive(request.active);
        citationResponse(requestId, Boolean(editor), { active: citationAutocompleteActive });
        return;
      }
      if (request.type === "setReferenceAutocompleteActive") {
        setReferenceAutocompleteActive(request.active);
        citationResponse(requestId, Boolean(editor), { active: referenceAutocompleteActive });
        return;
      }
      if (request.type === "setFigureAutocompleteActive") {
        setFigureAutocompleteActive(request.active);
        citationResponse(requestId, Boolean(editor), { active: figureAutocompleteActive });
        return;
      }
      if (request.type === "focus") {
        editor?.focus?.();
        citationResponse(requestId, Boolean(editor));
        return;
      }
      if (request.type === "resizeEditor") {
        let resized = false;
        try {
          if (editorKind === "ace") {
            editor?.resize?.(true);
            resized = Boolean(editor);
          } else if (editorKind === "codemirror") {
            editor?.requestMeasure?.();
            resized = Boolean(editor);
          }
        } catch (_error) {
          resized = false;
        }
        scheduleOverlayRender();
        citationResponse(requestId, resized);
        return;
      }
      if (request.type === "setCursor") {
        const moved = setCursorIndex(request.index, request.focus !== false);
        citationResponse(requestId, moved, moved ? {
          index: Math.max(0, Number(request.index) || 0)
        } : {});
        return;
      }
      if (request.type === "resolveProjectFile") {
        const file = await resolveProjectFile(request.path);
        citationResponse(requestId, Boolean(file), file ? { file } : {
          error: `Project file not found: ${String(request.path || "")}`
        });
        return;
      }
      if (request.type === "openProjectFile") {
        const item = await revealProjectFile(request.path);
        if (!item) {
          citationResponse(requestId, false, { error: `Project file not found: ${String(request.path || "")}` });
          return;
        }
        const target = item.querySelector(
          "button.item-name-button, button[aria-label], [role='button'], .item-name-button"
        ) || item;
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        citationResponse(requestId, true, { path: treeItemPath(item) || String(request.path || "") });
        return;
      }
      if (request.type === "listProjectFigures") {
        const result = await listProjectFigures({ full: request.full === true });
        citationResponse(requestId, true, result);
        return;
      }
      if (request.type === "readProjectTextFile") {
        const file = await readProjectTextFile(request.path);
        citationResponse(requestId, Boolean(file), file ? { file } : {
          error: `Project text file not found: ${String(request.path || "")}`
        });
        return;
      }
      if (request.type === "readProjectMetadataFile") {
        const file = await readProjectMetadataFile(request.path, {
          fileId: request.fileId,
          entityType: request.entityType
        });
        citationResponse(requestId, true, { file });
        return;
      }
      if (request.type === "probeProjectMetadataFile") {
        const probe = probeProjectMetadataFile(request.path);
        citationResponse(requestId, true, { probe });
        return;
      }
      if (request.type === "writeProjectMetadataFile") {
        const result = await writeProjectMetadataFile(request.path, request.text);
        citationResponse(requestId, true, { result });
        return;
      }
      if (request.type === "moveCursorVertical") {
        const moved = moveCursorVertical(request.direction);
        citationResponse(requestId, moved);
        return;
      }
      if (request.type === "setSelection") {
        const moved = setSelectionRange(
          request.anchor,
          request.head,
          request.focus !== false
        );
        citationResponse(requestId, moved, moved ? {
          anchor: Math.max(0, Number(request.anchor) || 0),
          head: Math.max(0, Number(request.head) || 0)
        } : {});
        return;
      }
      if (request.type === "replaceRange") {
        const replaced = replaceRange(
          request.start,
          request.end,
          request.text,
          {
            selectionStart: request.selectionStart,
            selectionEnd: request.selectionEnd,
            focus: request.focus !== false
          }
        );
        citationResponse(requestId, replaced);
        return;
      }
      citationResponse(requestId, false, {
        error: `Unknown SmartTeX citation request: ${request.type}`
      });
    } catch (error) {
      citationResponse(requestId, false, {
        error: error?.message || String(error)
      });
    }
  });

  window.addEventListener(COLLABTEX_IDENTITY_REFRESH_EVENT, () => {
    if (!lastCollabtexIdentityName) {
      discoverLocalCollabtexIdentity({ allowSettingsFetch: true }).catch(() => {});
    }
  });

  function refreshEditorBinding() {
    editorDiscoveryTimer = 0;
    const found = findEditor();
    if (found) {
      bindEditor(found);
      // Opening or closing Ace/CodeMirror search panels does not necessarily
      // emit an editor render event, but it changes which annotation areas
      // must be masked.
      scheduleOverlayRender();
    }
    if (nativeAutocompleteSuppressed()) hideNativeAutocomplete();
    if (!lastCollabtexIdentityName) scheduleCollabtexIdentityDiscovery(120);
  }

  function scheduleEditorBindingRefresh() {
    const root = editorKind === "codemirror" ? editor?.dom : editor?.container;
    if (editor && root?.isConnected) return;
    if (editorDiscoveryTimer) return;
    editorDiscoveryTimer = window.setTimeout(refreshEditorBinding, keyboardIdleDelay());
  }

  const observer = new MutationObserver(scheduleEditorBindingRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Editor callbacks are authoritative. Polling previously copied the complete
  // source every 250 ms and could put fresh keyboard input behind that work.
  const poll = window.setInterval(() => {
    if (keyboardIdleDelay() > 0) return;
    const root = editorKind === "codemirror" ? editor?.dom : editor?.container;
    if (!editor || !root?.isConnected) refreshEditorBinding();
  }, 1000);

  collaborationSocketPoll = window.setInterval(() => {
    if (keyboardIdleDelay() > 0) return;
    // Search eagerly during bootstrap, then back off to one scan per 10 s on
    // hosts that do not expose their socket through reachable app state.
    if (collaborationSocketSearchMisses < 6 || collaborationSocketSearchMisses % 5 === 0) {
      ensureCollaborationSocket();
    } else {
      collaborationSocketSearchMisses += 1;
    }
  }, 2000);
  collaborationPresenceHeartbeat = window.setInterval(() => {
    // Clear the deduplication key so active collaborators remain discoverable
    // after reconnects while producing only one tiny presence packet per 4 s.
    lastCollaborationPresenceFingerprint = "";
    scheduleCollaborationPresence();
  }, 4000);
  window.setTimeout(() => {
    if (keyboardIdleDelay() === 0) ensureCollaborationSocket();
  }, 1000);
  scheduleCollabtexIdentityDiscovery(0);
  window.setTimeout(() => scheduleCollabtexIdentityDiscovery(0), 500);
  window.setTimeout(() => scheduleCollabtexIdentityDiscovery(0), 1500);
  window.setTimeout(() => scheduleCollabtexIdentityDiscovery(0), 4000);
  window.setTimeout(() => scheduleCollabtexIdentityDiscovery(0, true), 9000);

  window.addEventListener("pagehide", () => {
    window.clearInterval(poll);
    window.clearInterval(collaborationSocketPoll);
    window.clearInterval(collaborationPresenceHeartbeat);
    window.clearTimeout(collaborationPresenceTimer);
    window.clearTimeout(collabtexIdentityDiscoveryTimer);
    window.clearTimeout(stateTimer);
    window.clearTimeout(structureRefreshTimer);
    window.clearTimeout(overlayIdleTimer);
    window.clearTimeout(editorDiscoveryTimer);
    collaborationSocketCleanup?.();
    collaborationSocketCleanup = null;
    collaborationSocket = null;
    cleanupCodeMirrorBinding();
    observer.disconnect();
    numberBadgeLayer?.remove();
    numberBadgeLayer = null;
    commentHighlightLayer?.remove();
    commentHighlightLayer = null;
    commentIconLayer?.remove();
    commentIconLayer = null;
    setCitationAutocompleteActive(false);
    setReferenceAutocompleteActive(false);
  }, { once: true });

  bindEditor(findEditor());
})();
