import { describe, it, expect } from "vitest";
import { fetchCandles, fetchRawCandles } from "../src/sources/candle-source.js";
import type { FetchLike } from "../src/sources/candle-source.js";

/**
 * The live candle source fetches real Bitget candles from the public keyless
 * endpoint. These tests use an injected transport so the suite never touches the
 * network: they pin the URL, the parse-and-sort, and the error paths.
 */

function fakeFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      async text() {
        return JSON.stringify(payload);
      },
      async json() {
        return payload;
      },
    };
  };
  return { fetch, calls };
}

// Bitget v2 spot candle rows are all strings: [ts, o, h, l, c, baseVol, quoteVol, usdtVol].
// Deliberately out of order to prove we sort ascending by time.
const RAW = {
  code: "00000",
  msg: "success",
  requestTime: 1736000000000,
  data: [
    ["1736007200000", "105", "112", "104", "108", "5", "540", "540"],
    ["1736000000000", "100", "110", "90", "105", "10", "1000", "1000"],
    ["1736003600000", "105", "109", "100", "104", "7", "728", "728"],
  ],
};

describe("fetchRawCandles", () => {
  it("builds the keyless spot candles URL with symbol, granularity and limit", async () => {
    const { fetch, calls } = fakeFetch(RAW);
    await fetchRawCandles({ symbol: "BTCUSDT", granularity: "4h", limit: 200, fetchImpl: fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/v2/spot/market/candles");
    expect(calls[0]).toContain("symbol=BTCUSDT");
    expect(calls[0]).toContain("granularity=4h");
    expect(calls[0]).toContain("limit=200");
  });

  it("returns the raw Bitget response untouched (for snapshotting)", async () => {
    const { fetch } = fakeFetch(RAW);
    const raw = await fetchRawCandles({ symbol: "BTCUSDT", granularity: "4h", fetchImpl: fetch });
    expect(raw.code).toBe("00000");
    expect(raw.data).toHaveLength(3);
  });

  it("caps limit at 1000", async () => {
    const { fetch, calls } = fakeFetch(RAW);
    await fetchRawCandles({ symbol: "BTCUSDT", granularity: "4h", limit: 999999, fetchImpl: fetch });
    expect(calls[0]).toContain("limit=1000");
  });

  it("throws on a non-OK HTTP status", async () => {
    const { fetch } = fakeFetch("upstream boom", { ok: false, status: 503 });
    await expect(
      fetchRawCandles({ symbol: "BTCUSDT", granularity: "4h", fetchImpl: fetch }),
    ).rejects.toThrow(/503/);
  });

  it("throws when Bitget returns a non-success code", async () => {
    const { fetch } = fakeFetch({ code: "40034", msg: "param error", requestTime: 0, data: [] });
    await expect(
      fetchRawCandles({ symbol: "NOPE", granularity: "4h", fetchImpl: fetch }),
    ).rejects.toThrow(/40034|param error/);
  });

  it("throws on empty data", async () => {
    const { fetch } = fakeFetch({ code: "00000", msg: "success", requestTime: 0, data: [] });
    await expect(
      fetchRawCandles({ symbol: "BTCUSDT", granularity: "4h", fetchImpl: fetch }),
    ).rejects.toThrow(/empty/i);
  });

  it("rejects an unknown granularity before calling the network", async () => {
    const { fetch, calls } = fakeFetch(RAW);
    await expect(
      // deliberately bad value, as could arrive from a CLI cast
      fetchRawCandles({ symbol: "BTCUSDT", granularity: "9z" as never, fetchImpl: fetch }),
    ).rejects.toThrow(/unknown granularity/i);
    expect(calls).toHaveLength(0);
  });
});

describe("fetchCandles", () => {
  it("parses to Bars sorted oldest-first", async () => {
    const { fetch } = fakeFetch(RAW);
    const bars = await fetchCandles({ symbol: "BTCUSDT", granularity: "4h", fetchImpl: fetch });
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.time)).toEqual([1736000000000, 1736003600000, 1736007200000]);
    expect(bars[0]).toMatchObject({ open: 100, high: 110, low: 90, close: 105, volume: 10 });
  });
});
