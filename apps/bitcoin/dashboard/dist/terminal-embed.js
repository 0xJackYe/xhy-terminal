/* A reporting bridge for the local terminal. The standalone options page is unchanged. */
(function () {
  'use strict';

  const host = window.parent;
  const origin = window.location.origin;
  if (host === window || origin === 'null') return;
  try {
    if (host.location.origin !== origin) return;
  } catch (_) {
    return;
  }

  let queued = false;
  let forced = false;
  let started = false;
  let previousFocus;
  let previousHeight;

  function send(message) {
    host.postMessage(message, origin);
  }

  function report() {
    queued = false;
    const force = forced;
    forced = false;
    if (!document.body) return;

    const focused = document.body.classList.contains('quote-focus');
    if (force || focused !== previousFocus) {
      previousFocus = focused;
      send({type: 'options-focus', focused});
    }

    // The quote table uses viewport-based heights. This measurement is informational;
    // resizing the iframe from it would create a parent/child layout feedback loop.
    const rawHeight = focused ? window.innerHeight : Math.max(
      document.body.scrollHeight,
      document.documentElement ? document.documentElement.scrollHeight : 0,
      window.innerHeight
    );
    const height = Math.ceil(rawHeight);
    if (Number.isFinite(height) && height > 0 && (force || height !== previousHeight)) {
      previousHeight = height;
      send({type: 'options-height', height, infoOnly: true});
    }
  }

  function schedule(force) {
    forced = forced || force === true;
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(report);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== host || event.origin !== origin) return;
    if (!event.data || event.data.type !== 'options-request-state') return;
    schedule(true);
  });

  function start() {
    if (started || !document.body) return;
    started = true;
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () { schedule(); }).observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'hidden', 'open'],
        childList: true,
        subtree: true
      });
    }
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(function () { schedule(); });
      observer.observe(document.body);
      if (document.documentElement) observer.observe(document.documentElement);
    }
    window.addEventListener('resize', function () { schedule(); });
    window.addEventListener('pageshow', function () { schedule(true); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) schedule(true);
    });
    schedule(true);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, {once: true});
})();
