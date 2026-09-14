import Heap from './heap'

/**
 * @template Node
 * @template Weight
 * @param {(node: Node) => Iterable<Node>} getNeighbors
 * @param {(u: Node, v: Node) => Weight} weight
 * @param {{zero: Weight, add: (a: Weight, b: Weight) => Weight, lessThan: (a: Weight, b: Weight) => boolean}} monoid
 * @param {(node: Node) => string} id
 * @param {Node} source
 * @param {(u: Node, v: Node, id: (node: Node) => string, previous: Record<string, Node>) => boolean} allowed
 * @param {(node: Node, weight: Weight) => boolean} [prune]
 * @param {string} [targetId] stop once this node is settled; its distance and
 *   the predecessors along its path are final at that point, so callers that
 *   only need one destination can skip exploring the rest of the graph.
 * @param {(node: Node) => Weight} [heuristic] cost the node has committed to
 *   but not yet been charged, added to the queue key only. Distances stay
 *   exact; this just stops a cost billed in arrears from reading as free and
 *   leaving the queue with nothing to order by. Must never overstate what is
 *   still to come, or the first path found may not be the cheapest.
 * @returns {{distance: Record<string, Weight>, previous: Record<string, Node>}}
 */
export function dijkstra(getNeighbors, weight, {zero, add, lessThan}, id, source, allowed, prune = () => false, targetId = undefined, heuristic = () => zero) {
  /** @type {Record<string, Weight>} */
  const distance = {}
  /** @type {Record<string, Node>} */
  const previous = {}
  distance[id(source)] = zero
  /** @type {Heap<Weight, Node>} */
  const q = new Heap(null, lessThan)
  q.insert(heuristic(source), source)
  while (!q.isEmpty()) {
    const entry = q.removeEntry()
    if (!entry) break
    const u = entry.getValue()
    const idu = id(u)
    // Drop stale queue entries that no longer match the best known distance.
    // Compared on the queue's own terms, so the heuristic cancels out.
    if (distance[idu] !== undefined && lessThan(add(distance[idu], heuristic(u)), entry.getKey())) {
      continue
    }
    if (idu === targetId) break

    for (const v of getNeighbors(u)) {
      if (!allowed(u, v, id, previous)) continue
      const idv = id(v)
      const dv = distance[idv]
      const wuv = weight(u, v)
      const alt = add(distance[idu], wuv)
      if (prune(v, alt)) continue
      if (dv === undefined || lessThan(alt, dv)) {
        distance[idv] = alt
        previous[idv] = u
        // Push a new entry instead of decreasing key; stale entries are skipped when popped.
        q.insert(add(alt, heuristic(v)), v)
      }
    }
  }

  return {distance, previous}
}
