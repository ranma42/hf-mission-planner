import Heap from './heap'

/**
 * @template Node
 * @typedef {{node: Node, weight: number[], prev: Label<Node>|null, live: boolean,
 *   key: string, res: number[]}} Label
 */

/**
 * Lexicographic order on weight vectors. It is a linear extension of
 * componentwise <=, which is what the search needs: a label can only be
 * dominated by one that sorts before it, so popping in this order means a
 * label is settled when it comes off the queue.
 * @param {number[]} a @param {number[]} b
 */
function lexLessThan(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

/**
 * Martins' label-correcting multi-objective shortest path.
 *
 * Where a scalar Dijkstra keeps one distance per state, this keeps a set of
 * mutually non-dominated labels, so a single graph expansion yields the whole
 * Pareto front instead of the one path a given tie-break order happens to
 * prefer. Labels carry their own predecessor, since a state no longer has a
 * single best way to reach it.
 *
 * @template Node
 * @param {object} options
 * @param {Node} options.source
 * @param {(node: Node) => Iterable<Node>} options.getNeighbors
 * @param {(u: Node, v: Node) => number[]} options.weight edge cost vector; the
 *   first `metricCount` entries take part in dominance, any remaining ones are
 *   tie-breakers that only affect which representative path is kept.
 * @param {number} options.metricCount
 * @param {number} [options.tieBreakCount] how many tie-breakers `weight`
 *   appends after the metrics. They cost nothing in front size — dominance
 *   never looks at them — and only order the queue, so among labels equal on
 *   every metric the one preferred here is the one that survives.
 * @param {(label: Label<Node>, v: Node) => boolean} options.allowed
 * @param {(node: Node) => string} options.key states sharing a key compete;
 *   coarser than full state identity, so that e.g. differing fuel levels are
 *   compared rather than tracked separately.
 * @param {(node: Node) => number[]} options.resources per-state quantities
 *   where *more is better* (fuel, pivots, bonus). A label is only dominated by
 *   one that is no worse on every metric *and* no poorer on every resource.
 * @param {(node: Node) => boolean} options.isTarget
 * @param {(targets: Label<Node>[]) => void} [options.onProgress] called
 *   occasionally with the non-dominated targets found so far, so a long search
 *   can show its work. Time-throttled, not called for every label.
 * @param {(node: Node) => number[]} [options.pending] cost a label has already
 *   committed to but not yet been billed for, per metric. Weights stay exactly
 *   as `weight` totals them — dominance and the front are unaffected — but the
 *   queue, the bound and the target test all see weight + pending, which is a
 *   lower bound on anything the label can still become. Without it a metric
 *   billed in arrears reads as free until it is charged, and prunes nothing.
 * @param {number[]} [options.bound] per-metric value below which a solution is
 *   still of interest. A label that has already overshot *every* entry is
 *   discarded. Pass -Infinity for a metric that should never rescue a label.
 * @returns {Label<Node>[]} the non-dominated labels reaching the target
 */
export function paretoSearch({source, getNeighbors, weight, metricCount, tieBreakCount = 1, allowed, key, resources, isTarget, bound, pending, onProgress}) {
  /** @param {Node} node @param {number[]} w */
  const estimate = (node, w) => {
    if (!pending) return w
    const p = pending(node)
    const r = w.slice()
    for (let i = 0; i < p.length; i++) r[i] += p[i]
    return r
  }
  /** @type {Map<string, Label<Node>[]>} */
  const frontier = new Map
  /** @type {Heap<number[], Label<Node>>} */
  const q = new Heap(null, lexLessThan)
  /** @type {Label<Node>[]} */
  const targets = []
  /** Componentwise minimum over `targets`; a cheap gate on the dominance scan. @type {number[]|null} */
  let targetFloor = null

  /** @param {number[]} a @param {number[]} b */
  const weightDominates = (a, b) => {
    for (let i = 0; i < metricCount; i++) if (a[i] > b[i]) return false
    return true
  }
  /** Has this label overshot every bound, making it unable to reach an
   * interesting solution? Costs only grow, so this is stable under extension.
   * @param {number[]} w */
  const outOfBounds = (w) => {
    if (!bound) return false
    for (let i = 0; i < metricCount; i++) if (w[i] <= bound[i]) return false
    return true
  }

  /** @param {number[]} a @param {number[]} b */
  const resourcesDominate = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] < b[i]) return false
    return true
  }

  /**
   * The key and resource vector are derived once per label rather than on every
   * comparison: `offer` is the hot path, and both showed up as pure allocation.
   * @param {Node} node @param {number[]} weight @param {Label<Node>|null} prev
   * @returns {Label<Node>}
   */
  const makeLabel = (node, weight, prev) =>
    ({node, weight, prev, live: true, key: key(node), res: resources(node)})

  /**
   * Record a label unless something already known is at least as good, evicting
   * anything it makes redundant. Returns false if the label is not worth queueing.
   * @param {Label<Node>} label
   */
  const offer = (label) => {
    const existing = frontier.get(label.key)
    if (!existing) {
      frontier.set(label.key, [label])
      return true
    }
    for (const e of existing) {
      if (weightDominates(e.weight, label.weight) && resourcesDominate(e.res, label.res)) return false
    }
    const kept = existing.filter(e => {
      if (weightDominates(label.weight, e.weight) && resourcesDominate(label.res, e.res)) {
        e.live = false // already queued; skipped when popped
        return false
      }
      return true
    })
    kept.push(label)
    frontier.set(label.key, kept)
    return true
  }

  const start = makeLabel(source, new Array(metricCount + tieBreakCount).fill(0), null)
  offer(start)
  q.insert(estimate(source, start.weight), start)

  let pops = 0
  let lastReport = Date.now()
  while (!q.isEmpty()) {
    const entry = q.removeEntry()
    if (!entry) break
    const label = entry.getValue()
    if (!label.live) continue
    const est = entry.getKey()

    // Checking the clock is itself measurable at this frequency, so only look
    // every few thousand pops.
    if (onProgress && (++pops & 0x1fff) === 0 && Date.now() - lastReport > 250) {
      lastReport = Date.now()
      onProgress(targets.filter(t => t.live))
    }

    if (isTarget(label.node)) {
      targets.push(label)
      if (!targetFloor) targetFloor = label.weight.slice(0, metricCount)
      else for (let i = 0; i < metricCount; i++) targetFloor[i] = Math.min(targetFloor[i], label.weight[i])
      continue
    }
    // Extending a label only ever adds cost, so once the target can already be
    // reached at least as cheaply on every metric, this branch cannot contribute.
    // `targetFloor` is the componentwise minimum over targets: if the label beats
    // it anywhere, no target can dominate it and the full scan is skipped.
    if (targetFloor && weightDominates(targetFloor, est) &&
        targets.some(t => t.live && weightDominates(t.weight, est))) continue

    for (const v of getNeighbors(label.node)) {
      if (!allowed(label, v)) continue
      const edge = weight(label.node, v)
      const w = new Array(edge.length)
      for (let i = 0; i < edge.length; i++) w[i] = label.weight[i] + edge[i]
      const e = estimate(v, w)
      if (outOfBounds(e)) continue
      const next = makeLabel(v, w, label)
      if (!offer(next)) continue
      q.insert(e, next)
    }
  }

  return targets.filter(t => t.live)
}

/**
 * Walk a label's predecessor chain back to the source.
 * @template Node @param {Label<Node>} label @returns {Node[]}
 */
export function labelPath(label) {
  /** @type {Node[]} */
  const path = []
  for (let l = /** @type {Label<Node>|null} */ (label); l; l = l.prev) path.unshift(l.node)
  return path
}
