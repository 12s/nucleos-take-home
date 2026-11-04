import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePassword, parseArgs, decideOutcome, redact, checkIdentity } from '../../onboarding/lib.mjs';

test('generatePassword: long, varied, random', () => {
  const a = generatePassword();
  assert.equal(a.length, 20);
  assert.match(a, /[a-z]/); assert.match(a, /[A-Z]/); assert.match(a, /[0-9]/); assert.match(a, /[^A-Za-z0-9]/);
  assert.notEqual(a, generatePassword());
});

test('parseArgs: requires an email and an adult birth year', () => {
  assert.equal(parseArgs(['--email', 'a@b.co']).email, 'a@b.co');
  assert.equal(parseArgs([], { KA_EMAIL: 'env@b.co' }).email, 'env@b.co');
  assert.throws(() => parseArgs([]), /--email/);
  assert.throws(() => parseArgs(['--email', 'nope']), /--email/);
  assert.throws(() => parseArgs(['--email', 'a@b.co', '--birth-year', String(new Date().getFullYear() - 10)]), /adult/);
  assert.throws(() => parseArgs(['--email', 'a@b.co', '--bogus']), /unknown/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('decideOutcome: "created" only with proof from Khan Academy', () => {
  assert.equal(decideOutcome({ identity: { status: 'success', detail: 'kaid x' } }).outcome, 'created');
  assert.equal(decideOutcome({ identity: { status: 'success', detail: '' }, kaError: 'stale msg' }).outcome, 'created', 'proof beats a stale message');
  assert.equal(decideOutcome({ kaError: 'Email taken' }).outcome, 'failed');
  assert.equal(decideOutcome({ kaError: 'Email taken' }).detail, 'Email taken');
  assert.equal(decideOutcome({ identity: { status: 'mismatch', detail: 'other' } }).outcome, 'unverified');
  assert.equal(decideOutcome({ identity: { status: 'not-signed-in', detail: 'no user' }, timedOut: true }).outcome, 'unverified');
  assert.equal(decideOutcome({ identity: { status: 'unverifiable', detail: 'HTTP 403' } }).outcome, 'unverified');
  assert.equal(decideOutcome({}).outcome, 'unverified');
});

test('redact removes every occurrence of every secret', () => {
  assert.equal(redact('a@b.co / pw / a@b.co', ['a@b.co', 'pw']), '[redacted] / [redacted] / [redacted]');
  assert.equal(redact('nothing', ['', null]), 'nothing');
});

test('checkIdentity uses the browser context cookie jar and the shared rule', async () => {
  let posted;
  const context = {
    cookies: async () => [{ name: 'fkey', value: 'F1' }, { name: 'KAAS', value: 's' }],
    request: { post: async (url, opts) => { posted = { url, opts }; return { ok: () => true, status: () => 200, json: async () => ({ data: { user: { kaid: 'k', email: 'a@b.co', isPhantom: false } } }) }; } },
  };
  const r = await checkIdentity(context, 'a@b.co');
  assert.equal(r.status, 'success');
  assert.equal(posted.opts.headers['x-ka-fkey'], 'F1');
});

test('committed config.json is a deliberately wrong example, and real-credential files are git-ignored', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../extension/config.json', import.meta.url)));
  assert.match(cfg.username, /@example\.com$/, 'example.com is reserved, so this can never be a real account');
  const ignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^secrets\/$/m);
  assert.match(ignore, /^extension\/config\.local\.json$/m);
});
