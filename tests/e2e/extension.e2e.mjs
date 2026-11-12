/*
 * End-to-end: load the real unpacked extension into Chromium and point it at
 * the fake Khan Academy (tests/fixtures/fake-ka.mjs). No request leaves the
 * machine: every khanacademy.org URL is answered by the fixture.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createFakeKA, FIXTURE_LOGIN_ERROR, FIXTURE_TAKEN_ERROR } from '../fixtures/fake-ka.mjs';
import { runOnboarding } from '../../onboarding/lib.mjs';

const require = createRequire(import.meta.url);
const KAX = require('../../extension/shared.js');
const EXT_SRC = fileURLToPath(new URL('../../extension/', import.meta.url));
const ACCOUNT = { email: 'learner@fixture.test', password: 'Correct-Horse-9!' };
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

/** Copy the extension, optionally adding config.local.json, and launch Chromium with it. */
async function launch({ localConfig, fake = createFakeKA({ accounts: { [ACCOUNT.email]: ACCOUNT.password } }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kax-ext-'));
  cpSync(EXT_SRC, dir, { recursive: true, filter: (src) => !src.endsWith('config.local.json') });
  if (localConfig) writeFileSync(join(dir, 'config.local.json'), JSON.stringify(localConfig));
  const profile = mkdtempSync(join(tmpdir(), 'kax-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  await fake.install(context);
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  cleanups.push(async () => { await context.close(); rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true }); });
  const page = await context.newPage();
  const readLog = async () => (await sw.evaluate(() => chrome.storage.local.get('kaxLog'))).kaxLog || [];
  return { context, page, fake, sw, readLog };
}

const toast = (page, timeout = 15000) =>
  page.waitForSelector('#kax-toast-host', { state: 'attached', timeout }).then((h) => h.evaluate((el) => ({ kind: el.dataset.kind, message: el.dataset.message })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('wrong credentials (shipped config.json): shows Khan Academy\'s error word for word, logs it, tries once', async () => {
  const { page, fake, readLog } = await launch();
  await page.goto('https://accounts.khanacademy.org/login');
  const t = await toast(page);
  assert.equal(t.kind, 'error');
  assert.equal(t.message, FIXTURE_LOGIN_ERROR);
  await sleep(2500);
  assert.equal(fake.state.loginPosts, 1, 'exactly one attempt per visit');
  const log = await readLog();
  const failed = log.find((l) => l.outcome === 'failed');
  assert.equal(failed.khanAcademyError, FIXTURE_LOGIN_ERROR);
  assert.doesNotMatch(JSON.stringify(log), /deliberately-wrong-password/, 'password never logged');
});

test('a new visit (reload) is a new attempt; still one per visit', async () => {
  const { page, fake } = await launch();
  await page.goto('https://accounts.khanacademy.org/login');
  await toast(page);
  await page.reload();
  await toast(page);
  await sleep(1500);
  assert.equal(fake.state.loginPosts, 2);
});

test('correct credentials (config.local.json): success toast only after Khan Academy confirms the user', async () => {
  const { page, fake, readLog } = await launch({ localConfig: { username: ACCOUNT.email, password: ACCOUNT.password } });
  await page.goto('https://www.khanacademy.org/login');
  await page.waitForURL('https://www.khanacademy.org/');
  const t = await toast(page);
  assert.equal(t.kind, 'success', t.message);
  assert.match(t.message, /kaid_fixture123/);
  assert.equal(fake.state.loginPosts, 1);
  const log = await readLog();
  assert.ok(log.some((l) => l.outcome === 'signed-in' && l.check === 'success'));
  assert.doesNotMatch(JSON.stringify(log), /Correct-Horse-9!|learner@fixture\.test/, 'no password or full email in the log');
});

test('navigation away is not success: a phantom user is reported as not confirmed', async () => {
  const fake = createFakeKA({ accounts: { [ACCOUNT.email]: ACCOUNT.password } });
  fake.state.profileResponse = { data: { user: { id: 'p', kaid: 'kaid_phantom', email: null, username: null, isPhantom: true } } };
  const { page } = await launch({ fake, localConfig: { username: ACCOUNT.email, password: ACCOUNT.password } });
  await page.goto('https://accounts.khanacademy.org/login');
  await page.waitForURL('https://www.khanacademy.org/');
  const t = await toast(page);
  assert.equal(t.kind, 'unknown');
  assert.match(t.message, /not confirmed: .*phantom/);
});

test('signed in as someone else is not success', async () => {
  const fake = createFakeKA({ accounts: { [ACCOUNT.email]: ACCOUNT.password } });
  fake.state.profileResponse = { data: { user: { id: 'o', kaid: 'kaid_other', email: 'other@fixture.test', username: 'other', isPhantom: false } } };
  const { page } = await launch({ fake, localConfig: { username: ACCOUNT.email, password: ACCOUNT.password } });
  await page.goto('https://accounts.khanacademy.org/login');
  await page.waitForURL('https://www.khanacademy.org/');
  assert.equal((await toast(page)).kind, 'unknown');
});

test('bounced back to /login after submitting: reported, not retried (avoids lockouts)', async () => {
  const fake = createFakeKA();
  fake.state.bounceToLogin = true;
  const { page } = await launch({ fake });
  await page.goto('https://accounts.khanacademy.org/login');
  const t = await toast(page);
  assert.equal(t.kind, 'unknown');
  assert.match(t.message, /returned to the login page/);
  await sleep(2000);
  assert.equal(fake.state.loginPosts, 1);
});

test('does nothing on other pages', async () => {
  const { page, fake } = await launch({ localConfig: { username: ACCOUNT.email, password: ACCOUNT.password } });
  for (const url of ['https://www.khanacademy.org/', 'https://www.khanacademy.org/math', 'https://accounts.khanacademy.org/signup']) {
    await page.goto(url);
    await sleep(1200);
    assert.equal(await page.$('#kax-toast-host'), null, url);
  }
  assert.equal(fake.state.loginPosts, 0);
});

test('onboarding script: creates the account and proves it, never prints secrets', async () => {
  const fake = createFakeKA();
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  await fake.install(context);
  const lines = [];
  // context.request bypasses page routes, so answer the identity check from the fixture directly
  // through the same fetchIdentity rule the real script uses.
  const identityCheck = (_ctx, email) => KAX.fetchIdentity(async (url, init) => {
    const r = fake.handle(init.method, url, init.body);
    return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(r.body) };
  }, '', email);
  const result = await runOnboarding({ context, email: 'new@fixture.test', password: 'Gen3rated-Secret!', birthYear: 2000, firstName: 'A', lastName: 'B', agreeTerms: true, timeoutMs: 30000, pollMs: 200, say: (m) => lines.push(m), identityCheck });
  assert.equal(result.outcome, 'created', result.detail);
  assert.equal(result.kaid, 'kaid_fixture123');
  assert.equal(fake.state.signupPosts, 1, 'one account, one submit');
  assert.equal(fake.state.accounts['new@fixture.test'], 'Gen3rated-Secret!');
  assert.doesNotMatch(lines.join('\n') + result.detail, /Gen3rated-Secret!|new@fixture\.test/);
});

test('onboarding script: a Khan Academy error is reported as failure, verbatim', async () => {
  const fake = createFakeKA({ accounts: { 'taken@fixture.test': 'x' } });
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  await fake.install(context);
  const identityCheck = (_ctx, email) => KAX.fetchIdentity(async (url, init) => {
    const r = fake.handle(init.method, url, init.body);
    return { ok: true, status: 200, json: async () => JSON.parse(r.body) };
  }, '', email);
  const result = await runOnboarding({ context, email: 'taken@fixture.test', password: 'Whatever-1!', birthYear: 2000, firstName: 'A', lastName: 'B', agreeTerms: true, timeoutMs: 30000, pollMs: 200, identityCheck });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.detail, FIXTURE_TAKEN_ERROR);
});

test('onboarding script: without --agree-terms it never ticks the terms box or submits', async () => {
  const fake = createFakeKA();
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  await fake.install(context);
  const lines = [];
  const identityCheck = (_ctx, email) => KAX.fetchIdentity(async (url, init) => {
    const r = fake.handle(init.method, url, init.body);
    return { ok: true, status: 200, json: async () => JSON.parse(r.body) };
  }, '', email);
  const result = await runOnboarding({ context, email: 'new@fixture.test', password: 'Whatever-1!', birthYear: 2000, firstName: 'A', lastName: 'B', timeoutMs: 6000, pollMs: 200, say: (m) => lines.push(m), identityCheck });
  assert.equal(fake.state.signupPosts, 0, 'nothing submitted without consent');
  assert.equal(result.outcome, 'unverified');
  assert.ok(lines.some((l) => /agree to its terms/.test(l)), lines.join('\n'));
});
