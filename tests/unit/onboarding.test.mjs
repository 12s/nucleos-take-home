import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePassword, parseArgs, decideOutcome, redact, checkIdentity, watchProfileResponses } from '../../onboarding/lib.mjs';

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
  assert.equal(parseArgs(['--email', 'a@b.co']).agreeTerms, false, 'terms are never agreed by default');
  assert.equal(parseArgs(['--email', 'a@b.co', '--agree-terms']).agreeTerms, true);
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

test('checkIdentity asks from a real www.khanacademy.org tab and applies the shared rule', async () => {
  const visited = [];
  let evaluated = 0;
  const page = {
    isClosed: () => false,
    goto: async (u) => { visited.push(u); },
    evaluate: async (_fn, arg) => { evaluated++; assert.match(arg.query, /isPhantom/); return { ok: true, status: 200, body: { data: { user: { kaid: 'k', email: 'a@b.co', isPhantom: false } } } }; },
  };
  const context = { newPage: async () => page };
  assert.equal((await checkIdentity(context, 'a@b.co')).status, 'success');
  assert.equal((await checkIdentity(context, 'a@b.co')).status, 'success');
  assert.deepEqual(visited, ['https://www.khanacademy.org/about'], 'one verifier tab, reused');
  assert.equal(evaluated, 2);

  const bad = { newPage: async () => ({ ...page, evaluate: async () => ({ ok: false, status: 403, body: null }) }) };
  assert.equal((await checkIdentity(bad, 'a@b.co')).detail, 'profile request returned HTTP 403');
});

test("watchProfileResponses: Khan Academy's own GraphQL user objects count as proof", async () => {
  const listeners = [];
  const context = { on: (ev, fn) => { assert.equal(ev, 'response'); listeners.push(fn); } };
  const best = watchProfileResponses(context, 'a@b.co');
  const emit = (url, json) => Promise.all(listeners.map((fn) => fn({ url: () => url, json: async () => json })));
  await emit('https://www.khanacademy.org/some/page.json', { data: { user: { kaid: 'k', email: 'a@b.co', isPhantom: false } } });
  assert.equal(best(), null, 'non-GraphQL responses are ignored');
  await emit('https://www.khanacademy.org/api/internal/graphql/otherQuery', { data: { user: { kaid: 'x', email: 'other@b.co', isPhantom: false } } });
  assert.equal(best(), null, 'another person on the page proves nothing');
  await emit('https://www.khanacademy.org/api/internal/graphql/getFullUserProfile?hash=1', { data: { user: null } });
  assert.equal(best(), null, 'not-signed-in is not remembered');
  await emit('https://www.khanacademy.org/api/internal/graphql/getFullUserProfile?hash=1', { data: { user: { kaid: 'k9', email: 'A@b.co', isPhantom: false } } });
  assert.equal(best().status, 'success');
  assert.match(best().detail, /kaid k9, from Khan Academy.s own user query/);
});

test('committed config.json is a deliberately wrong example, and real-credential files are git-ignored', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../extension/config.json', import.meta.url)));
  assert.match(cfg.username, /@example\.com$/, 'example.com is reserved, so this can never be a real account');
  const ignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^secrets\/$/m);
  assert.match(ignore, /^extension\/config\.local\.json$/m);
});
