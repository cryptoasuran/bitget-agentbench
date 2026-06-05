import { describe, it, expect } from "vitest";
import { createServer } from "../src/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Drive the MCP server's request handlers directly (no transport) so the tool
 * contract is covered in CI without spawning a process.
 */

// Reach into the server's registered handlers via a tiny in-process client.
// The SDK exposes setRequestHandler; we re-create a server and call the handlers
// through a connected pair would need a transport, so instead we test the
// handler wiring by listing tools and calling the tool through a minimal stub.

describe("agentbench MCP server", () => {
  it("creates a server without throwing", () => {
    const server = createServer();
    expect(server).toBeTruthy();
  });

  it("exposes exactly the agentbench_run tool", async () => {
    const server = createServer();
    // Access the internal handler map through a request round-trip.
    const handler = (server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    })._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    expect(handler).toBeTypeOf("function");
    const result = (await handler!({
      method: "tools/list",
      params: {},
    })) as { tools: { name: string }[] };
    expect(result.tools.map((t) => t.name)).toEqual(["agentbench_run"]);
  });

  it("agentbench_run returns a scorecard for a valid request", async () => {
    const server = createServer();
    const handler = (server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    })._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const result = (await handler!({
      method: "tools/call",
      params: {
        name: "agentbench_run",
        arguments: { strategy: "rsi-meanrev", symbol: "BTCUSDT", granularity: "4h", seed: 42 },
      },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBeFalsy();
    const scorecard = JSON.parse(result.content[0]!.text);
    expect(scorecard.agent).toBe("rsi-meanrev");
    expect(typeof scorecard.metrics.totalReturnPct).toBe("number");
    expect(scorecard.metrics.totalTrades).toBeGreaterThan(0);
  });

  it("rejects an unknown strategy with an error result", async () => {
    const server = createServer();
    const handler = (server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    })._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const result = (await handler!({
      method: "tools/call",
      params: {
        name: "agentbench_run",
        arguments: { strategy: "does-not-exist", symbol: "BTCUSDT", granularity: "4h" },
      },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown strategy");
  });
});
