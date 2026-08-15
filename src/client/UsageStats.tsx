/**
 * Usage statistics conversation view (requirement C): a CC-Switch-style
 * dashboard — hero metric cards (real tokens / requests / cost), detail
 * cards with the cache-hit-rate progress bar, a dual-axis trend chart with
 * date range + auto refresh, provider/model filters, and bottom tabs for the
 * request log / provider stats / model stats, plus an editable price table.
 *
 * The view is registered as a top-level conversation view tab, alongside
 * Chat and Trajectory. Data rides the node bridge (`/cost-tracker/*`,
 * loopback-guarded); the page refetches on filter/range changes, on the
 * chosen refresh interval (30s default), and on pushed settings
 * invalidations.
 * @module @visol-456/dsh-cost-tracker/client/usage-stats
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DualAxisTrendChart, formatCost, formatTokensShort,
} from './chart.tsx'
import type {
  CostFilterWire, RangeSelection, UsageStatsState, UsageStatsStore,
} from './store.ts'
import { resolveRange } from './store.ts'
import type { CostModelPriceForm } from './usage-stats-model.ts'
import { emptyModelPrice, parseHours, priceSectionFromForm } from './usage-stats-model.ts'
import { PricingEditor } from './PricingEditor.tsx'
import css from './UsageStats.module.css'

/** Injected dependencies of the view (slot `inject`). */
export interface UsageStatsViewInjected {
  /** The page store (loaded on mount, refreshed on interval + invalidations). */
  controller: UsageStatsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<UsageStatsState>
  /** View copy. */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** Backwards-compatible alias for the previous settings-section inject face. */
export type UsageStatsSectionInjected = UsageStatsViewInjected

/** Props delivered by the slot outlet: runtime kit + inject face spread flat. */
export type UsageStatsViewProps = ConvViewProps & Partial<UsageStatsViewInjected>

/** Backwards-compatible alias for the previous settings-section props type. */
export type UsageStatsSectionProps = UsageStatsViewProps

const RANGE_PRESETS = ['today', '1d', '7d', '14d', '30d'] as const
const REFRESH_OPTIONS = [0, 5_000, 10_000, 30_000, 60_000] as const
const DEFAULT_REFRESH_MS = 30_000
/** Request-log page size: 15 rows is enough for a glance (CC Switch density). */
const LOG_PAGE_SIZE = 15

/** Cascade helper: changing the provider clears the model filter. */
function useFilters() {
  const [provider, setProvider] = useState<string | undefined>(undefined)
  const [model, setModel] = useState<string | undefined>(undefined)
  const changeProvider = useCallback((next: string | undefined) => {
    setProvider(next)
    setModel(undefined)
  }, [])
  return { provider, model, setProvider: changeProvider, setModel }
}

/**
 * The usage dashboard conversation view body.
 * @param props - runtime conversation-view props plus injected controller/store/t.
 */
export function UsageStatsView({ controller, useSnapshot, t }: UsageStatsViewProps) {
  const [range, setRange] = useState<RangeSelection>({ preset: 'today' })
  const { provider, model, setProvider, setModel } = useFilters()
  const [refreshMs, setRefreshMs] = useState(DEFAULT_REFRESH_MS)
  const [tab, setTab] = useState<'logs' | 'providers' | 'models'>('logs')
  const [offset, setOffset] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const state = useSnapshot?.(s => s) as UsageStatsState | undefined
  const filter = useMemo<CostFilterWire>(() => {
    const { fromMs, toMs } = resolveRange(range, now)
    return {
      fromMs,
      toMs,
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
    }
  }, [range, now, provider, model])

  const load = useCallback(() => {
    if (controller === undefined) return
    void controller.load(filter, offset)
  }, [controller, filter, offset])

  useEffect(() => { load() }, [load])

  // Auto refresh (30s default; 0 = off). `now` re-resolves live ranges each
  // tick so "today" keeps its window moving.
  useEffect(() => {
    if (refreshMs <= 0 || controller === undefined) return
    const timer = setInterval(() => { setNow(Date.now()) }, refreshMs)
    return () => clearInterval(timer)
  }, [refreshMs, controller])

  // Refresh immediately after the range end moves.
  useEffect(() => { load() }, [now, load])

  if (controller === undefined || useSnapshot === undefined || t === undefined || state === undefined) {
    return null
  }

  const overview = state.overview
  const hitPercent = overview?.cacheHitRate === undefined || overview.cacheHitRate === null
    ? null
    : Math.min(100, Math.max(0, overview.cacheHitRate * 100))

  return (
    <div className={css.page}>
      <div className={css.header}>
        <div>
          <h2 className={css.title}>{t('title')}</h2>
          <p className={css.subtitle}>{t('subtitle')}</p>
        </div>
        <div className={css.controls}>
          <select
            className={css.select}
            value={provider ?? ''}
            onChange={(event) => setProvider(event.target.value === '' ? undefined : event.target.value)}
            title={t('filterBySource')}
          >
            <option value="">{t('allSources')}</option>
            {state.options.providers.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <select
            className={css.select}
            value={model ?? ''}
            onChange={(event) => setModel(event.target.value === '' ? undefined : event.target.value)}
            title={t('filterByModel')}
          >
            <option value="">{t('allModels')}</option>
            {state.options.models.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <select
            className={css.select}
            value={String(refreshMs)}
            onChange={(event) => setRefreshMs(Number(event.target.value))}
            title={t('refreshInterval')}
          >
            {REFRESH_OPTIONS.map(ms => (
              <option key={ms} value={String(ms)}>
                {ms === 0 ? t('refreshOff') : `${ms / 1000}${t('seconds')}`}
              </option>
            ))}
          </select>
          <select
            className={css.select}
            value={range.preset}
            onChange={(event) => {
              setRange({ preset: event.target.value as RangeSelection['preset'] })
              setOffset(0)
            }}
          >
            {RANGE_PRESETS.map(preset => (
              <option key={preset} value={preset}>{t(`range${preset === 'today' ? 'Today' : preset.toUpperCase()}`)}</option>
            ))}
          </select>
          <button type="button" className={css.refreshButton} onClick={load}>{t('refresh')}</button>
        </div>
      </div>

      {state.status === 'error' && <div className={css.error}>{t('loadFailed')} {state.error}</div>}

      {/* Hero metric cards (CC Switch UsageHero layout). */}
      <div className={css.hero}>
        <div className={css.heroMain}>
          <div className={css.heroIcon}>⚡</div>
          <div>
            <div className={css.heroLabel}>{t('realTotalTokens')}</div>
            <div className={css.heroValue}>
              {(overview?.realTotalTokens ?? 0).toLocaleString()}
              <span className={css.heroCompact}>≈ {formatTokensShort(overview?.realTotalTokens ?? 0)}</span>
            </div>
          </div>
        </div>
        <div className={css.heroSide}>
          <div className={css.heroStat}>
            <span className={css.heroStatLabel}>{t('totalRequests')}</span>
            <span className={css.heroStatValue}>{(overview?.requests ?? 0).toLocaleString()}</span>
          </div>
          <div className={css.heroDivider} />
          <div className={css.heroStat}>
            <span className={css.heroStatLabel}>{t('totalCost')}</span>
            <span className={`${css.heroStatValue} ${css.costValue}`}>{t('currency')}{formatCost(overview?.totalCost ?? 0)}</span>
          </div>
        </div>
      </div>

      {/* Detail metric cards + cache-hit-rate progress bar. */}
      <div className={css.details}>
        <MiniStat label={t('freshInput')} value={formatTokensShort(overview?.inputTokens ?? 0)} accent="#3b82f6" />
        <MiniStat label={t('output')} value={formatTokensShort(overview?.outputTokens ?? 0)} accent="#22c55e" />
        <MiniStat label={t('cacheWrite')} value={formatTokensShort(overview?.cacheWriteTokens ?? 0)} accent="#f97316" />
        <MiniStat label={t('cacheRead')} value={formatTokensShort(overview?.cacheReadTokens ?? 0)} accent="#a855f7" />
        <div className={css.hitRateCard}>
          <div className={css.hitRateHeader}>
            <span className={css.hitRateLabel}>{t('cacheHitRate')}</span>
            <span className={css.hitRateValue}>
              {hitPercent === null ? t('none') : `${hitPercent >= 99.95 ? hitPercent.toFixed(0) : hitPercent.toFixed(1)}%`}
            </span>
          </div>
          <div className={css.hitRateBar}>
            <div className={css.hitRateFill} style={{ width: `${hitPercent ?? 0}%` }} />
          </div>
        </div>
      </div>

      {/* Trend chart. */}
      <div className={css.card}>
        <div className={css.cardHeader}>
          <h3 className={css.cardTitle}>{t('trends')}</h3>
          <span className={css.cardMeta}>{t(`range${range.preset === 'today' ? 'Today' : range.preset.toUpperCase()}`)}</span>
        </div>
        {state.status === 'loading' && state.trends.length === 0
          ? <div className={css.loading}>{t('loading')}</div>
          : <DualAxisTrendChart points={state.trends} t={t} />}
      </div>

      {/* Bottom tabs. */}
      <div className={css.tabs}>
        <button
          type="button"
          className={tab === 'logs' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => setTab('logs')}
        >
          {t('requestLogs')}
        </button>
        <button
          type="button"
          className={tab === 'providers' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => setTab('providers')}
        >
          {t('providerStats')}
        </button>
        <button
          type="button"
          className={tab === 'models' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => setTab('models')}
        >
          {t('modelStats')}
        </button>
      </div>

      {tab === 'logs' && (
        <div className={css.card}>
          {state.requests.length === 0
            ? <div className={css.empty}>{t('noData')}</div>
            : (
              <div className={css.tableWrap}>
                <table className={`${css.table} ${css.logTable}`}>
                  <thead>
                    <tr>
                      <th>{t('time')}</th>
                      <th>{t('provider')}</th>
                      <th>{t('model')}</th>
                      <th className={css.num}>{t('freshInput')}</th>
                      <th className={css.num}>{t('output')}</th>
                      <th className={css.num}>{t('cacheRead')}</th>
                      <th className={css.num}>{t('ttft')}</th>
                      <th className={css.num}>{t('cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.requests.map(row => (
                      <tr key={row.id}>
                        <td className={css.mono}>{new Date(row.completedAt).toLocaleString()}</td>
                        <td>{row.provider}</td>
                        <td>{row.model}</td>
                        <td className={css.num}>{row.inputTokens.toLocaleString()}</td>
                        <td className={css.num}>{row.outputTokens.toLocaleString()}</td>
                        <td className={css.num}>{row.cacheReadTokens.toLocaleString()}</td>
                        <td className={css.num}>{row.ttftMs === undefined ? t('none') : `${Math.round(row.ttftMs)}ms`}</td>
                        <td className={`${css.num} ${css.costValue}`}>{t('currency')}{formatCost(row.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          {state.requestsTotal > LOG_PAGE_SIZE && (
            <div className={css.pager}>
              <button
                type="button"
                className={css.pageButton}
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - LOG_PAGE_SIZE))}
              >
                {t('pagePrev')}
              </button>
              <span className={css.pageInfo}>{offset + 1}–{Math.min(offset + LOG_PAGE_SIZE, state.requestsTotal)} / {state.requestsTotal}</span>
              <button
                type="button"
                className={css.pageButton}
                disabled={offset + LOG_PAGE_SIZE >= state.requestsTotal}
                onClick={() => setOffset(offset + LOG_PAGE_SIZE)}
              >
                {t('pageNext')}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'providers' && (
        <div className={css.card}>
          {state.providers.length === 0
            ? <div className={css.empty}>{t('noData')}</div>
            : (
              <div className={css.tableWrap}>
                <table className={css.table}>
                  <thead>
                    <tr>
                      <th>{t('provider')}</th>
                      <th className={css.num}>{t('totalRequests')}</th>
                      <th className={css.num}>{t('tokens')}</th>
                      <th className={css.num}>{t('cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.providers.map(row => (
                      <tr key={row.provider}>
                        <td>{row.provider}</td>
                        <td className={css.num}>{row.requests.toLocaleString()}</td>
                        <td className={css.num}>{formatTokensShort(row.realTotalTokens)}</td>
                        <td className={`${css.num} ${css.costValue}`}>{t('currency')}{formatCost(row.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {tab === 'models' && (
        <div className={css.card}>
          {state.models.length === 0
            ? <div className={css.empty}>{t('noData')}</div>
            : (
              <div className={css.tableWrap}>
                <table className={css.table}>
                  <thead>
                    <tr>
                      <th>{t('model')}</th>
                      <th className={css.num}>{t('totalRequests')}</th>
                      <th className={css.num}>{t('tokens')}</th>
                      <th className={css.num}>{t('cacheHitRate')}</th>
                      <th className={css.num}>{t('cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.models.map(row => (
                      <tr key={row.model}>
                        <td>{row.model}</td>
                        <td className={css.num}>{row.requests.toLocaleString()}</td>
                        <td className={css.num}>{formatTokensShort(row.realTotalTokens)}</td>
                        <td className={css.num}>
                          {row.cacheHitRate === null ? t('none') : `${Math.round(row.cacheHitRate * 100)}%`}
                        </td>
                        <td className={`${css.num} ${css.costValue}`}>{t('currency')}{formatCost(row.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      <PricingEditor t={t} />
    </div>
  )
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className={css.miniStat}>
      <div className={css.miniLabel} style={{ color: accent }}>{label}</div>
      <div className={css.miniValue}>{value}</div>
    </div>
  )
}

