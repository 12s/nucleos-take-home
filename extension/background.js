/*
 * Service worker: the only place that reads the credentials, and the source of
 * truth for each tab's sign-in attempt across page navigations.
 *
 * Per-tab state lives in chrome.storage.session (memory only, cleared when the
 * browser closes, never synced). The attempt log lives in chrome.storage.local
 * and never contains a password.
 */
importScripts('shared.js');
const { validateConfig, maskIdentifier, PENDING_TTL_MS } = self.KAX;

const LOG_KEY = 'kaxLog';
const LOG_MAX = 100;
const tabKey = (tabId) => 'tab:' + tabId;

/**
 * config.local.json (git-ignored, your real account) wins over config.json
 * (committed, deliberately wrong example values).
 */
async function loadConfig() {
  for (const file of ['config.local.json', 'config.json']) {
    let res;
    try { res = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' }); } catch { continue; }
    if (!res.ok) continue;
    let raw;
    try { raw = await res.json(); } catch { return { ok: false, error: file + ' is not valid JSON', source: file }; }
    const v = validateConfig(raw);
    return v.ok ? { ok: true, config: v.config, source: file } : { ok: false, error: file + ': ' + v.error, source: file };
  }
  return { ok: false, error: 'no config.json or config.local.json found in the extension folder', source: null };
}

async function log(entry) {
  const line = { at: new Date().toISOString(), ...entry };
  console.log('[KA auto sign-in]', JSON.stringify(line));
  const { [LOG_KEY]: prev = [] } = await chrome.storage.local.get(LOG_KEY);
  await chrome.storage.local.set({ [LOG_KEY]: [...prev, line].slice(-LOG_MAX) });
}

async function getTab(tabId) {
  const { [tabKey(tabId)]: s } = await chrome.storage.session.get(tabKey(tabId));
  return s || null;
}
const setTab = (tabId, s) => chrome.storage.session.set({ [tabKey(tabId)]: s });
const clearTab = (tabId) => chrome.storage.session.remove(tabKey(tabId));

chrome.tabs.onRemoved.addListener((tabId) => { clearTab(tabId); });

const handlers = {
  /** Login page loaded. Decide whether this visit may make an attempt. */
  async loginPageLoaded(msg, tabId) {
    const s = await getTab(tabId);
    if (s && s.phase === 'submitted' && Date.now() - s.at < PENDING_TTL_MS) {
      // Khan Academy bounced us straight back to /login after our submit, with
      // no message we could read. Report that instead of trying again.
      await clearTab(tabId);
      await log({ outcome: 'unconfirmed', user: s.user, detail: 'returned to the login page after submitting; sign-in not confirmed' });
      return { attempt: false, report: { kind: 'unknown', text: 'Sign-in was not confirmed: Khan Academy returned to the login page without a message.' } };
    }
    const c = await loadConfig();
    if (!c.ok) {
      await log({ outcome: 'config-error', detail: c.error });
      return { attempt: false, report: { kind: 'error', text: 'Auto sign-in is not configured: ' + c.error } };
    }
    return { attempt: true, username: c.config.username, password: c.config.password, source: c.source };
  },

  /** Sent just before the content script clicks "Log in". */
  async attemptSubmitted(msg, tabId) {
    await setTab(tabId, { phase: 'submitted', at: Date.now(), user: maskIdentifier(msg.username), username: msg.username });
    await log({ outcome: 'submitted', user: maskIdentifier(msg.username), source: msg.source });
    return { ok: true };
  },

  /** Khan Academy displayed an error on the login form. */
  async attemptFailed(msg, tabId) {
    const s = await getTab(tabId);
    await clearTab(tabId);
    await log({ outcome: 'failed', user: s && s.user, khanAcademyError: msg.error });
    return { ok: true };
  },

  /** Nothing observable happened on the login page within the timeout. */
  async attemptUnknown(msg, tabId) {
    const s = await getTab(tabId);
    await clearTab(tabId);
    await log({ outcome: 'unconfirmed', user: s && s.user, detail: msg.detail });
    return { ok: true };
  },

  /** A khanacademy.org page loaded. Only acts if this tab just submitted the form. */
  async landingPageLoaded(msg, tabId) {
    const s = await getTab(tabId);
    if (!s || s.phase !== 'submitted') return { verify: false };
    if (Date.now() - s.at > PENDING_TTL_MS) { await clearTab(tabId); return { verify: false }; }
    await setTab(tabId, { ...s, phase: 'verifying' });
    return { verify: true, username: s.username };
  },

  /** Result of the identity check on the landing page. */
  async verificationResult(msg, tabId) {
    const s = await getTab(tabId);
    await clearTab(tabId);
    await log({ outcome: msg.result.status === 'success' ? 'signed-in' : 'unconfirmed', user: s && s.user, check: msg.result.status, detail: msg.result.detail });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  const h = msg && handlers[msg.type];
  // Only our own content scripts (which always run inside a tab) talk to us.
  if (!h || tabId == null || sender.id !== chrome.runtime.id) return false;
  h(msg, tabId).then(sendResponse, (e) => sendResponse({ error: String(e && e.message) }));
  return true; // async response
});
