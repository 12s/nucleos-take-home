/*
 * Minimal toast in a closed shadow root so Khan Academy's CSS can't restyle it
 * and our CSS can't leak into the page. Text is always set with textContent, so
 * an error string from the page is shown word for word and never parsed as HTML.
 */
(function (root) {
  'use strict';
  const COLORS = { success: '#0a7d3b', error: '#b3261e', unknown: '#8a5a00' };
  const TITLES = { success: 'Signed in', error: 'Sign-in failed', unknown: 'Sign-in not confirmed' };

  function showToast(kind, text) {
    const old = document.getElementById('kax-toast-host');
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = 'kax-toast-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.setAttribute('role', kind === 'success' ? 'status' : 'alert');
    box.setAttribute('data-kind', kind);
    box.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647', 'max-width:380px',
      'padding:12px 14px', 'border-radius:8px', 'color:#fff', 'font:14px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.25)', 'background:' + (COLORS[kind] || COLORS.unknown),
    ].join(';');
    const title = document.createElement('strong');
    title.textContent = 'KA auto sign-in: ' + (TITLES[kind] || TITLES.unknown);
    title.style.display = 'block';
    const body = document.createElement('div');
    body.className = 'kax-message';
    body.style.whiteSpace = 'pre-line';
    body.textContent = text;
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'position:absolute;top:4px;right:8px;background:none;border:0;color:#fff;font-size:18px;cursor:pointer';
    close.onclick = () => host.remove();
    box.append(title, body, close);
    shadow.append(box);
    (document.body || document.documentElement).append(host);
    // Tests and the demo read the message back from here (the shadow root is closed).
    host.dataset.kind = kind;
    host.dataset.message = text;
    return host;
  }

  root.KAXToast = { showToast };
})(globalThis);
