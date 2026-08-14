/**
 * LLM cost tracker node half.
 *
 * Watches the session firehose (`session/event` through the global
 * `internal/dispatch` relay, the same pattern dsh-llm-fallback uses) for
 * completed model calls: an `assistant/message` carrying provider usage ends
 * one call. The record stores the actual serving provider/model (from
 * `message.source`), the disjoint token buckets (uncached input, output,
 * cache read/write), first-token latency, and the billed CNY cost computed
 * from the effective price table. Records append durably to a JSONL log under
 * the harness home (`~/.dsh/cost-tracker` by default, `dataDir` overrides).
 *
 * The price table lives in the `cost-tracker` settings namespace (defaults ->
 * cordis.yml base -> saved user section); a committed change rebuilds pricing
 * hot, next call. The optional `webServer` seat serves the loopback-only data
 * bridge for the web UI; without a web server the plugin keeps recording and
 * only the UI is missing.
 *
 * @module @visol-456/dsh-cost-tracker
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the `ctx.webServer` Context merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  computeCost, DEFAULT_PRICE_TABLE, priceFor, resolvePriceTable,
  type ModelPrice, type PriceTable,
} from './pricing.ts'
import { CostStore } from './store.ts'
import type { CostRecord } from './types.ts'
import { COST_TRACKER_SETTINGS_NAMESPACE } from './config-http.ts'
import { registerCostTrackerBridge } from './config-http.ts'

export type { CostRecord } from './types.ts'
export type {
  CostFilter, CostOptions, CostOverview, CostRequestLogPage,
  CostTrendPoint, ModelCostStat, ProviderCostStat, SessionCostSummary,
} from './types.ts'
export {
  DEFAULT_PEAK_HOURS, DEFAULT_PRICE_TABLE, computeCost, isPeakHour, priceFor,
  resolveModelPrice, resolvePriceTable,
} from './pricing.ts'
export type { CostBreakdown, CostUsage, ModelPrice, PeakPrice, PriceTable } from './pricing.ts'
export { CostStore, bucketOf, granularityFor, recordMatches } from './store.ts'
export type { TrendGranularity } from './store.ts'
export {
  BRIDGE_PATH, COST_TRACKER_SETTINGS_NAMESPACE, handleCostTrackerBridge,
  isLoopbackAddress, isTrustedBridgeRequest, registerCostTrackerBridge,
} from './config-http.ts'

export const name = 'cost-tracker'
export const inject = ['agents']

/** Plugin config: only the data directory and the optional base price table. */
export interface Config {
  /** Data directory for the record log; defaults to `<harness home>/cost-tracker`. */
  dataDir?: string
  /** Base price table (cordis.yml layer of the `cost-tracker` settings namespace). */
  prices?: PriceTable
}

const CONFIG_KEYS: ReadonlySet<string> = new Set(['dataDir', 'prices'])

/** Validate the plugin config, failing loud on unknown keys or a bad table. */
export function resolveConfig(config: Config): { dataDir: string; basePrices: PriceTable } {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`cost-tracker: unknown key "${key}"`)
  }
  const dataDir = config.dataDir
  if (dataDir !== undefined && (typeof dataDir !== 'string' || dataDir.length === 0)) {
    throw new Error('cost-tracker: dataDir must be a non-empty string')
  }
  const basePrices = config.prices === undefined
    ? DEFAULT_PRICE_TABLE
    : resolvePriceTable(config.prices)
  return { dataDir: dataDir ?? join(resolveDshHome(), 'cost-tracker'), basePrices }
}

/** Runtime schema for {@link Config}. Unknown keys are rejected by {@link resolveConfig}. */
export const Config = z.object({}) as unknown as z<Config>

/** Schema of the GUI-editable price-table section (validated by {@link resolvePriceTable}). */
export const PriceSection = z.object({
  default: z.object({}),
  models: z.dict(z.object({})),
}) as unknown as z<PriceTable>

/** Per-step timing state, keyed `${turn}:${step}` per session. */
type StepTimings = Map<string, { start?: number; firstChunk?: number }>

/** Non-serializable hooks that make timing deterministic in tests. */
export interface CostTrackerInternals {
  /** Clock returning the current time in milliseconds (defaults to Date.now). */
  now?: () => number
}

/**
 * Install the cost tracker: record every completed model call and serve the
 * price/config bridge when a web server is mounted.
 * @param ctx - plugin context that owns the listeners and the store.
 * @param config - plugin config (dataDir + optional base prices).
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config, internals: CostTrackerInternals = {}): void {
  const now = internals.now ?? Date.now
  const { dataDir, basePrices } = resolveConfig(config)

  const store = new CostStore(dataDir)
  void store.init()

  // Price table: defaults -> cordis.yml base -> saved user section; every
  // committed change rebuilds `prices` hot (next recorded call).
  let pricesSource: () => PriceTable = () => basePrices
  let prices: PriceTable = basePrices
  const rebuild = (next: PriceTable): void => {
    prices = resolvePriceTable(next)
  }

  // Per-session step timings for first-token latency.
  const timings = new Map<string, StepTimings>()
  const timingsFor = (sessionId: string): StepTimings => {
    let map = timings.get(sessionId)
    if (map === undefined) {
      map = new Map()
      timings.set(sessionId, map)
    }
    return map
  }
  const stepKey = (turn: number, step: number): string => `${turn}:${step}`

  function handleEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'step/start') {
      timingsFor(session.id).set(stepKey(event.data.turn, event.data.step), { start: event.time })
      return
    }
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
        const timings = timingsFor(session.id)
        const key = stepKey(event.data.turn, event.data.step)
        const entry = timings.get(key) ?? { start: undefined }
        if (entry.firstChunk === undefined) entry.firstChunk = event.time
        timings.set(key, entry)
      }
      return
    }
    if (event.type === 'step/end') {
      timingsFor(session.id).delete(stepKey(event.data.turn, event.data.step))
      return
    }
    if (event.type === 'assistant/message') {
      const { turn, step, message, usage } = event.data
      const timing = timingsFor(session.id).get(stepKey(turn, step))
      timingsFor(session.id).delete(stepKey(turn, step))
      if (usage === undefined) return
      void recordCall(session, turn, step, message.source.provider, message.source.model, usage, event.time, timing)
      return
    }
  }

  async function recordCall(
    session: Session,
    turn: number,
    step: number,
    provider: string,
    model: string,
    usage: TokenUsage,
    completedAt: number,
    timing: { start?: number; firstChunk?: number } | undefined,
  ): Promise<void> {
    const requestedAt = timing?.start ?? completedAt
    const ttftMs = timing?.start !== undefined && timing.firstChunk !== undefined
      ? Math.max(0, timing.firstChunk - timing.start)
      : undefined
    const price: ModelPrice = priceFor(prices, model, completedAt)
    const breakdown = computeCost(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
        ...usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
      },
      price,
    )
    const record: CostRecord = {
      id: randomUUID(),
      sessionId: session.id,
      turn,
      step,
      provider,
      model,
      requestedAt,
      completedAt,
      ...ttftMs === undefined ? {} : { ttftMs },
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      ...usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
      inputCost: breakdown.inputCost,
      cacheHitCost: breakdown.cacheHitCost,
      cacheWriteCost: breakdown.cacheWriteCost,
      outputCost: breakdown.outputCost,
      totalCost: breakdown.totalCost,
      version: 1,
    }
    try {
      await store.append(record)
    } catch (error) {
      ctx.logger.warn(`cost-tracker: failed to persist call record: ${String(error)}`)
    }
  }

  // The session firehose is scope-filtered; the global internal/dispatch
  // relay reaches every committed session event regardless of scope (the
  // same mechanism dsh-llm-fallback uses).
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    try {
      handleEvent(session, event)
    } catch (error) {
      ctx.logger.warn(`cost-tracker: session event listener threw: ${String(error)}`)
    }
  }, { global: true })

  // Settings seam for the price table.
  installSettingsSection(ctx, COST_TRACKER_SETTINGS_NAMESPACE, PriceSection, basePrices, {
    setSource: (current) => { pricesSource = current },
    onChange: () => { rebuild(pricesSource()) },
    validate: (value) => { resolvePriceTable(value) },
  })

  // Browser data bridge, only when a web server is mounted.
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => registerCostTrackerBridge(sctx, { store, prices: () => prices }), 'cost-tracker: data bridge')
  })
}
