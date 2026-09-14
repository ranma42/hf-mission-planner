import ReactDOM from 'react-dom'
import React from 'react'
import { zoom } from 'd3-zoom'
import { select } from 'd3-selection'

import './index.css'
import HFMap from '../assets/hf.png'
import HF4Map from '../assets/hf4.jpg'
import { createSearch, ALL_METRICS } from './search'
import { formatBurns } from './format'
import { Overlay } from './Overlay'
import { MapData } from './MapData'
import { createPanMomentum } from './panMomentum'

/** @typedef {import('d3-zoom').ZoomTransform} ZoomTransform */

const isHF3 = location.search === '?ed=3'

const map = new Image
map.src = isHF3 ? HFMap : HF4Map
main.textContent = 'loading...'

const canvas = document.createElement('canvas')
const overlay = document.createElement('div')
overlay.setAttribute('id', 'overlay')
map.onload = () => {
  main.textContent = ''
  main.appendChild(map)
  canvas.width = map.width
  canvas.height = map.height
  main.appendChild(canvas)
  document.body.appendChild(overlay)
  const margin = 0.25
  const z = zoom()
    .scaleExtent([0.2, 1.5])
    .translateExtent([[map.width*-margin,map.height*-margin],[map.width*(1+margin),map.height*(1+margin)]])
    .filter(e => {
      // Filter out events with #overlay as an ancestor
      let el = e.target
      while (el) {
        if (el.id === "overlay") return false
        el = el.parentElement
      }
      return !e.ctrlKey && !e.button
    })
  createPanMomentum({
    zoomBehavior: z,
    zoomTarget: document.documentElement,
    applyTransform: ({x, y, k}) => {
      main.style.transform = `translate(${x}px,${y}px) scale(${k})`
      main.style.transformOrigin = '0 0'
    },
  })
  select(document.documentElement).call(z).call(z.translateTo, 0.85 * canvas.width, 0.80 * canvas.height)
  draw()
}

let editing = false
let mapData = new MapData
/** @type {string|null} */
let connecting = null
/** @type {PathNode[]|null} */
let highlightedPath = null
/** @type {'red'|'yellow'|'blue'} */
let solarSeason = 'red'
/** @type {string|null} */
let pathOrigin = null
/** @type {PathData|null} */
let pathData = null

const siteTypeOptions = ['C', 'S', 'M', 'V', 'D', 'H']
/** @type {MetricKey[]} */
let metricPriority = ['fuel', 'turns', 'hazards', 'radHazards']
let isru = 0
let thrust = 12
/** Direction changes the vehicle may make per turn without spending burns. */
let pivots = 0
/** Tanks of fuel per burn, as a fraction. At 1/1 a burn costs a tank, which is
 * the model this one replaced; at 0/1 the drive burns nothing and thrust is the
 * only limit on it. */
let fuelNum = 1
let fuelDen = 1
/** @type {Set<string>} */
let enabledSiteTypes = new Set(siteTypeOptions)

/** @type {ReturnType<typeof createSearch>} */
let search
/** Rebuild the search after any change to the map or the vehicle it captured. */
function refreshSearch() {
  search = createSearch({mapData, thrust, pivots, fuelNum, fuelDen, solarSeason, metricPriority})
}

function cancelPathSelection() {
  connecting = null
  pathOrigin = null
  highlightedPath = null
  previewedPath = null
  exploring = false
  solutions = []
  cancelSearchWorker()
}

/** @param {MapDataJSON} json */
const loadData = (json) => {
  mapData = MapData.fromJSON(json)
  refreshSearch()
  setTimeout(draw, 0)
}

if ('data' in localStorage) {
  loadData(/** @type {MapDataJSON} */ (JSON.parse(localStorage.data)))
} else if (location.protocol !== 'file:') {
  if (isHF3) {
    import('../assets/data.json').then(({default: data}) => loadData(/** @type {MapDataJSON} */ (data)))
  } else {
    import('../assets/data-hf4.json').then(({default: data}) => loadData(/** @type {MapDataJSON} */ (data)))
  }
}

// Offline support. Registered only for real builds: during `start:dev` a
// service worker would serve yesterday's bundle back at you. The path is
// relative so it resolves under a project subpath on GitHub Pages, which also
// scopes the worker to the app rather than the whole origin.
if (__PROD__ && 'serviceWorker' in navigator) {
  // A new worker takes over immediately and deletes the previous build's cache.
  // Chunk filenames are not content-hashed, so a page left running on the old
  // bundle could otherwise lazy-load a chunk and get the new build's contents.
  // Reloading onto the version now being served avoids that mismatch entirely.
  // Only when a controller was already in place: the first registration also
  // fires this, and reloading then would be pointless.
  if (navigator.serviceWorker.controller) {
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      location.reload()
    })
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'})
      .catch(e => console.warn('service worker registration failed', e))
  })
}

function changed() {
  localStorage.data = JSON.stringify(mapData.toJSON())
  invalidateExploreCache()
}

function downloadFormattedJSON() {
  const formatted = JSON.stringify(mapData.toJSON(), null, 2) + '\n'
  const blob = new Blob([formatted], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = isHF3 ? 'hf3-map-data.json' : 'hf4-map-data.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** @param {MouseEvent} e */
canvas.onclick = e => {
  if (editing) {
    const x = e.offsetX
    const y = e.offsetY
    const xPct = x / canvas.width
    const yPct = y / canvas.height
    const pointId = Math.random().toString()
    mapData.addPoint(pointId, {
      x: xPct,
      y: yPct,
      type: 'hohmann',
    })
    draw()
  } else {
    const closestId = nearestPoint(mousePos.x, mousePos.y, id => mapData.points[id].type !== 'decorative')
    if (!closestId) { return }

    if (canPath(closestId)) {
      highlightedPath = search.drawPath(pathData, pathOrigin, closestId)
      // @ts-ignore
      window.highlightedPath = highlightedPath
      endPathing()
      previewedPath = null
      recomputeSolutions()
    } else {
      beginPathing(closestId)
    }

    draw()
  }
}

/** @param {string} originId */
function beginPathing(originId) {
  pathOrigin = originId
  highlightedPath = null
  pathData = search.findPath(originId)
}

/** @param {string|null|undefined} closestId */
function canPath(closestId) {
  return closestId && pathOrigin && closestId !== pathOrigin
}

function endPathing() {
  pathOrigin = null
  pathData = null
}

function recomputeHighlightedPath() {
  const source = pathOrigin ?? highlightedPath?.[0].node
  if (source) {
    pathData = search.findPath(source)
    const pathDestination = highlightedPath?.[highlightedPath.length - 1].node
    if (pathDestination)
      highlightedPath = search.drawPath(pathData, source, pathDestination)
    previewedPath = null
    recomputeSolutions()
    draw()
  }
}

function refreshPath() {
  if (pathOrigin && pathData) {
    const closestId = nearestPoint(mousePos.x, mousePos.y, id => mapData.points[id].type !== 'decorative')

    if (canPath(closestId)) {
      const previousDestination = highlightedPath?.[highlightedPath.length - 1].node
      highlightedPath = search.drawPath(pathData, pathOrigin, closestId)
      const destination = highlightedPath?.[highlightedPath.length - 1].node
      // Follow the pointer while exploring, but only once it settles on a new
      // node — a search per mousemove would be all cancellation and no results.
      if (exploring && destination && destination !== previousDestination) scheduleSolutions()
    }
  }
}

/** @type {Vec2} */
const mousePos = {x: 0, y: 0} // pct
/** @param {MouseEvent} e */
canvas.onmousemove = e => {
  mousePos.x = e.offsetX / canvas.width
  mousePos.y = e.offsetY / canvas.height

  refreshPath()
  draw()
}

/**
 * @param {number} testX
 * @param {number} testY
 * @param {(id: string) => boolean} [filter]
 * @returns {string|undefined}
 */
function nearestPoint(testX, testY, filter = undefined) {
  let closest = null
  let dist = Infinity
  for (const pId in mapData.points) {
    if (filter && !filter(pId)) continue
    const {x, y} = mapData.points[pId]
    const dx = x - testX
    const dy = y - testY
    const testDist = Math.sqrt(dx*dx + dy*dy)
    if (testDist < dist) {
      closest = pId
      dist = testDist
    }
  }
  if (dist < 0.02)
    return closest
}

/** @param {number} a */
function clipToPi(a) {
  if (a < -Math.PI)
    return a + Math.PI * 2 * Math.abs(Math.floor((a + Math.PI) / (Math.PI * 2)))
  else if (a > Math.PI)
    return a - Math.PI * 2 * Math.abs(Math.ceil(((a - Math.PI) / (Math.PI * 2))))
  else
    return a
}

/** @param {number} testX @param {number} testY @returns {[string, string]|undefined} */
function nearestEdge(testX, testY) {
  const npId = nearestPoint(testX, testY)
  if (!npId) return
  const np = mapData.points[npId]
  const ns = mapData.neighborsOf(npId)
  const mdx = testX - np.x
  const mdy = testY - np.y
  const mouseAngle = Math.atan2(mdy, mdx)
  let minD = Infinity
  /** @type {[string, string]|null} */
  let closestEdge = null
  ns.forEach(otherEndId => {
    const otherEnd = mapData.points[otherEndId]
    const dy = otherEnd.y - np.y
    const dx = otherEnd.x - np.x
    const angle = Math.atan2(dy, dx)
    const dAngle = clipToPi(mouseAngle - angle)
    if (Math.abs(dAngle) < minD) {
      minD = Math.abs(dAngle)
      closestEdge = [npId, otherEndId]
    }
  })
  if (minD < Math.PI / 4 && closestEdge) {
    return closestEdge.sort()
  }
}

/** @param {KeyboardEvent} e */
window.onkeydown = e => {
  if (e.code === 'Escape') {
    cancelPathSelection()
  }
  if (editing) {
    if (e.code === 'KeyA') { // Add edge
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (connecting) {
        if (closestId && closestId !== connecting) {
          if (mapData.hasEdge(closestId, connecting))
            mapData.deleteEdge(closestId, connecting)
          else
            mapData.addEdge(closestId, connecting)
          changed()
          connecting = null
        }
      } else {
        if (closestId) connecting = closestId
      }
    }
    if (e.code === 'KeyM') { // Move point
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        mapData.points[closestId].x = mousePos.x
        mapData.points[closestId].y = mousePos.y
        changed()
      }
    }
    if (e.code === 'KeyX') { // Delete point
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        mapData.deletePoint(closestId)
        changed()
      }
    }
    if (e.code === 'KeyH') { // Set point type to hohmann
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        mapData.points[closestId].type = 'hohmann'
        changed()
      }
    }
    if (e.code === 'KeyL') { // Set point type to lagrange
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        mapData.points[closestId].type = 'lagrange'
        changed()
      }
    }
    if (e.code === 'KeyB') { // Set point type to burn / cycle through burn types
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        const p = mapData.points[closestId]
        if (p.type === 'burn') {
          if (p.landing == null) {
            p.landing = 1
          } else if (p.landing === 1) {
            p.landing = 0.5
          } else {
            delete p.landing
          }
        } else {
          p.type = 'burn'
        }
        changed()
      }
    }
    if (e.code === 'KeyD') { // Set point type to decorative
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        mapData.points[closestId].type = 'decorative'
        changed()
      }
    }
    if (e.code === 'KeyR') { // Set point type to radhaz
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        mapData.points[closestId].type = 'radhaz'
        changed()
      }
    }
    if (e.code === 'KeyZ') { // Toggle hazard
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        mapData.points[closestId].hazard = !mapData.points[closestId].hazard
        changed()
      }
    }
    if (e.code === 'KeyY') { // Set flyby boost / cycle boost size
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        const p = mapData.points[closestId]
        p.flybyBoost = ((!p.flybyBoost || p.flybyBoost === 'thrust' ? 0 : p.flybyBoost) + 1) % 5
        if (p.flybyBoost === 0)
          delete p.flybyBoost
        changed()
      }
    }
    if (e.code === 'KeyO') {
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        const p = mapData.points[closestId]
        p.flybyBoost = 'thrust'
        changed()
      }
    }
    if (e.code === 'KeyV') { // Set point type to be venus
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        const p = mapData.points[closestId]
        p.type = 'venus'
        p.flybyBoost = 2
        changed()
      }
    }
    if (e.code === 'KeyS') { // Set point type to site
      const closestId = nearestPoint(mousePos.x, mousePos.y)
      if (closestId) {
        const p = mapData.points[closestId]
        p.type = 'site'
        const name = prompt("Site name", p.siteName)
        const size = prompt("Site size + type", p.siteSize)
        const water = prompt("Site water", p.siteWater != null ? String(p.siteWater) : '')
        const synodic = prompt("Synodic?", p.siteSynodic != null ? String(p.siteSynodic) : '')
        if (name !== null) p.siteName = name
        if (size !== null) p.siteSize = size
        if (synodic && (synodic === 'yellow' || synodic === 'blue' || synodic === 'red')) p.siteSynodic = synodic
        if (water !== null) {
          const parsed = Number(water)
          if (Number.isFinite(parsed)) {
            p.siteWater = parsed
          }
        }
        changed()
      }
    }
    if (e.code.startsWith('Digit')) { // Set edge label
      const label = e.code.slice(5)
      const np = nearestPoint(mousePos.x, mousePos.y)
      const ne = nearestEdge(mousePos.x, mousePos.y)
      if (np && ne) {
        const [a, b] = ne
        const other = a === np ? b : a
        mapData.setEdgeLabel(np, other, label)
        changed()
      }
    }
    if (e.code === 'KeyJ') { // Download formatted JSON
      downloadFormattedJSON()
      e.preventDefault()
    }
  }

  if (e.code === 'Tab') { // Toggle edit mode
    editing = !editing
    e.preventDefault()
  }

  draw()
}



const ints = {
  /** @type {number} */ zero: 0,
  /** @type {(a: number, b: number) => number} */ add: (a, b) => a + b,
  /** @type {(a: number, b: number) => boolean} */ lessThan: (a, b) => a < b
}
















/** @param {MapPoint} p @returns {number|null} */
function siteSizeValue(p) {
  if (!p.siteSize) return null
  const match = String(p.siteSize).match(/^\d+/)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) ? n : null
}

/** @param {MapPoint} p @returns {string|null} */
function siteTypeValue(p) {
  if (!p.siteSize) return null
  const match = String(p.siteSize).match(/[A-Za-z]+$/)
  if (!match) return null
  const letters = match[0]
  if (!letters.length) return null
  return letters[letters.length - 1].toUpperCase()
}

/** @param {MapPoint} p @returns {boolean} */
function isSiteTypeEnabled(p) {
  const type = siteTypeValue(p)
  if (!type) return true
  return enabledSiteTypes.has(type)
}

const solarSeasonOptions = ['red', 'yellow', 'blue']
const synodicStrokeColors = {
  red: '#ed1c25',
  yellow: '#fdf100',
  blue: '#01abef',
}

/** @param {MetricKey[]} order */
function setMetricPriority(order) {
  if (order.length !== metricPriority.length) return
  if (!order.every(m => metricPriority.includes(m))) return
  if (order.every((m, i) => m === metricPriority[i])) return
  metricPriority = order
  refreshSearch()
  solutions = sortSolutions(solutions)
  recomputeHighlightedPath()
  draw()
}



let exploring = false
/**
 * Alternatives already computed for the current origin, keyed by destination, so
 * revisiting a node costs nothing.
 * @type {{sourceId: string, byTarget: Map<string, Solution[]>}|null}
 */
let exploreCache = null
/** @type {Solution[]} */
let solutions = []
/** Pending debounced search; bursts of changes collapse into one run. */
let solutionsTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null)
/** True while a worker search is in flight; `solutions` may be partial. */
let solutionsComputing = false
/** @type {Worker|null} */
let searchWorker = null
/** Replies carrying an older id are from a superseded request and get dropped. */
let exploreRequestId = 0
/** @type {{id: number, sourceId: string, targetId: string}|null} */
let pendingExplore = null
/** Path shown on the map while hovering a solution, without committing to it. @type {PathNode[]|null} */
let previewedPath = null

/** Invalidate cached searches after anything that changes edge weights or reachability. */
/**
 * The Explore search runs off the main thread: it can take tens of seconds on a
 * long route, which would otherwise freeze the page. Returns null if workers are
 * unavailable, so the caller can fall back to computing inline.
 * @returns {Worker|null}
 */
/** Drop an in-flight search. The worker has no way to be interrupted mid-run, so
 * the only way to stop it eating the next request is to discard it outright. */
/**
 * Abandon the in-flight search. It cannot be interrupted from outside, so the
 * only way to stop it delaying the next request is to discard the worker.
 */
function cancelSearchWorker() {
  if (searchWorker) searchWorker.terminate()
  searchWorker = null
  pendingExplore = null
  solutionsComputing = false
}

function getSearchWorker() {
  if (searchWorker) return searchWorker
  if (typeof Worker === 'undefined') return null
  try {
    searchWorker = new Worker(new URL('./search.worker.js', import.meta.url))
  } catch (e) {
    console.warn('search worker unavailable, falling back to inline search', e)
    return null
  }
  searchWorker.onmessage = (event) => {
    const {id, done, targetId, solutions: found, error} = event.data
    if (!pendingExplore || id !== pendingExplore.id) return // superseded
    if (error) console.warn('search worker failed:', error)

    if (done) {
      cacheSolutions(pendingExplore.sourceId, targetId, found)
      pendingExplore = null
      solutionsComputing = false
    }
    solutions = sortSolutions(found)
    draw()
  }
  return searchWorker
}

/** @param {string} sourceId @param {string} targetId @param {Solution[]} found */
function cacheSolutions(sourceId, targetId, found) {
  if (!exploreCache || exploreCache.sourceId !== sourceId) {
    exploreCache = {sourceId, byTarget: new Map}
  }
  exploreCache.byTarget.set(targetId, found)
}

function invalidateExploreCache() {
  exploreCache = null
  if (exploring) scheduleSolutions()
}

/**
 * Recompute the alternatives once the input settles. Dragging the thrust slider
 * or sweeping the pointer across the map fires continuously, and each search can
 * run for seconds, so coalesce the burst rather than starting and killing a
 * worker per event.
 * @param {number} [delay]
 */
function scheduleSolutions(delay = 250) {
  if (solutionsTimer !== null) clearTimeout(solutionsTimer)
  solutionsTimer = setTimeout(() => {
    solutionsTimer = null
    recomputeSolutions()
    draw()
  }, delay)
}






/** @param {Solution} a @param {Solution} b @returns {boolean} true if `a` dominates `b` */
function dominates(a, b) {
  return ALL_METRICS.every(k => a.weight[k] <= b.weight[k]) && ALL_METRICS.some(k => a.weight[k] < b.weight[k])
}

/** Present the front in the user's current priority order, dropping anything a
 * kept solution dominates. @param {Solution[]} front @returns {Solution[]} */
function sortSolutions(front) {
  return front
    .filter(s => !front.some(other => other !== s && dominates(other, s)))
    .sort((a, b) => {
      const ka = solutionSortKey(a), kb = solutionSortKey(b)
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
      return 0
    })
}

/** @param {Solution} s @returns {number[]} */
function solutionSortKey(s) {
  return metricPriority.map(k => s.weight[k])
}

/**
 * Refresh the displayed trade-offs for the current path's endpoints. The front
 * itself does not depend on `metricPriority` — that only sorts it — so a
 * priority change re-sorts from cache rather than searching again.
 */
function recomputeSolutions() {
  solutions = []
  if (!exploring || !highlightedPath) {
    cancelSearchWorker()
    return
  }
  const fromId = highlightedPath[0].node
  const toId = highlightedPath[highlightedPath.length - 1].node

  // Already doing exactly this work; let it finish.
  if (pendingExplore && pendingExplore.sourceId === fromId && pendingExplore.targetId === toId) return

  const cache = exploreCache && exploreCache.sourceId === fromId ? exploreCache : null
  const cached = cache && cache.byTarget.get(toId)
  if (cached) {
    cancelSearchWorker()
    solutions = sortSolutions(cached)
    return
  }

  // Anything else in flight is no longer wanted, and cannot be interrupted, so
  // discard it rather than let it delay this request.
  cancelSearchWorker()

  const worker = getSearchWorker()
  if (!worker) {
    // No worker available: block, as this used to, rather than lose the feature.
    const found = search.curateSolutions(search.findSolutions(fromId, toId))
    cacheSolutions(fromId, toId, found)
    solutions = sortSolutions(found)
    return
  }

  const id = ++exploreRequestId
  pendingExplore = {id, sourceId: fromId, targetId: toId}
  solutionsComputing = true
  worker.postMessage({
    id,
    map: mapData.toJSON(),
    thrust, pivots, fuelNum, fuelDen, solarSeason, metricPriority,
    fromId, toId,
  })
}


function toggleExplore() {
  exploring = !exploring
  previewedPath = null
  recomputeSolutions()
  draw()
}


/** @param {PathNode[]|null} path */
function previewSolution(path) {
  if (previewedPath === path) return
  previewedPath = path
  draw()
}

/** @param {PathNode[]} path */
function chooseSolution(path) {
  highlightedPath = path
  previewedPath = null
  draw()
}

/** @param {number} e */
function setIsru(e) {
  isru = e
  draw()
}

const MAX_PIVOTS = 5

/** @param {number} value */
function setPivots(value) {
  const clamped = Math.max(0, Math.min(MAX_PIVOTS, Math.round(value)))
  if (clamped === pivots) return
  pivots = clamped
  refreshSearch()
  invalidateExploreCache()
  recomputeHighlightedPath()
  draw()
}

/** @param {number} num */
function setFuelNum(num) {
  const clamped = Math.max(0, Math.round(num))
  if (clamped === fuelNum) return
  fuelNum = clamped
  refreshSearch()
  invalidateExploreCache()
  recomputeHighlightedPath()
  draw()
}

/** @param {number} den */
function setFuelDen(den) {
  const clamped = Math.max(1, Math.round(den))
  if (clamped === fuelDen) return
  fuelDen = clamped
  refreshSearch()
  invalidateExploreCache()
  recomputeHighlightedPath()
  draw()
}

/** @param {number} value */
function setThrust(value) {
  const rounded = Math.round(value)
  const clamped = Math.max(1, Math.min(15, rounded))
  thrust = clamped
  refreshSearch()
  invalidateExploreCache()
  recomputeHighlightedPath()
}

/** @param {string} type */
function toggleSiteType(type) {
  if (!siteTypeOptions.includes(type)) return
  const next = new Set(enabledSiteTypes)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  enabledSiteTypes = next
  draw()
}

/** @param {'red'|'yellow'|'blue'} season */
function setSolarSeason(season) {
  if (!solarSeasonOptions.includes(season)) return
  solarSeason = season
  refreshSearch()
  invalidateExploreCache()
  recomputeHighlightedPath()
  draw()
}

/** @param {MapPoint} p @param {number} width @param {number} height */
function toCanvasPoint(p, width, height) {
  return { x: p.x * width, y: p.y * height }
}

/**
 * Draw a catmull-rom spline through the provided points, which can include
 * decorative points as intermediate handles.
 * @param {CanvasRenderingContext2D} ctx
 * @param {MapPoint[]} pts
 * @param {number} width
 * @param {number} height
 */
function drawSplineSegment(ctx, pts, width, height) {
  if (pts.length < 2) return
  const canvasPts = pts.map(p => toCanvasPoint(p, width, height))
  for (let i = 0; i < canvasPts.length - 1; i++) {
    const p0 = canvasPts[i - 1] || canvasPts[i]
    const p1 = canvasPts[i]
    const p2 = canvasPts[i + 1]
    const p3 = canvasPts[i + 2] || p2
    const cp1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const cp2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y)
  }
}

function draw() {
  if (!mapData) return
  const { points, edges, edgeLabels } = mapData
  const ctx = canvas.getContext('2d')
  const {width, height} = ctx.canvas
  const venusFlybyAvailable = solarSeason === 'blue'
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.lineWidth = 2
  const nearestToCursor = nearestPoint(mousePos.x, mousePos.y)
  if (editing) {
    const unlabeledHohmannEdges = mapData.hohmannEdgesMissingLabels()
    const unlabeledEdgeMidpoints = []
    const seenUnlabeledEdges = new Set
    for (const { node, neighbor } of unlabeledHohmannEdges) {
      const key = [node, neighbor].sort().join(':')
      if (seenUnlabeledEdges.has(key)) continue
      seenUnlabeledEdges.add(key)
      const a = points[node]
      const b = points[neighbor]
      if (!a || !b) continue
      unlabeledEdgeMidpoints.push({
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      })
    }
    const ce = nearestEdge(mousePos.x, mousePos.y)
    edges.forEach(e => {
      const [a, b] = e.split(":")
      const pa = points[a]
      const pb = points[b]
      if (ce && ce[0] === a && ce[1] === b) {
        ctx.strokeStyle = 'lightgreen'
      } else {
        ctx.strokeStyle = 'white'
      }
      ctx.beginPath()
      ctx.moveTo(pa.x * width, pa.y * height)
      ctx.lineTo(pb.x * width, pb.y * height)
      ctx.stroke()
    })
    if (unlabeledEdgeMidpoints.length) {
      ctx.save()
      const glowRadius = 22
      const innerRadius = 16
      const fillRadius = 12
      const glowAlpha = 0.6
      const fillAlpha = 0.35
      unlabeledEdgeMidpoints.forEach(({x, y}) => {
        const cx = x * width
        const cy = y * height
        // Outer glow
        ctx.save()
        ctx.strokeStyle = `rgba(255,0,0,${glowAlpha})`
        ctx.lineWidth = 14
        ctx.shadowBlur = 12
        ctx.shadowColor = `rgba(255,0,0,0.8)`
        ctx.beginPath()
        ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
        // Inner ring
        ctx.save()
        ctx.strokeStyle = '#ffefef'
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
        // Center fill
        ctx.save()
        ctx.fillStyle = `rgba(255,0,0,${fillAlpha})`
        ctx.beginPath()
        ctx.arc(cx, cy, fillRadius, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      })
      ctx.restore()
    }
    for (let pId in points) {
      const p = points[pId]
      ctx.fillStyle = 'transparent'
      ctx.strokeStyle = 'white'
      if (p.type === 'hohmann') {
        ctx.fillStyle = 'green'
      } else if (p.type === 'lagrange') {
        ctx.fillStyle = 'transparent'
        ctx.strokeStyle = '#c66932'
        if (p.hazard) {
          ctx.fillStyle = '#d5cde5'
        }
      } else if (p.type === 'radhaz') {
        ctx.fillStyle = 'yellow'
      } else if (p.type === 'venus') {
        ctx.fillStyle = 'orange'
      } else if (p.type === 'site') {
        ctx.fillStyle = 'black'
        if (p.siteSynodic) {
          ctx.strokeStyle = synodicStrokeColors[p.siteSynodic] ?? 'white'
        }
      } else if (p.type === 'burn') {
        ctx.fillStyle = '#d60f7a'
      } else {
        ctx.fillStyle = 'cornflowerblue'
      }
      if (nearestToCursor === pId) {
        ctx.fillStyle = 'red'
      }
      const r = p.type === 'decorative' ? 3 : 10
      ctx.beginPath()
      if (p.type === 'site') {
        ctx.save()
        ctx.translate(p.x * width, p.y * height)
        const siteR = 15
        ctx.moveTo(siteR, 0)
        for (let t = 1; t < Math.PI*2; t += Math.PI*2/6) {
          ctx.lineTo(Math.cos(t) * siteR, Math.sin(t) * siteR)
        }
        ctx.closePath()
        ctx.restore()
      } else if (p.type === 'burn' && p.landing) {
        ctx.rect(p.x * width - r, p.y * height - r, r * 2 * p.landing, r * 2)
      } else {
        ctx.arc(p.x * width, p.y * height, r, 0, Math.PI*2)
      }
      ctx.fill()
      ctx.stroke()
      if (p.hazard) {
        ctx.save()
        ctx.fillStyle = p.type === 'burn' ? 'white' : 'black'
        ctx.font = '22px menlo'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('☠︎', p.x * width, p.y * height)
        ctx.restore()
      }
      if (p.flybyBoost) {
        ctx.save()
        ctx.fillStyle = 'white'
        ctx.shadowOffsetX = 1
        ctx.shadowOffsetY = 1
        ctx.shadowColor = 'black'
        ctx.font = '14px helvetica'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(`+${p.flybyBoost === 'thrust' ? 'T' : p.flybyBoost}`, p.x * width, p.y * height)
        ctx.restore()
      }
      if (p.type === 'site') {
        ctx.save()
        ctx.fillStyle = 'white'
        ctx.font = '12px helvetica'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(`${p.siteSize}`, p.x * width, p.y * height - 6)
        ctx.fillText(`${p.siteWater}`, p.x * width, p.y * height + 6)
        ctx.restore()
      }

      ctx.save()
      ctx.fillStyle = 'white'
      ctx.shadowOffsetX = 1
      ctx.shadowOffsetY = 1
      ctx.shadowColor = 'black'
      ctx.font = '12px helvetica'
      for (let otherId in (edgeLabels[pId] || {})) {
        const otherPoint = points[otherId]
        const label = edgeLabels[pId][otherId]
        const dx = (otherPoint.x - p.x) * width
        const dy = (otherPoint.y - p.y) * height
        const d = Math.sqrt(dx * dx + dy * dy)
        const nx = dx / d
        const ny = dy / d
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        const displacement = 12
        ctx.fillText(label, p.x * width + nx * displacement, p.y * height + ny * displacement)
      }
      ctx.restore()
    }
  } else {
    for (let pId in points) {
      const p = points[pId]
      if (p.type === 'venus') {
        if (!venusFlybyAvailable) {
          ctx.save()
          ctx.lineWidth = 8
          ctx.strokeStyle = "red"
          ctx.lineCap = "round"
          ctx.beginPath()
          const r = 15
          ctx.moveTo(p.x * width - r, p.y * height - r)
          ctx.lineTo(p.x * width + r, p.y * height + r)
          ctx.moveTo(p.x * width + r, p.y * height - r)
          ctx.lineTo(p.x * width - r, p.y * height + r)
          ctx.stroke()
          ctx.restore()
        }
      }
    }
    const nearest = nearestPoint(mousePos.x, mousePos.y, id => points[id].type !== 'decorative')
    if (nearest != null) {
      const p = points[nearest]
      ctx.save()
      ctx.strokeStyle = "yellow"
      ctx.lineWidth = 4
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 5
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, 15, 0, 2*Math.PI)
      ctx.stroke()
      ctx.restore()
    }
    if (pathOrigin != null) {
      const p = points[pathOrigin]
      ctx.save()
      ctx.strokeStyle = "red"
      ctx.lineWidth = 4
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 5
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, 15, 0, 2*Math.PI)
      ctx.stroke()
      ctx.restore()

      for (const pId in points) {
        if (pId === pathOrigin) continue;
        const p = points[pId]
        const siteWater = Number(p.siteWater ?? 0)
        const siteSize = siteSizeValue(p)
        const hasThrust = siteSize != null && thrust > siteSize
        const matchesSynodicSeason = p.siteSynodic == null || p.siteSynodic === solarSeason
        if (p.type === 'site' && siteWater >= isru && hasThrust && isSiteTypeEnabled(p) && matchesSynodicSeason) {
          ctx.save()
          ctx.font = 'bold 70px helvetica'
          ctx.shadowColor = 'black'
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 0
          ctx.shadowBlur = 10
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'center'
          const path = search.drawPath(pathData, pathOrigin, pId)
          // pathWeight reports zero for a missing path, which is indistinguishable
          // from a genuinely free one, so unreachable sites have to be skipped here
          // rather than filtered out by the label coming back empty.
          if (!path) {
            ctx.restore()
            continue
          }
          const burns = search.pathWeight(path).burns ?? 0
          const colors = [
            '#ffffb2',
            '#fecc5c',
            '#fd8d3c',
            '#f03b20',
            '#bd0026',
          ]
          ctx.fillStyle = colors[Math.min(colors.length - 1, Math.ceil(burns))]
          ctx.fillText(formatBurns(burns), p.x * width, p.y * height)
          ctx.restore()
        }
      }
    }
  }
  // A hovered solution previews on the map without replacing the committed path.
  const shownPath = previewedPath ?? highlightedPath
  if (shownPath) {
    ctx.save()
    const highlightedLineWidth = 20
    ctx.lineWidth = highlightedLineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(214,15,122,0.7)'
    const p0 = mapData.points[shownPath[0].node]
    ctx.beginPath()
    ctx.moveTo(p0.x * width, p0.y * height)
    /** @type {MapPoint[]} */
    let segmentPoints = [p0]
    let segmentHasDecorative = false

    for (let i = 1; i < shownPath.length; i++) {
      const currentPoint = mapData.points[shownPath[i].node]
      segmentPoints.push(currentPoint)
      segmentHasDecorative = segmentHasDecorative || currentPoint.type === 'decorative'

      const isAnchor = currentPoint.type !== 'decorative'
      const isLast = i === shownPath.length - 1
      if (isAnchor || isLast) {
        if (segmentPoints.length > 1) {
          if (!segmentHasDecorative && segmentPoints.length === 2) {
            const end = segmentPoints[1]
            ctx.lineTo(end.x * width, end.y * height)
          } else {
            drawSplineSegment(ctx, segmentPoints, width, height)
          }
        }
        segmentPoints = [currentPoint]
        segmentHasDecorative = false
      }
    }
    ctx.stroke()
    ctx.restore()
    ctx.save()
    ctx.lineWidth = 4
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    for (let i = 1; i < shownPath.length - 1; i++) {
      const p = shownPath[i]
      const next = shownPath[i + 1]
      if (search.turnWeight(p, next) > 0) {
        const { node: prevId } = shownPath[i - 1]
        const { node: pId } = p
        const nextDifferentNode = shownPath.slice(i + 1).find(p => p.node !== pId)
        if (!nextDifferentNode) continue
        const nextP = mapData.points[nextDifferentNode.node]
        const prevP = mapData.points[prevId]
        const currP = mapData.points[pId]
        const marker = pauseMarkerSpan(prevP, currP, nextP, highlightedLineWidth, width, height)
        if (!marker) continue
        const { dir, pos, neg } = marker
        ctx.beginPath()
        ctx.moveTo(currP.x * width - dir.x * neg, currP.y * height - dir.y * neg)
        ctx.lineTo(currP.x * width + dir.x * pos, currP.y * height + dir.y * pos)
        ctx.stroke()
      }
    }
    ctx.restore()
  }
  const weight = search.pathWeight(highlightedPath)
  ReactDOM.render(React.createElement(Overlay, {mapData, path: highlightedPath, weight, metricPriority, setMetricPriority, exploring, toggleExplore, solutions, solutionsComputing, previewSolution, chooseSolution, cancelPath: () => { cancelPathSelection(); draw() }, isru, setIsru, thrust, setThrust, pivots, setPivots, fuelNum, setFuelNum, fuelDen, setFuelDen, enabledSiteTypes, toggleSiteType, solarSeason, setSolarSeason}), overlay)
}


/**
 * @param {MapPoint} prev
 * @param {MapPoint} curr
 * @param {MapPoint} next
 * @param {number} lineWidth
 * @param {number} width
 * @param {number} height
 * @returns {{dir: Vec2, pos: number, neg: number}|null}
 */
function pauseMarkerSpan(prev, curr, next, lineWidth, width, height) {
  /** @param {{x: number, y: number}} param0 */
  const toCanvas = ({ x, y }) => ({ x: x * width, y: y * height })
  const a = toCanvas(prev)
  const b = toCanvas(curr)
  const c = toCanvas(next)

  const vIn = { x: b.x - a.x, y: b.y - a.y }
  const vOut = { x: c.x - b.x, y: c.y - b.y }
  const normIn = Math.hypot(vIn.x, vIn.y)
  const normOut = Math.hypot(vOut.x, vOut.y)
  if (normIn === 0 || normOut === 0) return null

  const uIn = { x: vIn.x / normIn, y: vIn.y / normIn }
  const uOut = { x: vOut.x / normOut, y: vOut.y / normOut }

  const bisectorDir = { x: uIn.x + uOut.x, y: uIn.y + uOut.y }
  const bisectorLen = Math.hypot(bisectorDir.x, bisectorDir.y)
  const dir = bisectorLen === 0
    ? { x: -uIn.y, y: uIn.x }
    : { x: -bisectorDir.y / bisectorLen, y: bisectorDir.x / bisectorLen }

  const radius = lineWidth / 2

  /** @param {Vec2} p @param {Vec2} s0 @param {Vec2} s1 */
  const distToSegment = (p, s0, s1) => {
    const vx = s1.x - s0.x
    const vy = s1.y - s0.y
    const l2 = vx * vx + vy * vy
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s0.x) * vx + (p.y - s0.y) * vy) / l2))
    const proj = { x: s0.x + t * vx, y: s0.y + t * vy }
    return Math.hypot(p.x - proj.x, p.y - proj.y)
  }

  /** @param {number} t */
  const strokeDistance = (t) => {
    const p = { x: b.x + dir.x * t, y: b.y + dir.y * t }
    return Math.min(distToSegment(p, a, b), distToSegment(p, b, c))
  }

  /** @param {number} sign */
  const extent = (sign) => {
    const maxT = radius * 20
    /** @param {number} t */
    const inside = (t) => strokeDistance(sign * t) <= radius
    if (!inside(0)) return 0

    let t = radius
    while (inside(t) && t < maxT) {
      t *= 2
    }
    let lo = 0
    let hi = Math.min(t, maxT)
    for (let i = 0; i < 25; i++) {
      const mid = (lo + hi) / 2
      if (inside(mid)) lo = mid
      else hi = mid
    }
    return lo
  }

  const pos = extent(1)
  const neg = extent(-1)

  if (pos === 0 && neg === 0) return null
  return { dir, pos, neg }
}

// Debug handle for benchmarking and console poking, in the same spirit as
// `window.highlightedPath` above.
// @ts-ignore
window.planner = {
  get mapData() { return mapData },
  get metricPriority() { return metricPriority },
  get thrust() { return thrust },
  get pivots() { return pivots },
  setPivots,
  get fuelNum() { return fuelNum },
  setFuelNum,
  get fuelDen() { return fuelDen },
  setFuelDen,
  setThrust,
  get search() { return search },
  get solutions() { return solutions },
  /** Enter destination-picking mode, as clicking an origin does. */
  beginPathingForTest: (/** @type {string} */ originId) => { exploring = true; beginPathing(originId); draw() },
  /** Destination of the path currently shown. */
  currentDestination: () => highlightedPath?.[highlightedPath.length - 1].node ?? null,
  /** Destination the cached/in-flight alternatives are for. */
  exploreTargetId: () => pendingExplore?.targetId ?? null,
  exploreCachedTargets: () => [...(exploreCache?.byTarget.keys() ?? [])],
  get solutionsComputing() { return solutionsComputing },
  /** Set up and kick off an Explore for a pair of nodes, as clicking would. */
  explore: (/** @type {string} */ fromId, /** @type {string} */ toId, /** @type {boolean} */ cold = false) => {
    highlightedPath = search.drawPath(search.findPath(fromId), fromId, toId) ?? null
    exploring = true
    if (cold) invalidateExploreCache()
    recomputeSolutions()
    return !!highlightedPath
  },
}
