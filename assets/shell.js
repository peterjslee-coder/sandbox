/* ============================================================
   Sandbox shell — shared behavior for every mini-app.
   ============================================================ */

/* ---- theme ------------------------------------------------ */

const THEME_KEY = 'sandbox.theme';

export const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, val) {
    try { localStorage.setItem(key, val); } catch { /* private mode — in-memory only */ }
  },
};

// Dark is the default. The OS preference does not get a vote unless the
// person has explicitly chosen light here.
export function initTheme(buttonId = 'themeToggle') {
  const saved = store.get(THEME_KEY);
  document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');

  const btn = document.getElementById(buttonId);
  if (!btn) return;

  const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';

  const paint = () => {
    btn.textContent = isDark() ? 'Light' : 'Dark';
    btn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  };

  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set(THEME_KEY, next);
    paint();
  });

  paint();
}

/* ---- service worker (offline / installable) --------------- */

export function registerSW(scopeRelativePath = './sw.js') {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(scopeRelativePath).catch(() => { /* non-fatal */ });
  });
}

/* ---- tiny DOM helper -------------------------------------- */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ---- URL-hash state (share links without a backend) -------- */

export function encodeState(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
