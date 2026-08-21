import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as costTracker from '../src/index.ts'
import { CostStore, RECORDS_FILE } from '../src/store.ts'

let root: string | undefined
let context: Context | undefined
let costsDir: string | undefined

/** Adapter reporting a DeepSeek-style usage with cache-hit tokens. */
class UsageAdapter extends LlmAdapter {
  readonly requests: string[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.model)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'hello from mock' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello from mock' } }
    yield {
      type: 'usage',
      usage: { inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 2_000 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  costsDir = undefined
})

async function loadYaml(buildLines: (costsDir: string) => string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cost-tracker-loader-'))
  costsDir = join(root, 'costs')
  const configPath = join(root, 'cordis.yml')
  await (await import('node:fs/promises')).writeFile(configPath, [...buildLines(costsDir), ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-cost-tracker', costTracker],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  // First resolution after the host/client program split is slow enough to
  // trip the default 5s budget on cold caches (same as the fallback suite).
  it('records one billed call per completed assistant message', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml((costsDir) => [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-cost-tracker'",
      '  config:',
      `    dataDir: ${costsDir}`,
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new UsageAdapter()
    loaded.llm.registerAdapter(['deepseek'], adapter)
    const agent = loaded.agentLoop.create(SessionId('loader-costs'), {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toEqual(['deepseek-v4-flash'])
    const assistant = agent.session.events.find(event => event.type === 'assistant/message')
    expect(assistant).toMatchObject({
      data: {
        message: { source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
        usage: { inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 2_000 },
      },
    })

    // The append is async (durable file write); poll briefly for the log.
    const logPath = join(costsDir!, RECORDS_FILE)
    let log = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        log = await readFile(logPath, 'utf8')
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    expect(log).not.toBe('')
    const records = log.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record).toMatchObject({
      sessionId: 'loader-costs',
      turn: 1,
      step: 1,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 1_000,
      outputTokens: 250,
      cacheReadTokens: 2_000,
      version: 1,
    })
    // Costs are floats; compare with tolerance.
    expect(record.inputCost as number).toBeCloseTo(1_000 / 1_000_000 * 1.5, 12)        // ¥1.5/M uncached (off-peak)
    expect(record.cacheHitCost as number).toBeCloseTo(2_000 / 1_000_000 * 0.05, 12)    // ¥0.05/M cached (off-peak)
    expect(record.outputCost as number).toBeCloseTo(250 / 1_000_000 * 4.5, 12)         // ¥4.5/M output (off-peak)
    expect(record.totalCost as number).toBeCloseTo((1_000 * 1.5 + 2_000 * 0.05 + 250 * 4.5) / 1_000_000, 12)

    // A fresh store over the same directory serves the session summary.
    const store = new CostStore(costsDir!)
    await store.init()
    const summary = store.sessionSummary('loader-costs')
    expect(summary.requests).toBe(1)
    expect(summary.totalCost).toBeCloseTo((1_000 * 1.5 + 2_000 * 0.05 + 250 * 4.5) / 1_000_000, 12)
    expect(summary.cacheHitRate).toBeCloseTo(2_000 / 3_000, 10)
    expect(summary.latest?.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps recording when no web server is mounted', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml((costsDir) => [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-cost-tracker'",
      '  config:',
      `    dataDir: ${costsDir}`,
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])
    const adapter = new UsageAdapter()
    loaded.llm.registerAdapter(['deepseek'], adapter)
    const agent = loaded.agentLoop.create(SessionId('loader-no-web'), {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 50))

    const log = await readFile(join(costsDir!, RECORDS_FILE), 'utf8')
    expect(log.trim().split('\n')).toHaveLength(1)
  })

  it('rejects an unknown plugin config key at load time', { timeout: 60_000 }, async () => {
    await expect(loadYaml(() => [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-cost-tracker'",
      '  config:',
      '    bogusKey: 1',
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])).rejects.toThrow()
  })
})
