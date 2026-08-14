import { describe, expect, it } from 'vitest'
import { formFromWire, parseHours, priceSectionFromForm } from '../src/client/usage-stats-model.ts'
import { resolveRange } from '../src/client/ranges.ts'

describe('parseHours', () => {
  it('parses the default DeepSeek windows', () => {
    expect(parseHours('9-12,14-18')).toEqual([[9, 12], [14, 18]])
    expect(parseHours('9-12')).toEqual([[9, 12]])
  })

  it('rejects malformed windows', () => {
    expect(() => parseHours('')).toThrow(/at least one/)
    expect(() => parseHours('abc')).toThrow(/9-12/)
    expect(() => parseHours('12-9')).toThrow(/range/)
    expect(() => parseHours('9-25')).toThrow(/range/)
    expect(() => parseHours('24-25')).toThrow(/range/)
  })

  it('tolerates trailing separators', () => {
    expect(parseHours('9-12,')).toEqual([[9, 12]])
    expect(parseHours('9-12 , 14-18')).toEqual([[9, 12], [14, 18]])
  })
})

describe('priceSectionFromForm', () => {
  it('builds a flat section and validates amounts', () => {
    const section = priceSectionFromForm({
      default: {
        inputPerMillion: '1', outputPerMillion: '2', cacheHitPerMillion: '0.02',
        peak: false, peakInputPerMillion: '', peakOutputPerMillion: '', peakCacheHitPerMillion: '', peakHours: '9-12',
      },
      models: {
        'deepseek-v4-pro': {
          inputPerMillion: '3', outputPerMillion: '6', cacheHitPerMillion: '0.025',
          peak: false, peakInputPerMillion: '', peakOutputPerMillion: '', peakCacheHitPerMillion: '', peakHours: '9-12',
        },
      },
    })
    expect(section).toEqual({
      default: { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02 },
      models: { 'deepseek-v4-pro': { inputPerMillion: 3, outputPerMillion: 6, cacheHitPerMillion: 0.025 } },
    })
  })

  it('includes peak blocks when enabled', () => {
    const section = priceSectionFromForm({
      default: {
        inputPerMillion: '1', outputPerMillion: '2', cacheHitPerMillion: '0.02',
        peak: true, peakInputPerMillion: '3', peakOutputPerMillion: '9', peakCacheHitPerMillion: '0.1', peakHours: '9-12,14-18',
      },
      models: {},
    })
    expect(section.default).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
      peak: { inputPerMillion: 3, outputPerMillion: 9, cacheHitPerMillion: 0.1, hours: [[9, 12], [14, 18]] },
    })
  })

  it('throws on bad amounts and empty model names', () => {
    const base = {
      default: {
        inputPerMillion: '1', outputPerMillion: '2', cacheHitPerMillion: '0.02',
        peak: false, peakInputPerMillion: '', peakOutputPerMillion: '', peakCacheHitPerMillion: '', peakHours: '9-12',
      },
      models: {} as Record<string, never>,
    }
    expect(() => priceSectionFromForm({ ...base, default: { ...base.default, inputPerMillion: '-1' } }))
      .toThrow(/non-negative/)
    expect(() => priceSectionFromForm({ ...base, models: { '': base.default } }))
      .toThrow(/non-empty/)
  })
})

describe('formFromWire', () => {
  it('maps the wire table into editable rows', () => {
    const form = formFromWire({
      default: { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02 },
      models: {
        'deepseek-v4-pro': {
          inputPerMillion: 3,
          outputPerMillion: 6,
          cacheHitPerMillion: 0.025,
          peak: { inputPerMillion: 9, outputPerMillion: 27, cacheHitPerMillion: 0.3, hours: [[9, 12], [14, 18]] },
        },
      },
    })
    expect(form.default.inputPerMillion).toBe('1')
    expect(form.models['deepseek-v4-pro'].peak).toBe(true)
    expect(form.models['deepseek-v4-pro'].peakHours).toBe('9-12,14-18')
  })

  it('tolerates a missing table', () => {
    const form = formFromWire(undefined)
    expect(form.default.inputPerMillion).toBe('')
    expect(form.models).toEqual({})
  })
})

describe('resolveRange', () => {
  const NOW = new Date(2026, 7, 15, 12).getTime() // 2026-08-15 12:00 local

  it('today starts at local midnight', () => {
    const { fromMs, toMs } = resolveRange({ preset: 'today' }, NOW)
    expect(fromMs).toBe(new Date(2026, 7, 15).getTime())
    expect(toMs).toBe(NOW)
  })

  it('1d is a rolling 24h window', () => {
    const { fromMs } = resolveRange({ preset: '1d' }, NOW)
    expect(fromMs).toBe(NOW - 86_400_000)
  })

  it('7d/14d/30d start at local midnight of the lookback day', () => {
    const day = 86_400_000
    expect(resolveRange({ preset: '7d' }, NOW).fromMs).toBe(new Date(2026, 7, 9).getTime())
    expect(resolveRange({ preset: '14d' }, NOW).fromMs).toBe(new Date(2026, 7, 2).getTime())
    expect(resolveRange({ preset: '30d' }, NOW).fromMs).toBe(new Date(2026, 6, 17).getTime())
    expect(resolveRange({ preset: '7d' }, NOW).toMs).toBe(NOW)
  })

  it('custom falls back to the last 24h without bounds', () => {
    expect(resolveRange({ preset: 'custom' }, NOW).fromMs).toBe(NOW - 86_400_000)
  })
})
