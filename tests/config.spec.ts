import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.ts'

describe('resolveConfig', () => {
  it('defaults the data directory to <harness home>/cost-tracker', () => {
    const resolved = resolveConfig({})
    expect(resolved.dataDir.endsWith('/cost-tracker')).toBe(true)
    expect(resolved.basePrices.default.inputPerMillion).toBe(1.5)
  })

  it('keeps an explicit dataDir', () => {
    expect(resolveConfig({ dataDir: '/tmp/ct' }).dataDir).toBe('/tmp/ct')
  })

  it('accepts a valid base price table', () => {
    const resolved = resolveConfig({
      prices: {
        default: { inputPerMillion: 2, outputPerMillion: 4, cacheHitPerMillion: 0.1 },
        models: {},
      },
    })
    expect(resolved.basePrices.default.outputPerMillion).toBe(4)
  })

  it('fails loud on unknown config keys', () => {
    expect(() => resolveConfig({ bogus: 1 } as never)).toThrow(/unknown key/)
  })

  it('fails loud on a malformed base price table', () => {
    expect(() => resolveConfig({
      prices: { default: { inputPerMillion: -1, outputPerMillion: 2, cacheHitPerMillion: 0.02 } },
    })).toThrow(/non-negative/)
    expect(() => resolveConfig({ prices: {} as never })).toThrow(/default is required/)
  })

  it('fails loud on an empty dataDir', () => {
    expect(() => resolveConfig({ dataDir: '' })).toThrow(/non-empty/)
  })
})
