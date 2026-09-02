/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (window.top !== window || globalThis.__smartTeXLabelReferenceGuardLoaded) return;
  globalThis.__smartTeXLabelReferenceGuardLoaded = true;

  const SETTINGS_KEY = "smarttex:label-reference-guard:v1";
  const RUNTIME_SETTINGS_EVENT = "smarttex:runtime-settings";
  const STATE_EVENT = "smarttex:editor-state";
  const REQUEST_EVENT = "smarttex:citation-editor-request";
  const RESPONSE_EVENT = "smarttex:citation-editor-response";
  const NAVIGATION_PUSH_EVENT = "smarttex:navigation-history-push";
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const contextTools = globalThis.SmartTeXLatexContext;
  const katex = globalThis.katex;
  const interactionTasks = globalThis.SmartTeXInteractionTasks;
  const pendingRequests = new Map();
  const issueQueue = [];
  const deferredIssues = new Map();

  let requestCounter = 0;
  let enabled = true;
  let runtimeSettingsOverrideActive = false;
  let currentState = null;
  let previousAnalysis = null;
  let currentAnalysis = null;
  let activeIssue = null;
  let dialog = null;
  let previewPopup = null;
  let previewTimer = 0;
  let previewCloseTimer = 0;
  let previewRenderFrame = 0;
  let previewRenderTimer = 0;
  let previewGeneration = 0;
  let placementFrame = 0;
  let placementResizeObserver = null;
  let analysisTimer = 0;
  let analysisRevision = 0;
  let lastAnalyzedSource = null;
  let lastAnalyzedFileName = "";

  function taskCheckpoint(iteration = 0, interval = 128) {
    interactionTasks?.checkpoint?.(iteration, interval);
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 4000) {
    const requestId = `label-guard-${Date.now()}-${++requestCounter}`;
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


  function isEscaped(source, index) {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      slashCount += 1;
    }
    return (slashCount % 2) === 1;
  }

  function balancedGroupEnd(sourceValue, openIndexValue, openCharValue = "{", closeCharValue = "}") {
    const source = String(sourceValue || "");
    const openIndex = Math.max(0, Number(openIndexValue) || 0);
    const openChar = String(openCharValue || "{").charAt(0);
    const closeChar = String(closeCharValue || "}").charAt(0);
    if (source[openIndex] !== openChar) return -1;
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
      if (isEscaped(source, index)) continue;
      if (source[index] === openChar) depth += 1;
      else if (source[index] === closeChar && --depth === 0) return index + 1;
    }
    return -1;
  }

  function lineStartIndex(source, indexValue) {
    return source.lastIndexOf("\n", Math.max(0, Number(indexValue) - 1)) + 1;
  }

  function lineEndIndex(source, indexValue) {
    const newline = source.indexOf("\n", Math.max(0, Number(indexValue) || 0));
    return newline < 0 ? source.length : newline;
  }

  let safeContextSourceCache = "";
  let safeContextEnvironmentRanges = [];
  let safeContextMathRanges = [];

  function latexEnvironmentRanges(sourceValue) {
    const source = String(sourceValue || "");
    if (source === safeContextSourceCache && safeContextEnvironmentRanges.length) {
      return safeContextEnvironmentRanges;
    }
    const ranges = [];
    const stacks = new Map();
    const pattern = /\\(begin|end)\s*\{([^{}]+)\}/g;
    let match;
    while ((match = pattern.exec(source))) {
      const kind = match[1];
      const name = String(match[2] || "").trim();
      if (!name) continue;
      if (kind === "begin") {
        const stack = stacks.get(name) || [];
        stack.push({ start: match.index, openEnd: pattern.lastIndex });
        stacks.set(name, stack);
      } else {
        const stack = stacks.get(name);
        const opening = stack?.pop?.();
        if (opening) {
          ranges.push({
            name,
            start: opening.start,
            openEnd: opening.openEnd,
            closeStart: match.index,
            end: pattern.lastIndex
          });
        }
      }
    }
    ranges.sort((left, right) => left.start - right.start || right.end - left.end);
    safeContextSourceCache = source;
    safeContextEnvironmentRanges = ranges;
    safeContextMathRanges = latexInlineMathRanges(source);
    return ranges;
  }

  function latexInlineMathRanges(sourceValue) {
    const source = String(sourceValue || "");
    const ranges = [];
    let index = 0;
    while (index < source.length) {
      if (source[index] === "%" && !isEscaped(source, index)) {
        const newline = source.indexOf("\n", index + 1);
        index = newline < 0 ? source.length : newline + 1;
        continue;
      }
      let open = "";
      let close = "";
      if (source.startsWith("\\(", index)) {
        open = "\\(";
        close = "\\)";
      } else if (source.startsWith("\\[", index)) {
        open = "\\[";
        close = "\\]";
      } else if (source[index] === "$" && !isEscaped(source, index)) {
        open = source[index + 1] === "$" ? "$$" : "$";
        close = open;
      }
      if (!open) {
        index += 1;
        continue;
      }
      let cursor = index + open.length;
      let closeIndex = -1;
      while (cursor < source.length) {
        if (source[cursor] === "%" && !isEscaped(source, cursor)) {
          const newline = source.indexOf("\n", cursor + 1);
          cursor = newline < 0 ? source.length : newline + 1;
          continue;
        }
        if (source.startsWith(close, cursor) && !isEscaped(source, cursor)) {
          closeIndex = cursor;
          break;
        }
        cursor += 1;
      }
      if (closeIndex < 0) {
        index += open.length;
        continue;
      }
      ranges.push({ start: index, end: closeIndex + close.length });
      index = closeIndex + close.length;
    }
    return ranges;
  }

  const SAFE_CONTEXT_IGNORED_ENVIRONMENTS = new Set(["document"]);

  function rangeContainingBoundary(ranges, boundaryValue, predicate = null) {
    const boundary = Math.max(0, Number(boundaryValue) || 0);
    let best = null;
    for (const range of ranges || []) {
      if (predicate && !predicate(range)) continue;
      if (boundary <= range.start || boundary >= range.end) continue;
      if (!best || (range.end - range.start) < (best.end - best.start)) best = range;
    }
    return best;
  }

  function localContextEnvironment(range) {
    return !SAFE_CONTEXT_IGNORED_ENVIRONMENTS.has(
      String(range?.name || "").trim().replace(/\*$/, "")
    );
  }

  function controlSequenceBounds(sourceValue, boundaryValue) {
    const source = String(sourceValue || "");
    const boundary = Math.max(0, Math.min(source.length, Number(boundaryValue) || 0));
    let start = boundary;
    while (start > 0 && /[A-Za-z@*]/.test(source[start - 1])) start -= 1;
    if (start > 0 && source[start - 1] === "\\") start -= 1;
    if (source[start] !== "\\") return null;
    let end = start + 1;
    if (/[A-Za-z@]/.test(source[end] || "")) {
      while (end < source.length && /[A-Za-z@]/.test(source[end])) end += 1;
      if (source[end] === "*") end += 1;
    } else {
      end = Math.min(source.length, end + 1);
    }
    return boundary > start && boundary < end ? { start, end } : null;
  }

  function commandStartBeforeGroup(sourceValue, openIndexValue) {
    const source = String(sourceValue || "");
    let cursor = Math.max(0, Number(openIndexValue) || 0);
    while (cursor > 0 && /\s/.test(source[cursor - 1])) cursor -= 1;
    // Skip preceding optional/required arguments to find the command owning a
    // later argument, for example the second group of \\frac{a}{b}.
    while (cursor > 0 && (source[cursor - 1] === "}" || source[cursor - 1] === "]")) {
      const close = source[cursor - 1];
      const open = close === "}" ? "{" : "[";
      let depth = 1;
      let index = cursor - 2;
      for (; index >= 0; index -= 1) {
        if (isEscaped(source, index)) continue;
        if (source[index] === close) depth += 1;
        else if (source[index] === open && --depth === 0) break;
      }
      if (index < 0) break;
      cursor = index;
      while (cursor > 0 && /\s/.test(source[cursor - 1])) cursor -= 1;
    }
    let end = cursor;
    if (source[end - 1] === "*") end -= 1;
    let start = end;
    while (start > 0 && /[A-Za-z@]/.test(source[start - 1])) start -= 1;
    if (start > 0 && source[start - 1] === "\\") return start - 1;
    return -1;
  }

  function commandInvocationEnd(sourceValue, commandStartValue) {
    const source = String(sourceValue || "");
    const commandStart = Math.max(0, Number(commandStartValue) || 0);
    const command = previewCommandAt(source, commandStart);
    if (!command) return commandStart;
    let cursor = command.end;
    while (cursor < source.length) {
      const whitespaceStart = cursor;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] !== "{" && source[cursor] !== "[") {
        return whitespaceStart === cursor ? cursor : whitespaceStart;
      }
      const close = source[cursor] === "{" ? "}" : "]";
      const groupEnd = balancedGroupEnd(source, cursor, source[cursor], close);
      if (groupEnd <= cursor) return cursor;
      cursor = groupEnd;
    }
    return cursor;
  }

  function commandInvocationContainingBoundary(sourceValue, boundaryValue) {
    const source = String(sourceValue || "");
    const boundary = Math.max(0, Math.min(source.length, Number(boundaryValue) || 0));
    const stack = [];
    for (let index = 0; index < boundary; index += 1) {
      if (source[index] === "%" && !isEscaped(source, index)) {
        const newline = source.indexOf("\n", index + 1);
        index = newline < 0 ? source.length : newline;
        continue;
      }
      if (isEscaped(source, index)) continue;
      if (source[index] === "{" || source[index] === "[") stack.push({ char: source[index], index });
      else if (source[index] === "}" || source[index] === "]") {
        const expected = source[index] === "}" ? "{" : "[";
        for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
          if (stack[stackIndex].char === expected) {
            stack.splice(stackIndex, 1);
            break;
          }
        }
      }
    }
    for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
      const openIndex = stack[stackIndex].index;
      const close = stack[stackIndex].char === "{" ? "}" : "]";
      const groupEnd = balancedGroupEnd(source, openIndex, stack[stackIndex].char, close);
      if (groupEnd <= boundary) continue;
      const commandStart = commandStartBeforeGroup(source, openIndex);
      if (commandStart < 0) continue;
      return {
        start: commandStart,
        end: Math.max(groupEnd, commandInvocationEnd(source, commandStart))
      };
    }
    return null;
  }

  function safeLatexContextBounds(sourceValue, startValue, endValue, optionsValue = {}) {
    const source = String(sourceValue || "");
    const options = optionsValue && typeof optionsValue === "object" ? optionsValue : {};
    let start = Math.max(0, Math.min(source.length, Number(startValue) || 0));
    let end = Math.max(start, Math.min(source.length, Number(endValue) || start));
    const hardStart = Math.max(
      0,
      Math.min(start, Number.isFinite(Number(options.hardStart)) ? Number(options.hardStart) : start - 320)
    );
    const hardEnd = Math.min(
      source.length,
      Math.max(end, Number.isFinite(Number(options.hardEnd)) ? Number(options.hardEnd) : end + 320)
    );
    const maximumEnvironmentLength = Math.max(
      0,
      Number.isFinite(Number(options.maximumEnvironmentLength))
        ? Number(options.maximumEnvironmentLength)
        : 1200
    );
    const maximumSyntaxLength = Math.max(
      80,
      Number.isFinite(Number(options.maximumSyntaxLength))
        ? Number(options.maximumSyntaxLength)
        : 1000
    );
    const environments = latexEnvironmentRanges(source);
    const mathRanges = source === safeContextSourceCache
      ? safeContextMathRanges
      : latexInlineMathRanges(source);

    function includeOrExcludeStart(range) {
      if (!range) return;
      const length = Math.max(0, range.end - range.start);
      if (length <= maximumSyntaxLength && range.start >= hardStart) {
        start = Math.min(start, range.start);
      } else if (range.end <= end) {
        start = Math.max(start, range.end);
      }
    }

    function includeOrExcludeEnd(range) {
      if (!range) return;
      const length = Math.max(0, range.end - range.start);
      if (length <= maximumSyntaxLength && range.end <= hardEnd) {
        end = Math.max(end, range.end);
      } else if (range.start >= start) {
        end = Math.min(end, range.start);
      }
    }

    for (let pass = 0; pass < 8; pass += 1) {
      const previousStart = start;
      const previousEnd = end;
      const startControl = controlSequenceBounds(source, start);
      const endControl = controlSequenceBounds(source, end);
      includeOrExcludeStart(startControl);
      includeOrExcludeEnd(endControl);

      const startMath = rangeContainingBoundary(mathRanges, start);
      const endMath = rangeContainingBoundary(mathRanges, end);
      includeOrExcludeStart(startMath);
      includeOrExcludeEnd(endMath);

      const startEnvironment = rangeContainingBoundary(
        environments,
        start,
        (range) => localContextEnvironment(range) &&
          (range.end - range.start) <= maximumEnvironmentLength &&
          range.start >= hardStart
      );
      const endEnvironment = rangeContainingBoundary(
        environments,
        end,
        (range) => localContextEnvironment(range) &&
          (range.end - range.start) <= maximumEnvironmentLength &&
          range.end <= hardEnd
      );
      if (startEnvironment) start = Math.min(start, startEnvironment.start);
      if (endEnvironment) end = Math.max(end, endEnvironment.end);

      const startCommand = commandInvocationContainingBoundary(source, start);
      const endCommand = commandInvocationContainingBoundary(source, end);
      includeOrExcludeStart(startCommand);
      includeOrExcludeEnd(endCommand);

      start = Math.max(hardStart, Math.min(start, end));
      end = Math.min(hardEnd, Math.max(end, start));
      if (start === previousStart && end === previousEnd) break;
    }
    return { start, end };
  }

  function surroundingSentenceContextDetails(
    sourceValue,
    indexValue,
    beforeCount = 3,
    afterCount = 3,
    occurrenceEndValue = null
  ) {
    const source = String(sourceValue || "");
    const index = Math.max(0, Math.min(source.length, Number(indexValue) || 0));
    const occurrenceEnd = Math.max(
      index,
      Math.min(
        source.length,
        Number.isFinite(Number(occurrenceEndValue)) ? Number(occurrenceEndValue) : index
      )
    );
    const maximumBeforeSentences = Math.max(0, Math.min(4, Number(beforeCount) || 0));
    const maximumAfterSentences = Math.max(0, Math.min(4, Number(afterCount) || 0));
    const windowStart = Math.max(0, index - 4200);
    const windowEnd = Math.min(source.length, occurrenceEnd + 4200);
    const sample = source.slice(windowStart, windowEnd);
    const localIndex = index - windowStart;
    const localOccurrenceEnd = occurrenceEnd - windowStart;
    const boundaries = [0];
    const boundaryPattern = /(?:[.!?](?:["')\]]*)\s+|\n\s*\n+)/g;
    let match;
    while ((match = boundaryPattern.exec(sample))) boundaries.push(match.index + match[0].length);
    if (boundaries[boundaries.length - 1] !== sample.length) boundaries.push(sample.length);

    function sentenceIndexAt(position) {
      let low = 0;
      let high = boundaries.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (boundaries[middle] <= position) low = middle;
        else high = middle - 1;
      }
      return Math.min(boundaries.length - 2, low);
    }

    const startSentenceIndex = sentenceIndexAt(localIndex);
    const endSentenceIndex = sentenceIndexAt(Math.max(localIndex, localOccurrenceEnd - 1));
    let beforeSentences = Math.min(maximumBeforeSentences, startSentenceIndex);
    let afterSentences = Math.min(
      maximumAfterSentences,
      Math.max(0, boundaries.length - 2 - endSentenceIndex)
    );

    function candidateBounds(beforeValue, afterValue) {
      return {
        start: boundaries[Math.max(0, startSentenceIndex - beforeValue)] || 0,
        end: boundaries[
          Math.min(boundaries.length - 1, endSentenceIndex + afterValue + 1)
        ] ?? sample.length
      };
    }

    // Keep the amount of prose on both sides of the concrete reference roughly
    // balanced. Remove only complete outer sentences, never split a sentence
    // merely to obtain exact character symmetry.
    for (let pass = 0; pass < 8; pass += 1) {
      const candidate = candidateBounds(beforeSentences, afterSentences);
      const leftLength = Math.max(1, localIndex - candidate.start);
      const rightLength = Math.max(1, candidate.end - localOccurrenceEnd);
      if (leftLength > rightLength * 1.55 && beforeSentences > 1) {
        beforeSentences -= 1;
        continue;
      }
      if (rightLength > leftLength * 1.55 && afterSentences > 1) {
        afterSentences -= 1;
        continue;
      }
      break;
    }

    let { start, end } = candidateBounds(beforeSentences, afterSentences);
    while (start < end && /\s/.test(sample[start])) start += 1;
    while (end > start && /\s/.test(sample[end - 1])) end -= 1;

    const absoluteStart = windowStart + start;
    const absoluteEnd = windowStart + end;
    const safetyAllowance = 280;
    const safe = safeLatexContextBounds(source, absoluteStart, absoluteEnd, {
      hardStart: Math.max(0, absoluteStart - safetyAllowance),
      hardEnd: Math.min(source.length, absoluteEnd + safetyAllowance),
      maximumEnvironmentLength: 0,
      maximumSyntaxLength: 900
    });

    // A local excerpt may begin with an opening environment token whose closing
    // token lies outside the excerpt (or vice versa). Remove only that unmatched
    // wrapper token instead of expanding to the complete potentially huge
    // environment. The content around the reference remains renderable as a
    // standalone fragment.
    let finalStart = safe.start;
    let finalEnd = safe.end;
    for (const range of latexEnvironmentRanges(source)) {
      if (
        range.start >= finalStart &&
        range.openEnd <= finalEnd &&
        range.end > finalEnd
      ) {
        finalStart = Math.max(finalStart, commandInvocationEnd(source, range.start), range.openEnd);
      }
      if (
        range.start < finalStart &&
        range.closeStart >= finalStart &&
        range.end <= finalEnd
      ) {
        finalEnd = Math.min(finalEnd, range.closeStart);
      }
    }
    while (finalStart < finalEnd && /\s/.test(source[finalStart])) finalStart += 1;
    while (finalEnd > finalStart && /\s/.test(source[finalEnd - 1])) finalEnd -= 1;

    return {
      text: source.slice(finalStart, finalEnd),
      start: finalStart,
      end: finalEnd,
      beforeSentences,
      afterSentences
    };
  }

  function surroundingSentenceContext(
    sourceValue,
    indexValue,
    beforeCount = 3,
    afterCount = 3,
    occurrenceEndValue = null
  ) {
    return surroundingSentenceContextDetails(
      sourceValue,
      indexValue,
      beforeCount,
      afterCount,
      occurrenceEndValue
    ).text;
  }

  function lineStartOffsets(sourceValue) {
    const source = String(sourceValue || "");
    const offsets = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source.charCodeAt(index) === 10) offsets.push(index + 1);
    }
    return offsets;
  }

  function lineNumberFromOffsets(offsetsValue, indexValue) {
    const offsets = Array.isArray(offsetsValue) ? offsetsValue : [0];
    const index = Math.max(0, Number(indexValue) || 0);
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle] <= index) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  }

  function rangeContaining(rangesValue, indexValue) {
    const ranges = Array.isArray(rangesValue) ? rangesValue : [];
    const index = Number(indexValue) || 0;
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const range = ranges[middle];
      const start = Number(range?.openStart ?? range?.start) || 0;
      const end = Number(range?.closeEnd ?? range?.end) || start;
      if (index < start) high = middle - 1;
      else if (index > end) low = middle + 1;
      else return range;
    }
    return null;
  }

  function previousSection(sectionsValue, indexValue) {
    const sections = Array.isArray(sectionsValue) ? sectionsValue : [];
    const index = Number(indexValue) || 0;
    let low = 0;
    let high = sections.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((Number(sections[middle]?.sourceIndex) || 0) <= index) low = middle + 1;
      else high = middle;
    }
    return low > 0 ? sections[low - 1] : null;
  }

  function normalizedDefinitionSignature(sourceValue, labelIndexValue, commandEndValue, targetValue) {
    const source = String(sourceValue || "");
    const labelIndex = Math.max(0, Number(labelIndexValue) || 0);
    const commandEnd = Math.max(labelIndex, Number(commandEndValue) || labelIndex);
    const before = source.slice(Math.max(0, labelIndex - 180), labelIndex);
    const after = source.slice(commandEnd, Math.min(source.length, commandEnd + 180));
    const surrounding = `${before}\\label{#}${after}`
      .replace(/%[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const target = targetValue || {};
    return [
      String(target.type || "label"),
      String(target.number || ""),
      String(target.title || target.caption || "").replace(/\s+/g, " ").trim().slice(0, 180),
      surrounding
    ].join("|");
  }

  function sourceAnalysis(stateValue) {
    const state = stateValue || {};
    const source = String(state.value || "");
    const fileName = String(state.fileName || "");
    const masked = contextTools?.maskIgnoredLatex?.(source) || source;
    const equations = contextTools?.equationContexts?.(source)?.contexts || [];
    const figures = contextTools?.figureContexts?.(source) || [];
    const tables = contextTools?.tableFloatContexts?.(source) || [];
    const sections = contextTools?.sectionNumbering?.(source) || [];
    const definitions = [];
    const seen = new Set();
    const lineOffsets = lineStartOffsets(source);
    const labelPattern = /\\label\s*\{([^{}]+)\}/g;
    let match;

    while ((match = labelPattern.exec(masked))) {
      taskCheckpoint(labelPattern.lastIndex, 64);
      const label = String(match[1] || "").trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const labelIndex = match.index;
      const openIndex = source.indexOf("{", labelIndex);
      const commandEnd = openIndex >= 0 ? balancedGroupEnd(source, openIndex) : -1;
      const rawBody = openIndex >= 0 && commandEnd > openIndex
        ? source.slice(openIndex + 1, commandEnd - 1)
        : label;
      const leading = rawBody.match(/^\s*/)?.[0]?.length || 0;
      const trailing = rawBody.match(/\s*$/)?.[0]?.length || 0;
      const valueStart = openIndex >= 0 ? openIndex + 1 + leading : labelIndex;
      const valueEnd = openIndex >= 0
        ? Math.max(valueStart, commandEnd - 1 - trailing)
        : valueStart + label.length;
      const equation = rangeContaining(equations, labelIndex);
      const figure = equation ? null : rangeContaining(figures, labelIndex);
      const table = equation || figure ? null : rangeContaining(tables, labelIndex);
      const section = equation || figure || table ? null : previousSection(sections, labelIndex);
      let target;
      if (equation) {
        target = { type: "equation", number: "", sourceIndex: equation.openStart };
      } else if (figure) {
        target = {
          type: "figure",
          number: "",
          caption: "",
          sourceIndex: figure.openStart
        };
      } else if (table) {
        target = {
          type: "table",
          number: "",
          caption: "",
          sourceIndex: table.openStart
        };
      } else if (section) {
        target = {
          type: "section",
          number: String(section.number || ""),
          title: String(section.title || ""),
          sourceIndex: section.sourceIndex
        };
      } else {
        target = { type: "label", number: "", sourceIndex: labelIndex };
      }
      definitions.push({
        label,
        sourceIndex: labelIndex,
        valueStart,
        valueEnd,
        commandEnd: commandEnd > 0 ? commandEnd : valueEnd,
        documentOrder: definitions.length,
        definitionSignature: normalizedDefinitionSignature(
          source,
          labelIndex,
          commandEnd > 0 ? commandEnd : valueEnd,
          target
        ),
        target
      });
    }

    const usages = [];
    const referencePattern = /\\(eqref|ref|pageref|autoref|cref|Cref|vref|Vref|nameref)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/g;
    while ((match = referencePattern.exec(masked))) {
      taskCheckpoint(referencePattern.lastIndex, 64);
      const command = String(match[1] || "ref");
      const openIndex = source.indexOf("{", match.index);
      const closeIndex = match.index + match[0].length - 1;
      if (openIndex < match.index || closeIndex <= openIndex) continue;
      const rawArgument = source.slice(openIndex + 1, closeIndex);
      const equation = rangeContaining(equations, match.index);
      const sourceLineStart = lineStartIndex(source, match.index);
      const sourceLineEnd = lineEndIndex(source, match.index);
      let excerpt = source.slice(sourceLineStart, sourceLineEnd).trim();
      if (excerpt.length > 280) excerpt = `${excerpt.slice(0, 277)}…`;
      let segmentStart = 0;
      const segments = rawArgument.split(",");
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        taskCheckpoint(segmentIndex, 8);
        const segment = segments[segmentIndex];
        const leading = segment.match(/^\s*/)?.[0]?.length || 0;
        const trailing = segment.match(/\s*$/)?.[0]?.length || 0;
        const label = segment.slice(leading, Math.max(leading, segment.length - trailing));
        if (label) {
          const labelStart = openIndex + 1 + segmentStart + leading;
          usages.push({
            label,
            command,
            commandStart: match.index,
            commandEnd: match.index + match[0].length,
            labelStart,
            labelEnd: labelStart + label.length,
            sourceIndex: match.index,
            lineNumber: lineNumberFromOffsets(lineOffsets, match.index),
            excerpt,
            equation: Boolean(equation),
            previewLatex: equation
              ? source.slice(Number(equation.contentStart) || 0, Number(equation.contentEnd) || 0).slice(0, 12000)
              : ""
          });
        }
        segmentStart += segment.length + 1;
      }
    }

    return {
      fileName,
      revision: ++analysisRevision,
      source,
      references: definitions,
      referenceUsages: usages
    };
  }

  function runScheduledAnalysis() {
    analysisTimer = 0;
    const state = currentState;
    if (!state) return;
    const source = String(state.value || "");
    const fileName = String(state.fileName || "");
    if (source === lastAnalyzedSource && fileName === lastAnalyzedFileName) return;
    if (interactionTasks?.canRunLongTask &&
        !interactionTasks.canRunLongTask(state, source.length)) return;
    let result;
    try {
      result = interactionTasks?.runSync
        ? interactionTasks.runSync("label-reference-analysis", () => sourceAnalysis(state))
        : sourceAnalysis(state);
    } catch (error) {
      if (interactionTasks?.isAbortError?.(error)) {
        scheduleAnalysis({ delay: 500 });
        return;
      }
      throw error;
    }
    if (
      !currentState ||
      String(currentState.value || "") !== source ||
      String(currentState.fileName || "") !== fileName
    ) {
      scheduleAnalysis();
      return;
    }
    lastAnalyzedSource = source;
    lastAnalyzedFileName = fileName;
    processAnalysis(result);
  }

  function scheduleAnalysis({ immediate = false, delay = null } = {}) {
    window.clearTimeout(analysisTimer);
    const requestedWait = delay === null ? (immediate ? 0 : 500) : Math.max(0, Number(delay) || 0);
    const wait = Math.max(
      requestedWait,
      Number(interactionTasks?.keyboardIdleRemaining?.()) || 0
    );
    analysisTimer = window.setTimeout(runScheduledAnalysis, wait);
  }

  interactionTasks?.subscribe?.(() => {
    window.clearTimeout(analysisTimer);
    analysisTimer = 0;
    window.clearTimeout(previewTimer);
    previewTimer = 0;
    window.clearTimeout(previewCloseTimer);
    window.clearTimeout(previewRenderTimer);
    previewCloseTimer = 0;
    previewRenderTimer = 0;
    if (previewRenderFrame) window.cancelAnimationFrame(previewRenderFrame);
    previewRenderFrame = 0;
    if (placementFrame) window.cancelAnimationFrame(placementFrame);
    placementFrame = 0;
    // The next post-idle state event schedules analysis when the source changed.
  });

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

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width >= 180 &&
      rect.height >= 140 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        if (isVisible(candidate)) return candidate;
      }
    }
    return null;
  }

  function preferredDialogArea() {
    const fileArea = firstVisible([
      "#ide-redesign-panel-file-tree",
      "[data-testid*='file-tree' i]",
      ".file-tree-list",
      ".file-tree"
    ]);
    if (fileArea) return fileArea;

    const pdfArea = firstVisible([
      "#ide-redesign-panel-pdf",
      "[data-testid*='pdf' i]",
      ".pdf-pane",
      ".pdf-viewer"
    ]);
    return pdfArea || fileArea;
  }

  function placeDialog() {
    placementFrame = 0;
    if (!dialog?.isConnected) return;
    const margin = 10;
    const area = preferredDialogArea();
    if (area) {
      const rect = area.getBoundingClientRect();
      const width = Math.max(190, Math.min(520, rect.width - margin * 2));
      const maxHeight = Math.max(220, rect.height - margin * 2);
      dialog.style.left = `${Math.round(rect.left + margin)}px`;
      dialog.style.top = `${Math.round(rect.top + margin)}px`;
      dialog.style.width = `${Math.round(width)}px`;
      dialog.style.maxHeight = `${Math.round(maxHeight)}px`;
      dialog.dataset.placement = area.matches(".file-tree-list, .file-tree, #ide-redesign-panel-file-tree, [data-testid*='file-tree' i]")
        ? "files"
        : "pdf";
      return;
    }

    const width = Math.min(480, Math.max(280, window.innerWidth * 0.34));
    dialog.style.left = `${Math.max(12, Math.round(window.innerWidth - width - 18))}px`;
    dialog.style.top = "72px";
    dialog.style.width = `${Math.round(width)}px`;
    dialog.style.maxHeight = `${Math.max(260, window.innerHeight - 96)}px`;
    dialog.dataset.placement = "viewport";
  }

  function scheduleDialogPlacement() {
    if (placementFrame) return;
    placementFrame = window.requestAnimationFrame(placeDialog);
  }

  function targetIdentity(record) {
    const target = record?.target || {};
    return [
      String(target.type || "label"),
      String(target.number || ""),
      String(target.title || target.caption || "").replace(/\s+/g, " ").trim()
    ].join("|");
  }

  function matchRenamedDefinition(oldRecord, addedRecords, usedLabels) {
    const available = addedRecords.filter((record) => !usedLabels.has(record.label));
    const exact = available.filter((record) => (
      record.definitionSignature &&
      record.definitionSignature === oldRecord.definitionSignature
    ));
    if (exact.length === 1) return exact[0];

    const oldIdentity = targetIdentity(oldRecord);
    const sameTarget = available.filter((record) => (
      targetIdentity(record) === oldIdentity &&
      Number(record.documentOrder) === Number(oldRecord.documentOrder)
    ));
    return sameTarget.length === 1 ? sameTarget[0] : null;
  }

  function changedLabelIssues(previous, current) {
    const previousDefinitions = Array.isArray(previous?.references) ? previous.references : [];
    const currentDefinitions = Array.isArray(current?.references) ? current.references : [];
    const currentUsages = Array.isArray(current?.referenceUsages) ? current.referenceUsages : [];
    const previousByLabel = new Map(previousDefinitions.map((record) => [record.label, record]));
    const currentByLabel = new Map(currentDefinitions.map((record) => [record.label, record]));
    const removed = previousDefinitions.filter((record) => !currentByLabel.has(record.label));
    const added = currentDefinitions.filter((record) => !previousByLabel.has(record.label));
    const usedAddedLabels = new Set();
    const issues = [];

    for (const oldRecord of removed) {
      const usages = currentUsages
        .filter((usage) => String(usage.label || "") === String(oldRecord.label || ""))
        .map((usage, index) => ({ ...usage, guardId: `${usage.commandStart}:${usage.labelStart}:${index}` }));
      if (!usages.length) continue;
      const replacementRecord = matchRenamedDefinition(oldRecord, added, usedAddedLabels);
      if (replacementRecord) usedAddedLabels.add(replacementRecord.label);
      issues.push({
        fileName: String(current.fileName || ""),
        revision: Number(current.revision) || 0,
        oldLabel: String(oldRecord.label || ""),
        newLabel: replacementRecord ? String(replacementRecord.label || "") : "",
        changed: Boolean(replacementRecord),
        oldRecord,
        replacementRecord,
        usages,
        previewSource: String(current.source || ""),
        previousSource: String(previous.source || "")
      });
    }
    return issues;
  }

  function issueKey(issue) {
    return `${issue.fileName}\n${issue.oldLabel}\n${issue.newLabel}`;
  }

  function enqueueIssue(issue) {
    const key = issueKey(issue);
    if (activeIssue && issueKey(activeIssue) === key) return;
    if (issueQueue.some((candidate) => issueKey(candidate) === key)) return;
    issueQueue.push(issue);
    showNextIssue();
  }

  function labelFieldAtCursor(stateValue = currentState) {
    const state = stateValue || {};
    const source = String(state.value || "");
    const cursorIndex = Math.max(0, Number(state.cursorIndex) || 0);
    const masked = contextTools?.maskIgnoredLatex?.(source) || source;
    const pattern = /\\label\s*\{/g;
    let match;
    while ((match = pattern.exec(masked))) {
      const openIndex = masked.lastIndexOf("{", pattern.lastIndex - 1);
      if (openIndex < 0) continue;
      const groupEnd = balancedGroupEnd(source, openIndex);
      const valueEnd = groupEnd > 0 ? groupEnd - 1 : lineEndIndex(source, openIndex);
      if (cursorIndex < openIndex + 1 || cursorIndex > valueEnd) continue;
      return {
        sourceIndex: match.index,
        valueStart: openIndex + 1,
        valueEnd,
        label: source.slice(openIndex + 1, valueEnd).trim()
      };
    }
    return null;
  }

  function deferredIssueKey(issueOrRecord, fileNameValue = "") {
    const oldLabel = String(issueOrRecord?.oldLabel || issueOrRecord?.label || "");
    const fileName = String(issueOrRecord?.fileName || fileNameValue || "");
    return `${fileName}\n${oldLabel}`;
  }

  function issueForOldRecord(oldRecordValue, analysisValue) {
    const oldRecord = oldRecordValue || {};
    const analysis = analysisValue || {};
    const definitions = Array.isArray(analysis.references) ? analysis.references : [];
    const usages = (Array.isArray(analysis.referenceUsages) ? analysis.referenceUsages : [])
      .filter((usage) => String(usage.label || "") === String(oldRecord.label || ""))
      .map((usage, index) => ({ ...usage, guardId: `${usage.commandStart}:${usage.labelStart}:${index}` }));
    if (definitions.some((record) => record.label === oldRecord.label) || !usages.length) return null;
    const replacementRecord = matchRenamedDefinition(oldRecord, definitions, new Set());
    return {
      fileName: String(analysis.fileName || ""),
      revision: Number(analysis.revision) || 0,
      oldLabel: String(oldRecord.label || ""),
      newLabel: replacementRecord ? String(replacementRecord.label || "") : "",
      changed: Boolean(replacementRecord),
      oldRecord,
      replacementRecord,
      usages,
      previewSource: String(analysis.source || ""),
      previousSource: String(previousAnalysis?.source || "")
    };
  }

  function cursorStillEditingIssue(issue, stateValue = currentState) {
    const field = labelFieldAtCursor(stateValue);
    if (!field) return false;
    const replacement = issue?.replacementRecord;
    if (replacement && Math.abs(field.sourceIndex - Number(replacement.sourceIndex || 0)) <= 8) {
      return true;
    }
    if (issue?.changed && field.label === issue.newLabel) return true;
    const oldSourceIndex = Number(issue?.oldRecord?.sourceIndex);
    return Number.isFinite(oldSourceIndex) && Math.abs(field.sourceIndex - oldSourceIndex) <= 8;
  }

  function deferIssue(issue) {
    if (!issue?.oldRecord) return;
    deferredIssues.set(deferredIssueKey(issue), {
      fileName: String(issue.fileName || ""),
      oldRecord: issue.oldRecord
    });
  }

  function flushDeferredIssues(analysisValue = currentAnalysis) {
    const analysis = analysisValue || currentAnalysis;
    if (!analysis || !deferredIssues.size) return;
    for (const [key, pending] of [...deferredIssues.entries()]) {
      if (String(pending.fileName || "") !== String(analysis.fileName || "")) continue;
      const verified = issueForOldRecord(pending.oldRecord, analysis);
      if (!verified) {
        deferredIssues.delete(key);
        continue;
      }
      if (cursorStillEditingIssue(verified)) continue;
      deferredIssues.delete(key);
      enqueueIssue(verified);
    }
  }

  function closePreviewPopup() {
    previewGeneration += 1;
    window.clearTimeout(previewTimer);
    window.clearTimeout(previewCloseTimer);
    window.clearTimeout(previewRenderTimer);
    if (previewRenderFrame) window.cancelAnimationFrame(previewRenderFrame);
    previewTimer = 0;
    previewCloseTimer = 0;
    previewRenderTimer = 0;
    previewRenderFrame = 0;
    previewPopup?.remove();
    previewPopup = null;
  }

  function scheduleClosePreviewPopup(delay = 120) {
    window.clearTimeout(previewCloseTimer);
    previewCloseTimer = window.setTimeout(closePreviewPopup, delay);
  }

  function cancelPreviewPopupClose() {
    window.clearTimeout(previewCloseTimer);
    previewCloseTimer = 0;
  }

  window.addEventListener("smarttex:editor-scroll-state", (event) => {
    if (event?.detail?.active === true) closePreviewPopup();
  });

  function closeDialog({ showNext = true } = {}) {
    closePreviewPopup();
    placementResizeObserver?.disconnect?.();
    placementResizeObserver = null;
    dialog?.remove();
    dialog = null;
    activeIssue = null;
    if (showNext) queueMicrotask(showNextIssue);
  }

  function showNextIssue() {
    if (!enabled || dialog || !issueQueue.length) return;
    activeIssue = issueQueue.shift();
    renderDialog();
  }

  function announceNavigationOrigin(destinationIndex) {
    if (!currentState) return;
    const cursorIndex = Math.max(0, Number(currentState.cursorIndex) || 0);
    if (cursorIndex === Number(destinationIndex)) return;
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

  async function jumpToUsage(usage) {
    try {
      const source = await latestEditorSource();
      const range = resolveUsageRange(source, usage);
      const index = Math.max(
        0,
        Number(range?.commandStart ?? usage.commandStart ?? usage.sourceIndex) || 0
      );
      announceNavigationOrigin(index);
      await bridgeRequest("setCursor", { index, focus: true });
    } catch (error) {
      setDialogStatus(error?.message || String(error), true);
    }
  }

  function referencePatternFor(commandValue, labelValue) {
    const command = String(commandValue || "ref").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const label = String(labelValue || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\\\${command}\\*?(?:\\s*\\[[^\\]]*\\]){0,2}\\s*\\{([^{}]*)\\}`, "g");
  }

  function resolveUsageRange(sourceValue, usage) {
    const source = String(sourceValue || "");
    const expectedStart = Math.max(0, Number(usage.labelStart) || 0);
    const expectedEnd = Math.max(expectedStart, Number(usage.labelEnd) || expectedStart);
    if (source.slice(expectedStart, expectedEnd) === activeIssue.oldLabel) {
      return {
        start: expectedStart,
        end: expectedEnd,
        commandStart: Math.max(0, Number(usage.commandStart) || 0)
      };
    }

    const candidates = [];
    const pattern = referencePatternFor(usage.command, activeIssue.oldLabel);
    let match;
    while ((match = pattern.exec(source))) {
      const openIndex = source.indexOf("{", match.index);
      if (openIndex < 0) continue;
      const raw = match[1] || "";
      let offset = 0;
      for (const part of raw.split(",")) {
        const leading = part.match(/^\s*/)?.[0]?.length || 0;
        const trailing = part.match(/\s*$/)?.[0]?.length || 0;
        const label = part.slice(leading, Math.max(leading, part.length - trailing));
        if (label === activeIssue.oldLabel) {
          const start = openIndex + 1 + offset + leading;
          candidates.push({ start, end: start + label.length, commandStart: match.index });
        }
        offset += part.length + 1;
      }
    }
    if (!candidates.length) return null;
    candidates.sort((left, right) => (
      Math.abs(left.commandStart - Number(usage.commandStart || 0)) -
      Math.abs(right.commandStart - Number(usage.commandStart || 0))
    ));
    return candidates[0];
  }

  async function latestEditorSource() {
    const response = await bridgeRequest("getState", {}, 2500);
    if (response?.state) currentState = { ...currentState, ...response.state };
    return String(response?.state?.value ?? currentState?.value ?? "");
  }

  function setDialogBusy(busy) {
    if (!dialog) return;
    const isBusy = Boolean(busy);
    dialog.classList.toggle("smarttex-label-guard-busy", isBusy);
    for (const control of dialog.querySelectorAll("button, a")) {
      if ("disabled" in control) {
        control.disabled = isBusy || (
          control.classList.contains("smarttex-label-guard-update-all") &&
          !activeIssue?.changed
        );
      }
      control.setAttribute("aria-disabled", isBusy ? "true" : "false");
    }
  }

  function setDialogStatus(message, isError = false) {
    const status = dialog?.querySelector(".smarttex-label-guard-status");
    if (!status) return;
    status.textContent = String(message || "");
    status.classList.toggle("smarttex-label-guard-status-error", Boolean(isError));
  }

  function removeUsage(guardId) {
    if (!activeIssue) return;
    activeIssue.usages = activeIssue.usages.filter((usage) => usage.guardId !== guardId);
    if (!activeIssue.usages.length) {
      closeDialog();
      return;
    }
    renderUsageList();
  }

  async function changeUsage(usage) {
    if (!activeIssue?.changed || !activeIssue.newLabel) return;
    setDialogBusy(true);
    setDialogStatus("Updating reference…");
    try {
      const source = await latestEditorSource();
      const range = resolveUsageRange(source, usage);
      if (!range) throw new Error("The reference could no longer be located in the current source.");
      await bridgeRequest("replaceRange", {
        start: range.start,
        end: range.end,
        text: activeIssue.newLabel,
        selectionStart: range.start + activeIssue.newLabel.length,
        selectionEnd: range.start + activeIssue.newLabel.length,
        focus: false
      });
      removeUsage(usage.guardId);
    } catch (error) {
      setDialogStatus(error?.message || String(error), true);
    } finally {
      setDialogBusy(false);
    }
  }

  function resolveDefinitionValueRange(sourceValue, recordValue, expectedLabelValue) {
    const source = String(sourceValue || "");
    const record = recordValue || {};
    const expectedLabel = String(expectedLabelValue || record.label || "");
    const start = Math.max(0, Number(record.valueStart) || 0);
    const end = Math.max(start, Number(record.valueEnd) || start);
    if (expectedLabel && source.slice(start, end) === expectedLabel) return { start, end };
    const escaped = expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\\\label\\s*\\{\\s*(${escaped})\\s*\\}`, "g");
    const candidates = [];
    let match;
    while ((match = pattern.exec(source))) {
      const relative = match[0].indexOf(match[1]);
      candidates.push({
        start: match.index + relative,
        end: match.index + relative + match[1].length
      });
    }
    if (!candidates.length) return null;
    candidates.sort((left, right) => (
      Math.abs(left.start - Number(record.sourceIndex || 0)) -
      Math.abs(right.start - Number(record.sourceIndex || 0))
    ));
    return candidates[0];
  }

  async function restorePreviousLabel() {
    if (!activeIssue?.oldLabel) return;
    setDialogBusy(true);
    setDialogStatus("Restoring previous label…");
    try {
      const source = await latestEditorSource();
      if (activeIssue.changed && activeIssue.replacementRecord) {
        const range = resolveDefinitionValueRange(
          source,
          activeIssue.replacementRecord,
          activeIssue.newLabel
        );
        if (!range) throw new Error("The changed label could no longer be located in the current source.");
        await bridgeRequest("replaceRange", {
          start: range.start,
          end: range.end,
          text: activeIssue.oldLabel,
          selectionStart: range.start + activeIssue.oldLabel.length,
          selectionEnd: range.start + activeIssue.oldLabel.length,
          focus: false
        });
      } else {
        const oldRecord = activeIssue.oldRecord || {};
        const previousSource = String(activeIssue.previousSource || "");
        const commandStart = Math.max(0, Number(oldRecord.sourceIndex) || 0);
        const commandEnd = Math.max(commandStart, Number(oldRecord.commandEnd) || commandStart);
        const previousCommand = previousSource.slice(commandStart, commandEnd) || `\\label{${activeIssue.oldLabel}}`;
        const insertionIndex = Math.max(0, Math.min(source.length, commandStart));
        await bridgeRequest("replaceRange", {
          start: insertionIndex,
          end: insertionIndex,
          text: previousCommand,
          selectionStart: insertionIndex + previousCommand.length,
          selectionEnd: insertionIndex + previousCommand.length,
          focus: false
        });
      }
      closeDialog();
    } catch (error) {
      setDialogStatus(error?.message || String(error), true);
      setDialogBusy(false);
    }
  }

  async function updateAllUsages() {
    if (!activeIssue?.changed || !activeIssue.newLabel || !activeIssue.usages.length) return;
    setDialogBusy(true);
    setDialogStatus("Updating all references…");
    try {
      const source = await latestEditorSource();
      const ranges = activeIssue.usages
        .map((usage) => ({ usage, range: resolveUsageRange(source, usage) }))
        .filter((entry) => entry.range)
        .sort((left, right) => right.range.start - left.range.start);
      if (!ranges.length) throw new Error("No matching references could be located in the current source.");
      for (const entry of ranges) {
        await bridgeRequest("replaceRange", {
          start: entry.range.start,
          end: entry.range.end,
          text: activeIssue.newLabel,
          selectionStart: entry.range.start + activeIssue.newLabel.length,
          selectionEnd: entry.range.start + activeIssue.newLabel.length,
          focus: false
        });
      }
      closeDialog();
    } catch (error) {
      setDialogStatus(error?.message || String(error), true);
      setDialogBusy(false);
    }
  }

  function cleanPreviewText(value) {
    return String(value || "")
      .replace(/%[^\n]*/g, " ")
      .replace(/\\(?:ttfamily|rmfamily|sffamily|bfseries|mdseries|itshape|slshape|scshape|normalfont)\b/g, "")
      .replace(/\\(?:centering|raggedright|raggedleft)\b/g, "")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ");
  }

  function appendPlainPreviewText(container, value) {
    const cleaned = cleanPreviewText(value)
      .replace(/\\([%#$&_{}])/g, "$1")
      .replace(/~/g, "\u00a0");
    const pieces = cleaned.split(/(\n\s*\n|\\\\|\\par\b)/g);
    for (const piece of pieces) {
      if (!piece) continue;
      if (/^(?:\n\s*\n|\\\\|\\par\b)$/.test(piece)) {
        container.appendChild(document.createElement("br"));
        if (/\n\s*\n|\\par/.test(piece)) container.appendChild(document.createElement("br"));
      } else {
        container.appendChild(document.createTextNode(piece.replace(/\s*\n\s*/g, " ")));
      }
    }
  }

  function referenceDisplayText(commandValue, targetValue, labelValue) {
    const command = String(commandValue || "ref");
    const target = targetValue || {};
    const label = String(labelValue || "");
    const number = String(target.number || label || "?");
    if (command === "eqref") return `(${number})`;
    if (/^(?:autoref|cref|Cref|vref|Vref|nameref)$/.test(command)) {
      const type = String(target.type || "reference");
      const prefix = command === "Cref"
        ? type.charAt(0).toUpperCase() + type.slice(1)
        : type;
      return `${prefix} ${number}`;
    }
    return number;
  }

  function localCitationIndex(sourceValue, keyValue) {
    const source = String(sourceValue || "");
    const key = String(keyValue || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bibItem = new RegExp(`\\\\bibitem(?:\\s*\\[[^\\]]*\\])?\\s*\\{${key}\\}`).exec(source);
    if (bibItem) return bibItem.index;
    const bibEntry = new RegExp(`@[A-Za-z]+\\s*\\{\\s*${key}\\s*,`, "i").exec(source);
    return bibEntry ? bibEntry.index : -1;
  }

  function addPreviewLink(container, textValue, destinationIndex, className = "") {
    const link = document.createElement("a");
    link.href = "#";
    link.className = `smarttex-label-guard-preview-link ${className}`.trim();
    link.textContent = String(textValue || "?");
    if (!Number.isFinite(Number(destinationIndex)) || Number(destinationIndex) < 0) {
      link.setAttribute("aria-disabled", "true");
      link.addEventListener("click", (event) => event.preventDefault());
    } else {
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        const index = Math.max(0, Number(destinationIndex) || 0);
        announceNavigationOrigin(index);
        try {
          await bridgeRequest("setCursor", { index, focus: true });
          closePreviewPopup();
        } catch (error) {
          setDialogStatus(error?.message || String(error), true);
        }
      });
    }
    container.appendChild(link);
  }

  function renderPreviewMath(
    container,
    latexValue,
    sourceValue,
    sourceIndexValue,
    displayMode = false,
    renderContext = null
  ) {
    const span = document.createElement(displayMode ? "div" : "span");
    span.className = displayMode
      ? "smarttex-label-guard-preview-math smarttex-label-guard-preview-math-display"
      : "smarttex-label-guard-preview-math";
    const prepared = renderContext?.preparedCommands
      ? contextTools?.applyPreparedDocumentCommands?.(
          renderContext.preparedCommands,
          String(latexValue || "")
        )
      : contextTools?.prepareDocumentCommands?.(
          String(sourceValue || ""),
          Math.max(0, Number(sourceIndexValue) || 0),
          String(latexValue || "")
        );
    const effectivePrepared = prepared || {
      body: String(latexValue || ""),
      macros: { "\\ensuremath": "#1" }
    };
    try {
      katex?.render?.(String(effectivePrepared.body || latexValue || ""), span, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        macros: effectivePrepared.macros || { "\\ensuremath": "#1" }
      });
    } catch (_error) {
      span.textContent = String(latexValue || "");
    }
    container.appendChild(span);
  }

  const PREVIEW_REFERENCE_PATTERN = /^\\(eqref|ref|pageref|autoref|cref|Cref|vref|Vref|nameref)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/;
  const PREVIEW_CITATION_PATTERN = /^\\(cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/;
  const PREVIEW_MATH_ENVIRONMENTS = new Set([
    "equation", "equation*", "align", "align*", "alignat", "alignat*",
    "flalign", "flalign*", "gather", "gather*", "multline", "multline*",
    "eqnarray", "eqnarray*", "split", "aligned", "alignedat", "cases"
  ]);
  const PREVIEW_TEXT_COMMANDS = new Map([
    ["textbf", "strong"], ["bf", "strong"], ["textit", "em"], ["emph", "em"],
    ["textsl", "em"], ["texttt", "code"], ["verb", "code"], ["textrm", "span"],
    ["textsf", "span"], ["mbox", "span"], ["hbox", "span"], ["underline", "u"],
    ["section", "strong"], ["subsection", "strong"], ["subsubsection", "strong"],
    ["paragraph", "strong"], ["subparagraph", "strong"], ["caption", "span"],
    ["footnote", "span"], ["thanks", "span"], ["title", "strong"], ["author", "span"]
  ]);
  const PREVIEW_SYMBOL_COMMANDS = new Map([
    ["LaTeX", "LaTeX"], ["TeX", "TeX"], ["ldots", "…"], ["dots", "…"],
    ["textendash", "–"], ["textemdash", "—"], ["textquoteleft", "‘"],
    ["textquoteright", "’"], ["textquotedblleft", "“"], ["textquotedblright", "”"],
    ["copyright", "©"], ["pounds", "£"], ["euro", "€"], ["degree", "°"],
    ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"],
    ["epsilon", "ε"], ["theta", "θ"], ["lambda", "λ"], ["mu", "μ"],
    ["nu", "ν"], ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"],
    ["tau", "τ"], ["phi", "φ"], ["omega", "ω"], ["Gamma", "Γ"],
    ["Delta", "Δ"], ["Theta", "Θ"], ["Lambda", "Λ"], ["Pi", "Π"],
    ["Sigma", "Σ"], ["Phi", "Φ"], ["Omega", "Ω"],
    ["%", "%"], ["#", "#"], ["$", "$"], ["&", "&"], ["_", "_"],
    ["{", "{"], ["}", "}"], ["~", " "], [" ", " "],
    ["quad", "  "], ["qquad", "    "], [",", " "], [";", " "], [":", " "], ["!", ""]
  ]);

  function previewCommandAt(text, index) {
    if (text[index] !== "\\") return null;
    const next = text[index + 1] || "";
    if (!/[A-Za-z@]/.test(next)) {
      return { name: next, start: index, end: Math.min(text.length, index + 2) };
    }
    let cursor = index + 2;
    while (cursor < text.length && /[A-Za-z@]/.test(text[cursor])) cursor += 1;
    if (text[cursor] === "*") cursor += 1;
    return { name: text.slice(index + 1, cursor).replace(/\*$/, ""), start: index, end: cursor };
  }

  function skipPreviewWhitespace(text, index) {
    let cursor = Math.max(0, Number(index) || 0);
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    return cursor;
  }

  function previewGroup(text, index, open = "{", close = "}") {
    const start = skipPreviewWhitespace(text, index);
    if (text[start] !== open) return null;
    const end = balancedGroupEnd(text, start, open, close);
    if (end <= start) return null;
    return { start, contentStart: start + 1, contentEnd: end - 1, end };
  }

  function appendPreviewBreak(container, double = false) {
    container.appendChild(document.createElement("br"));
    if (double) container.appendChild(document.createElement("br"));
  }

  function currentReferenceOccurrence(usage, absoluteLabelStart) {
    return Number.isFinite(Number(usage?.labelStart)) &&
      Number(usage.labelStart) === Number(absoluteLabelStart);
  }

  function cachedReferenceTarget(renderContext, source, label) {
    const key = String(label || "");
    const cache = renderContext?.referenceTargets;
    if (cache?.has(key)) return cache.get(key);
    const target = contextTools?.referenceTarget?.(source, key) || null;
    cache?.set(key, target);
    return target;
  }

  function cachedCitationTarget(renderContext, source, keyValue) {
    const key = String(keyValue || "");
    const cache = renderContext?.citationTargets;
    if (cache?.has(key)) return cache.get(key);
    const target = localCitationIndex(source, key);
    cache?.set(key, target);
    return target;
  }

  function renderReferenceCommand(container, match, absoluteStart, source, usage, renderContext) {
    const command = match[1];
    const argument = String(match[2] || "");
    const argumentOpen = match[0].lastIndexOf("{");
    let segmentStart = 0;
    const segments = argument.split(",");
    segments.forEach((segment, segmentIndex) => {
      if (segmentIndex) appendPlainPreviewText(container, ", ");
      const leading = segment.match(/^\s*/)?.[0]?.length || 0;
      const trailing = segment.match(/\s*$/)?.[0]?.length || 0;
      const label = segment.slice(leading, Math.max(leading, segment.length - trailing));
      const absoluteLabelStart = absoluteStart + argumentOpen + 1 + segmentStart + leading;
      const target = cachedReferenceTarget(renderContext, source, label);
      addPreviewLink(
        container,
        referenceDisplayText(command, target, label),
        target?.sourceIndex,
        currentReferenceOccurrence(usage, absoluteLabelStart)
          ? "smarttex-label-guard-preview-current"
          : ""
      );
      segmentStart += segment.length + 1;
    });
  }

  function renderCitationCommand(container, match, source, renderContext) {
    const keys = String(match[2] || "").split(",").map((key) => key.trim()).filter(Boolean);
    appendPlainPreviewText(container, "[");
    keys.forEach((key, keyIndex) => {
      if (keyIndex) appendPlainPreviewText(container, ", ");
      addPreviewLink(container, key, cachedCitationTarget(renderContext, source, key));
    });
    appendPlainPreviewText(container, "]");
  }

  function renderGenericCommand(container, text, command, source, absoluteStart, usage, depth, renderContext) {
    const name = command.name;
    let cursor = command.end;
    if (PREVIEW_SYMBOL_COMMANDS.has(name)) {
      appendPlainPreviewText(container, PREVIEW_SYMBOL_COMMANDS.get(name));
      return cursor;
    }
    if (["label", "index", "hypertarget", "phantomsection", "centering", "raggedright", "raggedleft", "noindent"].includes(name)) {
      const group = previewGroup(text, cursor);
      return group?.end || cursor;
    }
    if (name === "item") {
      appendPreviewBreak(container, false);
      appendPlainPreviewText(container, "• ");
      return cursor;
    }
    if (["par", "newline", "linebreak", "pagebreak", "newpage", "clearpage"].includes(name) || name === "\\") {
      appendPreviewBreak(container, name === "par");
      return cursor;
    }
    if (name === "includegraphics") {
      const optional = previewGroup(text, cursor, "[", "]");
      if (optional) cursor = optional.end;
      const group = previewGroup(text, cursor);
      if (group) {
        appendPlainPreviewText(container, `[figure: ${text.slice(group.contentStart, group.contentEnd).trim()}]`);
        return group.end;
      }
      return cursor;
    }
    if (name === "href") {
      const urlGroup = previewGroup(text, cursor);
      const textGroup = urlGroup ? previewGroup(text, urlGroup.end) : null;
      if (urlGroup && textGroup) {
        const link = document.createElement("a");
        link.className = "smarttex-label-guard-preview-link";
        link.href = text.slice(urlGroup.contentStart, urlGroup.contentEnd).trim();
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        renderLatexFragment(
          link,
          text.slice(textGroup.contentStart, textGroup.contentEnd),
          source,
          absoluteStart + textGroup.contentStart,
          usage,
          depth + 1,
          renderContext
        );
        container.appendChild(link);
        return textGroup.end;
      }
    }
    if (name === "url") {
      const group = previewGroup(text, cursor);
      if (group) {
        const value = text.slice(group.contentStart, group.contentEnd).trim();
        const link = document.createElement("a");
        link.className = "smarttex-label-guard-preview-link";
        link.href = value;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = value;
        container.appendChild(link);
        return group.end;
      }
    }
    const tagName = PREVIEW_TEXT_COMMANDS.get(name);
    if (tagName) {
      const optional = previewGroup(text, cursor, "[", "]");
      if (optional) cursor = optional.end;
      const group = previewGroup(text, cursor);
      if (group) {
        const wrapper = document.createElement(tagName);
        if (["caption", "footnote", "thanks"].includes(name)) {
          wrapper.className = "smarttex-label-guard-preview-secondary";
        }
        renderLatexFragment(
          wrapper,
          text.slice(group.contentStart, group.contentEnd),
          source,
          absoluteStart + group.contentStart,
          usage,
          depth + 1,
          renderContext
        );
        container.appendChild(wrapper);
        return group.end;
      }
    }
    if (["SI", "qty", "quantity", "numrange", "SIrange"].includes(name)) {
      const groups = [];
      const optional = previewGroup(text, cursor, "[", "]");
      if (optional) cursor = optional.end;
      for (let count = 0; count < 3; count += 1) {
        const group = previewGroup(text, cursor);
        if (!group) break;
        groups.push(group);
        cursor = group.end;
      }
      groups.forEach((group, groupIndex) => {
        if (groupIndex) appendPlainPreviewText(container, " ");
        renderLatexFragment(
          container,
          text.slice(group.contentStart, group.contentEnd),
          source,
          absoluteStart + group.contentStart,
          usage,
          depth + 1,
          renderContext
        );
      });
      return cursor;
    }
    if (["unit", "si", "mathrm", "operatorname", "text", "ensuremath", "makebox", "raisebox", "rotatebox", "scalebox", "colorbox", "fbox", "boxed"].includes(name)) {
      const optional = previewGroup(text, cursor, "[", "]");
      if (optional) cursor = optional.end;
      const groups = [];
      for (let count = 0; count < 3; count += 1) {
        const group = previewGroup(text, cursor);
        if (!group) break;
        groups.push(group);
        cursor = group.end;
      }
      const selected = groups.length ? groups[groups.length - 1] : null;
      if (selected) {
        renderLatexFragment(
          container,
          text.slice(selected.contentStart, selected.contentEnd),
          source,
          absoluteStart + selected.contentStart,
          usage,
          depth + 1,
          renderContext
        );
        return cursor;
      }
    }

    // Generic fallback: consume optional and required groups, suppress the raw
    // command name, and recursively render every textual argument. This keeps
    // custom document commands readable rather than exposing red command text.
    const groups = [];
    for (let count = 0; count < 4; count += 1) {
      const optional = previewGroup(text, cursor, "[", "]");
      if (optional) {
        cursor = optional.end;
        continue;
      }
      const group = previewGroup(text, cursor);
      if (!group) break;
      groups.push(group);
      cursor = group.end;
    }
    if (groups.length) {
      groups.forEach((group, groupIndex) => {
        if (groupIndex) appendPlainPreviewText(container, " ");
        renderLatexFragment(
          container,
          text.slice(group.contentStart, group.contentEnd),
          source,
          absoluteStart + group.contentStart,
          usage,
          depth + 1,
          renderContext
        );
      });
      return cursor;
    }
    return command.end;
  }

  function renderLatexFragment(container, fragmentValue, source, absoluteStartValue, usage, depth = 0, renderContext = null) {
    const text = String(fragmentValue || "");
    const absoluteStart = Math.max(0, Number(absoluteStartValue) || 0);
    if (depth > 12) {
      appendPlainPreviewText(container, text);
      return;
    }
    let index = 0;
    let plainStart = 0;
    const flushPlain = (end) => {
      if (end > plainStart) appendPlainPreviewText(container, text.slice(plainStart, end));
    };

    while (index < text.length) {
      if (text[index] === "%" && !isEscaped(text, index)) {
        flushPlain(index);
        const newline = text.indexOf("\n", index + 1);
        index = newline < 0 ? text.length : newline + 1;
        plainStart = index;
        continue;
      }
      if (text.startsWith("\\(", index) || text.startsWith("\\[", index)) {
        const display = text[index + 1] === "[";
        const close = display ? "\\]" : "\\)";
        const end = text.indexOf(close, index + 2);
        if (end >= 0) {
          flushPlain(index);
          renderPreviewMath(container, text.slice(index + 2, end), source, absoluteStart + index, display, renderContext);
          index = end + 2;
          plainStart = index;
          continue;
        }
      }
      if (text[index] === "$" && !isEscaped(text, index)) {
        const display = text[index + 1] === "$";
        const delimiter = display ? "$$" : "$";
        const end = text.indexOf(delimiter, index + delimiter.length);
        if (end >= 0) {
          flushPlain(index);
          renderPreviewMath(
            container,
            text.slice(index + delimiter.length, end),
            source,
            absoluteStart + index,
            display,
            renderContext
          );
          index = end + delimiter.length;
          plainStart = index;
          continue;
        }
      }
      if (text.startsWith("\\begin", index)) {
        const command = previewCommandAt(text, index);
        const environmentGroup = command ? previewGroup(text, command.end) : null;
        if (environmentGroup) {
          const environment = text.slice(environmentGroup.contentStart, environmentGroup.contentEnd).trim();
          const endPattern = new RegExp(`\\\\end\\s*\\{${environment.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\}`);
          const afterOpen = text.slice(environmentGroup.end);
          const endMatch = endPattern.exec(afterOpen);
          if (endMatch) {
            flushPlain(index);
            let body = afterOpen.slice(0, endMatch.index);
            if (PREVIEW_MATH_ENVIRONMENTS.has(environment)) {
              body = body.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\(?:nonumber|notag)\b/g, "");
              if ((body.includes("&") || /\\\\/.test(body)) && !/\\begin\s*\{/.test(body)) {
                body = `\\begin{aligned}${body}\\end{aligned}`;
              }
              renderPreviewMath(container, body, source, absoluteStart + environmentGroup.end, true, renderContext);
            } else {
              renderLatexFragment(
                container,
                body,
                source,
                absoluteStart + environmentGroup.end,
                usage,
                depth + 1,
                renderContext
              );
            }
            index = environmentGroup.end + endMatch.index + endMatch[0].length;
            plainStart = index;
            continue;
          }
        }
      }
      if (text[index] === "\\") {
        const rest = text.slice(index);
        let match = PREVIEW_REFERENCE_PATTERN.exec(rest);
        if (match) {
          flushPlain(index);
          renderReferenceCommand(container, match, absoluteStart + index, source, usage, renderContext);
          index += match[0].length;
          plainStart = index;
          continue;
        }
        match = PREVIEW_CITATION_PATTERN.exec(rest);
        if (match) {
          flushPlain(index);
          renderCitationCommand(container, match, source, renderContext);
          index += match[0].length;
          plainStart = index;
          continue;
        }
        const command = previewCommandAt(text, index);
        if (command) {
          flushPlain(index);
          const next = renderGenericCommand(container, text, command, source, absoluteStart, usage, depth, renderContext);
          index = Math.max(command.end, next);
          plainStart = index;
          continue;
        }
      }
      if (text[index] === "{") {
        const group = previewGroup(text, index);
        if (group) {
          flushPlain(index);
          renderLatexFragment(
            container,
            text.slice(group.contentStart, group.contentEnd),
            source,
            absoluteStart + group.contentStart,
            usage,
            depth + 1,
            renderContext
          );
          index = group.end;
          plainStart = index;
          continue;
        }
      }
      index += 1;
    }
    flushPlain(text.length);
  }

  function renderRichPreview(container, usage) {
    const source = String(currentState?.value || activeIssue?.previewSource || "");
    const resolved = resolveUsageRange(source, usage) || {};
    const effectiveUsage = {
      ...usage,
      commandStart: Number(resolved.commandStart ?? usage.commandStart ?? usage.sourceIndex) || 0,
      commandEnd: Number(resolved.commandEnd ?? usage.commandEnd) || 0,
      labelStart: Number(resolved.labelStart ?? usage.labelStart) || 0,
      labelEnd: Number(resolved.labelEnd ?? usage.labelEnd) || 0,
      sourceIndex: Number(resolved.commandStart ?? usage.sourceIndex) || 0
    };
    const details = surroundingSentenceContextDetails(
      source,
      effectiveUsage.sourceIndex,
      3,
      3,
      effectiveUsage.commandEnd
    );
    const preparedCommands = contextTools?.prepareDocumentCommandContext?.(
      source,
      effectiveUsage.sourceIndex
    ) || null;
    const renderContext = {
      preparedCommands,
      referenceTargets: new Map(),
      citationTargets: new Map()
    };
    renderLatexFragment(
      container,
      details.text,
      source,
      details.start,
      effectiveUsage,
      0,
      renderContext
    );
  }

  function placePreviewPopup(anchor) {
    if (!previewPopup?.isConnected || !anchor?.isConnected) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popupRect = previewPopup.getBoundingClientRect();
    let left = anchorRect.right + 10;
    if (left + popupRect.width > window.innerWidth - 10) {
      left = Math.max(10, anchorRect.left - popupRect.width - 10);
    }
    let top = anchorRect.top;
    if (top + popupRect.height > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - popupRect.height - 10);
    }
    previewPopup.style.left = `${Math.round(left)}px`;
    previewPopup.style.top = `${Math.round(top)}px`;
  }

  function showUsagePreview(anchor, usage) {
    closePreviewPopup();
    const generation = ++previewGeneration;
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      if (generation !== previewGeneration || !anchor?.isConnected) return;
      previewPopup = document.createElement("aside");
      previewPopup.className = "smarttex-label-guard-preview";
      previewPopup.setAttribute("role", "dialog");
      previewPopup.setAttribute("aria-label", `Reference context at line ${usage.lineNumber || "?"}`);
      previewPopup.setAttribute("aria-busy", "true");
      const heading = document.createElement("div");
      heading.className = "smarttex-label-guard-preview-heading";
      heading.textContent = `Context around line ${usage.lineNumber || "?"}`;
      const body = document.createElement("div");
      body.className = "smarttex-label-guard-preview-body smarttex-label-guard-preview-loading";
      const spinner = document.createElement("span");
      spinner.className = "smarttex-inline-loading-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const loadingText = document.createElement("span");
      loadingText.textContent = "Rendering reference context…";
      body.append(spinner, loadingText);
      previewPopup.append(heading, body);
      previewPopup.addEventListener("pointerenter", cancelPreviewPopupClose);
      previewPopup.addEventListener("pointerleave", () => scheduleClosePreviewPopup(140));
      document.body.appendChild(previewPopup);
      placePreviewPopup(anchor);

      // Let the browser paint the loading state before parsing and rendering the
      // context. Build the final content off-DOM so no partial preview is exposed.
      previewRenderFrame = window.requestAnimationFrame(() => {
        previewRenderFrame = 0;
        previewRenderTimer = window.setTimeout(() => {
          previewRenderTimer = 0;
          if (
            generation !== previewGeneration ||
            !previewPopup?.isConnected ||
            !anchor?.isConnected
          ) return;
          const rendered = document.createElement("div");
          try {
            renderRichPreview(rendered, usage);
            body.classList.remove("smarttex-label-guard-preview-loading");
            body.replaceChildren(...rendered.childNodes);
          } catch (_error) {
            body.classList.remove("smarttex-label-guard-preview-loading");
            body.textContent = usage.excerpt || `\${usage.command}{${usage.label}}`;
          } finally {
            previewPopup?.removeAttribute("aria-busy");
            placePreviewPopup(anchor);
          }
        }, 16);
      });
    }, 70);
  }

  function usageLabel(usage) {
    const command = `\\${usage.command}{${activeIssue.oldLabel}}`;
    return `${command} — line ${usage.lineNumber || "?"}`;
  }

  function renderUsageList() {
    const list = dialog?.querySelector(".smarttex-label-guard-list");
    const count = dialog?.querySelector(".smarttex-label-guard-count");
    if (!list || !activeIssue) return;
    list.replaceChildren();
    count.textContent = `${activeIssue.usages.length} reference${activeIssue.usages.length === 1 ? "" : "s"} still use this label.`;

    for (const usage of activeIssue.usages) {
      const item = document.createElement("li");
      item.className = "smarttex-label-guard-item";
      const link = document.createElement("a");
      link.href = "#";
      link.className = "smarttex-label-guard-link";
      link.textContent = usageLabel(usage);
      link.setAttribute("aria-label", `${usageLabel(usage)}. Show surrounding context.`);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        jumpToUsage(usage);
      });
      link.addEventListener("pointerenter", () => showUsagePreview(link, usage));
      link.addEventListener("focus", () => showUsagePreview(link, usage));
      link.addEventListener("pointerleave", () => scheduleClosePreviewPopup(140));
      link.addEventListener("blur", () => scheduleClosePreviewPopup(80));

      const excerpt = document.createElement("div");
      excerpt.className = "smarttex-label-guard-excerpt";
      excerpt.textContent = usage.excerpt || "";
      const controls = document.createElement("div");
      controls.className = "smarttex-label-guard-item-actions";
      if (activeIssue.changed) {
        const change = document.createElement("button");
        change.type = "button";
        change.className = "smarttex-label-guard-change";
        change.textContent = "Update";
        change.title = `Replace this occurrence with ${activeIssue.newLabel}`;
        change.addEventListener("click", () => changeUsage(usage));
        const ignore = document.createElement("button");
        ignore.type = "button";
        ignore.className = "smarttex-label-guard-ignore";
        ignore.textContent = "Ignore";
        ignore.title = "Remove this occurrence from the list without changing it";
        ignore.addEventListener("click", () => removeUsage(usage.guardId));
        controls.append(change, ignore);
      }
      item.append(link, excerpt);
      if (controls.childElementCount) item.appendChild(controls);
      list.appendChild(item);
    }
  }

  function renderDialog() {
    if (!activeIssue) return;
    dialog = document.createElement("section");
    dialog.className = "smarttex-label-guard-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "false");
    dialog.setAttribute("aria-labelledby", "smarttex-label-guard-title");
    dialog.innerHTML = `
      <header class="smarttex-label-guard-header">
        <div>
          <h2 id="smarttex-label-guard-title"></h2>
          <p class="smarttex-label-guard-count"></p>
        </div>
        <button type="button" class="smarttex-label-guard-close" aria-label="Close" title="Close (Esc)">&times;</button>
      </header>
      <p class="smarttex-label-guard-description"></p>
      <ul class="smarttex-label-guard-list"></ul>
      <div class="smarttex-label-guard-status" role="status" aria-live="polite"></div>
      <footer class="smarttex-label-guard-footer">
        <button type="button" class="smarttex-label-guard-restore">Restore previous label</button>
        <span class="smarttex-label-guard-footer-spacer" aria-hidden="true"></span>
        <button type="button" class="smarttex-label-guard-cancel">Cancel</button>
        <button type="button" class="smarttex-label-guard-update-all">Update all</button>
      </footer>
    `;
    dialog.querySelector("#smarttex-label-guard-title").textContent = activeIssue.changed
      ? `Label changed: ${activeIssue.oldLabel} → ${activeIssue.newLabel}`
      : `Label deleted: ${activeIssue.oldLabel}`;
    dialog.querySelector(".smarttex-label-guard-description").textContent = activeIssue.changed
      ? "Choose a reference to open it, update individual occurrences, ignore them, update all remaining occurrences, or restore the previous label."
      : "The following references no longer have a matching label. Open a reference to inspect it or restore the previous label.";
    const close = dialog.querySelector(".smarttex-label-guard-close");
    const restore = dialog.querySelector(".smarttex-label-guard-restore");
    const cancel = dialog.querySelector(".smarttex-label-guard-cancel");
    const updateAll = dialog.querySelector(".smarttex-label-guard-update-all");
    close.addEventListener("click", () => closeDialog());
    restore.title = `Restore \label{${activeIssue.oldLabel}} in the document`;
    restore.addEventListener("click", restorePreviousLabel);
    cancel.addEventListener("click", () => closeDialog());
    updateAll.disabled = !activeIssue.changed;
    updateAll.title = activeIssue.changed
      ? `Replace all remaining occurrences with ${activeIssue.newLabel}`
      : "A deleted label has no replacement value";
    updateAll.addEventListener("click", updateAllUsages);
    document.body.appendChild(dialog);
    renderUsageList();
    if (typeof ResizeObserver === "function") {
      placementResizeObserver = new ResizeObserver(scheduleDialogPlacement);
      const area = preferredDialogArea();
      if (area) placementResizeObserver.observe(area);
      placementResizeObserver.observe(dialog);
    }
    scheduleDialogPlacement();
  }

  function processAnalysis(result) {
    if (!result || String(result.fileName || "") !== String(currentState?.fileName || result.fileName || "")) {
      previousAnalysis = result || previousAnalysis;
      currentAnalysis = result || currentAnalysis;
      return;
    }
    const previous = previousAnalysis;
    previousAnalysis = result;
    currentAnalysis = result;
    if (!enabled || !previous) return;
    if (String(previous.fileName || "") !== String(result.fileName || "")) return;
    for (const issue of changedLabelIssues(previous, result)) {
      if (cursorStillEditingIssue(issue)) deferIssue(issue);
      else enqueueIssue(issue);
    }
    flushDeferredIssues(result);
  }

  window.addEventListener(STATE_EVENT, (event) => {
    let state;
    try {
      state = interactionTasks?.parseEditorState
        ? interactionTasks.parseEditorState(event.detail)
        : JSON.parse(String(event.detail || "null"));
    } catch (_error) {
      return;
    }
    if (!state) return;
    const previousSource = String(currentState?.value || "");
    const previousFileName = String(currentState?.fileName || "");
    const previousLabelField = labelFieldAtCursor(currentState);
    currentState = state;
    const sourceChanged = (
      previousSource !== String(state.value || "") ||
      previousFileName !== String(state.fileName || "")
    );
    if (sourceChanged) {
      scheduleAnalysis({ immediate: previousAnalysis === null });
      return;
    }
    const currentLabelField = labelFieldAtCursor(currentState);
    const leftPreviousLabelField = Boolean(previousLabelField) && (
      !currentLabelField ||
      Number(previousLabelField.sourceIndex) !== Number(currentLabelField.sourceIndex)
    );
    if (leftPreviousLabelField) {
      if (
        String(lastAnalyzedSource || "") !== String(currentState.value || "") ||
        String(lastAnalyzedFileName || "") !== String(currentState.fileName || "")
      ) {
        scheduleAnalysis({ immediate: true });
      } else {
        flushDeferredIssues(currentAnalysis);
      }
    }
  });

  bridgeRequest("getState", {}, 2500).then((response) => {
    if (!response?.state) return;
    currentState = response.state;
    scheduleAnalysis({ immediate: true });
  }).catch(() => {});

  function applyEnabledSetting(value) {
    enabled = value !== false;
    if (!enabled) {
      issueQueue.length = 0;
      deferredIssues.clear();
      closeDialog({ showNext: false });
    }
  }

  if (extensionApi?.storage?.local?.get) {
    extensionApi.storage.local.get(SETTINGS_KEY).then((stored) => {
      const runtime = globalThis.SmartTeXRuntimeSettings;
      runtimeSettingsOverrideActive = runtime?.usingPresets === false;
      applyEnabledSetting(
        runtime?.labelReferenceGuard?.enabled !== undefined
          ? runtime.labelReferenceGuard.enabled
          : stored?.[SETTINGS_KEY]?.enabled
      );
    }).catch(() => {});
  }

  window.addEventListener(RUNTIME_SETTINGS_EVENT, (event) => {
    const detail = event?.detail || {};
    runtimeSettingsOverrideActive = detail.usingPresets === false;
    applyEnabledSetting(detail.labelReferenceGuard?.enabled);
  });

  extensionApi?.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local" || !changes?.[SETTINGS_KEY] || runtimeSettingsOverrideActive) return;
    applyEnabledSetting(changes[SETTINGS_KEY].newValue?.enabled);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dialog) return;
    if (dialog.classList.contains("smarttex-label-guard-busy")) return;
    event.preventDefault();
    event.stopPropagation();
    closeDialog();
  }, true);
  window.addEventListener("resize", scheduleDialogPlacement, { passive: true });
  window.addEventListener("scroll", scheduleDialogPlacement, { passive: true, capture: true });

  globalThis.SmartTeXLabelReferenceGuard = Object.freeze({
    isEnabled: () => enabled,
    forTest: Object.freeze({
      changedLabelIssues,
      matchRenamedDefinition,
      sourceAnalysis,
      labelFieldAtCursor,
      issueForOldRecord,
      cursorStillEditingIssue,
      surroundingSentenceContext,
      surroundingSentenceContextDetails,
      safeLatexContextBounds,
      resolveDefinitionValueRange,
      currentReferenceOccurrence,
      previewCommandAt,
      renderLatexFragment
    })
  });
})();
