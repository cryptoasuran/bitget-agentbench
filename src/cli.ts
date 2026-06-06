#!/usr/bin/env node
/**
 * agentbench CLI.
 *
 * Usage:
 *   agentbench run (--strategy <name> | --agent <file>) --symbol BTCUSDT --tf 4h
 *                  [--seed 42] [--out ./report]
 *   agentbench report <scorecard.json>
 *   agentbench compare <a.json> <b.json>
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixture } from "./sources/fixture-source.js";
import { runBacktest } from "./engine/backtest.js";
import { emitReport, hashDataset } from "./report/emit.js";
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
      "agentbench — backtest and score Bitget trading agents",
      "",
      "Usage:",
      "  agentbench run (--strategy <name> | --agent <file>) --symbol <SYM>",
      "               --tf <1h|4h|1day|...> [--seed <n>] [--out <dir>]",
      "  agentbench report <scorecard.json>",
      "  agentbench compare <a.json> <b.json>",
      "",
      `Built-in strategies: ${listStrategies().join(", ")}`,
      "",
      "Examples:",
      "  agentbench run --strategy sma-crossover --symbol BTCUSDT --tf 4h --out ./r",
      "  agentbench run --agent ./my-agent.ts --symbol ETHUSDT --tf 4h --seed 99",
      "  agentbench report ./r/scorecard.json",
      "  agentbench compare ./a/scorecard.json ./b/scorecard.json",
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

  process.stderr.write(`Loading fixture ${symbol} ${granularity}...\n`);
  const bars = loadFixture(symbol, granularity);
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
      source: "fixture",
      bars: bars.length,
      firstBarTime: bars[0]?.time ?? 0,
      lastBarTime: bars[bars.length - 1]?.time ?? 0,
      datasetSha256: hashDataset(bars),
    },
  });

  emitReport(scorecard, fills, equityCurve, outDir);
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

export {
  parseArgs,
  helpText,
  resolveAgent,
  formatScorecardSummary,
  cmdRun,
  cmdReport,
  cmdCompare,
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
