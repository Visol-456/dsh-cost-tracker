/**
 * Cost-tracker client store: mirrors the node bridge wire contract so the
 * browser bundle stays self-contained, and drives the usage dashboard and
 * the conversation cost line through snapshot stores.
 * @module @visol-456/dsh-cost-tracker/client/store
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Route prefix of the node bridge (same-origin with the web shell). */
export const BRIDGE_PATH = '/cost-tracker'

/** Request-log page size served by the bridge (15 rows is enough for a glance). */
export const LOG_PAGE_SIZE = 15

// ---- wire types (mirror of the node half) ----

/** One recorded call as served by the bridge. */
export interface CostRecordWire {
  id: string
  sessionId: string
  turn: number
  step: number
  provider: string
  model: string
  requestedAt: number
  completedAt: number
  ttftMs?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
  inputCost: number
  cacheHitCost: number
  cacheWriteCost: number
  outputCost: number
  totalCost: number
}

export interface SessionCostSummaryWire {
  sessionId: string
  requests: number
  totalCost: number
  inputCost: number
  cacheHitCost: number
  cacheWriteCost: number
  outputCost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheHitRate: number | null
  ttftMsAvg: number | null
  latest: CostRecordWire | undefined
}

export interface CostOverviewWire {
  realTotalTokens: number
  requests: number
  totalCost: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  cacheHitRate: number | null
}

export interface CostTrendPointWire {
  time: number
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalCost: number
}

export interface ProviderCostStatWire {
  provider: string
  requests: number
  realTotalTokens: number
  totalCost: number
}

export interface ModelCostStatWire {
  model: string
  requests: number
  realTotalTokens: number
  totalCost: number
  cacheHitRate: number | null
}

export interface CostOptionsWire {
  providers: string[]
  models: string[]
}

export interface CostRequestLogPageWire {
  rows: CostRecordWire[]
  total: number
}

/** Time/entity filter sent as query parameters. */
export interface CostFilterWire {
  fromMs?: number
  toMs?: number
  provider?: string
  model?: string
}

// Re-export the pure range vocabulary from its framework-free home.
export { resolveRange } from './ranges.ts'
export type { RangePreset, RangeSelection } from './ranges.ts'

/** Snapshot of one usage-dashboard page. */
export interface UsageStatsState {
  status: 'loading' | 'ready' | 'error'
  overview: CostOverviewWire | undefined
  trends: CostTrendPointWire[]
  requests: CostRecordWire[]
  requestsTotal: number
  requestsOffset: number
  providers: ProviderCostStatWire[]
  models: ModelCostStatWire[]
  options: CostOptionsWire
  error: string | null
}

/** Snapshot of the conversation cost line. */
export interface CostLineState {
  status: 'loading' | 'ready' | 'error'
  summary: SessionCostSummaryWire | undefined
  error: string | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** GET a bridge endpoint and parse JSON, refusing non-OK responses. */
async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${BRIDGE_PATH}${path}`, { headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null
      && typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
      ? String((body as { error: { message: string } }).error.message)
      : `bridge rejected the request (HTTP ${String(response.status)})`
    throw new Error(message)
  }
  return body
}

function queryString(filter: CostFilterWire, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams()
  if (filter.fromMs !== undefined) params.set('fromMs', String(filter.fromMs))
  if (filter.toMs !== undefined) params.set('toMs', String(filter.toMs))
  if (filter.provider !== undefined) params.set('provider', filter.provider)
  if (filter.model !== undefined) params.set('model', filter.model)
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  const encoded = params.toString()
  return encoded === '' ? '' : `?${encoded}`
}

/**
 * The usage-dashboard controller. One instance per settings surface; every
 * query runs through the same loopback bridge the node half serves.
 */
export class UsageStatsStore {
  /** The snapshot the page renders from (uSES-safe store). */
  readonly store: SnapshotStore<UsageStatsState> = createSnapshotStore<UsageStatsState>({
    status: 'loading',
    overview: undefined,
    trends: [],
    requests: [],
    requestsTotal: 0,
    requestsOffset: 0,
    providers: [],
    models: [],
    options: { providers: [], models: [] },
    error: null,
  })

  /** Refetch everything the dashboard shows for one filter + page. */
  async load(filter: CostFilterWire, offset = 0): Promise<void> {
    this.store.update((state) => { state.status = 'loading' })
    try {
      const [overview, trends, requests, providers, models, options] = await Promise.all([
        getJson(`/overview${queryString(filter)}`) as Promise<CostOverviewWire>,
        getJson(`/trends${queryString(filter)}`) as Promise<CostTrendPointWire[]>,
        getJson(`/requests${queryString(filter, { limit: String(LOG_PAGE_SIZE), offset: String(offset) }) }`) as Promise<CostRequestLogPageWire>,
        getJson(`/providers${queryString(filter)}`) as Promise<ProviderCostStatWire[]>,
        getJson(`/models${queryString(filter)}`) as Promise<ModelCostStatWire[]>,
        getJson('/options') as Promise<CostOptionsWire>,
      ])
      this.store.update((state) => {
        state.status = 'ready'
        state.overview = overview
        state.trends = trends
        state.requests = requests.rows
        state.requestsTotal = requests.total
        state.requestsOffset = offset
        state.providers = providers
        state.models = models
        state.options = options
        state.error = null
      })
    } catch (error) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = errorMessage(error)
      })
    }
  }
}

/** Price-table view served by the bridge. */
export interface PriceConfigViewWire {
  available: boolean
  writable: boolean
  hasDocument: boolean
  value: unknown
  base?: unknown
  user?: unknown
  revision: number
}

/**
 * The conversation cost-line controller: loads one session's summary and
 * refreshes on demand (new message, session switch).
 */
export class CostLineStore {
  /** The snapshot the cost line renders from. */
  readonly store: SnapshotStore<CostLineState> = createSnapshotStore<CostLineState>({
    status: 'loading',
    summary: undefined,
    error: null,
  })

  /** Load one session's summary. */
  async load(sessionId: string): Promise<void> {
    this.store.update((state) => { state.status = 'loading' })
    try {
      const summary = await getJson(`/session?id=${encodeURIComponent(sessionId)}`) as SessionCostSummaryWire
      this.store.update((state) => {
        state.status = 'ready'
        state.summary = summary
        state.error = null
      })
    } catch (error) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = errorMessage(error)
      })
    }
  }
}

/** Read the current price-table view. */
export async function loadPriceConfig(): Promise<PriceConfigViewWire> {
  const view = await getJson('/config') as PriceConfigViewWire
  return {
    available: view.available === true,
    writable: view.writable === true,
    hasDocument: view.hasDocument === true,
    value: view.value,
    ...view.base === undefined ? {} : { base: view.base },
    ...view.user === undefined ? {} : { user: view.user },
    revision: view.revision,
  }
}

/** Save the price-table section (revision-fenced replace). */
export async function savePriceConfig(
  section: Record<string, unknown>,
  expectedRevision: number | undefined,
): Promise<{ ok: true; view: PriceConfigViewWire } | { ok: false; code: 'conflict' | 'rejected'; message: string }> {
  const response = await fetch(`${BRIDGE_PATH}/config`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ section, ...expectedRevision === undefined ? {} : { expectedRevision } }),
  })
  const body = await response.json().catch(() => undefined) as PriceConfigViewWire | { error?: { code?: string; message?: string } } | undefined
  if (response.status === 409) {
    return {
      ok: false,
      code: 'conflict',
      message: typeof body === 'object' && body !== null && typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
        ? String((body as { error: { message: string } }).error.message)
        : 'prices changed elsewhere',
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      code: 'rejected',
      message: typeof body === 'object' && body !== null && typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
        ? String((body as { error: { message: string } }).error.message)
        : `bridge rejected the write (HTTP ${String(response.status)})`,
    }
  }
  return { ok: true, view: body as PriceConfigViewWire }
}

/** Clear the saved price section (back to defaults). */
export async function resetPriceConfig(expectedRevision: number | undefined): Promise<{ ok: true; view: PriceConfigViewWire } | { ok: false; code: 'conflict' | 'rejected'; message: string }> {
  return savePriceConfig({}, expectedRevision)
}
