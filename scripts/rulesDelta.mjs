/*
 * The text delta between a book's publisher and living editions.
 *
 * The two editions are laid out independently, so lines wrap in different
 * places and a line diff would flag most of the book. Instead each edition is
 * reduced to a stream of words, the streams are diffed, and every run of
 * changes is reported with a little context, the rule section it falls in and
 * the page it is on in each edition, so the reader can jump to both PDFs.
 */
import fs from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { diffArrays } from 'diff'

/** Words of context shown either side of a change. */
const CONTEXT = 12

/**
 * @typedef {{text: string, page: number, section: string}} Word
 * @typedef {{section: string, pages: [number, number], parts: ['=' | '-' | '+', string][]}} Hunk
 *   parts alternate unchanged context ('=') with text only in the publisher
 *   edition ('-') or only in the living one ('+').
 */

/**
 * Running heads and folios, e.g. "20| HIGH FRONTIER 4 ALL | CORE RULES". They
 * differ between editions without saying anything about the rules.
 */
const RUNNING_HEAD = /^\s*\d*\s*\|?\s*HIGH FRONTIER 4 ALL\b.*$|^\s*\d+\s*$/i

/**
 * Rule headings ("G6. Voluntary…", "2A7. …") and their lettered points
 * ("a. Cube Limits."), which together name the section a change is in.
 */
const HEADING = /^(\d?[A-Z]\d{1,2})\.\s/
const POINT = /^([a-z])\.\s/

/** Typography that changes between exports without changing the rules. */
function normalise(/** @type {string} */ s) {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/­/g, '')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/\s+/g, ' ')
}

/** @param {string} file @returns {Promise<Word[]>} */
async function words(file) {
  const pdf = await getDocument({data: new Uint8Array(fs.readFileSync(file)), verbosity: 0}).promise
  /** @type {Word[]} */
  const out = []
  let heading = ''
  let section = ''
  for (let page = 1; page <= pdf.numPages; page++) {
    const content = await (await pdf.getPage(page)).getTextContent()
    let line = ''
    /** @type {string[]} */
    const lines = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      line += item.str
      if (item.hasEOL) { lines.push(line); line = '' }
    }
    lines.push(line)
    for (const raw of lines) {
      const text = normalise(raw).trim()
      if (!text || RUNNING_HEAD.test(text)) continue
      const h = HEADING.exec(text)
      const p = POINT.exec(text)
      if (h) section = heading = h[1]
      else if (p && heading) section = heading + p[1]
      for (const w of text.split(' ')) {
        // Rejoin a word hyphenated across a line break: "industrial-" + "ization".
        const last = out[out.length - 1]
        if (last && last.text.endsWith('-') && last.joinable && /^[a-z]/.test(w)) {
          last.text = last.text.slice(0, -1) + w
          last.joinable = false
          continue
        }
        out.push({text: w, page, section, joinable: false})
      }
      const last = out[out.length - 1]
      if (last) last.joinable = true
    }
  }
  for (const w of out) delete w.joinable
  return out
}

/** @param {Word[]} ws */
const join = (ws) => ws.map((w) => w.text).join(' ')

/** @param {Word[]} a @param {Word[]} b @returns {Hunk[]} */
function hunks(a, b) {
  /** @type {Hunk[]} */
  const out = []
  /** @type {Hunk | null} */
  let hunk = null
  // Unchanged words since the last change, held back until it is known
  // whether they end the current hunk or sit inside it.
  /** @type {Word[]} */
  let gap = []
  let i = 0
  let j = 0
  const close = () => {
    if (!hunk) return
    hunk.parts.push(['=', join(gap.slice(0, CONTEXT))])
    out.push(hunk)
    hunk = null
  }
  for (const part of diffArrays(a.map((w) => w.text), b.map((w) => w.text))) {
    const n = part.value.length
    if (!part.added && !part.removed) {
      gap = b.slice(j, j + n)
      i += n
      j += n
      continue
    }
    if (hunk && gap.length > 2 * CONTEXT) close()
    if (!hunk) {
      const anchorA = a[Math.min(i, a.length - 1)]
      const anchorB = b[Math.min(j, b.length - 1)]
      hunk = {
        section: anchorB?.section || anchorA?.section || '',
        pages: [anchorA?.page ?? 0, anchorB?.page ?? 0],
        parts: [['=', join(gap.slice(-CONTEXT))]],
      }
    } else if (gap.length) {
      hunk.parts.push(['=', join(gap)])
    }
    gap = []
    if (part.removed) {
      hunk.parts.push(['-', join(a.slice(i, i + n))])
      i += n
    } else {
      hunk.parts.push(['+', join(b.slice(j, j + n))])
      j += n
    }
  }
  close()
  return out
}

/**
 * @param {{books: {id: string}[], documents: import('../src/rulesSources.mjs').RulesDocument[]}} sources
 * @param {(doc: import('../src/rulesSources.mjs').RulesDocument) => string} cached
 * @param {(book: string) => string} output
 */
export async function writeDeltas(sources, cached, output) {
  for (const {id} of sources.books) {
    const publisher = sources.documents.find((d) => d.book === id && d.edition === 'publisher')
    const living = sources.documents.find((d) => d.book === id && d.edition === 'living')
    if (!publisher || !living) { console.log(`- ${id}: needs both editions, skipped`); continue }
    if (!fs.existsSync(cached(publisher)) || !fs.existsSync(cached(living))) {
      throw new Error(`${id}: run "node scripts/rules.mjs fetch" first`)
    }
    const changes = hunks(await words(cached(publisher)), await words(cached(living)))
    const header = {
      book: id,
      from: {sha256: publisher.sha256, date: publisher.date},
      to: {sha256: living.sha256, date: living.date},
    }
    // One change per line, so regenerating after a rules update gives a
    // readable git diff of what changed in the delta.
    const json = JSON.stringify(header).slice(0, -1) +
      ',"hunks":[\n' + changes.map((h) => JSON.stringify(h)).join(',\n') + '\n]}\n'
    fs.writeFileSync(output(id), json)
    console.log(`✓ ${id}: ${changes.length} changes`)
  }
}
