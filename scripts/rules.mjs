#!/usr/bin/env node
/*
 * The rulebook PDFs are too big for git, so the repository records where each
 * one comes from and what it must hash to (assets/rules/sources.json) and this
 * script fetches them.
 *
 *   node scripts/rules.mjs fetch [outDir]
 *     Download every document into .cache/rules/ (skipping ones already there),
 *     check each against its recorded SHA-256, and copy them into outDir
 *     (default dist/) under the names the app expects. Exits non-zero if any
 *     download fails or does not match, so a deploy never ships a rulebook
 *     nobody has looked at.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { documentPath } from '../src/rulesSources.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcesFile = path.join(root, 'assets/rules/sources.json')
const cacheDir = path.join(root, '.cache/rules')

/** @type {{books: {id: string, title: string}[], editions: {id: string, title: string}[], documents: import('../src/rulesSources.mjs').RulesDocument[]}} */
const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))

/** @param {string} file */
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** @param {import('../src/rulesSources.mjs').RulesDocument} doc */
function cached(doc) {
  return path.join(cacheDir, `${doc.sha256}.pdf`)
}

/** @param {import('../src/rulesSources.mjs').RulesDocument} doc */
async function download(doc) {
  const target = cached(doc)
  if (fs.existsSync(target) && sha256(target) === doc.sha256) return null
  // Dropbox serves an HTML interstitial to clients that look like bots.
  const response = await fetch(doc.url, {headers: {'user-agent': 'Mozilla/5.0'}, redirect: 'follow'})
  if (!response.ok) return `HTTP ${response.status}`
  const body = Buffer.from(await response.arrayBuffer())
  const actual = crypto.createHash('sha256').update(body).digest('hex')
  if (actual !== doc.sha256) {
    return `digest mismatch: got sha256 ${actual} (${body.length} bytes), expected ${doc.sha256} (${doc.bytes} bytes)`
  }
  fs.mkdirSync(cacheDir, {recursive: true})
  fs.writeFileSync(target + '.part', body)
  fs.renameSync(target + '.part', target)
  return null
}

async function fetchAll(outDir = path.join(root, 'dist')) {
  const failures = []
  for (const doc of sources.documents) {
    const name = `${doc.book}/${doc.edition}`
    let error
    try {
      error = await download(doc)
    } catch (e) {
      error = String(e)
    }
    if (error) {
      failures.push(`${name}: ${error}\n    ${doc.url}`)
      console.error(`✗ ${name}`)
      continue
    }
    const out = path.join(outDir, documentPath(doc))
    fs.mkdirSync(path.dirname(out), {recursive: true})
    fs.copyFileSync(cached(doc), out)
    console.log(`✓ ${name} → ${path.relative(root, out)}`)
  }
  if (failures.length) {
    console.error(`\n${failures.length} problem(s) with the rulebooks in assets/rules/sources.json:\n  ${failures.join('\n  ')}`)
    console.error('\nIf a source was updated on purpose, check the new file and record its digest, size and date.')
    process.exit(1)
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === 'fetch') {
  await fetchAll(args[0] && path.resolve(args[0]))
} else {
  console.error('usage: node scripts/rules.mjs fetch [outDir]')
  process.exit(2)
}
