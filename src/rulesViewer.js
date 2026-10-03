/*
 * A PDF viewer with search, built from PDF.js's viewer components.
 *
 * Browsers' own PDF handling cannot be relied on here: Android Chrome has no
 * inline viewer and hands PDFs to another app, and an installed PWA on iPadOS
 * has no find-in-page. PDF.js behaves the same everywhere, works offline, and
 * its text layer is what search runs against.
 *
 * Its own chunk, loaded only when a rulebook is opened: PDF.js is several
 * times the size of the rest of the rules page.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import { documentPath } from './rulesSources.mjs'
import { bookTitle, editionTitle } from './rulesCatalog'
import { h } from './dom'

// Emitted by webpack as a file of its own, and loaded by PDF.js as a module
// worker, so its megabyte of minified code is neither re-bundled nor parsed on
// the main thread.
GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

/**
 * Makes a document's pages leave placed artwork out of their text: the
 * Sunspot Cycle placard, playmat excerpts and so on, which InDesign tags as
 * PlacedPDF. That text is too small to read and is often clipped mid-word, so
 * searching found matches nobody could see. scripts/rulesDelta.mjs leaves it
 * out of the deltas for the same reason.
 *
 * Done where the text is produced rather than in search alone: the find
 * controller locates its highlights by position in the text layer's items, so
 * both have to see the same text.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdf
 */
async function skipPlacedArtwork(pdf) {
  const proto = Object.getPrototypeOf(await pdf.getPage(1))
  if (proto.streamTextContent.skipsPlacedArtwork) return
  const original = proto.streamTextContent
  /** @param {{includeMarkedContent?: boolean, disableNormalization?: boolean}} [params] */
  const streamTextContent = function (params = {}) {
    // Marked content is the only way to tell where artwork starts and ends,
    // so always ask for it, and drop the markers again if the caller did not.
    const stream = original.call(this, {...params, includeMarkedContent: true})
    /** Tags of the marked-content sections the current item is inside. @type {string[]} */
    const open = []
    return stream.pipeThrough(new TransformStream({
      transform(/** @type {{items: any[]}} */ chunk, controller) {
        const items = []
        for (const item of chunk.items) {
          const inArtwork = open.includes('PlacedPDF')
          if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') open.push(item.tag ?? '')
          else if (item.type === 'endMarkedContent') open.pop()
          if (inArtwork || open.includes('PlacedPDF')) continue
          if (item.type && !params.includeMarkedContent) continue
          items.push(item)
        }
        controller.enqueue({...chunk, items})
      },
    }))
  }
  streamTextContent.skipsPlacedArtwork = true
  proto.streamTextContent = streamTextContent
}

/** The zoom steps the − and + buttons move between. */
const SCALES = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]

/**
 * @param {import('./rulesSources.mjs').RulesDocument} doc
 * @param {number} initialPage
 * @param {string} initialQuery
 */
export function openViewer(doc, initialPage, initialQuery) {
  const path = documentPath(doc)
  const title = `${bookTitle(doc.book)} · ${editionTitle(doc.edition)}`
  document.title = `${title} · Rules`

  const viewer = h('div', {className: 'pdfViewer'})
  const container = h('div', {className: 'Viewer-container'}, viewer)
  const search = h('input', {type: 'search', className: 'Viewer-search', placeholder: 'Search', value: initialQuery, enterKeyHint: 'search'})
  const matches = h('span', {className: 'Viewer-matches'})
  const page = h('span', {className: 'Viewer-page'}, '…')
  const status = h('div', {className: 'Viewer-status'}, `Loading ${title}…`)

  const eventBus = new EventBus()
  const linkService = new PDFLinkService({eventBus})
  const findController = new PDFFindController({eventBus, linkService})
  const pdfViewer = new PDFViewer({container, viewer, eventBus, linkService, findController})
  linkService.setViewer(pdfViewer)

  /** @param {'' | 'again'} type @param {boolean} [previous] */
  const find = (type, previous = false) => {
    eventBus.dispatch('find', {
      source: null,
      type,
      query: search.value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    })
  }

  // Keep the page and search in the address, so reloading, or going back
  // from a page a link led to, returns to the same place.
  const remember = () => {
    const params = new URLSearchParams({doc: `${doc.book}-${doc.edition}`, page: String(pdfViewer.currentPageNumber)})
    if (search.value) params.set('q', search.value)
    history.replaceState(null, '', '#' + params)
  }

  search.oninput = () => { find(''); remember() }
  search.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    find('again', e.shiftKey)
  }

  /** @param {number} direction */
  const zoom = (direction) => {
    const current = pdfViewer.currentScale
    const next = direction > 0
      ? SCALES.find((s) => s > current + 0.01) ?? SCALES[SCALES.length - 1]
      : [...SCALES].reverse().find((s) => s < current - 0.01) ?? SCALES[0]
    pdfViewer.currentScale = next
  }

  eventBus.on('pagesinit', () => {
    pdfViewer.currentScaleValue = 'page-width'
    if (initialPage > 1) pdfViewer.currentPageNumber = initialPage
    if (initialQuery) find('')
    status.remove()
  })
  eventBus.on('pagechanging', (/** @type {{pageNumber: number}} */ {pageNumber}) => {
    page.textContent = `${pageNumber} / ${pdfViewer.pagesCount}`
    remember()
  })
  /** @param {{matchesCount: {current: number, total: number}}} e */
  const showMatches = ({matchesCount: {current, total}}) => {
    matches.textContent = !search.value ? '' : total ? `${current} / ${total}` : 'No matches'
  }
  eventBus.on('updatefindmatchescount', showMatches)
  eventBus.on('updatefindcontrolstate', showMatches)
  window.addEventListener('resize', () => {
    if (pdfViewer.currentScaleValue === 'page-width') pdfViewer.currentScaleValue = 'page-width'
  })

  // Range requests are off: the service worker answers from a whole cached
  // file, and PDF.js rejects a full response to a request for a range.
  getDocument({url: path, disableRange: true}).promise.then(async (pdf) => {
    await skipPlacedArtwork(pdf)
    pdfViewer.setDocument(pdf)
    linkService.setDocument(pdf)
  }, (e) => {
    status.textContent = `Could not open ${title}: ${e.message ?? e}`
  })

  return h('div', {className: 'Viewer'},
    h('div', {className: 'Viewer-bar'},
      h('a', {className: 'Viewer-button', href: '#', title: 'All rulebooks'}, '←'),
      h('span', {className: 'Viewer-title'}, title),
      h('div', {className: 'Viewer-find'},
        search,
        h('button', {className: 'Viewer-button', title: 'Previous match', onclick: () => find('again', true)}, '▲'),
        h('button', {className: 'Viewer-button', title: 'Next match', onclick: () => find('again')}, '▼'),
        matches),
      h('div', {className: 'Viewer-zoom'},
        h('button', {className: 'Viewer-button', title: 'Zoom out', onclick: () => zoom(-1)}, '−'),
        h('button', {className: 'Viewer-button', title: 'Fit width', onclick: () => { pdfViewer.currentScaleValue = 'page-width' }}, '↔'),
        h('button', {className: 'Viewer-button', title: 'Zoom in', onclick: () => zoom(1)}, '+')),
      page,
      h('a', {className: 'Viewer-button', href: path, target: '_blank', rel: 'noopener', title: 'Open the PDF itself'}, 'PDF'),
    ),
    container,
    status,
  )
}
