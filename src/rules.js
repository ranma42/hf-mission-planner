/*
 * The rules section: the publisher and living editions of each rulebook, a
 * viewer with search for them, and the text delta between the two.
 *
 * Views are chosen by the hash, so each one can be bookmarked and the back
 * button works:
 *   #                          the list of books
 *   #doc=core-living&page=12   a PDF, optionally at a page and with &q=search
 *   #delta=core                what changed between a book's editions
 */
import './rules.css'
import { documentPath, RULES_CACHE } from './rulesSources.mjs'
import { books, editions, documents, findDocument, bookTitle } from './rulesCatalog'
import { h } from './dom'
import { registerServiceWorker } from './serviceWorker'

/** @typedef {import('./rulesSources.mjs').RulesDocument} RulesDocument */
/** @typedef {{section: string, pages: [number, number], parts: ['=' | '-' | '+', string][]}} Hunk */
/** @typedef {{book: string, from: {date: string}, to: {date: string}, hunks: Hunk[]}} Delta */

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
      'the rulebooks as the designer keeps revising them. The changes list compares the two texts.'),
    ...books.map((book) => {
      const delta = findDocument(book.id, 'publisher') && findDocument(book.id, 'living')
      return h('section', {className: 'Rules-book'},
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
          delta ? h('li', {}, h('a', {href: `#delta=${book.id}`}, 'Changes'), h('span', {className: 'Rules-meta'}, 'publisher → living')) : null,
        ))
    }),
    offlinePanel(),
    h('p', {className: 'Rules-credits'},
      'Rulebooks © Ion Game Design and Phil Eklund, served unmodified from ',
      h('a', {href: 'https://iongamedesign.com/products/high-frontier-4-all'}, 'ION’s downloads'),
      ' and ',
      h('a', {href: 'https://docs.google.com/spreadsheets/d/1dt1g3XGxMcQPIij1uLAc-x9-TiZXiwHTX8-jYK-3hEg'}, 'living rules'),
      '.'),
  )
}

/**
 * Whether a change only touches case, punctuation or numbering. Most of those
 * are footnote numbers shifting along after an insertion, which say nothing
 * about the rules.
 *
 * @param {Hunk} hunk
 */
function isCosmetic(hunk) {
  /** @param {'-' | '+'} op */
  const text = (op) => hunk.parts.filter(([o]) => o === op).map(([, t]) => t).join(' ').toLowerCase().replace(/[^a-z]/g, '')
  return text('-') === text('+')
}

/**
 * What to search for to find a change in one edition: the changed words
 * themselves when there are enough of them to be distinctive, otherwise the
 * words just before the change, which both editions share.
 *
 * @param {Hunk} hunk
 * @param {'-' | '+'} side '-' for the publisher edition, '+' for the living one
 */
function searchFor(hunk, side) {
  const changed = hunk.parts.find(([op]) => op === side)?.[1].split(' ') ?? []
  if (changed.length >= 3) return changed.slice(0, 6).join(' ')
  const first = hunk.parts.findIndex(([op]) => op !== '=')
  const before = first > 0 ? hunk.parts[first - 1][1].split(' ') : []
  return before.slice(-5).join(' ')
}

/** @param {string} book */
async function deltaView(book) {
  document.title = `${bookTitle(book)} changes · Rules`
  const publisher = findDocument(book, 'publisher')
  const living = findDocument(book, 'living')
  /** @type {Delta} */
  const delta = (await import(`../assets/rules/${book}-delta.json`)).default
  const filter = h('input', {type: 'search', className: 'Rules-filter', placeholder: 'Filter by text or section (e.g. F4)'})
  const showCosmetic = h('input', {type: 'checkbox'})
  const count = h('span', {className: 'Rules-meta'})
  const list = h('ol', {className: 'Delta-list'})

  const items = delta.hunks.map((hunk) => {
    const text = hunk.parts.map(([, t]) => t).join(' ').toLowerCase()
    const el = h('li', {className: 'Delta-hunk'},
      h('div', {className: 'Delta-where'},
        h('span', {className: 'Delta-section'}, hunk.section || '—'),
        publisher ? h('a', {href: '#' + new URLSearchParams({doc: `${book}-publisher`, page: String(hunk.pages[0]), q: searchFor(hunk, '-')})}, `publisher p. ${hunk.pages[0]}`) : null,
        living ? h('a', {href: '#' + new URLSearchParams({doc: `${book}-living`, page: String(hunk.pages[1]), q: searchFor(hunk, '+')})}, `living p. ${hunk.pages[1]}`) : null,
      ),
      h('p', {className: 'Delta-text'},
        ...hunk.parts.map(([op, t]) =>
          op === '=' ? t + ' ' : h(op === '-' ? 'del' : 'ins', {}, t, ' '))),
    )
    return {hunk, el, text, cosmetic: isCosmetic(hunk)}
  })

  const update = () => {
    const q = filter.value.trim().toLowerCase()
    let shown = 0
    let hidden = 0
    for (const item of items) {
      const matches = !q || item.text.includes(q) || item.hunk.section.toLowerCase().startsWith(q)
      const visible = matches && (showCosmetic.checked || !item.cosmetic)
      if (matches && !visible) hidden++
      item.el.hidden = !visible
      if (visible) shown++
    }
    count.textContent = `${shown} shown` + (hidden ? `, ${hidden} cosmetic hidden` : '')
  }
  filter.oninput = update
  showCosmetic.onchange = update
  list.append(...items.map((i) => i.el))
  update()

  return h('div', {className: 'Rules-delta'},
    h('header', {className: 'Rules-header'},
      h('a', {className: 'Rules-back', href: '#'}, '← Rules'),
      h('h1', {}, `${bookTitle(book)}: changes`),
    ),
    h('p', {className: 'Rules-intro'},
      `Text in the publisher edition (${formatDate(delta.from.date)}) that the living rules (${formatDate(delta.to.date)}) `,
      'remove is ', h('del', {}, 'struck through'), '; text they add is ', h('ins', {}, 'underlined'), '. ',
      'The page links open each edition with the change highlighted. This compares the extracted text ',
      'only: section labels are a best guess, and sidebars and tables can come out jumbled, so check the ',
      'PDF before relying on a change.'),
    h('div', {className: 'Delta-controls'},
      filter,
      h('label', {}, showCosmetic, ' Show case, punctuation and numbering changes'),
      count),
    list,
  )
}

async function route() {
  const params = new URLSearchParams(location.hash.slice(1))
  const doc = params.get('doc')
  const delta = params.get('delta')
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
  root.replaceChildren(delta && books.some((b) => b.id === delta) ? await deltaView(delta) : indexView())
}

window.addEventListener('hashchange', route)
route()
registerServiceWorker()
