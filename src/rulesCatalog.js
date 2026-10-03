/*
 * The rulebooks this build ships, from assets/rules/sources.json.
 */
import sources from '../assets/rules/sources.json'

/** @typedef {import('./rulesSources.mjs').RulesDocument} RulesDocument */

export const books = /** @type {{id: string, title: string}[]} */ (sources.books)
export const editions = /** @type {{id: string, title: string}[]} */ (sources.editions)
export const documents = /** @type {RulesDocument[]} */ (sources.documents)

/** @param {string} book @param {string} edition */
export function findDocument(book, edition) {
  return documents.find((d) => d.book === book && d.edition === edition)
}

/** @param {string} id */
export function bookTitle(id) {
  return books.find((b) => b.id === id)?.title ?? id
}

/** @param {string} id */
export function editionTitle(id) {
  return editions.find((e) => e.id === id)?.title ?? id
}
