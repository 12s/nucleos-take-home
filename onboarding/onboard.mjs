#!/usr/bin/env node
/*
 * CLI: npm run onboard -- --email you+nucleos@example.com
 *
 * Opens a visible Chromium window, walks Khan Academy's learner sign-up, and
 * exits 0 only if Khan Academy confirms a signed-in, non-anonymous account with
 * that email. Credentials are written to secrets/ka-account.json (git-ignored,
 * mode 600) and are never printed.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, generatePassword, runOnboarding, maskIdentifier } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_FILE = join(ROOT, 'secrets', 'ka-account.json');

const USAGE = `Usage: npm run onboard -- --email you@example.com [--birth-year 2000] [--first-name X] [--last-name Y] [--timeout-min 5] [--agree-terms] [--force]
  KA_EMAIL / KA_PASSWORD env vars may be used instead of --email / a generated password.`;

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2), process.env); } catch (e) { console.error(e.message + '\n' + USAGE); process.exit(64); }
  if (opts.help) { console.log(USAGE); return; }

  // One account only: refuse to sign up again once one was proven to exist.
  if (existsSync(ACCOUNT_FILE) && !opts.force) {
    const prev = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'));
    if (prev.verified) {
      console.log(`An account was already created and verified on ${prev.createdAt} (${maskIdentifier(prev.email)}). Not creating another. Use --force only if that account is gone.`);
      process.exit(0);
    }
  }

  const password = process.env.KA_PASSWORD || generatePassword();

  // Credentials are written as soon as the sign-up form is submitted (the account
  // may exist from that moment on), marked unverified until Khan Academy proves it.
  // A file from an earlier run is kept as secrets/ka-account.<time>.json, never overwritten.
  let savedThisRun = false;
  const save = (verified, kaid = null) => {
    mkdirSync(dirname(ACCOUNT_FILE), { recursive: true });
    if (!savedThisRun && existsSync(ACCOUNT_FILE)) {
      renameSync(ACCOUNT_FILE, ACCOUNT_FILE.replace(/\.json$/, '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'));
    }
    writeFileSync(ACCOUNT_FILE, JSON.stringify({ email: opts.email, password, kaid, verified, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    chmodSync(ACCOUNT_FILE, 0o600);
    savedThisRun = true;
  };

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  // Ctrl+C: the credentials are already on disk if the form was submitted.
  process.once('SIGINT', async () => {
    console.log('\nStopped. ' + (savedThisRun ? 'Credentials are in secrets/ka-account.json (unverified).' : 'Nothing was submitted.'));
    await browser.close().catch(() => {});
    process.exit(130);
  });

  let result;
  try {
    result = await runOnboarding({
      context, email: opts.email, password, birthYear: opts.birthYear, firstName: opts.firstName, lastName: opts.lastName, agreeTerms: opts.agreeTerms,
      timeoutMs: opts.timeoutMin * 60000, say: (m) => console.log('  ' + m),
      failureScreenshot: join(ROOT, 'secrets', 'last-failure.png'),
      onSubmitted: () => { save(false); console.log('  Saved the credentials to secrets/ka-account.json (unverified until Khan Academy confirms).'); },
    });
  } catch (e) {
    result = { outcome: 'unverified', detail: 'script error: ' + e.message.split('\n')[0] };
  } finally {
    await browser.close();
  }

  if (result.outcome === 'created') {
    save(true, result.kaid || null);
    console.log(`\nACCOUNT CREATED. Verified: Khan Academy reports a signed-in, non-anonymous user with email ${maskIdentifier(opts.email)} (${result.detail}).`);
    console.log('Credentials saved to secrets/ka-account.json (git-ignored). Run `npm run use-account` to give them to the extension.');
    process.exit(0);
  }
  if (result.outcome === 'failed') {
    // Khan Academy rejected the sign-up form itself. Keep the credentials anyway (renamed),
    // never delete them: a mistaken verdict must not lose the password to a real account.
    if (savedThisRun) renameSync(ACCOUNT_FILE, ACCOUNT_FILE.replace(/\.json$/, '.rejected.' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'));
    console.log(`\nACCOUNT NOT CREATED. Khan Academy said: "${result.detail}"`);
    if (result.emptyFields && result.emptyFields.length) console.log('Required fields that were still empty: ' + result.emptyFields.join(', '));
    process.exit(1);
  }
  console.log(`\nACCOUNT CREATION NOT CONFIRMED: ${result.detail}. Not claiming success.`);
  console.log(savedThisRun
    ? 'The credentials are in secrets/ka-account.json (git-ignored, marked unverified) in case the account does exist.'
    : 'The sign-up form was never submitted, so no account was created.');
  process.exit(2);
}

main();
