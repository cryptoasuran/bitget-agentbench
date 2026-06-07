/**
 * Report emitters — write scorecard.json, trades.jsonl, equity.csv and a
 * run manifest to disk. All output is deterministic JSON/CSV with no
 * dynamic values (the manifest captures the dataset hash, config, and seed —
 * re-run with the same inputs and you get byte-identical output).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Scorecard, Fill, Bar } from "../types.js";
import { renderHtml } from "./html.js";
import { computeScorecardSha256 } from "./hash.js";

/**
 * Deterministic SHA256 of a bar dataset. Hashes the canonical OHLCV tuples so
 * the manifest can prove which exact candles produced a result. Anyone with the
 * same dataset gets the same hash, which is what makes a scorecard verifiable.
 */
export function hashDataset(bars: readonly Bar[]): string {
  const h = createHash("sha256");
  for (const b of bars) {
    h.update(`${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}\n`);
  }
  return h.digest("hex");
}

/**
 * Emit the full report suite into `outDir`.
 * Produces:
 *   scorecard.json    — the Scorecard (metrics + manifest) plus its content hash
 *   trades.jsonl      — one JSON object per fill line
 *   manifest.json     — the standalone run manifest
 *   equity.csv        — equity curve (one col per row, header row)
 */
export function emitReport(
  scorecard: Scorecard,
  fills: readonly Fill[],
  equity: readonly number[],
  outDir: string,
): void {
  mkdirSync(outDir, { recursive: true });

  // scorecard.json — stamp a content hash so the artifact is self-certifying.
  // The hash covers {agent, metrics, manifest}; verify recomputes and checks it.
  const stamped: Scorecard = {
    ...scorecard,
    scorecardSha256: computeScorecardSha256(scorecard),
  };
  writeFileSync(
    resolve(outDir, "scorecard.json"),
    JSON.stringify(stamped, null, 2),
    "utf8",
  );

  // trades.jsonl — ndjson, one fill per line
  const lines = fills.map((f) => JSON.stringify(f));
  writeFileSync(resolve(outDir, "trades.jsonl"), lines.join("\n") + "\n", "utf8");

  // equity.csv — header + one row per bar
  const csv = "equity\n" + equity.map(String).join("\n") + "\n";
  writeFileSync(resolve(outDir, "equity.csv"), csv, "utf8");

  // manifest.json — standalone for re-runs
  writeFileSync(
    resolve(outDir, "manifest.json"),
    JSON.stringify(scorecard.manifest, null, 2),
    "utf8",
  );

  // scorecard.html — self-contained visual report (carries the content hash too)
  writeFileSync(
    resolve(outDir, "scorecard.html"),
    renderHtml(stamped, equity, fills),
    "utf8",
  );
}
