import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const K = require('../../extension/shared.js');

const user = (o) => ({ data: { user: { id: 'u', kaid: 'kaid_1', email: 'learner@example.com', username: 'learner1', isPhantom: false, ...o } } });

test('evaluateIdentity: success only for the configured, non-phantom user', () => {
  assert.equal(K.evaluateIdentity(user(), 'learner@example.com').status, 'success');
  assert.equal(K.evaluateIdentity(user(), '  LEARNER@example.com ').status, 'success', 'email match is case/space-insensitive');
  assert.equal(K.evaluateIdentity(user(), 'learner1').status, 'success', 'username also identifies the account');
  assert.equal(K.evaluateIdentity(user(), 'someone@else.com').status, 'mismatch');
});

test('evaluateIdentity: never reports success without proof', () => {
  assert.equal(K.evaluateIdentity({ data: { user: null } }, 'learner@example.com').status, 'not-signed-in');
  assert.equal(K.evaluateIdentity(user({ isPhantom: true }), 'learner@example.com').status, 'not-signed-in');
  for (const bad of [null, 'x', {}, { data: {} }, { errors: [{ message: 'nope' }] }, user({ isPhantom: undefined }), user({ kaid: '' }), { data: { user: 7 } }]) {
    assert.equal(K.evaluateIdentity(bad, 'learner@example.com').status, 'unverifiable', JSON.stringify(bad));
  }
  assert.equal(K.evaluateIdentity(user(), '').status, 'mismatch', 'empty configured username never matches');
});

test('fetchIdentity: sends the GraphQL query with credentials and fkey, maps failures to unverifiable', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => user() }; };
  const r = await K.fetchIdentity(ok, 'a=1; fkey=abc%20d; b=2', 'learner@example.com');
  assert.equal(r.status, 'success');
  assert.equal(seen.url, K.PROFILE_URL);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.credentials, 'include');
  assert.equal(seen.init.headers['x-ka-fkey'], 'abc d');
  assert.match(JSON.parse(seen.init.body).query, /isPhantom/);

  assert.equal((await K.fetchIdentity(async () => { throw new Error('offline'); }, '', 'x')).status, 'unverifiable');
  assert.equal((await K.fetchIdentity(async () => ({ ok: false, status: 403 }), '', 'x')).detail, 'profile request returned HTTP 403');
  assert.equal((await K.fetchIdentity(async () => ({ ok: true, json: async () => { throw new Error(); } }), '', 'x')).status, 'unverifiable');
});

test('validateConfig rejects missing fields without echoing the password', () => {
  assert.deepEqual(K.validateConfig({ username: ' a@b.c ', password: 'p' }), { ok: true, config: { username: 'a@b.c', password: 'p' } });
  assert.equal(K.validateConfig({ username: 'a' }).ok, false);
  assert.equal(K.validateConfig({ password: 'secret' }).ok, false);
  assert.doesNotMatch(K.validateConfig({ password: 'secret' }).error, /secret/);
  assert.equal(K.validateConfig(null).ok, false);
});

test('isLoginUrl: only the Khan Academy login page', () => {
  assert.ok(K.isLoginUrl('https://accounts.khanacademy.org/login'));
  assert.ok(K.isLoginUrl('https://accounts.khanacademy.org/login?continue=%2F'));
  assert.ok(K.isLoginUrl('https://www.khanacademy.org/login/'));
  for (const u of ['https://www.khanacademy.org/', 'https://accounts.khanacademy.org/signup', 'https://accounts.khanacademy.org/loginx',
    'http://accounts.khanacademy.org/login', 'https://evil.com/login', 'https://khanacademy.org.evil.com/login', 'not a url']) {
    assert.equal(K.isLoginUrl(u), false, u);
  }
});

test('collectMessageTexts: reads alerts and invalid-field messages verbatim, ignores cookie banner and hidden/polite text', () => {
  const { document } = new JSDOM(`
    <div id="truste-consent-track" role="alert">Accept All Cookies</div>
    <div aria-live="polite">Logging in…</div>
    <div role="alert" hidden>Hidden thing</div>
    <div role="alert">  Your   password
      is incorrect. </div>
    <input aria-invalid="true" aria-describedby="d1 d2"><div id="d1">Must be at least 8 characters</div><div id="d2"></div>
    <input aria-invalid="false" aria-describedby="d3"><div id="d3">Not an error</div>
    <div role="alert">Your password is incorrect.</div>`).window;
  assert.deepEqual(K.collectMessageTexts(document), ['Your password is incorrect.', 'Must be at least 8 characters']);
});

test('newMessages: only text that appeared after the submit', () => {
  assert.deepEqual(K.newMessages(['a', 'b', 'c'], ['a', 'c']), ['b']);
  assert.deepEqual(K.newMessages(['a'], ['a']), []);
});

test('maskIdentifier never reveals the full identifier', () => {
  assert.equal(K.maskIdentifier('matt+ka@gmail.com'), 'm***@gmail.com');
  assert.equal(K.maskIdentifier('learner1'), 'l***');
  assert.equal(K.maskIdentifier(''), '(empty)');
});

test('findIdentityInGraphQL: finds the configured user anywhere in a response, ignores everyone else', () => {
  const resp = { data: { classroom: { students: [{ kaid: 'o', isPhantom: false, email: 'other@x.com' }] }, viewer: { me: { kaid: 'k1', isPhantom: false, username: 'learner1', email: null } } } };
  const v = K.findIdentityInGraphQL(resp, 'learner1');
  assert.equal(v.status, 'success');
  assert.equal(v.kaid, 'k1');
  assert.equal(K.findIdentityInGraphQL(resp, 'nobody@x.com'), null);
  assert.equal(K.findIdentityInGraphQL({ data: { user: { kaid: 'p', isPhantom: true, email: 'learner1' } } }, 'learner1'), null, 'phantom never counts');
  assert.equal(K.findIdentityInGraphQL({ data: { user: { kaid: 'k', email: 'learner1' } } }, 'learner1'), null, 'needs isPhantom to be present');
  const loop = { data: {} }; loop.data.self = loop;
  assert.equal(K.findIdentityInGraphQL(loop, 'x'), null, 'cycles are safe');
});
