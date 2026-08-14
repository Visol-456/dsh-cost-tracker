/**
 * Browser data bridge for the cost tracker: serves the price-table config
 * (same settings-seam semantics as the llm-fallback bridge) and every
 * statistics query the web UI needs.
 *
 * Trust: the route is guarded, not authenticated. Every request must come
 * from a loopback socket and must not look cross-site; when the web server is
 * bound to 0.0.0.0 this still admits the local browser (127.0.0.1) while
 * refusing LAN clients, but the guard is a miswrite/cross-site fence, not an
 * auth layer.
 *
 * @module @visol-456/dsh-cost-tracker/config-http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import {
  SettingsConflictError,
  settingsNamespace,
  type SettingsDescriptor,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import type { CostStore } from './store.ts'
import type { PriceTable } from './pricing.ts'
import { granularityFor } from './store.ts'
import type { CostFilter } from './types.ts'

/** Route prefix owning every bridge request. */
export const BRIDGE_PATH = '/cost-tracker'

/** Settings namespace carrying the GUI-edited price table. */
export const COST_TRACKER_SETTINGS_NAMESPACE = settingsNamespace('cost-tracker')

/** Maximum request body the bridge accepts (the price table is small). */
const MAX_BODY_BYTES = 1024 * 1024

/** Wire view of the price-table namespace (mirror of the fallback bridge). */
export interface PriceConfigView {
  /** Whether a settings provider serves the namespace. */
  available: boolean
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Whether the provider owns a local user-editable document. */
  hasDocument: boolean
  /** Resolved value: schema defaults, then base, then the user section. */
  value: unknown
  /** Composition base layer (cordis.yml entry), when one was declared. */
  base?: unknown
  /** Raw saved user section, when one exists. */
  user?: unknown
  /** Monotonic revision of the raw user section; send back to fence a write. */
  revision: number
}

/** Wire error the bridge returns on a rejected write. */
export interface ConfigBridgeError {
  error: {
    /** Stable machine code: `settings-conflict` or `settings-rejected`. */
    code: 'settings-conflict' | 'settings-rejected'
    /** Human message from the settings seam. */
    message: string
  }
}

/** Whether a socket peer address is the loopback interface (v4, v6, v4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '127.0.0.1' || address === '::1') return true
  const mapped = '::ffff:'
  if (address.startsWith(mapped)) return address.slice(mapped.length) === '127.0.0.1'
  return false
}

/**
 * Decide whether one request may reach the bridge. All three conditions must
 * hold: the socket peer is loopback, the browser marks the request not
 * cross-site, and an attached Origin equals the Host authority.
 * @param request - the incoming request.
 * @returns whether the request is trusted.
 */
export function isTrustedBridgeRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers['origin']
  if (origin === undefined) return true
  const host = request.headers['host']
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a bounded JSON request body. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.length
    if (received > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** Parse one query parameter as a non-negative number, or undefined. */
function queryNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return parsed
}

/** Parse one query parameter as a non-negative safe integer, or undefined. */
function queryInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

/** The store-backed services the bridge serves. */
export interface CostTrackerBridgeDeps {
  readonly store: CostStore
  /** Resolve the current effective price table. */
  readonly prices: () => PriceTable
}

/**
 * Register the data bridge on the shared web server.
 * @param ctx - plugin context (must have the `webServer` service injected).
 * @param deps - store + price resolver.
 * @returns the disposer removing the route.
 */
export function registerCostTrackerBridge(ctx: { webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void } }, deps: CostTrackerBridgeDeps): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BRIDGE_PATH,
    handler: (req, res) => void handleCostTrackerBridge(ctx, deps, req, res),
  })
}

/** Whether a stored section carries no keys (a reset leaves an empty object). */
function isEmptySection(section: unknown): boolean {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    && Object.keys(section as Record<string, unknown>).length === 0
}

/** Project one descriptor to its wire view. */
function viewOf(descriptor: SettingsDescriptor, settings: { writable: boolean; hasDocument: boolean }): PriceConfigView {
  return {
    available: true,
    writable: settings.writable,
    hasDocument: settings.hasDocument,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined || isEmptySection(descriptor.user) ? {} : { user: descriptor.user },
    revision: descriptor.revision,
  }
}

/** The namespace's current descriptor, when the provider serves it. */
function descriptorOf(ctx: unknown, ns: SettingsNamespace): SettingsDescriptor | undefined {
  const settings = (ctx as { get(name: string): { describe(options: { redactSecrets: boolean }): SettingsDescriptor[] } | undefined }).get('settings')
  if (settings === undefined) return undefined
  return settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
}

/**
 * Handle one bridge request: the price-table GET/PUT plus every statistics
 * query. Loopback/Origin-guarded at the door.
 * @param ctx - plugin context carrying the settings service.
 * @param deps - store + price resolver.
 * @param request - the incoming node:http request.
 * @param res - the response to write.
 */
export async function handleCostTrackerBridge(
  ctx: unknown,
  deps: CostTrackerBridgeDeps,
  request: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isTrustedBridgeRequest(request)) {
    res.writeHead(403)
    res.end()
    return
  }
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'PUT') {
    res.writeHead(405)
    res.end()
    return
  }
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  const tail = path.startsWith(BRIDGE_PATH) ? path.slice(BRIDGE_PATH.length) : path
  const query = new URL(request.url ?? '/', 'http://localhost').searchParams

  try {
    // ---- price-table config (GET/PUT) ----
    if (tail === '/config') {
      if (method === 'GET') {
        const descriptor = descriptorOf(ctx, COST_TRACKER_SETTINGS_NAMESPACE)
        if (descriptor === undefined) {
          const settings = (ctx as { get(name: string): { writable: boolean; documentPath?: string } | undefined }).get('settings')
          json(res, 200, {
            available: false,
            writable: settings?.writable ?? false,
            hasDocument: settings?.documentPath !== undefined,
            value: deps.prices(),
            revision: 0,
          } satisfies PriceConfigView)
          return
        }
        const settings = (ctx as { get(name: string): { writable: boolean; documentPath?: string } | undefined }).get('settings')
        json(res, 200, viewOf(descriptor, {
          writable: settings?.writable ?? false,
          hasDocument: settings?.documentPath !== undefined,
        }))
        return
      }
      // PUT: revision-fenced replace of the price section.
      const settings = (ctx as { get(name: string): { writable: boolean; documentPath?: string } | undefined }).get('settings')
      if (settings === undefined) {
        json(res, 503, {
          error: { code: 'settings-rejected', message: 'cost-tracker: no settings provider is mounted in this deployment' },
        } satisfies ConfigBridgeError)
        return
      }
      let body: unknown
      try {
        body = await readJson(request)
      } catch (error) {
        json(res, 400, {
          error: { code: 'settings-rejected', message: `cost-tracker: invalid request body: ${error instanceof Error ? error.message : String(error)}` },
        } satisfies ConfigBridgeError)
        return
      }
      const parsed = body as { section?: unknown; expectedRevision?: unknown } | undefined
      if (typeof parsed !== 'object' || parsed === null
        || typeof parsed.section !== 'object' || parsed.section === null || Array.isArray(parsed.section)) {
        json(res, 400, {
          error: { code: 'settings-rejected', message: 'cost-tracker: PUT requires {"section": {...}}' },
        } satisfies ConfigBridgeError)
        return
      }
      const section = parsed.section as Record<string, unknown>
      const expectedRevision = typeof parsed.expectedRevision === 'number' ? parsed.expectedRevision : undefined
      try {
        await (settings as unknown as { replace(ns: SettingsNamespace, section: Record<string, unknown>, revision?: number): Promise<void> })
          .replace(COST_TRACKER_SETTINGS_NAMESPACE, section, expectedRevision)
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          json(res, 409, {
            error: {
              code: 'settings-conflict',
              message: `cost-tracker: prices changed elsewhere (expected revision ${String(error.expected)}, current ${String(error.actual)}); reload and retry`,
            },
          } satisfies ConfigBridgeError)
          return
        }
        json(res, 400, {
          error: {
            code: 'settings-rejected',
            message: error instanceof Error ? error.message : String(error),
          },
        } satisfies ConfigBridgeError)
        return
      }
      const descriptor = descriptorOf(ctx, COST_TRACKER_SETTINGS_NAMESPACE)
      if (descriptor === undefined) {
        json(res, 500, { error: { code: 'settings-rejected', message: 'cost-tracker: namespace vanished after write' } } satisfies ConfigBridgeError)
        return
      }
      json(res, 200, viewOf(descriptor, { writable: settings.writable, hasDocument: settings.documentPath !== undefined }))
      return
    }

    // ---- statistics queries (GET only) ----
    if (method === 'PUT') {
      res.writeHead(405)
      res.end()
      return
    }

    // Shared filter from query parameters.
    const fromMs = queryNumber(query.get('fromMs') ?? undefined, 'fromMs')
    const toMs = queryNumber(query.get('toMs') ?? undefined, 'toMs')
    if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs) {
      throw new Error('toMs must be greater than fromMs')
    }
    const provider = query.get('provider')
    const model = query.get('model')
    const filter: CostFilter = {
      ...fromMs === undefined ? {} : { fromMs },
      ...toMs === undefined ? {} : { toMs },
      ...provider === null || provider === '' ? {} : { provider },
      ...model === null || model === '' ? {} : { model },
    }

    if (tail === '/overview') {
      json(res, 200, deps.store.overview(filter))
      return
    }
    if (tail === '/trends') {
      const from = fromMs ?? 0
      const to = toMs ?? Date.now()
      json(res, 200, deps.store.trends({ ...filter, fromMs: from, toMs: to }, granularityFor(from, to)))
      return
    }
    if (tail === '/session') {
      const id = query.get('id')
      if (id === null || id === '') throw new Error('session requires ?id=')
      json(res, 200, deps.store.sessionSummary(id))
      return
    }
    if (tail === '/requests') {
      const limit = queryInt(query.get('limit') ?? undefined, 'limit')
      const offset = queryInt(query.get('offset') ?? undefined, 'offset')
      json(res, 200, deps.store.requests(filter, limit ?? 50, offset ?? 0))
      return
    }
    if (tail === '/providers') {
      json(res, 200, deps.store.providerStats(filter))
      return
    }
    if (tail === '/models') {
      json(res, 200, deps.store.modelStats(filter))
      return
    }
    if (tail === '/options') {
      json(res, 200, deps.store.options())
      return
    }
    if (tail === '/config') {
      json(res, 200, { value: deps.prices() })
      return
    }
    json(res, 404, { error: { code: 'settings-rejected', message: `cost-tracker: unknown path ${tail}` } })
  } catch (error) {
    json(res, 400, {
      error: {
        code: 'settings-rejected',
        message: `cost-tracker: ${error instanceof Error ? error.message : String(error)}`,
      },
    } satisfies ConfigBridgeError)
  }
}
