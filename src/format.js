/**
 * Render a burn count the way the game writes it, with a ½ glyph rather than a
 * decimal. Also keeps the value narrow, which matters in the alternatives list
 * where five of them share one panel.
 * @param {number} burns
 */
export function formatBurns(burns) {
  const wholeBurns = Math.floor(burns)
  const halfBurns = burns - wholeBurns
  // A site reachable for free still needs a marker: an empty label would hide it
  // entirely, which reads as "not reachable" rather than "costs nothing".
  if (wholeBurns === 0 && halfBurns === 0) return '0'
  return `${wholeBurns > 0 ? wholeBurns : ''}${halfBurns > 0 ? '½' : ''}`
}

/**
 * Every metric is a whole count except burns, which come in halves.
 * @param {MetricKey} key @param {number} value
 */
export function formatMetric(key, value) {
  return key === 'burns' ? formatBurns(value) : String(value)
}
