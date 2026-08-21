/**
 * Cost tracker client half: registers the Usage statistics conversation view
 * tab (requirement C) and the conversation cost line + session summary on
 * the composer dock (requirements A + B). Data rides the node bridge
 * (`/cost-tracker/*`, loopback-guarded); the view keeps fresh on pushed
 * settings invalidations (price edits) and connection resets.
 * @module @visol-456/dsh-cost-tracker/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the conversation slot declarations (conversation.view,
// composer.dock etc.).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-settings/types'
import { UsageStatsStore } from './store.ts'
import type { UsageStatsState } from './store.ts'
import { UsageStatsView, type UsageStatsViewInjected } from './UsageStats.tsx'
import { CostLine, type CostLineProps } from './CostLine.tsx'
import { zh, en, type CostTrackerKey } from './locales.ts'

export type {
  UsageStatsViewInjected, UsageStatsViewProps,
  UsageStatsSectionInjected, UsageStatsSectionProps,
} from './UsageStats.tsx'
export type { CostLineProps } from './CostLine.tsx'
export {
  CostLineStore, UsageStatsStore, loadPriceConfig, resetPriceConfig, savePriceConfig,
} from './store.ts'
export type {
  CostFilterWire, CostLineState, CostOptionsWire, CostOverviewWire, CostRecordWire,
  CostRequestLogPageWire, CostTrendPointWire, ModelCostStatWire, PriceConfigViewWire,
  ProviderCostStatWire, RangePreset, RangeSelection, SessionCostSummaryWire,
  UsageStatsState,
} from './store.ts'
export type { CostTrackerKey } from './locales.ts'
export { formatCost, formatTokensShort } from './chart.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The cost tracker page + cost line copy. */
    'cost-tracker': CostTrackerKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'cost-tracker'

/** Required services: slots and locale for the registrations, remote for
 *  pushed settings invalidations. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Register the Usage view as a top-level conversation view tab and the cost
 * line on the conversation composer dock. Keep the view fresh on pushed
 * invalidations (settings document changes for this namespace).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cost-tracker: dictionaries')

  const t = ctx.locale.bind(NS) as (key: string, params?: Record<string, unknown>) => string

  // Conversation > 使用统计 tab (requirement C), sibling of Chat/Trajectory.
  const controller = new UsageStatsStore()
  const injected = (_sessionId: SessionId): UsageStatsViewInjected => ({ controller, hooks: { snapshot: controller.store }, t })

  ctx.effect(() => {
    const refresh = (): void => { void controller.load({ fromMs: 0, toMs: Date.now() }, 0) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns === NS) refresh()
      }),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'cost-tracker: pushed invalidations')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'usage',
    order: 2,
    label: () => t('nav'),
    inject: injected,
  }, UsageStatsView))

  // Conversation stats band: per-call cost + session summary (A + B).
  // Order 1 renders right under the shipped stats line (order 0).
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'cost-tracker',
    order: 1,
  }, CostLine))
}
