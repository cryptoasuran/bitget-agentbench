/**
 * SMA crossover example agent.
 *
 * Runs on any symbol/timeframe. Buy when the fast SMA crosses above the slow
 * SMA; sell when it crosses below. Trades a fixed position size.
 *
 * This is a real tradeable strategy used to demonstrate AgentBench features:
 * backtest, scorecard, fill ledger, risk guard. It produces actual trade
 * evidence for the hackathon submission.
 *
 * Usage:
 *   npx agentbench run --agent examples/sma-crossover.ts --symbol BTCUSDT --tf 1h --out ./report
 */

import type { StrategyAgent, BarContext, Bar, Order } from "../index.js";

const FAST = 10;  // fast SMA period
const SLOW = 30;  // slow SMA period
const TRADE_SIZE = 0.01; // BTC per order

/** Simple moving average over the last `period` bars. */
function sma(bars: readonly Bar[], period: number): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const sum = slice.reduce((a, b) => a + b.close, 0);
  return sum / period;
}

const agent: StrategyAgent = {
  name: "sma-crossover",

  onBar(_bar: Bar, ctx: BarContext): Order[] {
    // Need at least SLOW bars of history + the current bar
    const allBars = [...ctx.history, _bar];
    if (allBars.length < SLOW) return [];

    const fastNow = sma(allBars, FAST);
    const slowNow = sma(allBars, SLOW);

    // Previous bar's SMAs (for the cross)
    const prevBars = allBars.slice(0, -1);
    const fastPrev = sma(prevBars, FAST);
    const slowPrev = sma(prevBars, SLOW);

    if (fastNow === null || slowNow === null ||
        fastPrev === null || slowPrev === null) return [];

    const symbol = ctx.position.symbol || "BTCUSDT";

    // Bullish cross: fast crosses above slow
    if (fastPrev <= slowPrev && fastNow > slowNow) {
      if (ctx.position.size <= 0) {
        return [{ symbol, side: "buy", orderType: "market", size: TRADE_SIZE }];
      }
    }

    // Bearish cross: fast crosses below slow
    if (fastPrev >= slowPrev && fastNow < slowNow) {
      if (ctx.position.size > 0) {
        return [{ symbol, side: "sell", orderType: "market", size: ctx.position.size }];
      }
    }

    return [];
  },
};

export default agent;
