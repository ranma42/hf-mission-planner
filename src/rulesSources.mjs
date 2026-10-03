/*
 * Shared by the app, the webpack config and scripts/rules.mjs, so it imports
 * nothing: the config loads it with require(), which cannot follow a JSON
 * import the way webpack can.
 */

/**
 * @typedef {{book: string, edition: string, date: string, url: string, bytes: number, sha256: string}} RulesDocument
 */

/**
 * Where a document is served from, relative to the app. The digest is part of
 * the name for the same reason bundle names carry a content hash: a cached copy
 * under this URL can never be stale, so the service worker keeps it across
 * deploys and only ever downloads a PDF that actually changed.
 *
 * @param {RulesDocument} doc
 */
export function documentPath(doc) {
  return `rules/${doc.book}-${doc.edition}.${doc.sha256.slice(0, 12)}.pdf`
}

/**
 * The Cache Storage cache the rulebooks are kept in. Unlike the app's own
 * cache it is not replaced on every deploy, since the PDFs rarely change and
 * are far too big to download again each time; the service worker prunes it
 * to the documents the current build lists instead.
 */
export const RULES_CACHE = 'hf-rules'
