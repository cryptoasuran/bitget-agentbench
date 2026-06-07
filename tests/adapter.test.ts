import { describe, it, expect } from "vitest";
import { fromAgentHub, toOrder } from "../src/adapters/agent-hub.js";
import type { AgentHubOrder } from "../src/adapters/agent-hub.js";
import { runBacktest } from "../src/engine/backtest.js";
import { loadFixture } from "../src/sources/fixture-source.js";
import { hashDataset } from "../src/report/emit.js";
import { VERSION } from "../src/version.js";
import type { Bar, BarContext } from "../src/types.js";

/**
 * The Agent Hub adapter is the proof that an agent built against
 * `spot_place_order` drops into AgentBench without a rewrite. These tests pin
 * the shape mapping and that a wrapped decision function runs end to end.
 */

describe("toOrder", () => {
  it("maps a spot_place_order shape straight onto an engine Order", () => {
    const o = toOrder({ symbol: "BTCUSDT", side: "buy", orderType: "limit", price: 50_000, size: 0.5 });
    expect(o).toEqual({ symbol: "BTCUSDT", side: "buy", orderType: "limit", price: 50_000, size: 0.5 });
  });

  it("defaults orderType to market, matching the tool", () => {
    expect(toOrder({ symbol: "ETHUSDT", side: "sell", size: 1 }).orderType).toBe("market");
  });

  it("rejects an invalid order (zero size) via the engine schema", () => {
    expect(() => toOrder({ symbol: "BTCUSDT", side: "buy", size: 0 } as AgentHubOrder)).toThrow();
  });
});

describe("fromAgentHub", () => {
  it("wraps a decision function and backtests it to a scorecard", async () => {
    // An Agent-Hub-style agent: buy once, hold. Decision returns spot_place_order calls.
    let bought = false;
    const agent = fromAgentHub("hub-buy-and-hold", (_bar: Bar, ctx: BarContext): AgentHubOrder[] => {
      if (!bought && ctx.position.size === 0) {
        bought = true;
        return [{ symbol: "BTCUSDT", side: "buy", orderType: "market", size: 0.01 }];
      }
      return [];
    });

    const bars = loadFixture("BTCUSDT", "4h");
    const { scorecard, fills } = await runBacktest({
      agent,
      bars,
      config: { startingEquity: 10_000, feeBps: 10, slippageBps: 1, seed: 42 },
      risk: { maxDrawdownKill: 0.3, maxPositionSize: 1 },
      manifest: {
        agentbenchVersion: VERSION,
        symbol: "BTCUSDT",
        granularity: "4h",
        source: "fixture",
        bars: bars.length,
        firstBarTime: bars[0]!.time,
        lastBarTime: bars[bars.length - 1]!.time,
        datasetSha256: hashDataset(bars),
      },
    });

    expect(scorecard.agent).toBe("hub-buy-and-hold");
    expect(fills.length).toBe(1);
    expect(fills[0]!.side).toBe("buy");
  });
});
