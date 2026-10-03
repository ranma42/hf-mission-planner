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
import { books, editions, findDocument } from './rulesCatalog'
import { h } from './dom'
import { registerServiceWorker } from './serviceWorker'

const root = /** @type {HTMLElement} */ (document.getElementById('rules'))

/** @param {string} iso */
function formatDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'})
}

/** @param {number} bytes */
function formatSize(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

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
