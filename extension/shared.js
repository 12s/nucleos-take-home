/*
 * Pure logic shared by the content scripts, the service worker, the onboarding
 * script and the tests. Nothing in here touches chrome.* APIs, so it can be
 * required from Node and unit-tested directly.
 *
 * Loaded three ways:
 *   - content scripts: listed before login.js / landing.js in manifest.json
 *   - service worker:  importScripts('shared.js')
 *   - Node:            require('../extension/shared.js')
 */
(function (root) {
  'use strict';

  // Khan Academy's own GraphQL operation for the signed-in user. The field list
  // is a subset of the query the khanacademy.org web app ships in its bundle.
  const PROFILE_URL = 'https://www.khanacademy.org/api/internal/graphql/getFullUserProfile';
  const PROFILE_QUERY = 'query getFullUserProfile { user { id kaid email username isPhantom } }';

  // How long we wait on the login page for Khan Academy to react to a submit.
  const RESULT_TIMEOUT_MS = 20000;
  // How long the landing page listens for Khan Academy's own user queries.
  const PASSIVE_WAIT_MS = 15000;
  // How long a "submitted" attempt stays eligible for verification on the next page.
  const PENDING_TTL_MS = 60000;

  // Element ids belonging to the TrustArc cookie banner, never a sign-in error.
  const IGNORED_ANCESTOR = '[id^="truste"], [id*="trustarc"], #kax-toast-host';

  /** Collapse whitespace the way a browser renders it, without changing words. */
  function normalizeText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /**
   * Validate a parsed config object. Returns { ok, config } or { ok:false, error }.
   * The error never includes the password.
   */
  function validateConfig(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'config is not a JSON object' };
    const username = typeof raw.username === 'string' ? raw.username.trim() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    if (!username) return { ok: false, error: 'config.username is missing or empty' };
    if (!password) return { ok: false, error: 'config.password is missing or empty' };
    return { ok: true, config: { username, password } };
  }

  /** Is this URL the Khan Academy login page? (The only page we act on.) */
  function isLoginUrl(href) {
    let u;
    try { u = new URL(href); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    const hostOk = u.hostname === 'accounts.khanacademy.org' || u.hostname === 'www.khanacademy.org';
    return hostOk && /^\/login\/?$/.test(u.pathname);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    // jsdom has no layout; only trust getClientRects when a real engine is present.
    if (typeof el.getClientRects === 'function' && el.ownerDocument.defaultView &&
        el.ownerDocument.defaultView.navigator && !/jsdom/i.test(el.ownerDocument.defaultView.navigator.userAgent)) {
      if (el.getClientRects().length === 0) return false;
    }
    return true;
  }

  /**
   * Every piece of text on the page that Khan Academy uses to announce a problem
   * with the login form: alerts and assertive live regions, plus the description text of any
   * field it has marked aria-invalid. Returned verbatim (whitespace-collapsed).
   */
  function collectMessageTexts(doc) {
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || el.closest(IGNORED_ANCESTOR) || !isVisible(el)) return;
      const t = normalizeText(el.textContent);
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    };
    // Polite live regions are left out on purpose: they also carry status text
    // such as "Logging in…", which is not an error.
    doc.querySelectorAll('[role="alert"], [aria-live="assertive"]').forEach(push);
    doc.querySelectorAll('input[aria-invalid="true"]').forEach((input) => {
      const ids = normalizeText(input.getAttribute('aria-describedby')).split(' ').filter(Boolean);
      ids.forEach((id) => push(doc.getElementById(id)));
      const errId = input.getAttribute('aria-errormessage');
      if (errId) push(doc.getElementById(errId));
    });
    return out;
  }

  /** Texts present now that were not present in the pre-submit baseline. */
  function newMessages(current, baseline) {
    const base = new Set(baseline);
    return current.filter((t) => !base.has(t));
  }

  /**
   * Decide what a getFullUserProfile response proves.
   *   success        - a real (non-phantom) user whose email or username is the configured one
   *   not-signed-in  - Khan Academy says there is no user, or only an anonymous "phantom" one
   *   mismatch       - signed in, but as somebody else
   *   unverifiable   - the response did not have the shape we need; we refuse to guess
   */
  function evaluateIdentity(json, configuredUsername) {
    const want = normalizeText(configuredUsername).toLowerCase();
    if (!json || typeof json !== 'object') return { status: 'unverifiable', detail: 'empty or non-JSON response' };
    if (Array.isArray(json.errors) && json.errors.length) {
      return { status: 'unverifiable', detail: 'GraphQL error: ' + normalizeText(json.errors[0] && json.errors[0].message) };
    }
    if (!json.data || !('user' in json.data)) return { status: 'unverifiable', detail: 'response has no data.user field' };
    const user = json.data.user;
    if (user === null) return { status: 'not-signed-in', detail: 'Khan Academy reports no signed-in user' };
    if (typeof user !== 'object') return { status: 'unverifiable', detail: 'data.user is not an object' };
    if (user.isPhantom === true) return { status: 'not-signed-in', detail: 'Khan Academy reports an anonymous (phantom) user' };
    if (user.isPhantom !== false) return { status: 'unverifiable', detail: 'isPhantom missing from response' };
    if (typeof user.kaid !== 'string' || !user.kaid) return { status: 'unverifiable', detail: 'kaid missing from response' };
    const email = normalizeText(user.email).toLowerCase();
    const username = normalizeText(user.username).toLowerCase();
    if (want && (want === email || want === username)) {
      return { status: 'success', detail: 'signed in as kaid ' + user.kaid, kaid: user.kaid };
    }
    return { status: 'mismatch', detail: 'signed in, but as a different account (kaid ' + user.kaid + ')', kaid: user.kaid };
  }

  /**
   * Khan Academy's own pages query the signed-in user through safelisted GraphQL
   * operations (our ad-hoc query can be refused with HTTP 403). Look through any
   * GraphQL response for user objects (a kaid plus isPhantom) and apply
   * evaluateIdentity to each. Only a success is returned: a page can also show
   * other people, so a non-matching user proves nothing either way.
   */
  function findIdentityInGraphQL(json, configuredUsername) {
    const seen = new Set();
    let found = null;
    (function walk(node, depth) {
      if (found || !node || typeof node !== 'object' || depth > 10 || seen.has(node)) return;
      seen.add(node);
      if (typeof node.kaid === 'string' && typeof node.isPhantom === 'boolean') {
        const v = evaluateIdentity({ data: { user: node } }, configuredUsername);
        if (v.status === 'success') { found = v; return; }
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    })(json, 0);
    return found;
  }

  /** Read Khan Academy's CSRF token ("fkey" cookie) if it is visible to scripts. */
  function readFkey(cookieString) {
    const m = /(?:^|;\s*)fkey=([^;]+)/.exec(cookieString || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  /**
   * Ask Khan Academy who is signed in. `fetchImpl` and `cookieString` are passed
   * in so the onboarding script, the extension and the tests share one code path.
   */
  async function fetchIdentity(fetchImpl, cookieString, configuredUsername) {
    const headers = { 'content-type': 'application/json' };
    const fkey = readFkey(cookieString);
    if (fkey) headers['x-ka-fkey'] = fkey;
    let res;
    try {
      res = await fetchImpl(PROFILE_URL, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ operationName: 'getFullUserProfile', query: PROFILE_QUERY, variables: {} }),
      });
    } catch (e) {
      return { status: 'unverifiable', detail: 'profile request failed: ' + (e && e.message) };
    }
    if (!res.ok) return { status: 'unverifiable', detail: 'profile request returned HTTP ' + res.status };
    let json;
    try { json = await res.json(); } catch { return { status: 'unverifiable', detail: 'profile response was not JSON' }; }
    return evaluateIdentity(json, configuredUsername);
  }

  /** Mask an email/username for logs: "matt+ka@gmail.com" -> "m***@gmail.com". */
  function maskIdentifier(s) {
    const v = normalizeText(s);
    if (!v) return '(empty)';
    const at = v.indexOf('@');
    if (at > 0) return v[0] + '***' + v.slice(at);
    return v[0] + '***';
  }

  const api = {
    PROFILE_URL, PROFILE_QUERY, RESULT_TIMEOUT_MS, PENDING_TTL_MS, PASSIVE_WAIT_MS,
    normalizeText, validateConfig, isLoginUrl, collectMessageTexts, newMessages,
    evaluateIdentity, findIdentityInGraphQL, readFkey, fetchIdentity, maskIdentifier,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KAX = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
