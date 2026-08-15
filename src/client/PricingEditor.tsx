/**
 * Price-table editor: structured rows (default + per-model) with optional
 * peak/off-peak blocks, saved through the loopback config bridge
 * (revision-fenced). Server-side validation is the fail-loud backstop; the
 * form validates locally first.
 * @module @visol-456/dsh-cost-tracker/client/pricing-editor
 */

import { useEffect, useState } from 'react'
import {
  emptyModelPrice, formFromWire, priceSectionFromForm, type CostPriceForm, type CostModelPriceForm,
} from './usage-stats-model.ts'
import { loadPriceConfig, resetPriceConfig, savePriceConfig, type PriceConfigViewWire } from './store.ts'
import css from './UsageStats.module.css'

interface PricingEditorProps {
  t: (key: string, params?: Record<string, unknown>) => string
}

type EditorStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; available: boolean; writable: boolean; revision: number | undefined }
  | { kind: 'error'; message: string }

/**
 * The editable price table: loads the resolved table on mount, stages edits
 * locally, saves the whole section (revision-fenced), resets to defaults.
 */
export function PricingEditor({ t }: PricingEditorProps) {
  const [status, setStatus] = useState<EditorStatus>({ kind: 'loading' })
  const [form, setForm] = useState<CostPriceForm | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    loadPriceConfig().then((view) => {
      if (cancelled) return
      setForm(formFromWire(view.value))
      setStatus({
        kind: 'ready',
        available: view.available,
        writable: view.writable,
        revision: view.revision,
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true }
  }, [])

  const patchRow = (key: 'default' | string, patch: Partial<CostModelPriceForm>): void => {
    if (form === undefined) return
    if (key === 'default') {
      setForm({ ...form, default: { ...form.default, ...patch } })
    } else {
      const row = form.models[key] ?? emptyModelPrice()
      setForm({ ...form, models: { ...form.models, [key]: { ...row, ...patch } } })
    }
    setDirty(true)
    setMessage(null)
  }

  const renameModel = (from: string, to: string): void => {
    if (form === undefined) return
    const models: Record<string, CostModelPriceForm> = {}
    for (const [model, row] of Object.entries(form.models)) {
      models[model === from ? to : model] = row
    }
    setForm({ ...form, models })
    setDirty(true)
  }

  const removeModel = (model: string): void => {
    if (form === undefined) return
    const models: Record<string, CostModelPriceForm> = {}
    for (const [name, row] of Object.entries(form.models)) {
      if (name !== model) models[name] = row
    }
    setForm({ ...form, models })
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (form === undefined || status.kind !== 'ready') return
    let section: Record<string, unknown>
    try {
      section = priceSectionFromForm(form)
    } catch (error) {
      setMessage({ kind: 'error', text: t('invalidPrices', { message: error instanceof Error ? error.message : String(error) }) })
      return
    }
    setSaving(true)
    const result = await savePriceConfig(section, status.revision)
    setSaving(false)
    if (result.ok) {
      setMessage({ kind: 'ok', text: t('saved') })
      setDirty(false)
      setStatus({
        kind: 'ready',
        available: result.view.available,
        writable: result.view.writable,
        revision: result.view.revision,
      })
    } else if (result.code === 'conflict') {
      setMessage({ kind: 'error', text: `${t('conflictTitle')} ${result.message}` })
    } else {
      setMessage({ kind: 'error', text: `${t('priceSaveFailed')} ${result.message}` })
    }
  }

  const reset = async (): Promise<void> => {
    if (status.kind !== 'ready') return
    if (!window.confirm(t('resetConfirm'))) return
    setSaving(true)
    const result = await resetPriceConfig(status.revision)
    setSaving(false)
    if (result.ok) {
      setForm(formFromWire(result.view.value))
      setDirty(false)
      setMessage({ kind: 'ok', text: t('saved') })
      setStatus({
        kind: 'ready',
        available: result.view.available,
        writable: result.view.writable,
        revision: result.view.revision,
      })
    } else {
      setMessage({ kind: 'error', text: `${t('priceSaveFailed')} ${result.message}` })
    }
  }

  if (status.kind === 'loading') return <div className={css.pricingCard}>{t('loading')}</div>
  if (status.kind === 'error') {
    return <div className={css.pricingCard}><div className={css.error}>{t('loadFailed')} {status.message}</div></div>
  }
  if (form === undefined) return null

  // Without a settings provider the table is a read-only view of the
  // deployment's price table — explain where to edit it instead of showing
  // a bare error.
  const readOnly = !status.available || !status.writable

  return (
    <div className={css.pricingCard}>
      <div className={css.cardHeader}>
        <h3 className={css.cardTitle}>{t('pricing')}</h3>
        <span className={css.cardMeta}>{t('pricingDescription')}</span>
      </div>
      {!status.available && <div className={css.pricingNotice}>{t('pricesUnavailable')}</div>}

      <div className={css.priceRow}>
        <div className={css.priceRowHeader}>{t('defaultPrice')}</div>
        <PriceFields row={form.default} onChange={(patch) => patchRow('default', patch)} t={t} disabled={readOnly} />
      </div>

      <div className={css.priceRowHeader}>{t('modelPrices')}</div>
      {Object.entries(form.models).map(([model, row]) => (
        <div key={model} className={css.priceRow}>
          <div className={css.priceRowTitle}>
            <input
              className={css.modelInput}
              value={model}
              disabled={readOnly}
              onChange={(event) => renameModel(model, event.target.value)}
            />
            <button type="button" className={css.removeButton} disabled={readOnly} onClick={() => removeModel(model)}>
              {t('removeModel')}
            </button>
          </div>
          <PriceFields row={row} onChange={(patch) => patchRow(model, patch)} t={t} disabled={readOnly} />
        </div>
      ))}
      <button
        type="button"
        className={css.addButton}
        disabled={readOnly}
        onClick={() => {
          if (form === undefined) return
          setForm({ ...form, models: { ...form.models, '': emptyModelPrice() } })
          setDirty(true)
        }}
      >
        + {t('addModel')}
      </button>

      <div className={css.priceActions}>
        <button type="button" className={css.saveButton} disabled={saving || readOnly || !dirty} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </button>
        <button type="button" className={css.resetButton} disabled={saving || readOnly} onClick={() => void reset()}>
          {saving ? t('resetting') : t('reset')}
        </button>
        {message !== null && (
          <span className={message.kind === 'ok' ? css.okMessage : css.errorMessage}>{message.text}</span>
        )}
      </div>
    </div>
  )
}

interface PriceFieldsProps {
  row: CostModelPriceForm
  onChange: (patch: Partial<CostModelPriceForm>) => void
  t: (key: string, params?: Record<string, unknown>) => string
  disabled?: boolean
}

/** One price row: three price inputs + optional peak block. */
function PriceFields({ row, onChange, t, disabled = false }: PriceFieldsProps) {
  return (
    <div className={css.priceFields}>
      <label className={css.priceField}>
        <span>{t('inputPerMillion')}</span>
        <input
          className={css.priceInput}
          type="number"
          min={0}
          step="any"
          disabled={disabled}
          value={row.inputPerMillion}
          onChange={(event) => onChange({ inputPerMillion: event.target.value })}
        />
      </label>
      <label className={css.priceField}>
        <span>{t('outputPerMillion')}</span>
        <input
          className={css.priceInput}
          type="number"
          min={0}
          step="any"
          disabled={disabled}
          value={row.outputPerMillion}
          onChange={(event) => onChange({ outputPerMillion: event.target.value })}
        />
      </label>
      <label className={css.priceField}>
        <span>{t('cacheHitPerMillion')}</span>
        <input
          className={css.priceInput}
          type="number"
          min={0}
          step="any"
          disabled={disabled}
          value={row.cacheHitPerMillion}
          onChange={(event) => onChange({ cacheHitPerMillion: event.target.value })}
        />
      </label>
      <label className={css.peakToggle}>
        <input
          type="checkbox"
          disabled={disabled}
          checked={row.peak}
          onChange={(event) => onChange({ peak: event.target.checked })}
        />
        <span>{t('peakPrices')}</span>
      </label>
      {row.peak && (
        <div className={css.peakFields}>
          <label className={css.priceField}>
            <span>{t('inputPerMillion')} (peak)</span>
            <input
              className={css.priceInput}
              type="number"
              min={0}
              step="any"
              disabled={disabled}
              value={row.peakInputPerMillion}
              onChange={(event) => onChange({ peakInputPerMillion: event.target.value })}
            />
          </label>
          <label className={css.priceField}>
            <span>{t('outputPerMillion')} (peak)</span>
            <input
              className={css.priceInput}
              type="number"
              min={0}
              step="any"
              disabled={disabled}
              value={row.peakOutputPerMillion}
              onChange={(event) => onChange({ peakOutputPerMillion: event.target.value })}
            />
          </label>
          <label className={css.priceField}>
            <span>{t('cacheHitPerMillion')} (peak)</span>
            <input
              className={css.priceInput}
              type="number"
              min={0}
              step="any"
              disabled={disabled}
              value={row.peakCacheHitPerMillion}
              onChange={(event) => onChange({ peakCacheHitPerMillion: event.target.value })}
            />
          </label>
          <label className={css.priceField}>
            <span>{t('peakHours')}</span>
            <input
              className={css.priceInput}
              disabled={disabled}
              value={row.peakHours}
              onChange={(event) => onChange({ peakHours: event.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  )
}
