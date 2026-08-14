/**
 * Cost-tracker domain types: one durable record per completed LLM call,
 * plus the wire shapes served by the config/statistics bridge. Currency is
 * CNY (¥) throughout; prices are CNY per million tokens.
 *
 * @module @visol-456/dsh-cost-tracker/types
 */

/** One recorded model call (one durable JSONL line). */
export interface CostRecord {
  /** Unique record id. */
  id: string
  /** Owning session id. */
  sessionId: string
  /** Turn of the call inside the session. */
  turn: number
  /** Step of the call inside the turn. */
  step: number
  /** Provider route that actually served the call. */
  provider: string
  /** Model id that actually served the call. */
  model: string
  /** Request start (step start) in ms epoch, when recorded. */
  requestedAt: number
  /** Completion (assistant message) time in ms epoch. */
  completedAt: number
  /** First-token latency in ms, when the step recorded a first token. */
  ttftMs?: number
  /** Uncached (cache-miss) input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Cache-hit (cache-read) input tokens. */
  cacheReadTokens: number
  /** Cache-write tokens (DeepSeek does not report a write bucket; 0). */
  cacheWriteTokens: number
  /** Reasoning tokens when the provider reported them. */
  reasoningTokens?: number
  /** Billed cost of the uncached input, CNY. */
  inputCost: number
  /** Billed cost of the cache-hit input, CNY. */
  cacheHitCost: number
  /** Billed cost of the cache-write input, CNY. */
  cacheWriteCost: number
  /** Billed cost of the output, CNY. */
  outputCost: number
  /** Sum of the four cost buckets, CNY. */
  totalCost: number
  /** Record format version. */
  version: 1
}

/** Time/entity filter shared by every statistics query. */
export interface CostFilter {
  /** Inclusive start of the window, ms epoch. */
  fromMs?: number
  /** Exclusive end of the window, ms epoch. */
  toMs?: number
  /** Only records served by this provider route. */
  provider?: string
  /** Only records served by this model id. */
  model?: string
}

/** Whole-log figures for one session (conversation summary card). */
export interface SessionCostSummary {
  sessionId: string
  /** Number of recorded calls. */
  requests: number
  /** Sum of all billed costs, CNY. */
  totalCost: number
  /** Cache-miss input cost, CNY. */
  inputCost: number
  /** Cache-hit input cost, CNY. */
  cacheHitCost: number
  /** Cache-write input cost, CNY. */
  cacheWriteCost: number
  /** Output cost, CNY. */
  outputCost: number
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Cache-hit tokens. */
  cacheReadTokens: number
  /** Cache-write tokens. */
  cacheWriteTokens: number
  /** Cache-hit share of billed input, 0..1, null with no input. */
  cacheHitRate: number | null
  /** Average first-token latency over recorded steps, ms; null with none. */
  ttftMsAvg: number | null
  /** Newest record first. */
  latest: CostRecord | undefined
}

/** Global overview figures for the hero metric cards. */
export interface CostOverview {
  /** Sum of the four token buckets — "真实消耗 Tokens". */
  realTotalTokens: number
  /** Number of recorded calls. */
  requests: number
  /** Sum of all billed costs, CNY. */
  totalCost: number
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Cache-write tokens. */
  cacheWriteTokens: number
  /** Cache-hit tokens. */
  cacheReadTokens: number
  /** Cache-hit share of billed input, 0..1, null with no input. */
  cacheHitRate: number | null
}

/** One time bucket of the usage trend (dual-axis chart point). */
export interface CostTrendPoint {
  /** Bucket start, ms epoch. */
  time: number
  /** Human bucket label. */
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  /** Sum of billed costs in the bucket, CNY. */
  totalCost: number
}

/** One provider row of the provider statistics tab. */
export interface ProviderCostStat {
  provider: string
  requests: number
  realTotalTokens: number
  totalCost: number
}

/** One model row of the model statistics tab. */
export interface ModelCostStat {
  model: string
  requests: number
  realTotalTokens: number
  totalCost: number
  /** Cache-hit share of billed input, 0..1, null with no input. */
  cacheHitRate: number | null
}

/** Paged request log. */
export interface CostRequestLogPage {
  rows: CostRecord[]
  total: number
}

/** Distinct filter option values over the recorded log. */
export interface CostOptions {
  providers: string[]
  models: string[]
}
