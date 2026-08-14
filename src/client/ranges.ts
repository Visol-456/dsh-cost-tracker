/**
 * Date-range vocabulary for the usage dashboard: presets (today/1d/7d/14d/30d
 * /custom, mirroring CC Switch) and the pure resolution to [fromMs, toMs).
 * Deliberately free of framework imports so it runs in node tests.
 * @module @visol-456/dsh-cost-tracker/client/ranges
 */

/** Date-range preset (mirror of the CC Switch range vocabulary). */
export type RangePreset = 'today' | '1d' | '7d' | '14d' | '30d' | 'custom'

export interface RangeSelection {
  preset: RangePreset
  customStart?: number
  customEnd?: number
}

const DAY_MS = 86_400_000

/** Resolve a range selection to [fromMs, toMs), live end by default. */
export function resolveRange(selection: RangeSelection, nowMs: number = Date.now()): { fromMs: number; toMs: number } {
  const startOfToday = new Date(nowMs)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  switch (selection.preset) {
    case 'today':
      return { fromMs: todayMs, toMs: nowMs }
    case '1d':
      return { fromMs: nowMs - DAY_MS, toMs: nowMs }
    case '7d':
      return { fromMs: todayMs - 6 * DAY_MS, toMs: nowMs }
    case '14d':
      return { fromMs: todayMs - 13 * DAY_MS, toMs: nowMs }
    case '30d':
      return { fromMs: todayMs - 29 * DAY_MS, toMs: nowMs }
    case 'custom':
      return {
        fromMs: selection.customStart ?? nowMs - DAY_MS,
        toMs: selection.customEnd ?? nowMs,
      }
  }
}
