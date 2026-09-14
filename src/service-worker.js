/*
 * Emitted to dist/sw.js by the build, which fills in the two constants below.
 * Not imported by anything and not app code, so it is excluded from tsconfig:
 * it runs in a ServiceWorkerGlobalScope, which the project's DOM lib does not
 * model.
 */
const VERSION = '__VERSION__'
const SHELL = __SHELL__
const CACHE = `hf-planner-${VERSION}`
const INDEX = './index.html'

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await caches.open(CACHE).then((cache) => cache.addAll(SHELL))
    // Without this a new build waits until every tab is closed, which in
    // practice means never on a phone: the old version keeps being served and
    // its cache is never cleaned up.
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Each build gets its own cache, so drop the ones earlier builds left.
    for (const key of await caches.keys()) {
      if (key.startsWith('hf-planner-') && key !== CACHE) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return

  // Opening the app offline: fall back to the cached page.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request)
      } catch (e) {
        return (await caches.match(INDEX)) || (await caches.match('./')) || Response.error()
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cached = await caches.match(request)
    if (cached) return cached
    // Everything the build emits is content-hashed or rebuilt per version, so a
    // cache hit is never stale. Misses are stored on the way through: that is
    // how the map art — several megabytes the shell deliberately skips — ends
    // up available offline, without being downloaded before it is wanted.
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE)
      cache.put(request, response.clone())
    }
    return response
  })())
})
