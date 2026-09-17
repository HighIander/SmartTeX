"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "latex-context.js"));
require(path.join(__dirname, "..", "table-renderer.js"));
const tools = globalThis.SmartTeXLatexContext;
const tableTools = globalThis.SmartTeXTableRenderer;
const katex = require(path.join(__dirname, "..", "vendor", "katex", "katex.min.js"));

function equationAt(source, marker = "|") {
  const cursor = source.indexOf(marker);
  assert.notEqual(cursor, -1, "test source must contain a cursor marker");
  const cleanSource = source.slice(0, cursor) + source.slice(cursor + marker.length);
  return {
    source: cleanSource,
    context: tools.findEquationContext(cleanSource, cursor)
  };
}

function tableAt(source, marker = "|") {
  const cursor = source.indexOf(marker);
  assert.notEqual(cursor, -1, "test table source must contain a cursor marker");
  const cleanSource = source.slice(0, cursor) + source.slice(cursor + marker.length);
  return {
    source: cleanSource,
    context: tools.findTableContext(cleanSource, cursor)
  };
}

{
  const { context } = equationAt("Text $a+|b$ text");
  assert.equal(context.source, "a+b");
  assert.equal(context.cursorOffset, 2);
  assert.equal(context.display, false);
}

{
  const { source, context } = equationAt("Text $|$ text");
  assert.ok(context, "an editor-created empty $…$ pair must already be an equation");
  assert.equal(context.source, "");
  assert.equal(context.display, false);
  assert.equal(context.complete, true);
  assert.equal(
    tools.findEquationContextFromAnalysis(source, context.contentStart, tools.analyzeEquations(source))
      ?.display,
    false,
    "cached equation lookup must recognize the auto-closed inline pair too"
  );
}

{
  const { context } = equationAt("Text $1|$ text");
  assert.ok(context, "typing inside an auto-closed inline pair must retain the equation context");
  assert.equal(context.source, "1");
  assert.equal(context.cursorOffset, 1);
  assert.equal(context.display, false);
}

{
  const { context } = equationAt("\\[\\frac{a}{|b}\\]");
  assert.equal(context.source, "\\frac{a}{b}");
  assert.equal(context.display, true);
}

{
  const { context } = equationAt("\\begin{align}a &= |b \\\\ c &= d\\end{align}");
  assert.equal(context.environment, "align");
  assert.match(tools.previewBody(context), /\\begin\{aligned\}/);
}

{
  const markedSource = [
    "\\begin{equation}a=b\\end{equation}",
    "\\begin{align}",
    "c &= |d \\\\",
    "e &= f \\notag \\\\",
    "g &= h \\tag{A}",
    "\\end{align}"
  ].join("\n");
  const cursor = markedSource.indexOf("|");
  const source = markedSource.slice(0, cursor) + markedSource.slice(cursor + 1);
  const context = tools.findEquationContext(source, cursor);
  const numbering = tools.equationPreviewNumbering(source, context);
  assert.equal(numbering.numbers[0].value, "2");
  assert.equal(numbering.numbers[1], null);
  assert.equal(numbering.numbers[2].value, "A");
  const body = tools.previewBody(context, null, numbering);
  assert.match(body, /\\qquad\\qquad \\text\{\(\}2\\text\{\)\}/);
  assert.doesNotMatch(body, /\\notag|\\tag/);
}

{
  const { source, context } = equationAt(
    "\\begin{equation*}a=|b\\tag{manual}\\end{equation*}"
  );
  const numbering = tools.equationPreviewNumbering(source, context);
  assert.equal(numbering.numbers[0].value, "manual");
  assert.equal(numbering.numbers[0].starred, false);
}

{
  const source = "% $not math$\nPrice: \\$5";
  assert.equal(tools.findEquationContext(source, source.indexOf("not")), null);
  assert.equal(tools.findEquationContext(source, source.length), null);
}

{
  const { context } = tableAt(
    "\\begin{tabular}{|l|c|}\\hline Name & Value \\\\ Sample§ & $x^2$ \\\\ \\hline\\end{tabular}",
    "§"
  );
  assert.ok(context);
  assert.equal(context.kind, "table");
  assert.equal(context.environment, "tabular");
  assert.equal(context.columnSpec, "|l|c|");
  const model = tableTools.parseTable(context.source, context.columnSpec);
  assert.equal(model.rows.length, 2);
  assert.equal(model.rows[0].cells.length, 2);
  assert.equal(model.columns[0].align, "left");
  assert.equal(model.columns[1].align, "center");
  assert.equal(model.columns[0].leftBorder, 1);
  assert.equal(model.columns[1].rightBorder, 1);
  assert.equal(model.rows[0].ruleBefore.full, 1);
  assert.equal(model.rows[1].ruleAfter.full, 1);
}

{
  const { context } = tableAt(
    "\\begin{tabularx}{\\textwidth}{lX}\\multicolumn{2}{c}{Head|ing} \\\\ A & B\\end{tabularx}"
  );
  assert.ok(context);
  assert.equal(context.environment, "tabularx");
  assert.equal(context.columnSpec, "lX");
  const model = tableTools.parseTable(context.source, context.columnSpec);
  assert.equal(model.rows[0].cells[0].colspan, 2);
  assert.equal(model.rows[0].cells[0].content, "Heading");
}

{
  const { source, context } = tableAt(
    "\\[\\begin{array}{cr}a & b \\\\ c & d|\\end{array}\\]"
  );
  const equation = tools.findEquationContext(source, context.contentEnd);
  assert.equal(context.environment, "array");
  assert.equal(context.columnSpec, "cr");
  assert.ok(
    (context.closeEnd - context.openStart) <
    (equation.closeEnd - equation.openStart),
    "the array context must be more specific than its enclosing display equation"
  );
}

{
  const markedSource = [
    "\\begin{table}",
    "\\caption{First}",
    "\\begin{tabular}{c}A\\end{tabular}",
    "\\end{table}",
    "\\begin{table}",
    "\\caption{Second}",
    "\\begin{tabular}{c}B|\\end{tabular}",
    "\\end{table}"
  ].join("\n");
  const cursor = markedSource.indexOf("|");
  const source = markedSource.slice(0, cursor) + markedSource.slice(cursor + 1);
  const context = tools.findTableContext(source, cursor);
  assert.equal(tools.tablePreviewNumber(source, context), 2);
  const caption = tools.floatCaption(source, context, "table");
  assert.equal(caption.text, "Second");
  assert.equal(caption.starred, false);
  assert.equal(source.slice(caption.start, caption.end), "Second");
}

{
  const { source, context } = tableAt(
    "\\begin{tabular}{c}Unnumbered|\\end{tabular}"
  );
  assert.equal(tools.tablePreviewNumber(source, context), null);
}

{
  const markedSource = [
    "\\begin{figure}",
    "\\includegraphics{sample}",
    "\\caption{A {nested} caption}",
    "|\\end{figure}"
  ].join("\n");
  const cursor = markedSource.indexOf("|");
  const source = markedSource.slice(0, cursor) + markedSource.slice(cursor + 1);
  const context = tools.findFigureContext(source, cursor);
  const caption = tools.floatCaption(source, context, "figure");
  assert.equal(caption.text, "A {nested} caption");
  assert.equal(caption.starred, false);
  assert.equal(source.slice(caption.start, caption.end), "A {nested} caption");
}

{
  const source = [
    "\\newcommand{\\vect}[1]{\\mathbf{#1}}",
    "\\providecommand{\\R}{\\mathbb{R}}",
    "$\\vect{x}| \\in \\R$",
    "\\newcommand{\\later}{z}"
  ].join("\n");
  const cursor = source.indexOf("|");
  const cleanSource = source.slice(0, cursor) + source.slice(cursor + 1);
  const context = tools.findEquationContext(cleanSource, cursor);
  const definitions = tools.extractNewCommandDefinitions(cleanSource, context.openStart);
  assert.equal(definitions.length, 2);
  assert.match(definitions[0], /\\newcommand\{\\vect\}/);
  assert.doesNotMatch(definitions.join("\n"), /\\later/);

  assert.ok(context);
  const body = tools.previewBody(context);
  assert.match(body, /\\SmartTeXCaret/);
  const prepared = tools.prepareDocumentCommands(cleanSource, context.openStart, body);
  const html = katex.renderToString(prepared.body, {
    throwOnError: true,
    strict: "ignore",
    trust: (renderContext) => (
      renderContext.command === "\\htmlClass" &&
      renderContext.class === "smarttex-rendered-caret"
    ),
    macros: {
      ...prepared.macros,
      "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
    }
  });
  assert.match(html, /smarttex-rendered-caret/);
  assert.match(html, /katex-html[\s\S]*smarttex-rendered-caret/);
  assert.match(html, /mathbf/);
}

{
  const markedSource = [
    String.raw`\DeclareMathOperator{\erfcx}{erfcx}`,
    String.raw`\DeclareMathOperator*{\argmax}{arg\,max}`,
    String.raw`\begin{equation}`,
    String.raw`\erfcx(x)+\argmax_{y}| f(y)`,
    String.raw`\end{equation}`,
    String.raw`\DeclareMathOperator{\laterop}{later}`
  ].join("\n");
  const cursor = markedSource.indexOf("|");
  const source = markedSource.slice(0, cursor) + markedSource.slice(cursor + 1);
  const context = tools.findEquationContext(source, cursor);
  const prepared = tools.prepareDocumentCommands(
    source,
    context.openStart,
    tools.previewBody(context)
  );
  assert.equal(prepared.macros["\\erfcx"], String.raw`\operatorname{erfcx}`);
  assert.equal(prepared.macros["\\argmax"], String.raw`\operatorname*{arg\,max}`);
  assert.equal(prepared.macros["\\laterop"], undefined);
  const html = katex.renderToString(prepared.body, {
    throwOnError: true,
    strict: "ignore",
    trust: true,
    macros: {
      ...prepared.macros,
      "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
    }
  });
  assert.match(html, /erfcx/);
  assert.match(html, /arg/);
  assert.match(html, /max/);
}

{
  const { source, context } = equationAt("$\\ensuremath{a+|b}$");
  const prepared = tools.prepareDocumentCommands(
    source,
    context.openStart,
    tools.previewBody(context)
  );
  assert.equal(prepared.macros["\\ensuremath"], "#1");
  assert.doesNotThrow(() => katex.renderToString(prepared.body, {
    throwOnError: true,
    strict: "ignore",
    trust: true,
    macros: {
      ...prepared.macros,
      "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
    }
  }));
}

{
  const { source, context } = equationAt(String.raw`$\bm{\upsigma}+\upvarepsilon|$`);
  const prepared = tools.prepareDocumentCommands(source, context.openStart, tools.previewBody(context));
  assert.equal(prepared.macros["\\upsigma"], String.raw`\mathrm{\sigma}`);
  assert.equal(prepared.macros["\\upvarepsilon"], String.raw`\mathrm{\varepsilon}`);
  assert.doesNotThrow(() => katex.renderToString(prepared.body, {
    throwOnError: true,
    strict: "ignore",
    trust: true,
    macros: {
      ...prepared.macros,
      "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
    }
  }));
}

{
  const scriptCaret = tools.injectCaret("x^2", 2);
  assert.match(scriptCaret, /x\^\{\\SmartTeXCaret\{\}2\}/);
  const groupCaret = tools.injectCaret("\\frac{a}{b}", 9);
  assert.match(groupCaret, /\\frac\{a\}\{\\SmartTeXCaret\{\}b\}/);
  const commandCaret = tools.injectCaret("\\frac{a}{b}", 3);
  assert.ok(commandCaret.startsWith("\\SmartTeXCaret{}\\frac"));
}

{
  let placement = tools.resolveCaretPlacement("\\ne", 3);
  assert.equal(placement.commandSide, "right");

  placement = tools.resolveCaretPlacement("\\ne", 2, placement);
  assert.equal(
    placement.commandSide,
    "right",
    "moving into a command from the right must keep the rendered caret on the right"
  );
  const rightCaretSource = tools.injectCaret("\\ne", 2, placement.commandSide);
  assert.ok(rightCaretSource.startsWith("\\ne\\SmartTeXCaret{}"));

  placement = tools.resolveCaretPlacement("\\ne", 1, placement);
  assert.equal(
    placement.commandSide,
    "right",
    "moving within a command must not change the rendered caret side"
  );

  placement = tools.resolveCaretPlacement("\\ne", 0, placement);
  assert.equal(placement.commandSide, "left");
  placement = tools.resolveCaretPlacement("\\ne", 1, placement);
  assert.equal(
    placement.commandSide,
    "left",
    "moving into a command from the left must keep the rendered caret on the left"
  );
  const leftCaretSource = tools.injectCaret("\\ne", 1, placement.commandSide);
  assert.ok(leftCaretSource.startsWith("\\SmartTeXCaret{}\\ne"));

  const renderCaret = (latex) => {
    const html = katex.renderToString(latex, {
      throwOnError: true,
      strict: "ignore",
      trust: true,
      macros: {
        "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
      }
    });
    return html.slice(html.indexOf('<span class="katex-html"'));
  };
  const leftHtml = renderCaret(leftCaretSource);
  const rightHtml = renderCaret(rightCaretSource);
  assert.ok(leftHtml.indexOf("smarttex-rendered-caret") < leftHtml.indexOf("\uE020"));
  assert.ok(rightHtml.indexOf("smarttex-rendered-caret") > rightHtml.indexOf("\uE020"));

  placement = tools.resolveCaretPlacement("\\neq", 2, {
    ...placement,
    commandSide: "right"
  });
  assert.equal(
    placement.commandSide,
    "right",
    "editing the command text must preserve its rendered caret side"
  );
}

{
  const renderWithCaret = (source, cursor, previous = null) => {
    const placement = tools.resolveCaretPlacement(source, cursor, previous);
    const withCaret = tools.injectCaret(source, cursor, placement.commandSide);
    assert.doesNotThrow(() => katex.renderToString(withCaret, {
      throwOnError: true,
      strict: "ignore",
      trust: true,
      macros: {
        "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
      }
    }));
    return placement;
  };

  const simple = "\\left(x\\right)";
  let placement = renderWithCaret(simple, 6);
  for (const cursor of [5, 4, 3, 2, 1]) {
    placement = renderWithCaret(simple, cursor, placement);
    assert.equal(placement.commandSide, "right");
  }
  placement = renderWithCaret(simple, 0, placement);
  assert.equal(placement.commandSide, "left");
  for (const cursor of [1, 2, 3, 4, 5]) {
    placement = renderWithCaret(simple, cursor, placement);
    assert.equal(placement.commandSide, "left");
  }

  const named = "\\left\\langle x \\right\\rangle";
  for (const cursor of [1, 5, 7, 10, 20, named.length - 1]) {
    renderWithCaret(named, cursor);
  }
}


{
  const matrixEquation = String.raw`\mathbf M
\begin{pmatrix}
E_\parallel \\ E_\perp
\end{pmatrix}
=
0,
\quad
\mathbf M=
\begin{pmatrix}
\varepsilon_{\parallel\parallel} & \varepsilon_{\parallel\perp} \\[3pt]
\varepsilon_{\perp\parallel} & \varepsilon_{\perp\perp}-k^2/\omega^2
\end{pmatrix}.
\label{eq:M_def}`;
  const context = {
    kind: "environment",
    environment: "equation",
    source: matrixEquation,
    cursorOffset: 0
  };
  let previousPlacement = null;
  const protectedOffsets = new Set();
  for (const token of ["\\begin{pmatrix}", "\\end{pmatrix}", "\\\\[3pt]"]) {
    let tokenStart = matrixEquation.indexOf(token);
    while (tokenStart >= 0) {
      for (let offset = tokenStart + 1; offset < tokenStart + token.length; offset += 1) {
        protectedOffsets.add(offset);
      }
      tokenStart = matrixEquation.indexOf(token, tokenStart + token.length);
    }
  }

  for (let cursor = 0; cursor <= matrixEquation.length; cursor += 1) {
    context.cursorOffset = cursor;
    const placement = tools.resolveCaretPlacement(
      matrixEquation,
      cursor,
      previousPlacement
    );
    previousPlacement = placement;
    const body = tools.previewBody(
      context,
      placement.commandSide,
      { numbers: [{ value: "1", starred: false }], rows: [] },
      true
    );
    let html = "";
    assert.doesNotThrow(() => {
      html = katex.renderToString(body, {
        displayMode: true,
        throwOnError: true,
        strict: "ignore",
        trust: true,
        macros: {
          "\\label": { tokens: [], numArgs: 1 },
          "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
        }
      });
    }, `cursor offset ${cursor} must not make valid matrix LaTeX invalid`);
    if (protectedOffsets.has(cursor)) {
      assert.match(
        html,
        /smarttex-rendered-caret/,
        `cursor offset ${cursor} inside protected syntax must be rendered at a safe boundary`
      );
    }
  }
}

{
  const source = "\\newcommand{\\pair}[2][x]{#1+#2}\n$\\pair{|y}+\\pair[z]{w}$";
  const cursor = source.indexOf("|");
  const cleanSource = source.slice(0, cursor) + source.slice(cursor + 1);
  const context = tools.findEquationContext(cleanSource, cursor);
  const prepared = tools.prepareDocumentCommands(
    cleanSource,
    context.openStart,
    tools.previewBody(context)
  );
  const optionalMacro = katex.renderToString(prepared.body, {
    throwOnError: true,
    strict: "ignore",
    trust: true,
    macros: {
      ...prepared.macros,
      "\\SmartTeXCaret": "\\htmlClass{smarttex-rendered-caret}{\\vphantom{|}}"
    }
  });
  assert.match(optionalMacro, /mord/);
  assert.match(optionalMacro, /smarttex-rendered-caret/);
}

{
  const equationWithLabel = katex.renderToString(
    "E=mc^2\\label{eq:mass-energy}",
    {
      throwOnError: true,
      strict: "ignore",
      macros: {
        "\\label": { tokens: [], numArgs: 1 },
        "\\nonumber": "",
        "\\notag": ""
      }
    }
  );
  assert.match(equationWithLabel, /mathnormal/);
  const renderedHtml = equationWithLabel.slice(equationWithLabel.indexOf('<span class="katex-html"'));
  assert.doesNotMatch(renderedHtml, /mass-energy/);
}

{
  const source = String.raw`\begin{equation}
E=mc^2
\label{eq:mass-energy}
\end{equation}
\begin{figure}
\caption{Mass energy}
\label{fig:mass-energy}
\end{figure}`;
  const equation = tools.referenceTarget(source, "eq:mass-energy");
  const figure = tools.referenceTarget(source, "fig:mass-energy");
  assert.equal(equation.type, "equation");
  assert.equal(equation.number, "1");
  assert.equal(figure.type, "figure");
  assert.equal(figure.number, 1);
  assert.equal(figure.caption, "Mass energy");
}

{
  const source = String.raw`\documentclass{revtex4-2}
\section{Main section}\label{sec:main}
\subsection{Main subsection}\label{sec:sub}
\appendix
\section{First appendix}\label{sec:appendix-a}
\begin{equation}a=1\label{eq:appendix-a1}\end{equation}
\begin{equation}b=2\label{eq:appendix-a2}\end{equation}
\subsection{Appendix subsection}\label{sec:appendix-a1}
\section{Second appendix}\label{sec:appendix-b}`;
  const numbering = tools.sectionNumbering(source);
  assert.deepEqual(
    numbering.map((section) => section.number),
    ["I", "I.A", "A", "A.1", "B"]
  );
  assert.equal(tools.referenceTarget(source, "sec:main").number, "I");
  assert.equal(tools.referenceTarget(source, "sec:sub").number, "I.A");
  assert.equal(tools.referenceTarget(source, "sec:appendix-a").number, "A");
  assert.equal(tools.referenceTarget(source, "sec:appendix-a1").number, "A.1");
  assert.equal(tools.referenceTarget(source, "sec:appendix-b").number, "B");
  assert.equal(tools.referenceTarget(source, "eq:appendix-a1").number, "A1");
  assert.equal(tools.referenceTarget(source, "eq:appendix-a2").number, "A2");
}

{
  const source = String.raw`\numberwithin{equation}{section}
\counterwithin{figure}{section}
\renewcommand{\thesection}{\roman{section}}
\section{First}\label{sec:first}
\begin{equation}a=1\label{eq:first}\end{equation}
\begin{figure}\caption{First}\label{fig:first}\end{figure}
\section{Second}\label{sec:second}
\begin{equation}b=2\label{eq:second}\end{equation}
\appendix
\renewcommand{\theequation}{\thesection\arabic{equation}}
\renewcommand{\thefigure}{\thesection-\Alph{figure}}
\section{Appendix}\label{sec:appendix}
\begin{equation}c=3\label{eq:appendix-one}\end{equation}
\begin{equation}d=4\label{eq:appendix-two}\end{equation}
\begin{figure}\caption{Appendix figure}\label{fig:appendix}\end{figure>`;
  assert.equal(tools.referenceTarget(source, "sec:first").number, "i");
  assert.equal(tools.referenceTarget(source, "eq:first").number, "i.1");
  assert.equal(tools.referenceTarget(source, "fig:first").number, "i.1");
  assert.equal(tools.referenceTarget(source, "sec:second").number, "ii");
  assert.equal(tools.referenceTarget(source, "eq:second").number, "ii.1");
  assert.equal(tools.referenceTarget(source, "sec:appendix").number, "A");
  assert.equal(tools.referenceTarget(source, "eq:appendix-one").number, "A1");
  assert.equal(tools.referenceTarget(source, "eq:appendix-two").number, "A2");
  assert.equal(tools.referenceTarget(source, "fig:appendix").number, "A-A");
}

{
  const source = String.raw`\setcounter{equation}{7}
\begin{equation}a=1\label{eq:eight}\end{equation}
\addtocounter{equation}{2}
\renewcommand{\theequation}{\Roman{equation}}
\begin{equation}b=2\label{eq:eleven}\end{equation}`;
  assert.equal(tools.referenceTarget(source, "eq:eight").number, "8");
  assert.equal(tools.referenceTarget(source, "eq:eleven").number, "XI");
}

{
  const source = String.raw`\begin{table}
\caption{Selected caption text}
\label{tab:caption}
\begin{tabular}{cc}
A & B \\
\end{tabular}
\end{table}`;
  const cursor = source.indexOf("caption text") + 3;
  const context = tools.findTableFloatContext(source, cursor);
  assert.ok(context, "A table preview context should be found from its caption.");
  assert.equal(context.kind, "table");
  assert.equal(context.cursorInsideTable, false);
  assert.equal(context.source.trim(), "A & B \\\\");
  assert.ok(context.floatOpenStart < context.openStart);
  assert.ok(context.floatCloseEnd > context.closeEnd);
}



{
  const source = [
    "% \\begin{equation}commented=1\\end{equation}",
    "\\begin{equation}active=1\\label{eq:active}\\end{equation}",
    "% \\begin{figure}\\caption{Commented}\\label{fig:commented}\\end{figure}",
    "\\begin{figure}\\caption{Active}\\label{fig:active}\\end{figure}",
    "% \\begin{table}\\caption{Commented}\\begin{tabular}{c}X\\end{tabular}\\end{table}",
    "\\begin{table}\\caption{Active}\\begin{tabular}{c}Y\\end{tabular}\\label{tab:active}\\end{table}",
    "% \\section{Commented}",
    "\\section{Active}\\label{sec:active}"
  ].join("\n");

  const equation = tools.referenceTarget(source, "eq:active");
  const figure = tools.referenceTarget(source, "fig:active");
  const table = tools.referenceTarget(source, "tab:active");
  const section = tools.referenceTarget(source, "sec:active");

  assert.equal(equation.number, "1");
  assert.equal(figure.number, 1);
  assert.equal(table.number, 1);
  assert.equal(section.number, "1");
  assert.equal(tools.referenceTarget(source, "fig:commented"), null);
}

console.log("SmartTeX LaTeX context tests passed.");


{
  const source = String.raw`\begin{figure}
\caption{Maximum rates %and this is commented
frequency, escaped \% sign, and \verb|% literal|.}
\end{figure}`;
  const context = tools.findFigureContext(source, source.indexOf("\\caption"));
  const caption = tools.floatCaption(source, context, "figure");
  assert.ok(caption);
  assert.equal(
    caption.text.replace(/\s+/g, " "),
    String.raw`Maximum rates frequency, escaped \% sign, and \verb|% literal|.`
  );
}
