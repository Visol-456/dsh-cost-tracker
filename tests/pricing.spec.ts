import { describe, expect, it } from 'vitest'
import {
  computeCost, DEFAULT_PEAK_HOURS, DEFAULT_PRICE_TABLE, isPeakHour, priceFor,
  resolveModelPrice, resolvePriceTable,
} from '../src/pricing.ts'
import type { PriceTable } from '../src/pricing.ts'

const PRICES: PriceTable = {
  models: {
    'deepseek-v4-flash': {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
    },
  },
  default: {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheHitPerMillion: 0.02,
  },
}

describe('computeCost', () => {
  it('bills cache-hit, cache-miss and output separately', () => {
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000 },
      PRICES.models['deepseek-v4-flash'],
    )
    expect(cost.inputCost).toBeCloseTo(1, 10)          // 1M × ¥1/M
    expect(cost.cacheHitCost).toBeCloseTo(0.04, 10)    // 2M × ¥0.02/M
    expect(cost.outputCost).toBeCloseTo(1, 10)         // 0.5M × ¥2/M
    expect(cost.cacheWriteCost).toBe(0)
    expect(cost.totalCost).toBeCloseTo(2.04, 10)
  })

  it('degrades to input + output when no cache detail is present', () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, PRICES.default)
    expect(cost.cacheHitCost).toBe(0)
    expect(cost.totalCost).toBeCloseTo(2, 10)
  })

  it('bills cache-write tokens when the entry declares a price', () => {
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 },
      { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02, cacheWritePerMillion: 1.5 },
    )
    expect(cost.cacheWriteCost).toBeCloseTo(1.5, 10)
  })

  it('is exact for tiny token counts', () => {
    const cost = computeCost({ inputTokens: 42, outputTokens: 17 }, PRICES.default)
    expect(cost.totalCost).toBeCloseTo(42 / 1_000_000 + 17 * 2 / 1_000_000, 12)
  })
})

describe('peak pricing', () => {
  const peakTable: PriceTable = {
    default: {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
      peak: {
        inputPerMillion: 3,
        outputPerMillion: 9,
        cacheHitPerMillion: 0.1,
      },
    },
    models: {},
  }

  it('isPeakHour matches the default Beijing windows', () => {
    expect(isPeakHour(10, DEFAULT_PEAK_HOURS)).toBe(true)
    expect(isPeakHour(15, DEFAULT_PEAK_HOURS)).toBe(true)
    expect(isPeakHour(8, DEFAULT_PEAK_HOURS)).toBe(false)
    expect(isPeakHour(13, DEFAULT_PEAK_HOURS)).toBe(false)
    expect(isPeakHour(18, DEFAULT_PEAK_HOURS)).toBe(false)
    expect(isPeakHour(23, DEFAULT_PEAK_HOURS)).toBe(false)
  })

  it('priceFor picks peak prices inside a peak window', () => {
    const peak = priceFor(peakTable, 'unknown-model', new Date(2026, 7, 15, 10).getTime())
    expect(peak.inputPerMillion).toBe(3)
    expect(peak.outputPerMillion).toBe(9)
    expect(peak.cacheHitPerMillion).toBe(0.1)
  })

  it('priceFor keeps flat prices outside a peak window', () => {
    const offPeak = priceFor(peakTable, 'unknown-model', new Date(2026, 7, 15, 8).getTime())
    expect(offPeak.inputPerMillion).toBe(1)
    expect(offPeak.outputPerMillion).toBe(2)
  })

  it('priceFor falls back to the table default for unknown models', () => {
    expect(priceFor(PRICES, 'some-other-model', Date.now()).inputPerMillion).toBe(1)
    expect(priceFor(PRICES, 'deepseek-v4-flash', Date.now()).inputPerMillion).toBe(1)
  })
})

describe('resolvePriceTable validation (fail loud)', () => {
  it('accepts a valid table and freezes it', () => {
    const resolved = resolvePriceTable({ default: PRICES.default, models: PRICES.models })
    expect(resolved.models['deepseek-v4-flash'].outputPerMillion).toBe(2)
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('rejects a missing default entry', () => {
    expect(() => resolvePriceTable({ models: {} })).toThrow(/default is required/)
  })

  it('rejects negative and non-finite prices', () => {
    expect(() => resolveModelPrice({ inputPerMillion: -1, outputPerMillion: 2, cacheHitPerMillion: 0.02 }, 'p')).toThrow(/non-negative/)
    expect(() => resolveModelPrice({ inputPerMillion: NaN, outputPerMillion: 2, cacheHitPerMillion: 0.02 }, 'p')).toThrow(/finite/)
    expect(() => resolveModelPrice({ inputPerMillion: Infinity, outputPerMillion: 2, cacheHitPerMillion: 0.02 }, 'p')).toThrow(/finite/)
  })

  it('rejects unknown price keys', () => {
    expect(() => resolveModelPrice({ inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02, surprise: 1 }, 'p')).toThrow(/unknown key/)
    expect(() => resolvePriceTable({ default: { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02, surprise: 1 } })).toThrow(/unknown key/)
  })

  it('rejects invalid peak windows', () => {
    expect(() => resolveModelPrice({
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
      peak: { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02, hours: [[9, 9]] },
    }, 'p')).toThrow(/hours/)
    expect(() => resolveModelPrice({
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
      peak: { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02, hours: [[9, 25]] },
    }, 'p')).toThrow(/hours/)
    expect(() => resolveModelPrice({
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
      peak: { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02, hours: [] },
    }, 'p')).toThrow(/hours/)
  })

  it('rejects malformed peak blocks', () => {
    expect(() => resolveModelPrice({
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
      peak: { inputPerMillion: 1 },
    }, 'p')).toThrow(/outputPerMillion/)
  })

  it('rejects empty model keys', () => {
    expect(() => resolvePriceTable({ default: PRICES.default, models: { '': PRICES.default } })).toThrow(/non-empty/)
  })
})

describe('default table', () => {
  it('matches the official DeepSeek list prices', () => {
    expect(DEFAULT_PRICE_TABLE.models['deepseek-v4-flash']).toMatchObject({
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
    })
    expect(DEFAULT_PRICE_TABLE.models['deepseek-v4-pro']).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 6,
      cacheHitPerMillion: 0.025,
    })
  })
})
