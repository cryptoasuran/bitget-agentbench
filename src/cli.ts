#!/usr/bin/env node
/**
 * agentbench CLI.
 *
 * Usage:
 *   agentbench run (--strategy <name> | --agent <file>) --symbol BTCUSDT --tf 4h
 *                  [--seed 42] [--out ./report]
 *   agentbench report <scorecard.json>
 *   agentbench compare <a.json> <b.json>
 *   agentbench verify <report-dir | scorecard.json>
 */

import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixture, parseRawCandles } from "./sources/fixture-source.js";
import { fetchRawCandles } from "./sources/candle-source.js";
import { runBacktest } from "./engine/backtest.js";
import { emitReport, hashDataset } from "./report/emit.js";
import { verifyReport } from "./verify.js";
import type { CheckStatus } from "./verify.js";
import { STRATEGIES, listStrategies } from "./strategies/registry.js";
import { VERSION } from "./version.js";
import { ScorecardSchema } from "./types.js";
import type { Granularity, Scorecard, StrategyAgent } from "./types.js";

interface CliArgs {
  cmd: string;
  strategyName?: string;
  agentPath?: string;
  symbol?: string;
  granularity?: Granularity;
  seed?: number;
  outDir?: string;
  /** "fixture" (default, zero-network) or "live" (fetch fresh Bitget candles). */
  source?: string;
  /** Candle count for --source live (default 200, capped at 1000). */
  limit?: number;
  args: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const result: Partial<CliArgs> = { args: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case "--strategy": result.strategyName = argv[++i]; break;
      case "--agent": result.agentPath = argv[++i]; break;
      case "--symbol": result.symbol = argv[++i]; break;
      case "--tf": result.granularity = argv[++i] as Granularity; break;
      case "--seed": result.seed = Number(argv[++i]); break;
      case "--out": result.outDir = argv[++i]; break;
      case "--source": result.source = argv[++i]; break;
      case "--limit": result.limit = Number(argv[++i]); break;
      case "--help": case "-h": result.cmd = "help"; break;
      default:
        if (!result.cmd && !a.startsWith("--")) result.cmd = a;
        else result.args!.push(a);
        break;
    }
    i++;
  }
  return result as CliArgs;
}

function helpText(): string {
  return (
    [
      "agentbench: backtest and score Bitget trading agents",
      "",
      "Usage:",
      "  agentbench run (--strategy <name> | --agent <file>) --symbol <SYM>",
      "               --tf <1h|4h|1day|...> [--seed <n>] [--out <dir>]",
      "               [--source <fixture|live>] [--limit <n>]",
      "  agentbench report <scorecard.json>",
      "  agentbench compare <a.json> <b.json>",
      "  agentbench verify <report-dir | scorecard.json>",
      "",
      `Built-in strategies: ${listStrategies().join(", ")}`,
      "",
      "Sources: fixture (default, committed candles, zero network) or live",
      "  (fetch fresh candles from Bitget's public keyless endpoint; the run",
      "  snapshots them to candles.json so it stays verifiable).",
      "",
      "Examples:",
      "  agentbench run --strategy sma-crossover --symbol BTCUSDT --tf 4h --out ./r",
      "  agentbench run --strategy rsi-meanrev --symbol BTCUSDT --tf 4h --source live --limit 500 --out ./r",
      "  agentbench run --agent ./my-agent.ts --symbol ETHUSDT --tf 4h --seed 99",
      "  agentbench report ./r/scorecard.json",
      "  agentbench compare ./a/scorecard.json ./b/scorecard.json",
      "  agentbench verify ./r",
      "",
      `version ${VERSION}`,
    ].join("\n") + "\n"
  );
}

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  if (opts.cmd === "help" || !opts.cmd) {
    process.stdout.write(helpText());
    return;
  }

  if (opts.cmd === "run") {
    await cmdRun(opts);
  } else if (opts.cmd === "report") {
    await cmdReport(opts);
  } else if (opts.cmd === "compare") {
    await cmdCompare(opts);
  } else if (opts.cmd === "verify") {
    await cmdVerify(opts);
  } else {
    process.stderr.write(`agentbench: unknown command "${opts.cmd}"\n`);
    process.exitCode = 1;
  }
}

/** Resolve the agent from --strategy (built-in) or --agent (a file). */
async function resolveAgent(opts: CliArgs): Promise<StrategyAgent | null> {
  if (opts.strategyName && opts.agentPath) {
    process.stderr.write(
      "agentbench run: pass either --strategy <name> or --agent <file>, not both\n",
    );
    return null;
  }

  if (opts.strategyName) {
    const agent = STRATEGIES[opts.strategyName];
    if (!agent) {
      process.stderr.write(
        `agentbench run: unknown strategy "${opts.strategyName}". ` +
          `Available: ${listStrategies().join(", ")}\n`,
      );
      return null;
    }
    return agent;
  }

  if (opts.agentPath) {
    const absPath = resolve(opts.agentPath);
    let agentModule: unknown;
    try {
      agentModule = await import(absPath);
    } catch (err) {
      process.stderr.write(
        `agentbench: failed to load agent at ${absPath}: ${String(err)}\n`,
      );
      return null;
    }
    const agent: StrategyAgent =
      ((agentModule as Record<string, unknown>)?.default as StrategyAgent) ||
      ((agentModule as Record<string, unknown>)?.agent as StrategyAgent);
    if (!agent || typeof agent.onBar !== "function") {
      process.stderr.write(
        `agentbench: agent at ${absPath} must export a default ` +
          `{ onBar(bar, ctx) } or named "agent"\n`,
      );
      return null;
    }
    return agent;
  }

  process.stderr.write(
    "agentbench run: provide --strategy <name> or --agent <file>\n",
  );
  return null;
}

/** Format the human-readable scorecard summary shared by `run` and `report`. */
function formatScorecardSummary(s: Scorecard, outDir?: string): string {
  const m = s.metrics;
  const lines = [
    `Agent:       ${s.agent}`,
    `Symbol:      ${s.manifest.symbol} ${s.manifest.granularity}`,
    `Bars:        ${s.manifest.bars}`,
    `Version:     ${s.manifest.agentbenchVersion}`,
    `Equity:      ${m.startingEquity} → ${m.finalEquity.toFixed(2)}`,
    `Return:      ${m.totalReturnPct.toFixed(2)}%`,
    `Max DD:      ${m.maxDrawdownPct.toFixed(2)}%`,
    `Sharpe:      ${m.sharpe.toFixed(2)}`,
    `Sortino:     ${m.sortino === null ? "n/a" : m.sortino.toFixed(2)}`,
    `Win Rate:    ${m.winRatePct.toFixed(1)}%`,
    `Profit Fact: ${m.profitFactor === null ? "n/a" : m.profitFactor.toFixed(2)}`,
    `Trades:      ${m.totalTrades}`,
    `Fees:        ${m.totalFees.toFixed(4)}`,
    `Violations:  ${m.violations}`,
  ];
  if (outDir) lines.push("", `Report: ${outDir}/`);
  return lines.join("\n") + "\n";
}

async function cmdRun(opts: CliArgs): Promise<void> {
  const symbol = opts.symbol ?? "BTCUSDT";
  const granularity = opts.granularity ?? "1h";
  const seed = opts.seed ?? 1;
  const outDir = opts.outDir ?? "./agentbench-report";

  const agent = await resolveAgent(opts);
  if (!agent) {
    process.exitCode = 1;
    return;
  }

  // Load candles: a committed fixture (default, zero network) or fresh from
  // Bitget's public keyless endpoint. A live run snapshots the exact candles it
  // fetched so the result stays reproducible and verifiable afterward.
  const sourceOpt = opts.source ?? "fixture";
  const live = sourceOpt === "live" || sourceOpt === "candles";
  let bars;
  let manifestSource: "fixture" | "candles";
  let rawSnapshot: Awaited<ReturnType<typeof fetchRawCandles>> | null = null;
  if (live) {
    const limit = opts.limit ?? 200;
    process.stderr.write(
      `Fetching live candles ${symbol} ${granularity} (limit ${limit}) from Bitget...\n`,
    );
    try {
      rawSnapshot = await fetchRawCandles({ symbol, granularity, limit });
    } catch (err) {
      process.stderr.write(`agentbench run: live fetch failed: ${String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    bars = parseRawCandles(rawSnapshot.data as Parameters<typeof parseRawCandles>[0]);
    manifestSource = "candles";
  } else {
    process.stderr.write(`Loading fixture ${symbol} ${granularity}...\n`);
    bars = loadFixture(symbol, granularity);
    manifestSource = "fixture";
  }
  process.stderr.write(`Loaded ${bars.length} bars\n`);

  const config = { startingEquity: 10_000, feeBps: 10, slippageBps: 1, seed };
  const risk = { maxDrawdownKill: 0.3, maxPositionSize: 1.0 };

  process.stderr.write(
    `Running ${agent.name ?? "unnamed"} on ${bars.length} bars (seed=${seed})...\n`,
  );

  const { scorecard, fills, violations, equityCurve } = await runBacktest({
    agent,
    bars,
    config,
    risk,
    manifest: {
      agentbenchVersion: VERSION,
      symbol,
      granularity,
      source: manifestSource,
      bars: bars.length,
      firstBarTime: bars[0]?.time ?? 0,
      lastBarTime: bars[bars.length - 1]?.time ?? 0,
      datasetSha256: hashDataset(bars),
    },
  });

  emitReport(scorecard, fills, equityCurve, outDir);
  // Snapshot the exact live candles next to the report so verify can re-derive
  // the dataset hash, recompute the ledger and replay on the same data.
  if (rawSnapshot) {
    writeFileSync(resolve(outDir, "candles.json"), JSON.stringify(rawSnapshot), "utf8");
  }
  process.stdout.write(formatScorecardSummary(scorecard, outDir));

  if (violations.length > 0) {
    process.stdout.write(`\nViolations:\n`);
    for (const v of violations) {
      process.stdout.write(`  [${v.action}] ${v.rule}: ${v.detail}\n`);
    }
  }
}

/** Load and validate a scorecard JSON file. Returns null and reports on error. */
function readScorecard(path: string, cmd: string): Scorecard | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(path), "utf8"));
    return ScorecardSchema.parse(raw);
  } catch (err) {
    process.stderr.write(`agentbench ${cmd}: could not read scorecard ${path}: ${String(err)}\n`);
    return null;
  }
}

async function cmdReport(opts: CliArgs): Promise<void> {
  const file = opts.args[0];
  if (!file) {
    process.stderr.write("agentbench report: a scorecard JSON path is required\n");
    process.exitCode = 1;
    return;
  }
  const scorecard = readScorecard(file, "report");
  if (!scorecard) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(formatScorecardSummary(scorecard));
}

function fmtNullable(n: number | null): string {
  return n === null ? "n/a" : n.toFixed(2);
}

/** A short label for a scorecard path: its parent dir plus the file name, so
 * two runs whose files are both named scorecard.json stay distinguishable. */
function runLabel(p: string): string {
  return `${basename(dirname(resolve(p)))}/${basename(p)}`;
}

async function cmdCompare(opts: CliArgs): Promise<void> {
  const [fileA, fileB] = opts.args;
  if (!fileA || !fileB) {
    process.stderr.write("agentbench compare: two scorecard JSON paths are required\n");
    process.exitCode = 1;
    return;
  }
  const a = readScorecard(fileA, "compare");
  const b = readScorecard(fileB, "compare");
  if (!a || !b) {
    process.exitCode = 1;
    return;
  }

  const rows: Array<[string, string, string]> = [
    ["Agent", a.agent, b.agent],
    ["Return %", a.metrics.totalReturnPct.toFixed(2), b.metrics.totalReturnPct.toFixed(2)],
    ["Max DD %", a.metrics.maxDrawdownPct.toFixed(2), b.metrics.maxDrawdownPct.toFixed(2)],
    ["Sharpe", a.metrics.sharpe.toFixed(2), b.metrics.sharpe.toFixed(2)],
    ["Sortino", fmtNullable(a.metrics.sortino), fmtNullable(b.metrics.sortino)],
    ["Win Rate %", a.metrics.winRatePct.toFixed(1), b.metrics.winRatePct.toFixed(1)],
    ["Profit Fact", fmtNullable(a.metrics.profitFactor), fmtNullable(b.metrics.profitFactor)],
    ["Trades", String(a.metrics.totalTrades), String(b.metrics.totalTrades)],
    ["Violations", String(a.metrics.violations), String(b.metrics.violations)],
  ];

  const labelA = runLabel(fileA);
  const labelB = runLabel(fileB);
  const w0 = Math.max(...rows.map((r) => r[0].length), "Metric".length);
  const w1 = Math.max(...rows.map((r) => r[1].length), labelA.length);
  const w2 = Math.max(...rows.map((r) => r[2].length), labelB.length);

  const line = (c0: string, c1: string, c2: string): string =>
    `${c0.padEnd(w0)}  ${c1.padStart(w1)}  ${c2.padStart(w2)}\n`;

  process.stdout.write(line("Metric", labelA, labelB));
  process.stdout.write(`${"-".repeat(w0)}  ${"-".repeat(w1)}  ${"-".repeat(w2)}\n`);
  for (const [k, va, vb] of rows) {
    process.stdout.write(line(k, va, vb));
  }
}

const CHECK_TAG: Record<CheckStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
};

async function cmdVerify(opts: CliArgs): Promise<void> {
  const target = opts.args[0];
  if (!target) {
    process.stderr.write(
      "agentbench verify: a report directory or scorecard.json path is required\n",
    );
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await verifyReport(target);
  } catch (err) {
    process.stderr.write(`agentbench verify: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\nVerifying ${result.target}\n`);
  process.stdout.write(`Agent:    ${result.agent}\n\n`);
  for (const c of result.checks) {
    process.stdout.write(`  [${CHECK_TAG[c.status]}] ${c.name.padEnd(9)} ${c.detail}\n`);
    for (const d of c.diffs ?? []) {
      process.stdout.write(
        `           · ${d.field}: claimed ${d.claimed}, recomputed ${d.recomputed}\n`,
      );
    }
  }

  const anyFail = result.checks.some((c) => c.status === "fail");
  if (result.pass) {
    process.stdout.write("\nVERIFIED. The numbers were recomputed from the ledger and they match\n");
  } else if (anyFail) {
    process.stdout.write("\nFAILED. See the checks above\n");
  } else {
    // No check failed, but no substantive recompute (ledger or replay) ran, so
    // the claim could not actually be checked. Not a pass.
    process.stdout.write(
      "\nUNVERIFIABLE. Nothing failed but no ledger or replay check ran, " +
        "so the numbers were never independently recomputed. Point verify at a full " +
        "report directory of a built-in or fixture-backed run.\n",
    );
  }
  if (!result.pass) process.exitCode = 1;
}

export {
  parseArgs,
  helpText,
  resolveAgent,
  formatScorecardSummary,
  cmdRun,
  cmdReport,
  cmdCompare,
  cmdVerify,
  main,
};

/**
 * True when this module is the process entry point. Compares realpaths so it
 * still matches when launched through the `node_modules/.bin/agentbench`
 * symlink, and stays false when imported by the test runner.
 */
function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`agentbench: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
