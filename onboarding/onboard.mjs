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
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, generatePassword, runOnboarding, maskIdentifier } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_FILE = join(ROOT, 'secrets', 'ka-account.json');

const USAGE = `Usage: npm run onboard -- --email you@example.com [--birth-year 2000] [--first-name X] [--last-name Y] [--timeout-min 5] [--force]
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
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  let result;
  try {
    result = await runOnboarding({
      context, email: opts.email, password, birthYear: opts.birthYear, firstName: opts.firstName, lastName: opts.lastName,
      timeoutMs: opts.timeoutMin * 60000, say: (m) => console.log('  ' + m),
    });
  } catch (e) {
    result = { outcome: 'unverified', detail: 'script error: ' + e.message.split('\n')[0] };
  } finally {
    await browser.close();
  }

  if (result.outcome === 'created') {
    mkdirSync(dirname(ACCOUNT_FILE), { recursive: true });
    writeFileSync(ACCOUNT_FILE, JSON.stringify({ email: opts.email, password, kaid: result.kaid, verified: true, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    chmodSync(ACCOUNT_FILE, 0o600);
    console.log(`\nACCOUNT CREATED. Verified: Khan Academy reports a signed-in, non-anonymous user with email ${maskIdentifier(opts.email)} (${result.detail}).`);
    console.log('Credentials saved to secrets/ka-account.json (git-ignored). Run `npm run use-account` to give them to the extension.');
    process.exit(0);
  }
  if (result.outcome === 'failed') {
    console.log(`\nACCOUNT NOT CREATED. Khan Academy said: "${result.detail}"`);
    process.exit(1);
  }
  console.log(`\nACCOUNT CREATION NOT CONFIRMED: ${result.detail}. Not claiming success. Check the email inbox or try signing in before re-running.`);
  process.exit(2);
}

main();
