/**
 * Live candle source — fetches real candles from Bitget's public spot market
 * endpoint. Keyless and read-only: the v2 `/spot/market/candles` endpoint needs
 * no API key and touches no account. Use it to score a strategy against fresh
 * data instead of a committed fixture.
 *
 * Determinism note: live data changes between calls, so this is opt-in and is
 * NOT the default. A run that uses it records `source: "candles"` and the caller
 * snapshots the exact candles it fetched (see the CLI writing `candles.json`),
 * so the result stays reproducible and `agentbench verify` can re-derive it from
 * that snapshot. Fixtures remain the zero-network default.
 */

import { parseRawCandles } from "./fixture-source.js";
import { GRANULARITIES } from "../types.js";
import type { Bar, Granularity } from "../types.js";

const BITGET_BASE = "https://api.bitget.com";
const CANDLES_PATH = "/api/v2/spot/market/candles";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000; // Bitget's per-call cap for this endpoint.

/** A single raw Bitget candle: all fields are strings. */
type RawCandle = [string, string, string, string, string, string, string, string?];

/** The Bitget candles response envelope. */
export interface BitgetCandleResponse {
  code: string;
  msg: string;
  requestTime: number;
  data: RawCandle[];
}

/**
 * Minimal fetch contract, so the source works on Node 18+'s global fetch and is
 * trivially injectable in tests without pulling in DOM types.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface FetchCandlesOptions {
  symbol: string;
  granularity: Granularity;
  /** Number of candles to fetch (default 200, capped at 1000). */
  limit?: number;
  /** Override the API base (for tests or a mirror). */
  baseUrl?: string;
  /** Inject a transport (for tests). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Fetch the raw Bitget candles response. Returned untouched so the caller can
 * snapshot exactly what the run used.
 */
export async function fetchRawCandles(opts: FetchCandlesOptions): Promise<BitgetCandleResponse> {
  const { symbol, granularity, limit = DEFAULT_LIMIT, baseUrl = BITGET_BASE } = opts;
  // Validate the granularity at the boundary: it reaches us cast from CLI input,
  // so reject anything outside the known set with a clear error instead of
  // forwarding it to the API.
  if (!GRANULARITIES.includes(granularity)) {
    throw new Error(`unknown granularity "${granularity}"; expected one of ${GRANULARITIES.join(", ")}`);
  }
  const f: FetchLike | undefined = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) {
    throw new Error("no fetch available: use Node 18+ or pass fetchImpl");
  }

  const n = Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
  const url =
    `${baseUrl}${CANDLES_PATH}` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&granularity=${encodeURIComponent(granularity)}` +
    `&limit=${n}`;

  const res = await f(url);
  if (!res.ok) {
    throw new Error(`Bitget candles HTTP ${res.status}: ${(await safeText(res)).slice(0, 200)}`);
  }

  const payload = (await res.json()) as BitgetCandleResponse;
  if (payload?.code !== "00000") {
    throw new Error(`Bitget candles error ${payload?.code}: ${payload?.msg}`);
  }
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error(`Bitget candles: empty data for ${symbol} ${granularity}`);
  }
  return payload;
}

/** Fetch live candles and parse them into Bars, sorted oldest-first. */
export async function fetchCandles(opts: FetchCandlesOptions): Promise<Bar[]> {
  const payload = await fetchRawCandles(opts);
  return parseRawCandles(payload.data as Parameters<typeof parseRawCandles>[0]);
}
