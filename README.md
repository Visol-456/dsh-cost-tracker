# @visol-456/dsh-cost-tracker

[English](README_en.md) | 中文

DeepSeek Harness 的 **LLM 成本统计插件**：监听每次模型调用完成事件，按 provider 上报的
token 用量（输入 / 输出 / 缓存命中 / 缓存未命中）与价格表折算费用，持久化每次调用记录，
并在 dsh web 里提供三层 UI：

- **A. 调用级明细**：对话轨迹输入框下方的统计带里，官方统计行（turn/step、首 token
  平均秒数、缓存命中状态）之下多出一行 —— `费用 ¥0.0042 · 会话 ¥0.1234`，即本次调用费用；
- **B. 会话级汇总**：同一统计带的「会话汇总」卡片 —— 会话总费用 + 缓存命中 / 未命中 /
  输出三类费用 + 各桶 token 数 + 缓存命中率 + 平均首 token 延迟；
- **C. 全局统计页**：会话页顶部「使用统计」tab（与「对话」「轨迹」平级，布局参照 CC Switch 的 Usage Statistics）：
  主指标卡（真实消耗 Tokens / 总请求数 / 总成本）+ 详细指标卡（新增输入 / 输出 /
  缓存创建 / 缓存命中 / 缓存命中率进度条）+ 双 Y 轴趋势折线图（成本 / 缓存创建 /
  缓存命中 / 输入 / 输出五条线，日期范围 + 30s 自动刷新）+ 来源 / 模型筛选 +
  底部 tabs（请求日志 / Provider 统计 / 模型统计）+ 价格表编辑器。

> DeepSeek Harness `dsh-plugin` 生态的社区插件，不属于官方仓库。

## 致谢 / 设计参考

使用统计页面（指标卡、双 Y 轴趋势图、请求日志表格、tooltip 交互等）的 UI 全面对齐
[CC Switch](https://github.com/farion1231/cc-switch)（MIT 协议）的 Usage Statistics
页面 —— 布局、配色、图表样式与交互密度均以其为蓝本。向 CC Switch 原作者
farion1231 及项目致谢；本插件为独立实现（自绘 SVG 图表，未引入 recharts），
仅参考其视觉设计与交互模式。

## 开发原因

DeepSeek 2026-08-17 起调整价格并引入峰谷定价（高峰 9:00-12:00、14:00-18:00 为高峰价，
其余半价）。Harness 本身没有任何货币计费能力（`token-meter` 的 "shadow price" 只是上下文
压力估算，不是钱），于是有了这个插件：用 provider 上报的**缓存命中/未命中分开的 token 数**
按价格表实时折算人民币费用，并给出与 DeepSeek 平台用量页可交叉核对的可视化界面。

## 快速开始

```bash
npm i @visol-456/dsh-cost-tracker
```

在 `cordis.yml` 中挂载插件（裸机 node 部署）：

```yaml
- name: '@visol-456/dsh-cost-tracker'
  config:
    dataDir: /path/to/cost-records   # 可选，默认 <DSH_HOME>/cost-tracker
```

挂载即开始记录，无需任何配置。默认价格表按官方定价（元 / 百万 tokens）：

| 模型 | 缓存命中 | 未命中输入 | 输出 |
|---|---|---|---|
| deepseek-v4-flash | 0.02 | 1 | 2 |
| deepseek-v4-pro | 0.025 | 3 | 6 |
| 其他模型（default） | 0.02 | 1 | 2 |

8/17 峰谷定价后请到 **会话页 → 使用统计 → 价格配置** 修改（支持按模型填峰谷价与高峰时段），
或直接改 settings 文档 / cordis.yml 的 `prices`。**错误的价格表会在加载时直接报错**
（fail loud），绝不会静默错算。

## 部署到 web profile（dsh web）

### A. `dsh plugin add`（推荐）

本包声明了 `dsh.bundle`，安装后会作为 profile 层自动激活（随包 `cordis.patch.yml`
以默认价格挂载插件，价格在 UI 里编辑）：

```bash
dsh plugin --profile web add @visol-456/dsh-cost-tracker
```

### B. 手动 patch 覆盖层

```yaml
# cordis.yml（patch 列表）
- insert:
    - id: cost-tracker
      name: '@visol-456/dsh-cost-tracker'
```

```bash
dsh web --patch ./cordis.yml
```

### patch 语法（最大的坑）

- 每个挂载条目必须有 `id`；新增条目必须放在顶层 `- insert:` 列表里。
- 裸条目列表会被静默拒绝且 **`dsh web` 启动不打印任何错误**。
- 用 `node --import tsx/esm apps/cli/src/bin.ts web --dump-config --patch <file>`
  诊断组合配置树。

### 本地开发 junction 位置

`$DSH_HOME/profiles/node_modules` 是 launcher 维护的 bundle 回退目录，**不参与**
cordis.yml 条目的裸 import 解析。本地挂载未发布的 checkout，必须把 junction 建在
**harness 根 node_modules**：

```bash
mkdir -p <harness-root>/node_modules/@visol-456
ln -s ~/myshare/deepseek_harness/dsh-cost-tracker <harness-root>/node_modules/@visol-456/dsh-cost-tracker
```

## 数据与安全

- 记录文件：`<dataDir>/records.jsonl`（默认 `<DSH_HOME>/cost-tracker/`，
  `$DSH_HOME` 缺省为 `~/.dsh`），每次调用一行 JSON。
- 费用公式：命中费用 = 命中 tokens × 命中单价；未命中费用 = 未命中 tokens × 未命中单价
  （= 正常输入价）；输出费用 = 输出 tokens × 输出单价；无缓存细分时退化为
  输入费用 + 输出费用。
- 数据桥：`/cost-tracker/*` 路由挂在共享 webServer 上，**loopback + Origin 同源守卫**
  （`--host 0.0.0.0` 时 LAN 请求被 403 拒绝），与 dsh-llm-fallback 的配置桥同款信任模型。
- 无 webServer 时纯 node 运行照常记录，仅 UI 缺失。

## 与 dsh-llm-fallbacks 的定位区别

- [omdsh-dev/dsh-llm-fallbacks](https://github.com/omdsh-dev/dsh-llm-fallbacks)（及
  @visol-456/dsh-llm-fallback）：请求**路由/容灾**插件 —— 主 provider 失败时把同一请求
  切换到备用 provider/model。管的是"请求往哪走"。
- 本插件：**计量/计费**插件 —— 调用完成后按真实用量折算费用。管的是"花了多少钱"。
- 两者互补、可同时挂载；本插件记录的是**实际服务**的 provider/model
  （`assistant/message` 的 `message.source`），因此 fallback 切换后费用归属依然正确。

## 开发

```bash
npm install
npm run build        # tsc 双 tsconfig + tsdown（node + client 双入口）
npm test             # vitest：费用计算/价格校验/持久化/聚合/桥守卫/loader E2E
```

## 原理速览

- 监听点：`internal/dispatch`（global）→ `session/event`；`assistant/message` 携带
  provider 上报的 `TokenUsage`（harness 的 DeepSeek adapter 已把
  `prompt_cache_hit_tokens` 映射为 `cacheReadTokens` 并从 `inputTokens` 中减掉，
  见 `packages/llm/llm-deepseek/src/translate.ts` 的 `mapUsage`）。
- 客户端：`conversation.view`（order 2）注册「使用统计」tab，与「对话」「轨迹」平级；
  `conversation.composer.dock`（order 1，紧随官方 stats line）注册费用行与会话汇总卡片；
  数据经 HTTP 桥获取，新消息/切会话自动刷新。
- 趋势图：自绘 SVG 双 Y 轴平滑趋势图（Catmull-Rom 转 cubic Bézier，harness 无图表库，recharts 会显著膨胀插件 bundle）。

## License

MIT
