#!/usr/bin/env node
/**
 * agentbench CLI.
 *
 * Usage:
 *   agentbench run --agent <file> --symbol BTCUSDT --tf 1h [--seed 42] [--out ./report]
 *   agentbench report <scorecard.json>
 *   agentbench compare <a.json> <b.json>
 */

import { resolve } from "node:path";
import { loadFixture } from "./sources/fixture-source.js";
import { runBacktest } from "./engine/backtest.js";
import { emitReport, hashDataset } from "./report/emit.js";
import type { Granularity, StrategyAgent } from "./types.js";

const PKG_VERSION = "0.1.0";

interface CliArgs {
  cmd: string;
  agentPath?: string;
  symbol?: string;
  granularity?: Granularity;
  seed?: number;
  outDir?: string;
  args: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const result: Partial<CliArgs> = { args: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case "--agent": result.agentPath = argv[++i]; break;
      case "--symbol": result.symbol = argv[++i]; break;
      case "--tf": result.granularity = argv[++i] as Granularity; break;
      case "--seed": result.seed = Number(argv[++i]); break;
      case "--out": result.outDir = argv[++i]; break;
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

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  if (opts.cmd === "help" || !opts.cmd) {
    process.stdout.write(
      [
        "agentbench — backtest and score Bitget trading agents",
        "",
        "Usage:",
        "  agentbench run --agent <file> --symbol <SYM> --tf <1h|4h|1day|...>",
        "               [--seed <n>] [--out <dir>]",
        "  agentbench report <scorecard.json>",
        "  agentbench compare <a.json> <b.json>",
        "",
        "Examples:",
        "  agentbench run --agent ./sma.ts --symbol BTCUSDT --tf 1h --out ./r",
        "  agentbench run --agent ./my-agent.ts --symbol ETHUSDT --tf 4h --seed 99",
        "",
        `version ${PKG_VERSION}`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (opts.cmd === "run") {
    await cmdRun(opts);
  } else if (opts.cmd === "report") {
    await cmdReport(opts);
  } else {
    process.stderr.write(`agentbench: unknown command "${opts.cmd}"\n`);
    process.exitCode = 1;
  }
}

async function cmdRun(opts: CliArgs): Promise<void> {
  const agentPath = opts.agentPath;
  const symbol = opts.symbol ?? "BTCUSDT";
  const granularity = opts.granularity ?? "1h";
  const seed = opts.seed ?? 1;
  const outDir = opts.outDir ?? "./agentbench-report";

  if (!agentPath) {
    process.stderr.write("agentbench run: --agent <file> is required\n");
    process.exitCode = 1;
    return;
  }

  // Load agent module dynamically
  const absPath = resolve(agentPath);
  let agentModule: unknown;
  try {
    agentModule = await import(absPath);
  } catch (err) {
    process.stderr.write(`agentbench: failed to load agent at ${absPath}: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const agent: StrategyAgent =
    (agentModule as Record<string, unknown>)?.default as StrategyAgent ||
    (agentModule as Record<string, unknown>)?.agent as StrategyAgent;

  if (!agent || typeof agent.onBar !== "function") {
    process.stderr.write(
      `agentbench: agent at ${absPath} must export a default { onBar(bar, ctx) } or named "agent"\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Load bars from fixture
  process.stderr.write(`Loading fixture ${symbol} ${granularity}...\n`);
  const bars = loadFixture(symbol, granularity);
  process.stderr.write(`Loaded ${bars.length} bars\n`);

  // Config
  const config = {
    startingEquity: 10_000,
    feeBps: 10,
    slippageBps: 1,
    seed,
  };

  const risk = {
    maxDrawdownKill: 0.3,
    maxPositionSize: 1.0,
  };

  process.stderr.write(
    `Running ${agent.name ?? "unnamed"} on ${bars.length} bars (seed=${seed})...\n`,
  );

  const { scorecard, fills, violations, equityCurve } = await runBacktest({
    agent,
    bars,
    config,
    risk,
    manifest: {
      agentbenchVersion: PKG_VERSION,
      symbol,
      granularity,
      source: "fixture",
      bars: bars.length,
      firstBarTime: bars[0]?.time ?? 0,
      lastBarTime: bars[bars.length - 1]?.time ?? 0,
      datasetSha256: hashDataset(bars),
    },
  });

  emitReport(scorecard, fills, equityCurve, outDir);

  // Quick summary to stdout
  process.stdout.write(
    [
      `Agent:       ${scorecard.agent}`,
      `Symbol:      ${scorecard.manifest.symbol} ${scorecard.manifest.granularity}`,
      `Bars:        ${scorecard.manifest.bars}`,
      `Equity:      ${scorecard.metrics.startingEquity} → ${scorecard.metrics.finalEquity.toFixed(2)}`,
      `Return:      ${scorecard.metrics.totalReturnPct.toFixed(2)}%`,
      `Max DD:      ${scorecard.metrics.maxDrawdownPct.toFixed(2)}%`,
      `Sharpe:      ${scorecard.metrics.sharpe.toFixed(2)}`,
      `Sortino:     ${scorecard.metrics.sortino === null ? "n/a" : scorecard.metrics.sortino.toFixed(2)}`,
      `Win Rate:    ${scorecard.metrics.winRatePct.toFixed(1)}%`,
      `Profit Fact: ${scorecard.metrics.profitFactor === null ? "n/a" : scorecard.metrics.profitFactor.toFixed(2)}`,
      `Trades:      ${scorecard.metrics.totalTrades}`,
      `Fees:        ${scorecard.metrics.totalFees.toFixed(4)}`,
      `Violations:  ${scorecard.metrics.violations}`,
      ``,
      `Report: ${outDir}/`,
    ].join("\n") + "\n",
  );

  if (violations.length > 0) {
    process.stdout.write(`\nViolations:\n`);
    for (const v of violations) {
      process.stdout.write(`  [${v.action}] ${v.rule}: ${v.detail}\n`);
    }
  }
}

async function cmdReport(_opts: CliArgs): Promise<void> {
  process.stderr.write("agentbench report: not yet implemented\n");
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`agentbench: ${String(err)}\n`);
  process.exitCode = 1;
});
