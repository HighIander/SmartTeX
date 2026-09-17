/* SPDX-License-Identifier: CC-BY-NC-SA-4.0 */

(() => {
  "use strict";

  if (globalThis.SmartTeXCommentProfile) return;

  const KEY = "smarttex:comment-profile:v1";
  const COLLABTEX_IDENTITY_EVENT = "smarttex:collabtex-local-identity";
  const FALLBACK_NOTICE_KEY = "smarttex:comment-fallback-name-notice:v1";
  const OPEN_SETTINGS_EVENT = "smarttex:open-settings-menu";
  const IDENTITY_REFRESH_EVENT = "smarttex:collabtex-identity-refresh";
  let fallbackNoticeClaimed = false;
  const ANIMALS = Object.freeze([
    "Albatross", "Badger", "Beaver", "Bison", "Capybara", "Caracal", "Dolphin",
    "Falcon", "Fox", "Gecko", "Heron", "Ibex", "Jaguar", "Koala", "Lemur",
    "Lynx", "Marmot", "Narwhal", "Octopus", "Orca", "Otter", "Owl", "Panda",
    "Penguin", "Quokka", "Raven", "Salamander", "Seal", "Stoat", "Tapir",
    "Tern", "Tiger", "Toucan", "Turtle", "Wombat", "Yak"
  ]);
  const COLORS = Object.freeze([
    "#e5534b", "#d97706", "#b58900", "#5f9f45", "#2f9e72", "#159eaf",
    "#268bd2", "#4f7fe8", "#7455d9", "#9b59b6", "#c94f9d", "#d94f70"
  ]);

  function validColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ""));
  }

  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)] || items[0];
  }

  function randomProfile() {
    return { name: randomItem(ANIMALS), color: randomItem(COLORS), nameSource: "generated" };
  }

  function normalizedNameSource(value, name) {
    const explicit = String(value?.nameSource || "").trim().toLowerCase();
    if (["generated", "collabtex", "manual"].includes(explicit)) return explicit;
    // Profiles created before automatic CollabTeX identity detection did not
    // contain provenance. Preserve custom names as manual, while allowing the
    // old random-animal fallback to be upgraded automatically.
    return ANIMALS.includes(String(name || "").trim()) ? "generated" : "manual";
  }

  function normalize(value, fallback = null) {
    const base = fallback || randomProfile();
    const rawName = String(value?.name || "").trim();
    const name = rawName.slice(0, 80) || base.name;
    return {
      name,
      color: validColor(value?.color) ? String(value.color).toLowerCase() : base.color,
      nameSource: normalizedNameSource(value, name)
    };
  }

  function cleanDetectedName(value) {
    const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name || /^anonymous$/i.test(name) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) return "";
    return name;
  }


  function isFallbackProfile(value) {
    const normalized = normalize(value);
    return normalized.nameSource === "generated" && ANIMALS.includes(normalized.name);
  }

  async function fallbackNoticeShown(storageArea) {
    if (!storageArea?.get) return false;
    try {
      const stored = await storageArea.get(FALLBACK_NOTICE_KEY) || {};
      return stored?.[FALLBACK_NOTICE_KEY] === true;
    } catch (_error) {
      return false;
    }
  }

  async function markFallbackNoticeShown(storageArea) {
    if (!storageArea?.set) return;
    try { await storageArea.set({ [FALLBACK_NOTICE_KEY]: true }); } catch (_error) {}
  }

  function dismissFallbackNotice() {
    if (typeof document === "undefined") return;
    document.querySelector?.(".smarttex-fallback-name-notice")?.remove?.();
  }

  function positionFallbackNotice(bubble, anchor) {
    if (!bubble?.isConnected || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const margin = 10;
    const preferredLeft = rect.left + rect.width / 2 - bubbleRect.width / 2;
    const left = Math.max(margin, Math.min(window.innerWidth - bubbleRect.width - margin, preferredLeft));
    let top = rect.bottom + 10;
    let above = false;
    if (top + bubbleRect.height > window.innerHeight - margin && rect.top - bubbleRect.height - 10 >= margin) {
      top = rect.top - bubbleRect.height - 10;
      above = true;
    }
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(Math.max(margin, top))}px`;
    bubble.classList.toggle("smarttex-fallback-name-notice-above", above);
    const arrowLeft = Math.max(14, Math.min(bubbleRect.width - 14, rect.left + rect.width / 2 - left));
    bubble.style.setProperty("--smarttex-fallback-arrow-left", `${Math.round(arrowLeft)}px`);
  }

  async function maybeShowFallbackNotice(storageArea, profile, anchor, options = {}) {
    if (typeof document === "undefined" || !anchor?.isConnected || !isFallbackProfile(profile)) return false;
    if (fallbackNoticeClaimed || document.querySelector?.(".smarttex-fallback-name-notice")) return false;
    fallbackNoticeClaimed = true;
    if (await fallbackNoticeShown(storageArea)) return false;
    dismissFallbackNotice();

    const bubble = document.createElement("aside");
    bubble.className = "smarttex-fallback-name-notice";
    bubble.setAttribute("role", "note");
    bubble.setAttribute("aria-label", "Fallback user name");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "smarttex-fallback-name-notice-close";
    close.textContent = "×";
    close.title = "Close";
    close.setAttribute("aria-label", "Close fallback-name notice");

    const text = document.createElement("span");
    text.textContent = `SmartTeX could not read your CollabTeX user name, so “${normalize(profile).name}” is being used as a fallback. You can change it in the options menu.`;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "smarttex-fallback-name-notice-link";
    open.textContent = "Open options";

    const reposition = () => {
      if (globalThis.SmartTeXInteractionTasks?.isScrolling?.()) return;
      positionFallbackNotice(bubble, anchor);
    };
    const repositionAfterScroll = (event) => {
      if (event?.detail?.active === false) reposition();
    };
    const cleanup = () => {
      window.removeEventListener("resize", reposition, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("smarttex:editor-scroll-state", repositionAfterScroll);
      bubble.remove();
    };
    close.addEventListener("click", cleanup);
    open.addEventListener("click", () => {
      cleanup();
      if (typeof options.openSettings === "function") options.openSettings();
      else window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { focusUserName: true } }));
    });
    bubble.append(close, text, document.createTextNode(" "), open);
    document.documentElement.appendChild(bubble);
    await markFallbackNoticeShown(storageArea);
    requestAnimationFrame(reposition);
    window.addEventListener("resize", reposition, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("smarttex:editor-scroll-state", repositionAfterScroll);
    return true;
  }

  async function applyDetectedName(storageArea, detectedName) {
    const name = cleanDetectedName(detectedName);
    if (!name || !storageArea?.get || !storageArea?.set) return null;
    let stored = {};
    try { stored = await storageArea.get(KEY) || {}; } catch (_error) { return null; }
    const current = normalize(stored?.[KEY]);
    if (current.nameSource === "manual") return current;
    if (current.name === name && current.nameSource === "collabtex") return current;
    const next = { ...current, name, nameSource: "collabtex" };
    try { await storageArea.set({ [KEY]: next }); } catch (_error) { return current; }
    return next;
  }

  async function ensure(storageArea) {
    const generated = randomProfile();
    if (!storageArea?.get || !storageArea?.set) return generated;
    let stored = {};
    try {
      stored = await storageArea.get(KEY) || {};
    } catch (_error) {
      return generated;
    }
    const existing = stored?.[KEY];
    if (existing?.name && validColor(existing?.color)) {
      const normalized = normalize(existing, generated);
      // Persist provenance when upgrading a profile from older SmartTeX builds.
      if (existing.nameSource !== normalized.nameSource) {
        try { await storageArea.set({ [KEY]: normalized }); } catch (_error) {}
      }
      return normalized;
    }
    const profile = normalize(existing, generated);
    try { await storageArea.set({ [KEY]: profile }); } catch (_error) { /* local fallback remains usable */ }
    return profile;
  }

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (typeof window !== "undefined") {
    window.addEventListener(COLLABTEX_IDENTITY_EVENT, (event) => {
      let detail = {};
      try {
        detail = typeof event.detail === "string" ? JSON.parse(event.detail || "{}") : (event.detail || {});
      } catch (_error) {
        return;
      }
      applyDetectedName(extensionApi?.storage?.local, detail?.name).catch(() => {});
    });
  }

  globalThis.SmartTeXCommentProfile = Object.freeze({
    KEY,
    COLLABTEX_IDENTITY_EVENT,
    FALLBACK_NOTICE_KEY,
    OPEN_SETTINGS_EVENT,
    IDENTITY_REFRESH_EVENT,
    ANIMALS,
    COLORS,
    validColor,
    randomProfile,
    normalize,
    cleanDetectedName,
    isFallbackProfile,
    fallbackNoticeShown,
    markFallbackNoticeShown,
    dismissFallbackNotice,
    maybeShowFallbackNotice,
    applyDetectedName,
    ensure
  });
})();
