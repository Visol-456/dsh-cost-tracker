/**
 * Regression: the price-table settings namespace must register whenever a
 * settings provider is mounted. The base layer passed to the provider must be
 * a *detached* clone — DEFAULT_PRICE_TABLE / resolvePriceTable() are
 * deep-frozen, and the provider's schema coercion writes into the merged base
 * layer; a frozen base made register() throw ("Cannot assign to read only
 * property"), the namespace silently never registered, and the config bridge
 * reported the price editor unavailable (`available: false`).
 * @module dsh-cost-tracker/tests/settings-registration
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as costTracker from '../src/index.ts'

/** Minimal in-memory settings provider (file providers need disk + chokidar). */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  private document: Record<string, unknown> = {}

  protected async load(): Promise<Record<string, unknown>> {
    return this.document
  }

  protected async persist(_ns: string, section: Record<string, unknown>): Promise<void> {
    this.document = { ...this.document, ...section }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('settings namespace registration', () => {
  it('registers the cost-tracker price section when a settings provider is mounted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cost-tracker-settings-'))
    context = new Context()
    await context.plugin(AgentRegistry)
    await context.plugin(MemorySettings)
    await context.plugin(costTracker, { dataDir: join(root, 'costs') })

    const settings = context.get('settings')
    expect(settings).toBeDefined()

    const descriptors = settings!.describe({ redactSecrets: true })
    const price = descriptors.find(candidate => candidate.ns === 'cost-tracker')
    expect(price, 'cost-tracker namespace must be registered').toBeDefined()
    // The resolved value equals the default table (composition base).
    expect(price!.value).toMatchObject({
      default: { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02 },
      models: {
        'deepseek-v4-flash': { inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 0.02 },
      },
    })
  })

  it('keeps recording when no settings provider is mounted (optional service)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cost-tracker-no-settings-'))
    context = new Context()
    await context.plugin(AgentRegistry)
    // No settings provider: the plugin must still apply without error.
    await context.plugin(costTracker, { dataDir: join(root, 'costs') })
    expect(context.get('settings')).toBeUndefined()
  })
})
