import { createSearch } from './search'
import { MapData } from './MapData'

/**
 * Runs Explore off the main thread. The search takes long enough to freeze the
 * page if done inline — seconds on a long route, and far worse on a phone — so
 * it stays here regardless of how fast the algorithm gets.
 *
 * The front is streamed back as it is found, so the list fills in rather than
 * appearing all at once. Replies carry the id of the request that caused them;
 * the main thread drops any whose id it has moved past, so a superseded search
 * costs correctness nothing.
 */
self.onmessage = (/** @type {MessageEvent} */ event) => {
  const {id, map, thrust, pivots, fuelNum, fuelDen, solarSeason, metricPriority, fromId, toId} = event.data
  const search = createSearch({mapData: MapData.fromJSON(map), thrust, pivots, fuelNum, fuelDen, solarSeason, metricPriority})

  try {
    const front = search.findSolutions(fromId, toId, (/** @type {Solution[]} */ partial) => {
      self.postMessage({id, done: false, targetId: toId, solutions: search.curateSolutions(partial)})
    })
    self.postMessage({id, done: true, targetId: toId, solutions: search.curateSolutions(front)})
  } catch (e) {
    self.postMessage({id, done: true, targetId: toId, solutions: [], error: String(e && e.message || e)})
  }
}
