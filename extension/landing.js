/*
 * Runs on www.khanacademy.org pages from document_start, but does nothing unless
 * the background says this tab submitted the login form in the last minute.
 * Then it proves the sign-in from Khan Academy itself, two ways:
 *   1. passive: the user objects in Khan Academy's own GraphQL responses, seen by
 *      page-hook.js (these use Khan Academy's safelisted queries);
 *   2. active: our own getFullUserProfile request (may be refused with HTTP 403).
 * Success needs a non-phantom user whose email or username is the configured one.
 * Anything less after PASSIVE_WAIT_MS is reported as "not confirmed".
 */
(function () {
  'use strict';
  const { fetchIdentity, findIdentityInGraphQL, PASSIVE_WAIT_MS } = globalThis.KAX;
  const { showToast } = globalThis.KAXToast;
  if (globalThis.__kaxLandingRan) return;
  globalThis.__kaxLandingRan = true;

  const log = (...a) => console.log('[KA auto sign-in]', ...a);

  // Start listening immediately so we don't miss Khan Academy's first requests.
  const buffered = [];
  let onResponse = null;
  const listener = (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'kax-page-hook') return;
    buffered.push(e.data.json);
    if (onResponse) onResponse(e.data.json);
  };
  window.addEventListener('message', listener);

  const domReady = () => new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r()));

  async function run() {
    const plan = await chrome.runtime.sendMessage({ type: 'landingPageLoaded' });
    if (!plan || !plan.verify) { window.removeEventListener('message', listener); return; } // ordinary visit

    const result = await new Promise((resolve) => {
      let done = false;
      let active = null;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const consider = (json) => { const v = findIdentityInGraphQL(json, plan.username); if (v) finish({ ...v, detail: v.detail + ', from Khan Academy\'s own user query' }); };

      buffered.forEach(consider);
      onResponse = consider;

      fetchIdentity(fetch.bind(globalThis), document.cookie, plan.username).then((r) => {
        active = r;
        if (r.status === 'success') finish(r);
      });

      const timer = setTimeout(() => {
        // No proof. Report the most specific reason we have.
        const why = active && active.status !== 'unverifiable'
          ? active.detail
          : 'no Khan Academy response identified the configured user within ' + PASSIVE_WAIT_MS / 1000 + ' s' + (active ? ' (our own check: ' + active.detail + ')' : '');
        finish({ status: active && active.status !== 'unverifiable' ? active.status : 'unverifiable', detail: why });
      }, PASSIVE_WAIT_MS);
    });

    window.removeEventListener('message', listener);
    await chrome.runtime.sendMessage({ type: 'verificationResult', result });
    await domReady();
    if (result.status === 'success') {
      const text = 'Khan Academy confirms you are signed in (' + result.detail + ').';
      showToast('success', text);
      log(text);
    } else {
      const text = 'Sign-in was not confirmed: ' + result.detail + '.';
      showToast('unknown', text);
      log(text);
    }
  }

  run().catch((e) => log('unexpected error', e));
})();
