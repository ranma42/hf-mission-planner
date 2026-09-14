import React from 'react'

const e = React.createElement

/** @param {number} n @param {string} sg @param {string} pl */
const pl = (n, sg, pl) => n === 1 ? `${n} ${sg}` : `${n} ${pl}`

/** @typedef {'burns'|'turns'|'hazards'|'radHazards'} MetricKey */

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

/** @param {{mapData: MapData, path: PathNode[]|null, weight: {burns: number, turns: number, hazards: number, radHazards: number}, metricPriority: MetricKey[], setMetricPriority: (order: MetricKey[]) => void, cancelPath: () => void}} props */
function PathInfo({mapData, path, weight, metricPriority, setMetricPriority, cancelPath}) {
  /** @type {[{key: MetricKey, order: MetricKey[]}|null, (drag: {key: MetricKey, order: MetricKey[]}|null) => void]} */
  const [drag, setDrag] = React.useState(null)

  if (!path) return e('div')

  const sourcePoint = path ? mapData.points[path[0].node] : null
  const destinationPoint = path ? mapData.points[path[path.length - 1].node] : null

  const metricMeta = {
    burns: {sg: 'burn', pl: 'burns'},
    turns: {sg: 'turn', pl: 'turns'},
    hazards: {sg: 'hazard', pl: 'hazards'},
    radHazards: {sg: 'rad hazard', pl: 'rad hazards'},
  }
  // While dragging, show the previewed order; commit it only on drop.
  const displayOrder = drag ? drag.order : metricPriority

  /** @param {MetricKey} key @param {number} delta */
  const moveBy = (key, delta) => {
    const from = metricPriority.indexOf(key)
    const to = from + delta
    if (from < 0 || to < 0 || to >= metricPriority.length) return
    const next = [...metricPriority]
    next.splice(to, 0, ...next.splice(from, 1))
    setMetricPriority(next)
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
    displayOrder.map((key, i) => {
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
    e('div', {className: 'PathInfo-row PathInfo-destinationRow'},
      e('span', {className: 'PathInfo-destination'}, `${sourcePoint?.siteName ?? '\u2022'} \u2192 ${destinationPoint?.siteName ?? '\u2022'}`),
      e('button', {
        type: 'button',
        className: 'PathInfo-cancelButton',
        'aria-label': 'Cancel path',
        onClick: cancelPath,
      }, '\u2715'),
    ),
  )
}

const isruLevels = [0, 1, 2, 3, 4]

const siteTypeOptions = ['C', 'S', 'M', 'V', 'D', 'H']

const solarSeasonOptions = ['red', 'yellow', 'blue']

/** @param {{isru: number, setIsru: (value: number) => void, thrust: number, setThrust: (value: number) => void, enabledSiteTypes: Set<string>, toggleSiteType: (type: string) => void, solarSeason: string, setSolarSeason: (value: string) => void}} param0 */
function VehicleInfo({isru, setIsru, thrust, setThrust, enabledSiteTypes, toggleSiteType, solarSeason, setSolarSeason}) {
  /** @param {string} value */
  const updateThrust = (value) => {
    const n = Number(value)
    if (Number.isNaN(n)) return
    setThrust(n)
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

/** @param {{mapData: MapData, path: PathNode[]|null, weight: {burns: number, turns: number, hazards: number, radHazards: number}, metricPriority: MetricKey[], setMetricPriority: (order: MetricKey[]) => void, cancelPath: () => void, isru: number, setIsru: (value: number) => void, thrust: number, setThrust: (value: number) => void, enabledSiteTypes: Set<string>, toggleSiteType: (type: string) => void, solarSeason: string, setSolarSeason: (value: string) => void}} props */
export function Overlay({mapData, path, weight, metricPriority, setMetricPriority, cancelPath, isru, setIsru, thrust, setThrust, enabledSiteTypes, toggleSiteType, solarSeason, setSolarSeason}) {
  return e(React.Fragment, null,
    e(PathInfo, {mapData, path, weight, metricPriority, setMetricPriority, cancelPath}),
    e(VehicleInfo, {isru, setIsru, thrust, setThrust, enabledSiteTypes, toggleSiteType, solarSeason, setSolarSeason}),
  )
}
