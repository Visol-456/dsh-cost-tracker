/**
 * Price table and cost computation for the cost tracker.
 *
 * Prices are CNY per MILLION tokens, matching the DeepSeek pricing page
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing). Defaults below
 * are the official list prices captured on 2026-08-15; since 2026-08-17
 * DeepSeek moved to peak/off-peak pricing, every model entry may carry an
 * optional `peak` block — when present, calls whose local time falls inside a
 * peak window bill at the peak prices.
 *
 * A malformed table fails loud at validation time (never silently
 * mis-billed): unknown keys, non-finite or negative prices, and invalid peak
 * windows all throw.
 *
 * @module @visol-456/dsh-cost-tracker/pricing
 */

/** One model's three (or four) per-million-token prices in CNY. */
export interface ModelPrice {
  /** Uncached (cache-miss) input price, CNY per million tokens. */
  inputPerMillion: number
  /** Output price, CNY per million tokens. */
  outputPerMillion: number
  /** Cache-hit input price, CNY per million tokens. */
  cacheHitPerMillion: number
  /** Cache-write input price, CNY per million tokens (DeepSeek: 0). */
  cacheWritePerMillion?: number
  /** Optional peak/off-peak pricing override. */
  peak?: PeakPrice
}

/** Peak-hour price block: bills at these prices inside peak windows. */
export interface PeakPrice {
  inputPerMillion: number
  outputPerMillion: number
  cacheHitPerMillion: number
  cacheWritePerMillion?: number
  /**
   * Peak windows as local-time half-open hour ranges [start, end).
   * Default: Beijing peak hours 09:00-12:00 and 14:00-18:00.
   */
  hours?: [number, number][]
}

/** The whole table: per-model entries plus the fallback for unknown models. */
export interface PriceTable {
  /** Per-model entries; a missing model falls back to {@link default}. */
  models: Record<string, ModelPrice>
  /** Fallback price used for models without an explicit entry (required). */
  default: ModelPrice
}

/**
 * Default table: official DeepSeek list prices as of 2026-08-15
 * (deepseek-v4-flash: hit 0.02 / miss 1 / output 2; deepseek-v4-pro:
 * hit 0.025 / miss 3 / output 6 — CNY per million tokens). Peak/off-peak
 * prices take effect 2026-08-17; the flat entries above stay the baseline
 * until the user edits them from Settings > 使用统计 or the settings document.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = Object.freeze({
  models: Object.freeze({
    'deepseek-v4-flash': Object.freeze({
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheHitPerMillion: 0.02,
    }),
    'deepseek-v4-pro': Object.freeze({
      inputPerMillion: 3,
      outputPerMillion: 6,
      cacheHitPerMillion: 0.025,
    }),
  }),
  default: Object.freeze({
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheHitPerMillion: 0.02,
  }),
})

/** DeepSeek's official Beijing peak windows (09:00-12:00, 14:00-18:00). */
export const DEFAULT_PEAK_HOURS: readonly (readonly [number, number])[] = [
  [9, 12],
  [14, 18],
]

/** The four known price keys; anything else in a price object is rejected. */
const PRICE_KEYS: ReadonlySet<string> = new Set([
  'inputPerMillion',
  'outputPerMillion',
  'cacheHitPerMillion',
  'cacheWritePerMillion',
  'peak',
])
const PEAK_KEYS: ReadonlySet<string> = new Set([
  'inputPerMillion',
  'outputPerMillion',
  'cacheHitPerMillion',
  'cacheWritePerMillion',
  'hours',
])

/** Validate one price amount: finite, non-negative number. */
function checkAmount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite non-negative number`)
  }
  return value
}

/** Validate the optional peak block of one model entry. */
function resolvePeak(value: unknown, path: string): PeakPrice | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!PEAK_KEYS.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
  let hours: [number, number][] = [...DEFAULT_PEAK_HOURS] as [number, number][]
  if (raw.hours !== undefined) {
    if (!Array.isArray(raw.hours) || raw.hours.length === 0) {
      throw new Error(`${path}.hours must be a non-empty array of [start, end) hour ranges`)
    }
    hours = raw.hours.map((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2
        || !Number.isInteger(entry[0]) || !Number.isInteger(entry[1])
        || entry[0] < 0 || entry[0] >= 24 || entry[1] <= entry[0] || entry[1] > 24) {
        throw new Error(`${path}.hours[${index}] must be an integer [start, end) range within 0..24`)
      }
      return [entry[0], entry[1]]
    })
  }
  return {
    inputPerMillion: checkAmount(raw.inputPerMillion, `${path}.inputPerMillion`),
    outputPerMillion: checkAmount(raw.outputPerMillion, `${path}.outputPerMillion`),
    cacheHitPerMillion: checkAmount(raw.cacheHitPerMillion, `${path}.cacheHitPerMillion`),
    ...raw.cacheWritePerMillion === undefined
      ? {}
      : { cacheWritePerMillion: checkAmount(raw.cacheWritePerMillion, `${path}.cacheWritePerMillion`) },
    hours,
  }
}

/**
 * Validate one model price entry, failing loud on any malformed field.
 * @param value - the raw entry from config or the settings seam.
 * @param path - diagnostic path prefix (e.g. "cost-tracker: prices.models.x").
 * @returns the validated, frozen entry.
 */
export function resolveModelPrice(value: unknown, path: string): ModelPrice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!PRICE_KEYS.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
  const peak = resolvePeak(raw.peak, `${path}.peak`)
  return Object.freeze({
    inputPerMillion: checkAmount(raw.inputPerMillion, `${path}.inputPerMillion`),
    outputPerMillion: checkAmount(raw.outputPerMillion, `${path}.outputPerMillion`),
    cacheHitPerMillion: checkAmount(raw.cacheHitPerMillion, `${path}.cacheHitPerMillion`),
    ...raw.cacheWritePerMillion === undefined
      ? {}
      : { cacheWritePerMillion: checkAmount(raw.cacheWritePerMillion, `${path}.cacheWritePerMillion`) },
    ...peak === undefined ? {} : { peak },
  })
}

/**
 * Validate the whole price table: the required `default` entry plus the
 * per-model map. Fails loud (throws) on a malformed table so a wrong price
 * document can never silently mis-bill.
 * @param value - the raw table.
 * @returns the validated, frozen table.
 */
export function resolvePriceTable(value: unknown): PriceTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('cost-tracker: prices must be an object')
  }
  const raw = value as Record<string, unknown>
  const defaultPrice = raw.default === undefined
    ? undefined
    : resolveModelPrice(raw.default, 'cost-tracker: prices.default')
  if (defaultPrice === undefined) {
    throw new Error('cost-tracker: prices.default is required')
  }
  const models: Record<string, ModelPrice> = {}
  if (raw.models !== undefined) {
    if (typeof raw.models !== 'object' || raw.models === null || Array.isArray(raw.models)) {
      throw new Error('cost-tracker: prices.models must be an object')
    }
    for (const [model, entry] of Object.entries(raw.models as Record<string, unknown>)) {
      if (model.length === 0) throw new Error('cost-tracker: prices.models keys must be non-empty')
      models[model] = resolveModelPrice(entry, `cost-tracker: prices.models.${model}`)
    }
  }
  return Object.freeze({ default: defaultPrice, models: Object.freeze(models) })
}

/** Whether a local-time hour falls inside any peak window. */
export function isPeakHour(hour: number, hours: readonly (readonly [number, number])[]): boolean {
  return hours.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Resolve the effective price for one model at one instant: the model's own
 * entry when present, else the table default; the peak block when the instant
 * falls in a peak window and the entry declares one.
 */
export function priceFor(table: PriceTable, model: string, atMs: number): ModelPrice {
  const entry = table.models[model] ?? table.default
  const peak = entry.peak
  if (peak === undefined) return entry
  const hours = peak.hours ?? DEFAULT_PEAK_HOURS
  if (!isPeakHour(new Date(atMs).getHours(), hours)) return entry
  return Object.freeze({
    inputPerMillion: peak.inputPerMillion,
    outputPerMillion: peak.outputPerMillion,
    cacheHitPerMillion: peak.cacheHitPerMillion,
    ...peak.cacheWritePerMillion === undefined
      ? entry.cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion: entry.cacheWritePerMillion }
      : { cacheWritePerMillion: peak.cacheWritePerMillion },
  })
}

/** Token counts a cost computation needs (a projection of TokenUsage). */
export interface CostUsage {
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Cache-hit tokens; absent degrades to input-price-only billing. */
  cacheReadTokens?: number
  /** Cache-write tokens; absent treated as zero. */
  cacheWriteTokens?: number
}

/** Money result of one call: the four billed buckets and their sum. */
export interface CostBreakdown {
  inputCost: number
  cacheHitCost: number
  cacheWriteCost: number
  outputCost: number
  totalCost: number
}

/**
 * Compute the billed cost of one call against one price entry.
 *
 * - cache-hit cost = cacheReadTokens × cache-hit price
 * - cache-miss cost = inputTokens × input price (uncached input IS the miss)
 * - output cost = outputTokens × output price
 * - cache-write cost = cacheWriteTokens × cache-write price (0 when absent)
 * - no cache detail → input cost + output cost (degraded, still billed)
 *
 * @param usage - the call's token counts.
 * @param price - the effective price entry (peak-resolved by the caller or {@link priceFor}).
 * @returns the four bucket costs and their sum.
 */
export function computeCost(usage: CostUsage, price: ModelPrice): CostBreakdown {
  const inputCost = usage.inputTokens / 1_000_000 * price.inputPerMillion
  const outputCost = usage.outputTokens / 1_000_000 * price.outputPerMillion
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheHitCost = cacheReadTokens / 1_000_000 * price.cacheHitPerMillion
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const cacheWriteCost = cacheWriteTokens / 1_000_000 * (price.cacheWritePerMillion ?? 0)
  return {
    inputCost,
    cacheHitCost,
    cacheWriteCost,
    outputCost,
    totalCost: inputCost + cacheHitCost + cacheWriteCost + outputCost,
  }
}
