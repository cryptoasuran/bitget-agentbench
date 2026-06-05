/**
 * RSI mean-reversion example agent.
 *
 * Buy when RSI drops into oversold territory, sell when it climbs back into
 * overbought territory. A second strategy alongside sma-crossover to show
 * AgentBench scoring different styles on the same data.
 *
 * Usage:
 *   npx agentbench run --agent examples/rsi-meanrev.ts --symbol BTCUSDT --tf 4h --out ./report
 */

import type { StrategyAgent, BarContext, Bar, Order } from "../index.js";

const PERIOD = 14;
const OVERSOLD = 30;
const OVERBOUGHT = 70;
const TRADE_SIZE = 0.01;

/**
 * Wilder's RSI over the last `period` closes. Returns null until there are
 * enough bars. Pure function of the close series, no lookahead.
 */
function rsi(bars: readonly Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const closes = bars.slice(-(period + 1)).map((b) => b.close);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

const agent: StrategyAgent = {
  name: "rsi-meanrev",

  onBar(bar: Bar, ctx: BarContext): Order[] {
    const allBars = [...ctx.history, bar];
    const value = rsi(allBars, PERIOD);
    if (value === null) return [];

    const symbol = ctx.position.symbol || "BTCUSDT";

    // Oversold and flat -> buy
    if (value < OVERSOLD && ctx.position.size <= 0) {
      return [{ symbol, side: "buy", orderType: "market", size: TRADE_SIZE, tag: `rsi=${value.toFixed(1)}` }];
    }

    // Overbought and long -> sell the position
    if (value > OVERBOUGHT && ctx.position.size > 0) {
      return [{ symbol, side: "sell", orderType: "market", size: ctx.position.size, tag: `rsi=${value.toFixed(1)}` }];
    }

    return [];
  },
};

export default agent;
