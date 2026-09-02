"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require(path.join(__dirname, "..", "latex-context.js"));
const tools = globalThis.SmartTeXLatexContext;

const source = String.raw`\section{Intro}
\begin{equation}
  a=b \label{eq:first}
\end{equation}
\subsection{Details}
\begin{align}
  c&=d \label{eq:c}\\
  e&=f \notag \label{eq:hidden}\\
  g&=h \tag{X} \label{eq:g}
\end{align}
\begin{figure}
  \includegraphics{figure-a}
  \caption{A useful figure}
  \label{fig:a}
\end{figure}
\begin{figure}
  \includegraphics{figure-b}
  \caption*{Unnumbered caption}
  \label{fig:unnumbered}
\end{figure}
\section{Results}
\begin{table}
  \caption{Parameters}
  \label{tab:params}
  \begin{tabular}{c}x\end{tabular}
\end{table}`;

const elements = tools.numberedOutlineElements(source);
assert.deepEqual(
  elements.map(({ type, number, label }) => ({ type, number, label })),
  [
    { type: "equation", number: "1", label: "eq:first" },
    { type: "equation", number: "2", label: "eq:c" },
    { type: "equation", number: "X", label: "eq:g" },
    { type: "figure", number: "1", label: "fig:a" },
    { type: "table", number: "1", label: "tab:params" }
  ]
);
assert.ok(elements.every((entry, index, array) => (
  index === 0 || entry.sourceIndex >= array[index - 1].sourceIndex
)), "numbered outline entries should stay in document order");
assert.equal(elements.find((entry) => entry.type === "figure")?.caption, "A useful figure");
assert.equal(elements.find((entry) => entry.type === "table")?.caption, "Parameters");
assert.ok(Number.isInteger(elements.find((entry) => entry.type === "figure")?.captionSourceIndex));
assert.ok(Number.isInteger(elements.find((entry) => entry.type === "table")?.captionSourceIndex));
assert.ok(!elements.some((entry) => entry.label === "eq:hidden"));
assert.ok(!elements.some((entry) => entry.label === "fig:unnumbered"));

const sections = tools.sectionNumbering(source);
assert.deepEqual(
  sections.map(({ level, title }) => ({ level, title })),
  [
    { level: 0, title: "Intro" },
    { level: 1, title: "Details" },
    { level: 0, title: "Results" }
  ]
);

const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");
assert.match(content, /\.outline-pane \.outline-body/);
assert.doesNotMatch(content, /heading\.textContent = "Numbered elements"/);
assert.match(content, /contextTools\.sectionNumbering\?\.\(source\)/);
assert.match(content, /const owner = active\.filter\(Boolean\)\.at\(-1\)/);
assert.match(content, /findNativeOutlineSectionItem\(body, section, usedItems\)/);
assert.match(content, /nativeItem\.insertBefore\(list, nestedStructure \|\| null\)/);
assert.match(content, /Fig\. \$\{entry\.number\}/);
assert.match(content, /Eq\. \(\$\{entry\.number\}\)/);
assert.match(content, /announceNavigationOrigin\(sourceIndex\)[\s\S]*?bridgeRequest\("setCursor"/);
assert.match(content, /post-input editor state[\s\S]*scheduleNumberedOutlineUpdate\(20\)/);
assert.match(css, /merged into CollabTeX's section hierarchy/);
assert.match(css, /\.smarttex-numbered-outline-link\s*\{/);
assert.match(css, /\.smarttex-numbered-outline-label\s*\{/);

console.log("Numbered File Outline hierarchy checks passed.");
