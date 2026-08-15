# @visol-456/dsh-cost-tracker

English | [中文](README.md)

An **LLM cost tracker plugin** for the DeepSeek Harness: it listens to model-call
completion events, bills every call from the provider-reported token usage
(input / output / cache hit / cache miss) against a price table, persists each
call, and shows three layers of UI in dsh web:

- **A. Per-call cost**: in the conversation stats band under the composer, one row
  below the shipped stats line (turn/step, avg first-token latency, cache-hit
  status) — `Cost ¥0.0042 · Session ¥0.1234`.
- **B. Session summary**: an expandable card in the same band — session total cost,
  the three cost buckets (cache hit / cache miss / output), token counts, cache-hit
  rate, average first-token latency.
- **C. Global stats page**: the "Usage" tab at the top of the conversation page,
  sibling to Chat/Trajectory — a CC-Switch-style Usage Statistics
  dashboard: hero metrics (real tokens / requests / total cost), detail cards
  (fresh input / output / cache creation / cache hit + cache-hit-rate progress
  bar), a dual-axis trend chart (cost / cache creation / cache hit / input / output,
  date range + 30s auto refresh), provider/model filters, bottom tabs (request log /
  provider stats / model stats), and an editable price table.

> A community plugin for the DeepSeek Harness `dsh-plugin` ecosystem — not part of
> the official repository.

## Acknowledgements / Design reference

The usage statistics page (metric cards, dual-axis trend chart, request-log
table, tooltip interaction, etc.) closely follows the Usage Statistics page of
[CC Switch](https://github.com/farion1231/cc-switch) (MIT licensed) — layout,
colors, chart style, and interaction density are modeled after it. Thanks to
farion1231 and the CC Switch project. This plugin is an independent
implementation (hand-rolled SVG charts, no recharts dependency); only the
visual design and interaction patterns are referenced.

## Why

DeepSeek changes pricing on 2026-08-17 and introduces peak/off-peak rates
(peak 09:00-12:00 and 14:00-18:00 Beijing time, off-peak is half price). The
Harness itself has no monetary billing anywhere (token-meter's "shadow price" is a
context-pressure heuristic, not money). This plugin bills every call in CNY from the
provider-reported **cache-hit/miss-split token counts** and gives you a dashboard
that can be cross-checked against the DeepSeek platform usage page.

## Quick start

```bash
npm i @visol-456/dsh-cost-tracker
```

Mount in `cordis.yml` (headless node deployment):

```yaml
- name: '@visol-456/dsh-cost-tracker'
  config:
    dataDir: /path/to/cost-records   # optional; defaults to <DSH_HOME>/cost-tracker
```

Recording starts immediately with zero configuration. Default price table
(CNY per million tokens, from the official pricing page):

| Model | Cache hit | Cache miss | Output |
|---|---|---|---|
| deepseek-v4-flash | 0.02 | 1 | 2 |
| deepseek-v4-pro | 0.025 | 3 | 6 |
| others (default) | 0.02 | 1 | 2 |

After the 8/17 peak/off-peak pricing takes effect, edit prices in
Conversation → Usage → Pricing (per-model peak prices and peak hours are supported),
or write the `prices` key into the settings document / cordis.yml. **A malformed
price table fails loud at load time** — it can never silently mis-bill.

## Deploying to the web profile (dsh web)

### A. `dsh plugin add` (recommended)

This package declares `dsh.bundle`, so installation activates it as a profile layer
automatically (the bundled `cordis.patch.yml` mounts it with default prices):

```bash
dsh plugin --profile web add @visol-456/dsh-cost-tracker
```

### B. Manual patch overlay

```yaml
# cordis.yml (a patch list)
- insert:
    - id: cost-tracker
      name: '@visol-456/dsh-cost-tracker'
```

```bash
dsh web --patch ./cordis.yml
```

### Patch gotchas

- Every mounted entry needs an `id`; new entries must live in a top-level
  `- insert:` list.
- Bare entry lists are rejected silently, and **`dsh web` prints no error** on
  startup.
- Diagnose the composed tree with
  `node --import tsx/esm apps/cli/src/bin.ts web --dump-config --patch <file>`.

### Local development junction

`$DSH_HOME/profiles/node_modules` is the launcher's bundle fallback directory and
does **not** participate in bare import resolution from cordis.yml. To mount an
unpublished checkout locally, junction it into the **harness root node_modules**:

```bash
mkdir -p <harness-root>/node_modules/@visol-456
ln -s ~/myshare/deepseek_harness/dsh-cost-tracker <harness-root>/node_modules/@visol-456/dsh-cost-tracker
```

## Data & security

- Records: `<dataDir>/records.jsonl` (default `<DSH_HOME>/cost-tracker/`, `$DSH_HOME`
  falls back to `~/.dsh`), one JSON line per call.
- Billing: hit cost = hit tokens × hit price; miss cost = miss tokens × miss price
  (= normal input price); output cost = output tokens × output price; without cache
  detail it degrades to input + output cost.
- Data bridge: `/cost-tracker/*` routes on the shared webServer, guarded by
  **loopback + same-Origin** checks (LAN requests get 403 even under
  `--host 0.0.0.0`) — the same trust model as the dsh-llm-fallback config bridge.
- Without a webServer the plugin keeps recording in pure-node mode; only the UI
  is missing.

## Positioning vs dsh-llm-fallbacks

- [omdsh-dev/dsh-llm-fallbacks](https://github.com/omdsh-dev/dsh-llm-fallbacks)
  (and @visol-456/dsh-llm-fallback): a request **routing/failover** plugin — when
  the primary provider fails, the same request retries on backup
  provider/model pairs. It answers "where does the request go".
- This plugin: a **metering/billing** plugin — bills completed calls from real usage.
  It answers "how much did it cost".
- They complement each other and can be mounted together; this plugin records the
  provider/model that **actually served** the call (`message.source` of
  `assistant/message`), so cost attribution stays correct across fallback switches.

## Development

```bash
npm install
npm run build        # tsc dual tsconfig + tsdown (node + client entries)
npm test             # vitest: cost math, price validation, persistence,
                     # aggregations, bridge guard, loader E2E
```

## How it works

- Listening point: `internal/dispatch` (global) → `session/event`; the
  `assistant/message` event carries the provider-reported `TokenUsage` (the
  harness DeepSeek adapter already maps `prompt_cache_hit_tokens` into
  `cacheReadTokens` and subtracts it from `inputTokens` — see `mapUsage` in
  `packages/llm/llm-deepseek/src/translate.ts`).
- Client: the "Usage" tab registers on `conversation.view` (order 2), sibling
  to Chat/Trajectory; the cost line and session summary register on
  `conversation.composer.dock` (order 1, right below the official stats line);
  data flows through the HTTP bridge, refreshed on new messages and session
  switches.
- Trend chart: a hand-rolled SVG dual-axis smooth trend chart (Catmull-Rom to
  cubic Bézier; the harness ships no chart library, and recharts would bloat
  the plugin bundle).

## License

MIT
