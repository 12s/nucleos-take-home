/*
 * Onboarding: create one free Khan Academy learner account with email + password,
 * then prove it exists by asking Khan Academy who is signed in.
 *
 * Exported as a function taking a Playwright BrowserContext so the tests can run
 * the exact same code against local fixture pages.
 */
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KAX = require('../extension/shared.js');
export const { maskIdentifier, normalizeText } = KAX;

export const SIGNUP_URL = 'https://www.khanacademy.org/signup';
// Khan Academy's month picker shows "Jan", "Feb", …; accept the full name too.
const JANUARY = /^jan(uary)?\.?$/i;

/** Strong random password: 20 chars, always has lower, upper, digit and symbol. */
export function generatePassword(length = 20) {
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#%^*-_=+'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

export function parseArgs(argv, env = {}) {
  const opts = { email: env.KA_EMAIL || '', birthYear: 2000, firstName: 'Nucleos', lastName: 'Learner', force: false, agreeTerms: false, timeoutMin: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(a + ' needs a value'); return v; };
    if (a === '--email') opts.email = next();
    else if (a === '--birth-year') opts.birthYear = Number(next());
    else if (a === '--first-name') opts.firstName = next();
    else if (a === '--last-name') opts.lastName = next();
    else if (a === '--timeout-min') opts.timeoutMin = Number(next());
    else if (a === '--force') opts.force = true;
    else if (a === '--agree-terms') opts.agreeTerms = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error('unknown argument ' + a);
  }
  if (opts.help) return opts;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email)) throw new Error('pass --email you@example.com (or set KA_EMAIL)');
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(opts.birthYear) || thisYear - opts.birthYear < 18 || opts.birthYear < 1900) {
    throw new Error('--birth-year must make the learner an adult (18+)');
  }
  if (!(opts.timeoutMin > 0)) throw new Error('--timeout-min must be positive');
  return opts;
}

/**
 * The only place the final verdict is decided. "created" requires proof from
 * Khan Academy itself; an error message means "failed"; anything else is
 * "unverified", which is reported as such and never rounded up to success.
 */
export function decideOutcome({ identity, kaError, timedOut }) {
  if (identity && identity.status === 'success') return { outcome: 'created', detail: identity.detail };
  if (identity && identity.status === 'mismatch') return { outcome: 'unverified', detail: identity.detail };
  if (kaError) return { outcome: 'failed', detail: kaError };
  if (timedOut) return { outcome: 'unverified', detail: 'timed out before Khan Academy confirmed a signed-in account' + (identity ? ' (last check: ' + identity.detail + ')' : '') };
  return { outcome: 'unverified', detail: identity ? identity.detail : 'no confirmation from Khan Academy' };
}

/** Make sure a string we are about to print can't contain the secrets. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out;
}

// ---- page helpers (run against real pages or fixtures) ----

const EMAIL_SEL = 'input[type="email"], input[name*="email" i], input[autocomplete="email"], input[autocomplete="username"]';
const PASSWORD_SEL = 'input[type="password"]';
const FIRST_SEL = 'input[autocomplete="given-name"], input[name*="first" i]';
const LAST_SEL = 'input[autocomplete="family-name"], input[name*="last" i]';
const SUBMIT_RE = /^(sign up|create account|create my account|continue|next|submit)$/i;
// The profile step after sign-up ("Enter Khan Academy for learners").
const PROFILE_RE = /^(enter khan academy\b.*|get started|finish|done|let's go)$/i;
const EMAIL_PATH_RE = /(sign up|continue) with email/i;
const CAPTCHA_SEL = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[title*="captcha" i]';

async function fillVisibleEmpty(page, selector, value) {
  let n = 0;
  const loc = typeof selector === 'string' ? page.locator(selector) : selector;
  for (const el of await loc.all()) {
    if (await el.isVisible().catch(() => false) && (await el.inputValue().catch(() => 'x')) === '') {
      await el.fill(value);
      n++;
    }
  }
  return n;
}

async function alertTexts(page) {
  return page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll('[role="alert"], [aria-live="assertive"]');
    nodes.forEach((el) => {
      if (el.closest('[id^="truste"], [id*="trustarc"]')) return;
      if (el.getClientRects().length === 0) return;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && !out.includes(t)) out.push(t);
    });
    document.querySelectorAll('input[aria-invalid="true"]').forEach((input) => {
      (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).forEach((id) => {
        const el = document.getElementById(id);
        const t = el && (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !out.includes(t)) out.push(t);
      });
    });
    return out;
  });
}

/**
 * Mark (data-kax-terms) every visible, unchecked checkbox whose label talks about
 * agreeing to terms, and return how many there are. Covers <label for>, a wrapping
 * <label>, aria-label(ledby), and plain text next to the box.
 */
async function markUncheckedTerms(page) {
  return page.evaluate(() => {
    const RE = /terms|agree|privacy policy/i;
    let n = 0;
    document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach((box) => {
      box.removeAttribute('data-kax-terms');
      const checked = box.matches('input') ? box.checked : box.getAttribute('aria-checked') === 'true';
      if (checked) return;
      const texts = [box.getAttribute('aria-label') || ''];
      (box.getAttribute('aria-labelledby') || '').split(/\s+/).forEach((id) => { const el = id && document.getElementById(id); if (el) texts.push(el.textContent); });
      if (box.id) document.querySelectorAll(`label[for="${CSS.escape(box.id)}"]`).forEach((l) => texts.push(l.textContent));
      if (box.closest('label')) texts.push(box.closest('label').textContent);
      let el = box.parentElement;
      for (let i = 0; el && i < 3; i++, el = el.parentElement) texts.push(el.textContent);
      if (!RE.test(texts.join(' '))) return;
      // A visually hidden native input still counts if its styled wrapper is visible.
      const shown = box.getClientRects().length || (box.parentElement && box.parentElement.getClientRects().length);
      if (!shown) return;
      box.setAttribute('data-kax-terms', '');
      n++;
    });
    return n;
  });
}

/**
 * Tag the visible first/last name inputs with data-kax-field="first"|"last".
 * Uses the input's own label (for=, wrapping label, aria-labelledby, aria-label)
 * and, failing that, the nearest ancestor whose text names exactly one of them.
 */
async function markNameFields(page) {
  return page.evaluate(() => {
    const kinds = { first: /first name|given name/i, last: /last name|family name|surname/i };
    const which = (text) => {
      const hits = Object.keys(kinds).filter((k) => kinds[k].test(text || ''));
      return hits.length === 1 ? hits[0] : null;
    };
    const marked = {};
    document.querySelectorAll('input:not([type]), input[type="text"]').forEach((el) => {
      el.removeAttribute('data-kax-field');
      if (!el.getClientRects().length) return;
      const own = [el.getAttribute('aria-label') || ''];
      if (el.id) document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((l) => own.push(l.textContent));
      if (el.closest('label')) own.push(el.closest('label').textContent);
      (el.getAttribute('aria-labelledby') || '').split(/\s+/).forEach((id) => { const n = id && document.getElementById(id); if (n) own.push(n.textContent); });
      let kind = which(own.join(' '));
      for (let a = el.parentElement, i = 0; !kind && a && i < 4; a = a.parentElement, i++) {
        const t = a.textContent || '';
        if (kinds.first.test(t) && kinds.last.test(t)) break; // container holds both: ambiguous
        kind = which(t);
      }
      if (kind && !marked[kind]) { el.setAttribute('data-kax-field', kind); marked[kind] = true; }
    });
    return marked;
  });
}

/** Labels (never values) of visible required controls that are still empty or unticked. */
async function emptyRequiredFields(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input, select, textarea, [role="checkbox"]').forEach((el) => {
      const required = el.required || el.getAttribute('aria-required') === 'true' || el.getAttribute('aria-invalid') === 'true';
      if (!required) return;
      const isBox = el.type === 'checkbox' || el.getAttribute('role') === 'checkbox';
      const empty = isBox ? !(el.checked || el.getAttribute('aria-checked') === 'true') : !el.value;
      const shown = el.getClientRects().length || (el.parentElement && el.parentElement.getClientRects().length);
      if (!empty || !shown) return;
      const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const byIds = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)[0];
      const label = (byFor || el.closest('label') || byIds || {}).textContent || el.getAttribute('aria-label') || el.placeholder || el.name || el.type || el.tagName;
      out.push(label.replace(/\s+/g, ' ').replace(/\brequired\b/gi, '').trim().slice(0, 60) + (isBox ? ' (checkbox)' : ''));
    });
    return out;
  });
}

async function tickMarkedTerms(page) {
  for (const box of await page.locator('[data-kax-terms]').all()) {
    try { await box.check({ timeout: 3000 }); } catch { await box.check({ force: true }); }
  }
}

/** Pick an option in a Wonder Blocks style combobox (button[role=combobox] + listbox). */
async function pickFromCombobox(page, testId, name) {
  const box = page.locator(`[data-testid="${testId}"]`);
  await box.click();
  const opt = page.getByRole('option', { name, exact: typeof name === 'string' }).first();
  try {
    await opt.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error(`could not find option ${name} in the ${testId} list`);
  }
  await opt.click(); // Playwright scrolls long lists (years) into view first
}

export const VERIFY_PAGE_URL = 'https://www.khanacademy.org/about';

/**
 * Ask Khan Academy who this browser context is signed in as, from inside a real
 * www.khanacademy.org tab: same origin, same cookies, same request the extension
 * makes. The verdict comes from the extension's shared evaluateIdentity rule.
 */
export async function checkIdentity(context, email) {
  let vp = context.__kaxVerifier;
  if (!vp || vp.isClosed()) {
    vp = await context.newPage();
    await vp.goto(VERIFY_PAGE_URL, { waitUntil: 'domcontentloaded' });
    context.__kaxVerifier = vp;
    context.__kaxVerifierAt = Date.now();
  } else if (Date.now() - (context.__kaxVerifierAt || 0) > 10000 && vp.reload) {
    // Reloading makes Khan Academy's page query the signed-in user again (passive proof).
    await vp.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    context.__kaxVerifierAt = Date.now();
  }
  const res = await vp.evaluate(async ({ url, query }) => {
    const m = /(?:^|;\s*)fkey=([^;]+)/.exec(document.cookie);
    const headers = { 'content-type': 'application/json' };
    if (m) headers['x-ka-fkey'] = decodeURIComponent(m[1]);
    const r = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ operationName: 'getFullUserProfile', query, variables: {} }) });
    let body = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, body };
  }, { url: KAX.PROFILE_URL, query: KAX.PROFILE_QUERY });
  return KAX.fetchIdentity(async () => ({ ok: res.ok, status: res.status, json: async () => { if (res.body === null) throw new Error('not JSON'); return res.body; } }), '', email);
}

/**
 * Passive proof: Khan Academy's own pages query the signed-in user through
 * safelisted GraphQL operations. Watch every GraphQL response in the context and
 * apply the extension's findIdentityInGraphQL rule. Returns a getter for the
 * proof, or null if none has been seen.
 */
export function watchProfileResponses(context, email) {
  let best = null;
  context.on('response', async (r) => {
    if (best || !/\/api\/internal\/graphql\//.test(r.url())) return;
    let json;
    try { json = await r.json(); } catch { return; }
    const v = KAX.findIdentityInGraphQL(json, email);
    if (v && !best) best = { ...v, detail: v.detail + ", from Khan Academy's own user query" };
  });
  return () => best;
}

/**
 * Drive the sign-up flow. Returns { outcome: 'created'|'failed'|'unverified', detail, kaid? }.
 * `say` receives progress lines; it is never given the password or the full email.
 */
export async function runOnboarding({ context, email, password, birthYear, firstName, lastName, timeoutMs, agreeTerms = false, onSubmitted = () => {}, failureScreenshot = null, say = () => {}, pollMs = 1000, identityCheck = checkIdentity }) {
  const secrets = [email, password];
  const print = (m) => say(redact(m, secrets));
  const seenIdentity = watchProfileResponses(context, email);
  const page = await context.newPage();
  const deadline = Date.now() + timeoutMs;

  print('Opening Khan Academy sign-up…');
  await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded' });

  // Step 1: "Student – learning on my own" (the adult learner path).
  const student = page.locator('a[href*="/signup/learner"]').first();
  await student.waitFor({ state: 'visible', timeout: 30000 });
  await student.click();

  // Step 2: date of birth, as an adult.
  await page.locator('[data-testid="birthday-picker-month"]').waitFor({ state: 'visible', timeout: 30000 });
  await pickFromCombobox(page, 'birthday-picker-month', JANUARY);
  await pickFromCombobox(page, 'birthday-picker-year', String(birthYear));
  await page.getByRole('button', { name: /^next$/i }).click();
  try {
    await page.waitForURL((u) => !/\/signup\/learner\/birthday/.test(u.pathname), { timeout: 15000 });
  } catch {
    const msgs = await alertTexts(page);
    throw new Error('the birthday step did not advance' + (msgs.length ? ': ' + msgs.join(' | ') : ''));
  }
  print('Entered date of birth January ' + birthYear + '.');

  // Step 3+: whatever Khan Academy asks for next. We fill what we recognise,
  // press its primary button once per distinct step, and let the user finish
  // anything we don't recognise (CAPTCHA, unexpected prompt) in the window.
  const clicked = new Set();
  let submitted = false;
  let identity = null;
  let kaError = null;
  let baseline = await alertTexts(page);
  let announcedCaptcha = false;
  let announcedManual = false;
  let announcedTerms = false;
  let lastIdentity = '';
  let provenAt = 0;
  let emptyFields = [];
  const retries = {};
  const stepSeenAt = {};
  let frontRestored = false;
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    if (!page.isClosed()) {
      const stepKey = page.url().split('?')[0];

      if (await page.locator(CAPTCHA_SEL).first().isVisible().catch(() => false)) {
        if (!announcedCaptcha) { print('A CAPTCHA is showing. Solve it in the browser window; this script will not bypass it.'); announcedCaptcha = true; }
      } else {
        const choice = page.getByRole('button', { name: EMAIL_PATH_RE }).or(page.getByRole('link', { name: EMAIL_PATH_RE })).first();
        if (await choice.isVisible().catch(() => false) && !clicked.has(stepKey + '#email-path')) {
          clicked.add(stepKey + '#email-path');
          await choice.click();
        }
        // Name fields are found by attribute or by their visible label ("First name").
        const names = await markNameFields(page).catch(() => ({}));
        stepSeenAt[stepKey] = stepSeenAt[stepKey] || Date.now();
        const first = page.locator(FIRST_SEL).or(page.locator('[data-kax-field="first"]'));
        const last = page.locator(LAST_SEL).or(page.locator('[data-kax-field="last"]'));
        const filled = (await fillVisibleEmpty(page, first, firstName)) + (await fillVisibleEmpty(page, last, lastName)) +
          (await fillVisibleEmpty(page, EMAIL_SEL, email)) + (await fillVisibleEmpty(page, PASSWORD_SEL, password));
        if (filled) print('Filled ' + filled + ' field' + (filled > 1 ? 's' : '') + ' on ' + new URL(page.url()).pathname + '.');

        // Agreeing to Khan Academy's terms is the user's decision: only tick the box
        // when they passed --agree-terms; otherwise wait for them to tick it.
        let termsPending = (await markUncheckedTerms(page).catch(() => 0)) > 0;
        if (termsPending && agreeTerms) {
          await tickMarkedTerms(page);
          print("Ticked Khan Academy's terms checkbox (you passed --agree-terms).");
          termsPending = (await markUncheckedTerms(page).catch(() => 0)) > 0;
        } else if (termsPending && !announcedTerms) {
          print("Khan Academy needs you to agree to its terms. Tick the box in the browser window (or re-run with --agree-terms); the script submits once it's ticked.");
          announcedTerms = true;
        }

        const hasPassword = await page.locator(PASSWORD_SEL).first().isVisible().catch(() => false);
        const btn = page.getByRole('button', { name: SUBMIT_RE }).first();
        if (hasPassword && !termsPending && !clicked.has(stepKey + '#submit') && await btn.isVisible().catch(() => false) &&
            await btn.isEnabled().catch(() => false) && (await btn.getAttribute('aria-disabled')) !== 'true') {
          clicked.add(stepKey + '#submit');
          baseline = await alertTexts(page);
          await btn.click();
          submitted = true;
          onSubmitted();
          print('Submitted the sign-up form. Waiting for Khan Academy to confirm…');
        }

        // After sign-up Khan Academy may ask for a name on a profile page. Press its
        // button once, after the required name fields are filled.
        const profileBtn = page.getByRole('button', { name: PROFILE_RE }).first();
        if (submitted && !hasPassword && !filled && !clicked.has(stepKey + '#profile') && stepKey === page.url().split('?')[0] &&
            await profileBtn.isVisible().catch(() => false) &&
            await profileBtn.isEnabled().catch(() => false) && (await profileBtn.getAttribute('aria-disabled')) !== 'true' &&
            ((names.first && names.last) || Date.now() - stepSeenAt[stepKey] > 3000) &&
            (await emptyRequiredFields(page).catch(() => ['?'])).length === 0) {
          // Only on a pass that filled nothing new and found nothing required still empty,
          // so a page that is still rendering its fields is never submitted half-done.
          clicked.add(stepKey + '#profile');
          baseline = await alertTexts(page);
          await profileBtn.click();
          print('Filled in the profile step (name) and continued.');
        }
      }

      if (submitted) {
        const fresh = (await alertTexts(page).catch(() => [])).filter((t) => !baseline.includes(t));
        if (fresh.length) {
          const onSignupForm = await page.locator(PASSWORD_SEL).first().isVisible().catch(() => false);
          const empty = await emptyRequiredFields(page).catch(() => []);
          if (failureScreenshot) await page.screenshot({ path: failureScreenshot, fullPage: true }).then(() => print('Saved a screenshot of the form to ' + failureScreenshot), () => {});
          if (onSignupForm) {
            // The sign-up form itself was rejected: no account was created.
            kaError = fresh.join(' | ');
            emptyFields = empty;
            break;
          }
          // A later step (e.g. the profile page) complained. The account already exists,
          // so fill what's missing and try that step again (at most 3 times).
          baseline = await alertTexts(page).catch(() => baseline);
          const key = page.url().split('?')[0] + '#profile';
          retries[key] = (retries[key] || 0) + 1;
          print('Khan Academy said "' + fresh.join(' | ') + '" on ' + new URL(page.url()).pathname + (empty.length ? ' (empty: ' + empty.join(', ') + ')' : '') + (retries[key] <= 3 ? '; filling it in and retrying.' : '; finish this step in the browser window.'));
          if (retries[key] <= 3) clicked.delete(key);
        }
      }
    }

    // Proof, not a URL guess: does Khan Academy say this browser is signed in as `email`?
    // The active check opens a second tab, so wait until our own submit (or a minute,
    // for a step the user finishes by hand) to avoid stealing focus mid-form.
    if (submitted || Date.now() - startedAt > 60000) {
      identity = await identityCheck(context, email).catch((e) => ({ status: 'unverifiable', detail: String(e.message).split('\n')[0] }));
      if (!frontRestored && !page.isClosed()) { await page.bringToFront().catch(() => {}); frontRestored = true; } // the check opened a tab
      const seen = seenIdentity();
      if (seen && identity.status !== 'success' && (seen.status === 'success' || identity.status !== 'mismatch')) identity = seen;
      const summary = identity.status + ': ' + identity.detail;
      if (summary !== lastIdentity) { print('Khan Academy identity check → ' + summary); lastIdentity = summary; }
      if (identity.status === 'mismatch') break;
      if (identity.status === 'success') {
        // Proven. Finish a pending profile step first so the account is fully set up,
        // but give it at most 20 s once the account is confirmed.
        const profileDone = [...clicked].some((k) => k.endsWith('#profile'));
        if (profileDone) break;
        if (!provenAt) {
          provenAt = Date.now();
          // The page may still be loading the profile step; give it a moment to appear.
          const onProfile = !page.isClosed() && await page.getByRole('button', { name: PROFILE_RE }).first()
            .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
          if (!onProfile) break;
        } else if (Date.now() - provenAt > 20000) break;
      }
    }

    if (!announcedManual && Date.now() - startedAt > 30000) {
      print('Still waiting. If the browser shows a step this script did not complete, finish it there; the script keeps checking.');
      announcedManual = true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // An error on screen does not prove the account is missing; check once more.
  if (seenIdentity() && seenIdentity().status === 'success') identity = seenIdentity();
  if (!identity || (identity.status !== 'success' && identity.status !== 'mismatch')) {
    identity = await identityCheck(context, email).catch((e) => ({ status: 'unverifiable', detail: String(e.message) }));
  }
  const result = decideOutcome({ identity, kaError, timedOut: !kaError && Date.now() >= deadline });
  return { ...result, detail: redact(result.detail, secrets), kaid: identity && identity.kaid, emptyFields: emptyFields.map((f) => redact(f, secrets)) };
}
