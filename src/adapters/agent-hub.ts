/**
 * Bitget Agent Hub adapter.
 *
 * Agent Hub agents place trades by calling a `spot_place_order` tool whose
 * arguments are `{ symbol, side, orderType, price, size }`. AgentBench's `Order`
 * is the same shape, so an agent that already targets Agent Hub does not need a
 * rewrite to be backtested: wrap its per-bar decision in `fromAgentHub` and it
 * becomes a `StrategyAgent`.
 *
 * The mapping is deliberately thin and validated, so the adapter is honest about
 * what it does: it normalises an Agent-Hub-style order call into the engine's
 * `Order` (defaulting `orderType` to "market", validating with the same schema
 * the engine uses) and nothing more. Size is in base units, matching the engine;
 * Agent Hub's quote-size market-buy variant is out of scope for this adapter.
 */

import { OrderSchema } from "../types.js";
import type { Bar, BarContext, Order, StrategyAgent } from "../types.js";

/**
 * An order in the shape Agent Hub's `spot_place_order` tool accepts. `orderType`
 * defaults to "market" when omitted, matching the tool's behaviour.
 */
export interface AgentHubOrder {
  symbol: string;
  side: "buy" | "sell";
  orderType?: "market" | "limit";
  /** Required for limit orders, ignored for market. */
  price?: number;
  /** Order size in base units. */
  size: number;
  /** Optional client tag, echoed into the trade ledger. */
  tag?: string;
}

/** A per-bar decision function written against the Agent Hub order shape. */
export type AgentHubDecide = (
  bar: Bar,
  ctx: BarContext,
) => AgentHubOrder[] | Promise<AgentHubOrder[]>;

/** Normalise one Agent Hub order call into a validated engine `Order`. */
export function toOrder(call: AgentHubOrder): Order {
  return OrderSchema.parse({
    symbol: call.symbol,
    side: call.side,
    orderType: call.orderType ?? "market",
    ...(call.price !== undefined ? { price: call.price } : {}),
    size: call.size,
    ...(call.tag !== undefined ? { tag: call.tag } : {}),
  });
}

/**
 * Wrap an Agent-Hub-style decision function into a `StrategyAgent` AgentBench can
 * backtest. The decision function returns the same `spot_place_order` calls the
 * agent would make against Agent Hub; the adapter validates and forwards them.
 */
export function fromAgentHub(name: string, decide: AgentHubDecide): StrategyAgent {
  return {
    name,
    async onBar(bar: Bar, ctx: BarContext): Promise<Order[]> {
      const calls = await decide(bar, ctx);
      return calls.map(toOrder);
    },
  };
}
