/**
 * Builds an element. Children that are null are skipped, so optional parts can
 * be written inline.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any>} [props]
 * @param {...(Node|string|null)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else if (key in el) /** @type {any} */ (el)[key] = value
    else el.setAttribute(key, value)
  }
  for (const child of children) if (child != null) el.append(child)
  return el
}
