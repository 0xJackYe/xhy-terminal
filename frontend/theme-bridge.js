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
    // Frames grow to their content, so their own vh is circular. Long lists
    // size themselves against the top window instead.
    try {
      const top = win.top;
      const syncViewport = () => doc.documentElement.style.setProperty("--xhy-vh", `${top.innerHeight}px`);
      top.addEventListener("resize", syncViewport);
      syncViewport();
    } catch { /* Only same-origin portal frames reach this point. */ }
    new win.ResizeObserver(announce).observe(doc.body);
    new win.MutationObserver(announce).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
    win.addEventListener("load", announce);
    win.addEventListener("hashchange", announce);
    doc.fonts?.ready.then(announce);
    announce();
  }

  // Portal shortcuts keep working while focus is inside an embedded project:
  // ⌘K / Ctrl+K always, and 1 2 3 T / ? whenever no field is being typed in
  // and the project has not used the key itself.
  // On a narrow page (a phone) the Bitcoin pages show one section at a time,
  // chosen in the terminal's top bar, so each fits the screen without
  // scrolling: 行情 · 警报 · 邮件 for alerts, 持仓 · 分布 · 定投 for the wallet.
  // Wide windows show every section side by side and hide the switch (CSS).
  const SECTIONS = {
    alerts: { page: "alertsPage", items: [["market", "行情"], ["alarm", "警报"], ["email", "邮件"]] },
    wallet: { page: "walletPage", items: [["holdings", "持仓"], ["allocation", "分布"], ["dca", "定投"]] },
  };
  function connectSections(doc) {
    const win = doc.defaultView;
    if (win.__xhySections || !/^\/btc\/?$/.test(doc.location.pathname)) return;
    const bar = doc.querySelector(".topbar");
    if (!bar) return;
    win.__xhySections = true;
    const root = doc.documentElement, group = doc.createElement("div");
    group.className = "xhy-sections";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "页面分区");
    bar.append(group);
    const current = () => Object.keys(SECTIONS).find(key => { const page = doc.getElementById(SECTIONS[key].page);return page && !page.hidden; });
    const render = () => {
      const key = current();
      group.hidden = !key;
      if (!key) return;
      const chosen = root.dataset["xhySection" + key[0].toUpperCase() + key.slice(1)] || SECTIONS[key].items[0][0];
      root.dataset["xhySection" + key[0].toUpperCase() + key.slice(1)] = chosen;
      const html = SECTIONS[key].items.map(([value, label]) => '<button type="button" data-section="' + value + '" aria-pressed="' + (value === chosen) + '">' + label + "</button>").join("");
      if (group.innerHTML !== html) group.innerHTML = html;
    };
    group.addEventListener("click", event => {
      const button = event.target.closest?.("button[data-section]"), key = current();
      if (!button || !key) return;
      root.dataset["xhySection" + key[0].toUpperCase() + key.slice(1)] = button.dataset.section;
      render();
      win.scrollTo?.(0, 0);
      win.__xhyFitReset?.();
      win.XHYMotion?.enter(doc.getElementById(SECTIONS[key].page), { y: 4, duration: 220 });
      // A diary wider than a phone opens on its latest weeks, as it does when
      // it first draws in view.
      win.requestAnimationFrame(() => { for (const strip of doc.querySelectorAll(".dca-diary-scroll")) strip.scrollLeft = strip.scrollWidth; });
    });
    // The terminal's router shows the page first; follow it on the next tick.
    win.addEventListener("hashchange", () => win.setTimeout(render, 0));
    render();
    win.setTimeout(render, 0);
  }

  // The portal shows no standing notices. A form's own result (saved, or why
  // not) still shows for a few seconds after the person uses that form: the
  // panel is marked while its result is wanted, and CSS shows it only then.
  const FORMS = ".alarm-panel, .email-panel, .portfolio-settings";
  function connectFeedback(doc) {
    const win = doc.defaultView;
    if (win.__xhyFeedback || win.parent === win) return;
    win.__xhyFeedback = true;
    const mark = event => {
      const panel = event.target.closest?.(FORMS);
      if (!panel) return;
      panel.dataset.xhyActed = "true";
      win.clearTimeout(panel.__xhyActed);
      panel.__xhyActed = win.setTimeout(() => { delete panel.dataset.xhyActed; }, 8000);
    };
    for (const type of ["click", "submit", "change"]) doc.addEventListener(type, mark, true);
  }

  // A page inside the portal never scrolls: when the window is too small for
  // everything on it, the page is drawn a little smaller (down to 70%) instead
  // of showing a scroll bar. --xhy-fit lets full-height layouts keep filling
  // the window at that scale. Re-measured after every layout change; a window
  // resize, page switch or section switch starts again from full size.
  function connectFit(doc) {
    const win = doc.defaultView;
    if (win.__xhyFit || win.parent === win || !doc.body) return;
    win.__xhyFit = true;
    const root = doc.documentElement;
    // An embedded page never shows a scroll bar: it fits by drawing smaller
    // (below), and anything still taller at the smallest size is cut off
    // rather than scrolled. The body never scrolls on its own, so whatever
    // it holds counts towards the page height measured below.
    root.style.setProperty("overflow", "hidden", "important");
    doc.body.style.setProperty("overflow", "visible", "important");
    let zoom = 1, frame = 0;
    const set = value => {
      zoom = value;
      doc.body.style.zoom = value === 1 ? "" : String(value);
      root.style.setProperty("--xhy-fit", String(value));
    };
    const measure = () => {
      frame = 0;
      // Native chart input uses unscaled CSS coordinates. Keep its fullscreen
      // dialog at 1:1; resume fitting the underlying page after it closes.
      if (doc.querySelector("#dcaCandleSheet:not([hidden])")) {
        if (zoom !== 1) set(1);
        return;
      }
      // The page, and any card whose height is set by the window (the travel
      // form), must show all of its content.
      let ratio = win.innerHeight / root.scrollHeight;
      for (const box of doc.querySelectorAll(".travel-form")) if (box.clientHeight && box.scrollHeight > box.clientHeight + 1) ratio = Math.min(ratio, box.clientHeight / box.scrollHeight);
      if (ratio < 0.998 && zoom > 0.7) {
        set(Math.max(0.7, Math.floor(zoom * ratio * 1000) / 1000));
        frame = win.requestAnimationFrame(measure);
      }
    };
    const schedule = reset => {
      if (reset && zoom !== 1) set(1);
      if (!frame) frame = win.requestAnimationFrame(measure);
    };
    // Content that grows inside a fixed-height box does not resize the body,
    // so any change to the page is a reason to measure again (once a frame).
    new win.ResizeObserver(() => schedule(false)).observe(doc.body);
    new win.MutationObserver(() => schedule(false)).observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "open"] });
    win.addEventListener("resize", () => schedule(true));
    win.addEventListener("hashchange", () => schedule(true));
    win.__xhyFitReset = () => schedule(true);
    schedule(false);
  }

  function connectShortcuts(doc) {
    const win = doc.defaultView;
    if (win.top === win || win.__xhyShortcuts) return;
    win.__xhyShortcuts = true;
    const typing = target => target instanceof win.Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
    doc.addEventListener("keydown", event => {
      const palette = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
      const single = !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing && !event.repeat
        && ["1", "2", "3", "t", "T", "/", "?"].includes(event.key) && !typing(event.target);
      if ((!palette && !single) || event.defaultPrevented) return;
      event.preventDefault();
      win.top.postMessage({ type: "xhy:shortcut", key: palette ? "palette" : event.key.toLowerCase() }, win.location.origin);
    });
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
      // The portal's phone interface shows the page title itself.
      if (embedded && document.documentElement.dataset.ui) root.dataset.xhyUi = document.documentElement.dataset.ui;
      // The travel page is built on the portal's own design and needs no
      // restyling; the older Diet and Bitcoin apps get the shared embed theme.
      if (doc.head && root.dataset.xhySurface !== "travel" && !doc.querySelector('link[data-xhy-embed-theme]')) {
        // embed-dense.css only applies inside the portal frame: it re-flows each
        // page so its content fits one window under the shell header.
        for (const href of ["/embed-theme.css", "/embed-dense.css"]) {
          const sheet = doc.createElement("link");
          sheet.rel = "stylesheet";
          sheet.href = href;
          sheet.dataset.xhyEmbedTheme = "";
          doc.head.append(sheet);
        }
      }
      // Native terminal CSS also uses body.dark. Keep both token systems aligned.
      if (doc.body) doc.body.classList.toggle("dark", theme === "dark");
      disableOptions(doc);
      connectDocumentHeight(doc);
      connectProjectMotion(doc);
      connectShortcuts(doc);
      connectSections(doc);
      connectFeedback(doc);
      connectFit(doc);
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
