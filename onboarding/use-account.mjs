#!/usr/bin/env node
/*
 * Copy the verified account from secrets/ka-account.json into
 * extension/config.local.json (git-ignored), which the extension prefers over
 * the deliberately wrong extension/config.json. `--remove` deletes it again so
 * the next run uses the wrong example values.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_FILE = join(ROOT, 'secrets', 'ka-account.json');
const LOCAL_CONFIG = join(ROOT, 'extension', 'config.local.json');

if (process.argv.includes('--remove')) {
  rmSync(LOCAL_CONFIG, { force: true });
  console.log('Removed extension/config.local.json; the extension will use the wrong example values in config.json. Reload it in chrome://extensions.');
  process.exit(0);
}
if (!existsSync(ACCOUNT_FILE)) {
  console.error('No secrets/ka-account.json yet. Run `npm run onboard -- --email ...` first, or create extension/config.local.json by hand.');
  process.exit(1);
}
const { email, password } = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'));
writeFileSync(LOCAL_CONFIG, JSON.stringify({ username: email, password }, null, 2) + '\n', { mode: 0o600 });
console.log('Wrote extension/config.local.json. Reload the extension in chrome://extensions, then open the Khan Academy login page.');
