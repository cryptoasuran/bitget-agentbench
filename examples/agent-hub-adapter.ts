/**
 * Agent Hub adapter example.
 *
 * This is an agent written the way a Bitget Agent Hub agent already is: it
 * decides on each bar and "places orders" in the exact `spot_place_order` shape
 * `{ symbol, side, orderType, price, size }`. `fromAgentHub` wraps that decision
 * function into a strategy AgentBench can backtest, with no rewrite of the
 * decision logic. Point `agentbench run --agent` at this file to score it.
 *
 * Usage:
 *   npx agentbench run --agent examples/agent-hub-adapter.ts --symbol BTCUSDT --tf 4h --seed 42 --out ./report
 *   npx agentbench verify ./report
 */

import { fromAgentHub } from "bitget-agentbench";
import type { AgentHubOrder, Bar, BarContext } from "bitget-agentbench";

const BREAKOUT_LOOKBACK = 20;
const TRADE_SIZE = 0.01;

/** Highest close over the last `n` bars, or null if not enough history. */
function highestClose(bars: readonly Bar[], n: number): number | null {
  if (bars.length < n) return null;
  return Math.max(...bars.slice(-n).map((b) => b.close));
}

/**
 * A breakout agent in Agent Hub terms: go long when price closes above its
 * recent high, flatten when it falls back below. The returned objects are
 * literally `spot_place_order` calls.
 */
function decide(bar: Bar, ctx: BarContext): AgentHubOrder[] {
  const symbol = ctx.position.symbol || "BTCUSDT";
  const priorHigh = highestClose(ctx.history, BREAKOUT_LOOKBACK);
  if (priorHigh === null) return [];

  if (ctx.position.size <= 0 && bar.close > priorHigh) {
    return [{ symbol, side: "buy", orderType: "market", size: TRADE_SIZE, tag: "breakout" }];
  }
  if (ctx.position.size > 0 && bar.close < priorHigh) {
    return [{ symbol, side: "sell", orderType: "market", size: ctx.position.size, tag: "exit" }];
  }
  return [];
}

export default fromAgentHub("agent-hub-breakout", decide);
