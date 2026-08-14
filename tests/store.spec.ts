import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CostStore, RECORDS_FILE, bucketOf, granularityFor } from '../src/store.ts'
import type { CostRecord } from '../src/types.ts'

let dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs = []
})

async function tempStore(): Promise<{ store: CostStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-tracker-store-'))
  dirs.push(dir)
  const store = new CostStore(dir)
  await store.init()
  return { store, dir }
}

function record(overrides: Partial<CostRecord>): CostRecord {
  return {
    id: 'rec',
    sessionId: 's1',
    turn: 1,
    step: 1,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    requestedAt: 1_700_000_000_000,
    completedAt: 1_700_000_060_000,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 60,
    cacheWriteTokens: 0,
    inputCost: 0.0001,
    cacheHitCost: 0.0000012,
    cacheWriteCost: 0,
    outputCost: 0.0001,
    totalCost: 0.0002012,
    version: 1,
    ...overrides,
  }
}

describe('CostStore persistence', () => {
  it('appends and reloads records from the JSONL log', async () => {
    const { store, dir } = await tempStore()
    await store.append(record({ id: 'a' }))
    await store.append(record({ id: 'b', sessionId: 's2' }))
    expect(store.all()).toHaveLength(2)

    // A fresh store over the same directory sees the persisted log.
    const reloaded = new CostStore(dir)
    await reloaded.init()
    expect(reloaded.all().map(row => row.id)).toEqual(['a', 'b'])
  })

  it('creates the directory and tolerates a missing log', async () => {
    const { store } = await tempStore()
    expect(store.all()).toEqual([])
  })

  it('skips malformed lines without failing the rest of the log', async () => {
    const { store, dir } = await tempStore()
    await store.append(record({ id: 'ok' }))
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(dir, RECORDS_FILE), '{not json}\n')
    const reloaded = new CostStore(dir)
    await reloaded.init()
    expect(reloaded.all().map(row => row.id)).toEqual(['ok'])
  })
})

describe('CostStore aggregation', () => {
  it('sessionSummary folds costs, tokens and TTFT', async () => {
    const { store } = await tempStore()
    await store.append(record({
      id: 'a',
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 60,
      inputCost: 0.0001, cacheHitCost: 0.0000012, outputCost: 0.0001, totalCost: 0.0002012,
      ttftMs: 1200,
    }))
    await store.append(record({
      id: 'b',
      turn: 1, step: 2,
      inputTokens: 200, outputTokens: 0, cacheReadTokens: 0,
      inputCost: 0.0002, cacheHitCost: 0, outputCost: 0, totalCost: 0.0002,
      ttftMs: 800,
    }))
    await store.append(record({ id: 'c', sessionId: 'other' }))
    const summary = store.sessionSummary('s1')
    expect(summary.requests).toBe(2)
    expect(summary.inputTokens).toBe(300)
    expect(summary.outputTokens).toBe(50)
    expect(summary.cacheReadTokens).toBe(60)
    expect(summary.totalCost).toBeCloseTo(0.0004012, 12)
    expect(summary.cacheHitCost).toBeCloseTo(0.0000012, 12)
    expect(summary.inputCost).toBeCloseTo(0.0003, 12)
    expect(summary.outputCost).toBeCloseTo(0.0001, 12)
    expect(summary.cacheHitRate).toBeCloseTo(60 / 360, 10)
    expect(summary.ttftMsAvg).toBe(1000)
    expect(summary.latest?.id).toBe('b')
  })

  it('overview aggregates the hero metrics and cache-hit rate', async () => {
    const { store } = await tempStore()
    await store.append(record({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 60 }))
    await store.append(record({ inputTokens: 200, outputTokens: 10, cacheReadTokens: 30, sessionId: 's2' }))
    const overview = store.overview({})
    expect(overview.requests).toBe(2)
    expect(overview.realTotalTokens).toBe(450)
    expect(overview.inputTokens).toBe(300)
    expect(overview.outputTokens).toBe(60)
    expect(overview.cacheReadTokens).toBe(90)
    expect(overview.cacheHitRate).toBeCloseTo(90 / 390, 10)
    expect(overview.totalCost).toBeCloseTo(0.0004024, 12)
  })

  it('filters by time range, provider and model', async () => {
    const { store } = await tempStore()
    await store.append(record({ id: 'a', completedAt: 1_000, provider: 'p1', model: 'm1' }))
    await store.append(record({ id: 'b', completedAt: 2_000, provider: 'p1', model: 'm2' }))
    await store.append(record({ id: 'c', completedAt: 3_000, provider: 'p2', model: 'm1' }))
    expect(store.filtered({ fromMs: 1_500, toMs: 3_000 }).map(r => r.id)).toEqual(['b'])
    expect(store.filtered({ provider: 'p1' }).map(r => r.id)).toEqual(['a', 'b'])
    expect(store.filtered({ model: 'm1' }).map(r => r.id)).toEqual(['a', 'c'])
    expect(store.filtered({ provider: 'p2', model: 'm1' }).map(r => r.id)).toEqual(['c'])
  })

  it('trends bucket hourly within a 24h window and daily beyond', async () => {
    const { store } = await tempStore()
    const base = new Date(2026, 7, 15, 10, 30).getTime()
    await store.append(record({ id: 'a', completedAt: base }))
    await store.append(record({ id: 'b', completedAt: base + 10 * 60_000 }))
    await store.append(record({ id: 'c', completedAt: base + 3 * 3_600_000 }))
    const hourly = store.trends({ fromMs: base - 3_600_000, toMs: base + 6 * 3_600_000 }, 'hour')
    expect(hourly).toHaveLength(2)
    expect(hourly[0].requests).toBe(2)
    expect(hourly[1].requests).toBe(1)
    expect(hourly[0].time).toBe(new Date(2026, 7, 15, 10).getTime())

    const daily = store.trends({ fromMs: base - 2 * 86_400_000, toMs: base + 86_400_000 }, 'day')
    expect(daily).toHaveLength(1)
    expect(daily[0].label).toBe('08-15')
  })

  it('granularityFor picks hour for ≤24h windows', () => {
    expect(granularityFor(0, 24 * 3_600_000)).toBe('hour')
    expect(granularityFor(0, 24 * 3_600_000 + 1)).toBe('day')
  })

  it('bucketOf aligns hour and day buckets to local time', () => {
    const hour = bucketOf(new Date(2026, 7, 15, 10, 30).getTime(), 'hour')
    expect(hour.startMs).toBe(new Date(2026, 7, 15, 10).getTime())
    expect(hour.label).toBe('08-15 10:00')
    const day = bucketOf(new Date(2026, 7, 15, 10, 30).getTime(), 'day')
    expect(day.startMs).toBe(new Date(2026, 7, 15).getTime())
  })

  it('requests pages newest-first', async () => {
    const { store } = await tempStore()
    for (let i = 0; i < 5; i++) {
      await store.append(record({ id: `r${i}`, completedAt: i * 1000 }))
    }
    const page = store.requests({}, 2, 0)
    expect(page.total).toBe(5)
    expect(page.rows.map(r => r.id)).toEqual(['r4', 'r3'])
    const next = store.requests({}, 2, 2)
    expect(next.rows.map(r => r.id)).toEqual(['r2', 'r1'])
  })

  it('providerStats and modelStats sort by total cost', async () => {
    const { store } = await tempStore()
    await store.append(record({ id: 'a', provider: 'p1', model: 'm1', totalCost: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }))
    await store.append(record({ id: 'b', provider: 'p2', model: 'm2', totalCost: 3, inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 }))
    await store.append(record({ id: 'c', provider: 'p1', model: 'm1', totalCost: 2, inputTokens: 0, outputTokens: 10, cacheReadTokens: 0 }))
    const providers = store.providerStats({})
    expect(providers.map(p => p.provider)).toEqual(['p1', 'p2'])
    expect(providers[0].requests).toBe(2)
    expect(providers[0].totalCost).toBe(3)
    expect(providers[0].realTotalTokens).toBe(25)
    const models = store.modelStats({})
    expect(models.map(m => m.model)).toEqual(['m1', 'm2'])
    expect(models[0].requests).toBe(2)
    // m2 billed 5 input tokens with no cache hits → rate 0 (not null).
    expect(models[1].cacheHitRate).toBe(0)
  })

  it('options lists distinct providers and models', async () => {
    const { store } = await tempStore()
    await store.append(record({ provider: 'b', model: 'y' }))
    await store.append(record({ provider: 'a', model: 'x' }))
    await store.append(record({ provider: 'a', model: 'x' }))
    expect(store.options()).toEqual({ providers: ['a', 'b'], models: ['x', 'y'] })
  })
})
