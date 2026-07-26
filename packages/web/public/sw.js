/*
 * Tempra service worker.
 *
 * Offline is not a nicety here. The app is used at 3am, half awake, sometimes on
 * a phone with no signal. The shell must open every single time.
 *
 * Strategy:
 *   - navigations      -> network first, fall back to the cached shell
 *   - static assets    -> cache first, refreshed quietly in the background
 *   - /api and /hooks  -> never touched; the app's own outbox owns offline writes
 *
 * The SW deliberately does not cache API responses. The app already keeps its own
 * snapshot in localStorage, and a second, invisible cache would let the two
 * disagree — which at 3am looks like lost data.
 */

// Bumped when cached assets change identity rather than name. The icons are
// unhashed, so an old install would otherwise keep serving the previous mark.
const VERSION = 'tempra-v2';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/icon-180.png',
  '/favicon.svg',
  '/favicon.ico',
];

/** Assets are content-hashed by Vite, so their names are only knowable from the shell. */
async function precacheShellAssets(shell, assets) {
  const response = await fetch('/', { cache: 'reload' });
  if (!response.ok) return;
  await shell.put('/', response.clone());

  const html = await response.text();
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    if (match[1]) urls.add(match[1]);
  }

  // The very first load happens before this worker controls the page, so nothing
  // would otherwise be in the runtime cache when the phone next goes dark. These
  // go into the ASSETS cache because that is where cacheFirstAsset looks.
  const store = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      await assets.put(url, res.clone());
      return res;
    } catch {
      return null;
    }
  };

  const stored = await Promise.all([...urls].map(store));

  // Fonts are referenced from inside the CSS, not the HTML. Missing them would
  // leave the app readable but wearing the wrong typeface exactly when it is
  // offline — so follow one level of url() references.
  const nested = new Set();
  await Promise.all(
    stored.map(async (res) => {
      if (!res || !/text\/css/.test(res.headers.get('content-type') ?? '')) return;
      const css = await res.text();
      for (const match of css.matchAll(/url\(\s*["']?(\/assets\/[^"')]+)/g)) {
        if (match[1] && !urls.has(match[1])) nested.add(match[1]);
      }
    }),
  );
  await Promise.all([...nested].map(store));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const [shell, assets] = await Promise.all([caches.open(SHELL), caches.open(ASSETS)]);
      await Promise.all(
        PRECACHE.filter((url) => url !== '/').map((url) =>
          assets.add(url).catch(() => undefined),
        ),
      );
      await precacheShellAssets(shell, assets).catch(() => undefined);
      // Take over straight away. A half-updated app that only heals after two
      // launches is worse than a brief swap, and the shell is tiny.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== SHELL && key !== ASSETS).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/');
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put('/', response.clone());
    return response;
  } catch {
    const cached = await cache.match('/');
    if (cached) return cached;
    return new Response('Tempra is offline and has no cached copy yet.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(request);
  if (cached) {
    // Hashed assets can never go stale, but the manifest and icons can change
    // between deploys, so refresh quietly in the background.
    fetch(request)
      .then((res) => (res.ok ? cache.put(request, res) : undefined))
      .catch(() => undefined);
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    // Offline with nothing cached. Return a real response rather than letting
    // respondWith reject, which surfaces as an opaque network error.
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }

  event.respondWith(cacheFirstAsset(request));
});
