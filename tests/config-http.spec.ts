import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { handleCostTrackerBridge, isTrustedBridgeRequest } from '../src/config-http.ts'
import { CostStore } from '../src/store.ts'
import { DEFAULT_PRICE_TABLE } from '../src/pricing.ts'

let store: CostStore | undefined

afterEach(async () => {
  await store?.init()
  store = undefined
})

async function tempStore(): Promise<CostStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-tracker-http-'))
  store = new CostStore(dir)
  await store.init()
  return store
}

function fakeRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const headers: Record<string, string | undefined> = {
    host: '127.0.0.1:3080',
    ...(overrides.headers as Record<string, string | undefined> | undefined),
  }
  return {
    headers,
    method: 'GET',
    url: '/cost-tracker/overview',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as IncomingMessage
}

describe('isTrustedBridgeRequest', () => {
  it('accepts loopback requests without an Origin', () => {
    expect(isTrustedBridgeRequest(fakeRequest())).toBe(true)
    expect(isTrustedBridgeRequest(fakeRequest({ socket: { remoteAddress: '::1' } }))).toBe(true)
    expect(isTrustedBridgeRequest(fakeRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }))).toBe(true)
  })

  it('accepts a same-origin Origin', () => {
    expect(isTrustedBridgeRequest(fakeRequest({
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    }))).toBe(true)
  })

  it('rejects LAN peers, cross-site requests and mismatched origins', () => {
    expect(isTrustedBridgeRequest(fakeRequest({ socket: { remoteAddress: '192.168.1.10' } }))).toBe(false)
    expect(isTrustedBridgeRequest(fakeRequest({
      headers: { 'sec-fetch-site': 'cross-site' },
    }))).toBe(false)
    expect(isTrustedBridgeRequest(fakeRequest({
      headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
    }))).toBe(false)
    expect(isTrustedBridgeRequest(fakeRequest({
      headers: { host: '127.0.0.1:3080', origin: 'not a url' },
    }))).toBe(false)
    expect(isTrustedBridgeRequest(fakeRequest({ headers: { origin: 'http://x' } }))).toBe(false)
  })
})

describe('handleCostTrackerBridge', () => {
  async function call(request: IncomingMessage, store: CostStore): Promise<{ status: number; body: unknown }> {
    const out = { status: 0, body: undefined as unknown }
    const res = {
      writeHead(status: number) { out.status = status },
      end(body?: unknown) { out.body = body === undefined ? undefined : JSON.parse(String(body)) },
    }
    await handleCostTrackerBridge(
      { get: () => undefined },
      { store, prices: () => DEFAULT_PRICE_TABLE },
      request,
      res as never,
    )
    return out
  }

  it('refuses non-loopback requests with 403', async () => {
    const store = await tempStore()
    const result = await call(fakeRequest({ socket: { remoteAddress: '10.0.0.5' } }), store)
    expect(result.status).toBe(403)
  })

  it('rejects unsupported methods with 405', async () => {
    const store = await tempStore()
    const result = await call(fakeRequest({ method: 'DELETE' }), store)
    expect(result.status).toBe(405)
  })

  it('serves overview, options and session endpoints', async () => {
    const store = await tempStore()
    const overview = await call(fakeRequest({ url: '/cost-tracker/overview' }), store)
    expect(overview.status).toBe(200)
    expect(overview.body).toMatchObject({ requests: 0, realTotalTokens: 0, totalCost: 0 })

    const options = await call(fakeRequest({ url: '/cost-tracker/options' }), store)
    expect(options.body).toEqual({ providers: [], models: [] })

    const session = await call(fakeRequest({ url: '/cost-tracker/session?id=s1' }), store)
    expect(session.body).toMatchObject({ sessionId: 's1', requests: 0, totalCost: 0 })
  })

  it('rejects malformed queries with 400', async () => {
    const store = await tempStore()
    const badRange = await call(fakeRequest({ url: '/cost-tracker/overview?fromMs=100&toMs=50' }), store)
    expect(badRange.status).toBe(400)
    const badNumber = await call(fakeRequest({ url: '/cost-tracker/overview?fromMs=abc' }), store)
    expect(badNumber.status).toBe(400)
    const noId = await call(fakeRequest({ url: '/cost-tracker/session' }), store)
    expect(noId.status).toBe(400)
  })

  it('404s unknown paths', async () => {
    const store = await tempStore()
    const result = await call(fakeRequest({ url: '/cost-tracker/nope' }), store)
    expect(result.status).toBe(404)
  })
})
