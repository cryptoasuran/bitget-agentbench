import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  cmdRun,
  cmdReport,
  cmdCompare,
  cmdVerify,
  resolveAgent,
  helpText,
} from "../src/cli.js";
import { VERSION } from "../src/version.js";
import type { Granularity } from "../src/types.js";

/**
 * The CLI module guards its auto-run, so importing it here does not execute
 * `main`. We drive the command functions directly.
 */

function tmpOut(): string {
  return mkdtempSync(join(tmpdir(), "agentbench-cli-"));
}

function runOpts(over: Record<string, unknown>) {
  return {
    cmd: "run",
    symbol: "BTCUSDT",
    granularity: "4h" as Granularity,
    seed: 42,
    args: [] as string[],
    ...over,
  };
}

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  return { writes, restore: () => spy.mockRestore() };
}

describe("version single source of truth", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("agentbench run --strategy", () => {
  it("resolves a built-in strategy and stamps the real version", async () => {
    const out = tmpOut();
    await cmdRun(runOpts({ strategyName: "rsi-meanrev", outDir: out }));
    const sc = JSON.parse(
      readFileSync(join(out, "scorecard.json"), "utf8"),
    ) as { agent: string; metrics: { totalTrades: number }; manifest: { agentbenchVersion: string } };
    expect(sc.agent).toBe("rsi-meanrev");
    expect(sc.manifest.agentbenchVersion).toBe(VERSION);
    expect(sc.metrics.totalTrades).toBeGreaterThan(0);
  });

  it("rejects an unknown strategy", async () => {
    const agent = await resolveAgent(
      runOpts({ strategyName: "does-not-exist" }),
    );
    expect(agent).toBeNull();
  });

  it("rejects passing both --strategy and --agent", async () => {
    const agent = await resolveAgent(
      runOpts({ strategyName: "rsi-meanrev", agentPath: "./x.ts" }),
    );
    expect(agent).toBeNull();
  });
});

describe("agentbench report", () => {
  it("reprints the summary of a saved scorecard", async () => {
    const out = tmpOut();
    await cmdRun(runOpts({ strategyName: "sma-crossover", outDir: out }));
    const cap = captureStdout();
    await cmdReport({ cmd: "report", args: [join(out, "scorecard.json")] });
    cap.restore();
    const text = cap.writes.join("");
    expect(text).toContain("Agent:");
    expect(text).toContain("sma-crossover");
    expect(text).toContain(VERSION);
  });
});

describe("agentbench compare", () => {
  it("prints a two-column metric diff of two scorecards", async () => {
    const outA = tmpOut();
    const outB = tmpOut();
    await cmdRun(runOpts({ strategyName: "sma-crossover", outDir: outA }));
    await cmdRun(runOpts({ strategyName: "rsi-meanrev", outDir: outB }));
    const cap = captureStdout();
    await cmdCompare({
      cmd: "compare",
      args: [join(outA, "scorecard.json"), join(outB, "scorecard.json")],
    });
    cap.restore();
    const text = cap.writes.join("");
    expect(text).toContain("Return %");
    expect(text).toContain("Sharpe");
    expect(text).toContain("Violations");
  });
});

describe("agentbench verify", () => {
  it("verifies a freshly emitted report and reports VERIFIED", async () => {
    const out = tmpOut();
    await cmdRun(runOpts({ strategyName: "rsi-meanrev", outDir: out }));
    const prevExit = process.exitCode;
    const cap = captureStdout();
    await cmdVerify({ cmd: "verify", args: [out] });
    cap.restore();
    const text = cap.writes.join("");
    expect(text).toContain("[PASS] integrity");
    expect(text).toContain("[PASS] ledger");
    expect(text).toContain("[PASS] replay");
    expect(text).toContain("VERIFIED");
    expect(process.exitCode).not.toBe(1);
    process.exitCode = prevExit;
  });

  it("fails with exit code 1 when the scorecard is tampered", async () => {
    const out = tmpOut();
    await cmdRun(runOpts({ strategyName: "rsi-meanrev", outDir: out }));
    const scPath = join(out, "scorecard.json");
    const sc = JSON.parse(readFileSync(scPath, "utf8"));
    sc.metrics.totalReturnPct = 1234;
    writeFileSync(scPath, JSON.stringify(sc, null, 2));

    const prevExit = process.exitCode;
    const cap = captureStdout();
    await cmdVerify({ cmd: "verify", args: [out] });
    cap.restore();
    const text = cap.writes.join("");
    expect(text).toContain("[FAIL] integrity");
    expect(text).toContain("FAILED");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });

  it("errors when no target is given", async () => {
    const prevExit = process.exitCode;
    await cmdVerify({ cmd: "verify", args: [] });
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });
});

describe("help", () => {
  it("lists the built-in strategies and the real version", () => {
    const text = helpText();
    expect(text).toContain("sma-crossover");
    expect(text).toContain("rsi-meanrev");
    expect(text).toContain(VERSION);
  });

  it("documents the verify command", () => {
    expect(helpText()).toContain("agentbench verify");
  });
});
