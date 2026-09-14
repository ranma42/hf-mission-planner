import { createSearch } from './search'
import { MapData } from './MapData'

/**
 * Runs Explore off the main thread. The search can take tens of seconds on long
 * routes, which freezes the page if done inline; here the map is rebuilt from a
 * plain snapshot and the front is streamed back as it is discovered.
 *
 * Requests are answered in order, and the main thread discards replies whose id
 * it has moved past, so a superseded search costs correctness nothing.
 */
self.onmessage = (/** @type {MessageEvent} */ event) => {
  const {id, map, thrust, solarSeason, metricPriority, fromId, toId} = event.data
  const search = createSearch({mapData: MapData.fromJSON(map), thrust, solarSeason, metricPriority})

  try {
    const front = search.findSolutions(fromId, toId, (partial) => {
      self.postMessage({id, done: false, solutions: search.curateSolutions(partial)})
    })
    self.postMessage({id, done: true, solutions: search.curateSolutions(front)})
  } catch (e) {
    self.postMessage({id, done: true, solutions: [], error: String(e && e.message || e)})
  }
}
