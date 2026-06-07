import { describe, it, expect } from "vitest";
import { computeScorecardSha256, canonicalJson } from "../src/report/hash.js";
import type { Scorecard } from "../src/types.js";

/**
 * The scorecard content hash is what makes the artifact self-certifying: it is a
 * SHA256 over {agent, metrics, manifest} so any edit to the file changes it.
 * These tests pin the properties verify relies on: determinism, key-order
 * independence, exclusion of the hash field itself, and sensitivity to tampering.
 */

const base: Scorecard = {
  agent: "rsi-meanrev",
  metrics: {
    startingEquity: 10_000,
    finalEquity: 9899.96,
    totalReturnPct: -1.0004,
    maxDrawdownPct: 2.63,
    sharpe: -0.94,
    sortino: -0.64,
    winRatePct: 78.57,
    profitFactor: 1.24,
    totalTrades: 14,
    totalFees: 21.6566,
    turnover: 1.23,
    exposurePct: 30,
    violations: 0,
  },
  manifest: {
    agentbenchVersion: "0.2.0",
    schemaVersion: 1,
    symbol: "BTCUSDT",
    granularity: "4h",
    source: "fixture",
    bars: 930,
    firstBarTime: 1767240000000,
    lastBarTime: 1780617600000,
    datasetSha256: "3476016e55d868ed6c05e442416301be73f6dd8c120b5f9a2d8c41319f3ec6cc",
    engine: { startingEquity: 10_000, feeBps: 10, slippageBps: 1, seed: 42 },
    risk: { maxDrawdownKill: 0.3, maxPositionSize: 1 },
  },
};

describe("canonicalJson", () => {
  it("sorts object keys recursively so insertion order does not matter", () => {
    const a = canonicalJson({ b: 1, a: { y: 2, x: 3 } });
    const b = canonicalJson({ a: { x: 3, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":3,"y":2},"b":1}');
  });

  it("preserves null and array order", () => {
    expect(canonicalJson({ p: null, q: [3, 1, 2] })).toBe('{"p":null,"q":[3,1,2]}');
  });
});

describe("computeScorecardSha256", () => {
  it("is a 64-char hex digest", () => {
    expect(computeScorecardSha256(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same content", () => {
    expect(computeScorecardSha256(base)).toBe(computeScorecardSha256(base));
  });

  it("ignores a scorecardSha256 field already present on the object", () => {
    const withHash = { ...base, scorecardSha256: "deadbeef" } as Scorecard;
    expect(computeScorecardSha256(withHash)).toBe(computeScorecardSha256(base));
  });

  it("changes when any metric is tampered", () => {
    const tampered = { ...base, metrics: { ...base.metrics, totalReturnPct: 999 } };
    expect(computeScorecardSha256(tampered)).not.toBe(computeScorecardSha256(base));
  });

  it("changes when the manifest dataset hash is swapped", () => {
    const tampered = {
      ...base,
      manifest: { ...base.manifest, datasetSha256: "0".repeat(64) },
    };
    expect(computeScorecardSha256(tampered)).not.toBe(computeScorecardSha256(base));
  });
});
