/*
 * Runs in the page's own JavaScript world ("world": "MAIN") at document_start on
 * www.khanacademy.org, so it sees the GraphQL requests Khan Academy's app makes
 * for the signed-in user. It only reads responses: it never changes a request or
 * a response, and it never sends anything off the page. Each GraphQL response is
 * handed to landing.js (isolated world) with window.postMessage; landing.js
 * ignores them unless this tab is verifying a sign-in.
 */
(function () {
  'use strict';
  if (window.__kaxHook) return;
  window.__kaxHook = true;

  const isGraphQL = (url) => /\/api\/internal\/graphql\//.test(String(url));
  const emit = (url, json) => {
    try { window.postMessage({ source: 'kax-page-hook', url: String(url), json }, location.origin); } catch { /* not cloneable */ }
  };

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = args[0] && typeof args[0] === 'object' && 'url' in args[0] ? args[0].url : args[0];
      if (isGraphQL(url)) p.then((r) => r.clone().json().then((j) => emit(url, j), () => {}), () => {});
    } catch { /* never break the page */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (isGraphQL(url)) {
        this.addEventListener('load', () => {
          try { emit(url, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* not JSON */ }
        });
      }
    } catch { /* never break the page */ }
    return origOpen.call(this, method, url, ...rest);
  };
})();
