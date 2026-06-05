#!/usr/bin/env node
/**
 * AgentBench MCP server.
 *
 * Exposes AgentBench over the Model Context Protocol so an agent inside Claude,
 * Cursor or any MCP client can backtest a strategy and read back a scorecard,
 * without leaving its tool loop. This is the "agent scores itself" path.
 *
 * One tool: `agentbench_run`. It runs a built-in example strategy (or one named
 * by the caller) over a committed candle fixture and returns the metrics. The
 * whole thing is credential-free and deterministic.
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
import { hashDataset } from "./report/emit.js";
import { loadFixture } from "./sources/fixture-source.js";
import { GRANULARITIES, type Granularity, type StrategyAgent } from "./types.js";
import smaCrossover from "./strategies/sma-crossover.js";
import rsiMeanrev from "./strategies/rsi-meanrev.js";

const SERVER_NAME = "agentbench-mcp";
const SERVER_VERSION = "0.1.0";

/** Built-in strategies the MCP tool can run by name. */
const STRATEGIES: Record<string, StrategyAgent> = {
  "sma-crossover": smaCrossover,
  "rsi-meanrev": rsiMeanrev,
};

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
    },
    required: ["strategy", "symbol", "granularity"],
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
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [RUN_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== RUN_TOOL.name) {
      return fail(`Unknown tool: ${request.params.name}`);
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const strategyName = String(args["strategy"] ?? "");
    const symbol = String(args["symbol"] ?? "");
    const granularity = String(args["granularity"] ?? "") as Granularity;
    const seed = typeof args["seed"] === "number" ? (args["seed"] as number) : 42;

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
      const { scorecard } = await runBacktest({
        agent,
        bars,
        config: { startingEquity: 10_000, feeBps: 10, slippageBps: 1, seed },
        risk: { maxDrawdownKill: 0.3, maxPositionSize: 1 },
        manifest: {
          agentbenchVersion: SERVER_VERSION,
          symbol,
          granularity,
          source: "fixture",
          bars: bars.length,
          firstBarTime: bars[0]?.time ?? 0,
          lastBarTime: bars[bars.length - 1]?.time ?? 0,
          datasetSha256: hashDataset(bars),
        },
      });
      return ok(scorecard);
    } catch (err) {
      return fail(`Backtest failed: ${String(err)}`);
    }
  });

  return server;
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
