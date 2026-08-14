# 调研结论（里程碑 a）— dsh-cost-tracker

调研对象：`~/myshare/deepseek_harness/deepseek-harness`（官方源码，只读）与
`/tmp/cc-switch`（UI 参考，只读 clone）。本文件所有结论均附源码路径证据。
调研日期：2026-08-15。

---

## 1. LLM 用量数据通路（生死问题）

### 1a. TokenUsage 完整类型定义

`packages/llm/llm/src/types.ts:127-141`：

```ts
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

- 计数是**互斥（disjoint）**的：`inputTokens` 只含未命中输入；缓存命中/写入单独上报；
  计费输入 = 三者之和（注释明示 "billed input = sum of the three"）。
- 除 cacheRead/cacheWrite/reasoning 外**没有**其他缓存细分字段。

### 1b. DeepSeek adapter 是否保留缓存细分字段 —— **保留，无数据丢失**

`packages/llm/llm-deepseek/src/translate.ts:45-62`（`mapUsage`）：

```ts
const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
return {
  inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
  outputTokens: usage.completion_tokens,
  ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
  ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
}
```

- `prompt_cache_hit_tokens`（DeepSeek API 的缓存命中字段）被映射为
  `TokenUsage.cacheReadTokens`，且已从 `inputTokens` 中减掉。
- `cacheWriteTokens` 未被 DeepSeek adapter 填充（DeepSeek 不单独上报"缓存写入"桶；
  `prompt_cache_miss_tokens` 即未命中输入，落在 `inputTokens` 里）。
- **结论**：harness 的 `TokenUsage` 是插件唯一需要的数据源，缓存命中/未命中天然分开，
  无需访问 adapter 原始响应。费用公式：
  - 缓存命中费用 = `cacheReadTokens` × 命中单价
  - 未命中费用 = `inputTokens` × 未命中单价（=正常输入价）
  - 输出费用 = `outputTokens` × 输出单价
  - 无缓存字段时退化为 输入费用 + 输出费用

### 1c. LLM 请求完成后哪里能拿到 usage —— 会话事件通道（session firehose）

- **没有** `agent/response` 之类的完成事件。agent 事件全集
  （`packages/core/agent/src/runtime-types.ts:159-290`）：`agent/created`、
  `agent/status`、`agent/session-start`、`agent/pre-step`、
  `agent/request`（请求前 waterfall，能拿到 `LlmCallConfig` → provider/model/turn/step）、
  `agent/request-error`、`agent/turn-stopping`、`agent/error`。
- usage 走**会话事件**：`assistant/chunk`（`chunk.type === 'usage'` 流式早样本）与
  `assistant/message`（`event.data.usage` 最终样本）——
  `packages/llm/token-meter/src/usage-projection.ts:75-80`（官方 token-meter 的取法）。
- 插件监听通道（会话 firehose，`packages/core/session/src/index.ts:60-105`）：
  - `ctx.on('session/created', (session) => …)`、`ctx.on('session/disposed', …)`、
    `ctx.on('session/event', (session, event) => …)`（commit 后 fire-and-forget append feed）、
    `ctx.sessions.list()` 枚举存量会话（用于启动回放）。
  - ⚠️ `session/event` 是 scope-filtered 的；插件纤维收不到。实证方案：
    dsh-llm-fallback 用 `ctx.on('internal/dispatch', (_m, name, args) => …,
    { global: true })` 过滤 `session/event`（`dsh-llm-fallback/src/index.ts:313-325`），
    本插件照搬。
- **监听点设计**：`agent/request` 记录请求元数据（provider/model/turn/step/时间）到
  pending 表；`assistant/message`（带 usage）到达时配对生成费用记录并持久化。
  错误请求无 usage，不产生记录。

## 2. 对话轨迹统计行怎么渲染、数据从哪来

- 组件：`packages/client/ui-conversation/src/client/chat/StatsLine.tsx`，
  注册在 `conversation.composer.dock` 座位（`src/client/apply.ts:428-429`，
  `slots.register({ name: 'conversation.composer.dock', id: 'stats', order: 0, locale: NS }, StatsLine)`）。
- 数据：`useProjection('sessionStats')`（turn/step、llm/tool 耗时、TTFT 均值、解码吞吐，
  `packages/session/session-stats` 的 whole-log projection）+ `useProjection('tokenUsage')`
  （四桶 token 数，`packages/llm/token-meter`），无 projection 时退化为窗口 fold。
- 渲染：一行 pipe 分隔文本（`turns/steps | 耗时 | TTFT 均值 | tokens/s | 缓存命中率% | in/out tokens`）。
- **接入点**：`conversation.composer.dock` 是 list 座位，第三方可注册 order 更靠后的条目，
  渲染在自己的行里（官方 StatsLine 不动）。session 作用域条目自动获得标准 kit
  （`sessionId`/`useSession`/`useProjection`，`packages/client/ui-slots/src/renderer.ts`），
  owner share 是 `InputZone`（`session: ConversationSnapshot`、`input`），
  `ConversationSnapshot.sessionId` 可取当前会话 id（`runtime/src/client/sessions/conversation.ts:433`）。

## 3. conversationEvents 注册表与第三方自定义节点

- `ctx.conversationEvents.register(definition)` 是 client runtime 公开服务
  （`packages/client/runtime/src/client/index.ts:172` →
  `conversation/event-registry.ts`），`kind` 唯一注册、effect 生命周期。
- 自定义节点：声明 `ChatNodeDataMap`/`ConversationTurnDataMap` module augmentation
  （见 `ui-conversation/src/client/conversation-nodes/turn-tail.ts:13-25`），
  definition 提供 `match/start/update/publication/buildLocationData/buildViewNode`，
  渲染器注册到 keyed 座位 `conversation.chat.node`（`contract/slots.ts:78`）。
- **结论**：第三方注册自定义会话节点/渲染器是官方支持机制。但本项目 A/B 需求
  （统计行加费用栏 + 会话汇总卡片）用 `conversation.composer.dock` 更贴切，
  不必自建 chat 节点。

## 4. 官方是否已有成本/用量统计

- 搜遍 `packages`：**没有**任何 cost/price/billing 货币计费实现。
- `token-meter` 的 "shadow price" 是上下文压力估算（固定启发式 token 定价，
  `estimate.ts`/`projection.ts`），**不是钱**。
- 结论：本插件是全新能力，不与官方功能重叠。

## 5. 持久化选型

- 官方候选：
  - dsh-storage hub（`packages/storage/storage*`）：KV 后端注册表（json/sqlite），
    需额外挂载 storage 包，插件不能假设存在。
  - settings 命名空间：只适合小配置（价格表），不适合记录流。
  - 会话 JSONL（session-persistence-jsonl）：按会话目录组织，与插件记录模型不符。
- 选型：**插件自管 append-only JSONL + 内存聚合**，默认目录
  `join(resolveDshHome(config.dshHome), 'cost-tracker')`（`packages/util/home-paths/src/index.ts:87`，
  `$DSH_HOME` 或 `~/.dsh`），`dataDir` 可覆盖。每次调用一条 JSON 记录；启动时全量载入，
  聚合查询（按会话 / 按时间范围 / 按 provider / 按模型）在内存完成——个人规模完全够用，
  且与官方"日志即真相"的 JSONL 哲学一致（session-persistence-jsonl 同思路）。
- 价格表走 settings 命名空间（installSettingsSection），GUI 可改、改后热生效。

## 6. 设置页接入与图表库

- 接入：`settings.section` 座位（与 Models 同座），注册模式照抄
  `dsh-llm-fallback/src/client/index.ts:83-90`（`ctx.slots.inject('settings.section', …)`，
  `order: 20`，`locale` 命名空间，自定义 `inject`）。
- 图表库：`apps/web/package.json` 只有 react/react-dom/vite —— **harness 无现成图表库**。
  CC Switch 用 recharts ^3.5.1（MIT），但体积大（~500KB+），且插件 client 由 tsdown
  内联全部依赖（见下），会显著膨胀 bundle。
- 选型：**轻量自绘 SVG 双轴折线图**（本插件自实现，~3KB），视觉对齐 CC Switch
  （五条线、双 Y 轴、图例、tooltip）。

## 7. CC Switch 统计页源码分析（/tmp/cc-switch）

- 布局（`src/components/usage/UsageDashboard.tsx`）：
  顶栏标题+来源/模型筛选+刷新间隔+日期范围 → `UsageHero` 主指标卡 →
  `UsageTrendChart` 趋势图 → Tabs（请求日志 / Provider 统计 / 模型统计）→ 折叠面板（价格配置/重建）。
- 主指标（`UsageHero.tsx`）：`realTotalTokens = input + output + cacheRead + cacheCreation`
  （"真实消耗 Tokens"，闪电图标）+ 总请求数 + 总成本（USD，4 位小数）；
  第二行 4 个 MiniStat（新增输入/输出/缓存写入/缓存命中）+ 缓存命中率进度条
  （`cacheRead / (input + cacheRead + cacheCreation)`）。
- 趋势（`UsageTrendChart.tsx`）：recharts AreaChart，双 YAxis（左 tokens 右 cost），
  5 条 Area（input/output/cacheCreation/cacheRead 走 token 轴、cost 走 cost 轴），
  范围 ≤24h 按小时分桶，自定义 tooltip。
- 范围（`src/lib/usageRange.ts`）：preset `today/1d/7d/14d/30d/custom`，
  `resolveUsageRange(selection, nowMs)`；默认 `today`，30s 自动刷新
  （`DEFAULT_REFRESH_INTERVAL_MS = 30000`）。
- 筛选（`UsageDashboard.tsx`）：provider 下拉（选项来自当前范围真实有数据的 provider），
  模型随 provider 级联；`v:` 前缀编码防选项名撞 "all" 哨兵。
- 数据模型（Rust 后端 `src-tauri`，usage 表）：每次请求一行，
  provider/model、四类 token 数、四类费用（字符串小数）、总费用、首 token 延迟、耗时、
  statusCode、时间戳；SQL 聚合出 summary/daily/trends/provider/model 统计。
- **照搬**：布局层级（hero→detail→trend→tabs）、主指标语义（realTotalTokens 公式、
  命中率公式）、范围 preset、30s 刷新、筛选级联、请求日志列结构。
- **改动**：货币 USD→CNY（¥，4 位小数）；去掉 app type 筛选（harness 无此概念，
  改保留 provider/model）；recharts→自绘 SVG；数据源从 Rust/SQLite 改为插件 HTTP 桥；
  增加"缓存创建"= cacheWriteTokens 的语义映射（DeepSeek 无此桶，界面显示 N/A）。

## 8. 插件挂载与构建机制（照抄 dsh-llm-fallback）

- `package.json`：`dsh.bundle.patch`（cordis.patch.yml 随包）、`dsh.client`
  （inject 平台模块列表 + platform web）、`exports["./client"]`、peerDeps 对齐
  `^0.1.0-rc.6`（fallback 的 node_modules 实测 rc.6 已在本机 harness 验证可用）、
  react `^18.2.0`（对齐 apps/web）。
- 构建：tsc 双 tsconfig（node/client）+ tsdown 三入口（index/invariant/client）；
  client 入口 CJS factory 形式 `window.__ModuleLoader__.load`、平台种子词 external、
  CSS Modules 经 lightningcss 内联、bundle purity gate 禁止跨插件 value import。
- HTTP 桥：`ctx.webServer.register({kind:'exact', path, handler})`，loopback + Origin
  同源守卫（`config-http.ts` 的 `isTrustedBridgeRequest`），`--host 0.0.0.0` 时 LAN 请求 403。
- 无 webServer：`ctx.inject(['webServer'], …)` 可选注入，纯节点运行照常记录。

## 9. 价格默认值（api-docs.deepseek.com 定价页，2026-08-15 抓取）

| 模型 | 缓存命中 元/M | 未命中 元/M | 输出 元/M |
|---|---|---|---|
| deepseek-v4-flash | 0.02 | 1 | 2 |
| deepseek-v4-pro | 0.025 | 3 | 6 |

2026-08-17 起改为峰谷定价（高峰 9:00-12:00、14:00-18:00 北京时间为高峰价，
其余半价；flash: 峰值 0.10/3.0/9.0，pro: 峰值 0.30/9.0/27.0）。
插件默认表取当前价，GUI/配置均可改（含可选峰谷价覆盖），价格校验 fail loud。
