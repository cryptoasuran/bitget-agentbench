/**
 * RiskGuard — policy gate between the agent and the simulator.
 *
 * Every order the agent emits passes through RiskGuard before execution.
 * Violations are recorded for the scorecard; rejected orders never reach
 * the fill simulator; a "kill" violation halts the entire run.
 *
 * All policies are optional — omit a field and that rule is not enforced.
 */

import type { Order, RiskPolicy, Violation } from "../types.js";
import type { SimState } from "./simulator.js";

export interface RiskCtx {
  /** Time of the current bar (epoch ms). */
  now: number;
  /** Current equity before order execution. */
  equity: number;
  /** Peak equity seen so far in this run. */
  peakEquity: number;
  /** Cumulative realised loss within the current UTC day (quote currency). */
  dailyRealisedLoss: number;
  /**
   * Reference price used to value market orders (which carry no limit price)
   * for notional and leverage checks. The execution bar's open is the right
   * estimate since that is where a market order fills.
   */
  referencePrice: number;
}

/**
 * Screen orders through the risk policy. Returns accepted orders and
 * any violations emitted. Kill violations are included in violations[] —
 * the caller must check and halt the run.
 */
export function screenOrders(
  orders: readonly Order[],
  state: SimState,
  ctx: RiskCtx,
  policy: RiskPolicy,
): { accepted: Order[]; violations: Violation[] } {
  const violations: Violation[] = [];
  const accepted: Order[] = [];

  for (const order of orders) {
    const v = checkOrder(order, state, ctx, policy);
    if (v !== null) {
      violations.push(v);
      if (v.action === "kill") break; // hard stop on kill
      continue; // reject this order
    }
    accepted.push(order);
  }

  return { accepted, violations };
}

function checkOrder(
  order: Order,
  state: SimState,
  ctx: RiskCtx,
  policy: RiskPolicy,
): Violation | null {
  const { now } = ctx;
  // Limit orders use their own price; market orders use the execution-bar
  // reference price so notional and leverage caps actually bind on them.
  const price = order.price ?? ctx.referencePrice;
  const notional = price * order.size;

  // Symbol allowlist
  if (policy.symbolAllowlist && policy.symbolAllowlist.length > 0) {
    if (!policy.symbolAllowlist.includes(order.symbol)) {
      return {
        time: now,
        rule: "symbol-allowlist",
        detail: `${order.symbol} not in allowlist [${policy.symbolAllowlist.join(", ")}]`,
        action: "reject",
      };
    }
  }

  // Max order size
  if (policy.maxOrderSize && order.size > policy.maxOrderSize) {
    return {
      time: now,
      rule: "max-order-size",
      detail: `order size ${order.size} > max ${policy.maxOrderSize}`,
      action: "reject",
    };
  }

  // Max notional per order
  if (policy.maxNotional && notional > policy.maxNotional) {
    return {
      time: now,
      rule: "max-notional",
      detail: `notional ${notional.toFixed(2)} > max ${policy.maxNotional}`,
      action: "reject",
    };
  }

  // Max position size (post-fill)
  if (policy.maxPositionSize) {
    const postSize = state.size + (order.side === "buy" ? order.size : -order.size);
    if (Math.abs(postSize) > policy.maxPositionSize) {
      return {
        time: now,
        rule: "max-position-size",
        detail: `post-fill position |${postSize}| > max ${policy.maxPositionSize}`,
        action: "reject",
      };
    }
  }

  // Max gross exposure = gross position notional / equity. For long-only spot
  // this is bounded by 1x in practice (you cannot hold more than your cash buys);
  // the cap is meaningful as a guard against an agent trying to over-allocate,
  // and it is the right primitive to extend to real leverage once futures land.
  if (policy.maxLeverage && ctx.equity > 0) {
    const grossNotional = Math.abs(state.size * price) + notional;
    const exposure = grossNotional / ctx.equity;
    if (exposure > policy.maxLeverage) {
      return {
        time: now,
        rule: "max-leverage",
        detail: `gross exposure ${exposure.toFixed(2)}x > max ${policy.maxLeverage}x`,
        action: "reject",
      };
    }
  }

  // Drawdown kill switch
  if (policy.maxDrawdownKill && ctx.peakEquity > 0) {
    const dd = (ctx.peakEquity - ctx.equity) / ctx.peakEquity;
    if (dd >= policy.maxDrawdownKill) {
      return {
        time: now,
        rule: "max-drawdown-kill",
        detail: `drawdown ${(dd * 100).toFixed(1)}% >= kill level ${(policy.maxDrawdownKill * 100).toFixed(1)}%`,
        action: "kill",
      };
    }
  }

  // Max daily loss kill switch
  if (policy.maxDailyLoss && ctx.dailyRealisedLoss >= policy.maxDailyLoss) {
    return {
      time: now,
      rule: "max-daily-loss",
      detail: `daily realised loss ${ctx.dailyRealisedLoss.toFixed(2)} >= max ${policy.maxDailyLoss}`,
      action: "kill",
    };
  }

  return null; // order passes
}

/** Compute the UTC day epoch (midnight) for a timestamp in ms. */
export function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
