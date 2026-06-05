import { describe, it, expect } from "vitest";
import { computeMetrics } from "../src/engine/metrics.js";
import type { Fill, Violation } from "../src/types.js";

// Hand-computed scenario: 3 bars, 1h candles, 2 fills.
const equity = [10100, 10200, 9800];
const fills: Fill[] = [
  {
    time: 1780588800000, symbol: "BTCUSDT", side: "sell",
    orderType: "market", size: 0.01, price: 63800, fee: 6.38,
    slippage: 0, realizedPnl: 200, equityAfter: 10100, // win
  },
  {
    time: 1780592400000, symbol: "BTCUSDT", side: "sell",
    orderType: "market", size: 0.01, price: 63600, fee: 6.36,
    slippage: 0, realizedPnl: -600, equityAfter: 9800, // loss
  },
];
const noViolations: Violation[] = [];

describe("computeMetrics", () => {
  it("totalReturnPct = -2% from 10000 to 9800", () => {
    const m = computeMetrics({
      equity, fills, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 3,
    });
    expect(m.totalReturnPct).toBeCloseTo(-2, 2);
  });

  it("maxDrawdownPct sees peak at 10200, trough at 9800", () => {
    const m = computeMetrics({
      equity, fills, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 3,
    });
    // peak 10200, trough 9800 -> (10200 - 9800) / 10200 * 100 ≈ 3.92%
    expect(m.maxDrawdownPct).toBeCloseTo(3.92, 1);
  });

  it("winRate = 50% (1 win, 1 loss)", () => {
    const m = computeMetrics({
      equity, fills, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 3,
    });
    expect(m.winRatePct).toBeCloseTo(50, 0);
  });

  it("profitFactor = gross profit / gross loss = 200 / 600 ≈ 0.333", () => {
    const m = computeMetrics({
      equity, fills, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 3,
    });
    expect(m.profitFactor).toBeCloseTo(0.333, 2);
  });

  it("totalTrades = 2, totalFees = 6.38 + 6.36", () => {
    const m = computeMetrics({
      equity, fills, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 3,
    });
    expect(m.totalTrades).toBe(2);
    expect(m.totalFees).toBeCloseTo(12.74, 2);
  });

  it("empty equity returns zero metrics", () => {
    const m = computeMetrics({
      equity: [], fills: [], violations: [],
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 0,
    });
    expect(m.totalReturnPct).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.sortino).toBe(0);
  });

  it("only winning trades -> profitFactor is null (undefined, not Infinity)", () => {
    const winOnly: Fill[] = [
      { ...fills[0]!, realizedPnl: 500 },
    ];
    const m = computeMetrics({
      equity: [10500, 10600], fills: winOnly, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 1,
    });
    // null serialises cleanly to JSON; Infinity would become null silently
    expect(m.profitFactor).toBeNull();
    expect(m.winRatePct).toBe(100);
  });

  it("Sharpe and Sortino are computed (negative return = negative Sharpe)", () => {
    const m = computeMetrics({
      equity, fills, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 3,
    });
    // Existence check — exact values verified by golden snapshots
    expect(m.sharpe).toBeLessThan(0); // losing run
    expect(m.sortino).not.toBeNull();
    expect(m.sortino!).toBeLessThan(0);
    expect(Number.isFinite(m.sortino!)).toBe(true);
  });

  it("no scorecard metric serialises to a JSON null hole from Infinity", () => {
    // A run with downside present and losses present -> both finite numbers
    const m = computeMetrics({
      equity, fills, violations: noViolations,
      granularity: "1h", riskFree: 0,
      startingEquity: 10_000, totalBars: 3,
    });
    const json = JSON.stringify(m);
    // Infinity would have stringified to null; assert no accidental nulls beyond
    // the two intentionally-nullable fields when they are defined here.
    const parsed = JSON.parse(json);
    expect(Number.isFinite(parsed.sharpe)).toBe(true);
    expect(Number.isFinite(parsed.maxDrawdownPct)).toBe(true);
    expect(Number.isFinite(parsed.turnover)).toBe(true);
  });
});
