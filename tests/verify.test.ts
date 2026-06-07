import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBacktest } from "../src/engine/backtest.js";
import { emitReport } from "../src/report/emit.js";
import { loadFixture } from "../src/sources/fixture-source.js";
import { hashDataset } from "../src/report/emit.js";
import { computeScorecardSha256 } from "../src/report/hash.js";
import { STRATEGIES } from "../src/strategies/registry.js";
import { VERSION } from "../src/version.js";
import { verifyReport } from "../src/verify.js";

/**
 * verify is the centerpiece. These tests prove it has teeth: a clean report
 * passes every check, and each kind of tampering fails the specific check that
 * is supposed to catch it. The decisive case is "edit a number AND re-stamp the
 * content hash" — integrity then passes, but the independent recompute from the
 * ledger (and the replay) still fail, so a forger cannot launder a fake.
 */

let goodDir: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbench-verify-"));
  const bars = loadFixture("BTCUSDT", "4h");
  const { scorecard, fills, equityCurve } = await runBacktest({
    agent: STRATEGIES["rsi-meanrev"]!,
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
  goodDir = dir;
});

function copyReport(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbench-verify-"));
  cpSync(goodDir, dir, { recursive: true });
  return dir;
}

function check(result: { checks: Array<{ name: string; status: string }> }, name: string) {
  return result.checks.find((c) => c.name === name)!;
}

describe("verifyReport — clean report", () => {
  it("passes overall with all four checks passing", async () => {
    const r = await verifyReport(goodDir);
    expect(r.pass).toBe(true);
    expect(check(r, "integrity").status).toBe("pass");
    expect(check(r, "dataset").status).toBe("pass");
    expect(check(r, "ledger").status).toBe("pass");
    expect(check(r, "replay").status).toBe("pass");
  });

  it("accepts a path to scorecard.json directly, not just the directory", async () => {
    const r = await verifyReport(join(goodDir, "scorecard.json"));
    expect(r.pass).toBe(true);
  });
});

describe("verifyReport — tampering is caught", () => {
  it("fails integrity when a metric is edited without re-hashing", async () => {
    const dir = copyReport();
    const sc = JSON.parse(readFileSync(join(dir, "scorecard.json"), "utf8"));
    sc.metrics.totalReturnPct = 999;
    writeFileSync(join(dir, "scorecard.json"), JSON.stringify(sc, null, 2));
    const r = await verifyReport(dir);
    expect(r.pass).toBe(false);
    expect(check(r, "integrity").status).toBe("fail");
  });

  it("still fails when the metric is edited AND the hash is re-stamped (the forger case)", async () => {
    const dir = copyReport();
    const sc = JSON.parse(readFileSync(join(dir, "scorecard.json"), "utf8"));
    sc.metrics.totalReturnPct = 999;
    // Re-stamp a valid content hash over the doctored content.
    delete sc.scorecardSha256;
    sc.scorecardSha256 = computeScorecardSha256(sc);
    writeFileSync(join(dir, "scorecard.json"), JSON.stringify(sc, null, 2));
    const r = await verifyReport(dir);
    expect(r.pass).toBe(false);
    expect(check(r, "integrity").status).toBe("pass"); // hash now self-consistent
    expect(check(r, "ledger").status).toBe("fail"); // recompute exposes the lie
    expect(check(r, "replay").status).toBe("fail"); // and so does the replay
  });

  it("fails dataset when the claimed dataset hash is swapped (and re-stamped)", async () => {
    const dir = copyReport();
    const sc = JSON.parse(readFileSync(join(dir, "scorecard.json"), "utf8"));
    sc.manifest.datasetSha256 = "0".repeat(64);
    delete sc.scorecardSha256;
    sc.scorecardSha256 = computeScorecardSha256(sc);
    writeFileSync(join(dir, "scorecard.json"), JSON.stringify(sc, null, 2));
    const r = await verifyReport(dir);
    expect(check(r, "dataset").status).toBe("fail");
    expect(r.pass).toBe(false);
  });

  it("fails ledger when the trade ledger is altered", async () => {
    const dir = copyReport();
    const lines = readFileSync(join(dir, "trades.jsonl"), "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]!);
    first.realizedPnl = first.realizedPnl + 5000; // fabricate a profit
    lines[0] = JSON.stringify(first);
    writeFileSync(join(dir, "trades.jsonl"), lines.join("\n") + "\n");
    const r = await verifyReport(dir);
    expect(check(r, "ledger").status).toBe("fail");
    expect(r.pass).toBe(false);
  });
});

describe("verifyReport — honest skips", () => {
  it("skips replay for an external (non-built-in) agent but still checks the ledger", async () => {
    const dir = copyReport();
    const sc = JSON.parse(readFileSync(join(dir, "scorecard.json"), "utf8"));
    sc.agent = "my-private-agent";
    delete sc.scorecardSha256;
    sc.scorecardSha256 = computeScorecardSha256(sc);
    writeFileSync(join(dir, "scorecard.json"), JSON.stringify(sc, null, 2));
    const r = await verifyReport(dir);
    expect(check(r, "replay").status).toBe("skip");
    expect(check(r, "ledger").status).toBe("pass");
    expect(check(r, "integrity").status).toBe("pass");
    expect(r.pass).toBe(true); // ledger carries it (a substantive recompute passed)
  });

  it("skips integrity for a pre-0.2.0 scorecard with no content hash", async () => {
    const dir = copyReport();
    const sc = JSON.parse(readFileSync(join(dir, "scorecard.json"), "utf8"));
    delete sc.scorecardSha256;
    writeFileSync(join(dir, "scorecard.json"), JSON.stringify(sc, null, 2));
    const r = await verifyReport(dir);
    expect(check(r, "integrity").status).toBe("skip");
  });
});

describe("verifyReport — a SKIP is never a free pass (the forger's escape)", () => {
  it("does NOT report VERIFIED when no substantive check ran", async () => {
    // The attack: invent metrics, mark source non-fixture (dataset skips), name a
    // non-built-in agent (replay skips), self-stamp a valid content hash, and point
    // verify at a bare scorecard.json with no ledger files beside it (ledger skips).
    // Only integrity runs and passes. This must NOT be VERIFIED.
    const dir = mkdtempSync(join(tmpdir(), "agentbench-verify-"));
    const sc = JSON.parse(readFileSync(join(goodDir, "scorecard.json"), "utf8"));
    sc.agent = "totally-made-up-bot";
    sc.metrics.totalReturnPct = 4242; // pure fiction
    sc.manifest.source = "candles";
    delete sc.scorecardSha256;
    sc.scorecardSha256 = computeScorecardSha256(sc);
    writeFileSync(join(dir, "scorecard.json"), JSON.stringify(sc, null, 2));

    const r = await verifyReport(join(dir, "scorecard.json"));
    expect(check(r, "integrity").status).toBe("pass");
    expect(check(r, "dataset").status).toBe("skip");
    expect(check(r, "ledger").status).toBe("skip");
    expect(check(r, "replay").status).toBe("skip");
    expect(r.pass).toBe(false); // no substantive recompute ran -> not verified
  });

  it("a clean built-in report stays VERIFIED (replay is substantive)", async () => {
    const r = await verifyReport(goodDir);
    expect(r.pass).toBe(true);
  });
});

describe("verifyReport — a live (source=candles) run verifies from its snapshot", () => {
  // Build a report whose candles came from "live": emit the standard report, mark
  // the manifest source as candles, and drop a candles.json snapshot beside it.
  async function makeLiveReport(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "agentbench-verify-live-"));
    const bars = loadFixture("BTCUSDT", "4h");
    const { scorecard, fills, equityCurve } = await runBacktest({
      agent: STRATEGIES["rsi-meanrev"]!,
      bars,
      config: { startingEquity: 10_000, feeBps: 10, slippageBps: 1, seed: 42 },
      risk: { maxDrawdownKill: 0.3, maxPositionSize: 1 },
      manifest: {
        agentbenchVersion: VERSION,
        symbol: "BTCUSDT",
        granularity: "4h",
        source: "candles", // pretend these came from the live endpoint
        bars: bars.length,
        firstBarTime: bars[0]!.time,
        lastBarTime: bars[bars.length - 1]!.time,
        datasetSha256: hashDataset(bars),
      },
    });
    emitReport(scorecard, fills, equityCurve, dir);
    // snapshot the exact candles in the Bitget raw shape, like the CLI does
    const rawRows = bars.map((b) => [
      String(b.time), String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), "0", "0",
    ]);
    writeFileSync(join(dir, "candles.json"), JSON.stringify({ code: "00000", msg: "success", requestTime: 0, data: rawRows }));
    return dir;
  }

  it("passes all four checks when the candles.json snapshot is present", async () => {
    const dir = await makeLiveReport();
    const r = await verifyReport(dir);
    expect(check(r, "dataset").status).toBe("pass");
    expect(check(r, "ledger").status).toBe("pass");
    expect(check(r, "replay").status).toBe("pass");
    expect(r.pass).toBe(true);
  });

  it("skips dataset/ledger/replay (not throws) when the snapshot is missing", async () => {
    const dir = await makeLiveReport();
    rmSync(join(dir, "candles.json"));
    const r = await verifyReport(dir);
    expect(check(r, "dataset").status).toBe("skip");
    expect(check(r, "replay").status).toBe("skip");
    expect(r.pass).toBe(false); // no substantive recompute could run
  });
});

describe("verifyReport — malformed inputs fail cleanly, never throw", () => {
  it("fails (not throws) on a missing scorecard.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbench-verify-"));
    const r = await verifyReport(dir);
    expect(r.pass).toBe(false);
    expect(check(r, "integrity").status).toBe("fail");
  });

  it("fails (not throws) on malformed scorecard JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbench-verify-"));
    writeFileSync(join(dir, "scorecard.json"), "{ not valid json");
    const r = await verifyReport(dir);
    expect(r.pass).toBe(false);
  });

  it("fails the ledger check (not throws) on a corrupt trades.jsonl line", async () => {
    const dir = copyReport();
    writeFileSync(join(dir, "trades.jsonl"), "this is not json\n");
    const r = await verifyReport(dir);
    expect(check(r, "ledger").status).toBe("fail");
  });

  it("fails the ledger check (not throws) on non-numeric equity rows", async () => {
    const dir = copyReport();
    writeFileSync(join(dir, "equity.csv"), "equity\n10000\nNaNoops\n10010\n");
    const r = await verifyReport(dir);
    expect(check(r, "ledger").status).toBe("fail");
  });
});
