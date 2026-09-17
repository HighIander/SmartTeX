/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

((global) => {
  "use strict";

  const MATH_ENVIRONMENTS = new Set([
    "math",
    "displaymath",
    "equation",
    "equation*",
    "align",
    "align*",
    "alignat",
    "alignat*",
    "flalign",
    "flalign*",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "eqnarray",
    "eqnarray*"
  ]);
  const TABLE_ENVIRONMENTS = new Set([
    "array",
    "longtable",
    "tabular",
    "tabular*",
    "tabularx"
  ]);
  const VERBATIM_ENVIRONMENTS = [
    "verbatim",
    "verbatim*",
    "Verbatim",
    "lstlisting",
    "minted"
  ];
  const CARET_MACRO = "\\SmartTeXCaret{}";
  const KATEX_COMPATIBLE_MATH_MACROS = Object.freeze({
    // `upgreek` is common in plasma-physics documents but KaTeX does not
    // provide its upright-Greek commands. Keep the physical tensor notation
    // intact in every preview, including `\\bm{\\upsigma}`.
    "\\upsigma": "\\mathrm{\\sigma}",
    "\\upvarepsilon": "\\mathrm{\\varepsilon}"
  });
  const MASK_CHARACTER = "\u0000";
  function taskCheckpoint(iteration = 0, interval = 256) {
    global.SmartTeXInteractionTasks?.checkpoint?.(iteration, interval);
  }

  const DELIMITER_COMMANDS = new Set([
    "\\left",
    "\\right",
    "\\middle",
    "\\big",
    "\\Big",
    "\\bigg",
    "\\Bigg",
    "\\bigl",
    "\\bigr",
    "\\Bigl",
    "\\Bigr",
    "\\biggl",
    "\\biggr",
    "\\Biggl",
    "\\Biggr"
  ]);

  function isEscaped(source, index) {
    let backslashes = 0;
    for (let position = index - 1; position >= 0 && source[position] === "\\"; position -= 1) {
      backslashes += 1;
    }
    return backslashes % 2 === 1;
  }

  function romanNumber(value) {
    const table = [
      [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
      [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
      [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
    ];
    let number = Math.max(0, Number(value) || 0);
    let result = "";
    for (const [amount, symbol] of table) {
      while (number >= amount) {
        result += symbol;
        number -= amount;
      }
    }
    return result;
  }

  function alphaNumber(value) {
    let number = Math.max(1, Number(value) || 1);
    let result = "";
    while (number > 0) {
      number -= 1;
      result = String.fromCharCode(65 + (number % 26)) + result;
      number = Math.floor(number / 26);
    }
    return result;
  }

  function lowerRomanNumber(value) {
    return romanNumber(value).toLocaleLowerCase();
  }

  function lowerAlphaNumber(value) {
    return alphaNumber(value).toLocaleLowerCase();
  }

  function sectionNumbering(sourceValue) {
    return documentCounterAnalysis(sourceValue).sections;
  }

  let documentCounterCacheSource = null;
  let documentCounterCache = null;
  let equationCounterCacheSource = null;
  let equationCounterCache = null;

  function counterCommandEvents(source, masked) {
    const events = [];
    const simplePattern = /\\appendix\b|\\(section|subsection|subsubsection|paragraph)(\*)?|\\(setcounter|addtocounter)\s*\{([^{}]+)\}\s*\{\s*(-?\d+)\s*\}|\\(numberwithin|counterwithin|counterwithout)(\*)?\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g;
    let match;
    while ((match = simplePattern.exec(masked))) {
      taskCheckpoint(simplePattern.lastIndex);
      if (match[0].startsWith("\\appendix")) {
        events.push({ index: match.index, kind: "appendix" });
      } else if (match[1]) {
        let position = skipWhitespace(masked, match.index + match[0].length);
        let title = "";
        if (masked[position] === "{") {
          const argument = readBalanced(masked, position, "{", "}");
          if (argument) title = source.slice(position + 1, argument.end - 1).trim();
        }
        events.push({
          index: match.index,
          kind: "section",
          counter: match[1],
          starred: Boolean(match[2]),
          title
        });
      } else if (match[3]) {
        events.push({
          index: match.index,
          kind: match[3],
          counter: String(match[4] || "").trim(),
          value: Number(match[5]) || 0
        });
      } else if (match[6]) {
        events.push({
          index: match.index,
          kind: match[6],
          starred: Boolean(match[7]),
          counter: String(match[8] || "").trim(),
          parent: String(match[9] || "").trim()
        });
      }
    }

    const definitionPattern = /\\(?:renewcommand|providecommand)\*?|\\def\b/g;
    while ((match = definitionPattern.exec(masked))) {
      let position = skipWhitespace(masked, match.index + match[0].length);
      let command = "";
      if (masked[position] === "{") {
        const argument = readBalanced(masked, position, "{", "}");
        if (!argument) continue;
        command = source.slice(position + 1, argument.end - 1).trim();
        position = skipWhitespace(masked, argument.end);
      } else {
        const commandMatch = /^\\[A-Za-z@]+/.exec(masked.slice(position));
        if (!commandMatch) continue;
        command = commandMatch[0];
        position = skipWhitespace(masked, position + commandMatch[0].length);
      }
      const counterMatch = /^\\the([A-Za-z@]+)$/.exec(command);
      if (!counterMatch || masked[position] !== "{") continue;
      const definition = readBalanced(masked, position, "{", "}");
      if (!definition) continue;
      events.push({
        index: match.index,
        kind: "format",
        counter: counterMatch[1],
        template: source.slice(position + 1, definition.end - 1).trim()
      });
    }
    return events;
  }

  function documentCounterAnalysis(
    sourceValue,
    parsedEquations = null,
    includeFloats = true
  ) {
    const source = String(sourceValue || "");
    if (includeFloats) {
      if (source === documentCounterCacheSource && documentCounterCache) {
        return documentCounterCache;
      }
    } else {
      if (source === documentCounterCacheSource && documentCounterCache) {
        return documentCounterCache;
      }
      if (source === equationCounterCacheSource && equationCounterCache) {
        return equationCounterCache;
      }
    }
    const masked = maskIgnoredLatex(source);
    const revtex = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^{}]*revtex/i.test(masked);
    const counters = Object.create(null);
    const parents = new Map([
      ["subsection", "section"],
      ["subsubsection", "subsection"],
      ["paragraph", "subsubsection"]
    ]);
    const templates = new Map([
      ["section", revtex ? "\\Roman{section}" : "\\arabic{section}"],
      ["subsection", revtex
        ? "\\thesection.\\Alph{subsection}"
        : "\\thesection.\\arabic{subsection}"],
      ["subsubsection", "\\thesubsection.\\arabic{subsubsection}"],
      ["paragraph", "\\thesubsubsection.\\arabic{paragraph}"],
      ["equation", "\\arabic{equation}"],
      ["figure", "\\arabic{figure}"],
      ["table", "\\arabic{table}"]
    ]);
    const sectionLevels = ["section", "subsection", "subsubsection", "paragraph"];
    sectionLevels.forEach((name) => { counters[name] = 0; });
    counters.equation = 0;
    counters.figure = 0;
    counters.table = 0;
    let appendix = false;

    const resetChildren = (parent) => {
      for (const [child, candidateParent] of parents) {
        if (candidateParent !== parent) continue;
        counters[child] = 0;
        resetChildren(child);
      }
    };
    const formatCounter = (name, stack = new Set()) => {
      if (stack.has(name)) return String(counters[name] || 0);
      const nextStack = new Set(stack);
      nextStack.add(name);
      const template = templates.get(name) || `\\arabic{${name}}`;
      let rendered = String(template);
      rendered = rendered.replace(/\\the([A-Za-z@]+)/g, (_whole, nested) => (
        formatCounter(nested, nextStack)
      ));
      rendered = rendered.replace(
        /\\(arabic|roman|Roman|alph|Alph)\s*\{([^{}]+)\}/g,
        (_whole, style, counterName) => {
          const value = Math.max(0, Number(counters[String(counterName).trim()]) || 0);
          if (style === "roman") return lowerRomanNumber(value);
          if (style === "Roman") return romanNumber(value);
          if (style === "alph") return value > 0 ? lowerAlphaNumber(value) : "";
          if (style === "Alph") return value > 0 ? alphaNumber(value) : "";
          return String(value);
        }
      );
      return rendered
        .replace(/\\protect\b/g, "")
        .replace(/[{}]/g, "")
        .trim();
    };
    const increment = (name) => {
      counters[name] = Math.max(0, Number(counters[name]) || 0) + 1;
      resetChildren(name);
      return formatCounter(name);
    };

    const parsed = parsedEquations || equationContexts(source);
    const equations = parsed.contexts;
    const figures = includeFloats
      ? figureContexts(source).sort((left, right) => left.openStart - right.openStart)
      : [];
    const tables = includeFloats
      ? genericEnvironmentContexts(source, ["table", "table*"])
        .sort((left, right) => left.openStart - right.openStart)
      : [];
    const events = counterCommandEvents(source, masked);
    equations.forEach((context) => events.push({
      index: context.openStart,
      kind: "equation",
      context
    }));
    for (const [kind, contexts] of [["figure", figures], ["table", tables]]) {
      contexts.forEach((context) => {
        const body = source.slice(context.contentStart, context.contentEnd);
        const captionMatch = /\\caption(?!\*)\s*(?:\[[^\]\r\n]*\]\s*)?\{/.exec(
          maskIgnoredLatex(body)
        );
        events.push({
          index: captionMatch ? context.contentStart + captionMatch.index : context.openStart,
          kind,
          context,
          numbered: Boolean(captionMatch)
        });
      });
    }
    events.sort((left, right) => left.index - right.index);

    const equationNumberingByOpenStart = new Map();
    const figureNumbersByOpenStart = new Map();
    const tableNumbersByOpenStart = new Map();
    const sections = [];
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      taskCheckpoint(eventIndex, 32);
      const event = events[eventIndex];
      if (event.kind === "appendix") {
        appendix = true;
        if (revtex) {
          parents.set("equation", "section");
          templates.set("equation", "\\thesection\\arabic{equation}");
        }
        counters.section = 0;
        resetChildren("section");
        templates.set("section", "\\Alph{section}");
        templates.set("subsection", "\\thesection.\\arabic{subsection}");
        continue;
      }
      if (event.kind === "format") {
        templates.set(event.counter, event.template);
        continue;
      }
      if (event.kind === "setcounter" || event.kind === "addtocounter") {
        const current = Number(counters[event.counter]) || 0;
        counters[event.counter] = event.kind === "setcounter"
          ? event.value
          : current + event.value;
        continue;
      }
      if (["numberwithin", "counterwithin", "counterwithout"].includes(event.kind)) {
        if (event.kind === "counterwithout") {
          if (parents.get(event.counter) === event.parent) parents.delete(event.counter);
        } else {
          parents.set(event.counter, event.parent);
          if (!event.starred) {
            templates.set(
              event.counter,
              `\\the${event.parent}.\\arabic{${event.counter}}`
            );
          }
        }
        continue;
      }
      if (event.kind === "section") {
        const level = sectionLevels.indexOf(event.counter);
        const number = event.starred ? "" : increment(event.counter);
        sections.push({
          command: event.counter,
          level,
          starred: event.starred,
          appendix,
          number,
          title: event.title,
          sourceIndex: event.index
        });
        continue;
      }
      if (event.kind === "equation") {
        const completeContext = {
          ...event.context,
          source: source.slice(event.context.contentStart, event.context.contentEnd)
        };
        const result = equationPreviewNumberingAtCounter(
          completeContext,
          counters.equation,
          (value) => {
            counters.equation = value;
            return formatCounter("equation");
          }
        );
        counters.equation = result.counter;
        equationNumberingByOpenStart.set(event.context.openStart, result.numbering);
        continue;
      }
      if ((event.kind === "figure" || event.kind === "table") && event.numbered) {
        const number = increment(event.kind);
        const targetMap = event.kind === "figure"
          ? figureNumbersByOpenStart
          : tableNumbersByOpenStart;
        targetMap.set(event.context.openStart, number);
      }
    }

    const analysis = {
      ...parsed,
      equations,
      figures,
      tables,
      sections,
      equationNumberingByOpenStart,
      figureNumbersByOpenStart,
      tableNumbersByOpenStart
    };
    if (includeFloats) {
      documentCounterCacheSource = source;
      documentCounterCache = analysis;
    } else {
      equationCounterCacheSource = source;
      equationCounterCache = analysis;
    }
    return analysis;
  }

  function blankRange(characters, start, end) {
    for (let index = start; index < end; index += 1) {
      taskCheckpoint(index - start);
      if (characters[index] !== "\r" && characters[index] !== "\n") {
        characters[index] = MASK_CHARACTER;
      }
    }
  }


  function removeLatexCommentsPreservingLength(sourceValue) {
    const source = String(sourceValue || "");
    const characters = source.split("");
    for (let index = 0; index < source.length; index += 1) {
      taskCheckpoint(index);
      if (source[index] === "\\" && source.slice(index, index + 5) === "\\verb") {
        let delimiterIndex = index + 5;
        if (source[delimiterIndex] === "*") delimiterIndex += 1;
        const delimiter = source[delimiterIndex];
        if (delimiter && !/\s|[A-Za-z]/.test(delimiter)) {
          const endDelimiter = source.indexOf(delimiter, delimiterIndex + 1);
          index = endDelimiter < 0 ? source.length - 1 : endDelimiter;
          continue;
        }
      }
      if (source[index] !== "%" || isEscaped(source, index)) continue;
      let end = index;
      while (end < source.length && source[end] !== "\r" && source[end] !== "\n") {
        characters[end] = " ";
        end += 1;
      }
      index = end - 1;
    }
    return characters.join("");
  }

  function maskIgnoredLatex(sourceValue) {
    const source = String(sourceValue || "");
    const characters = source.split("");

    for (let index = 0; index < source.length; index += 1) {
      taskCheckpoint(index);
      if (source[index] === "%" && !isEscaped(source, index)) {
        let end = index;
        while (end < source.length && source[end] !== "\r" && source[end] !== "\n") {
          end += 1;
        }
        blankRange(characters, index, end);
        index = end - 1;
        continue;
      }

      if (source[index] !== "\\" || source.slice(index, index + 5) !== "\\verb") {
        continue;
      }
      let delimiterIndex = index + 5;
      if (source[delimiterIndex] === "*") delimiterIndex += 1;
      const delimiter = source[delimiterIndex];
      if (!delimiter || /\s|[A-Za-z]/.test(delimiter)) continue;
      const endDelimiter = source.indexOf(delimiter, delimiterIndex + 1);
      const end = endDelimiter < 0 ? source.length : endDelimiter + 1;
      blankRange(characters, index, end);
      index = end - 1;
    }

    let masked = characters.join("");
    for (const environment of VERBATIM_ENVIRONMENTS) {
      const escapedEnvironment = environment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const beginPattern = new RegExp(`\\\\begin\\s*\\{${escapedEnvironment}\\}`, "g");
      let match;
      while ((match = beginPattern.exec(masked))) {
        taskCheckpoint(beginPattern.lastIndex);
        const endPattern = new RegExp(`\\\\end\\s*\\{${escapedEnvironment}\\}`, "g");
        endPattern.lastIndex = match.index + match[0].length;
        const endMatch = endPattern.exec(masked);
        const end = endMatch ? endMatch.index + endMatch[0].length : source.length;
        blankRange(characters, match.index, end);
        masked = characters.join("");
        beginPattern.lastIndex = end;
      }
    }
    return characters.join("");
  }

  function environmentOpeningAt(masked, index) {
    if (masked[index] !== "\\") return null;
    const match = masked.slice(index).match(/^\\begin\s*\{([^{}]+)\}/);
    if (!match || !MATH_ENVIRONMENTS.has(match[1])) return null;
    return {
      token: match[0],
      environment: match[1],
      display: !["math"].includes(match[1])
    };
  }

  function delimiterOpeningAt(masked, index) {
    if (masked.startsWith("\\(", index)) {
      return { token: "\\(", close: "\\)", display: false };
    }
    if (masked.startsWith("\\[", index)) {
      return { token: "\\[", close: "\\]", display: true };
    }
    if (masked[index] !== "$" || isEscaped(masked, index)) return null;
    if (masked.startsWith("$$", index)) {
      return { token: "$$", close: "$$", display: true };
    }
    return { token: "$", close: "$", display: false };
  }

  function closingTokenAt(masked, index, active) {
    if (active.kind !== "environment") {
      return masked.startsWith(active.close, index) ? active.close : "";
    }
    if (masked[index] !== "\\") return "";
    const escapedName = active.environment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return masked.slice(index).match(
      new RegExp(`^\\\\end\\s*\\{${escapedName}\\}`)
    )?.[0] || "";
  }

  function equationContexts(sourceValue) {
    const source = String(sourceValue || "");
    const masked = maskIgnoredLatex(source);
    const contexts = [];
    let active = null;
    let index = 0;

    while (index < masked.length) {
      taskCheckpoint(index);
      if (!active) {
        const environment = environmentOpeningAt(masked, index);
        if (environment) {
          active = {
            kind: "environment",
            environment: environment.environment,
            display: environment.display,
            openStart: index,
            contentStart: index + environment.token.length,
            close: `\\end{${environment.environment}}`
          };
          index += environment.token.length;
          continue;
        }

        const delimiter = delimiterOpeningAt(masked, index);
        if (delimiter) {
          active = {
            kind: "delimiter",
            delimiter: delimiter.token,
            display: delimiter.display,
            openStart: index,
            contentStart: index + delimiter.token.length,
            close: delimiter.close
          };
          index += delimiter.token.length;
          continue;
        }
        index += 1;
        continue;
      }

      const closingToken = closingTokenAt(masked, index, active);
      if (closingToken) {
        contexts.push({
          ...active,
          contentEnd: index,
          closeEnd: index + closingToken.length,
          complete: true
        });
        index += closingToken.length;
        active = null;
        continue;
      }
      index += 1;
    }

    if (active) {
      contexts.push({
        ...active,
        contentEnd: source.length,
        closeEnd: source.length,
        complete: false
      });
    }
    return { contexts, masked };
  }

  function autoClosedInlineEquationContext(source, cursor, masked) {
    const opening = cursor - 1;
    if (
      opening < 0 ||
      source[opening] !== "$" ||
      source[cursor] !== "$" ||
      isEscaped(masked, opening) ||
      isEscaped(masked, cursor)
    ) return null;
    return {
      kind: "delimiter",
      delimiter: "$",
      display: false,
      openStart: opening,
      contentStart: cursor,
      close: "$",
      contentEnd: cursor,
      closeEnd: cursor + 1,
      complete: true,
      source: "",
      cursorOffset: 0
    };
  }

  function findEquationContext(sourceValue, cursorValue) {
    const source = String(sourceValue || "");
    const cursor = Math.max(0, Math.min(Number(cursorValue) || 0, source.length));
    const { contexts, masked } = equationContexts(source);
    if (
      cursor < source.length &&
      masked[cursor] === MASK_CHARACTER
    ) {
      return null;
    }
    const autoClosedInline = autoClosedInlineEquationContext(source, cursor, masked);
    if (autoClosedInline) return autoClosedInline;
    const context = contexts.find((candidate) => (
      cursor >= candidate.contentStart && cursor <= candidate.contentEnd
    ));
    if (!context) return null;
    return {
      ...context,
      source: source.slice(context.contentStart, context.contentEnd),
      cursorOffset: cursor - context.contentStart
    };
  }

  function tableEnvironmentHeader(source, masked, environment, tokenEnd) {
    let position = skipWhitespace(masked, tokenEnd);
    const takeGroup = (opening, closing) => {
      if (masked[position] !== opening) return null;
      const group = readBalanced(masked, position, opening, closing);
      if (!group) return null;
      const value = source.slice(position + 1, group.end - 1);
      position = skipWhitespace(masked, group.end);
      return value;
    };
    const takeOptionalPosition = () => {
      if (masked[position] === "[") takeGroup("[", "]");
    };
    let columnSpec = "";

    if (environment === "tabular*") {
      takeGroup("{", "}");
      takeOptionalPosition();
      columnSpec = takeGroup("{", "}") ?? "";
    } else if (environment === "tabularx") {
      takeGroup("{", "}");
      columnSpec = takeGroup("{", "}") ?? "";
    } else {
      takeOptionalPosition();
      columnSpec = takeGroup("{", "}") ?? "";
    }
    return { columnSpec, contentStart: position };
  }

  function tableContexts(sourceValue) {
    const source = String(sourceValue || "");
    const masked = maskIgnoredLatex(source);
    const tokenPattern = /\\(begin|end)\s*\{([^{}\r\n]+)\}/g;
    const stack = [];
    const contexts = [];
    let match;

    while ((match = tokenPattern.exec(masked))) {
      taskCheckpoint(tokenPattern.lastIndex);
      const kind = match[1];
      const environment = match[2].trim();
      if (kind === "begin") {
        stack.push({
          environment,
          openStart: match.index,
          tokenEnd: match.index + match[0].length
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
      if (!TABLE_ENVIRONMENTS.has(environment)) continue;
      const header = tableEnvironmentHeader(
        source,
        masked,
        environment,
        opening.tokenEnd
      );
      contexts.push({
        kind: "table",
        environment,
        display: true,
        openStart: opening.openStart,
        contentStart: header.contentStart,
        contentEnd: match.index,
        closeEnd: match.index + match[0].length,
        complete: true,
        columnSpec: header.columnSpec
      });
    }

    for (const opening of stack) {
      if (!TABLE_ENVIRONMENTS.has(opening.environment)) continue;
      const header = tableEnvironmentHeader(
        source,
        masked,
        opening.environment,
        opening.tokenEnd
      );
      contexts.push({
        kind: "table",
        environment: opening.environment,
        display: true,
        openStart: opening.openStart,
        contentStart: header.contentStart,
        contentEnd: source.length,
        closeEnd: source.length,
        complete: false,
        columnSpec: header.columnSpec
      });
    }
    return contexts;
  }

  function findTableContext(sourceValue, cursorValue) {
    const source = String(sourceValue || "");
    const cursor = Math.max(0, Math.min(Number(cursorValue) || 0, source.length));
    const context = tableContexts(source)
      .filter((candidate) => (
        cursor >= candidate.openStart &&
        cursor <= candidate.closeEnd
      ))
      .sort((left, right) => (
        (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart)
      ))[0];
    if (!context) return null;
    return {
      ...context,
      source: source.slice(context.contentStart, context.contentEnd),
      cursorOffset: Math.max(
        0,
        Math.min(cursor - context.contentStart, context.contentEnd - context.contentStart)
      )
    };
  }

  function skipWhitespace(source, index) {
    let position = index;
    while (
      position < source.length &&
      (source[position] === MASK_CHARACTER || /\s/.test(source[position]))
    ) {
      position += 1;
    }
    return position;
  }

  function readBalanced(source, start, opening, closing) {
    if (source[start] !== opening) return null;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      taskCheckpoint(index - start);
      if (source[index] === opening && !isEscaped(source, index)) depth += 1;
      if (source[index] === closing && !isEscaped(source, index)) {
        depth -= 1;
        if (depth === 0) {
          return { start, end: index + 1 };
        }
      }
    }
    return null;
  }

  function readControlSequence(source, start) {
    if (source[start] !== "\\") return null;
    let end = start + 1;
    if (/[A-Za-z@]/.test(source[end] || "")) {
      while (end < source.length && /[A-Za-z@]/.test(source[end])) end += 1;
    } else if (end < source.length) {
      end += 1;
    }
    return { start, end };
  }

  function parseNewCommandRecords(sourceValue, beforeIndexValue = Infinity) {
    const source = String(sourceValue || "");
    const masked = maskIgnoredLatex(source);
    const beforeIndex = Math.max(0, Math.min(
      Number.isFinite(beforeIndexValue) ? Number(beforeIndexValue) : source.length,
      source.length
    ));
    const pattern = /\\(newcommand|renewcommand|providecommand)(\*)?/g;
    const records = [];
    let match;

    while ((match = pattern.exec(masked))) {
      taskCheckpoint(pattern.lastIndex);
      if (match.index >= beforeIndex || records.length >= 250) break;
      let position = skipWhitespace(masked, match.index + match[0].length);
      let name = "";
      if (masked[position] === "{") {
        const nameGroup = readBalanced(masked, position, "{", "}");
        if (!nameGroup) continue;
        name = source.slice(position + 1, nameGroup.end - 1).trim();
        position = nameGroup.end;
      } else {
        const nameToken = readControlSequence(masked, position);
        if (!nameToken) continue;
        name = source.slice(nameToken.start, nameToken.end);
        position = nameToken.end;
      }
      if (!/^\\(?:[A-Za-z@]+|.)$/.test(name)) continue;

      position = skipWhitespace(masked, position);
      let numArgs = 0;
      let optionalDefault = null;
      if (masked[position] === "[") {
        const argumentCount = readBalanced(masked, position, "[", "]");
        if (!argumentCount) continue;
        const rawCount = source.slice(position + 1, argumentCount.end - 1).trim();
        numArgs = Number.parseInt(rawCount, 10);
        if (!Number.isInteger(numArgs) || numArgs < 0 || numArgs > 9) continue;
        position = skipWhitespace(masked, argumentCount.end);
        if (masked[position] === "[") {
          const optionalDefaultGroup = readBalanced(masked, position, "[", "]");
          if (!optionalDefaultGroup || numArgs < 1) continue;
          optionalDefault = source.slice(position + 1, optionalDefaultGroup.end - 1);
          position = skipWhitespace(masked, optionalDefaultGroup.end);
        }
      }

      const definition = readBalanced(masked, position, "{", "}");
      if (!definition || definition.end > beforeIndex) continue;
      const raw = source.slice(match.index, definition.end).trim();
      if (raw) {
        records.push({
          kind: match[1],
          name,
          numArgs,
          optionalDefault,
          body: source.slice(position + 1, definition.end - 1),
          raw,
          start: match.index,
          end: definition.end
        });
      }
      pattern.lastIndex = definition.end;
    }
    return records;
  }

  function parseDeclareMathOperatorRecords(sourceValue, beforeIndexValue = Infinity) {
    const source = String(sourceValue || "");
    const masked = maskIgnoredLatex(source);
    const beforeIndex = Math.max(0, Math.min(
      Number.isFinite(beforeIndexValue) ? Number(beforeIndexValue) : source.length,
      source.length
    ));
    const pattern = /\\DeclareMathOperator(\*)?/g;
    const records = [];
    let match;

    while ((match = pattern.exec(masked))) {
      if (match.index >= beforeIndex || records.length >= 250) break;
      let position = skipWhitespace(masked, match.index + match[0].length);
      let name = "";
      if (masked[position] === "{") {
        const nameGroup = readBalanced(masked, position, "{", "}");
        if (!nameGroup) continue;
        name = source.slice(position + 1, nameGroup.end - 1).trim();
        position = nameGroup.end;
      } else {
        const nameToken = readControlSequence(masked, position);
        if (!nameToken) continue;
        name = source.slice(nameToken.start, nameToken.end);
        position = nameToken.end;
      }
      if (!/^\\(?:[A-Za-z@]+|.)$/.test(name)) continue;

      position = skipWhitespace(masked, position);
      const definition = readBalanced(masked, position, "{", "}");
      if (!definition || definition.end > beforeIndex) continue;
      records.push({
        kind: "DeclareMathOperator",
        name,
        starred: Boolean(match[1]),
        body: source.slice(position + 1, definition.end - 1),
        raw: source.slice(match.index, definition.end).trim(),
        start: match.index,
        end: definition.end
      });
      pattern.lastIndex = definition.end;
    }
    return records;
  }

  function extractNewCommandDefinitions(sourceValue, beforeIndexValue = Infinity) {
    return parseNewCommandRecords(sourceValue, beforeIndexValue)
      .map((record) => record.raw);
  }

  function activeDocumentCommandRecords(records) {
    const active = new Map();
    for (const record of [...records].sort((left, right) => left.start - right.start)) {
      if (record.kind === "providecommand" && active.has(record.name)) continue;
      active.set(record.name, record);
    }
    return [...active.values()];
  }

  function macroNameMatches(source, index, name) {
    if (!source.startsWith(name, index)) return false;
    const last = name[name.length - 1] || "";
    const next = source[index + name.length] || "";
    return !/[A-Za-z@]/.test(last) || !/[A-Za-z@]/.test(next);
  }

  function readMacroArgument(source, startValue) {
    const start = skipWhitespace(source, startValue);
    if (start >= source.length) return null;
    if (source[start] === "{") {
      const group = readBalanced(source, start, "{", "}");
      return group ? {
        value: source.slice(start + 1, group.end - 1),
        end: group.end
      } : null;
    }
    if (source[start] === "\\") {
      const command = readControlSequence(source, start);
      return command ? {
        value: source.slice(command.start, command.end),
        end: command.end
      } : null;
    }
    const codePoint = source.codePointAt(start);
    const end = start + (codePoint > 0xFFFF ? 2 : 1);
    return { value: source.slice(start, end), end };
  }

  function substituteMacroArguments(bodyValue, args) {
    const placeholder = "\uE000";
    return String(bodyValue || "")
      .replace(/##/g, placeholder)
      .replace(/#([1-9])/g, (_match, number) => args[Number(number) - 1] ?? "")
      .replaceAll(placeholder, "#");
  }

  function expandOptionalCommandsOnce(source, optionalRecords) {
    let output = "";
    let changed = false;
    let index = 0;

    while (index < source.length) {
      taskCheckpoint(index);
      const record = source[index] === "\\"
        ? optionalRecords.find((candidate) => macroNameMatches(source, index, candidate.name))
        : null;
      if (!record) {
        output += source[index];
        index += 1;
        continue;
      }

      let position = skipWhitespace(source, index + record.name.length);
      const args = [];
      if (source[position] === "[") {
        const optional = readBalanced(source, position, "[", "]");
        if (!optional) {
          output += source[index];
          index += 1;
          continue;
        }
        args.push(source.slice(position + 1, optional.end - 1));
        position = optional.end;
      } else {
        args.push(record.optionalDefault);
      }

      let complete = true;
      for (let argumentIndex = 1; argumentIndex < record.numArgs; argumentIndex += 1) {
        const argument = readMacroArgument(source, position);
        if (!argument) {
          complete = false;
          break;
        }
        args.push(argument.value);
        position = argument.end;
      }
      if (!complete) {
        output += source[index];
        index += 1;
        continue;
      }

      output += `{${substituteMacroArguments(record.body, args)}}`;
      index = position;
      changed = true;
    }
    return { value: output, changed };
  }

  function expandOptionalCommands(sourceValue, optionalRecords) {
    let value = String(sourceValue || "");
    for (let pass = 0; pass < 16; pass += 1) {
      const expanded = expandOptionalCommandsOnce(value, optionalRecords);
      value = expanded.value;
      if (!expanded.changed) break;
    }
    return value;
  }

  function prepareDocumentCommandContext(sourceValue, beforeIndexValue) {
    const activeRecords = activeDocumentCommandRecords([
      ...parseNewCommandRecords(sourceValue, beforeIndexValue),
      ...parseDeclareMathOperatorRecords(sourceValue, beforeIndexValue)
    ]);
    const optionalRecords = activeRecords
      .filter((record) => record.kind !== "DeclareMathOperator")
      .filter((record) => record.optionalDefault !== null)
      .sort((left, right) => right.name.length - left.name.length);
    const macros = {
      ...KATEX_COMPATIBLE_MATH_MACROS,
      // LaTeX's \ensuremath is a mode guard. SmartTeX only sends these
      // fragments to KaTeX's math renderer, so its argument is the complete
      // compatible expansion.
      "\\ensuremath": "#1"
    };

    for (const record of activeRecords) {
      if (record.kind === "DeclareMathOperator") {
        const body = expandOptionalCommands(record.body, optionalRecords);
        macros[record.name] = `\\operatorname${record.starred ? "*" : ""}{${body}}`;
        continue;
      }
      if (record.optionalDefault !== null) continue;
      macros[record.name] = expandOptionalCommands(record.body, optionalRecords);
    }
    return {
      macros,
      optionalRecords,
      count: activeRecords.length
    };
  }

  function applyPreparedDocumentCommands(preparedValue, bodyValue) {
    const prepared = preparedValue || {};
    const optionalRecords = Array.isArray(prepared.optionalRecords)
      ? prepared.optionalRecords
      : [];
    return {
      body: expandOptionalCommands(bodyValue, optionalRecords),
      macros: prepared.macros || { ...KATEX_COMPATIBLE_MATH_MACROS, "\\ensuremath": "#1" },
      count: Number(prepared.count) || 0
    };
  }

  function prepareDocumentCommands(sourceValue, beforeIndexValue, bodyValue) {
    return applyPreparedDocumentCommands(
      prepareDocumentCommandContext(sourceValue, beforeIndexValue),
      bodyValue
    );
  }

  function extendedDelimiterSequence(source, start) {
    const sequence = readControlSequence(source, start);
    if (!sequence) return null;
    const command = source.slice(sequence.start, sequence.end);
    if (!DELIMITER_COMMANDS.has(command)) return null;
    const delimiterStart = skipWhitespace(source, sequence.end);
    if (delimiterStart >= source.length) return sequence;
    if (source[delimiterStart] === "\\") {
      const delimiter = readControlSequence(source, delimiterStart);
      return delimiter ? { start: sequence.start, end: delimiter.end } : sequence;
    }
    const codePoint = source.codePointAt(delimiterStart);
    return {
      start: sequence.start,
      end: delimiterStart + (codePoint > 0xFFFF ? 2 : 1)
    };
  }

  function controlSequenceAround(source, offset) {
    const searchStart = Math.max(0, offset - 40);
    for (let start = searchStart; start <= offset; start += 1) {
      if (source[start] !== "\\") continue;
      const delimiterSequence = extendedDelimiterSequence(source, start);
      if (
        delimiterSequence &&
        offset >= delimiterSequence.start &&
        offset <= delimiterSequence.end
      ) {
        return delimiterSequence;
      }
    }

    let slash = offset;
    while (slash > 0 && /[A-Za-z@]/.test(source[slash - 1])) slash -= 1;
    if (slash > 0 && source[slash - 1] === "\\") slash -= 1;
    if (source[slash] !== "\\") return null;
    const sequence = readControlSequence(source, slash);
    if (!sequence || offset < sequence.start || offset > sequence.end) return null;
    return sequence;
  }

  function environmentDirectiveAround(sourceValue, offsetValue) {
    const source = String(sourceValue || "");
    const offset = Math.max(0, Math.min(Number(offsetValue) || 0, source.length));
    const searchStart = Math.max(0, offset - 96);

    for (let start = searchStart; start <= offset; start += 1) {
      if (source[start] !== "\\") continue;
      const command = readControlSequence(source, start);
      if (!command) continue;
      const commandName = source.slice(command.start, command.end);
      if (commandName !== "\\begin" && commandName !== "\\end") continue;
      const argumentStart = skipWhitespace(source, command.end);
      const argument = readBalanced(source, argumentStart, "{", "}");
      const end = argument?.end || command.end;
      if (offset < command.start || offset > end) continue;
      return {
        start: command.start,
        end,
        syntaxKind: "environment-directive"
      };
    }
    return null;
  }

  function rowBreakDirectiveAround(sourceValue, offsetValue) {
    const source = String(sourceValue || "");
    const offset = Math.max(0, Math.min(Number(offsetValue) || 0, source.length));
    const searchStart = Math.max(0, offset - 64);

    for (let start = searchStart; start <= offset; start += 1) {
      if (source[start] !== "\\" || source[start + 1] !== "\\") continue;
      let end = start + 2;
      if (source[end] === "*") end += 1;
      end = skipWhitespace(source, end);
      if (source[end] === "[") {
        const spacing = readBalanced(source, end, "[", "]");
        if (spacing) end = spacing.end;
      }
      if (offset < start || offset > end) continue;
      return {
        start,
        end,
        syntaxKind: "row-break-directive"
      };
    }
    return null;
  }

  function caretProtectedSequenceAround(sourceValue, offsetValue) {
    const source = String(sourceValue || "");
    const offset = Math.max(0, Math.min(Number(offsetValue) || 0, source.length));
    return (
      environmentDirectiveAround(source, offset) ||
      rowBreakDirectiveAround(source, offset) ||
      controlSequenceAround(source, offset)
    );
  }

  function resolveCaretPlacement(sourceValue, offsetValue, previousValue = null) {
    const source = String(sourceValue || "");
    const cursorOffset = Math.max(
      0,
      Math.min(Number(offsetValue) || 0, source.length)
    );
    const command = caretProtectedSequenceAround(source, cursorOffset);
    if (!command) {
      return {
        cursorOffset,
        commandStart: null,
        commandEnd: null,
        commandSide: null
      };
    }

    let commandSide;
    if (cursorOffset <= command.start) {
      commandSide = "left";
    } else if (cursorOffset >= command.end) {
      commandSide = "right";
    } else if (
      previousValue?.commandStart === command.start &&
      (previousValue.commandSide === "left" || previousValue.commandSide === "right")
    ) {
      commandSide = previousValue.commandSide;
    } else {
      commandSide = Number(previousValue?.cursorOffset) >= command.end
        ? "right"
        : "left";
    }

    return {
      cursorOffset,
      commandStart: command.start,
      commandEnd: command.end,
      commandSide
    };
  }

  function nextAtomEnd(source, startValue) {
    let start = skipWhitespace(source, startValue);
    if (start >= source.length) return start;
    if (source[start] === "{") {
      return readBalanced(source, start, "{", "}")?.end || source.length;
    }
    if (source[start] === "\\") {
      const command = readControlSequence(source, start);
      if (!command) return start + 1;
      let end = command.end;
      let groups = 0;
      while (groups < 4) {
        const groupStart = skipWhitespace(source, end);
        const opening = source[groupStart];
        if (opening !== "{" && opening !== "[") break;
        const group = readBalanced(
          source,
          groupStart,
          opening,
          opening === "{" ? "}" : "]"
        );
        if (!group) break;
        end = group.end;
        groups += 1;
      }
      return end;
    }
    const codePoint = source.codePointAt(start);
    return start + (codePoint > 0xFFFF ? 2 : 1);
  }

  function commandAwareCaretOffset(sourceValue, offsetValue, commandSide = null) {
    const source = String(sourceValue || "");
    let offset = Math.max(0, Math.min(Number(offsetValue) || 0, source.length));
    const command = caretProtectedSequenceAround(source, offset);
    if (command && offset > command.start && offset < command.end) {
      offset = commandSide === "right" ? command.end : command.start;
    } else if (command && offset < command.end) {
      offset = command.start;
    } else if (command && offset === command.end) {
      const next = skipWhitespace(source, offset);
      if (source[next] === "{" || source[next] === "[") {
        offset = command.start;
      }
    }
    return offset;
  }

  function cursorInsideControlSequence(sourceValue, offsetValue) {
    const source = String(sourceValue || "");
    const offset = Math.max(0, Math.min(Number(offsetValue) || 0, source.length));
    const command = caretProtectedSequenceAround(source, offset);
    return Boolean(
      command &&
      offset > command.start &&
      offset < command.end
    );
  }

  function cursorAtProtectedAtomBoundary(sourceValue, offsetValue) {
    const source = String(sourceValue || "");
    const offset = Math.max(0, Math.min(Number(offsetValue) || 0, source.length));

    // A caret immediately after a superscript/subscript marker is rendered
    // inside the following atom so that the preview remains valid LaTeX. Mark
    // that relocated caret red when the atom is a group or a command, because
    // inserting text at the literal source position would split the construct.
    let previous = offset - 1;
    while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
    if (source[previous] !== "^" && source[previous] !== "_") return false;

    const next = skipWhitespace(source, offset);
    return source[next] === "{" || source[next] === "\\";
  }

  function injectCaret(sourceValue, offsetValue, commandSide = null) {
    const source = String(sourceValue || "");
    const offset = commandAwareCaretOffset(source, offsetValue, commandSide);

    const next = skipWhitespace(source, offset);
    if (source[next] === "{") {
      return `${source.slice(0, next + 1)}${CARET_MACRO}${source.slice(next + 1)}`;
    }

    let previous = offset - 1;
    while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
    if (source[previous] === "^" || source[previous] === "_") {
      if (next >= source.length) {
        return `${source.slice(0, offset)}{${CARET_MACRO}}${source.slice(offset)}`;
      }
      const atomEnd = nextAtomEnd(source, next);
      return (
        source.slice(0, offset) +
        `{${CARET_MACRO}` +
        source.slice(offset, atomEnd) +
        "}" +
        source.slice(atomEnd)
      );
    }

    return `${source.slice(0, offset)}${CARET_MACRO}${source.slice(offset)}`;
  }

  function splitMathRows(sourceValue) {
    const source = String(sourceValue || "");
    const rows = [];
    let start = 0;
    let braceDepth = 0;

    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "{" && !isEscaped(source, index)) {
        braceDepth += 1;
        continue;
      }
      if (source[index] === "}" && !isEscaped(source, index)) {
        braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
      if (
        braceDepth !== 0 ||
        source[index] !== "\\" ||
        source[index + 1] !== "\\"
      ) {
        continue;
      }

      rows.push(source.slice(start, index));
      index += 1;
      let next = index + 1;
      if (source[next] === "*") next += 1;
      while (next < source.length && /[ \t]/.test(source[next])) next += 1;
      if (source[next] === "[") {
        const spacing = readBalanced(source, next, "[", "]");
        if (spacing) next = spacing.end;
      }
      start = next;
      index = next - 1;
    }
    rows.push(source.slice(start));
    return rows;
  }

  function rowNumberDirective(sourceValue) {
    const source = String(sourceValue || "");
    const masked = maskIgnoredLatex(source);
    const tagPattern = /\\tag(\*)?\s*\{/g;
    const ranges = [];
    let tag = null;
    let match;

    while ((match = tagPattern.exec(masked))) {
      const opening = match.index + match[0].lastIndexOf("{");
      const group = readBalanced(masked, opening, "{", "}");
      if (!group) continue;
      tag = {
        value: source.slice(opening + 1, group.end - 1).trim(),
        starred: Boolean(match[1])
      };
      ranges.push({ start: match.index, end: group.end });
      tagPattern.lastIndex = group.end;
    }

    const withoutTags = ranges
      .sort((left, right) => right.start - left.start)
      .reduce(
        (value, range) => value.slice(0, range.start) + value.slice(range.end),
        source
      );
    const suppressed = /\\(?:nonumber|notag)\b/.test(masked);
    return {
      source: withoutTags
        .replace(/\\(?:nonumber|notag)\b/g, "")
        .trim(),
      suppressed,
      tag
    };
  }

  function equationLineDirectives(context) {
    const environment = String(context?.environment || "");
    const baseEnvironment = environment.replace(/\*$/, "");
    const multiRow = [
      "align",
      "alignat",
      "flalign",
      "gather",
      "eqnarray",
      "multline"
    ].includes(baseEnvironment);
    const sources = multiRow ? splitMathRows(context?.source) : [String(context?.source || "")];
    return {
      baseEnvironment,
      multiRow,
      rows: sources.map(rowNumberDirective)
    };
  }

  function equationCounterIncrement(context) {
    if (context?.kind !== "environment") return 0;
    const environment = String(context.environment || "");
    if (environment.endsWith("*")) return 0;
    const { baseEnvironment, rows } = equationLineDirectives(context);
    if (![
      "equation",
      "align",
      "alignat",
      "flalign",
      "gather",
      "multline",
      "eqnarray"
    ].includes(baseEnvironment)) {
      return 0;
    }
    if (baseEnvironment === "multline" || baseEnvironment === "equation") {
      return rows.some((row) => row.suppressed) ? 0 : 1;
    }
    return rows.filter((row) => !row.suppressed).length;
  }

  function equationPreviewNumberingAtCounter(
    context,
    counterValue = 0,
    formatNumber = (value) => String(value)
  ) {
    const environment = String(context?.environment || "");
    const starred = environment.endsWith("*");
    const directives = equationLineDirectives(context);
    const automaticallyNumbered = (
      context?.kind === "environment" &&
      !starred &&
      [
        "equation",
        "align",
        "alignat",
        "flalign",
        "gather",
        "multline",
        "eqnarray"
      ].includes(directives.baseEnvironment)
    );
    let counter = Math.max(0, Number(counterValue) || 0);
    const numbers = directives.rows.map(() => null);

    if (directives.baseEnvironment === "multline") {
      const tagIndex = directives.rows.findIndex((row) => row.tag);
      const suppressed = directives.rows.some((row) => row.suppressed);
      if (automaticallyNumbered && !suppressed) counter += 1;
      const numberIndex = tagIndex >= 0 ? tagIndex : directives.rows.length - 1;
      const tag = tagIndex >= 0 ? directives.rows[tagIndex].tag : null;
      if (tag || (automaticallyNumbered && !suppressed)) {
        numbers[numberIndex] = tag || { value: formatNumber(counter), starred: false };
      }
    } else {
      directives.rows.forEach((row, index) => {
        if (automaticallyNumbered && !row.suppressed) counter += 1;
        if (row.tag) {
          numbers[index] = row.tag;
        } else if (automaticallyNumbered && !row.suppressed) {
          numbers[index] = { value: formatNumber(counter), starred: false };
        }
      });
    }

    return {
      numbering: {
        ...directives,
        numbers
      },
      counter
    };
  }

  function analyzeEquations(sourceValue) {
    const source = String(sourceValue || "");
    const parsed = equationContexts(source);
    const counters = documentCounterAnalysis(source, parsed, false);

    return {
      ...parsed,
      numberingByOpenStart: counters.equationNumberingByOpenStart,
      finalCounter: parsed.contexts.reduce((total, context) => (
        total + equationCounterIncrement({
          ...context,
          source: source.slice(context.contentStart, context.contentEnd)
        })
      ), 0)
    };
  }

  function findEquationContextFromAnalysis(sourceValue, cursorValue, analysisValue) {
    const source = String(sourceValue || "");
    const cursor = Math.max(0, Math.min(Number(cursorValue) || 0, source.length));
    const analysis = analysisValue || analyzeEquations(source);
    const masked = String(analysis?.masked || "");
    if (cursor < source.length && masked[cursor] === MASK_CHARACTER) return null;
    const autoClosedInline = autoClosedInlineEquationContext(source, cursor, masked);
    if (autoClosedInline) return autoClosedInline;
    const contexts = Array.isArray(analysis?.contexts) ? analysis.contexts : [];
    let context = null;
    let low = 0;
    let high = contexts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = contexts[middle];
      if (cursor < candidate.contentStart) {
        high = middle - 1;
      } else if (cursor > candidate.contentEnd) {
        low = middle + 1;
      } else {
        context = candidate;
        break;
      }
    }
    if (!context) return null;
    return {
      ...context,
      source: source.slice(context.contentStart, context.contentEnd),
      cursorOffset: cursor - context.contentStart
    };
  }

  function equationPreviewNumbering(sourceValue, context) {
    const source = String(sourceValue || "");
    const analysis = documentCounterAnalysis(source, null, false);
    const cached = analysis.equationNumberingByOpenStart.get(context?.openStart);
    if (cached) return cached;

    let counter = 0;
    for (let candidateIndex = 0; candidateIndex < analysis.contexts.length; candidateIndex += 1) {
      taskCheckpoint(candidateIndex, 32);
      const candidate = analysis.contexts[candidateIndex];
      if (candidate.closeEnd > Number(context?.openStart)) break;
      const completeContext = {
        ...candidate,
        source: source.slice(candidate.contentStart, candidate.contentEnd)
      };
      counter = equationPreviewNumberingAtCounter(completeContext, counter).counter;
    }
    return equationPreviewNumberingAtCounter(context, counter).numbering;
  }

  function genericEnvironmentContexts(sourceValue, environmentNames) {
    const source = String(sourceValue || "");
    const masked = maskIgnoredLatex(source);
    const names = new Set(environmentNames);
    const tokenPattern = /\\(begin|end)\s*\{([^{}\r\n]+)\}/g;
    const stack = [];
    const contexts = [];
    let match;

    while ((match = tokenPattern.exec(masked))) {
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

    for (const opening of stack) {
      if (!names.has(opening.environment)) continue;
      contexts.push({
        ...opening,
        contentEnd: source.length,
        closeEnd: source.length,
        complete: false
      });
    }
    return contexts;
  }

  function tableFloatContexts(sourceValue) {
    const source = String(sourceValue || "");
    return genericEnvironmentContexts(source, ["table", "table*"]).map((context) => ({
      ...context,
      kind: "table-float",
      display: true,
      source: source.slice(context.contentStart, context.contentEnd)
    }));
  }

  function findTableFloatContext(sourceValue, cursorValue) {
    const source = String(sourceValue || "");
    const cursor = Math.max(0, Math.min(Number(cursorValue) || 0, source.length));
    const floatContext = tableFloatContexts(source)
      .filter((candidate) => (
        cursor >= candidate.openStart &&
        cursor <= candidate.closeEnd
      ))
      .sort((left, right) => (
        (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart)
      ))[0];
    if (!floatContext) return null;

    const tableContext = tableContexts(source)
      .filter((candidate) => (
        candidate.openStart >= floatContext.contentStart &&
        candidate.closeEnd <= floatContext.contentEnd
      ))
      .sort((left, right) => left.openStart - right.openStart)[0];
    if (!tableContext) return null;

    return {
      ...tableContext,
      source: source.slice(tableContext.contentStart, tableContext.contentEnd),
      cursorOffset: Math.max(
        0,
        Math.min(
          cursor - tableContext.contentStart,
          tableContext.contentEnd - tableContext.contentStart
        )
      ),
      cursorInsideTable: (
        cursor >= tableContext.openStart &&
        cursor <= tableContext.closeEnd
      ),
      floatOpenStart: floatContext.openStart,
      floatContentStart: floatContext.contentStart,
      floatContentEnd: floatContext.contentEnd,
      floatCloseEnd: floatContext.closeEnd
    };
  }

  function figureContexts(sourceValue) {
    const source = String(sourceValue || "");
    return genericEnvironmentContexts(source, ["figure", "figure*"]).map((context) => ({
      ...context,
      kind: "figure",
      display: true,
      source: source.slice(context.contentStart, context.contentEnd)
    }));
  }

  function findFigureContext(sourceValue, cursorValue) {
    const source = String(sourceValue || "");
    const cursor = Math.max(0, Math.min(Number(cursorValue) || 0, source.length));
    const context = figureContexts(source)
      .filter((candidate) => (
        cursor >= candidate.openStart &&
        cursor <= candidate.closeEnd
      ))
      .sort((left, right) => (
        (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart)
      ))[0];
    if (!context) return null;
    return {
      ...context,
      cursorOffset: Math.max(
        0,
        Math.min(cursor - context.contentStart, context.contentEnd - context.contentStart)
      )
    };
  }

  function figurePreviewNumber(sourceValue, context) {
    const number = documentCounterAnalysis(sourceValue)
      .figureNumbersByOpenStart.get(context?.openStart) ?? null;
    return /^\d+$/.test(String(number ?? "")) ? Number(number) : number;
  }

  function hasNumberedCaption(sourceValue) {
    const masked = maskIgnoredLatex(sourceValue);
    return /\\caption(?!\*)\s*(?:\[[^\]\r\n]*\]\s*)?\{/.test(masked);
  }

  function tablePreviewNumber(sourceValue, context) {
    const source = String(sourceValue || "");
    const analysis = documentCounterAnalysis(source);
    const floats = analysis.tables;
    const enclosing = floats
      .filter((candidate) => (
        candidate.openStart <= context.openStart &&
        candidate.closeEnd >= context.closeEnd
      ))
      .sort((left, right) => (
        (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart)
      ))[0];
    if (!enclosing) return null;
    const enclosingSource = source.slice(enclosing.contentStart, enclosing.contentEnd);
    if (!hasNumberedCaption(enclosingSource)) return null;
    const number = analysis.tableNumbersByOpenStart.get(enclosing.openStart) ?? null;
    return /^\d+$/.test(String(number ?? "")) ? Number(number) : number;
  }

  function floatCaption(sourceValue, context, kindValue) {
    const source = String(sourceValue || "");
    const kind = kindValue === "table" ? "table" : "figure";
    const environments = kind === "table"
      ? ["table", "table*"]
      : ["figure", "figure*"];
    const enclosing = genericEnvironmentContexts(source, environments)
      .filter((candidate) => (
        candidate.openStart <= context?.openStart &&
        candidate.closeEnd >= context?.closeEnd
      ))
      .sort((left, right) => (
        (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart)
      ))[0];
    if (!enclosing) return null;
    const body = source.slice(enclosing.contentStart, enclosing.contentEnd);
    const masked = maskIgnoredLatex(body);
    const captionPattern = /\\caption(\*)?/g;
    const match = captionPattern.exec(masked);
    if (!match) return null;
    let position = skipWhitespace(masked, match.index + match[0].length);
    if (masked[position] === "[") {
      const shortCaption = readBalanced(masked, position, "[", "]");
      if (!shortCaption) return null;
      position = skipWhitespace(masked, shortCaption.end);
    }
    if (masked[position] !== "{") return null;
    const caption = readBalanced(masked, position, "{", "}");
    if (!caption) return null;
    const rawStart = enclosing.contentStart + position + 1;
    const rawEnd = enclosing.contentStart + caption.end - 1;
    const rawText = source.slice(rawStart, rawEnd);
    // TeX comments are active inside caption arguments as well. Replace the
    // commented characters with spaces rather than deleting them so all
    // source offsets used for cursor/selection mapping remain exact.
    const renderedText = removeLatexCommentsPreservingLength(rawText);
    const leadingWhitespace = renderedText.length - renderedText.trimStart().length;
    const trailingWhitespace = renderedText.length - renderedText.trimEnd().length;
    return {
      text: renderedText.trim(),
      starred: Boolean(match[1]),
      rawStart,
      rawEnd,
      start: rawStart + leadingWhitespace,
      end: Math.max(
        rawStart + leadingWhitespace,
        rawEnd - trailingWhitespace
      )
    };
  }

  function containsLabel(sourceValue, labelValue) {
    const label = String(labelValue || "").trim();
    const pattern = /\\label\s*\{([^{}]+)\}/g;
    const masked = maskIgnoredLatex(sourceValue);
    let match;
    while ((match = pattern.exec(masked))) {
      taskCheckpoint(pattern.lastIndex);
      if (match[1].trim() === label) return true;
    }
    return false;
  }

  function referenceTarget(sourceValue, labelValue) {
    const source = String(sourceValue || "");
    const label = String(labelValue || "").trim();
    if (!label) return null;
    const masked = maskIgnoredLatex(source);
    const labelPattern = /\\label\s*\{([^{}]+)\}/g;
    let labelIndex = -1;
    let labelMatch;
    while ((labelMatch = labelPattern.exec(masked))) {
      taskCheckpoint(labelPattern.lastIndex);
      if (labelMatch[1].trim() === label) {
        labelIndex = labelMatch.index;
        break;
      }
    }
    if (labelIndex < 0) return null;

    const equation = equationContexts(source).contexts.find((candidate) => (
      labelIndex >= candidate.openStart && labelIndex <= candidate.closeEnd
    ));
    if (equation) {
      const complete = {
        ...equation,
        source: source.slice(equation.contentStart, equation.contentEnd)
      };
      const numbering = equationPreviewNumbering(source, complete);
      let rowIndex = numbering.rows.findIndex((row) => (
        containsLabel(row.source, label)
      ));
      if (rowIndex < 0) {
        rowIndex = numbering.numbers.findIndex(Boolean);
      }
      return {
        label,
        type: "equation",
        number: numbering.numbers[rowIndex]?.value || "",
        sourceIndex: equation.openStart,
        context: complete,
        numbering
      };
    }

    const figure = figureContexts(source).find((candidate) => (
      labelIndex >= candidate.openStart && labelIndex <= candidate.closeEnd
    ));
    if (figure) {
      return {
        label,
        type: "figure",
        number: figurePreviewNumber(source, figure),
        sourceIndex: figure.openStart,
        context: figure,
        caption: floatCaption(source, figure, "figure")?.text || ""
      };
    }

    const table = genericEnvironmentContexts(source, ["table", "table*"])
      .find((candidate) => (
        labelIndex >= candidate.openStart && labelIndex <= candidate.closeEnd
      ));
    if (table) {
      return {
        label,
        type: "table",
        number: tablePreviewNumber(source, table),
        sourceIndex: table.openStart,
        context: table,
        caption: floatCaption(source, table, "table")?.text || ""
      };
    }

    const numberedSections = sectionNumbering(source);
    const matchedSection = numberedSections
      .filter((candidate) => candidate.sourceIndex <= labelIndex)
      .at(-1);
    const section = matchedSection
      ? {
          label,
          type: "section",
          number: matchedSection.number,
          title: matchedSection.title,
          sourceIndex: matchedSection.sourceIndex
        }
      : null;
    return section || {
      label,
      type: "label",
      number: "",
      sourceIndex: labelIndex
    };
  }

  function splitMathRowsWithOffsets(sourceValue) {
    const source = String(sourceValue || "");
    const rows = [];
    let start = 0;
    let braceDepth = 0;

    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "{" && !isEscaped(source, index)) {
        braceDepth += 1;
        continue;
      }
      if (source[index] === "}" && !isEscaped(source, index)) {
        braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
      if (
        braceDepth !== 0 ||
        source[index] !== "\\" ||
        source[index + 1] !== "\\"
      ) {
        continue;
      }

      rows.push({ source: source.slice(start, index), start, end: index });
      index += 1;
      let next = index + 1;
      if (source[next] === "*") next += 1;
      while (next < source.length && /[ \t]/.test(source[next])) next += 1;
      if (source[next] === "[") {
        const spacing = readBalanced(source, next, "[", "]");
        if (spacing) next = spacing.end;
      }
      start = next;
      index = next - 1;
    }
    rows.push({ source: source.slice(start), start, end: source.length });
    return rows;
  }

  function labelsInSourceRange(sourceValue, maskedValue, startValue, endValue) {
    const source = String(sourceValue || "");
    const masked = String(maskedValue || maskIgnoredLatex(source));
    const start = Math.max(0, Math.min(Number(startValue) || 0, source.length));
    const end = Math.max(start, Math.min(Number(endValue) || 0, source.length));
    const segment = masked.slice(start, end);
    const pattern = /\\label\s*\{([^{}]+)\}/g;
    const labels = [];
    let match;
    while ((match = pattern.exec(segment))) {
      taskCheckpoint(pattern.lastIndex, 32);
      const label = String(match[1] || "").trim();
      if (!label) continue;
      labels.push({
        label,
        sourceIndex: start + match.index
      });
    }
    return labels;
  }

  function numberedOutlineElements(sourceValue) {
    const source = String(sourceValue || "");
    if (!source) return [];
    const masked = maskIgnoredLatex(source);
    const analysis = documentCounterAnalysis(source);
    const elements = [];

    for (const context of analysis.equations || []) {
      const numbering = analysis.equationNumberingByOpenStart.get(context.openStart);
      if (!numbering?.numbers?.length) continue;
      const body = source.slice(context.contentStart, context.contentEnd);
      const rows = splitMathRowsWithOffsets(body);
      numbering.numbers.forEach((number, rowIndex) => {
        if (!number?.value) return;
        const row = rows[rowIndex] || rows[rows.length - 1] || {
          start: 0,
          end: body.length,
          source: body
        };
        const rowStart = context.contentStart + row.start;
        const rowEnd = context.contentStart + row.end;
        const labels = labelsInSourceRange(source, masked, rowStart, rowEnd);
        elements.push({
          type: "equation",
          number: String(number.value),
          label: labels[0]?.label || "",
          sourceIndex: rowStart,
          environmentSourceIndex: context.openStart
        });
      });
    }

    for (const context of analysis.figures || []) {
      const number = analysis.figureNumbersByOpenStart.get(context.openStart);
      if (number === undefined || number === null || String(number) === "") continue;
      const labels = labelsInSourceRange(source, masked, context.openStart, context.closeEnd);
      const caption = floatCaption(source, context, "figure");
      elements.push({
        type: "figure",
        number: String(number),
        label: labels[0]?.label || "",
        sourceIndex: context.openStart,
        caption: caption?.text || "",
        captionSourceIndex: Number.isFinite(Number(caption?.start)) ? Number(caption.start) : null
      });
    }

    for (const context of analysis.tables || []) {
      const number = analysis.tableNumbersByOpenStart.get(context.openStart);
      if (number === undefined || number === null || String(number) === "") continue;
      const labels = labelsInSourceRange(source, masked, context.openStart, context.closeEnd);
      const caption = floatCaption(source, context, "table");
      elements.push({
        type: "table",
        number: String(number),
        label: labels[0]?.label || "",
        sourceIndex: context.openStart,
        caption: caption?.text || "",
        captionSourceIndex: Number.isFinite(Number(caption?.start)) ? Number(caption.start) : null
      });
    }

    return elements.sort((left, right) => (
      Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0)
    ));
  }

  function equationNumberLatex(number) {
    if (!number?.value) return "";
    return number.starred
      ? `{${number.value}}`
      : `\\text{(}${number.value}\\text{)}`;
  }

  function previewBody(
    context,
    commandSide = null,
    numbering = null,
    includeCaret = true
  ) {
    const withCaret = includeCaret
      ? injectCaret(context.source, context.cursorOffset, commandSide)
      : String(context.source || "");
    if (context.kind !== "environment") return withCaret;
    const environment = String(context.environment || "").replace(/\*$/, "");
    const numberedRows = numbering?.rows?.length
      ? splitMathRows(withCaret).map(rowNumberDirective)
      : null;
    if (["align", "alignat", "flalign", "eqnarray"].includes(environment)) {
      const body = numberedRows
        ? numberedRows.map((row, index) => {
          const number = equationNumberLatex(numbering.numbers[index]);
          return `${row.source}&&${number ? `\\qquad\\qquad ${number}` : ""}`;
        }).join("\\\\")
        : withCaret;
      return `\\begin{aligned}${body}\\end{aligned}`;
    }
    if (environment === "gather") {
      if (!numberedRows) return `\\begin{gathered}${withCaret}\\end{gathered}`;
      const body = numberedRows.map((row, index) => {
        const number = equationNumberLatex(numbering.numbers[index]);
        return `${row.source}&&${number ? `\\qquad\\qquad ${number}` : ""}`;
      }).join("\\\\");
      return `\\begin{aligned}${body}\\end{aligned}`;
    }
    if (environment === "multline") {
      const body = (numberedRows || [{ source: withCaret }]).map((row, index) => {
        const number = equationNumberLatex(numbering?.numbers?.[index]);
        return `${row.source}&&${number ? `\\qquad\\qquad ${number}` : ""}`;
      }).join("\\\\");
      return `\\begin{aligned}${body}\\end{aligned}`;
    }
    const row = rowNumberDirective(withCaret);
    const number = equationNumberLatex(numbering?.numbers?.[0]);
    return `${row.source}${number ? `\\qquad\\qquad ${number}` : ""}`;
  }

  global.SmartTeXLatexContext = Object.freeze({
    maskIgnoredLatex,
    removeLatexCommentsPreservingLength,
    equationContexts,
    findEquationContext,
    tableContexts,
    findTableContext,
    tableFloatContexts,
    findTableFloatContext,
    figureContexts,
    findFigureContext,
    extractNewCommandDefinitions,
    prepareDocumentCommands,
    katexCompatibleMathMacros: () => ({ ...KATEX_COMPATIBLE_MATH_MACROS }),
    prepareDocumentCommandContext,
    applyPreparedDocumentCommands,
    analyzeEquations,
    findEquationContextFromAnalysis,
    resolveCaretPlacement,
    commandAwareCaretOffset,
    cursorInsideControlSequence,
    cursorAtProtectedAtomBoundary,
    injectCaret,
    previewBody,
    equationPreviewNumbering,
    tablePreviewNumber,
    figurePreviewNumber,
    floatCaption,
    sectionNumbering,
    referenceTarget,
    numberedOutlineElements
  });
})(globalThis);
