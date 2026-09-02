/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const blobPromises = new Map();
  const objectUrlPromises = new Map();
  const pdfPreviewPromises = new Map();
  const NOMINAL_TEXT_WIDTH_PX = 520;
  const MIN_POPUP_ZOOM = 1;
  const MAX_POPUP_ZOOM = 5;
  const POPUP_ZOOM_STEP = 0.25;
  const POPUP_ZOOM_OVERSAMPLE = 2;
  const MAX_PREVIEW_RENDER_DIMENSION = 8192;
  const MAX_PREVIEW_RENDER_PIXELS = 48_000_000;
  let pdfModulePromise = null;

  function taskCheckpoint(iteration = 0, interval = 128) {
    globalThis.SmartTeXInteractionTasks?.checkpoint?.(iteration, interval);
  }

  function isPdf(pathValue, blob = null) {
    return (
      /\.pdf(?:$|[?#])/i.test(String(pathValue || "")) ||
      String(blob?.type || "").toLowerCase() === "application/pdf"
    );
  }

  function fetchedBlob(urlValue) {
    const url = String(urlValue || "");
    if (!blobPromises.has(url)) {
      blobPromises.set(url, fetch(url, {
        cache: "force-cache",
        credentials: "include"
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`Figure request failed (${response.status}).`);
        }
        return response.blob();
      }).catch((error) => {
        blobPromises.delete(url);
        throw error;
      }));
    }
    return blobPromises.get(url);
  }

  function cachedObjectUrl(url) {
    if (!objectUrlPromises.has(url)) {
      objectUrlPromises.set(url, fetchedBlob(url)
        .then((blob) => URL.createObjectURL(blob))
        .catch((error) => {
          // A transient first fetch must not poison every later preview attempt
          // for this figure URL with the same permanently rejected promise.
          objectUrlPromises.delete(url);
          throw error;
        }));
    }
    return objectUrlPromises.get(url);
  }

  function invalidateMediaUrl(urlValue) {
    const url = String(urlValue || "");
    blobPromises.delete(url);
    const objectUrl = objectUrlPromises.get(url);
    objectUrlPromises.delete(url);
    objectUrl?.then?.((value) => URL.revokeObjectURL(value)).catch(() => {});
  }

  function pdfModule() {
    if (!pdfModulePromise) {
      const moduleUrl = extensionApi?.runtime?.getURL?.("vendor/pdfjs/pdf.mjs");
      if (!moduleUrl) {
        return Promise.reject(new Error("The bundled PDF renderer is unavailable."));
      }
      pdfModulePromise = import(moduleUrl).then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = extensionApi.runtime.getURL(
          "vendor/pdfjs/pdf.worker.mjs"
        );
        return pdfjs;
      }).catch((error) => {
        pdfModulePromise = null;
        throw error;
      });
    }
    return pdfModulePromise;
  }

  function boundedRenderScale(originalWidth, originalHeight, desiredScale) {
    let scale = Math.max(0.05, Number(desiredScale) || 1);
    const width = Math.max(1, Number(originalWidth) || 1);
    const height = Math.max(1, Number(originalHeight) || 1);
    scale = Math.min(
      scale,
      MAX_PREVIEW_RENDER_DIMENSION / width,
      MAX_PREVIEW_RENDER_DIMENSION / height,
      Math.sqrt(MAX_PREVIEW_RENDER_PIXELS / (width * height))
    );
    return Math.max(0.05, scale);
  }

  function pdfPreviewDataUrl(url, request = {}) {
    const multiplier = Math.max(1, Number(request.multiplier) || 1);
    const targetWidth = Math.max(0, Number(request.targetWidth) || 0);
    const targetHeight = Math.max(0, Number(request.targetHeight) || 0);
    const widthBucket = targetWidth > 0 ? Math.ceil(targetWidth / 128) * 128 : 0;
    const heightBucket = targetHeight > 0 ? Math.ceil(targetHeight / 128) * 128 : 0;
    const cacheKey = targetWidth > 0 || targetHeight > 0
      ? `${url}::target:${widthBucket}x${heightBucket}`
      : `${url}::multiplier:${multiplier}`;
    if (!pdfPreviewPromises.has(cacheKey)) {
      pdfPreviewPromises.set(cacheKey, Promise.all([fetchedBlob(url), pdfModule()])
        .then(async ([blob, pdfjs]) => {
          const data = new Uint8Array(await blob.arrayBuffer());
          const pdf = await pdfjs.getDocument({ data }).promise;
          try {
            const page = await pdf.getPage(1);
            const original = page.getViewport({ scale: 1 });
            const baseScale = Math.max(
              0.35,
              Math.min(2, 1200 / original.width, 1000 / original.height)
            );
            const renderTargetWidth = widthBucket || targetWidth;
            const renderTargetHeight = heightBucket || targetHeight;
            const targetScale = renderTargetWidth > 0 || renderTargetHeight > 0
              ? Math.max(
                renderTargetWidth > 0 ? renderTargetWidth / original.width : 0,
                renderTargetHeight > 0 ? renderTargetHeight / original.height : 0
              )
              : baseScale * multiplier;
            const renderScale = boundedRenderScale(
              original.width,
              original.height,
              targetScale
            );
            const viewport = page.getViewport({ scale: renderScale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            await page.render({
              canvasContext: canvas.getContext("2d", { alpha: false }),
              viewport
            }).promise;
            return {
              dataUrl: canvas.toDataURL("image/png"),
              width: canvas.width,
              height: canvas.height,
              renderScale
            };
          } finally {
            pdf.destroy();
          }
        }).catch((error) => {
          pdfPreviewPromises.delete(cacheKey);
          throw error;
        }));
    }
    return pdfPreviewPromises.get(cacheKey);
  }



  async function createMedia(pathValue, urlValue, options = {}) {
    const path = String(pathValue || "Figure");
    const url = String(urlValue || "");
    const blob = await fetchedBlob(url);
    const pdf = isPdf(path, blob);
    const image = document.createElement("img");
    image.className = pdf
      ? String(options.pdfClass || options.imageClass || "")
      : String(options.imageClass || "");
    image.alt = path;
    image.decoding = "async";
    image.dataset.smarttexFigureSource = url;
    if (pdf) {
      const preview = await pdfPreviewDataUrl(url, { multiplier: 1 });
      image.src = preview.dataUrl;
      image.dataset.smarttexPdfPreview = "true";
      image.dataset.smarttexPdfPreviewWidth = String(preview.width);
      image.dataset.smarttexPdfPreviewHeight = String(preview.height);
      image.dataset.smarttexFigureKind = "pdf";
    } else {
      image.src = await cachedObjectUrl(url);
      image.dataset.smarttexFigureKind = /\.svg(?:$|[?#])/i.test(path) ||
        String(blob?.type || "").toLowerCase() === "image/svg+xml"
        ? "vector"
        : "raster";
    }
    return image;
  }

  function stripComments(value) {
    return String(value || "").replace(/(^|[^\\])%[^\r\n]*/g, "$1");
  }

  function balancedGroup(source, openIndex, openChar = "{", closeChar = "}") {
    if (source[openIndex] !== openChar) return null;
    let depth = 1;
    for (let index = openIndex + 1; index < source.length; index += 1) {
      taskCheckpoint(index - openIndex);
      if (source[index] === "\\") {
        index += 1;
        continue;
      }
      if (source[index] === openChar) depth += 1;
      else if (source[index] === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return {
            start: openIndex,
            contentStart: openIndex + 1,
            contentEnd: index,
            end: index + 1,
            content: source.slice(openIndex + 1, index)
          };
        }
      }
    }
    return null;
  }

  function dimensionModel(value, lineWidthRatio = 1) {
    const text = String(value || "").replace(/\s+/g, "").trim();
    if (!text) return null;
    const relative = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))?\\(linewidth|textwidth|columnwidth)$/i);
    if (relative) {
      const factor = relative[1] === undefined || relative[1] === ""
        ? 1
        : Number(relative[1]);
      if (!Number.isFinite(factor)) return null;
      const unit = relative[2].toLowerCase();
      const totalRatio = factor * (unit === "linewidth" ? lineWidthRatio : 1);
      return {
        source: text,
        unit,
        factor,
        totalRatio,
        localRatio: lineWidthRatio > 0 ? totalRatio / lineWidthRatio : factor,
        fixedPx: null
      };
    }
    const fixed = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(pt|pc|in|cm|mm|px)$/i);
    if (!fixed) return null;
    const number = Number(fixed[1]);
    if (!Number.isFinite(number)) return null;
    const unit = fixed[2].toLowerCase();
    const pxPerUnit = {
      pt: 96 / 72.27,
      pc: 16,
      in: 96,
      cm: 96 / 2.54,
      mm: 96 / 25.4,
      px: 1
    }[unit];
    return {
      source: text,
      unit,
      factor: number,
      totalRatio: null,
      localRatio: null,
      fixedPx: number * pxPerUnit
    };
  }

  function includeGraphicsModels(sourceValue, lineWidthRatio = 1, sourceOffset = 0) {
    const source = String(sourceValue || "");
    const images = [];
    const pattern = /\\includegraphics(?:\s*\[([^\]]*)\])?\s*\{([^{}]+)\}/g;
    let match;
    while ((match = pattern.exec(source))) {
      taskCheckpoint(pattern.lastIndex);
      const options = String(match[1] || "");
      const widthMatch = options.match(/(?:^|,)\s*width\s*=\s*([^,]+)(?:,|$)/i);
      const scaleMatch = options.match(/(?:^|,)\s*scale\s*=\s*([^,]+)(?:,|$)/i);
      const width = widthMatch
        ? dimensionModel(widthMatch[1], lineWidthRatio)
        : null;
      const scale = scaleMatch ? Number(scaleMatch[1]) : 1;
      images.push({
        path: String(match[2] || "").trim(),
        options,
        start: sourceOffset + match.index,
        end: sourceOffset + pattern.lastIndex,
        width,
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1
      });
    }
    return images;
  }

  function widthEnvironmentModels(sourceValue, environmentName) {
    const source = String(sourceValue || "");
    const escapedName = String(environmentName || "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escapedName) return [];
    const tokenPattern = new RegExp(
      `\\\\(begin|end)\\s*\\{\\s*${escapedName}\\s*\\}`,
      "g"
    );
    const stack = [];
    const models = [];
    let match;
    while ((match = tokenPattern.exec(source))) {
      taskCheckpoint(tokenPattern.lastIndex);
      if (match[1] === "begin") {
        let cursor = tokenPattern.lastIndex;
        while (/\s/.test(source[cursor] || "")) cursor += 1;
        if (source[cursor] === "[") {
          const optional = balancedGroup(source, cursor, "[", "]");
          if (optional) cursor = optional.end;
        }
        while (/\s/.test(source[cursor] || "")) cursor += 1;
        const widthGroup = balancedGroup(source, cursor);
        stack.push({
          environment: environmentName,
          beginStart: match.index,
          beginEnd: widthGroup?.end || tokenPattern.lastIndex,
          contentStart: widthGroup?.end || tokenPattern.lastIndex,
          widthSource: widthGroup?.content || ""
        });
        if (widthGroup) tokenPattern.lastIndex = widthGroup.end;
      } else if (stack.length) {
        const opened = stack.pop();
        if (stack.length === 0) {
          models.push({
            ...opened,
            contentEnd: match.index,
            end: tokenPattern.lastIndex,
            source: source.slice(opened.contentStart, match.index)
          });
        }
      }
    }
    return models.sort((left, right) => left.beginStart - right.beginStart);
  }

  function minipageModels(sourceValue) {
    return widthEnvironmentModels(sourceValue, "minipage");
  }

  function subfigureModels(sourceValue) {
    return widthEnvironmentModels(sourceValue, "subfigure");
  }

  function inlineGapOnly(value) {
    let text = stripComments(value);
    text = text
      .replace(/\\hspace\*?\s*\{[^{}]*\}/g, "")
      .replace(/\\(?:hfill|fill|quad|qquad|enspace|thinspace|medspace|thickspace)\b/g, "")
      .replace(/[~\s]/g, "");
    return text.length === 0;
  }

  function panelModel(source, widthRatio, fixedWidthPx, sourceOffset = 0) {
    const images = includeGraphicsModels(source, widthRatio || 1, sourceOffset);
    let inferredRatio = widthRatio;
    if (!(inferredRatio > 0)) {
      inferredRatio = Math.max(
        0,
        ...images.map((image) => image.width?.totalRatio || 0)
      ) || 1;
    }
    return {
      widthRatio: inferredRatio,
      fixedWidthPx: Number.isFinite(fixedWidthPx) ? fixedWidthPx : null,
      images
    };
  }

  function parseFigureLayout(sourceValue, options = {}) {
    const source = String(sourceValue || "");
    const searchable = globalThis.SmartTeXLatexContext?.maskIgnoredLatex?.(source) || source;
    const environment = typeof options === "string"
      ? options
      : String(options?.environment || "");
    const forceStackedRows = environment === "figure";
    const subfigures = subfigureModels(searchable);
    const minipages = minipageModels(searchable);
    const widthContainers = subfigures.length ? subfigures : minipages;
    const panels = [];
    if (widthContainers.length) {
      for (const container of widthContainers) {
        const width = dimensionModel(container.widthSource, 1);
        panels.push({
          ...panelModel(
            container.source,
            width?.totalRatio || null,
            width?.fixedPx || null,
            container.contentStart
          ),
          start: container.beginStart,
          end: container.end,
          environment: container.environment
        });
      }
    } else {
      const images = includeGraphicsModels(searchable, 1, 0);
      for (const image of images) {
        panels.push({
          widthRatio: image.width?.totalRatio || 1,
          fixedWidthPx: image.width?.fixedPx || null,
          images: [image],
          start: image.start,
          end: image.end
        });
      }
    }

    const rows = [];
    let row = null;
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
      taskCheckpoint(panelIndex, 16);
      const panel = panels[panelIndex];
      const previous = row?.items?.at(-1) || null;
      const currentRatio = row?.items?.reduce(
        (sum, item) => sum + Math.max(0, Number(item.widthRatio) || 0),
        0
      ) || 0;
      const nextRatio = Math.max(0, Number(panel.widthRatio) || 0);
      const gap = previous ? searchable.slice(previous.end, panel.start) : "";
      const canShareRow = Boolean(
        !forceStackedRows &&
        row &&
        previous &&
        inlineGapOnly(gap) &&
        currentRatio + nextRatio <= 1.08
      );
      if (!canShareRow) {
        row = { items: [] };
        rows.push(row);
      }
      row.items.push(panel);
    }

    if (!rows.length) {
      rows.push({ items: [{ widthRatio: 1, fixedWidthPx: null, images: [] }] });
    }

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      taskCheckpoint(rowIndex, 16);
      const candidate = rows[rowIndex];
      candidate.fixedWidthPx = candidate.items.reduce(
        (sum, item) => sum + (Number(item.fixedWidthPx) || 0),
        0
      );
      candidate.relativeWidthRatio = candidate.items.reduce(
        (sum, item) => sum + (
          item.fixedWidthPx ? 0 : Math.max(0, Number(item.widthRatio) || 1)
        ),
        0
      );
      candidate.normalizeRelativeWidths = (
        candidate.fixedWidthPx <= 0 && candidate.relativeWidthRatio > 0
      );
    }

    const desiredWidthPx = Math.max(
      40,
      ...rows.map((candidate) => {
        const fixed = candidate.items.reduce(
          (sum, item) => sum + (Number(item.fixedWidthPx) || 0),
          0
        );
        const relative = candidate.items.reduce(
          (sum, item) => sum + (
            item.fixedWidthPx ? 0 : Math.max(0, Number(item.widthRatio) || 1)
          ),
          0
        );
        return fixed + NOMINAL_TEXT_WIDTH_PX * Math.min(1.35, Math.max(relative, 0));
      })
    );

    return {
      source,
      environment,
      rows,
      desiredWidthPx: Math.min(1600, desiredWidthPx),
      nominalTextWidthPx: NOMINAL_TEXT_WIDTH_PX
    };
  }

  function popupAvailableWidth(root) {
    const resizableOutput = root.closest?.(
      "#smarttex-equation-preview[data-smarttex-user-sized='true'] .smarttex-equation-output"
    );
    if (resizableOutput) {
      const style = globalThis.getComputedStyle?.(resizableOutput);
      const padding = (parseFloat(style?.paddingLeft) || 0) +
        (parseFloat(style?.paddingRight) || 0);
      return Math.max(40, resizableOutput.clientWidth - padding);
    }
    const owner = root.closest?.(".smarttex-document-reference-popup");
    if (owner) {
      const style = globalThis.getComputedStyle?.(owner);
      const horizontalPadding = (parseFloat(style?.paddingLeft) || 0) +
        (parseFloat(style?.paddingRight) || 0);
      const hasExplicitWidth = Boolean(owner.style?.width);
      if (
        owner.dataset.smarttexContentKind === "figure" &&
        !owner.classList.contains("smarttex-reference-popup-compact") &&
        !hasExplicitWidth
      ) {
        return Math.max(180, Math.min(520, globalThis.innerWidth - 48));
      }
      const measured = owner.getBoundingClientRect?.().width || owner.clientWidth || 430;
      return Math.max(180, measured - horizontalPadding - 10);
    }
    return Math.max(220, Math.min(
      globalThis.innerWidth * 0.4 - 36,
      520,
      globalThis.innerWidth - 48
    ));
  }

  function popupAvailableHeight(root) {
    const resizableOutput = root.closest?.(
      "#smarttex-equation-preview[data-smarttex-user-sized='true'] .smarttex-equation-output"
    );
    if (resizableOutput) {
      const style = globalThis.getComputedStyle?.(resizableOutput);
      const padding = (parseFloat(style?.paddingTop) || 0) +
        (parseFloat(style?.paddingBottom) || 0);
      const figure = root.closest?.(".smarttex-figure-popup");
      const caption = figure?.querySelector?.(":scope > .smarttex-float-popup-caption");
      const captionHeight = caption?.getBoundingClientRect?.().height || 0;
      const gap = parseFloat(globalThis.getComputedStyle?.(figure)?.rowGap) || 0;
      return Math.max(40, resizableOutput.clientHeight - padding - captionHeight - gap);
    }
    const owner = root.closest?.(".smarttex-document-reference-popup");
    if (owner) {
      if (owner.classList.contains("smarttex-reference-popup-compact")) {
        return Math.max(100, Math.min(170, globalThis.innerHeight - 180));
      }
      return Math.max(110, Math.min(220, globalThis.innerHeight - 180));
    }
    return Math.max(150, Math.min(globalThis.innerHeight * 0.48, 500));
  }

  function imageDesiredHeight(image, displayWidth) {
    const naturalWidth = Number(image?.naturalWidth) || Number(image?.getAttribute?.("width")) || 0;
    const naturalHeight = Number(image?.naturalHeight) || Number(image?.getAttribute?.("height")) || 0;
    if (!(naturalWidth > 0 && naturalHeight > 0)) return displayWidth * 0.62;
    return displayWidth * naturalHeight / naturalWidth;
  }

  function layoutDesiredHeight(root, desiredWidth) {
    let total = 0;
    const rows = [...root.querySelectorAll(":scope > .smarttex-figure-layout-row")];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      taskCheckpoint(rowIndex, 8);
      const row = rows[rowIndex];
      let rowHeight = 0;
      for (const panel of row.children) {
        const ratio = Math.max(0.05, Number(panel.dataset.smarttexWidthRatio) || 1);
        const panelWidth = desiredWidth * ratio;
        let panelHeight = 0;
        const images = [...panel.querySelectorAll("img")];
        if (!images.length) panelHeight = 110;
        for (const image of images) {
          const localRatio = Math.max(
            0.05,
            Number(image.dataset.smarttexLocalWidthRatio) || 1
          );
          const fixed = Number(image.dataset.smarttexFixedWidthPx) || 0;
          const scale = Number(image.dataset.smarttexImageScale) || 1;
          const imageWidth = (fixed > 0 ? fixed : panelWidth * localRatio) * scale;
          panelHeight += imageDesiredHeight(image, imageWidth) + 8;
        }
        rowHeight = Math.max(rowHeight, panelHeight);
      }
      total += Math.max(110, rowHeight) + 10;
    }
    return Math.max(110, total);
  }


  function clampPopupZoom(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return MIN_POPUP_ZOOM;
    return Math.min(MAX_POPUP_ZOOM, Math.max(MIN_POPUP_ZOOM, number));
  }

  async function preparePopupZoomResolution(media, requestedScale, currentScale = 1) {
    const scale = clampPopupZoom(requestedScale);
    const previousScale = Math.max(MIN_POPUP_ZOOM, Number(currentScale) || 1);
    const pdfImages = [...media.querySelectorAll(
      'img[data-smarttex-pdf-preview="true"][data-smarttex-figure-source]'
    )];
    if (!pdfImages.length) return true;
    media.classList.add("smarttex-figure-resolution-loading");
    try {
      await Promise.all(pdfImages.map(async (image) => {
        const source = String(image.dataset.smarttexFigureSource || "");
        if (!source) return;
        if (!image.complete || !(image.naturalWidth > 0)) {
          try {
            await image.decode?.();
          } catch (_error) {
            // The current preview may still be measurable through layout fallbacks.
          }
        }
        const rect = image.getBoundingClientRect();
        const baseWidth = Math.max(
          1,
          (rect.width || image.clientWidth || image.naturalWidth || 1) / previousScale
        );
        const baseHeight = Math.max(
          1,
          (rect.height || image.clientHeight || image.naturalHeight || 1) / previousScale
        );
        const devicePixelRatio = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
        const targetWidth = Math.ceil(
          baseWidth * scale * devicePixelRatio * POPUP_ZOOM_OVERSAMPLE
        );
        const targetHeight = Math.ceil(
          baseHeight * scale * devicePixelRatio * POPUP_ZOOM_OVERSAMPLE
        );
        const currentWidth = Number(image.dataset.smarttexPdfPreviewWidth) || 0;
        const currentHeight = Number(image.dataset.smarttexPdfPreviewHeight) || 0;
        if (currentWidth >= targetWidth && currentHeight >= targetHeight) return;
        const highResolutionPreview = await pdfPreviewDataUrl(source, {
          targetWidth,
          targetHeight
        });
        const probe = new Image();
        probe.decoding = "async";
        probe.src = highResolutionPreview.dataUrl;
        try {
          await probe.decode?.();
        } catch (_error) {
          // Loading the final image element remains a valid fallback.
        }
        image.src = highResolutionPreview.dataUrl;
        image.dataset.smarttexPdfPreviewWidth = String(highResolutionPreview.width);
        image.dataset.smarttexPdfPreviewHeight = String(highResolutionPreview.height);
      }));
      return true;
    } catch (error) {
      console.warn("SmartTeX could not prepare the high-resolution figure preview:", error);
      return false;
    } finally {
      media.classList.remove("smarttex-figure-resolution-loading");
    }
  }


  function hasMeasurablePopupGeometry(node) {
    if (!node?.isConnected || !node.getClientRects?.().length) return false;
    const rect = node.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 1 && rect.height > 1);
  }

  function ensurePopupZoom(figure) {
    // A figure may already be connected while its popup is still hidden. In
    // that state every layout box measures 0x0. Freezing those measurements
    // collapses the image viewport and leaves only the caption visible.
    if (!figure?.isConnected) return null;
    const viewport = figure.querySelector?.(":scope > .smarttex-figure-popup-viewport");
    const media = viewport?.querySelector?.(":scope > .smarttex-figure-popup-media");
    if (!viewport || !media) return null;
    if (!hasMeasurablePopupGeometry(viewport) || !hasMeasurablePopupGeometry(media)) {
      return null;
    }
    if (viewport.__smarttexFigureZoom) return viewport.__smarttexFigureZoom;

    const controls = document.createElement("div");
    controls.className = "smarttex-figure-zoom-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Figure zoom");

    const output = document.createElement("output");
    output.className = "smarttex-figure-zoom-output";
    output.setAttribute("aria-live", "polite");

    const makeButton = (label, title, delta) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = viewport.getBoundingClientRect();
        controller.setScale(
          controller.requestedScale + delta,
          rect.width / 2,
          rect.height / 2
        );
      });
      return button;
    };

    const controller = {
      scale: MIN_POPUP_ZOOM,
      requestedScale: MIN_POPUP_ZOOM,
      zoomRequestId: 0,
      resolutionPromise: null,
      resolutionTargetScale: MIN_POPUP_ZOOM,
      panX: 0,
      panY: 0,
      dragging: false,
      pointerId: null,
      dragClientX: 0,
      dragClientY: 0,
      dragPanX: 0,
      dragPanY: 0,
      viewportBaseInlineHeight: viewport.style.height,
      mediaBaseInlineHeight: media.style.height,
      async ensureResolution(targetScale) {
        let requiredScale = clampPopupZoom(targetScale);
        while (requiredScale > MIN_POPUP_ZOOM + 1e-6) {
          if (this.resolutionPromise) {
            await this.resolutionPromise;
            requiredScale = Math.max(requiredScale, this.requestedScale);
            continue;
          }
          this.resolutionTargetScale = requiredScale;
          controls.setAttribute("aria-busy", "true");
          const task = preparePopupZoomResolution(
            media,
            requiredScale,
            this.scale
          ).finally(() => {
            if (this.resolutionPromise === task) this.resolutionPromise = null;
            controls.removeAttribute("aria-busy");
          });
          this.resolutionPromise = task;
          await task;
          if (this.requestedScale <= requiredScale + 1e-6) return;
          requiredScale = this.requestedScale;
        }
      },
      captureBaseGeometry(force = false) {
        if (!force && Number(media.dataset.smarttexBaseHeightPx) > 0) return;
        if (this.scale > MIN_POPUP_ZOOM + 1e-6 && !force) return;

        const viewportRect = viewport.getBoundingClientRect?.();
        const mediaRect = media.getBoundingClientRect?.();
        const viewportWidth = Math.max(1, viewportRect?.width || viewport.clientWidth || 1);
        const viewportHeight = Math.max(1, viewportRect?.height || viewport.clientHeight || 1);
        const mediaWidth = Math.max(1, mediaRect?.width || media.offsetWidth || viewportWidth);
        const mediaHeight = Math.max(1, mediaRect?.height || media.offsetHeight || viewportHeight);

        viewport.dataset.smarttexBaseViewportWidthPx = String(viewportWidth);
        viewport.dataset.smarttexBaseViewportHeightPx = String(viewportHeight);
        media.dataset.smarttexBaseWidthPx = String(mediaWidth);
        media.dataset.smarttexBaseHeightPx = String(mediaHeight);

        const contentNodes = [...media.querySelectorAll(
          "img, .smarttex-figure-popup-placeholder, .smarttex-document-figure-placeholder"
        )].filter((node) => node.getClientRects?.().length);
        for (const node of contentNodes) {
          if (!(node instanceof HTMLImageElement)) continue;
          const rect = node.getBoundingClientRect();
          const width = Math.max(1, rect.width || node.clientWidth || node.naturalWidth || 1);
          const height = Math.max(1, rect.height || node.clientHeight || node.naturalHeight || 1);
          node.dataset.smarttexBaseWidthPx = String(width);
          node.dataset.smarttexBaseHeightPx = String(height);
        }
        let left = 0;
        let top = 0;
        let right = mediaWidth;
        let bottom = mediaHeight;
        if (contentNodes.length && mediaRect) {
          left = Math.min(...contentNodes.map((node) => node.getBoundingClientRect().left - mediaRect.left));
          top = Math.min(...contentNodes.map((node) => node.getBoundingClientRect().top - mediaRect.top));
          right = Math.max(...contentNodes.map((node) => node.getBoundingClientRect().right - mediaRect.left));
          bottom = Math.max(...contentNodes.map((node) => node.getBoundingClientRect().bottom - mediaRect.top));
        }
        media.dataset.smarttexBaseContentLeftPx = String(Math.max(0, left));
        media.dataset.smarttexBaseContentTopPx = String(Math.max(0, top));
        media.dataset.smarttexBaseContentRightPx = String(Math.max(left + 1, right));
        media.dataset.smarttexBaseContentBottomPx = String(Math.max(top + 1, bottom));
      },
      freezeViewportGeometry() {
        this.captureBaseGeometry();
        const viewportWidth = Math.max(
          1,
          Number(viewport.dataset.smarttexBaseViewportWidthPx) || viewport.clientWidth || 1
        );
        const viewportHeight = Math.max(
          1,
          Number(viewport.dataset.smarttexBaseViewportHeightPx) || viewport.clientHeight || 1
        );
        viewport.style.width = `${viewportWidth}px`;
        viewport.style.height = `${viewportHeight}px`;
        viewport.classList.add("smarttex-figure-popup-viewport-frozen");
        media.classList.add("smarttex-figure-popup-media-pannable");
      },
      refresh() {
        const containerSized = Boolean(
          figure.classList.contains("smarttex-graphic-autocomplete-figure") &&
          figure.closest?.("[data-smarttex-user-sized='true']")
        );
        if (containerSized) {
          viewport.classList.remove("smarttex-figure-popup-viewport-frozen");
          media.classList.remove("smarttex-figure-popup-media-pannable");
          viewport.style.width = "100%";
          viewport.style.height = "100%";
          media.style.width = "100%";
          media.style.height = "100%";
          media.style.maxWidth = "100%";
          media.style.maxHeight = "100%";
          media.style.transform = "none";
          delete viewport.dataset.smarttexBaseViewportWidthPx;
          delete viewport.dataset.smarttexBaseViewportHeightPx;
          delete media.dataset.smarttexBaseWidthPx;
          delete media.dataset.smarttexBaseHeightPx;
          delete media.dataset.smarttexBaseContentLeftPx;
          delete media.dataset.smarttexBaseContentTopPx;
          delete media.dataset.smarttexBaseContentRightPx;
          delete media.dataset.smarttexBaseContentBottomPx;
          for (const node of media.querySelectorAll("img")) {
            delete node.dataset.smarttexBaseWidthPx;
            delete node.dataset.smarttexBaseHeightPx;
            node.style.removeProperty("width");
            node.style.removeProperty("height");
          }
          this.captureBaseGeometry(true);
          this.freezeViewportGeometry();
          this.clampPan();
          this.apply();
          return;
        }
        if (this.scale <= MIN_POPUP_ZOOM + 1e-6) {
          // Restore normal document flow before measuring again. The pannable
          // media is absolutely positioned while frozen; clearing only the
          // viewport height would therefore collapse the viewport to 0px on
          // every refresh.
          viewport.classList.remove("smarttex-figure-popup-viewport-frozen");
          media.classList.remove("smarttex-figure-popup-media-pannable");
          viewport.style.height = this.viewportBaseInlineHeight;
          media.style.height = this.mediaBaseInlineHeight;
          media.style.maxHeight = "";
          media.style.transform = "none";
          delete viewport.dataset.smarttexBaseViewportWidthPx;
          delete viewport.dataset.smarttexBaseViewportHeightPx;
          delete media.dataset.smarttexBaseWidthPx;
          delete media.dataset.smarttexBaseHeightPx;
          delete media.dataset.smarttexBaseContentLeftPx;
          delete media.dataset.smarttexBaseContentTopPx;
          delete media.dataset.smarttexBaseContentRightPx;
          delete media.dataset.smarttexBaseContentBottomPx;
          for (const node of media.querySelectorAll(
            "img, .smarttex-figure-popup-placeholder, .smarttex-document-figure-placeholder"
          )) {
            delete node.dataset.smarttexBaseWidthPx;
            delete node.dataset.smarttexBaseHeightPx;
            if (node instanceof HTMLImageElement && node.dataset.smarttexLocalWidthRatio) {
              node.style.removeProperty("height");
            }
          }
          this.captureBaseGeometry(true);
        }
        this.freezeViewportGeometry();
        this.clampPan();
        this.apply();
      },
      clampPan() {
        if (this.scale <= MIN_POPUP_ZOOM + 1e-6) {
          this.scale = MIN_POPUP_ZOOM;
          this.panX = 0;
          this.panY = 0;
          return;
        }
        this.captureBaseGeometry();
        const viewportWidth = Math.max(
          1,
          Number(viewport.dataset.smarttexBaseViewportWidthPx) || viewport.clientWidth || 1
        );
        const viewportHeight = Math.max(
          1,
          Number(viewport.dataset.smarttexBaseViewportHeightPx) || viewport.clientHeight || 1
        );
        const contentLeft = Math.max(0, Number(media.dataset.smarttexBaseContentLeftPx) || 0) * this.scale;
        const contentTop = Math.max(0, Number(media.dataset.smarttexBaseContentTopPx) || 0) * this.scale;
        const contentRight = Math.max(
          contentLeft + 1,
          Number(media.dataset.smarttexBaseContentRightPx) * this.scale ||
            Number(media.dataset.smarttexBaseWidthPx) * this.scale || 1
        );
        const contentBottom = Math.max(
          contentTop + 1,
          Number(media.dataset.smarttexBaseContentBottomPx) * this.scale ||
            Number(media.dataset.smarttexBaseHeightPx) * this.scale || 1
        );
        const contentWidth = contentRight - contentLeft;
        const contentHeight = contentBottom - contentTop;

        if (contentWidth <= viewportWidth + 0.5) {
          this.panX = (viewportWidth - contentWidth) / 2 - contentLeft;
        } else {
          const minimumX = viewportWidth - contentRight;
          const maximumX = -contentLeft;
          this.panX = Math.min(maximumX, Math.max(minimumX, this.panX));
        }
        if (contentHeight <= viewportHeight + 0.5) {
          this.panY = (viewportHeight - contentHeight) / 2 - contentTop;
        } else {
          const minimumY = viewportHeight - contentBottom;
          const maximumY = -contentTop;
          this.panY = Math.min(maximumY, Math.max(minimumY, this.panY));
        }
      },
      apply() {
        this.captureBaseGeometry();
        this.freezeViewportGeometry();
        const baseWidth = Math.max(
          1,
          Number(media.dataset.smarttexBaseWidthPx) ||
            (media.getBoundingClientRect?.().width || media.clientWidth || 1) / Math.max(1, this.scale)
        );
        const baseHeight = Math.max(
          1,
          Number(media.dataset.smarttexBaseHeightPx) ||
            (media.getBoundingClientRect?.().height || media.clientHeight || 1) / Math.max(1, this.scale)
        );
        const viewportWidth = Math.max(
          1,
          Number(viewport.dataset.smarttexBaseViewportWidthPx) || viewport.clientWidth || 1
        );
        const viewportHeight = Math.max(
          1,
          Number(viewport.dataset.smarttexBaseViewportHeightPx) || viewport.clientHeight || 1
        );
        viewport.style.width = `${viewportWidth}px`;
        viewport.style.height = `${viewportHeight}px`;
        media.style.setProperty("--smarttex-popup-zoom", String(this.scale));
        media.style.width = `${baseWidth * this.scale}px`;
        media.style.height = `${baseHeight * this.scale}px`;
        media.style.maxWidth = this.scale > MIN_POPUP_ZOOM + 1e-6 ? "none" : "100%";
        media.style.maxHeight = this.scale > MIN_POPUP_ZOOM + 1e-6 ? "none" : "100%";
        for (const panel of media.querySelectorAll("[data-smarttex-base-flex-basis-px]")) {
          const base = Number(panel.dataset.smarttexBaseFlexBasisPx) || 0;
          if (base > 0) panel.style.flexBasis = `${base * this.scale}px`;
        }
        for (const image of media.querySelectorAll("[data-smarttex-base-width-px]")) {
          const baseWidth = Number(image.dataset.smarttexBaseWidthPx) || 0;
          const baseHeight = Number(image.dataset.smarttexBaseHeightPx) || 0;
          if (baseWidth > 0) image.style.width = `${baseWidth * this.scale}px`;
          if (baseHeight > 0) image.style.height = `${baseHeight * this.scale}px`;
        }
        media.style.transformOrigin = "0 0";
        media.style.transform = this.scale > MIN_POPUP_ZOOM + 1e-6
          ? `translate3d(${this.panX}px, ${this.panY}px, 0)`
          : "none";
        viewport.classList.toggle(
          "smarttex-figure-popup-zoomed",
          this.scale > MIN_POPUP_ZOOM + 1e-6
        );
        viewport.classList.toggle("smarttex-figure-popup-panning", this.dragging);
        output.value = `${Math.round(this.scale * 100)}%`;
        output.textContent = output.value;
      },
      async setScale(value, anchorX, anchorY) {
        this.requestedScale = clampPopupZoom(value);
        const requestId = ++this.zoomRequestId;
        const pointX = Number.isFinite(Number(anchorX))
          ? Number(anchorX)
          : viewport.clientWidth / 2;
        const pointY = Number.isFinite(Number(anchorY))
          ? Number(anchorY)
          : viewport.clientHeight / 2;
        if (this.requestedScale > MIN_POPUP_ZOOM + 1e-6) {
          await this.ensureResolution(this.requestedScale);
          if (requestId !== this.zoomRequestId) return;
        }
        const nextScale = this.requestedScale;
        const oldScale = this.scale;
        const contentX = (pointX - this.panX) / oldScale;
        const contentY = (pointY - this.panY) / oldScale;
        this.scale = nextScale;
        this.panX = pointX - contentX * nextScale;
        this.panY = pointY - contentY * nextScale;
        this.clampPan();
        this.apply();
      }
    };

    const zoomOut = makeButton("−", "Zoom out", -POPUP_ZOOM_STEP);
    const zoomIn = makeButton("+", "Zoom in", POPUP_ZOOM_STEP);
    controls.append(zoomOut, output, zoomIn);
    viewport.appendChild(controls);

    viewport.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = viewport.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      const factor = Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.0025);
      controller.setScale(controller.requestedScale * factor, anchorX, anchorY);
    }, { passive: false });

    viewport.addEventListener("pointerdown", (event) => {
      if (
        controller.scale <= MIN_POPUP_ZOOM + 1e-6 ||
        event.button !== 0 ||
        event.target.closest?.(".smarttex-figure-zoom-controls")
      ) return;
      event.preventDefault();
      event.stopPropagation();
      controller.dragging = true;
      controller.pointerId = event.pointerId;
      controller.dragClientX = event.clientX;
      controller.dragClientY = event.clientY;
      controller.dragPanX = controller.panX;
      controller.dragPanY = controller.panY;
      try {
        viewport.setPointerCapture?.(event.pointerId);
      } catch (_error) {
        // Synthetic events and older browsers may not expose an active pointer capture.
      }
      controller.apply();
    });

    viewport.addEventListener("pointermove", (event) => {
      if (!controller.dragging || event.pointerId !== controller.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      controller.panX = controller.dragPanX + event.clientX - controller.dragClientX;
      controller.panY = controller.dragPanY + event.clientY - controller.dragClientY;
      controller.clampPan();
      controller.apply();
    });

    const stopDragging = (event) => {
      if (!controller.dragging || event.pointerId !== controller.pointerId) return;
      controller.dragging = false;
      try {
        viewport.releasePointerCapture?.(event.pointerId);
      } catch (_error) {
        // The pointer may already have been released by the browser.
      }
      controller.pointerId = null;
      controller.apply();
    };
    viewport.addEventListener("pointerup", stopDragging);
    viewport.addEventListener("pointercancel", stopDragging);
    viewport.addEventListener("lostpointercapture", () => {
      if (!controller.dragging) return;
      controller.dragging = false;
      controller.pointerId = null;
      controller.apply();
    });

    viewport.__smarttexFigureZoom = controller;
    controller.captureBaseGeometry(true);
    controller.freezeViewportGeometry();
    controller.apply();
    return controller;
  }

  function fitPopupLayout(root) {
    if (!root?.isConnected || !hasMeasurablePopupGeometry(root)) return;
    const desiredWidth = Math.max(
      40,
      Number(root.dataset.smarttexDesiredWidthPx) || NOMINAL_TEXT_WIDTH_PX
    );
    const availableWidth = popupAvailableWidth(root);
    const availableHeight = popupAvailableHeight(root);
    const desiredHeight = layoutDesiredHeight(root, desiredWidth);
    const popup = root.closest?.("[data-smarttex-popup-type]");
    const maximumFitScale = popup?.dataset.smarttexUserSized === "true" ? 4 : 1;
    const popupStyle = popup ? globalThis.getComputedStyle?.(popup) : null;
    const requestedScale = Math.max(
      0.05,
      Number.parseFloat(popupStyle?.getPropertyValue("--smarttex-popup-content-scale")) || 1
    );
    const autoFitScale = Math.max(
      0.75,
      Math.min(
        1,
        Number.parseFloat(popupStyle?.getPropertyValue("--smarttex-popup-auto-fit-scale")) || 1
      )
    );
    const minimumFitScale = requestedScale * autoFitScale;
    const idealScale = Math.min(
      maximumFitScale,
      availableWidth / desiredWidth,
      availableHeight / desiredHeight
    );
    const scale = Math.max(minimumFitScale, idealScale);
    const appliedScale = Number.isFinite(scale) && scale > 0 ? scale : minimumFitScale;
    const viewport = root.closest?.(".smarttex-figure-popup-viewport");
    const figure = root.closest?.(".smarttex-figure-popup");
    const applyLayoutScale = (layoutScale) => {
      const appliedWidth = Math.max(20, desiredWidth * layoutScale);
      root.style.setProperty("--smarttex-figure-popup-scale", String(layoutScale));
      root.dataset.smarttexBaseWidthPx = String(appliedWidth);
      root.style.width = `${appliedWidth}px`;
      for (const panel of root.querySelectorAll(".smarttex-figure-layout-panel")) {
        const fixedPanelWidth = Number(panel.dataset.smarttexFixedPanelWidthPx) || 0;
        if (fixedPanelWidth > 0) {
          const baseFlexBasis = fixedPanelWidth * layoutScale;
          panel.dataset.smarttexBaseFlexBasisPx = String(baseFlexBasis);
          panel.style.flexBasis = `${baseFlexBasis}px`;
        }
      }
      for (const image of root.querySelectorAll("[data-smarttex-local-width-ratio]")) {
        const fixedWidth = Number(image.dataset.smarttexFixedWidthPx) || 0;
        const imageScale = Number(image.dataset.smarttexImageScale) || 1;
        if (fixedWidth > 0) {
          const baseImageWidth = fixedWidth * imageScale * layoutScale;
          image.dataset.smarttexBaseWidthPx = String(baseImageWidth);
          image.style.width = `${baseImageWidth}px`;
        } else {
          delete image.dataset.smarttexBaseWidthPx;
          const localRatio = Math.max(
            0.05,
            Number(image.dataset.smarttexLocalWidthRatio) || 1
          );
          image.style.width = `${localRatio * imageScale * 100}%`;
        }
      }
      if (viewport) {
        viewport.style.width = `${appliedWidth}px`;
        viewport.classList.remove("smarttex-figure-popup-scrollable");
      }
      if (figure) {
        const mainEditorFigure = Boolean(
          popup?.id === "smarttex-equation-preview" &&
          popup?.dataset?.previewKind === "figure" &&
          popup?.dataset?.smarttexUserSized === "true"
        );
        if (mainEditorFigure) {
          // The media viewport is fitted to its aspect ratio, but the figure
          // container itself must span the popup body so the caption gets the
          // complete popup width and remains a dedicated bottom row.
          figure.style.width = "100%";
          figure.style.maxWidth = "100%";
        } else {
          figure.style.width = `${appliedWidth}px`;
          figure.style.maxWidth = `${appliedWidth}px`;
        }
        ensurePopupZoom(figure)?.refresh();
      }
    };

    let finalScale = appliedScale;
    applyLayoutScale(finalScale);

    const resizableOutput = root.closest?.(
      "#smarttex-equation-preview[data-smarttex-user-sized='true'] .smarttex-equation-output"
    );
    if (resizableOutput && figure && viewport) {
      const outputStyle = globalThis.getComputedStyle?.(resizableOutput);
      const horizontalPadding = (parseFloat(outputStyle?.paddingLeft) || 0) +
        (parseFloat(outputStyle?.paddingRight) || 0);
      const verticalPadding = (parseFloat(outputStyle?.paddingTop) || 0) +
        (parseFloat(outputStyle?.paddingBottom) || 0);
      const caption = figure.querySelector?.(":scope > .smarttex-float-popup-caption");
      const captionHeight = caption?.getBoundingClientRect?.().height || 0;
      const gap = parseFloat(globalThis.getComputedStyle?.(figure)?.rowGap) || 0;
      const viewportRect = viewport.getBoundingClientRect();
      const popupRect = popup?.getBoundingClientRect?.() || null;
      const outputRect = resizableOutput.getBoundingClientRect();
      const availableOutputWidth = popupRect
        ? Math.max(20, Math.min(
          resizableOutput.clientWidth,
          popupRect.right - outputRect.left - 1
        ))
        : resizableOutput.clientWidth;
      const availableOutputHeight = popupRect
        ? Math.max(20, Math.min(
          resizableOutput.clientHeight,
          popupRect.bottom - outputRect.top - 1
        ))
        : resizableOutput.clientHeight;
      const widthBudget = Math.max(20, availableOutputWidth - horizontalPadding);
      const heightBudget = Math.max(
        20,
        availableOutputHeight - verticalPadding - captionHeight - gap
      );
      const correction = Math.min(
        1,
        widthBudget / Math.max(1, viewportRect.width),
        heightBudget / Math.max(1, viewportRect.height)
      );
      if (correction < 0.995) {
        finalScale = Math.max(minimumFitScale, finalScale * correction);
        applyLayoutScale(finalScale);
      }
    }

    if (figure) {
      const caption = figure.querySelector?.(":scope > .smarttex-float-popup-caption");
      const captionHeight = Math.max(0, caption?.scrollHeight || caption?.getBoundingClientRect?.().height || 0);
      const gap = parseFloat(globalThis.getComputedStyle?.(figure)?.rowGap) || 0;
      // Expose the complete natural figure height to the outer popup fitter.
      // The popup must grow for media + caption first; the media must not be
      // cropped simply because the current popup happens to be too short.
      figure.dataset.smarttexRequiredHeightPx = String(
        Math.max(1, desiredHeight * finalScale + captionHeight + gap)
      );
    }
  }

  function observePopupLayout(root) {
    if (!root) return;
    // Fit first; fitPopupLayout initializes zoom only after the popup is both
    // visible and measurable. A requestAnimationFrame retry handles the editor
    // preview, which is unhidden immediately after its content is inserted.
    fitPopupLayout(root);
    const update = () => globalThis.requestAnimationFrame?.(() => fitPopupLayout(root));
    for (const image of root.querySelectorAll("img")) {
      if (!image.complete) image.addEventListener("load", update, { once: true });
    }
    update();
  }

  globalThis.SmartTeXFigureRenderer = Object.freeze({
    createMedia,
    ensurePopupZoom,
    fitPopupLayout,
    invalidateMediaUrl,
    isPdf,
    observePopupLayout,
    parseFigureLayout
  });
})();
