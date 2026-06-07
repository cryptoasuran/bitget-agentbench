/**
 * Load a strategy agent from a file.
 *
 * Used by the CLI (`run --agent`) and by `verify` when it is asked to replay an
 * external agent. Importing a file executes it, so callers must only load a file
 * the user explicitly pointed at. `verify` never loads a report-embedded agent on
 * its own; it requires an explicit opt-in.
 */

import { resolve } from "node:path";
import type { StrategyAgent } from "./types.js";

/** Import an agent file and return its strategy. Throws if it does not export one. */
export async function loadAgentFromFile(path: string): Promise<StrategyAgent> {
  const abs = resolve(path);
  const mod = (await import(abs)) as Record<string, unknown>;
  const agent = (mod["default"] ?? mod["agent"]) as StrategyAgent | undefined;
  if (!agent || typeof agent.onBar !== "function") {
    throw new Error(
      `agent at ${abs} must export a default { onBar(bar, ctx) } or a named "agent"`,
    );
  }
  return agent;
}
