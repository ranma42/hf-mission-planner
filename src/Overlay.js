import React from 'react'
import { formatMetric } from './format'
import { TRACKED_METRICS } from './search'

const e = React.createElement

/** @param {number} n @param {string} sg @param {string} pl */
const pl = (n, sg, pl) => n === 1 ? `${n} ${sg}` : `${n} ${pl}`

/** @typedef {import('./MapData').MapData} MapData */

/** @param {MetricKey[]} order @param {MetricKey} key @param {MetricKey} target @returns {MetricKey[]} */
function moveMetricTo(order, key, target) {
  const from = order.indexOf(key)
  const to = order.indexOf(target)
  if (from < 0 || to < 0 || from === to) return order
  const next = [...order]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

/** @typedef {{weight: MetricWeights, path: PathNode[]}} Solution */

const metricMeta = {
  fuel: {sg: 'tank', pl: 'tanks', abbr: 'F'},
  turns: {sg: 'turn', pl: 'turns', abbr: 'T'},
  hazards: {sg: 'hazard', pl: 'hazards', abbr: 'H'},
  radHazards: {sg: 'rad hazard', pl: 'rad hazards', abbr: 'R'},
  burns: {sg: 'burn', pl: 'burns', abbr: 'B'},
  pivots: {sg: 'pivot', pl: 'pivots', abbr: 'P'},
}

/** @param {{metrics: MetricKey[], solutions: Solution[], solutionsComputing: boolean, weight: MetricWeights, previewSolution: (path: PathNode[]|null) => void, chooseSolution: (path: PathNode[]) => void}} props */
function SolutionList({metrics, solutions, solutionsComputing, weight, previewSolution, chooseSolution}) {
  if (!solutions.length) return e('div', {className: 'PathInfo-empty'},
    solutionsComputing ? 'Searching…' : 'No alternatives found')

  /** @type {(MetricKey|TrackedKey)[]} */
  const columns = [...metrics, ...TRACKED_METRICS]

  // Each row is its own flex container, so without a shared width a wide figure
  // widens only its own row and the columns go ragged. Size every cell to the
  // widest value in the table instead.
  const widest = solutions.reduce((max, s) =>
    columns.reduce((m, key) => Math.max(m, formatMetric(key, s.weight[key]).length), max), 2)

  /** The read-outs are not part of the trade-off, so rule them off from the
   * metrics rather than letting the eye read six equal columns.
   * @param {MetricKey|TrackedKey} key */
  const cellClass = (key) =>
    'PathInfo-solutionCell' + (key === TRACKED_METRICS[0] ? ' PathInfo-solutionCell--tracked' : '')

  return e('div', {
    className: 'PathInfo-solutions',
    style: {'--solution-cell': `${widest + 0.3}ch`},
    onMouseLeave: () => previewSolution(null),
  },
    solutionsComputing ? e('div', {className: 'PathInfo-searching'}, 'Searching… best so far') : null,
    e('div', {className: 'PathInfo-solutionRow PathInfo-solutionHeader'},
      columns.map(key =>
        e('span', {key, className: cellClass(key), title: metricMeta[key].pl}, metricMeta[key].abbr)
      )
    ),
    solutions.map((solution, i) => {
      const current = metrics.every(key => solution.weight[key] === weight[key])
      return e('button', {
        key: i,
        type: 'button',
        className: 'PathInfo-solutionRow PathInfo-solutionButton' + (current ? ' selected' : ''),
        'aria-pressed': current,
        title: columns.map(key => pl(solution.weight[key], metricMeta[key].sg, metricMeta[key].pl)).join(', '),
        onMouseEnter: () => previewSolution(solution.path),
        onFocus: () => previewSolution(solution.path),
        onClick: () => chooseSolution(solution.path),
      },
        columns.map(key =>
          e('span', {key, className: cellClass(key)}, formatMetric(key, solution.weight[key]))
        )
      )
    })
  )
}

/** @param {{mapData: MapData, path: PathNode[]|null, weight: MetricWeights, metricPriority: MetricKey[], setMetricPriority: (order: MetricKey[]) => void, exploring: boolean, toggleExplore: () => void, solutions: Solution[], solutionsComputing: boolean, previewSolution: (path: PathNode[]|null) => void, chooseSolution: (path: PathNode[]) => void, cancelPath: () => void}} props */
function PathInfo({mapData, path, weight, metricPriority, setMetricPriority, exploring, toggleExplore, solutions, solutionsComputing, previewSolution, chooseSolution, cancelPath}) {
  /** @type {[{key: MetricKey, order: MetricKey[]}|null, (drag: {key: MetricKey, order: MetricKey[]}|null) => void]} */
  const [drag, setDrag] = React.useState(null)

  if (!path) return e('div')

  const sourcePoint = path ? mapData.points[path[0].node] : null
  const destinationPoint = path ? mapData.points[path[path.length - 1].node] : null

  // While dragging, show the previewed order; commit it only on drop.
  const displayOrder = drag ? drag.order : metricPriority

  /** Swap with the neighbouring *visible* metric, stepping over hidden ones.
   * @param {MetricKey} key @param {number} delta */
  const moveBy = (key, delta) => {
    const target = displayOrder[displayOrder.indexOf(key) + delta]
    if (!target) return
    setMetricPriority(moveMetricTo(metricPriority, key, target))
  }

  /** @param {React.DragEvent} ev @param {MetricKey} key */
  const onDragOverRow = (ev, key) => {
    if (!drag) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    if (key === drag.key) return
    const next = moveMetricTo(drag.order, drag.key, key)
    if (next !== drag.order) setDrag({key: drag.key, order: next})
  }

  return e('div', {className: 'PathInfo'},
    exploring ? e(SolutionList, {metrics: displayOrder, solutions, solutionsComputing, weight, previewSolution, chooseSolution}) : displayOrder.map((key, i) => {
      const {sg, pl: plural} = metricMeta[key]
      return e('div', {
        key,
        className: 'PathInfo-row PathInfo-metricRow' + (drag && drag.key === key ? ' dragging' : ''),
        draggable: true,
        onDragStart: (/** @type {React.DragEvent} */ ev) => {
          if (ev.dataTransfer) {
            ev.dataTransfer.effectAllowed = 'move'
            // Firefox requires some data to be set for a drag to start.
            ev.dataTransfer.setData('text/plain', key)
          }
          setDrag({key, order: displayOrder})
        },
        onDragOver: (/** @type {React.DragEvent} */ ev) => onDragOverRow(ev, key),
        onDrop: (/** @type {React.DragEvent} */ ev) => {
          ev.preventDefault()
          if (drag) setMetricPriority(drag.order)
          setDrag(null)
        },
        onDragEnd: () => setDrag(null),
      },
        e('span', {className: 'PathInfo-dragHandle', 'aria-hidden': true}, '⠿'),
        e('span', {className: 'PathInfo-label'}, `${pl(weight[key], sg, plural)}`),
        e('span', {className: 'PathInfo-priorityButtons'},
          e('button', {
            type: 'button',
            className: 'PathInfo-priorityButton',
            'aria-label': `Increase priority of ${plural}`,
            title: `Increase priority of ${plural}`,
            disabled: i === 0,
            onClick: () => moveBy(key, -1),
          }, '⬆'),
          e('button', {
            type: 'button',
            className: 'PathInfo-priorityButton',
            'aria-label': `Decrease priority of ${plural}`,
            title: `Decrease priority of ${plural}`,
            disabled: i === displayOrder.length - 1,
            onClick: () => moveBy(key, 1),
          }, '⬇'),
        ),
      )
    }),
    exploring ? null : TRACKED_METRICS.map(key => {
      const {sg, pl: plural} = metricMeta[key]
      return e('div', {key, className: 'PathInfo-row PathInfo-trackedRow'},
        e('span', {className: 'PathInfo-label'}, `${pl(weight[key], sg, plural)}`),
      )
    }),
    e('div', {className: 'PathInfo-row PathInfo-destinationRow'},
      e('span', {className: 'PathInfo-destination'}, `${sourcePoint?.siteName ?? '\u2022'} \u2192 ${destinationPoint?.siteName ?? '\u2022'}`),
      e('button', {
        type: 'button',
        className: 'PathInfo-cancelButton',
        'aria-label': 'Cancel path',
        onClick: cancelPath,
      }, '\u2715'),
    ),
    e('button', {
      type: 'button',
      className: 'PathInfo-exploreButton' + (exploring ? ' selected' : ''),
      'aria-pressed': exploring,
      onClick: toggleExplore,
    }, exploring ? '\u2190 Priorities' : 'Explore alternatives'),
  )
}

const isruLevels = [0, 1, 2, 3, 4]

const pivotLevels = [0, 1, 2, 3, 4, 5]

const siteTypeOptions = ['C', 'S', 'M', 'V', 'D', 'H']

const solarSeasonOptions = ['red', 'yellow', 'blue']

/** @param {{isru: number, setIsru: (value: number) => void, thrust: number, setThrust: (value: number) => void, pivots: number, setPivots: (value: number) => void, fuelNum: number, setFuelNum: (value: number) => void, fuelDen: number, setFuelDen: (value: number) => void, enabledSiteTypes: Set<string>, toggleSiteType: (type: string) => void, solarSeason: string, setSolarSeason: (value: string) => void}} param0 */
function VehicleInfo({isru, setIsru, thrust, setThrust, pivots, setPivots, fuelNum, setFuelNum, fuelDen, setFuelDen, enabledSiteTypes, toggleSiteType, solarSeason, setSolarSeason}) {
  /** @param {string} value */
  const updateThrust = (value) => {
    const n = Number(value)
    if (Number.isNaN(n)) return
    setThrust(n)
  }

  /** @param {(value: number) => void} set @param {string} value */
  const updateFuel = (set, value) => {
    const n = Number(value)
    if (Number.isNaN(n)) return
    set(n)
  }

  return e('details', {className: 'VehicleInfo', open: true},
    e('summary', {className: 'vehicle-info-summary'},
      e('span', {className: 'vehicle-info-icon'}, '🚀'),
      e('span', {className: 'vehicle-info-title'}, 'Vehicle Info'),
    ),
    e('div', {className: 'vehicle-info-body'},
      e('div', {className: 'field', role: 'group', 'aria-label': 'Thrust'},
        e('div', {className: 'label-row'},
          e('span', {className: 'label'}, 'Thrust')
        ),
        e('div', {className: 'thrust-inputs'},
          e('input', {
            type: 'range',
            min: 1,
            max: 15,
            step: 1,
            value: thrust,
            onChange: (ev) => updateThrust(ev.target.value),
          }),
          e('input', {
            type: 'number',
            min: 1,
            max: 15,
            step: 1,
            value: thrust,
            inputMode: 'numeric',
            onChange: (ev) => updateThrust(ev.target.value),
          }),
        )
      ),
      e('div', {className: 'field', role: 'group', 'aria-label': 'Fuel per Burn'},
        e('div', {className: 'label-row'},
          e('span', {className: 'label'}, 'Fuel per Burn'),
        ),
        e('div', {className: 'fuel-rate-inputs'},
          e('input', {
            type: 'number',
            className: 'fuel-rate-field',
            min: 0,
            step: 1,
            value: fuelNum,
            inputMode: 'numeric',
            'aria-label': 'Tanks',
            onChange: (ev) => updateFuel(setFuelNum, ev.target.value),
          }),
          e('span', {className: 'fuel-rate-separator', 'aria-hidden': true}, '/'),
          e('input', {
            type: 'number',
            className: 'fuel-rate-field',
            min: 1,
            step: 1,
            value: fuelDen,
            inputMode: 'numeric',
            'aria-label': 'Burns',
            onChange: (ev) => updateFuel(setFuelDen, ev.target.value),
          }),
        )
      ),
      e('div', {className: 'field', role: 'group', 'aria-label': 'Pivots'},
        e('div', {className: 'label-row'},
          e('span', {className: 'label'}, 'Pivots'),
        ),
        e('div', {className: 'isru-buttons'},
          pivotLevels.map(level =>
            e('button', {
              key: level,
              type: 'button',
              className: 'isru-button' + (pivots === level ? ' selected' : ''),
              'aria-pressed': pivots === level,
              onClick: () => setPivots(level),
            }, String(level))
          )
        )
      ),
      e('div', {className: 'field', role: 'group', 'aria-label': 'Solar Season'},
        e('div', {className: 'label-row'},
          e('span', {className: 'label'}, 'Solar Season'),
        ),
        e('div', {className: 'solar-season-buttons'},
          solarSeasonOptions.map(season =>
          e('button', {
            key: season,
            type: 'button',
            className: `solar-season-button solar-season-${season}` + (solarSeason === season ? ' selected' : ''),
            'aria-pressed': solarSeason === season,
            onClick: () => setSolarSeason(season),
          }, season[0].toUpperCase() + season.slice(1))
        )
        )
      ),
      e('div', {className: 'field', role: 'group', 'aria-label': 'Site Hydration'},
        e('span', {className: 'label'}, 'Site Hydration'),
        e('div', {className: 'isru-buttons'},
          isruLevels.map(level =>
            e('button', {
              key: level,
              type: 'button',
              className: 'isru-button' + (isru === level ? ' selected' : ''),
              'aria-pressed': isru === level,
              onClick: () => setIsru(level),
            }, `${level}+`)
          )
        )
      ),
      e('div', {className: 'field', role: 'group', 'aria-label': 'Spectral Type'},
        e('div', {className: 'label-row'},
          e('span', {className: 'label'}, 'Spectral Type'),
        ),
        e('div', {className: 'site-type-buttons'},
          siteTypeOptions.map(type =>
            e('button', {
              key: type,
              type: 'button',
              className: 'site-type-button' + (enabledSiteTypes.has(type) ? ' selected' : ''),
              'aria-pressed': enabledSiteTypes.has(type),
              onClick: () => toggleSiteType(type),
            }, type)
          )
        )
      )
    )
  )
}

/** @param {{mapData: MapData, path: PathNode[]|null, weight: MetricWeights, metricPriority: MetricKey[], setMetricPriority: (order: MetricKey[]) => void, exploring: boolean, toggleExplore: () => void, solutions: Solution[], solutionsComputing: boolean, previewSolution: (path: PathNode[]|null) => void, chooseSolution: (path: PathNode[]) => void, cancelPath: () => void, isru: number, setIsru: (value: number) => void, thrust: number, setThrust: (value: number) => void, pivots: number, setPivots: (value: number) => void, fuelNum: number, setFuelNum: (value: number) => void, fuelDen: number, setFuelDen: (value: number) => void, enabledSiteTypes: Set<string>, toggleSiteType: (type: string) => void, solarSeason: string, setSolarSeason: (value: string) => void}} props */
export function Overlay({mapData, path, weight, metricPriority, setMetricPriority, pivots, setPivots, fuelNum, setFuelNum, fuelDen, setFuelDen, exploring, toggleExplore, solutions, solutionsComputing, previewSolution, chooseSolution, cancelPath, isru, setIsru, thrust, setThrust, enabledSiteTypes, toggleSiteType, solarSeason, setSolarSeason}) {
  return e(React.Fragment, null,
    e(PathInfo, {mapData, path, weight, metricPriority, setMetricPriority, exploring, toggleExplore, solutions, solutionsComputing, previewSolution, chooseSolution, cancelPath}),
    e(VehicleInfo, {isru, setIsru, thrust, setThrust, pivots, setPivots, fuelNum, setFuelNum, fuelDen, setFuelDen, enabledSiteTypes, toggleSiteType, solarSeason, setSolarSeason}),
  )
}
