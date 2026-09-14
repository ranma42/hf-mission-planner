import { dijkstra } from './dijkstra'
import { paretoSearch, labelPath } from './pareto'

/** Every metric, in a fixed order — used wherever a stable key or comparison is
 * needed, independent of the user's current display priority. @type {MetricKey[]} */
export const ALL_METRICS = ['burns', 'turns', 'hazards', 'radHazards']

/**
 * @typedef {object} SearchContext
 * @property {import('./MapData').MapData} mapData
 * @property {number} thrust
 * @property {number} pivots direction changes the vehicle may make per turn
 * @property {string} solarSeason
 * @property {MetricKey[]} metricPriority tie-break order for single-path searches
 */

/**
 * All route-finding for a fixed vehicle and map.
 *
 * The context is captured by value, so a change to thrust, pivots, the solar
 * season or the map means building a new one — that is what lets the identical
 * code run inside a worker, where there is no shared mutable module state to
 * read from.
 *
 * @param {SearchContext} context
 */
export function createSearch({mapData, thrust, pivots, solarSeason, metricPriority}) {
  /**
   * Are you allowed to go to u from v, given the path previous?
   * @param {PathNode} u
   * @param {PathNode} v
   * @param {(node: PathNode) => string} id
   * @param {Record<string, PathNode>} previous
   * @returns {boolean}
   */
  function allowed(u, v, id, previous) {
    const {node: uId} = u
    const {node: vId} = v

    /** @param {PathNode} n */
    const prev = (n) => previous[id(n)]
  
    // Changing state without moving is permitted. We trust getNeighbors to
    // prevent infinite cycles.
    if (uId === vId) return true

    if (prev(u) && mapData.points[u.node].type === 'site') {
      // Once you enter a site, your turn ends.
      return false
    }
  
    // Visiting a node we've previously left in the same direction is forbidden.

    // First, walk back in the path until we find a different node.
    let n = prev(u)
    while (n?.node === uId) {
      n = prev(n)
    }
  
    // Then, walk the whole rest of the path. If we find vId anywhere with the
    // same direction or null direction, filter it out to prevent a loop.
    while (n) {
      if (n.node === vId && (n.dir === v.dir || n.dir == null))
        return false
      n = prev(n)
    }
    return true
  }

  /** @param {PathNode} p @returns {PathNode[]} */
  function getNeighbors(p) {
    // Done is a terminal state.
    if (p.done) return [];
    const {node, dir, bonus, burnsRemaining, pivotsRemaining, wait} = p
    /** @type {PathNode[]} */
    const ns = [{node, dir: null, bonus: 0, done: true, burnsRemaining, pivotsRemaining}] // Ending the turn is always valid. TODO: not on a lander burn!
    const { edgeLabels, points } = mapData
    const venusFlybyAvailable = solarSeason === 'blue'
    if (edgeLabels[node] && dir != null && !wait) {
      /**
       * Leave the Hohmann towards `otherNode`, paying `burnCost` burns and
       * `pivotCost` of the turn's pivot allowance.
       * @param {string} otherNode @param {string|null} newDir @param {number} burnCost @param {number} pivotCost
       */
      const exitHohmann = (otherNode, newDir, burnCost, pivotCost) => {
        if (burnCost > burnsRemaining || pivotCost > pivotsRemaining) return
        const bonusAfterHohmann = Math.max(bonus - burnCost, 0)
        const bonusBurnsUsed = bonus - bonusAfterHohmann
        ns.push({
          node: otherNode,
          dir: newDir,
          bonus: bonusAfterHohmann,
          burnsRemaining: burnsRemaining - burnCost + bonusBurnsUsed,
          pivotsRemaining: pivotsRemaining - pivotCost,
        })
      }
      for (const otherNode of Object.keys(edgeLabels[node])) {
        if (edgeLabels[node][otherNode] !== dir) {
          // Changing to an exit with a different label costs 2 burns, except on
          // '0' edges, which are one-way rather than a direction change.
          const turnCost = edgeLabels[node][otherNode] === '0' ? 0 : 2
          const entryCost = points[otherNode].type === 'burn' ? (points[otherNode].landing ?? 1) : 0
          const otherNodeType = points[otherNode].type
          const newDir = otherNodeType === 'hohmann' || otherNodeType === 'decorative' ? edgeLabels[node][otherNode] : null
          // Burn through the Hohmann...
          exitHohmann(otherNode, newDir, turnCost + entryCost, 0)
          // ...or spend a pivot in place of the direction change. The pivot is
          // free -- the allowance is the whole constraint -- so the only thing
          // stopping this is having none left this turn. The target node's own
          // entry cost is still paid in burns.
          if (turnCost > 0) exitHohmann(otherNode, newDir, entryCost, 1)
        }
      }
    }
    if (!wait && (points[node].type === 'hohmann' || ((points[node].type === 'burn' || points[node].type === 'lagrange') && burnsRemaining === 0))) {
      // Wait a turn. Both the burn and the pivot allowance refresh.
      ns.push({node, dir: null, bonus: 0, wait: true, burnsRemaining: thrust, pivotsRemaining: pivots})
    }
    for (const other of mapData.neighborsOf(node)) {
      if (edgeLabels[other] && edgeLabels[other][node] === '0')
        continue
      if (!(node in edgeLabels) || !(other in edgeLabels[node]) || edgeLabels[node][other] === dir || dir == null) {
        const dir = edgeLabels[other] && edgeLabels[other][node] ? edgeLabels[other][node] : null
        const entryCost = points[other].type === 'burn' ? points[other].landing ?? 1 : 0
        const flybyBoostRaw = points[other].type === 'venus' && !venusFlybyAvailable ? 0 : points[other].flybyBoost ?? 0
        const flybyBoost = flybyBoostRaw === 'thrust' ? thrust : flybyBoostRaw
        const bonusUsed = points[other].landing ? 0 : Math.min(bonus, entryCost)
        const bonusAfterEntry = Math.max(bonus - bonusUsed + flybyBoost, 0)
        if (burnsRemaining >= entryCost - bonusUsed)
          ns.push({node: other, dir, bonus: bonusAfterEntry, burnsRemaining: burnsRemaining - (entryCost - bonusUsed), pivotsRemaining})
      }
    }
    return ns
  }

  /** @type {{zero: number[], add: (a: number[], b: number[]) => number[], lessThan: (a: number[], b: number[]) => boolean, equals: (a: number[], b: number[]) => boolean, lessThanEq: (a: number[], b: number[]) => boolean}} */
  const tupleNs = {
    zero: [],
    add: (a, b) => {
      const n = Math.max(a.length, b.length)
      const r = []
      for (let i = 0; i < n; i++) {
        r[i] = (a[i] ?? 0) + (b[i] ?? 0)
      }
      return r
    },
    lessThan: (a, b) => {
      const n = Math.max(a.length, b.length)
      for (let i = 0; i < n; i++) {
        const ai = a[i] ?? 0
        const bi = b[i] ?? 0
        if (ai !== bi) return ai < bi
      }
      return false
    },
    equals: (a, b) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return false
      }
      return true
    },
    lessThanEq: (a, b) => {
      return tupleNs.lessThan(a, b) || tupleNs.equals(a, b)
    }
  }

  /** @param {PathNode} u @param {PathNode} v */
  function burnWeight(u, v) {
    const {burnsRemaining: uBurnsRemaining} = u
    const {burnsRemaining: vBurnsRemaining} = v
    return vBurnsRemaining < uBurnsRemaining ? uBurnsRemaining - vBurnsRemaining : 0
  }

  /** @param {PathNode} u @param {PathNode} v */
  function turnWeight(u, v) {
    const {wait} = v
    return wait ? 1 : 0
  }

  /** @param {PathNode} u @param {PathNode} v */
  function hazardWeight(u, v) {
    const { node: uId } = u
    const { node: vId } = v
    if (uId === vId) return 0
    const { points } = mapData
    if (points[vId].hazard)
      return 1
    return 0
  }

  /** @param {PathNode} u @param {PathNode} v */
  function radHazardWeight(u, v) {
    const { node: uId } = u
    const { node: vId } = v
    if (uId === vId) return 0
    const { points } = mapData
    if (points[vId].type === 'radhaz') {
      return 1
    }
    return 0
  }

  /** @param {PathNode} u @param {PathNode} v */
  function segmentWeight(u, v) {
    const { points } = mapData
    const vType = points[v.node].type
    if (vType === 'decorative') {
      return 0
    }
    return 1
  }

  /** @param {PathNode} u @param {PathNode} v */
  function edgeWeights(u, v) {
    const burns = burnWeight(u, v)
    const turns = turnWeight(u, v)
    const hazards = hazardWeight(u, v)
    const radHazards = radHazardWeight(u, v)
    const segments = segmentWeight(u, v)
    return {burns, turns, hazards, radHazards, segments}
  }

  /** @param {MetricKey[]} order @returns {(u: PathNode, v: PathNode) => number[]} */
  function makeNodeWeight(order) {
    return (u, v) => {
      const weights = edgeWeights(u, v)
      return [...order.map(key => weights[key]), weights.segments]
    }
  }

  /** @typedef {{weight: number[], burnsRemaining: number, pivotsRemaining: number, bonus: number}} DominanceEntry */
  /** @returns {(node: PathNode, weight: number[]) => boolean} */
  function makeDominancePrune() {
    /** @param {PathNode} node */
    const dominanceKey = (node) => {
      const dir = node.dir ?? ''
      const wait = node.wait ? 'w' : ''
      const done = node.done ? 'd' : ''
      return `${node.node}|${dir}|${wait}|${done}`
    }
    /** @type {Map<string, DominanceEntry[]>} */
    const frontier = new Map
    return (node, weight) => {
      const key = dominanceKey(node)
      const br = node.burnsRemaining ?? 0
      const pr = node.pivotsRemaining ?? 0
      const bonus = node.bonus ?? 0
      const entries = frontier.get(key)

      if (entries) {
        for (const e of entries) {
          if (tupleNs.lessThanEq(e.weight, weight) && e.burnsRemaining >= br && e.pivotsRemaining >= pr && e.bonus >= bonus) {
            return true
          }
        }
        const kept = entries.filter(e => !(tupleNs.lessThanEq(weight, e.weight) && br >= e.burnsRemaining && pr >= e.pivotsRemaining && bonus >= e.bonus))
        kept.push({weight, burnsRemaining: br, pivotsRemaining: pr, bonus})
        frontier.set(key, kept)
      } else {
        frontier.set(key, [{weight, burnsRemaining: br, pivotsRemaining: pr, bonus}])
      }
      return false
    }
  }

  const PATH_ID = Symbol('pathId')

  /** @param {PathNode} p */
  function pathId(p) {
    // @ts-ignore
    if (p[PATH_ID]) return p[PATH_ID]
    // Fast, collision-resistant encoding for path state.
    const id = p.done
      ? p.node
      : `s:${p.node}|${p.dir ?? ''}|${p.bonus}|${p.burnsRemaining}|${p.pivotsRemaining}|${p.wait ? 1 : 0}`
    // Cache on the object; symbol property stays non-enumerable in JSON/stringify.
    Object.defineProperty(p, PATH_ID, {value: id})
    return id
  }

  /** @param {string} fromId @param {MetricKey[]} [order] @param {string} [targetId] */
  function findPath(fromId, order = metricPriority, targetId = undefined) {
    // NB for pathfinding along Hohmanns each
    // hohmann is kind of like two nodes, one for
    // each direction. Moving into either node is
    // free, but switching from one to the other
    // costs 2 burns (or a turn).
    //  .
    //   `-.         ,-'
    //      `-O.  ,-'
    //      2 | `-.
    //       ,O'   `-.
    //    ,-'         `-
    // .-'
    // point: {node: string; dir: string?, id: string}
    const timed = order === metricPriority
    if (timed) console.time('calculating paths')

    const dominancePrune = makeDominancePrune()
    const source = /** @type {PathNode} */ ({node: fromId, dir: null, bonus: 0, burnsRemaining: thrust, pivotsRemaining: pivots})
    const pathData = dijkstra(getNeighbors, makeNodeWeight(order), tupleNs, pathId, source, allowed, dominancePrune, targetId)

    if (timed) console.timeEnd('calculating paths')

    return pathData
  }

  /**
   * @param {PathData} param0
   * @param {string} fromId
   * @param {string} toId
   * @returns {PathNode[]|undefined}
   */
  function drawPath({ distance, previous }, fromId, toId) {
    const source = /** @type {PathNode} */ ({node: fromId, dir: null, bonus: 0, burnsRemaining: thrust, pivotsRemaining: pivots})

    let shorterTo = /** @type {PathNode} */ ({node: toId, dir: null, bonus: 0, done: true, burnsRemaining: 0, pivotsRemaining: 0})
    let shorterToId = pathId(shorterTo)

    if (shorterToId in distance) {
      const path = [shorterTo]
      let cur = shorterTo
      while (pathId(cur) !== pathId(source)) {
        const n = previous[pathId(cur)]
        path.unshift(n)
        cur = n
      }

      // Ending the turn changes neither budget, but the terminal state is a fresh
      // literal (its id is just the node), so inherit them from its predecessor —
      // otherwise pathWeight bills the final step for every remaining burn.
      const pred = path[path.length - 2]
      if (pred) {
        path[path.length - 1] = {...shorterTo, burnsRemaining: pred.burnsRemaining, pivotsRemaining: pred.pivotsRemaining}
      }

      return path
    }
  }

  /** @param {PathNode[]|null|undefined} path */
  function pathWeight(path) {
    /** @type {MetricWeights} */
    const total = {burns: 0, turns: 0, hazards: 0, radHazards: 0}
    if (!path) return total

    for (let i = 1; i < path.length; i++) {
      const edge = edgeWeights(path[i-1], path[i])
      total.burns += edge.burns
      total.turns += edge.turns
      total.hazards += edge.hazards
      total.radHazards += edge.radHazards
    }
    return total
  }


  /**
   * Same rule as `allowed`, but walking a label's own predecessor chain rather
   * than the `previous` map — the multi-objective search keeps many paths per
   * state, so there is no single predecessor to look up. Keep the two in sync.
   * @param {import('./pareto').Label<PathNode>} label @param {PathNode} v
   */
  function allowedAlongChain(label, v) {
    const uId = label.node.node
    const vId = v.node

    // Changing state without moving is permitted. We trust getNeighbors to
    // prevent infinite cycles.
    if (uId === vId) return true

    // Once you enter a site, your turn ends.
    if (label.prev && mapData.points[uId].type === 'site') return false

    // Visiting a node we've previously left in the same direction is forbidden.
    // First, walk back until we find a different node...
    let l = label.prev
    while (l && l.node.node === uId) l = l.prev
    // ...then check the whole rest of the path for vId in the same (or any) direction.
    while (l) {
      const n = l.node
      if (n.node === vId && (n.dir === v.dir || n.dir == null)) return false
      l = l.prev
    }
    return true
  }

  /** @param {PathNode} u @param {PathNode} v @returns {number[]} */
  function paretoWeight(u, v) {
    const w = edgeWeights(u, v)
    // Trailing `segments` is a tie-breaker only: it keeps the shortest-looking
    // path among equals without splitting the front into segment-count variants.
    return [...ALL_METRICS.map(k => w[k]), w.segments]
  }

  /** @template T @param {T[]} items @returns {T[][]} */
  function permutations(items) {
    if (items.length <= 1) return [items]
    /** @type {T[][]} */
    const out = []
    for (let i = 0; i < items.length; i++) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)]
      for (const p of permutations(rest)) out.push([items[i], ...p])
    }
    return out
  }

  /**
   * The complete Pareto front runs to hundreds of entries on long routes — real
   * trade-offs, but not a list anyone can read. Keep the ones that win under at
   * least one priority ordering, which is the same content the old per-ordering
   * searches produced, now derived by sorting the front instead of re-searching.
   * @param {Solution[]} front @returns {Solution[]}
   */
  function curateSolutions(front) {
    if (front.length <= 1) return front
    const metrics = ALL_METRICS
    /** @type {Set<Solution>} */
    const picked = new Set
    for (const order of permutations(metrics)) {
      let best = front[0]
      for (const s of front) {
        if (tupleNs.lessThan(order.map(k => s.weight[k]), order.map(k => best.weight[k]))) best = s
      }
      picked.add(best)
    }
    return [...picked]
  }

  /**
   * The complete set of Pareto-optimal trade-offs between two points, from a
   * single graph expansion. Unlike running one lexicographic search per metric
   * ordering, this also finds interior solutions that are optimal under no
   * ordering at all, and costs one expansion rather than 24.
   * @param {string} fromId @param {string} toId
   * @param {(partial: Solution[]) => void} [onProgress] receives the best-so-far
   *   set periodically, so a caller can render progress during a long search.
   * @returns {Solution[]}
   */
  function findSolutions(fromId, toId, onProgress = undefined) {
    /** @param {import('./pareto').Label<PathNode>} label @returns {Solution} */
    const toSolution = (label) => {
      const path = labelPath(label)
      return {weight: pathWeight(path), path}
    }
    console.time('exploring solutions')
    const source = /** @type {PathNode} */ ({node: fromId, dir: null, bonus: 0, burnsRemaining: thrust, pivotsRemaining: pivots})
    /** @param {PathNode} n */
    const isTarget = (n) => !!n.done && n.node === toId

    // Every solution we display is lexicographically optimal under some priority
    // ordering, and such a solution has its *first* metric at that metric's global
    // optimum. So a label that has already overshot every metric's optimum cannot
    // lead to one, which bounds the front hard on long routes.
    const bound = ALL_METRICS.map(() => -Infinity)
    for (const m of ALL_METRICS) {
      const order = [m, ...ALL_METRICS.filter(k => k !== m)]
      const best = drawPath(findPath(fromId, order, toId), fromId, toId)
      if (best) bound[ALL_METRICS.indexOf(m)] = pathWeight(best)[m]
    }

    const labels = paretoSearch({
      source,
      getNeighbors,
      weight: paretoWeight,
      metricCount: ALL_METRICS.length,
      // Ending the turn is terminal, so a `done` state anywhere but the
      // destination is a dead end not worth carrying a label for.
      allowed: (label, v) => (!v.done || isTarget(v)) && allowedAlongChain(label, v),
      key: (n) => `${n.node}|${n.dir ?? ''}|${n.wait ? 'w' : ''}|${n.done ? 'd' : ''}`,
      resources: (n) => [n.burnsRemaining ?? 0, n.pivotsRemaining ?? 0, n.bonus ?? 0],
        isTarget,
      bound,
      onProgress: onProgress && (targets => onProgress(targets.map(toSolution))),
    })
    console.timeEnd('exploring solutions')

    return labels.map(toSolution)
  }

  return {
    findPath,
    drawPath,
    pathWeight,
    edgeWeights,
    turnWeight,
    findSolutions,
    curateSolutions,
  }
}
