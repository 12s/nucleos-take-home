/*
 * Runs on www.khanacademy.org pages, but does nothing unless the background says
 * this tab submitted the login form in the last minute. Then it proves the
 * sign-in by asking Khan Academy's own API who is signed in, and only reports
 * success if that user is the configured one and is not an anonymous "phantom".
 */
(function () {
  'use strict';
  const { fetchIdentity } = globalThis.KAX;
  const { showToast } = globalThis.KAXToast;
  if (globalThis.__kaxLandingRan) return;
  globalThis.__kaxLandingRan = true;

  const log = (...a) => console.log('[KA auto sign-in]', ...a);

  async function run() {
    const plan = await chrome.runtime.sendMessage({ type: 'landingPageLoaded' });
    if (!plan || !plan.verify) return; // ordinary page visit: stay out of the way

    // Same-origin request from the page, so Khan Academy's own session cookie is used.
    const result = await fetchIdentity(fetch.bind(globalThis), document.cookie, plan.username);
    await chrome.runtime.sendMessage({ type: 'verificationResult', result });

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
