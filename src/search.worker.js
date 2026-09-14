import { createSearch } from './search'
import { MapData } from './MapData'

/**
 * Runs the searches off the main thread. Both freeze the page if done inline:
 * Explore for seconds on a long route, and the path search for over a second
 * once a vehicle has pivots, which is every change to thrust, fuel or pivots
 * while a destination is being picked.
 *
 * Two kinds of request arrive, and the page gives each its own worker, since
 * Explore is discarded and restarted whenever the pointer settles somewhere new
 * and would otherwise take the path search down with it.
 *
 * `solutions` replies with the Pareto front, streamed as it is found. The front
 * is small, so it crosses whole.
 *
 * `path` cannot: the search behind it settles every state reachable from the
 * origin, which from GEO is sixty thousand of them, ten megabytes of distances
 * to copy on every change to the vehicle. So it stays here, and the reply
 * carries only the burns to each site, which is what the map labels. `route`
 * then reads one path at a time back out of it.
 *
 * Replies carry the id of the request that caused them; the page drops any
 * whose id it has moved past, so a superseded search costs correctness nothing.
 */

/** The search behind the last `path` request, kept so `route` can read paths out
 * of it rather than repeat it.
 * @type {{id: number, fromId: string, search: ReturnType<typeof createSearch>, pathData: PathData}|null} */
let pathSearch = null

self.onmessage = (/** @type {MessageEvent} */ event) => {
  const msg = event.data

  if (msg.type === 'route') {
    const {id, toId} = msg
    // The page only asks after a `path` reply, but a request already in flight
    // when the search was replaced arrives here with nothing left to read.
    const path = pathSearch && pathSearch.id === id
      ? pathSearch.search.drawPath(pathSearch.pathData, pathSearch.fromId, toId) ?? null
      : null
    self.postMessage({type: 'route', id, toId, path})
    return
  }

  const {type, id, map, thrust, pivots, fuelNum, fuelDen, solarSeason, metricPriority, fromId, toId} = msg
  const mapData = MapData.fromJSON(map)
  const search = createSearch({mapData, thrust, pivots, fuelNum, fuelDen, solarSeason, metricPriority})

  if (type === 'path') {
    try {
      const pathData = search.findPath(fromId)
      pathSearch = {id, fromId, search, pathData}
      /** @type {Record<string, number>} */
      const siteBurns = {}
      for (const nodeId of Object.keys(mapData.points)) {
        if (nodeId === fromId || mapData.points[nodeId].type !== 'site') continue
        const path = search.drawPath(pathData, fromId, nodeId)
        // A site left out of this is one no route reaches, which the labels need
        // to tell apart from one reached for nothing.
        if (path) siteBurns[nodeId] = search.pathWeight(path).burns
      }
      self.postMessage({type: 'path', id, fromId, siteBurns})
    } catch (e) {
      self.postMessage({type: 'path', id, fromId, siteBurns: {}, error: String(e && e.message || e)})
    }
    return
  }

  try {
    const front = search.findSolutions(fromId, toId, (/** @type {Solution[]} */ partial) => {
      self.postMessage({type: 'solutions', id, done: false, targetId: toId, solutions: search.curateSolutions(partial)})
    })
    self.postMessage({type: 'solutions', id, done: true, targetId: toId, solutions: search.curateSolutions(front)})
  } catch (e) {
    self.postMessage({type: 'solutions', id, done: true, targetId: toId, solutions: [], error: String(e && e.message || e)})
  }
}
