import { z } from "zod";

/**
 * AgentBench core types.
 *
 * The public surface is deliberately tiny. A strategy author implements
 * {@link StrategyAgent} (one method) and gets a full backtest, a risk gate and a
 * reproducible scorecard. Everything an integrator touches lives in this file.
 */

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** A single OHLCV candle. `time` is the open time in epoch milliseconds. */
export const BarSchema = z.object({
  time: z.number().int().nonnegative(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nonnegative(),
});
export type Bar = z.infer<typeof BarSchema>;

/** Granularities accepted by the Bitget candle endpoints. */
export const GRANULARITIES = [
  "1min",
  "5min",
  "15min",
  "30min",
  "1h",
  "4h",
  "6h",
  "12h",
  "1day",
  "3day",
  "1week",
  "1M",
] as const;
export type Granularity = (typeof GRANULARITIES)[number];

// ---------------------------------------------------------------------------
// Orders and fills
// ---------------------------------------------------------------------------

export const OrderSideSchema = z.enum(["buy", "sell"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(["market", "limit"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

/**
 * An order emitted by a strategy. Shaped to mirror Bitget's `spot_place_order`
 * fields (symbol, side, orderType, price, size) so an agent that already targets
 * agent_hub tools drops in without a rewrite.
 */
export const OrderSchema = z.object({
  symbol: z.string().min(1),
  side: OrderSideSchema,
  orderType: OrderTypeSchema,
  /** Required for limit orders, ignored for market orders. */
  price: z.number().positive().optional(),
  /** Order size in base units (e.g. BTC for BTCUSDT). */
  size: z.number().positive(),
  /** Optional caller tag echoed into the trade ledger. */
  tag: z.string().optional(),
});
export type Order = z.infer<typeof OrderSchema>;

/** A simulated fill produced by the engine for an order. */
export const FillSchema = z.object({
  time: z.number().int().nonnegative(),
  symbol: z.string(),
  side: OrderSideSchema,
  orderType: OrderTypeSchema,
  /** Size actually filled (may be less than requested on a partial). */
  size: z.number(),
  /** Average fill price after slippage. */
  price: z.number(),
  /** Fee paid in quote currency. */
  fee: z.number(),
  /** Slippage applied vs the reference price, in quote currency. */
  slippage: z.number(),
  /** Realised PnL booked by this fill (0 for position-opening fills). */
  realizedPnl: z.number(),
  /** Account equity immediately after the fill. */
  equityAfter: z.number(),
  tag: z.string().optional(),
});
export type Fill = z.infer<typeof FillSchema>;

/** Net position in a single symbol. Positive size = long, negative = short. */
export const PositionSchema = z.object({
  symbol: z.string(),
  /** Signed base size. 0 means flat. */
  size: z.number(),
  /** Volume-weighted average entry price of the open position. */
  avgPrice: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

// ---------------------------------------------------------------------------
// Risk policy (RiskGuard)
// ---------------------------------------------------------------------------

/**
 * Declarative risk policy enforced between the agent and the simulator. Any
 * field left undefined is not enforced. Orders that violate a hard limit are
 * rejected (and recorded); the drawdown kill-switch halts the whole run.
 */
export const RiskPolicySchema = z.object({
  /** Max absolute base size of any single order. */
  maxOrderSize: z.number().positive().optional(),
  /** Max absolute net position size per symbol (post-fill). */
  maxPositionSize: z.number().positive().optional(),
  /** Max notional (price * size) of any single order, in quote currency. */
  maxNotional: z.number().positive().optional(),
  /** Max gross leverage = gross notional / equity. */
  maxLeverage: z.number().positive().optional(),
  /** Only these symbols may be traded. Empty/undefined means all allowed. */
  symbolAllowlist: z.array(z.string()).optional(),
  /** Halt the run if equity drops this fraction below peak (0.2 = 20%). */
  maxDrawdownKill: z.number().positive().max(1).optional(),
  /** Halt the run if realised loss within one UTC day exceeds this (quote). */
  maxDailyLoss: z.number().positive().optional(),
});
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

/** A single risk rejection or kill event, recorded for the scorecard. */
export const ViolationSchema = z.object({
  time: z.number().int().nonnegative(),
  rule: z.string(),
  detail: z.string(),
  /** "reject" drops the order; "kill" halts the run. */
  action: z.enum(["reject", "kill"]),
});
export type Violation = z.infer<typeof ViolationSchema>;

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export const EngineConfigSchema = z.object({
  /** Starting equity in quote currency (e.g. USDT). */
  startingEquity: z.number().positive().default(10_000),
  /**
   * Fee in basis points (1 bp = 0.01%). Bitget standard spot: 0.1% flat
   * (10 bps) for both maker and taker. Source: Bitget Academy Fee Structure,
   * verified 2026-06-05. Futures fees (2/6 bps) are NOT used here; this is
   * a spot backtest engine. Users can override for their actual tier.
   */
  feeBps: z.number().nonnegative().default(10),
  /** Slippage in basis points applied against market fills. */
  slippageBps: z.number().nonnegative().default(1),
  /** Deterministic seed for any randomised behaviour. */
  seed: z.number().int().default(1),
});
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

// ---------------------------------------------------------------------------
// Strategy contract (what an integrator implements)
// ---------------------------------------------------------------------------

/**
 * Read-only view handed to the strategy on every bar. Lookahead is impossible:
 * `bar` is the just-closed bar and `history` holds only prior bars.
 */
export interface BarContext {
  /** Index of the current bar in the dataset (0-based). */
  readonly index: number;
  /** Bars strictly before the current one, oldest first. */
  readonly history: readonly Bar[];
  /** Current net position in the traded symbol. */
  readonly position: Position;
  /** Current account equity (mark-to-market on the current close). */
  readonly equity: number;
  /** Free quote balance not tied up in position. */
  readonly cash: number;
}

/**
 * The one interface a strategy author implements. Return the orders to place on
 * this bar (empty array to do nothing). Sync or async both work.
 *
 * @example
 * const sma: StrategyAgent = {
 *   onBar(bar, ctx) {
 *     if (ctx.position.size === 0 && bar.close > avg(ctx.history)) {
 *       return [{ symbol: bar's symbol, side: "buy", orderType: "market", size: 0.01 }];
 *     }
 *     return [];
 *   },
 * };
 */
export interface StrategyAgent {
  /** Optional human-readable name shown in the scorecard. */
  readonly name?: string;
  /** Optional hook called once before the first bar. */
  init?(meta: RunMeta): void | Promise<void>;
  /** Called once per bar. Return orders to place. */
  onBar(bar: Bar, ctx: BarContext): Order[] | Promise<Order[]>;
}

/** Static run metadata passed to `init`. */
export interface RunMeta {
  readonly symbol: string;
  readonly granularity: Granularity;
  readonly bars: number;
}

// ---------------------------------------------------------------------------
// Output artifacts (scorecard, manifest)
// ---------------------------------------------------------------------------

export const MetricsSchema = z.object({
  startingEquity: z.number(),
  finalEquity: z.number(),
  totalReturnPct: z.number(),
  maxDrawdownPct: z.number(),
  sharpe: z.number(),
  /** null when there is no downside (no negative returns): ratio undefined. */
  sortino: z.number().nullable(),
  winRatePct: z.number(),
  /** null when there are no losing trades: factor undefined. */
  profitFactor: z.number().nullable(),
  totalTrades: z.number().int(),
  totalFees: z.number(),
  turnover: z.number(),
  exposurePct: z.number(),
  violations: z.number().int(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

/** Reproducibility record. Lets a judge re-run and verify byte-for-byte. */
export const RunManifestSchema = z.object({
  agentbenchVersion: z.string(),
  schemaVersion: z.literal(1),
  symbol: z.string(),
  granularity: z.enum(GRANULARITIES),
  source: z.enum(["fixture", "candles"]),
  bars: z.number().int(),
  firstBarTime: z.number().int(),
  lastBarTime: z.number().int(),
  /** SHA256 of the candle dataset that drove the run. */
  datasetSha256: z.string(),
  engine: EngineConfigSchema,
  risk: RiskPolicySchema,
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

/**
 * The full scorecard. This file IS the verifiable usage evidence.
 *
 * `scorecardSha256` is a content hash over {agent, metrics, manifest}, written at
 * emit time so the artifact is self-certifying. It is optional on the schema so
 * scorecards produced before 0.2.0 still parse; `agentbench verify` treats its
 * absence as a skipped integrity check, not a failure.
 */
export const ScorecardSchema = z.object({
  agent: z.string(),
  metrics: MetricsSchema,
  manifest: RunManifestSchema,
  /** SHA256 over {agent, metrics, manifest}. See report/hash.ts. */
  scorecardSha256: z.string().optional(),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
