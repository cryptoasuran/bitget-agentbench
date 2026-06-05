# bitget-agentbench

Backtest, score and risk-guard Bitget trading agents on real candle data. Point
it at any strategy and it gives you back a reproducible scorecard and a full trade
ledger, with zero API keys and zero real money.

Built for the [Bitget Agent Hub](https://github.com/BitgetLimited/agent_hub)
ecosystem. If you are building a trading agent, this is the harness that proves it
works before it touches a live account.

## Why this exists

Agent Hub lets an agent read the market and place trades. It does not tell you
whether the agent is any good. There is no replay, no fill simulation, no
PnL/drawdown/Sharpe accounting, and no standard artifact you can hand someone to
say "here is what my agent actually did".

So every team rolls its own, badly, or trades live to get evidence. Both are bad
options. AgentBench fills that gap:

- **Backtest** any strategy against real Bitget candles, bar by bar, with no
  lookahead.
- **Risk-guard** it with hard limits (max position, max leverage, drawdown
  kill-switch) so a runaway agent stops instead of blowing up.
- **Score** it: return, max drawdown, Sharpe, Sortino, win rate, profit factor,
  exposure, fees, turnover.
- **Prove** it: every run emits a `scorecard.json`, a `trades.jsonl` ledger and a
  manifest with the dataset hash. Re-run with the same seed and you get the same
  numbers, byte for byte.

## Install

```bash
npm install bitget-agentbench
```

## Quickstart (no keys, no network)

The package ships with real Bitget candle fixtures, so you can run a full backtest
the moment it is installed.

```bash
npx agentbench run \
  --agent ./node_modules/bitget-agentbench/examples/sma-crossover.ts \
  --symbol BTCUSDT --tf 4h --seed 42 --out ./report
```

You get:

```
Agent:       sma-crossover
Symbol:      BTCUSDT 4h
Bars:        930
Equity:      10000 -> 9786.39
Return:      -2.14%
Max DD:      2.70%
Sharpe:      -2.45
Win Rate:    27.8%
Trades:      18
Fees:        25.42
Violations:  0

Report: ./report/
```

and a `report/` folder with `scorecard.json`, `trades.jsonl`, `equity.csv` and
`manifest.json`.

## Integrate your own agent in 5 lines

A strategy is one method. Return the orders to place on each bar, or an empty
array to do nothing.

```ts
import type { StrategyAgent } from "bitget-agentbench";

const agent: StrategyAgent = {
  name: "buy-the-dip",
  onBar(bar, ctx) {
    if (ctx.position.size === 0 && bar.close < bar.open * 0.98)
      return [{ symbol: "BTCUSDT", side: "buy", orderType: "market", size: 0.01 }];
    return [];
  },
};

export default agent;
```

Run it: `npx agentbench run --agent ./buy-the-dip.ts --symbol BTCUSDT --tf 4h`.

The order shape mirrors Bitget's `spot_place_order` fields (symbol, side,
orderType, price, size), so an agent that already calls Agent Hub trade tools
drops in without a rewrite.

## Use it as a library

```ts
import { runBacktest, loadFixture } from "bitget-agentbench";

const bars = loadFixture("BTCUSDT", "4h");
const { scorecard, fills } = await runBacktest({
  agent,
  bars,
  config: { startingEquity: 10_000, feeBps: 10, slippageBps: 1, seed: 42 },
  risk: { maxDrawdownKill: 0.3, maxPositionSize: 1 },
  manifest: {
    agentbenchVersion: "0.1.0", symbol: "BTCUSDT", granularity: "4h",
    source: "fixture", bars: bars.length,
    firstBarTime: bars[0].time, lastBarTime: bars[bars.length - 1].time,
    datasetSha256: "fixture",
  },
});

console.log(scorecard.metrics);
```

## MCP: let an agent backtest itself

AgentBench ships an MCP server, so an agent running in Claude, Cursor or any
MCP client can score a strategy without leaving its tool loop. This is the
"agent grades its own homework" path, and it slots right next to the official
Bitget Agent Hub MCP server.

Add it to Claude Code:

```bash
claude mcp add -s user agentbench -- npx -y -p bitget-agentbench agentbench-mcp
```

Or wire it manually (Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "agentbench": { "command": "npx", "args": ["-y", "-p", "bitget-agentbench", "agentbench-mcp"] }
  }
}
```

It exposes one tool, `agentbench_run`, which backtests a built-in strategy on a
fixture and returns the scorecard. No keys, deterministic, read-only:

```
agentbench_run({ strategy: "rsi-meanrev", symbol: "BTCUSDT", granularity: "4h", seed: 42 })
-> { agent, metrics: { totalReturnPct, maxDrawdownPct, sharpe, winRatePct, ... }, manifest }
```

The binary is `agentbench-mcp` and speaks MCP over stdio.

## RiskGuard

Every order passes through a policy gate before it can fill. Set only the limits
you care about; the rest are not enforced.

```ts
const risk = {
  maxOrderSize: 0.1,       // base units per order
  maxPositionSize: 1.0,    // net position cap
  maxNotional: 50_000,     // quote per order
  maxLeverage: 3,          // gross notional / equity
  symbolAllowlist: ["BTCUSDT", "ETHUSDT"],
  maxDrawdownKill: 0.2,    // halt the run at 20% drawdown
  maxDailyLoss: 500,       // halt at 500 quote realised loss in a UTC day
};
```

Rejected orders and kill events are recorded in the scorecard, so you can see
exactly when and why the guard stepped in.

## The fill model

Conservative and no-lookahead, so a backtest does not flatter the strategy:

- The agent sees a closed bar and decides. Orders execute against the **next**
  bar.
- Market orders fill at the next bar's open, with slippage moving the price
  against you.
- Limit buys fill at the limit price when the next bar's low reaches it. Limit
  sells fill when the high reaches it.
- Fees use Bitget's standard spot rate of 0.1% (verified against Bitget Academy,
  June 2026). Override `feeBps` for your own tier.

This is a long-only spot engine. Short positions and futures funding are on the
roadmap, not in this release. A sell larger than your position is clamped to what
you hold, never silently turned into a short.

## Reproducibility

The manifest records the dataset hash, symbol, timeframe, engine config and seed.
Same inputs in, same scorecard out. That is the verification: anyone can re-run a
result and confirm the numbers rather than trusting a screenshot.

## Security

This package depends only on `bitget-core`, the official MCP SDK and `zod`. It
has no `postinstall` script and ships a `guard:deps` check that fails the build
if any unexpected package enters the dependency tree. Nothing here touches your
shell, your global config or your credentials.

## Development

```bash
npm install
npm run build
npm test          # 33 tests: simulator, metrics, fixtures, types, mcp
npm run typecheck
npm run guard:deps
```

## Verification

Every financial formula is reviewed and the whole suite is verified locally
before release: 33 passing tests, a clean type-check, and end-to-end runs that
reproduce byte-identical scorecards from a fixed seed. The fill model, fee rate
and metric formulas are documented above so they can be checked rather than
trusted.

## License

MIT
