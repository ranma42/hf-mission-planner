/*
 * The rules section: the publisher and living editions of each rulebook, and a
 * viewer with search for them.
 *
 * Views are chosen by the hash, so each one can be bookmarked and the back
 * button works:
 *   #                          the list of books
 *   #doc=core-living&page=12   a PDF, optionally at a page and with &q=search
 */
import './rules.css'
import { documentPath, RULES_CACHE } from './rulesSources.mjs'
import { books, editions, documents, findDocument } from './rulesCatalog'
import { h } from './dom'
import { registerServiceWorker } from './serviceWorker'

/** @typedef {import('./rulesSources.mjs').RulesDocument} RulesDocument */

const root = /** @type {HTMLElement} */ (document.getElementById('rules'))

/** @param {string} iso */
function formatDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'})
}

/** @param {number} bytes */
function formatSize(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

// --- Offline copies ----------------------------------------------------------

/** @returns {Promise<Set<RulesDocument>>} the documents already stored offline. */
async function savedDocuments() {
  if (!('caches' in window)) return new Set()
  const cache = await caches.open(RULES_CACHE)
  const saved = await Promise.all(documents.map((d) => cache.match(documentPath(d))))
  return new Set(documents.filter((_, i) => saved[i]))
}

/**
 * Stores every rulebook offline. The service worker already tries this each
 * time a page opens, but a tablet may suspend it part way through a hundred-odd
 * MB, so this is the dependable way to fill in whatever it missed.
 *
 * @param {(done: number, total: number) => void} progress
 */
async function saveAll(progress) {
  // Ask the browser not to evict the cache under storage pressure: without
  // this, best-effort storage is the first thing cleared.
  await navigator.storage?.persist?.().catch(() => false)
  const cache = await caches.open(RULES_CACHE)
  const total = documents.reduce((sum, d) => sum + d.bytes, 0)
  let done = 0
  for (const doc of documents) {
    const path = documentPath(doc)
    if (!(await cache.match(path))) {
      const response = await fetch(path)
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
      await cache.put(path, response)
    }
    done += doc.bytes
    progress(done, total)
  }
}

function offlinePanel() {
  const status = h('span', {className: 'Rules-offlineStatus'}, 'Checking…')
  const button = h('button', {className: 'Rules-button', disabled: true}, 'Save all for offline use')
  const refresh = async () => {
    const saved = await savedDocuments()
    const missing = documents.filter((d) => !saved.has(d))
    const bytes = missing.reduce((sum, d) => sum + d.bytes, 0)
    status.textContent = missing.length
      ? `${saved.size} of ${documents.length} rulebooks are available offline (${formatSize(bytes)} still to download).`
      : `All ${documents.length} rulebooks are available offline.`
    button.disabled = !missing.length
  }
  button.onclick = async () => {
    button.disabled = true
    try {
      await saveAll((done, total) => { status.textContent = `Downloading… ${Math.floor(100 * done / total)}%` })
    } catch (e) {
      console.warn(e)
      alert(`Could not download every rulebook: ${e}`)
    }
    refresh()
  }
  if ('caches' in window) refresh()
  else status.textContent = 'This browser cannot keep the rulebooks for offline use.'
  return h('section', {className: 'Rules-offline'}, status, ' ', button)
}

// --- Views -------------------------------------------------------------------

function indexView() {
  document.title = 'Rules · High Frontier Mission Planner'
  return h('div', {className: 'Rules-index'},
    h('header', {className: 'Rules-header'},
      h('a', {className: 'Rules-back', href: './'}, '← Planner'),
      h('h1', {}, 'High Frontier 4 All rules'),
    ),
    h('p', {className: 'Rules-intro'},
      'The publisher edition is the rulebook ION Game Design publishes for download. The living rules are ',
      'the rulebooks as the designer keeps revising them.'),
    ...books.map((book) =>
      h('section', {className: 'Rules-book'},
        h('h2', {}, book.title),
        h('ul', {},
          ...editions.map(({id, title}) => {
            const doc = findDocument(book.id, id)
            return h('li', {},
              doc
                ? h('a', {href: `#doc=${book.id}-${id}`}, title)
                : h('span', {className: 'Rules-missing'}, title),
              h('span', {className: 'Rules-meta'}, doc ? `${formatDate(doc.date)} · ${formatSize(doc.bytes)}` : 'no PDF published yet'))
          }),
        ))),
    offlinePanel(),
    h('p', {className: 'Rules-credits'},
      'Rulebooks © Ion Game Design and Phil Eklund, served unmodified from ',
      h('a', {href: 'https://iongamedesign.com/products/high-frontier-4-all'}, 'ION’s downloads'),
      ' and ',
      h('a', {href: 'https://docs.google.com/spreadsheets/d/1dt1g3XGxMcQPIij1uLAc-x9-TiZXiwHTX8-jYK-3hEg'}, 'living rules'),
      '.'),
  )
}

async function route() {
  const params = new URLSearchParams(location.hash.slice(1))
  const doc = params.get('doc')
  window.scrollTo(0, 0)
  if (doc) {
    const [book, edition] = doc.split('-')
    const found = findDocument(book, edition)
    if (found) {
      const { openViewer } = await import('./rulesViewer')
      root.replaceChildren(openViewer(found, Number(params.get('page')) || 1, params.get('q') || ''))
      return
    }
  }
  root.replaceChildren(indexView())
}

window.addEventListener('hashchange', route)
route()
registerServiceWorker()
