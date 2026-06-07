#!/usr/bin/env node
/**
 * AgentBench MCP server.
 *
 * Exposes AgentBench over the Model Context Protocol so an agent inside Claude,
 * Cursor or any MCP client can backtest a strategy and read back a scorecard,
 * without leaving its tool loop. This is the "agent scores itself" path.
 *
 * Two tools:
 *   `agentbench_run`    — backtest a built-in strategy over a committed candle
 *                         fixture and return the scorecard. Pass `outDir` to also
 *                         persist the full report (scorecard.json, trades.jsonl,
 *                         equity.csv, scorecard.html) so the run leaves artifacts
 *                         that can be independently verified.
 *   `agentbench_verify` — run the four verify checks (integrity, dataset, ledger,
 *                         replay) against a report directory or scorecard.json.
 *                         This is the "agents grading agents" path.
 *
 * The whole thing is credential-free and deterministic.
 *
 * SDK usage mirrors the official bitget-mcp server so it feels native to the
 * ecosystem: Server + ListTools/CallTool handlers + stdio transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { runBacktest } from "./engine/backtest.js";
import { emitReport, hashDataset } from "./report/emit.js";
import { computeScorecardSha256 } from "./report/hash.js";
import { verifyReport } from "./verify.js";
import { loadFixture } from "./sources/fixture-source.js";
import { GRANULARITIES, type Granularity } from "./types.js";
import { STRATEGIES } from "./strategies/registry.js";
import { VERSION } from "./version.js";

const SERVER_NAME = "agentbench-mcp";

const RUN_TOOL: Tool = {
  name: "agentbench_run",
  description:
    "Backtest a Bitget trading strategy on real candle data and return a scorecard " +
    "(return, drawdown, Sharpe, win rate, exposure, trades). Runs against committed " +
    "fixtures with no API keys and no real funds. Deterministic for a given seed.",
  inputSchema: {
    type: "object",
    properties: {
      strategy: {
        type: "string",
        enum: Object.keys(STRATEGIES),
        description: "Which built-in strategy to backtest.",
      },
      symbol: {
        type: "string",
        description: "Trading pair, e.g. BTCUSDT. Must have a committed fixture.",
      },
      granularity: {
        type: "string",
        enum: [...GRANULARITIES],
        description: "Candle timeframe, e.g. 4h.",
      },
      seed: {
        type: "number",
        description: "Deterministic seed (default 42).",
      },
      outDir: {
        type: "string",
        description:
          "Optional directory to persist the full report into (scorecard.json, " +
          "trades.jsonl, equity.csv, scorecard.html). Persisted runs can be " +
          "independently checked with agentbench_verify.",
      },
    },
    required: ["strategy", "symbol", "granularity"],
    additionalProperties: false,
  },
  annotations: {
    // Writes report files when outDir is provided, so it is not read-only.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const VERIFY_TOOL: Tool = {
  name: "agentbench_verify",
  description:
    "Independently verify an AgentBench report: recompute the scorecard content " +
    "hash, re-hash the candle dataset, recompute every headline metric from the " +
    "trade ledger and equity curve, and replay built-in agents from the manifest. " +
    "Returns pass/fail/skip per check. Use this to check a trading claim instead " +
    "of trusting it.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Path to a report directory or a scorecard.json file.",
      },
    },
    required: ["target"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
  };
}

export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [RUN_TOOL, VERIFY_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (request.params.name === RUN_TOOL.name) return handleRun(args);
    if (request.params.name === VERIFY_TOOL.name) return handleVerify(args);
    return fail(`Unknown tool: ${request.params.name}`);
  });

  return server;
}

async function handleRun(args: Record<string, unknown>): Promise<CallToolResult> {
  const strategyName = String(args["strategy"] ?? "");
  const symbol = String(args["symbol"] ?? "");
  const granularity = String(args["granularity"] ?? "") as Granularity;
  const seed = typeof args["seed"] === "number" ? (args["seed"] as number) : 42;
  const outDir = typeof args["outDir"] === "string" ? (args["outDir"] as string) : undefined;

  const agent = STRATEGIES[strategyName];
  if (!agent) return fail(`Unknown strategy "${strategyName}". Available: ${Object.keys(STRATEGIES).join(", ")}`);
  if (!GRANULARITIES.includes(granularity)) return fail(`Unknown granularity "${granularity}".`);

  let bars;
  try {
    bars = loadFixture(symbol, granularity);
  } catch (err) {
    return fail(`No fixture for ${symbol} ${granularity}: ${String(err)}`);
  }

  try {
    const { scorecard, fills, equityCurve } = await runBacktest({
      agent,
      bars,
      config: { startingEquity: 10_000, feeBps: 10, slippageBps: 1, seed },
      risk: { maxDrawdownKill: 0.3, maxPositionSize: 1 },
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

    // Persist on request so an agent-driven run leaves verifiable artifacts.
    if (outDir) emitReport(scorecard, fills, equityCurve, outDir);

    return ok({
      ...scorecard,
      scorecardSha256: computeScorecardSha256(scorecard),
      ...(outDir ? { reportDir: outDir } : {}),
    });
  } catch (err) {
    return fail(`Backtest failed: ${String(err)}`);
  }
}

async function handleVerify(args: Record<string, unknown>): Promise<CallToolResult> {
  const target = String(args["target"] ?? "");
  if (!target) return fail("agentbench_verify requires a target path (report dir or scorecard.json).");
  try {
    return ok(await verifyReport(target));
  } catch (err) {
    return fail(`Verify failed: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: String(err) }, null, 2)}\n`);
  process.exitCode = 1;
});
