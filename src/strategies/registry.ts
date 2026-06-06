import type { StrategyAgent } from "../types.js";
import smaCrossover from "./sma-crossover.js";
import rsiMeanrev from "./rsi-meanrev.js";

/**
 * Built-in strategies, addressable by name from both the CLI (`--strategy`) and
 * the MCP tool. One source of truth so the two entry points cannot drift.
 */
export const STRATEGIES: Record<string, StrategyAgent> = {
  "sma-crossover": smaCrossover,
  "rsi-meanrev": rsiMeanrev,
};

/** The names of the built-in strategies. */
export function listStrategies(): string[] {
  return Object.keys(STRATEGIES);
}
