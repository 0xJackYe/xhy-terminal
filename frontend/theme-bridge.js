/* Keep the existing local apps on the portal palette, including nested frames. */
(() => {
  "use strict";
  if (window.__xhyThemeBridge) return;
  window.__xhyThemeBridge = true;
  const THEME_KEY = "xhy-theme";
  const observed = new WeakMap();
  const connectedFrames = new WeakSet();
  const financeNavigations = new WeakSet();
  const isProjectPath = path => /^\/(diet|btc)(\/|$)/.test(path) || /^\/travel(?:\.html)?$/.test(path);
  const project = isProjectPath(location.pathname);
  const validTheme = value => value === "dark" || value === "light";
  let currentTheme = "light";

  function installMotion(win) {
    if (win.XHYMotion) return win.XHYMotion;
    const preference = win.matchMedia("(prefers-reduced-motion: reduce)");
    const running = new Map();
    const cancelAll = () => { running.forEach(animation => animation.cancel()); running.clear(); };
    const reflectPreference = () => {
      win.document.documentElement.dataset.motion = preference.matches ? "reduced" : "standard";
      if (preference.matches) cancelAll();
    };
    preference.addEventListener?.("change", reflectPreference);
    reflectPreference();
    const enter = (element, { x = 0, y = 6, duration = 260 } = {}) => {
      if (!element) return;
      running.get(element)?.cancel();
      if (preference.matches || !element.animate || !element.getClientRects().length || element.closest("[hidden]")) return;
      if (win.frameElement && !win.frameElement.getClientRects().length) return;
      const animation = element.animate([
        { opacity: 0, transform: `translate3d(${x}px,${y}px,0)` },
        { opacity: 1, transform: "translate3d(0,0,0)" },
      ], { duration, easing: "cubic-bezier(.22,1,.36,1)" });
      running.set(element, animation);
      animation.finished.catch(() => {}).finally(() => { if (running.get(element) === animation) running.delete(element); });
      return animation;
    };
    win.XHYMotion = Object.freeze({ enter, cancelAll });
    return win.XHYMotion;
  }
  installMotion(window);

  function connectProjectMotion(doc) {
    const win = doc.defaultView;
    const motion = installMotion(win);
    if (win.__xhyProjectMotion || !/^\/btc\/$/.test(doc.location.pathname)) return;
    win.__xhyProjectMotion = true;
    let previous = win.location.hash;
    win.addEventListener("hashchange", () => {
      const next = win.location.hash;
      if (next === previous) return;
      previous = next;
      // Run after the original terminal's synchronous router has exposed the
      // selected page. Never animate market ticks or background refreshes.
      win.queueMicrotask(() => {
        const page = doc.querySelector(next === "#alerts" ? "#alertsPage" : "#walletPage");
        if (!["#alerts", "#wallet", "#wallet-panel"].includes(next) || !page || page.hidden) return;
        motion.cancelAll();
        motion.enter(page);
      });
    });
  }

  function readTheme() {
    try {
      if (window.parent !== window && validTheme(window.parent.document.documentElement.dataset.theme || window.parent.document.documentElement.dataset.xhyTheme)) {
        return window.parent.document.documentElement.dataset.theme || window.parent.document.documentElement.dataset.xhyTheme;
      }
    } catch { /* Only same-origin project frames are synchronized. */ }
    if (validTheme(document.documentElement.dataset.theme)) return document.documentElement.dataset.theme;
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (validTheme(stored)) return stored;
    } catch { /* Continue when local storage is unavailable. */ }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function disableOptions(doc) {
    if (!/^\/btc(?:\/|$)/.test(doc.location?.pathname || "")) return;
    // Keep the nodes used by terminal.js so the wallet and alerts router retains
    // its original event handlers; remove their visible entry and iframe source.
    doc.querySelectorAll('a[data-page="options"], a[href="#options"], .options-link').forEach(node => {
      node.hidden = true;
      node.setAttribute("aria-hidden", "true");
      node.tabIndex = -1;
    });
    const options = doc.getElementById("optionsPage");
    if (options) { options.hidden = true; options.setAttribute("aria-hidden", "true"); }
    const frame = doc.getElementById("optionsFrame");
    if (frame?.hasAttribute("src")) frame.removeAttribute("src");
    const navigation = doc.getElementById("pageNavigation");
    if (navigation && !financeNavigations.has(navigation)) {
      financeNavigations.add(navigation);
      // The original router still keeps its options node. Arrow-key navigation
      // must use just the two visible sections, as pointer navigation does.
      navigation.addEventListener("keydown", event => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        const links = Array.from(navigation.querySelectorAll(".nav-link")).filter(link => !link.hidden);
        const index = links.indexOf(event.target);
        if (index < 0) return;
        const target = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 :
          (index + (event.key === "ArrowRight" ? 1 : links.length - 1)) % links.length;
        event.preventDefault();
        event.stopImmediatePropagation();
        links[target].focus();
        links[target].click();
      }, true);
    }
    const win = doc.defaultView;
    if (win && /^#options(?:$|[/?])/.test(win.location.hash)) {
      win.history.replaceState(null, "", win.location.pathname + win.location.search + "#alerts");
      win.dispatchEvent(new win.Event("hashchange"));
    }
    if (/期权/.test(doc.title)) doc.title = "Bitcoin · 价格警报与钱包";
  }

  function connectFrame(frame) {
    if (connectedFrames.has(frame)) return;
    connectedFrames.add(frame);
    frame.addEventListener("load", () => {
      try { applyDocument(frame.contentDocument, currentTheme, true); }
      catch { /* Foreign frames are intentionally untouched. */ }
    });
    try { applyDocument(frame.contentDocument, currentTheme, true); }
    catch { /* Wait for a same-origin navigation. */ }
  }

  function connectDocumentHeight(doc) {
    const win = doc.defaultView;
    if (!doc.body || win.parent === win || win.__xhyDocumentHeight) return;
    doc.documentElement.dataset.xhyEmbedded = "true";
    let pending = false;
    let lastHeight = 0;
    const announce = () => {
      if (pending) return;
      pending = true;
      win.requestAnimationFrame(() => {
        pending = false;
        if (!win.frameElement?.getClientRects().length) return;
        // Body's natural flow height can shrink; document.scrollHeight has a
        // viewport minimum and would keep enlarging an already resized iframe.
        const body = doc.body.getBoundingClientRect();
        const style = win.getComputedStyle(doc.body);
        const height = Math.ceil(body.height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
        if (height < 1 || height === lastHeight) return;
        lastHeight = height;
        win.parent.postMessage({ type: "xhy:frame-height", height }, win.location.origin);
      });
    };
    win.__xhyDocumentHeight = { announce };
    new win.ResizeObserver(announce).observe(doc.body);
    new win.MutationObserver(announce).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
    win.addEventListener("load", announce);
    win.addEventListener("hashchange", announce);
    doc.fonts?.ready.then(announce);
    announce();
  }

  // Nested wallet content expands the finance document; that document then
  // announces its own new height to the shell. Only exact same-origin child
  // windows can resize their matching iframe.
  window.addEventListener("message", event => {
    if (event.origin !== location.origin || event.data?.type !== "xhy:frame-height" ||
        !Number.isFinite(event.data.height) || event.data.height < 1 || event.data.height > 50000) return;
    const frame = [...document.querySelectorAll("iframe")].find(item => event.source === item.contentWindow);
    if (!frame) return;
    frame.dataset.xhyAutoHeight = "true";
    frame.style.setProperty("--xhy-frame-height", `${Math.ceil(event.data.height)}px`);
  });

  function applyDocument(doc, theme, embedded = false) {
    if (!doc?.documentElement || !doc.defaultView) return;
    try { if (doc.defaultView.location.origin !== location.origin) return; }
    catch { return; }
    const root = doc.documentElement;
    const isProject = embedded || isProjectPath(doc.location.pathname);
    if (isProject) {
      root.dataset.xhyTheme = theme;
      root.dataset.xhySurface = /^\/travel(?:\.html)?$/.test(doc.location.pathname) ? "travel" : /^\/diet(?:\/|$)/.test(doc.location.pathname) ? "diet" : /\/wallet\.html$/.test(doc.location.pathname) ? "wallet" : "btc";
      root.style.colorScheme = theme;
      if (doc.head && !doc.querySelector('link[data-xhy-embed-theme]')) {
        const sheet = doc.createElement("link");
        sheet.rel = "stylesheet";
        sheet.href = "/embed-theme.css";
        sheet.dataset.xhyEmbedTheme = "";
        doc.head.append(sheet);
      }
      // Native terminal CSS also uses body.dark. Keep both token systems aligned.
      if (doc.body) doc.body.classList.toggle("dark", theme === "dark");
      disableOptions(doc);
      connectDocumentHeight(doc);
      connectProjectMotion(doc);
    }
    if (!observed.has(doc)) {
      let queued = false;
      const observer = new MutationObserver(records => {
        if (queued || !records.some(record => record.addedNodes.length)) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (isProject) disableOptions(doc);
          doc.querySelectorAll("iframe").forEach(connectFrame);
        });
      });
      observer.observe(root, { childList: true, subtree: true });
      observed.set(doc, observer);
      doc.defaultView.addEventListener("hashchange", () => { if (isProject) disableOptions(doc); });
      doc.addEventListener("DOMContentLoaded", () => applyDocument(doc, currentTheme, isProject), { once: true });
    }
    doc.querySelectorAll("iframe").forEach(frame => {
      connectFrame(frame);
      try { applyDocument(frame.contentDocument, theme, true); }
      catch { /* Cross-origin frames remain isolated. */ }
    });
    // The local charts use SVG with CSS colors. Resize also refreshes wallet
    // geometry when a formerly hidden project becomes visible.
    doc.defaultView.dispatchEvent(new doc.defaultView.CustomEvent("xhy:embedded-theme", { detail: { theme } }));
  }

  function synchronize(theme = readTheme()) {
    currentTheme = validTheme(theme) ? theme : readTheme();
    applyDocument(document, currentTheme, project);
  }
  synchronize();
  window.addEventListener("xhy:embedded-theme", event => {
    // Parent and nested copies can both observe a project document. Keep this
    // copy's value current before it observes a later dynamically added frame.
    if (validTheme(event.detail?.theme)) currentTheme = event.detail.theme;
  });
  window.addEventListener("xhy:theme-change", event => synchronize(event.detail?.theme));
  window.addEventListener("storage", event => { if (event.key === THEME_KEY) synchronize(event.newValue); });
  new MutationObserver(() => synchronize()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("DOMContentLoaded", () => synchronize(), { once: true });
})();
