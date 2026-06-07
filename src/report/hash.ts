/**
 * Scorecard content hashing.
 *
 * A scorecard carries a `scorecardSha256`: a SHA256 over its substantive content
 * ({agent, metrics, manifest}) so the artifact is self-certifying. Recompute it
 * and compare to detect any edit to the file. This is a content hash, not a
 * cryptographic signature: it proves the file was not altered after emission and
 * pairs with `agentbench verify`, which independently recomputes the numbers from
 * the ledger so a forger cannot just rehash a doctored file and call it true.
 */

import { createHash } from "node:crypto";
import type { Scorecard } from "../types.js";

/**
 * Canonical JSON of a value: object keys sorted recursively so the same logical
 * content always serialises to the same bytes, regardless of key insertion
 * order. That byte-stability is what makes the hash reproducible across machines.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

/**
 * Content hash of a scorecard over {agent, metrics, manifest}. Any existing
 * `scorecardSha256` field is deliberately excluded so the file can carry its own
 * hash without affecting it.
 */
export function computeScorecardSha256(scorecard: Scorecard): string {
  const { agent, metrics, manifest } = scorecard;
  const canonical = canonicalJson({ agent, metrics, manifest });
  return createHash("sha256").update(canonical).digest("hex");
}
