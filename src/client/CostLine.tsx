/**
 * Conversation cost line (requirement A) + session summary card (B).
 *
 * Mounted on the `conversation.composer.dock` seat, one order after the
 * shipped stats line, so the band reads: `turns/steps | … | cache % | in/out`
 * then `费用 ¥0.0042 · 会话 ¥0.1234` — the per-call cost "column" of the
 * existing stats row, plus a click-to-expand per-session summary card.
 *
 * The standard kit for session-scoped slot entries (sessionId, useSession)
 * is delivered by the slot framework; the summary refreshes whenever the
 * conversation snapshot changes (new message, session switch) and every
 * 30 seconds while mounted.
 * @module @visol-456/dsh-cost-tracker/client/cost-line
 */

import { memo, useEffect, useRef, useState } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// 0.1.1 的 renderer 运行时导出 useSyncExternalStoreWithSelector（公共），
// 类型暂未随包发布——本地补齐声明后复用（与官方 bindSnapshotSelector 同构）。
import { useSyncExternalStoreWithSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
declare module '@deepseek-ai/dsh-client-ui-renderer/client' {
  export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: undefined | (() => Snapshot),
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: ((a: Selection, b: Selection) => boolean) | undefined,
  ): Selection
}
/** 官方 bindSnapshotSelector 未公开导出，用公共 API 实现同款绑定。 */
function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void): (() => void) => w.subscribe(fn)
  const getSnapshot = (): T => w.getSnapshot()
  return (sel, eq) => useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)
}
import { CostLineStore } from './store.ts'
import { formatCost } from './chart.tsx'
import type { CostTrackerKey } from './locales.ts'
import css from './CostLine.module.css'

/** Props delivered by the dock outlet: the standard kit (plus locale seat).
 *  Partial so the slot framework fills every field from the kit/locale. */
export interface CostLineProps {
  sessionId: string | undefined
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  t: (key: CostTrackerKey, params?: Record<string, unknown>) => string
}

export type CostLineSlotProps = Partial<CostLineProps>

const REFRESH_MS = 30_000

/** One controller per mounted entry (fresh on session switch). */
const controllers = new Map<string, CostLineStore>()

function controllerFor(sessionId: string): CostLineStore {
  let controller = controllers.get(sessionId)
  if (controller === undefined) {
    controller = new CostLineStore()
    controllers.set(sessionId, controller)
  }
  return controller
}

/** The summary line: `费用 ¥0.0042 · 会话 ¥0.1234` with a summary toggle. */
export const CostLine = memo(function CostLine({ sessionId, useSession, t }: CostLineSlotProps) {
  if (useSession === undefined || t === undefined) return null
  // The settled node list changes on every committed session event; its
  // identity is the "new message" refresh trigger.
  const nodes = useSession(s => s.chat.legacy.nodes)
  const controller = sessionId === undefined ? undefined : controllerFor(sessionId)
  const useSnapshot = controller === undefined ? undefined : bindSnapshotSelector(controller.store)
  const summary = useSnapshot === undefined ? undefined : useSnapshot(s => s.summary)
  const status = useSnapshot === undefined ? undefined : useSnapshot(s => s.status)
  const [open, setOpen] = useState(false)

  const nodesRef = useRef(nodes)
  useEffect(() => {
    const changed = nodesRef.current !== nodes
    nodesRef.current = nodes
    if (changed || summary === undefined) {
      if (sessionId !== undefined) void controllerFor(sessionId).load(sessionId)
    }
  }, [nodes, sessionId, summary])

  // Slow refresh while mounted (the bridge is cheap; keeps totals honest
  // even if a snapshot signal is missed).
  useEffect(() => {
    if (sessionId === undefined) return
    const timer = setInterval(() => { void controllerFor(sessionId).load(sessionId) }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [sessionId])

  if (sessionId === undefined || summary === undefined) return null

  const line = summary.requests === 0
    ? null
    : (
      <>
        <span>{t('costLine')} <span className={css.amount}>{t('currency')}{formatCost(summary.latest?.totalCost ?? 0)}</span> {t('thisCall')}</span>
        <span className={css.sep}>|</span>
        <span>{t('sessionCost')} <span className={css.amount}>{t('currency')}{formatCost(summary.totalCost)}</span></span>
        <button
          type="button"
          className={css.toggle}
          onClick={() => setOpen(previous => !previous)}
        >
          {open ? t('hideSummary') : t('showSummary')}
        </button>
      </>
    )

  if (status === 'error' || line === null) return null

  return (
    <>
      <div className={css.root}>{line}</div>
      {open && (
        <SessionSummaryCard summary={summary} t={t} />
      )}
    </>
  )
})

interface SessionSummaryCardProps {
  summary: NonNullable<ReturnType<CostLineStore['store']['getSnapshot']>['summary']>
  t: (key: CostTrackerKey, params?: Record<string, unknown>) => string
}

/** The expandable per-session summary: total cost + three cost buckets +
 *  token counts + cache-hit rate. */
function SessionSummaryCard({ summary, t }: SessionSummaryCardProps) {
  const hitPercent = summary.cacheHitRate === null
    ? null
    : Math.min(100, Math.max(0, summary.cacheHitRate * 100))
  const cells: { label: string; value: string }[] = [
    { label: t('cacheMissCost'), value: `${t('currency')}${formatCost(summary.inputCost)}` },
    { label: t('cacheRead'), value: `${t('currency')}${formatCost(summary.cacheHitCost)}` },
    { label: t('cacheWriteCost'), value: `${t('currency')}${formatCost(summary.cacheWriteCost)}` },
    { label: t('output'), value: `${t('currency')}${formatCost(summary.outputCost)}` },
    { label: `${t('freshInput')} (tokens)`, value: summary.inputTokens.toLocaleString() },
    { label: `${t('output')} (tokens)`, value: summary.outputTokens.toLocaleString() },
    { label: `${t('cacheRead')} (tokens)`, value: summary.cacheReadTokens.toLocaleString() },
    { label: `${t('sessionAvgTtft')}`, value: summary.ttftMsAvg === null ? t('none') : `${Math.round(summary.ttftMsAvg)}ms` },
  ]
  return (
    <div className={css.card}>
      <div className={css.cardTitle}>{t('sessionSummary')}</div>
      <div className={css.totalRow}>
        <span className={css.totalAmount}>{t('currency')}{formatCost(summary.totalCost)}</span>
        <span className={css.totalMeta}>
          {summary.requests} {t('sessionRequests')} · {t('sessionTokens')}: {(summary.inputTokens + summary.outputTokens + summary.cacheReadTokens + summary.cacheWriteTokens).toLocaleString()}
        </span>
        {summary.latest !== undefined && (
          <span className={css.totalMeta}>{summary.latest.provider} / {summary.latest.model}</span>
        )}
      </div>
      <div className={css.grid}>
        {cells.map(cell => (
          <div key={cell.label} className={css.cell}>
            <div className={css.cellLabel}>{cell.label}</div>
            <div className={css.cellValue}>{cell.value}</div>
          </div>
        ))}
        <div key="hit-rate" className={css.cell}>
          <div className={css.cellLabel}>{t('cacheHitRate')}</div>
          <div className={css.cellValue}>
            {hitPercent === null ? t('none') : `${hitPercent >= 99.95 ? hitPercent.toFixed(0) : hitPercent.toFixed(1)}%`}
          </div>
          <div className={css.hitRateBar}>
            <div className={css.hitRateFill} style={{ width: `${hitPercent ?? 0}%` }} />
          </div>
        </div>
      </div>
    </div>
  )
}
