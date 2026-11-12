# Nucleos SSE take-home: Khan Academy onboarding + auto sign-in

Two pieces, both built so they only claim a result they can prove:

1. **`onboarding/`**: a Node + Playwright script that walks Khan Academy's adult-learner sign-up in a visible browser, then checks with Khan Academy's API that the new account exists before saying so.
2. **`extension/`**: a Manifest V3 Chrome extension. When you open the Khan Academy login page it fills the form once and submits it. If Khan Academy shows an error, the extension puts that exact text in a toast. If the login works, it confirms with Khan Academy who is signed in before showing a success toast.

**Recording (≤ 4 min):** _ADD LINK_ (onboarding run, then the wrong-credentials run with the error toast, then the corrected run with the success toast)

Download page: https://nucleos.mattdevoss.dev (extension zip + source zip)

---

## Quick start

Requires Node 20+ and Chrome.

```bash
npm run setup          # npm install + Playwright's Chromium
npm test               # unit + end-to-end tests (offline; see "Tests")
```

### 1. Run the onboarding script

```bash
npm run onboard -- --email you+nucleos@example.com --agree-terms
```

| Option                         | Default                    | Notes                                                                                                                                                                                                                                                                   |
| ------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--email` (or `KA_EMAIL`)      | required                   | Use an inbox you control. A `+tag` alias works well.                                                                                                                                                                                                                    |
| `KA_PASSWORD` env              | generated                  | 20 random characters from `crypto.randomInt` unless you set one.                                                                                                                                                                                                        |
| `--birth-year`                 | `2000` (born January 2000) | Must make the learner 18+ (the brief asks for an adult learner).                                                                                                                                                                                                        |
| `--first-name` / `--last-name` | `Nucleos` / `Learner`      | Filled only if Khan Academy asks for them.                                                                                                                                                                                                                              |
| `--agree-terms`                | off                        | Ticks Khan Academy's "I agree to the Terms of Service" box for you. Without it, the script waits for you to tick the box in the window, and it never submits until the box is ticked. Agreeing to the terms is your decision, so the script doesn't make it by default. |
| `--timeout-min`                | `5`                        | How long to wait for proof.                                                                                                                                                                                                                                             |
| `--force`                      | off                        | Allows a second sign-up after one was already verified. Use it only if the first account is gone.                                                                                                                                                                       |

What it does: it opens Chromium in a visible window, then goes **Sign up → Student → date of birth → email/password form → submit**. Then it polls Khan Academy for the signed-in user until it gets proof or hits the timeout. If a CAPTCHA or a step it doesn't recognise shows up, it says so and waits for you to finish that step in the window. It never tries to solve or bypass a CAPTCHA.

Exit codes: `0` = account created and verified, `1` = Khan Academy showed an error (printed word for word), `2` = not confirmed (it won't claim success).

The new credentials are written **only** to `secrets/ka-account.json` (git-ignored, mode 600). They're written the moment the sign-up form is submitted, marked `"verified": false`, and flipped to `true` once Khan Academy proves the account exists. Ctrl+C at any point leaves them on disk. A file from an earlier run is renamed to `ka-account.<time>.json` rather than overwritten, and the file is deleted again if Khan Academy rejects the sign-up. In that case the script also lists any required fields that were still empty (labels only) and saves a screenshot to `secrets/last-failure.png`. They never go to stdout. Every progress line goes through `redact()`, which strips the email and password. The script also refuses to run a second time once an account has been verified, so it can't create a batch of accounts.

### 2. Load the extension ("Load unpacked")

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension/` folder. (Or unzip `khan-academy-auto-signin-extension.zip` from the download page and choose that folder.)
3. Open https://www.khanacademy.org/login. Do this in a profile or incognito window where you're signed out. For incognito, first click **Details → Allow in Incognito** on the extension.

### 3. Set the credentials

The extension reads credentials from a JSON file inside its own folder. Two files, first match wins:

| File                          | Committed?           | Contents                                                                                               |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `extension/config.local.json` | **no** (git-ignored) | your real account                                                                                      |
| `extension/config.json`       | yes                  | deliberately wrong example values (`@example.com`, a reserved domain that can never be a real account) |

- **First run (should fail):** don't create `config.local.json`. The extension submits the example values, and the toast shows Khan Academy's error word for word.
- **Corrected run:** `npm run use-account` copies the verified account from `secrets/ka-account.json` into `extension/config.local.json`. You can also write it by hand as `{"username": "...", "password": "..."}`. Then click **reload** on the extension in `chrome://extensions` and open the login page again.
- `npm run use-example-config` deletes `config.local.json` so the next run uses the wrong values again.

Logs: every attempt is logged with `console.log` in the page and in the service worker (`chrome://extensions → Inspect views: service worker`). The last 100 entries also go to `chrome.storage.local` under `kaxLog`. Log entries hold a masked identifier (`m***@gmail.com`), the outcome, and Khan Academy's error text. They never hold the password.

---

## How I know an account was created

The script never decides from a URL change or a "welcome" screen. It decides from Khan Academy's own answer to "who is signed in in this browser?":

- `POST https://www.khanacademy.org/api/internal/graphql/getFullUserProfile` with `query getFullUserProfile { user { id kaid email username isPhantom } }`. This is the same operation, cut down to the fields I need, that the khanacademy.org web app ships in its JavaScript bundle. The script sends it from inside a www.khanacademy.org tab in the same browser, so it's a same-origin request that carries exactly the session the sign-up just created. It's the same request the extension makes.
- The script also watches the `getFullUserProfile` responses that Khan Academy's own pages request, and applies the same rule to them. That way the proof doesn't depend on Khan Academy accepting our query text.
- The result counts as **created** only if Khan Academy returns a user that has a `kaid` and `isPhantom === false` (phantom users are KA's anonymous visitors), and whose `email` (or `username`) equals the email we signed up with.
- Getting no user, a phantom user, a different user, or a response that isn't shaped as expected (an error, HTTP failure, missing fields) means **not confirmed**, and the script exits 2. An error shown in a sign-up alert means **failed**, exit 1. Even then, the script checks the API once more first, because an alert doesn't prove the account is missing.

All of this goes through `decideOutcome()` in `onboarding/lib.mjs` and `evaluateIdentity()` in `extension/shared.js`. The script and the extension use the same `evaluateIdentity`, so they apply the same rule.

## How I know a sign-in succeeded

Same idea, split across a page navigation:

1. On the login page (`login.js`), the extension waits for the form (`data-testid="identifier-field"`, `"password-field"`, `"log-in-submit-button"`). It fills the fields so React registers the change and waits until Khan Academy enables the button. Then it **tells the service worker "submitted" before clicking**, because a successful login navigates away and the script stops running.
2. Before clicking, it records a baseline of the messages already on the page. After clicking, any **new** text in `role="alert"`, `aria-live="assertive"`, or the description of a field Khan Academy marks `aria-invalid="true"` is Khan Academy's error. That text goes into the toast word for word through `textContent`, never as HTML. The cookie banner's alert regions are ignored.
3. If the page navigates to www.khanacademy.org, `landing.js` asks the service worker whether this tab submitted in the last 60 s. If it did, it looks for proof from Khan Academy itself, in two ways:
   - **Khan Academy's own user queries (the proof that works on the live site).** On www.khanacademy.org, `page-hook.js` runs in the page's own JavaScript world from `document_start` and passes each GraphQL response Khan Academy's app receives to `landing.js`, without changing anything. `findIdentityInGraphQL` looks in those responses for a user object (`kaid` plus `isPhantom`) whose email or username matches the configured one.
   - **Our own `getFullUserProfile` request.** It's same-origin with the session cookie. On the live site Khan Academy refuses it with **HTTP 403**, because it only accepts its own safelisted queries. That's why the first method exists. Where it works, it's accepted too.

   **Success** means one of them returned a non-phantom user matching the configured account within 15 s. A user who isn't you (a page can show other people) or no answer at all ends in an amber "not confirmed" toast that gives the reason, including our own check's result.
4. If there's no error and no navigation within 20 s, the extension says so. It doesn't guess.

## Main design decisions

- **The service worker owns the credentials.** Only `background.js` reads `config*.json`. The config isn't in `web_accessible_resources`, so the page can't fetch it. The login content script gets the credentials over `chrome.runtime` messaging only when the login page loads, writes them into the two fields, and drops its reference.
- **Per-tab state in `chrome.storage.session`.** It's in memory only, never synced, and cleared when the browser closes. It's keyed by `sender.tab.id`, so two tabs can't confuse each other, and it's removed when the tab closes (`tabs.onRemoved` doesn't need the `tabs` permission).
- **One attempt per visit.** Each document load of the login page runs at most one attempt, guarded by a flag in the content script's world. Khan Academy re-rendering the form in the same visit doesn't trigger a retry. A reload or a new visit does. If Khan Academy sends the tab straight back to `/login` after a submit with no message, the extension **reports that and does not resubmit**. A redirect loop with bad credentials would otherwise lock the account.
- **Wrong example credentials use `example.com`.** The failing demo can't count failed attempts against any real account, including mine.
- **Three outcomes, not two.** Success, failure (with Khan Academy's text), and "not confirmed" (with the reason). The brief says never to report an outcome you can't prove. So anything short of proof is reported as unproven, not as success.
- **Selectors.** Stable `data-testid`s first, then ids and names, then generic form controls. The login-page selectors come from the live page's DOM. I read it, but I didn't submit anything while building this.
- **The script drives what it recognises and hands the rest to you.** The sign-up flow is a multi-step React app, and Khan Academy can add steps (a CAPTCHA, a terms prompt). The script fills what it recognises, clicks each step's primary button once, and otherwise waits for you, because the proof check doesn't care how the form got submitted.
- **The script and extension share one verdict function, and the script takes a BrowserContext.** That's what lets the tests run the real code paths against a fake Khan Academy.

## Permissions

| Permission                                                                                        | Why                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                                                                                         | `chrome.storage.session` keeps the per-tab attempt state across the login → www.khanacademy.org navigation. `chrome.storage.local` keeps the attempt log.                            |
| content script on `https://accounts.khanacademy.org/login*`, `https://www.khanacademy.org/login*` | The login page, the only page where the extension acts. (`www…/login` redirects to `accounts…/login`. Both are listed so the script runs whichever one serves the form.)             |
| content scripts on `https://www.khanacademy.org/*` (except `/login*`): `landing.js`, and `page-hook.js` in the page's MAIN world | Where Khan Academy lands you after login. `page-hook.js` only reads the responses Khan Academy's own GraphQL requests receive and passes them to `landing.js` with `postMessage`. It never changes a request or sends data anywhere. `landing.js` ignores those messages unless this tab submitted the form in the last minute. A MAIN-world content script needs no extra permission (Chrome 111+). |

Not requested: `host_permissions`, `tabs`, `scripting`, `cookies`, `webRequest`, `activeTab`, `web_accessible_resources`. Every network request the extension makes is a same-origin request from a Khan Academy page.

## Tests

```bash
npm run test:unit   # node:test + jsdom, ~0.2 s
npm run test:e2e    # Playwright loads the real unpacked extension in Chromium, ~30 s
```

The end-to-end tests run against **`tests/fixtures/fake-ka.mjs`**, a stand-in Khan Academy served through Playwright request interception. Every request to `*.khanacademy.org` from the test browser is answered locally, so the tests never touch the real site or a real account. The fake login page copies the real page's attributes (ids, `data-testid`s, the `aria-disabled` submit button, a cookie banner with `role="alert"`). Its error wording is marked `FIXTURE:` so it can't pass for Khan Academy's real message.

What's covered, in the order it matters:

- **The proof rule** (`evaluateIdentity`, `decideOutcome`): it reports success only for the matching non-phantom user, and every malformed or ambiguous response comes back as unverifiable.
- **Wrong credentials**: the toast shows the fixture error word for word, exactly one POST is made, the failure is logged, and no password appears in the log.
- **Correct credentials**: the success toast appears only after the identity check, with exactly one POST and no secrets in the log.
- **Navigation isn't proof**: a phantom user or a different signed-in user gets "not confirmed", never success.
- **Lockout safety**: one attempt per visit. A bounce back to `/login` is reported and not retried.
- **The extension stays quiet elsewhere**: on the home page, a subject page, or the sign-up page it doesn't fill, submit, or show a toast.
- **The onboarding script** runs end to end against the fake sign-up flow (Student → birthday picker → email form). It creates exactly one account, proves it, and never prints the email or password. A "taken email" error is reported verbatim as failure.
- **Error extraction** (jsdom): it reads alerts and invalid-field messages, and ignores the cookie banner, hidden nodes, and polite status text.
- **Repo hygiene**: the committed `config.json` uses `@example.com`, and `secrets/` and `config.local.json` are git-ignored.

## Known limitations

- **Proof depends on Khan Academy's internal GraphQL.** On the live site, our own `getFullUserProfile` query gets HTTP 403, so sign-in is proven from the user object in Khan Academy's own query responses. If Khan Academy stops returning `kaid`/`isPhantom` with the user's email or username, both pieces report **not confirmed** rather than a false success.
- **`postMessage` from the page hook can be spoofed by other scripts on khanacademy.org.** Those are scripts Khan Academy itself chose to load, so that's an acceptable trust boundary here. A hardened version would check the service worker's own view instead, e.g. with `chrome.cookies` plus a server call it makes itself.
- **The steps after the birthday picker weren't observable without submitting a real sign-up**, so the script finds those fields generically (email/password/name inputs, a "Sign up / Continue" button). If Khan Academy's flow changes, the script waits and tells you to finish the step by hand. Proof still decides the result.
- **The error-text detection assumes** Khan Academy announces login errors the accessible way (an alert/live region, or `aria-invalid` plus a description). If it ever shows an error only as plain styled text, the extension waits 20 s and reports "not confirmed" instead of the text.
- **The success check runs only on www.khanacademy.org.** If Khan Academy ever lands a fresh login on another host, the attempt expires after 60 s with no toast.
- **Credentials are stored as plain JSON** inside the unpacked extension folder, as the brief asks. That's fine for a dev tool, not for real users (see below).
- Chrome only. There's no automated test against the live site, by design: it would create accounts and make login attempts on every CI run.

## What I'd do next with more time

- Add the second, independent success verifier mentioned above, and a **canary job** that runs one real login a day with a dedicated test account. That would catch Khan Academy DOM or API changes before users hit them.
- Replace the config file with an **options page** that stores credentials in `chrome.storage.local` (or uses Chrome's password manager / a managed policy for fleet deployment). Add a popup that shows `kaxLog`.
- **Lockout protection across visits**: count consecutive failures per account and stop auto-submitting after N, with a "try again" button in the toast.
- Localisation: Khan Academy's error text is already passed through untouched, but the toast titles are English only.
- Package with a fixed extension key, and add a release workflow (CI running `npm test` and building the zip).

## Use of AI tools

- **Claude Code (Claude Opus 5.5)**: I used it to scaffold the project and write most of the first draft of the code, tests, fixture, and this README. I also used it to check the live login and sign-up pages' DOM structure: it read the pages headlessly and submitted nothing. That's where the `data-testid` selectors came from. It also found the `getFullUserProfile` query in Khan Academy's public JS bundle.
- **Me**: I made the design calls (the proof-based verdict, the three outcomes, the lockout guard, the permission set). I reviewed every file and ran the real sign-up and sign-in against Khan Academy for the recording. Claude didn't create accounts or enter credentials on the real site.

## Layout

```
extension/   manifest.json, background.js (service worker), login.js, landing.js, page-hook.js, toast.js, shared.js, config.json
onboarding/  onboard.mjs (CLI), lib.mjs (flow + verdict), use-account.mjs
tests/       unit/ (node:test + jsdom), e2e/ (Playwright + unpacked extension), fixtures/fake-ka.mjs
```
