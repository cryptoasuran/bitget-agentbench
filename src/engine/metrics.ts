/**
 * Metrics engine — computes standard trading performance metrics from an equity
 * curve and a fill ledger. All pure functions: same inputs = same outputs.
 *
 * Annualisation factors match Bitget candle granularities (periods per 365-day year):
 *  1min=525600, 5min=105120, 15min=35040, 30min=17520,
 *  1h=8760, 4h=2190, 6h=1460, 12h=730,
 *  1day=365, 3day≈122, 1week≈52, 1M=12
 */

import type { Fill, Metrics, Granularity, Violation } from "../types.js";

const PERIODS_PER_YEAR: Record<Granularity, number> = {
  "1min": 365 * 24 * 60,
  "5min": (365 * 24 * 60) / 5,
  "15min": (365 * 24 * 60) / 15,
  "30min": (365 * 24 * 60) / 30,
  "1h": 365 * 24,
  "4h": (365 * 24) / 4,
  "6h": (365 * 24) / 6,
  "12h": (365 * 24) / 12,
  "1day": 365,
  "3day": 365 / 3,
  "1week": 365 / 7,
  "1M": 12,
};

export interface MetricsInput {
  /** Equity curve, one value per bar (closing equity). */
  equity: readonly number[];
  /** All fills across the run. */
  fills: readonly Fill[];
  /** Risk-guard violations emitted during the run. */
  violations: readonly Violation[];
  /** Bar granularity (for annualisation). */
  granularity: Granularity;
  /** Annualised risk-free rate as a decimal (default 0.0). */
  riskFree: number;
  /** Starting equity before any fills. */
  startingEquity: number;
  /** Number of bars in the dataset. */
  totalBars: number;
  /**
   * Per-bar position-held flags (true when a position was open at that bar's
   * close), one per equity-curve entry. Used for an exact exposure %. If
   * omitted, exposure is reported as 0 rather than guessed.
   */
  positionHeld?: readonly boolean[];
}

/**
 * Compute the full metrics report. Golden-value tests should be used to
 * verify the formulas against hand-computed reference data.
 */
export function computeMetrics(input: MetricsInput): Metrics {
  const { equity, fills, violations, granularity, riskFree, startingEquity, totalBars, positionHeld } = input;

  if (equity.length === 0) {
    return zeroMetrics(startingEquity, violations.length);
  }

  const finalEquity = equity[equity.length - 1]!;
  const totalReturnPct = ((finalEquity - startingEquity) / startingEquity) * 100;

  // Max drawdown
  let peak = startingEquity;
  let maxDrawdownPct = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = ((peak - e) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Per-bar simple returns for Sharpe / Sortino: (e - prev) / prev.
  // equity[0] is the pre-trade starting-equity sentinel, not a bar close, so we
  // start from it as the baseline (prev) but do not emit a return for it. That
  // avoids a spurious leading 0% return contaminating the series.
  const returns: number[] = [];
  let prev = equity[0]!;
  for (let i = 1; i < equity.length; i++) {
    const e = equity[i]!;
    if (prev > 0) returns.push((e - prev) / prev);
    prev = e;
  }

  const ann = PERIODS_PER_YEAR[granularity] ?? 365;
  const sharpe = computeSharpe(returns, riskFree, ann);
  const sortino = computeSortino(returns, riskFree, ann);

  // Trade-level stats
  const { winRatePct, profitFactor, totalTrades, totalFees, grossProfit, grossLoss } =
    tradeStats(fills);

  // Turnover = sum|notional| / avg equity. Average over true bar closes
  // (exclude the seed element at index 0).
  let totalTurnover = 0;
  for (const f of fills) totalTurnover += Math.abs(f.price * f.size);
  const barEquity = equity.length > 1 ? equity.slice(1) : equity;
  const avgEquity = barEquity.reduce((a, b) => a + b, 0) / barEquity.length;
  const turnover = avgEquity > 0 ? totalTurnover / avgEquity : 0;

  // Exposure = fraction of bars where a position was held at the bar close.
  // Exact when positionHeld is provided; otherwise reported as 0 (not guessed).
  const heldBars = positionHeld ? positionHeld.filter(Boolean).length : 0;
  const exposurePct = totalBars > 0 ? (heldBars / totalBars) * 100 : 0;

  return {
    startingEquity,
    finalEquity,
    totalReturnPct,
    maxDrawdownPct,
    sharpe,
    sortino,
    winRatePct,
    profitFactor,
    totalTrades,
    totalFees,
    turnover,
    exposurePct,
    violations: violations.length,
  };
}

/** Compute annualised Sharpe ratio. */
function computeSharpe(returns: number[], rf: number, periods: number): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const excess = mean - rf / periods;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  if (variance <= 0) return 0;
  return (excess / Math.sqrt(variance)) * Math.sqrt(periods);
}

/**
 * Compute annualised Sortino ratio (downside deviation only).
 * Returns null when there is no downside (no negative returns): the ratio is
 * mathematically undefined there, and null serialises cleanly to JSON instead
 * of Infinity (which JSON.stringify turns into null silently).
 */
function computeSortino(returns: number[], rf: number, periods: number): number | null {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const excess = mean - rf / periods;
  const negative = returns.filter((r) => r < 0);
  if (negative.length === 0) return null; // no downside -> undefined
  const downsideVar =
    negative.reduce((sum, r) => sum + r ** 2, 0) / negative.length;
  if (downsideVar <= 0) return 0;
  return (excess / Math.sqrt(downsideVar)) * Math.sqrt(periods);
}

/** Per-trade statistics from the fill ledger. */
function tradeStats(fills: readonly Fill[]) {
  if (fills.length === 0) {
    return { winRatePct: 0, profitFactor: 0, totalTrades: 0, totalFees: 0, grossProfit: 0, grossLoss: 0 };
  }

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let totalFees = 0;

  for (const f of fills) {
    totalFees += f.fee;
    // A fill is a "trade" when it has nonzero realised PnL (closing fill).
    if (f.realizedPnl > 0) {
      grossProfit += f.realizedPnl;
      wins++;
    } else if (f.realizedPnl < 0) {
      grossLoss += Math.abs(f.realizedPnl);
      losses++;
    }
  }

  const totalTrades = wins + losses;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  // null when there are no losing trades (factor undefined). Avoids Infinity,
  // which JSON.stringify silently turns into null anyway.
  const profitFactor: number | null =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0;

  return { winRatePct, profitFactor, totalTrades, totalFees, grossProfit, grossLoss };
}

function zeroMetrics(startingEquity: number, violationCount: number): Metrics {
  return {
    startingEquity,
    finalEquity: startingEquity,
    totalReturnPct: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    sortino: 0,
    winRatePct: 0,
    profitFactor: 0,
    totalTrades: 0,
    totalFees: 0,
    turnover: 0,
    exposurePct: 0,
    violations: violationCount,
  };
}
