/**
 * Hand-rolled SVG dual-axis trend chart for the usage dashboard — no chart
 * library (the harness ships none, and recharts would bloat the plugin
 * bundle). Mirrors the CC Switch trend layout: four token series on the left
 * axis, the cost series on the right axis, legend below, hover tooltip.
 * @module @visol-456/dsh-cost-tracker/client/chart
 */

import { useMemo, useState } from 'react'
import type { CostTrendPointWire } from './store.ts'
import css from './UsageStats.module.css'

/** Series palette (CC Switch colors). */
export const SERIES = [
  { key: 'inputTokens', color: '#3b82f6' },
  { key: 'outputTokens', color: '#22c55e' },
  { key: 'cacheWriteTokens', color: '#f97316' },
  { key: 'cacheReadTokens', color: '#a855f7' },
  { key: 'cost', color: '#f43f5e' },
] as const

export type SeriesKey = (typeof SERIES)[number]['key']

/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
export function formatTokensShort(n: number): string {
  const scaled = (value: number): string =>
    value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Format a CNY amount with exactly 4 decimals (¥0.0042). */
export function formatCost(n: number): string {
  return n.toFixed(4)
}

const WIDTH = 760
const HEIGHT = 300
const MARGIN = { top: 14, right: 52, bottom: 30, left: 52 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom

interface ChartProps {
  points: CostTrendPointWire[]
  t: (key: string, params?: Record<string, unknown>) => string
}

/** One point's value for a series key. */
function seriesValue(point: CostTrendPointWire, key: SeriesKey): number {
  return key === 'cost' ? point.totalCost : point[key]
}

/**
 * Build a smooth open Catmull-Rom spline path through the given 2D points.
 * The curve is converted to cubic Bézier segments so every data point remains
 * on the line and the result stays close to the underlying trend.
 */
function smoothPath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`

  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(i + 2, points.length - 1)]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

/**
 * Dual-axis trend chart: left axis = tokens, right axis = cost. Points are
 * mapped to x by index (even spacing), y by value with per-axis scales.
 */
export function DualAxisTrendChart({ points, t }: ChartProps) {
  const [hovered, setHovered] = useState<number | null>(null)

  const scales = useMemo(() => {
    let maxTokens = 0
    let maxCost = 0
    for (const point of points) {
      for (const series of SERIES) {
        if (series.key === 'cost') {
          maxCost = Math.max(maxCost, point.totalCost)
        } else {
          maxTokens = Math.max(maxTokens, point[series.key])
        }
      }
    }
    return {
      maxTokens: maxTokens === 0 ? 1 : maxTokens,
      maxCost: maxCost === 0 ? 1 : maxCost,
    }
  }, [points])

  const x = (index: number): number =>
    points.length <= 1
      ? MARGIN.left + PLOT_WIDTH / 2
      : MARGIN.left + index / (points.length - 1) * PLOT_WIDTH
  const yTokens = (value: number): number =>
    MARGIN.top + PLOT_HEIGHT - value / scales.maxTokens * PLOT_HEIGHT
  const yCost = (value: number): number =>
    MARGIN.top + PLOT_HEIGHT - value / scales.maxCost * PLOT_HEIGHT

  if (points.length === 0) {
    return <div className={css.ctChartEmpty}>{t('noData')}</div>
  }

  // ~6 evenly spaced x labels.
  const labelStep = Math.max(1, Math.ceil(points.length / 6))
  const xLabels = points
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index % labelStep === 0 || index === points.length - 1)

  // 4 horizontal gridlines with token tick labels.
  const gridlines = [0, 1, 2, 3, 4].map((step) => {
    const value = scales.maxTokens * step / 4
    return { value, y: yTokens(value) }
  })

  const hoveredPoint = hovered === null ? null : points[hovered]
  const hoveredX = hovered === null ? null : x(hovered)

  const seriesLine = (key: SeriesKey): string => {
    const linePoints = points.map((point, index) => ({
      x: x(index),
      y: key === 'cost' ? yCost(point.totalCost) : yTokens(point[key]),
    }))
    return smoothPath(linePoints)
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className={css.ctChartSvg}
        onMouseMove={(event) => {
          const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = (event.clientX - rect.left) / rect.width * WIDTH
          const index = Math.round((px - MARGIN.left) / PLOT_WIDTH * (points.length - 1))
          setHovered(Math.max(0, Math.min(points.length - 1, index)))
        }}
        onMouseLeave={() => setHovered(null)}
      >
        {gridlines.map(({ value, y }) => (
          <g key={value}>
            <line x1={MARGIN.left} x2={MARGIN.left + PLOT_WIDTH} y1={y} y2={y} className={css.ctGrid} />
            <text x={MARGIN.left - 8} y={y + 3} textAnchor="end" className={css.ctTick}>
              {formatTokensShort(value)}
            </text>
          </g>
        ))}
        {xLabels.map(({ point, index }) => (
          <text key={index} x={x(index)} y={HEIGHT - 8} textAnchor="middle" className={css.ctTick}>
            {point.label}
          </text>
        ))}

        {SERIES.map(({ key, color }) => (
          <path
            key={key}
            d={seriesLine(key)}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray={key === 'cost' ? '4 4' : undefined}
            className={css.ctLine}
          />
        ))}

        {hoveredPoint !== null && hoveredX !== null && (
          <g>
            <line x1={hoveredX} x2={hoveredX} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} className={css.ctGuide} />
            {SERIES.map(({ key, color }) => {
              const y = key === 'cost' ? yCost(hoveredPoint.totalCost) : yTokens(hoveredPoint[key])
              return <circle key={key} cx={hoveredX} cy={y} r={3.5} fill={color} />
            })}
          </g>
        )}

        {hoveredPoint !== null && hoveredX !== null && (
          <g transform={`translate(${Math.min(hoveredX + 10, WIDTH - 190)}, ${MARGIN.top + 6})`}>
            <rect width={180} height={132} rx={6} className={css.ctTooltipBg} />
            <text x={10} y={18} className={css.ctTooltipTitle}>{hoveredPoint.label}</text>
            {SERIES.map(({ key, color }, index) => (
              <g key={key}>
                <circle cx={12} cy={36 + index * 18} r={3} fill={color} />
                <text x={22} y={40 + index * 18} className={css.ctTooltipName}>
                  {key === 'cost' ? t('cost') : t(key === 'inputTokens' ? 'freshInput' : key === 'outputTokens' ? 'output' : key === 'cacheWriteTokens' ? 'cacheWrite' : 'cacheRead')}
                </text>
                <text x={170} y={40 + index * 18} textAnchor="end" className={css.ctTooltipValue}>
                  {key === 'cost' ? formatCost(hoveredPoint.totalCost) : formatTokensShort(hoveredPoint[key])}
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>
      <div className={css.ctLegend}>
        {SERIES.map(({ key, color }) => (
          <span key={key} className={css.ctLegendItem}>
            <span className={css.ctLegendDot} style={{ backgroundColor: color }} />
            {key === 'cost' ? t('cost') : t(key === 'inputTokens' ? 'freshInput' : key === 'outputTokens' ? 'output' : key === 'cacheWriteTokens' ? 'cacheWrite' : 'cacheRead')}
          </span>
        ))}
      </div>
    </div>
  )
}
