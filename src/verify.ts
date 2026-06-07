/**
 * verify — independently check that a scorecard is real.
 *
 * A scorecard is only useful if a third party can confirm it without trusting the
 * author. `verifyReport` re-derives the claim from the artifacts themselves and
 * runs up to four layered checks:
 *
 *   integrity  recompute the content hash, assert it matches the stored one.
 *              Catches any edit to scorecard.json.
 *   dataset    reload the candles named in the manifest, recompute their SHA256,
 *              assert it matches. Catches swapped or doctored candles.
 *   ledger     recompute every headline metric straight from equity.csv +
 *              trades.jsonl (reconstructing position/exposure from the fills) and
 *              assert it matches the claimed metrics. Catches the screenshot lie:
 *              numbers that do not follow from the trades.
 *   replay     for a built-in agent, re-run the backtest from the manifest's own
 *              config and seed and assert the metrics reproduce. The strongest
 *              check. Skips for external agents we cannot run.
 *
 * Each check reports pass / fail / skip with a reason. A re-stamped content hash
 * cannot launder a fake: integrity then passes, but ledger and replay recompute
 * the numbers from scratch and expose the tamper.
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { ScorecardSchema, FillSchema } from "./types.js";
import type { Scorecard, Fill, Metrics, Violation } from "./types.js";
import { hashDataset } from "./report/emit.js";
import { computeScorecardSha256 } from "./report/hash.js";
import { computeMetrics } from "./engine/metrics.js";
import { loadFixture } from "./sources/fixture-source.js";
import { runBacktest } from "./engine/backtest.js";
import { STRATEGIES } from "./strategies/registry.js";

export type CheckName = "integrity" | "dataset" | "ledger" | "replay";
export type CheckStatus = "pass" | "fail" | "skip";

export interface MetricDiff {
  field: string;
  claimed: string;
  recomputed: string;
}

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  detail: string;
  diffs?: MetricDiff[];
}

export interface VerifyResult {
  /** Resolved scorecard.json path that was verified. */
  target: string;
  agent: string;
  /**
   * True only when no check FAILED and at least one *substantive* recompute
   * (ledger or replay) PASSED. Integrity and dataset alone cannot certify a
   * scorecard: a forger can self-stamp a content hash over invented metrics, so
   * "the file was not edited" is not "the numbers are real". When every
   * substantive check skips, the verdict is not-verified (unverifiable), never
   * a pass. That closes the SKIP-as-free-pass hole.
   */
  pass: boolean;
  checks: CheckResult[];
}

/** Metric fields recomputed from the ledger and compared. Excludes `violations`,
 * which is not derivable from trades.jsonl alone and is covered by replay. */
const LEDGER_FIELDS = [
  "startingEquity", "finalEquity", "totalReturnPct", "maxDrawdownPct",
  "sharpe", "sortino", "winRatePct", "profitFactor", "totalTrades",
  "totalFees", "turnover", "exposurePct",
] as const;

/** All metric fields, compared on replay (which regenerates everything). */
const ALL_FIELDS = [...LEDGER_FIELDS, "violations"] as const;

/**
 * Verify a report. `target` may be a report directory or a scorecard.json path.
 */
export async function verifyReport(target: string): Promise<VerifyResult> {
  const abs = resolve(target);
  const isDir = existsSync(abs) && statSync(abs).isDirectory();
  const scorecardPath = isDir ? join(abs, "scorecard.json") : abs;
  const dir = isDir ? abs : dirname(abs);

  // A missing or malformed scorecard is an integrity failure, not a crash.
  let scorecard: Scorecard;
  try {
    scorecard = readScorecard(scorecardPath);
  } catch (err) {
    return {
      target: scorecardPath,
      agent: "unknown",
      pass: false,
      checks: [
        {
          name: "integrity",
          status: "fail",
          detail: `could not read a valid scorecard at ${scorecardPath}: ${String(err)}`,
        },
        skip("dataset", "no scorecard to check against"),
        skip("ledger", "no scorecard to check against"),
        skip("replay", "no scorecard to check against"),
      ],
    };
  }

  const checks: CheckResult[] = [
    checkIntegrity(scorecardPath, scorecard),
    checkDataset(scorecard),
    checkLedger(dir, scorecard),
    await checkReplay(scorecard),
  ];

  // A SKIP is never a free pass. Require a substantive recompute (ledger or
  // replay) to have actually PASSED, and no check to have failed.
  const anyFail = checks.some((c) => c.status === "fail");
  const substantivePass = checks.some(
    (c) => (c.name === "ledger" || c.name === "replay") && c.status === "pass",
  );
  return {
    target: scorecardPath,
    agent: scorecard.agent,
    pass: !anyFail && substantivePass,
    checks,
  };
}

function skip(name: CheckName, detail: string): CheckResult {
  return { name, status: "skip", detail };
}

function readScorecard(path: string): Scorecard {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ScorecardSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// integrity
// ---------------------------------------------------------------------------

function checkIntegrity(path: string, scorecard: Scorecard): CheckResult {
  if (!scorecard.scorecardSha256) {
    return {
      name: "integrity",
      status: "skip",
      detail: "no scorecardSha256 on this scorecard (pre-0.2.0); cannot check file integrity",
    };
  }
  const recomputed = computeScorecardSha256(scorecard);
  if (recomputed === scorecard.scorecardSha256) {
    return {
      name: "integrity",
      status: "pass",
      detail: `content hash matches (${recomputed.slice(0, 16)}…)`,
    };
  }
  return {
    name: "integrity",
    status: "fail",
    detail: "content hash mismatch: scorecard.json was edited after it was emitted",
    diffs: [{ field: "scorecardSha256", claimed: scorecard.scorecardSha256, recomputed }],
  };
}

// ---------------------------------------------------------------------------
// dataset
// ---------------------------------------------------------------------------

function checkDataset(scorecard: Scorecard): CheckResult {
  const m = scorecard.manifest;
  if (m.source !== "fixture") {
    return {
      name: "dataset",
      status: "skip",
      detail: `dataset source is "${m.source}", not bundled; cannot re-derive the candle hash`,
    };
  }
  let bars;
  try {
    bars = loadFixture(m.symbol, m.granularity);
  } catch (err) {
    return {
      name: "dataset",
      status: "skip",
      detail: `fixture for ${m.symbol} ${m.granularity} not available here: ${String(err)}`,
    };
  }
  const recomputed = hashDataset(bars);
  if (recomputed === m.datasetSha256) {
    return {
      name: "dataset",
      status: "pass",
      detail: `${bars.length} candles re-hash to the claimed dataset SHA256 (${recomputed.slice(0, 16)}…)`,
    };
  }
  return {
    name: "dataset",
    status: "fail",
    detail: "dataset hash mismatch: the candles do not match the manifest",
    diffs: [{ field: "datasetSha256", claimed: m.datasetSha256, recomputed }],
  };
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

function checkLedger(dir: string, scorecard: Scorecard): CheckResult {
  const equityPath = join(dir, "equity.csv");
  const tradesPath = join(dir, "trades.jsonl");
  if (!existsSync(equityPath) || !existsSync(tradesPath)) {
    return {
      name: "ledger",
      status: "skip",
      detail: "equity.csv or trades.jsonl not found; point verify at a full report directory",
    };
  }

  const m = scorecard.manifest;
  let bars;
  try {
    bars = loadFixture(m.symbol, m.granularity);
  } catch (err) {
    return {
      name: "ledger",
      status: "skip",
      detail: `cannot reload candles to reconstruct exposure: ${String(err)}`,
    };
  }

  // Parsing the ledger is part of the check: a corrupt equity.csv or trades.jsonl
  // is a failed verification, not a thrown exception that crashes the tool.
  let equity: number[];
  let fills: Fill[];
  try {
    equity = parseEquityCsv(readFileSync(equityPath, "utf8"));
    fills = parseTradesJsonl(readFileSync(tradesPath, "utf8"));
  } catch (err) {
    return {
      name: "ledger",
      status: "fail",
      detail: `could not parse the trade ledger or equity curve: ${String(err)}`,
    };
  }

  const positionHeld = reconstructPositionHeld(bars, fills, equity.length);

  // violations is not derivable from the ledger; feed the claimed count so the
  // performance metrics line up. Replay re-derives violations independently.
  const dummyViolations: Violation[] = Array.from(
    { length: scorecard.metrics.violations },
    () => ({ time: 0, rule: "", detail: "", action: "reject" as const }),
  );

  const recomputed = computeMetrics({
    equity,
    fills,
    violations: dummyViolations,
    granularity: m.granularity,
    riskFree: 0,
    startingEquity: m.engine.startingEquity,
    totalBars: m.bars,
    positionHeld,
  });

  const diffs = diffMetrics(scorecard.metrics, recomputed, LEDGER_FIELDS);
  if (diffs.length === 0) {
    return {
      name: "ledger",
      status: "pass",
      detail: `all ${LEDGER_FIELDS.length} headline metrics recompute from ${fills.length} fills + the equity curve`,
    };
  }
  return {
    name: "ledger",
    status: "fail",
    detail: "recomputed metrics do not match the claim: the ledger does not support these numbers",
    diffs,
  };
}

/** Equity CSV: a header line "equity" then one value per bar. Throws on a
 * non-numeric row so a corrupt curve is caught instead of poisoning the metrics
 * with NaN. */
function parseEquityCsv(text: string): number[] {
  const lines = text.trim().split("\n").filter((l) => l.length > 0);
  if (lines[0]?.trim() === "equity") lines.shift();
  return lines.map((l, i) => {
    const n = Number(l);
    if (!Number.isFinite(n)) {
      throw new Error(`equity.csv row ${i + 1} is not a finite number: ${JSON.stringify(l)}`);
    }
    return n;
  });
}

/** Trade ledger: one JSON Fill per line. */
function parseTradesJsonl(text: string): Fill[] {
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => FillSchema.parse(JSON.parse(l)));
}

/**
 * Rebuild the per-bar position-held flags from the fills, matching how the
 * backtest tracked them: a flag per equity-curve entry (index 0 is the pre-trade
 * seed), true when net position is open at that bar's close. Orders decided at
 * bar i execute at bar i+1, so a fill's time identifies its execution bar.
 */
function reconstructPositionHeld(
  bars: readonly { time: number }[],
  fills: readonly Fill[],
  targetLen: number,
): boolean[] {
  const held: boolean[] = [false]; // seed: flat before the first bar
  let size = 0;
  let fi = 0;
  // Stop at targetLen so an early-killed run (shorter equity curve) still lines
  // up with its ledger.
  for (let i = 0; i < bars.length - 1 && held.length < targetLen; i++) {
    const execTime = bars[i + 1]!.time;
    while (fi < fills.length && fills[fi]!.time === execTime) {
      const f = fills[fi]!;
      size += f.side === "buy" ? f.size : -f.size;
      if (size < 0) size = 0; // long-only clamp, mirrors the simulator
      fi++;
    }
    held.push(size !== 0);
  }
  return held;
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

async function checkReplay(scorecard: Scorecard): Promise<CheckResult> {
  const agent = STRATEGIES[scorecard.agent];
  if (!agent) {
    return {
      name: "replay",
      status: "skip",
      detail: `agent "${scorecard.agent}" is not a built-in strategy; cannot re-run an external agent`,
    };
  }
  const m = scorecard.manifest;
  let bars;
  try {
    bars = loadFixture(m.symbol, m.granularity);
  } catch (err) {
    return {
      name: "replay",
      status: "skip",
      detail: `fixture for ${m.symbol} ${m.granularity} not available to replay: ${String(err)}`,
    };
  }

  const { scorecard: replayed } = await runBacktest({
    agent,
    bars,
    config: m.engine,
    risk: m.risk,
    manifest: {
      agentbenchVersion: m.agentbenchVersion,
      symbol: m.symbol,
      granularity: m.granularity,
      source: m.source,
      bars: bars.length,
      firstBarTime: bars[0]?.time ?? 0,
      lastBarTime: bars[bars.length - 1]?.time ?? 0,
      datasetSha256: hashDataset(bars),
    },
  });

  const diffs = diffMetrics(scorecard.metrics, replayed.metrics, ALL_FIELDS);
  if (diffs.length === 0) {
    return {
      name: "replay",
      status: "pass",
      detail: `re-running ${scorecard.agent} from the manifest reproduces every metric`,
    };
  }
  return {
    name: "replay",
    status: "fail",
    detail: "replay did not reproduce the claimed metrics: the ledger was not produced by this run",
    diffs,
  };
}

// ---------------------------------------------------------------------------
// metric comparison
// ---------------------------------------------------------------------------

/** A small tolerance absorbs float re-serialisation without hiding real tampers
 * (which move numbers by orders of magnitude, not by 1e-6). */
function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

function diffMetrics(
  claimed: Metrics,
  recomputed: Metrics,
  fields: readonly (keyof Metrics)[],
): MetricDiff[] {
  const diffs: MetricDiff[] = [];
  for (const f of fields) {
    const a = claimed[f];
    const b = recomputed[f];
    const equal =
      a === null || b === null
        ? a === b
        : numbersEqual(a as number, b as number);
    if (!equal) {
      diffs.push({ field: f, claimed: String(a), recomputed: String(b) });
    }
  }
  return diffs;
}
