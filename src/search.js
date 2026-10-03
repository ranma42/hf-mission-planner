import { dijkstra } from './dijkstra'
import { paretoSearch, labelPath } from './pareto'

/** Every metric, in a fixed order — used wherever a stable key or comparison is
 * needed, independent of the user's current display priority. @type {MetricKey[]} */
export const ALL_METRICS = ['fuel', 'turns', 'hazards', 'radHazards']

/** Totalled and reported, but never optimised: they are consequences of a route
 * rather than trade-offs to be made against one another. @type {TrackedKey[]} */
export const TRACKED_METRICS = ['burns', 'pivots']

/** @type {(MetricKey|TrackedKey)[]} */
const SUMMED_METRICS = [...ALL_METRICS, ...TRACKED_METRICS]

/**
 * @typedef {object} SearchContext
 * @property {import('./MapData').MapData} mapData
 * @property {number} thrust
 * @property {number} pivots direction changes the vehicle may make per turn
 * @property {number} fuelNum tanks spent per burn, numerator
 * @property {number} fuelDen tanks spent per burn, denominator
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
export function createSearch({mapData, thrust, pivots, fuelNum, fuelDen, solarSeason, metricPriority}) {
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

  /** Tanks drawn by `burns` engine burns in one turn. A part-used tank is spent
   * in full, so the turn's burns round up together rather than one at a time.
   * Landings cost half burns, so count in halves and stay in integers — the
   * rounding is the model here, not an implementation detail.
   * @param {number} burns */
  function tanksFor(burns) {
    const halfBurns = Math.round(burns * 2)
    const halfDen = 2 * fuelDen
    return Math.floor((halfBurns * fuelNum + halfDen - 1) / halfDen)
  }

  /**
   * Knowing the turn's burns needs no extra state. `burnsRemaining` refills to
   * `thrust` at the start of every turn and only falls within one (bonus burns
   * are refunded into it rather than spent from it, which is why `burnWeight`
   * reads the same quantity), so the burns so far this turn are exactly
   * `thrust - burnsRemaining`.
   *
   * The charge falls due when the turn closes — `done` or `wait` — rather than
   * being spread over the burns as they happen. Spreading it is tempting, since
   * the running totals telescope to the same figure and it keeps the lead
   * metric moving, but it is wrong: it fuses the tanks already spent with the
   * part-tank in hand, and dominance cannot tell them apart. At 1/3, three
   * tanks with a fresh turn and two tanks with two burns already made both
   * total three, and the first looks better for having more burns left — but
   * the next burn costs it a whole tank and the second nothing, because the
   * second has already paid for the tank it is drawing on. Pruning on that
   * comparison loses real routes: it cost Sylvia -> Sedna its 24-tank
   * six-turn route and reported the 25-tank one as the best there was.
   *
   * Billed at the boundary, the weight carries only completed turns and
   * `burnsRemaining` carries the rest, so more of it is never worse and the
   * prune is sound again.
   *
   * @param {PathNode} u @param {PathNode} v
   */
  function fuelWeight(u, v) {
    if (!v.done && !v.wait) return 0
    return tanksFor(thrust - u.burnsRemaining)
  }

  /**
   * Tanks a node's burns have committed it to but that its turn has not been
   * billed for yet. Billing in arrears is what keeps the prune sound, but it
   * also leaves the fuel axis flat within a turn, and a lead metric that stands
   * still tells a queue nothing about what to pop next and a bound nothing to
   * prune against. This is what the turn will owe, so both can use it without
   * ever coming to prefer a costlier route. Zero once the turn has closed and
   * the charge has been made.
   * @param {PathNode} n @returns {number[]}
   */
  function fuelPending(n) {
    return [n.done || n.wait ? 0 : tanksFor(thrust - n.burnsRemaining)]
  }

  /** @param {PathNode} u @param {PathNode} v */
  function pivotWeight(u, v) {
    const {pivotsRemaining: uPivotsRemaining} = u
    const {pivotsRemaining: vPivotsRemaining} = v
    return vPivotsRemaining < uPivotsRemaining ? uPivotsRemaining - vPivotsRemaining : 0
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

  /** Straight-line length of every edge, in millionths of the map's width.
   * Integers, so the totals compare exactly: a tie-breaker that drifted in its
   * last bits would decide arbitrarily, which is the thing it exists to stop.
   * Positions do not move during a search, so this is measured once rather than
   * per relaxation. @type {Record<string, Record<string, number>>} */
  const edgeLength = {}
  for (const edge of mapData.edges) {
    const [a, b] = edge.split(':')
    const pa = mapData.points[a], pb = mapData.points[b]
    if (!pa || !pb) continue
    const d = Math.round(Math.hypot(pa.x - pb.x, pa.y - pb.y) * 1e6)
    if (!edgeLength[a]) edgeLength[a] = {}
    if (!edgeLength[b]) edgeLength[b] = {}
    edgeLength[a][b] = d
    edgeLength[b][a] = d
  }

  /** @param {PathNode} u @param {PathNode} v */
  function lengthWeight(u, v) {
    // Changing state without moving covers no ground.
    if (u.node === v.node) return 0
    const row = edgeLength[u.node]
    if (!row) return 0
    return row[v.node] ?? 0
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
    const fuel = fuelWeight(u, v)
    const burns = burnWeight(u, v)
    const pivots = pivotWeight(u, v)
    const turns = turnWeight(u, v)
    const hazards = hazardWeight(u, v)
    const radHazards = radHazardWeight(u, v)
    const segments = segmentWeight(u, v)
    const length = lengthWeight(u, v)
    // A pivot stands in for a direction change that would otherwise cost two
    // burns, so counting it as two is what makes a route that spends one
    // comparable with a route that burns through instead.
    const effort = burns + 2 * pivots
    return {fuel, burns, pivots, turns, hazards, radHazards, segments, length, effort}
  }

  /** Tie-breakers, in the order they are consulted, appended after the metrics
   * by both weight functions. Dominance stops at the metrics, so these cost
   * nothing in the size of the front; what they settle is which of several
   * equally optimal paths is the one shown.
   *
   * Effort leads, being what the route actually spends, with a pivot counted as
   * the two burns it stands in for so that the choice never turns on which of
   * the two a vehicle happens to have. Then the two that decide how a route
   * reads on the map: fewest segments, then shortest. Burns and pivots bring up
   * the rear, settling the rare route that ties on all of the above and keeping
   * the figures in the panel from depending on the order the search ran in.
   * @type {(TrackedKey|'segments'|'length'|'effort')[]} */
  const TIE_BREAKERS = ['effort', 'segments', 'length', ...TRACKED_METRICS]

  /** @param {MetricKey[]} order @returns {(u: PathNode, v: PathNode) => number[]} */
  function makeNodeWeight(order) {
    return (u, v) => {
      const weights = edgeWeights(u, v)
      return [...order.map(key => weights[key]), ...TIE_BREAKERS.map(key => weights[key])]
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
    // Fuel sits wherever `order` puts it, so the estimate goes to that index.
    const fuelIndex = order.indexOf('fuel')
    /** @param {PathNode} n @returns {number[]} */
    const heuristic = (n) => {
      const h = new Array(order.length + TIE_BREAKERS.length).fill(0)
      if (fuelIndex >= 0) h[fuelIndex] = fuelPending(n)[0]
      return h
    }
    const pathData = dijkstra(getNeighbors, makeNodeWeight(order), tupleNs, pathId, source, allowed, dominancePrune, targetId, heuristic)

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
    const total = {fuel: 0, turns: 0, hazards: 0, radHazards: 0, burns: 0, pivots: 0}
    if (!path) return total

    for (let i = 1; i < path.length; i++) {
      const edge = edgeWeights(path[i-1], path[i])
      for (const k of SUMMED_METRICS) total[k] += edge[k]
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
    // The trailing entries are tie-breakers only: dominance stops at
    // `metricCount`, so they choose the representative path among equals
    // without splitting the front into a variant per burn count.
    return [...ALL_METRICS.map(k => w[k]), ...TIE_BREAKERS.map(k => w[k])]
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
      tieBreakCount: TIE_BREAKERS.length,
      // Fuel is billed when the turn closes, so a label part-way through one
      // reads as owing nothing and neither `bound` nor the target test can
      // touch it. The tanks its burns have already committed it to are a lower
      // bound on what it will be billed, and arm both again.
      pending: fuelPending,
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
