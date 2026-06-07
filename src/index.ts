/**
 * bitget-agentbench — backtest, score and risk-guard Bitget trading agents.
 *
 * @example
 * ```ts
 * import { runBacktest, loadFixture } from "bitget-agentbench";
 *
 * const agent: StrategyAgent = {
 *   onBar(bar, ctx) {
 *     if (ctx.position.size === 0 && bar.close > 50000)
 *       return [{ symbol: "BTCUSDT", side: "buy", orderType: "market", size: 0.01 }];
 *     return [];
 *   },
 * };
 *
 * const bars = loadFixture("BTCUSDT", "1h");
 * const { scorecard } = await runBacktest({
 *   agent, bars,
 *   config: { startingEquity: 10000, feeBps: 10, slippageBps: 1, seed: 42 },
 *   risk: { maxDrawdownKill: 0.3 },
 *   manifest: { agentbenchVersion: "0.1.0", symbol: "BTCUSDT", granularity: "1h",
 *     source: "fixture", bars: bars.length, firstBarTime: bars[0]!.time,
 *     lastBarTime: bars[bars.length-1]!.time, datasetSha256: "fixture" },
 * });
 * console.log(scorecard);
 * ```
 */

// Types (public contract)
export type {
  Bar, Order, Fill, Position, RiskPolicy, Violation,
  EngineConfig, Metrics, RunManifest, Scorecard, Granularity,
  StrategyAgent, BarContext, RunMeta,
} from "./types.js";
export { BarSchema, OrderSchema, FillSchema, RiskPolicySchema, ScorecardSchema, GRANULARITIES } from "./types.js";

// Engine
export { runBacktest } from "./engine/backtest.js";
export type { BacktestInput, RunResult, ManifestInput } from "./engine/backtest.js";
export { fillOrder, applyFill, executeOrder, newSimState } from "./engine/simulator.js";
export type { SimState } from "./engine/simulator.js";
export { screenOrders, utcDayStart } from "./engine/riskguard.js";
export type { RiskCtx } from "./engine/riskguard.js";
export { computeMetrics } from "./engine/metrics.js";
export type { MetricsInput } from "./engine/metrics.js";
export { SeededRng } from "./engine/rng.js";

// Sources
export { loadFixture, parseRawCandles } from "./sources/fixture-source.js";

// Report
export { emitReport, hashDataset } from "./report/emit.js";
export { renderHtml } from "./report/html.js";
export { computeScorecardSha256, canonicalJson } from "./report/hash.js";

// Verification
export { verifyReport } from "./verify.js";
export type { VerifyResult, CheckResult, CheckName, CheckStatus, MetricDiff } from "./verify.js";

// Built-in example strategies (reusable)
export { default as smaCrossover } from "./strategies/sma-crossover.js";
export { default as rsiMeanrev } from "./strategies/rsi-meanrev.js";
export { STRATEGIES, listStrategies } from "./strategies/registry.js";

// Adapters
export { fromAgentHub, toOrder } from "./adapters/agent-hub.js";
export type { AgentHubOrder, AgentHubDecide } from "./adapters/agent-hub.js";

// Package version (single source of truth, stamped into every scorecard)
export { VERSION } from "./version.js";
