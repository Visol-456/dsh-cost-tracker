/**
 * Price-editor form model: converts between the bridge price-table wire
 * shape and the editable form rows, plus the peak-hours text parsing.
 * @module @visol-456/dsh-cost-tracker/client/usage-stats-model
 */

/** Editable form of one model price entry. */
export interface CostModelPriceForm {
  inputPerMillion: string
  outputPerMillion: string
  cacheHitPerMillion: string
  peak: boolean
  peakInputPerMillion: string
  peakOutputPerMillion: string
  peakCacheHitPerMillion: string
  peakHours: string
}

/** The whole editable table. */
export interface CostPriceForm {
  default: CostModelPriceForm
  models: Record<string, CostModelPriceForm>
}

/** One blank price row. */
export function emptyModelPrice(): CostModelPriceForm {
  return {
    inputPerMillion: '',
    outputPerMillion: '',
    cacheHitPerMillion: '',
    peak: false,
    peakInputPerMillion: '',
    peakOutputPerMillion: '',
    peakCacheHitPerMillion: '',
    peakHours: '9-12,14-18',
  }
}

/** Parse "9-12,14-18" into [[9,12],[14,18]]; throws on malformed input. */
export function parseHours(text: string): [number, number][] {
  const ranges = text.split(',').map(part => part.trim()).filter(part => part !== '')
  if (ranges.length === 0) throw new Error('peak hours must list at least one range')
  return ranges.map((part, index) => {
    const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(part)
    if (match === null) throw new Error(`peak hours[${index}] must look like "9-12"`)
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= 24 || end <= start || end > 24) {
      throw new Error(`peak hours[${index}] must be an integer [start, end) range within 0..24`)
    }
    return [start, end]
  })
}

/** Parse a price input into a finite non-negative number. */
export function parsePrice(text: string, label: string): number {
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`)
  return value
}

/** Convert the form back into the wire price-table section. */
export function priceSectionFromForm(form: CostPriceForm): Record<string, unknown> {
  const priceOf = (row: CostModelPriceForm, label: string): Record<string, unknown> => {
    const price: Record<string, unknown> = {
      inputPerMillion: parsePrice(row.inputPerMillion, `${label} input`),
      outputPerMillion: parsePrice(row.outputPerMillion, `${label} output`),
      cacheHitPerMillion: parsePrice(row.cacheHitPerMillion, `${label} cache hit`),
    }
    if (row.peak) {
      price.peak = {
        inputPerMillion: parsePrice(row.peakInputPerMillion, `${label} peak input`),
        outputPerMillion: parsePrice(row.peakOutputPerMillion, `${label} peak output`),
        cacheHitPerMillion: parsePrice(row.peakCacheHitPerMillion, `${label} peak cache hit`),
        hours: parseHours(row.peakHours),
      }
    }
    return price
  }
  const models: Record<string, unknown> = {}
  for (const [model, row] of Object.entries(form.models)) {
    if (model.trim() === '') throw new Error('model names must be non-empty')
    models[model.trim()] = priceOf(row, `"${model}"`)
  }
  return { default: priceOf(form.default, 'default'), models }
}

/** Wire price entry shape (mirror of the node half). */
interface WirePrice {
  inputPerMillion: number
  outputPerMillion: number
  cacheHitPerMillion: number
  peak?: {
    inputPerMillion: number
    outputPerMillion: number
    cacheHitPerMillion: number
    hours?: [number, number][]
  }
}

function rowFromWire(price: WirePrice | undefined): CostModelPriceForm {
  if (price === undefined) return emptyModelPrice()
  const peak = price.peak
  return {
    inputPerMillion: String(price.inputPerMillion ?? ''),
    outputPerMillion: String(price.outputPerMillion ?? ''),
    cacheHitPerMillion: String(price.cacheHitPerMillion ?? ''),
    peak: peak !== undefined,
    peakInputPerMillion: peak === undefined ? '' : String(peak.inputPerMillion ?? ''),
    peakOutputPerMillion: peak === undefined ? '' : String(peak.outputPerMillion ?? ''),
    peakCacheHitPerMillion: peak === undefined ? '' : String(peak.cacheHitPerMillion ?? ''),
    peakHours: peak?.hours === undefined
      ? '9-12,14-18'
      : peak.hours.map(([start, end]) => `${start}-${end}`).join(','),
  }
}

/** Convert the resolved wire value into the editable form. */
export function formFromWire(value: unknown): CostPriceForm {
  const table = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const defaultPrice = typeof table.default === 'object' && table.default !== null
    ? table.default as WirePrice
    : undefined
  const modelsRaw = typeof table.models === 'object' && table.models !== null
    ? table.models as Record<string, WirePrice>
    : {}
  const models: Record<string, CostModelPriceForm> = {}
  for (const [model, price] of Object.entries(modelsRaw)) models[model] = rowFromWire(price)
  return { default: rowFromWire(defaultPrice), models }
}
