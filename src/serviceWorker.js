// Offline support. Registered only for real builds: during `start:dev` a
// service worker would serve yesterday's bundle back at you. The path is
// relative so it resolves under a project subpath on GitHub Pages, which also
// scopes the worker to the app rather than the whole origin. Both pages
// register it, since either can be the one a tablet opens first.
export function registerServiceWorker() {
  if (!__PROD__ || !('serviceWorker' in navigator)) return
  // A new worker takes over immediately and deletes the previous build's cache.
  // Chunk filenames are not content-hashed, so a page left running on the old
  // bundle could otherwise lazy-load a chunk and get the new build's contents.
  // Reloading onto the version now being served avoids that mismatch entirely.
  // Only when a controller was already in place: the first registration also
  // fires this, and reloading then would be pointless.
  if (navigator.serviceWorker.controller) {
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      location.reload()
    })
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'})
      .catch(e => console.warn('service worker registration failed', e))
  })
  // Have the worker store any rulebooks it does not have yet. See the message
  // handler in service-worker.js for why this is not part of installing it.
  navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage('precache-rules'))
}
