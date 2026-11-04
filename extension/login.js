/*
 * Runs on the Khan Academy login page only (see manifest.json "matches").
 * Once per page load: fill the form, submit it, and report exactly what Khan
 * Academy says. Success is never decided here; it is proven on the next page
 * (landing.js) by asking Khan Academy who is signed in.
 */
(function () {
  'use strict';
  const { isLoginUrl, collectMessageTexts, newMessages, RESULT_TIMEOUT_MS } = globalThis.KAX;
  const { showToast } = globalThis.KAXToast;

  // One attempt per visit: this flag lives as long as this document does.
  if (globalThis.__kaxLoginRan) return;
  globalThis.__kaxLoginRan = true;
  if (!isLoginUrl(location.href)) return;

  const SEL = {
    username: '[data-testid="identifier-field"], #username-field, input[name="username"]',
    password: '[data-testid="password-field"], #current-password-field, input[type="password"]',
    submit: '[data-testid="log-in-submit-button"], form button[type="submit"]',
  };

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const log = (...a) => console.log('[KA auto sign-in]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Resolve with fn()'s first truthy value, re-checking on DOM changes. */
  function waitFor(fn, timeoutMs) {
    return new Promise((resolve) => {
      const first = fn();
      if (first) return resolve(first);
      const done = (v) => { obs.disconnect(); clearInterval(iv); clearTimeout(to); resolve(v); };
      const check = () => { const v = fn(); if (v) done(v); };
      const obs = new MutationObserver(check);
      obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const iv = setInterval(check, 250);
      const to = setTimeout(() => done(null), timeoutMs);
    });
  }

  /** Set a value so React-controlled inputs notice it. */
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  async function run() {
    const plan = await send({ type: 'loginPageLoaded' });
    if (!plan || plan.error) { log('background error', plan && plan.error); return; }
    if (!plan.attempt) {
      if (plan.report) { showToast(plan.report.kind, plan.report.text); log(plan.report.text); }
      return;
    }

    const form = await waitFor(() => {
      const u = document.querySelector(SEL.username);
      const p = document.querySelector(SEL.password);
      const b = document.querySelector(SEL.submit);
      return u && p && b ? { u, p, b } : null;
    }, 15000);
    if (!form) {
      const text = 'Could not find the Khan Academy login form on this page, so nothing was submitted.';
      showToast('unknown', text);
      await send({ type: 'attemptUnknown', detail: text });
      return;
    }

    setValue(form.u, plan.username);
    setValue(form.p, plan.password);
    plan.password = null;

    // Khan Academy keeps the button aria-disabled until both fields validate.
    const enabled = await waitFor(() => form.b.getAttribute('aria-disabled') !== 'true' && !form.b.disabled, 5000);
    if (!enabled) {
      const msgs = collectMessageTexts(document);
      const text = msgs.length ? msgs.join('\n') : 'The Log in button stayed disabled after filling the form, so nothing was submitted.';
      showToast('unknown', text);
      await send({ type: 'attemptUnknown', detail: text });
      return;
    }

    const baseline = collectMessageTexts(document);
    // Record the attempt before clicking: a successful login navigates away and
    // this script stops running, so the background must already know.
    await send({ type: 'attemptSubmitted', username: plan.username, source: plan.source });
    log('submitting with credentials from', plan.source);
    form.b.click();

    const errors = await waitFor(() => {
      const fresh = newMessages(collectMessageTexts(document), baseline);
      return fresh.length ? fresh : null;
    }, RESULT_TIMEOUT_MS);

    if (errors) {
      await sleep(300); // let a message that renders in pieces finish
      const final = newMessages(collectMessageTexts(document), baseline);
      const text = (final.length ? final : errors).join('\n');
      showToast('error', text);
      log('Khan Academy error:', text);
      await send({ type: 'attemptFailed', error: text });
      return;
    }

    // Still here, no error, no navigation: we cannot prove anything.
    const text = 'No response from Khan Academy within ' + RESULT_TIMEOUT_MS / 1000 + ' seconds. Sign-in was not confirmed.';
    showToast('unknown', text);
    log(text);
    await send({ type: 'attemptUnknown', detail: text });
  }

  run().catch((e) => log('unexpected error', e));
})();
