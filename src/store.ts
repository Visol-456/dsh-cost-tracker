/**
 * Durable record store and aggregation queries for the cost tracker.
 *
 * Persistence is an append-only JSONL file (`records.jsonl`) under the
 * plugin's data directory — the same "the log is the truth" philosophy as the
 * harness session logs. The full log is loaded into memory at startup and
 * every aggregation (session / time range / provider / model) folds in
 * memory, which is more than enough for personal-scale usage and keeps the
 * plugin dependency-free.
 *
 * @module @visol-456/dsh-cost-tracker/store
 */

import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CostFilter, CostOptions, CostOverview, CostRecord, CostRequestLogPage,
  CostTrendPoint, ModelCostStat, ProviderCostStat, SessionCostSummary,
} from './types.ts'

/** File holding every recorded call, one JSON object per line. */
export const RECORDS_FILE = 'records.jsonl'

/** Trend bucket granularity: hourly inside 24h windows, daily beyond. */
export type TrendGranularity = 'hour' | 'day'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Granularity for a window: hourly when it spans at most 24 hours. */
export function granularityFor(fromMs: number, toMs: number): TrendGranularity {
  return toMs - fromMs <= DAY_MS ? 'hour' : 'day'
}

/** Local-time bucket identity and start instant for a timestamp. */
export function bucketOf(timeMs: number, granularity: TrendGranularity): { startMs: number; key: string; label: string } {
  const date = new Date(timeMs)
  if (granularity === 'hour') {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours())
    return {
      startMs: start.getTime(),
      key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`,
      label: `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`,
    }
  }
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return {
    startMs: start.getTime(),
    key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    label: `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
  }
}

/** Whether one record passes a filter. */
export function recordMatches(record: CostRecord, filter: CostFilter): boolean {
  if (filter.fromMs !== undefined && record.completedAt < filter.fromMs) return false
  if (filter.toMs !== undefined && record.completedAt >= filter.toMs) return false
  if (filter.provider !== undefined && record.provider !== filter.provider) return false
  if (filter.model !== undefined && record.model !== filter.model) return false
  return true
}

/**
 * The cost record store. One instance per plugin fiber; append is durably
 * awaited so a crash after resolution never loses a committed record.
 */
export class CostStore {
  /** Every record loaded so far, in append order. */
  private records: CostRecord[] = []
  private readonly filePath: string
  private ready: Promise<void>

  /** @param dir - data directory; created on {@link init}. */
  constructor(dir: string) {
    this.filePath = join(dir, RECORDS_FILE)
    this.ready = (async () => {
      await mkdir(dir, { recursive: true })
      await this.load()
    })()
  }

  /** Load the persisted log (idempotent; called once by the constructor). */
  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const records: CostRecord[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        // A malformed line is skipped, never fatal: the plugin keeps tracking
        // future calls and the rest of the log stays usable.
        continue
      }
      if (typeof record !== 'object' || record === null || typeof (record as CostRecord).id !== 'string') {
        continue
      }
      records.push(record as CostRecord)
    }
    this.records = records
  }

  /** Await the initial load. */
  async init(): Promise<void> {
    await this.ready
  }

  /**
   * Append one record: keep it in memory and write it to the log durably.
   * @param record - the record to persist.
   */
  async append(record: CostRecord): Promise<void> {
    await this.ready
    this.records.push(record)
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  /** All records currently in memory (append order). */
  all(): readonly CostRecord[] {
    return this.records
  }

  /** Records passing a filter, in append order. */
  filtered(filter: CostFilter): readonly CostRecord[] {
    return this.records.filter(record => recordMatches(record, filter))
  }

  /** Whole-log figures for one session (conversation summary card). */
  sessionSummary(sessionId: string): SessionCostSummary {
    const rows = this.records.filter(record => record.sessionId === sessionId)
    let requests = 0
    let totalCost = 0
    let inputCost = 0
    let cacheHitCost = 0
    let cacheWriteCost = 0
    let outputCost = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let ttftSum = 0
    let ttftCount = 0
    for (const row of rows) {
      requests += 1
      totalCost += row.totalCost
      inputCost += row.inputCost
      cacheHitCost += row.cacheHitCost
      cacheWriteCost += row.cacheWriteCost
      outputCost += row.outputCost
      inputTokens += row.inputTokens
      outputTokens += row.outputTokens
      cacheReadTokens += row.cacheReadTokens
      cacheWriteTokens += row.cacheWriteTokens
      if (row.ttftMs !== undefined) {
        ttftSum += row.ttftMs
        ttftCount += 1
      }
    }
    const billedInput = inputTokens + cacheReadTokens + cacheWriteTokens
    const latest = rows.at(-1)
    return {
      sessionId,
      requests,
      totalCost,
      inputCost,
      cacheHitCost,
      cacheWriteCost,
      outputCost,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate: billedInput === 0 ? null : cacheReadTokens / billedInput,
      ttftMsAvg: ttftCount === 0 ? null : ttftSum / ttftCount,
      latest,
    }
  }

  /** Global overview figures for the hero metric cards. */
  overview(filter: CostFilter): CostOverview {
    let requests = 0
    let totalCost = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    for (const row of this.filtered(filter)) {
      requests += 1
      totalCost += row.totalCost
      inputTokens += row.inputTokens
      outputTokens += row.outputTokens
      cacheReadTokens += row.cacheReadTokens
      cacheWriteTokens += row.cacheWriteTokens
    }
    const billedInput = inputTokens + cacheReadTokens + cacheWriteTokens
    return {
      realTotalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      requests,
      totalCost,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate: billedInput === 0 ? null : cacheReadTokens / billedInput,
    }
  }

  /**
   * Time-bucketed trend series. The window [fromMs, toMs) is bucketed at
   * local-time hour (≤24h) or day (>24h) granularity, and empty buckets are
   * omitted (the chart connects present data points).
   */
  trends(filter: CostFilter, granularity?: TrendGranularity): CostTrendPoint[] {
    const fromMs = filter.fromMs ?? this.records[0]?.completedAt ?? 0
    const toMs = filter.toMs ?? Date.now()
    const bucket = granularity ?? granularityFor(fromMs, toMs)
    const buckets = new Map<string, CostTrendPoint>()
    for (const row of this.filtered(filter)) {
      const { startMs, key, label } = bucketOf(row.completedAt, bucket)
      let point = buckets.get(key)
      if (point === undefined) {
        point = {
          time: startMs,
          label,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0,
        }
        buckets.set(key, point)
      }
      point.requests += 1
      point.inputTokens += row.inputTokens
      point.outputTokens += row.outputTokens
      point.cacheWriteTokens += row.cacheWriteTokens
      point.cacheReadTokens += row.cacheReadTokens
      point.totalCost += row.totalCost
    }
    return [...buckets.values()].sort((left, right) => left.time - right.time)
  }

  /** Paged request log, newest first. */
  requests(filter: CostFilter, limit: number, offset: number): CostRequestLogPage {
    const rows = this.filtered(filter).slice().reverse()
    const total = rows.length
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 50
    const safeOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0
    return { rows: rows.slice(safeOffset, safeOffset + safeLimit), total }
  }

  /** Per-provider aggregates (provider statistics tab). */
  providerStats(filter: CostFilter): ProviderCostStat[] {
    const byProvider = new Map<string, ProviderCostStat>()
    for (const row of this.filtered(filter)) {
      let stat = byProvider.get(row.provider)
      if (stat === undefined) {
        stat = { provider: row.provider, requests: 0, realTotalTokens: 0, totalCost: 0 }
        byProvider.set(row.provider, stat)
      }
      stat.requests += 1
      stat.realTotalTokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
      stat.totalCost += row.totalCost
    }
    return [...byProvider.values()].sort((left, right) => right.totalCost - left.totalCost)
  }

  /** Per-model aggregates (model statistics tab). */
  modelStats(filter: CostFilter): ModelCostStat[] {
    const byModel = new Map<string, { requests: number; realTotalTokens: number; totalCost: number; inputTokens: number; cacheReadTokens: number }>()
    for (const row of this.filtered(filter)) {
      let stat = byModel.get(row.model)
      if (stat === undefined) {
        stat = { requests: 0, realTotalTokens: 0, totalCost: 0, inputTokens: 0, cacheReadTokens: 0 }
        byModel.set(row.model, stat)
      }
      stat.requests += 1
      stat.realTotalTokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
      stat.totalCost += row.totalCost
      stat.inputTokens += row.inputTokens
      stat.cacheReadTokens += row.cacheReadTokens
    }
    return [...byModel.entries()]
      .map(([model, stat]) => ({
        model,
        requests: stat.requests,
        realTotalTokens: stat.realTotalTokens,
        totalCost: stat.totalCost,
        cacheHitRate: stat.inputTokens + stat.cacheReadTokens === 0
          ? null
          : stat.cacheReadTokens / (stat.inputTokens + stat.cacheReadTokens),
      }))
      .sort((left, right) => right.totalCost - left.totalCost)
  }

  /** Distinct providers and models present in the log (filter option pools). */
  options(): CostOptions {
    const providers = new Set<string>()
    const models = new Set<string>()
    for (const row of this.records) {
      providers.add(row.provider)
      models.add(row.model)
    }
    return { providers: [...providers].sort(), models: [...models].sort() }
  }
}
