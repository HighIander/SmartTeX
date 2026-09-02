/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXPageContext?.isDocumentPage?.() === false) return;

  if (window.top !== window || globalThis.__smartTeXSettingsMenuLoaded) return;
  globalThis.__smartTeXSettingsMenuLoaded = true;

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const FEATURES_KEY = "smarttex:features:v1";
  const AUTOCOMPLETE_KEY = "smarttex:autocomplete:v1";
  const REFERENCE_POPUPS_KEY = "smarttex:reference-popups:v1";
  const STRUCTURE_HIGHLIGHT_KEY = "smarttex:structure-highlight:v1";
  const LABEL_REFERENCE_GUARD_KEY = "smarttex:label-reference-guard:v1";
  const DOCUMENT_OVERRIDES_KEY = "smarttex:document-overrides:v1";
  const POPUP_SIZES_KEY = "smarttex:popup-sizes:v1";
  const POPUP_SCALE_KEY = "smarttex:popup-scale:v1";
  const POPUP_CAPTION_FONT_SCALE_KEY = "smarttex:popup-caption-font-scale:v1";
  const POPUP_CAPTION_FONT_BASE_PX = 11;
  const COMMENT_PROFILE_KEY = globalThis.SmartTeXCommentProfile?.KEY || "smarttex:comment-profile:v1";
  const OPEN_SETTINGS_EVENT = globalThis.SmartTeXCommentProfile?.OPEN_SETTINGS_EVENT || "smarttex:open-settings-menu";
  const RUNTIME_SETTINGS_EVENT = "smarttex:runtime-settings";
  const DATA_PROTECTION_URL = "https://smartioz.com/smartTex/dataprotection.php";
  const IMPRINT_URL = "https://smartioz.com/smartTex/impressum.php";

  const DEFAULT_VALUES = Object.freeze({
    equations: true,
    tables: true,
    figures: true,
    referenceOrder: "document",
    referencePopupTrigger: "cursor",
    environmentPopupTrigger: "cursor",
    labelReferenceGuardEnabled: true,
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
  });

  const settingGroups = [
    {
      title: "Previews",
      rows: [
        { type: "checkbox", key: "equations", label: "Popup preview for equations" },
        { type: "checkbox", key: "tables", label: "Popup preview for tables" },
        { type: "checkbox", key: "figures", label: "Popup preview for figures" },
        {
          type: "select",
          key: "referencePopupTrigger",
          label: "Reference and citation popup trigger",
          options: [["cursor", "Cursor inside command"], ["hover", "Hover"]]
        },
        {
          type: "select",
          key: "environmentPopupTrigger",
          label: "Equation, table, and figure popup trigger",
          options: [["cursor", "Cursor inside source"], ["hover", "Hover"]]
        },
        {
          type: "checkbox",
          key: "labelReferenceGuardEnabled",
          label: "Warn when a changed or deleted label is referenced"
        }
      ]
    },
    {
      title: "Autocomplete",
      rows: [
        {
          type: "select",
          key: "referenceOrder",
          label: "Reference-list order",
          options: [["document", "Document order"], ["alphabetical", "Alphabetical"]]
        }
      ]
    },
    {
      title: "Source highlighting",
      rows: [
        { type: "highlight", keys: ["environmentEnabled", "environmentColor"], label: "Environment body" },
        { type: "highlight", keys: ["environmentFirstLineEnabled", "environmentFirstLineColor"], label: "First line of environments" },
        { type: "highlight", keys: ["sectionEnabled", "sectionColor"], label: "Section command lines" },
        { type: "highlight", keys: ["captionEnabled", "captionColor"], label: "Captions" },
        { type: "highlight", keys: ["labelEnabled", "labelColor"], label: "Labels" },
        { type: "highlight", keys: ["referenceEnabled", "referenceColor"], label: "References" },
        { type: "highlight", keys: ["nonumberEnabled", "nonumberColor"], label: "\\nonumber / \\notag" },
        { type: "highlight", keys: ["inlineMathEnabled", "inlineMathColor"], label: "Inline equations" },
        { type: "checkbox", key: "activeEnabled", label: "Emphasize the active field or environment" },
        { type: "range", key: "activeStrength", label: "Active emphasis strength", min: 0, max: 100, step: 5, suffix: "%" }
      ]
    }
  ];

  let presets = { ...DEFAULT_VALUES };
  let documentState = { usePresets: true, values: {} };
  let overrideMap = {};
  let menu = null;
  let optionsButton = null;
  let commentProfile = { name: "Anonymous", color: "#268bd2" };
  let commentNameControl = null;
  let commentColorControl = null;
  const controls = new Map();

  function stableDocumentKey() {
    const pathname = String(location.pathname || "/");
    const projectMatch = pathname.match(/\/(?:project|projects)\/([^/?#]+)/i);
    if (projectMatch) return `${location.origin}/project/${projectMatch[1]}`;
    return `${location.origin}${pathname.replace(/\/+$/, "") || "/"}`;
  }

  const documentKey = stableDocumentKey();
  let popupCaptionFontScale = readPopupCaptionFontScale();
  applyPopupCaptionFontScale(popupCaptionFontScale, { persist: false });

  function validColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ""))
      ? String(value).toLowerCase()
      : fallback;
  }


  function clampPopupScale(value) {
    return Math.max(0.5, Math.min(2, Number(value) || 1));
  }

  function readPopupScaleSettings() {
    const defaults = { mode: "global", global: 1, image: 1, equation: 1, table: 1 };
    try {
      const parsed = JSON.parse(localStorage.getItem(POPUP_SCALE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object") return defaults;
      return {
        mode: parsed.mode === "separate" ? "separate" : "global",
        global: clampPopupScale(parsed.global),
        image: clampPopupScale(parsed.image),
        equation: clampPopupScale(parsed.equation),
        table: clampPopupScale(parsed.table)
      };
    } catch (_error) {
      return defaults;
    }
  }

  function applyPopupScaleSettings(settings) {
    const normalized = {
      mode: settings?.mode === "separate" ? "separate" : "global",
      global: clampPopupScale(settings?.global),
      image: clampPopupScale(settings?.image),
      equation: clampPopupScale(settings?.equation),
      table: clampPopupScale(settings?.table)
    };
    try {
      localStorage.setItem(POPUP_SCALE_KEY, JSON.stringify(normalized));
    } catch (_error) {
      // The popup UI still updates for the current tab if local storage is restricted.
    }
    if (typeof globalThis.SmartTeXPopupUI?.setRelativeSizeSettings === "function") {
      globalThis.SmartTeXPopupUI.setRelativeSizeSettings(normalized);
    } else {
      window.dispatchEvent(new CustomEvent("smarttex:set-popup-relative-size", { detail: normalized }));
    }
    return normalized;
  }

  function clampPopupCaptionFontScale(value) {
    return Math.max(0.5, Math.min(2, Number(value) || 1));
  }

  function readPopupCaptionFontScale() {
    try {
      return clampPopupCaptionFontScale(localStorage.getItem(POPUP_CAPTION_FONT_SCALE_KEY));
    } catch (_error) {
      return 1;
    }
  }

  function applyPopupCaptionFontScale(value, { persist = true } = {}) {
    const scale = clampPopupCaptionFontScale(value);
    if (persist) {
      try {
        localStorage.setItem(POPUP_CAPTION_FONT_SCALE_KEY, String(scale));
      } catch (_error) {
        // The current page can still use the slider even if persistence is blocked.
      }
    }
    // Use one root variable for figure and table captions so cached and freshly
    // rendered popup DOM share identical typography. The slider is relative to
    // the compact 11 px default rather than mutating cached markup itself.
    document.documentElement.style.setProperty(
      "--smarttex-popup-caption-font-size",
      `${POPUP_CAPTION_FONT_BASE_PX * scale}px`
    );
    window.dispatchEvent(new CustomEvent("smarttex:set-popup-caption-font-scale", {
      detail: { scale, pixels: POPUP_CAPTION_FONT_BASE_PX * scale }
    }));
    return scale;
  }

  function normalizedPresets(stored = {}) {
    const features = stored[FEATURES_KEY] || {};
    const autocomplete = stored[AUTOCOMPLETE_KEY] || {};
    const popups = stored[REFERENCE_POPUPS_KEY] || {};
    const guard = stored[LABEL_REFERENCE_GUARD_KEY] || {};
    const highlights = stored[STRUCTURE_HIGHLIGHT_KEY] || {};
    const hasLegacyCombinedHighlight = highlights.enabled !== undefined || highlights.color !== undefined;
    const legacyEnvironmentEnabled = highlights.environmentEnabled !== undefined
      ? highlights.environmentEnabled !== false
      : highlights.enabled !== false;
    const legacyEnvironmentColor = validColor(
      highlights.environmentColor || highlights.color,
      DEFAULT_VALUES.environmentColor
    );

    return {
      equations: features.equations !== false,
      tables: features.tables !== false,
      figures: features.figures !== false,
      referenceOrder: autocomplete.referenceOrder === "alphabetical" ? "alphabetical" : "document",
      referencePopupTrigger: popups.trigger === "hover" ? "hover" : "cursor",
      environmentPopupTrigger: popups.environmentTrigger === "hover" ? "hover" : "cursor",
      labelReferenceGuardEnabled: guard.enabled !== false,
      environmentEnabled: legacyEnvironmentEnabled,
      environmentColor: legacyEnvironmentColor,
      environmentFirstLineEnabled: highlights.environmentFirstLineEnabled !== undefined
        ? highlights.environmentFirstLineEnabled !== false
        : (hasLegacyCombinedHighlight ? legacyEnvironmentEnabled : DEFAULT_VALUES.environmentFirstLineEnabled),
      environmentFirstLineColor: validColor(
        highlights.environmentFirstLineColor,
        hasLegacyCombinedHighlight ? legacyEnvironmentColor : DEFAULT_VALUES.environmentFirstLineColor
      ),
      sectionEnabled: highlights.sectionEnabled !== undefined
        ? highlights.sectionEnabled !== false
        : (hasLegacyCombinedHighlight ? legacyEnvironmentEnabled : DEFAULT_VALUES.sectionEnabled),
      sectionColor: validColor(highlights.sectionColor, hasLegacyCombinedHighlight ? legacyEnvironmentColor : DEFAULT_VALUES.sectionColor),
      captionEnabled: highlights.captionEnabled !== undefined
        ? highlights.captionEnabled !== false
        : DEFAULT_VALUES.captionEnabled,
      captionColor: validColor(highlights.captionColor, DEFAULT_VALUES.captionColor),
      labelEnabled: highlights.labelEnabled !== undefined
        ? highlights.labelEnabled !== false
        : DEFAULT_VALUES.labelEnabled,
      labelColor: validColor(highlights.labelColor, DEFAULT_VALUES.labelColor),
      referenceEnabled: highlights.referenceEnabled !== false,
      referenceColor: validColor(highlights.referenceColor, DEFAULT_VALUES.referenceColor),
      nonumberEnabled: highlights.nonumberEnabled !== undefined
        ? highlights.nonumberEnabled !== false
        : DEFAULT_VALUES.nonumberEnabled,
      nonumberColor: validColor(highlights.nonumberColor, DEFAULT_VALUES.nonumberColor),
      inlineMathEnabled: highlights.inlineMathEnabled !== false,
      inlineMathColor: validColor(highlights.inlineMathColor, DEFAULT_VALUES.inlineMathColor),
      activeEnabled: highlights.activeEnabled !== false,
      activeStrength: Math.max(0, Math.min(100,
        Number.isFinite(Number(highlights.activeStrength))
          ? Number(highlights.activeStrength)
          : DEFAULT_VALUES.activeStrength
      ))
    };
  }

  function effectiveValues() {
    return documentState.usePresets
      ? { ...presets }
      : { ...presets, ...documentState.values };
  }

  function dispatchEffectiveSettings() {
    const values = effectiveValues();
    const detail = {
        usingPresets: documentState.usePresets,
        features: {
          equations: values.equations,
          tables: values.tables,
          figures: values.figures
        },
        autocomplete: {
          referenceOrder: values.referenceOrder
        },
        referencePopups: {
          trigger: values.referencePopupTrigger,
          environmentTrigger: values.environmentPopupTrigger
        },
        labelReferenceGuard: {
          enabled: values.labelReferenceGuardEnabled
        },
        highlights: Object.fromEntries(
          Object.keys(DEFAULT_VALUES)
            .filter((key) => /(?:Enabled|Color|Strength)$/.test(key) || key === "activeEnabled")
            .map((key) => [key, values[key]])
        )
      };
    globalThis.SmartTeXRuntimeSettings = detail;
    window.dispatchEvent(new CustomEvent(RUNTIME_SETTINGS_EVENT, { detail }));
  }

  function makeResetButton(keys, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "smarttex-settings-reset";
    button.textContent = "↺";
    button.title = `Reset ${label} to the extension preset`;
    button.setAttribute("aria-label", button.title);
    button.dataset.settingKeys = keys.join(",");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (documentState.usePresets) return;
      for (const key of keys) documentState.values[key] = presets[key];
      updateMenuFromState();
      saveDocumentState();
      dispatchEffectiveSettings();
    });
    return button;
  }

  function createSettingRow(definition) {
    const row = document.createElement("div");
    row.className = `smarttex-settings-row smarttex-settings-row-${definition.type}`;
    const keys = definition.keys || [definition.key];

    if (definition.type === "checkbox") {
      const label = document.createElement("label");
      label.className = "smarttex-settings-checkbox-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.settingKey = definition.key;
      label.append(input, document.createTextNode(definition.label));
      row.append(label, makeResetButton(keys, definition.label));
      controls.set(definition.key, input);
    } else if (definition.type === "select") {
      const label = document.createElement("label");
      label.textContent = definition.label;
      const select = document.createElement("select");
      select.dataset.settingKey = definition.key;
      for (const [value, text] of definition.options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      }
      row.append(label, select, makeResetButton(keys, definition.label));
      controls.set(definition.key, select);
    } else if (definition.type === "highlight") {
      const label = document.createElement("label");
      label.className = "smarttex-settings-highlight-label";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.settingKey = keys[0];
      label.append(checkbox, document.createTextNode(definition.label));
      const color = document.createElement("input");
      color.type = "color";
      color.dataset.settingKey = keys[1];
      color.setAttribute("aria-label", `${definition.label} color`);
      row.append(label, color, makeResetButton(keys, definition.label));
      controls.set(keys[0], checkbox);
      controls.set(keys[1], color);
    } else if (definition.type === "range") {
      const label = document.createElement("label");
      label.textContent = definition.label;
      const value = document.createElement("output");
      value.className = "smarttex-settings-range-value";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(definition.min);
      input.max = String(definition.max);
      input.step = String(definition.step);
      input.dataset.settingKey = definition.key;
      input.dataset.suffix = definition.suffix || "";
      input.dataset.outputId = `${definition.key}-output`;
      value.dataset.outputFor = definition.key;
      row.append(label, value, input, makeResetButton(keys, definition.label));
      controls.set(definition.key, input);
    }
    return row;
  }

  function createMenu() {
    if (menu?.isConnected) return menu;
    menu = document.createElement("aside");
    menu.id = "smarttex-settings-menu";
    menu.hidden = true;
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "SmartTeX document options");

    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "SmartTeX options";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "smarttex-settings-close";
    close.innerHTML = "&times;";
    close.title = "Close";
    close.setAttribute("aria-label", "Close SmartTeX options");
    close.addEventListener("click", closeMenu);
    header.append(title, close);
    menu.appendChild(header);

    const profileSection = document.createElement("section");
    profileSection.className = "smarttex-settings-comment-profile";
    const profileHeading = document.createElement("h3");
    profileHeading.textContent = "Comments identity";
    const profileGrid = document.createElement("div");
    profileGrid.className = "smarttex-settings-comment-profile-grid";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "User name";
    commentNameControl = document.createElement("input");
    commentNameControl.type = "text";
    commentNameControl.maxLength = 80;
    commentNameControl.autocomplete = "off";
    commentNameControl.spellcheck = false;
    commentNameControl.setAttribute("aria-label", "Comment user name");
    nameLabel.appendChild(commentNameControl);
    const colorLabel = document.createElement("label");
    colorLabel.textContent = "User color";
    commentColorControl = document.createElement("input");
    commentColorControl.type = "color";
    commentColorControl.setAttribute("aria-label", "Comment user color");
    colorLabel.appendChild(commentColorControl);
    profileGrid.append(nameLabel, colorLabel);
    profileSection.append(profileHeading, profileGrid);
    menu.appendChild(profileSection);

    const saveProfile = ({ manualName = false } = {}) => {
      const normalized = globalThis.SmartTeXCommentProfile?.normalize?.({
        name: commentNameControl?.value,
        color: commentColorControl?.value,
        nameSource: manualName ? "manual" : commentProfile.nameSource
      }, commentProfile) || {
        name: String(commentNameControl?.value || "Anonymous").trim().slice(0, 80) || "Anonymous",
        color: validColor(commentColorControl?.value, "#268bd2"),
        nameSource: manualName ? "manual" : (commentProfile.nameSource || "manual")
      };
      commentProfile = normalized;
      extensionApi?.storage?.local?.set?.({ [COMMENT_PROFILE_KEY]: normalized }).catch?.(() => {});
    };
    commentNameControl.addEventListener("input", () => saveProfile({ manualName: true }));
    commentColorControl.addEventListener("input", () => saveProfile());

    const defaultsRow = document.createElement("label");
    defaultsRow.className = "smarttex-settings-use-presets";
    const defaultsToggle = document.createElement("input");
    defaultsToggle.type = "checkbox";
    defaultsToggle.id = "smarttex-settings-use-presets";
    defaultsRow.append(defaultsToggle, document.createTextNode("Use extension defaults"));
    menu.appendChild(defaultsRow);

    const scrollBody = document.createElement("div");
    scrollBody.className = "smarttex-settings-scroll-body";
    for (const group of settingGroups) {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = group.title;
      section.appendChild(heading);
      for (const definition of group.rows) section.appendChild(createSettingRow(definition));
      scrollBody.appendChild(section);
    }

    const popupSection = document.createElement("section");
    popupSection.className = "smarttex-settings-popup-size-section";
    const popupHeading = document.createElement("h3");
    popupHeading.textContent = "Popup sizes";

    let popupScaleSettings = readPopupScaleSettings();
    const popupControls = document.createElement("div");
    popupControls.className = "smarttex-settings-popup-size-controls";

    const resetPopupSizes = document.createElement("button");
    resetPopupSizes.type = "button";
    resetPopupSizes.className = "smarttex-settings-action smarttex-settings-reset-popup-sizes";
    resetPopupSizes.textContent = "Reset popup sizes";
    resetPopupSizes.title = "Reset saved popup sizes and set relative popup size to 100%";

    const globalScaleWrap = document.createElement("div");
    globalScaleWrap.className = "smarttex-settings-popup-global-scale";
    const globalScale = document.createElement("input");
    globalScale.type = "range";
    globalScale.min = "50";
    globalScale.max = "200";
    globalScale.step = "5";
    globalScale.setAttribute("aria-label", "Relative popup size");
    const globalScaleValue = document.createElement("span");
    globalScaleValue.className = "smarttex-settings-popup-scale-value";
    globalScaleWrap.append(globalScale, globalScaleValue);

    const detailToggle = document.createElement("button");
    detailToggle.type = "button";
    detailToggle.className = "smarttex-settings-popup-scale-toggle";
    detailToggle.title = "Set image, equation, and table popup sizes separately";
    detailToggle.setAttribute("aria-label", detailToggle.title);

    const separateScales = document.createElement("div");
    separateScales.className = "smarttex-settings-popup-separate-scales";
    const separateControls = {};
    for (const [type, labelText] of [["image", "Image"], ["equation", "Equation"], ["table", "Table"]]) {
      const row = document.createElement("label");
      row.className = "smarttex-settings-popup-scale-row";
      const label = document.createElement("span");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = "range";
      input.min = "50";
      input.max = "200";
      input.step = "5";
      input.setAttribute("aria-label", `${labelText} popup size`);
      const value = document.createElement("span");
      value.className = "smarttex-settings-popup-scale-value";
      row.append(label, input, value);
      separateScales.appendChild(row);
      separateControls[type] = { input, value };
    }

    const captionScaleRow = document.createElement("label");
    captionScaleRow.className = "smarttex-settings-popup-caption-scale";
    const captionScaleLabel = document.createElement("span");
    captionScaleLabel.textContent = "Caption font";
    const captionScale = document.createElement("input");
    captionScale.type = "range";
    captionScale.min = "50";
    captionScale.max = "200";
    captionScale.step = "5";
    captionScale.setAttribute("aria-label", "Figure and table popup caption font size");
    const captionScaleValue = document.createElement("span");
    captionScaleValue.className = "smarttex-settings-popup-scale-value";
    captionScaleRow.append(captionScaleLabel, captionScale, captionScaleValue);

    const updatePopupScaleControls = () => {
      const separate = popupScaleSettings.mode === "separate";
      globalScaleWrap.hidden = separate;
      separateScales.hidden = !separate;
      detailToggle.textContent = separate ? "▴" : "▾";
      detailToggle.setAttribute("aria-expanded", String(separate));
      globalScale.value = String(Math.round(popupScaleSettings.global * 100));
      globalScaleValue.textContent = `${Math.round(popupScaleSettings.global * 100)}%`;
      for (const type of ["image", "equation", "table"]) {
        const percent = Math.round(popupScaleSettings[type] * 100);
        separateControls[type].input.value = String(percent);
        separateControls[type].value.textContent = `${percent}%`;
      }
      const captionPercent = Math.round(popupCaptionFontScale * 100);
      captionScale.value = String(captionPercent);
      captionScaleValue.textContent = `${captionPercent}%`;
    };

    const commitPopupScale = (next) => {
      popupScaleSettings = applyPopupScaleSettings({ ...popupScaleSettings, ...next });
      updatePopupScaleControls();
    };

    globalScale.addEventListener("input", () => {
      commitPopupScale({ global: Number(globalScale.value) / 100 });
    });
    captionScale.addEventListener("input", () => {
      popupCaptionFontScale = applyPopupCaptionFontScale(Number(captionScale.value) / 100);
      captionScaleValue.textContent = `${Math.round(popupCaptionFontScale * 100)}%`;
    });
    for (const type of ["image", "equation", "table"]) {
      separateControls[type].input.addEventListener("input", () => {
        commitPopupScale({ [type]: Number(separateControls[type].input.value) / 100 });
      });
    }
    detailToggle.addEventListener("click", () => {
      commitPopupScale({ mode: popupScaleSettings.mode === "separate" ? "global" : "separate" });
    });

    resetPopupSizes.addEventListener("click", () => {
      popupScaleSettings = {
        mode: popupScaleSettings.mode,
        global: 1,
        image: 1,
        equation: 1,
        table: 1
      };
      try {
        localStorage.removeItem(POPUP_SIZES_KEY);
        localStorage.setItem(POPUP_SCALE_KEY, JSON.stringify(popupScaleSettings));
      } catch (_error) {
        // The live reset event still resets current popups if storage is restricted.
      }
      if (typeof globalThis.SmartTeXPopupUI?.resetSizes === "function") {
        globalThis.SmartTeXPopupUI.resetSizes({ relativeSettings: popupScaleSettings });
      } else {
        window.dispatchEvent(new CustomEvent("smarttex:reset-popup-sizes", {
          detail: { relativeSettings: popupScaleSettings }
        }));
      }
      updatePopupScaleControls();
    });

    popupControls.append(resetPopupSizes, globalScaleWrap, detailToggle);
    popupSection.append(popupHeading, popupControls, separateScales, captionScaleRow);
    updatePopupScaleControls();
    scrollBody.appendChild(popupSection);

    const legal = document.createElement("section");
    legal.className = "smarttex-settings-legal";
    const legalHeading = document.createElement("h3");
    legalHeading.textContent = "Legal information";
    const dataProtection = document.createElement("a");
    dataProtection.href = DATA_PROTECTION_URL;
    dataProtection.target = "_blank";
    dataProtection.rel = "noopener noreferrer";
    dataProtection.textContent = "Data protection";
    const imprint = document.createElement("a");
    imprint.href = IMPRINT_URL;
    imprint.target = "_blank";
    imprint.rel = "noopener noreferrer";
    imprint.textContent = "Imprint";
    legal.append(legalHeading, dataProtection, imprint);
    scrollBody.appendChild(legal);
    menu.appendChild(scrollBody);

    const footer = document.createElement("footer");
    const editPresets = document.createElement("button");
    editPresets.type = "button";
    editPresets.className = "smarttex-settings-edit-presets";
    editPresets.textContent = "Edit extension presets";
    editPresets.addEventListener("click", () => {
      if (typeof extensionApi?.runtime?.sendMessage === "function") {
        Promise.resolve(extensionApi.runtime.sendMessage({ type: "smarttex-open-options" })).catch(() => {});
      } else {
        extensionApi?.runtime?.openOptionsPage?.();
      }
      closeMenu();
    });
    footer.appendChild(editPresets);
    menu.appendChild(footer);

    defaultsToggle.addEventListener("change", () => {
      documentState.usePresets = defaultsToggle.checked;
      documentState.values = documentState.usePresets ? {} : { ...presets };
      updateMenuFromState();
      saveDocumentState();
      dispatchEffectiveSettings();
    });

    menu.addEventListener("input", handleControlChange);
    menu.addEventListener("change", handleControlChange);
    document.documentElement.appendChild(menu);
    return menu;
  }

  function handleControlChange(event) {
    const control = event.target?.closest?.("[data-setting-key]");
    if (!control || documentState.usePresets) return;
    const key = control.dataset.settingKey;
    let value;
    if (control.type === "checkbox") value = control.checked;
    else if (control.type === "range") value = Number(control.value);
    else value = control.value;
    documentState.values[key] = value;
    updateRangeOutputs();
    saveDocumentState();
    dispatchEffectiveSettings();
  }

  function updateRangeOutputs() {
    if (!menu) return;
    for (const output of menu.querySelectorAll("[data-output-for]")) {
      const control = controls.get(output.dataset.outputFor);
      output.textContent = `${control?.value || 0}${control?.dataset?.suffix || ""}`;
    }
  }

  function updateMenuFromState() {
    if (!menu) return;
    const values = effectiveValues();
    const usePresets = menu.querySelector("#smarttex-settings-use-presets");
    if (usePresets) usePresets.checked = documentState.usePresets;
    for (const [key, control] of controls) {
      const value = values[key];
      if (control.type === "checkbox") control.checked = value !== false;
      else control.value = String(value);
      control.disabled = documentState.usePresets;
    }
    for (const reset of menu.querySelectorAll(".smarttex-settings-reset")) {
      reset.disabled = documentState.usePresets;
    }
    menu.classList.toggle("smarttex-settings-using-presets", documentState.usePresets);
    if (commentNameControl && document.activeElement !== commentNameControl) commentNameControl.value = commentProfile.name || "Anonymous";
    if (commentColorControl && document.activeElement !== commentColorControl) commentColorControl.value = validColor(commentProfile.color, "#268bd2");
    updateRangeOutputs();
  }

  function positionMenu() {
    if (!menu || menu.hidden || !optionsButton) return;
    const rect = optionsButton.getBoundingClientRect();
    const width = Math.min(440, Math.max(320, window.innerWidth - 20));
    menu.style.width = `${width}px`;
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width));
    const top = Math.min(window.innerHeight - 80, rect.bottom + 8);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.maxHeight = `${Math.max(240, window.innerHeight - top - 10)}px`;
  }

  function maybeShowFallbackNameNoticeInMenu() {
    if (!commentNameControl?.isConnected) return;
    globalThis.SmartTeXCommentProfile?.maybeShowFallbackNotice?.(
      extensionApi?.storage?.local,
      commentProfile,
      commentNameControl
    ).catch?.(() => {});
  }

  function openMenu({ focusUserName = false } = {}) {
    createMenu();
    updateMenuFromState();
    menu.hidden = false;
    optionsButton?.setAttribute("aria-expanded", "true");
    positionMenu();
    if (focusUserName) commentNameControl?.focus?.({ preventScroll: true });
    else menu.querySelector("#smarttex-settings-use-presets")?.focus?.({ preventScroll: true });
    if (globalThis.SmartTeXCommentProfile?.isFallbackProfile?.(commentProfile)) {
      window.dispatchEvent(new CustomEvent(
        globalThis.SmartTeXCommentProfile?.IDENTITY_REFRESH_EVENT || "smarttex:collabtex-identity-refresh"
      ));
    }
    window.setTimeout(maybeShowFallbackNameNoticeInMenu, 300);
  }

  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    optionsButton?.setAttribute("aria-expanded", "false");
  }

  function toggleMenu(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!menu || menu.hidden) openMenu();
    else closeMenu();
  }

  function attachButton() {
    const candidate = document.getElementById("smarttex-options-button");
    if (!candidate || candidate === optionsButton) return Boolean(candidate);
    if (optionsButton) optionsButton.removeEventListener("click", toggleMenu, true);
    optionsButton = candidate;
    optionsButton.title = "Open SmartTeX options";
    optionsButton.setAttribute("aria-label", "Open SmartTeX options");
    optionsButton.setAttribute("aria-haspopup", "dialog");
    optionsButton.setAttribute("aria-expanded", "false");
    optionsButton.addEventListener("click", toggleMenu, true);
    return true;
  }

  async function saveDocumentState() {
    overrideMap = { ...overrideMap };
    overrideMap[documentKey] = {
      usePresets: documentState.usePresets,
      values: documentState.usePresets ? {} : { ...documentState.values }
    };
    try {
      await extensionApi?.storage?.local?.set?.({ [DOCUMENT_OVERRIDES_KEY]: overrideMap });
    } catch (error) {
      console.warn("SmartTeX could not save document options:", error);
    }
  }

  async function loadSettings() {
    const keys = [
      FEATURES_KEY,
      AUTOCOMPLETE_KEY,
      REFERENCE_POPUPS_KEY,
      STRUCTURE_HIGHLIGHT_KEY,
      LABEL_REFERENCE_GUARD_KEY,
      DOCUMENT_OVERRIDES_KEY,
      COMMENT_PROFILE_KEY
    ];
    const ensuredProfile = await globalThis.SmartTeXCommentProfile?.ensure?.(extensionApi?.storage?.local);
    const stored = await extensionApi?.storage?.local?.get?.(keys) || {};
    presets = normalizedPresets(stored);
    commentProfile = globalThis.SmartTeXCommentProfile?.normalize?.(stored[COMMENT_PROFILE_KEY], ensuredProfile)
      || stored[COMMENT_PROFILE_KEY]
      || ensuredProfile
      || commentProfile;
    overrideMap = stored[DOCUMENT_OVERRIDES_KEY] && typeof stored[DOCUMENT_OVERRIDES_KEY] === "object"
      ? stored[DOCUMENT_OVERRIDES_KEY]
      : {};
    const saved = overrideMap[documentKey];
    documentState = saved && typeof saved === "object"
      ? {
          usePresets: saved.usePresets !== false,
          values: saved.values && typeof saved.values === "object" ? { ...saved.values } : {}
        }
      : { usePresets: true, values: {} };
    updateMenuFromState();
    dispatchEffectiveSettings();
  }

  window.addEventListener(OPEN_SETTINGS_EVENT, (event) => {
    openMenu({ focusUserName: event?.detail?.focusUserName !== false });
  });

  document.addEventListener("pointerdown", (event) => {
    if (!menu || menu.hidden) return;
    if (menu.contains(event.target) || optionsButton?.contains?.(event.target)) return;
    closeMenu();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu || menu.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    optionsButton?.focus?.({ preventScroll: true });
  }, true);

  window.addEventListener("resize", positionMenu, { passive: true });
  window.addEventListener("scroll", positionMenu, { passive: true, capture: true });

  extensionApi?.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[COMMENT_PROFILE_KEY]) {
      commentProfile = globalThis.SmartTeXCommentProfile?.normalize?.(changes[COMMENT_PROFILE_KEY].newValue, commentProfile)
        || changes[COMMENT_PROFILE_KEY].newValue
        || commentProfile;
      if (!globalThis.SmartTeXCommentProfile?.isFallbackProfile?.(commentProfile)) {
        globalThis.SmartTeXCommentProfile?.dismissFallbackNotice?.();
      }
      updateMenuFromState();
    }
    if (changes[DOCUMENT_OVERRIDES_KEY]) {
      overrideMap = changes[DOCUMENT_OVERRIDES_KEY].newValue || {};
      const saved = overrideMap[documentKey];
      documentState = saved && typeof saved === "object"
        ? {
            usePresets: saved.usePresets !== false,
            values: saved.values && typeof saved.values === "object" ? { ...saved.values } : {}
          }
        : { usePresets: true, values: {} };
    }
    if (
      changes[FEATURES_KEY] || changes[AUTOCOMPLETE_KEY] ||
      changes[REFERENCE_POPUPS_KEY] || changes[STRUCTURE_HIGHLIGHT_KEY] ||
      changes[LABEL_REFERENCE_GUARD_KEY]
    ) {
      extensionApi.storage.local.get([
        FEATURES_KEY,
        AUTOCOMPLETE_KEY,
        REFERENCE_POPUPS_KEY,
        STRUCTURE_HIGHLIGHT_KEY,
        LABEL_REFERENCE_GUARD_KEY
      ]).then((stored) => {
        presets = normalizedPresets(stored);
        updateMenuFromState();
        dispatchEffectiveSettings();
      }).catch(() => {});
      return;
    }
    updateMenuFromState();
    dispatchEffectiveSettings();
  });

  const buttonObserver = new MutationObserver(() => {
    if (optionsButton?.isConnected) return;
    attachButton();
  });
  buttonObserver.observe(document.documentElement, { childList: true, subtree: true });
  attachButton();
  loadSettings().catch((error) => {
    console.warn("SmartTeX document options could not be loaded:", error);
    dispatchEffectiveSettings();
  });
})();
