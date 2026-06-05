/**
 * SMA crossover example agent.
 *
 * Buy when the fast SMA crosses above the slow SMA, sell when it crosses below.
 * A complete, self-contained strategy you can copy as a starting point.
 *
 * Usage:
 *   npx agentbench run --agent examples/sma-crossover.ts --symbol BTCUSDT --tf 4h --out ./report
 */

import type { StrategyAgent, BarContext, Bar, Order } from "bitget-agentbench";

const FAST = 10;
const SLOW = 30;
const TRADE_SIZE = 0.01;

function sma(bars: readonly Bar[], period: number): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  return slice.reduce((a, b) => a + b.close, 0) / period;
}

const agent: StrategyAgent = {
  name: "sma-crossover",
  onBar(bar: Bar, ctx: BarContext): Order[] {
    const allBars = [...ctx.history, bar];
    if (allBars.length < SLOW) return [];

    const fastNow = sma(allBars, FAST);
    const slowNow = sma(allBars, SLOW);
    const prevBars = allBars.slice(0, -1);
    const fastPrev = sma(prevBars, FAST);
    const slowPrev = sma(prevBars, SLOW);
    if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) return [];

    const symbol = ctx.position.symbol || "BTCUSDT";
    if (fastPrev <= slowPrev && fastNow > slowNow && ctx.position.size <= 0) {
      return [{ symbol, side: "buy", orderType: "market", size: TRADE_SIZE }];
    }
    if (fastPrev >= slowPrev && fastNow < slowNow && ctx.position.size > 0) {
      return [{ symbol, side: "sell", orderType: "market", size: ctx.position.size }];
    }
    return [];
  },
};

export default agent;
