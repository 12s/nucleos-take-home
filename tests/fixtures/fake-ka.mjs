/*
 * A stand-in for Khan Academy, served through Playwright request interception.
 * Every request to *.khanacademy.org made by the test browser is answered here,
 * so tests never touch the real site or a real account.
 *
 * The markup copies the attributes the real login page exposes (ids, data-testid,
 * aria-disabled on the submit button). Error wording is fixture text: the real
 * extension reads whatever Khan Academy renders.
 */
export const FIXTURE_LOGIN_ERROR = 'FIXTURE: Your email/username or password is incorrect.';
export const FIXTURE_TERMS_ERROR = 'FIXTURE: You must agree to the terms to proceed.';
export const FIXTURE_TAKEN_ERROR = 'FIXTURE: An account with this email already exists.';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const LOGIN_PAGE = page('Log in to Khan Academy | Khan Academy', `
<div id="truste-consent-track" role="alert">We use cookies. Accept All Cookies</div>
<main>
  <div id="login-error" role="alert"></div>
  <form id="login-form">
    <label for="username-field">Email or username <span>required</span></label>
    <input id="username-field" type="text" name="username" data-testid="identifier-field" aria-describedby="username-context-label" autocomplete="username">
    <div id="username-context-label"></div>
    <label for="current-password-field">Password <span>required</span></label>
    <input id="current-password-field" type="password" name="current-password" data-testid="password-field" aria-describedby="current-password-description">
    <div id="current-password-description">Must be at least 8 characters</div>
    <button type="submit" data-testid="log-in-submit-button" aria-disabled="true">Log in</button>
  </form>
  <a href="/signup">Sign up today</a>
</main>
<script>
  // The form renders late, like the real React app.
  const form = document.getElementById('login-form');
  const u = document.getElementById('username-field');
  const p = document.getElementById('current-password-field');
  const b = form.querySelector('button');
  const sync = () => b.setAttribute('aria-disabled', u.value && p.value ? 'false' : 'true');
  u.addEventListener('input', sync); p.addEventListener('input', sync);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (b.getAttribute('aria-disabled') === 'true') return;
    const r = await fetch('/fixture/login', { method: 'POST', body: JSON.stringify({ username: u.value, password: p.value }) });
    const j = await r.json();
    if (j.ok) location.href = j.redirect || 'https://www.khanacademy.org/';
    else document.getElementById('login-error').textContent = j.error;
  });
</script>`);

// Like the live page: labels only (no name/autocomplete attributes), an optional
// class code, and a button that finishes the profile.
const PROFILE_PAGE = page('Welcome', `
<h1>Welcome to Khan Academy for learners!</h1>
<label for=":r1:">First name <span>required</span></label><input id=":r1:">
<label for=":r2:">Last name <span>required</span></label><input id=":r2:">
<label for=":r3:">Have a class code? Join here! (Optional)</label><input id=":r3:" placeholder="Eg. G09WP">
<button type="button" id="enter">Enter Khan Academy for learners</button>
<script>
  document.getElementById('enter').onclick = async () => {
    const body = { first: document.getElementById(':r1:').value, last: document.getElementById(':r2:').value, code: document.getElementById(':r3:').value };
    const j = await (await fetch('/fixture/profile', { method: 'POST', body: JSON.stringify(body) })).json();
    if (j.ok) location.href = 'https://www.khanacademy.org/';
  };
</script>`);

// Like the real app, the home page asks for the signed-in user with its own
// (safelisted, GET + hash) query shortly after loading. Half via fetch, half via XHR.
const HOME_PAGE = page('Khan Academy', `<main><h1>Fixture home</h1></main>
<script>
  setTimeout(() => {
    const url = '/api/internal/graphql/getFullUserProfile?hash=1234567&variables=%7B%7D';
    if (Math.random() < 0.5) fetch(url).then((r) => r.json());
    else { const x = new XMLHttpRequest(); x.open('GET', url); x.send(); }
  }, 400);
</script>`);

const SIGNUP_PAGE = page('Sign up', `<a href="/signup/learner/birthday">Student Student learning on my own</a> <a href="/signup/parent">Family</a>`);

const BIRTHDAY_PAGE = page('Sign up', `
<label>Date of birth</label>
<button type="button" role="combobox" aria-label="Month" data-testid="birthday-picker-month" aria-controls="m">Month</button>
<div id="m" role="listbox" hidden>${['Jan', 'Feb', 'Mar'].map((m) => `<div role="option">${m}</div>`).join('')}</div>
<button type="button" role="combobox" aria-label="Year" data-testid="birthday-picker-year" aria-controls="y">Year</button>
<div id="y" role="listbox" hidden>${[2015, 2000, 1990, 1985].map((y) => `<div role="option">${y}</div>`).join('')}</div>
<button type="button" id="next">Next</button>
<script>
  for (const box of document.querySelectorAll('[role=combobox]')) {
    const list = document.getElementById(box.getAttribute('aria-controls'));
    box.onclick = () => { list.hidden = false; };
    list.onclick = (e) => { box.textContent = e.target.textContent; list.hidden = true; };
  }
  document.getElementById('next').onclick = () => {
    const year = Number(document.querySelector('[data-testid=birthday-picker-year]').textContent);
    if (year && new Date().getFullYear() - year >= 18) location.href = '/signup/learner/email';
  };
</script>`);

const EMAIL_PAGE = page('Sign up', `
<div id="signup-error" role="alert"></div>
<form id="f">
  <input type="email" name="email"><input type="password" name="password">
  <!-- Visually hidden native input with a styled box, like Wonder Blocks. -->
  <div class="terms"><input type="checkbox" id="tos" name="tos" style="position:absolute;opacity:0;width:1px;height:1px">
    <span>I agree to the Khan Academy <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a></span></div>
  <button type="submit">Sign up</button>
</form>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const j = await (await fetch('/fixture/signup', { method: 'POST', body: JSON.stringify(fd) })).json();
    if (j.ok) location.href = 'https://www.khanacademy.org/signup/learner/profile';
    else document.getElementById('signup-error').textContent = j.error;
  });
</script>`);

export function createFakeKA({ accounts = {} } = {}) {
  const state = {
    accounts: { ...accounts },       // email -> password
    session: null,                   // email of the signed-in user, or null
    loginPosts: 0,
    signupPosts: 0,
    profile: null,                   // { first, last, code } once the profile step is done
    forbidAdHocQuery: false,         // answer our own POSTed query with 403, like the live site
    profileResponse: null,           // override getFullUserProfile JSON for a test
    bounceToLogin: false,            // simulate a submit that lands back on /login with no message
  };

  function profileJson() {
    if (state.profileResponse) return state.profileResponse;
    if (!state.session) return { data: { user: null } };
    return { data: { user: { id: 'u1', kaid: 'kaid_fixture123', email: state.session, username: '', isPhantom: false } } };
  }

  /** Pure handler: (method, url, body) -> { status, contentType, body }. */
  function handle(method, url, body) {
    const u = new URL(url);
    const json = (obj, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    const html = (s) => ({ status: 200, contentType: 'text/html', body: s });
    if (u.pathname === '/api/internal/graphql/getFullUserProfile' && method === 'POST') {
      return state.forbidAdHocQuery ? { status: 403, contentType: 'text/plain', body: 'Forbidden' } : json(profileJson());
    }
    if (u.pathname === '/api/internal/graphql/getFullUserProfile' && method === 'GET') {
      const user = profileJson().data && profileJson().data.user;
      return json({ data: { user: user && { ...user, __typename: 'User' } } });
    }
    if (u.pathname === '/fixture/login' && method === 'POST') {
      state.loginPosts++;
      if (state.bounceToLogin) return json({ ok: true, redirect: 'https://accounts.khanacademy.org/login' });
      const { username, password } = JSON.parse(body || '{}');
      if (state.accounts[username] && state.accounts[username] === password) { state.session = username; return json({ ok: true }); }
      return json({ ok: false, error: FIXTURE_LOGIN_ERROR });
    }
    if (u.pathname === '/fixture/signup' && method === 'POST') {
      state.signupPosts++;
      const { email, password, tos } = JSON.parse(body || '{}');
      if (tos !== 'on') return json({ ok: false, error: FIXTURE_TERMS_ERROR });
      if (state.accounts[email]) return json({ ok: false, error: FIXTURE_TAKEN_ERROR });
      state.accounts[email] = password;
      state.session = email;
      state.profile = null;
      return json({ ok: true });
    }
    if (u.pathname === '/fixture/profile' && method === 'POST') {
      const p = JSON.parse(body || '{}');
      if (!p.first || !p.last) return json({ ok: false });
      state.profile = p;
      return json({ ok: true });
    }
    if (u.pathname === '/signup/learner/profile') return html(PROFILE_PAGE);
    if (/^\/login\/?$/.test(u.pathname)) return html(LOGIN_PAGE);
    if (u.pathname === '/signup') return html(SIGNUP_PAGE);
    if (u.pathname === '/signup/learner/birthday') return html(BIRTHDAY_PAGE);
    if (u.pathname === '/signup/learner/email') return html(EMAIL_PAGE);
    if (u.hostname === 'www.khanacademy.org') return html(HOME_PAGE);
    return { status: 404, contentType: 'text/plain', body: 'not in fixture' };
  }

  /** Answer every khanacademy.org request in this Playwright context from the fixture. */
  async function install(context) {
    await context.route(/^https:\/\/([a-z]+\.)?khanacademy\.org\//, async (route) => {
      const req = route.request();
      const r = handle(req.method(), req.url(), req.postData());
      await route.fulfill({ status: r.status, contentType: r.contentType, body: r.body });
    });
  }

  return { state, handle, install, profileJson };
}
