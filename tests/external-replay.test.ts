import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest } from "../src/engine/backtest.js";
import { emitReport, hashDataset } from "../src/report/emit.js";
import { loadFixture } from "../src/sources/fixture-source.js";
import { VERSION } from "../src/version.js";
import { verifyReport } from "../src/verify.js";
import extAgent from "./fixtures/ext-agent.mjs";

/**
 * verify can replay ANY strategy, not just built-ins, when the user supplies the
 * agent file. These tests prove: with --agent, replay runs and passes on a clean
 * external-agent report and fails on a tampered one; without it, replay honestly
 * skips and verify never executes the agent on its own.
 */

const AGENT_PATH = resolve(fileURLToPath(new URL("./fixtures/ext-agent.mjs", import.meta.url)));

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentbench-extreplay-"));
  const bars = loadFixture("BTCUSDT", "4h");
  const { scorecard, fills, equityCurve } = await runBacktest({
    agent: extAgent,
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
  emitReport(scorecard, fills, equityCurve, dir);
});

function check(r: { checks: Array<{ name: string; status: string }> }, name: string) {
  return r.checks.find((c) => c.name === name)!;
}

function copy(): string {
  const d = mkdtempSync(join(tmpdir(), "agentbench-extreplay-"));
  cpSync(dir, d, { recursive: true });
  return d;
}

describe("verify --agent: replay for any strategy", () => {
  it("skips replay by default for an external agent, and does not run it", async () => {
    const r = await verifyReport(dir);
    expect(check(r, "replay").status).toBe("skip");
    expect(check(r, "ledger").status).toBe("pass");
    expect(r.pass).toBe(true); // ledger carries it
  });

  it("replays and passes when the agent file is supplied", async () => {
    const r = await verifyReport(dir, { agentPath: AGENT_PATH });
    expect(check(r, "replay").status).toBe("pass");
    expect(check(r, "ledger").status).toBe("pass");
    expect(r.pass).toBe(true);
  });

  it("fails the ledger when a trade is doctored; replay still re-runs the agent", async () => {
    const d = copy();
    const lines = readFileSync(join(d, "trades.jsonl"), "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]!);
    first.price = first.price * 1.5; // fabricate a better fill in the recorded ledger
    lines[0] = JSON.stringify(first);
    writeFileSync(join(d, "trades.jsonl"), lines.join("\n") + "\n");
    const r = await verifyReport(d, { agentPath: AGENT_PATH });
    expect(check(r, "ledger").status).toBe("fail"); // recorded ledger no longer supports the metrics
    expect(check(r, "replay").status).toBe("pass"); // replay re-derives trades from the agent itself
    expect(r.pass).toBe(false);
  });

  it("fails replay when the claimed metrics do not match what the agent produces", async () => {
    const d = copy();
    const sc = JSON.parse(readFileSync(join(d, "scorecard.json"), "utf8"));
    sc.metrics.totalReturnPct = 123; // claim a return the agent never made
    delete sc.scorecardSha256;
    writeFileSync(join(d, "scorecard.json"), JSON.stringify(sc, null, 2));
    const r = await verifyReport(d, { agentPath: AGENT_PATH });
    expect(check(r, "replay").status).toBe("fail");
    expect(r.pass).toBe(false);
  });

  it("skips (does not throw) when the supplied agent path is bad", async () => {
    const r = await verifyReport(dir, { agentPath: "/no/such/agent.mjs" });
    expect(check(r, "replay").status).toBe("skip");
  });
});
