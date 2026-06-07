/**
 * A minimal external (non-built-in) strategy used to test replay of agents that
 * are not in the registry. Deterministic and stateless: it decides purely from
 * the bar index and the current position, so re-importing and re-running it
 * reproduces the same trades. No package imports, so it loads anywhere.
 */
export default {
  name: "ext-test-agent",
  onBar(bar, ctx) {
    if (ctx.index === 5 && ctx.position.size === 0) {
      return [{ symbol: "BTCUSDT", side: "buy", orderType: "market", size: 0.01 }];
    }
    if (ctx.index === 60 && ctx.position.size > 0) {
      return [{ symbol: "BTCUSDT", side: "sell", orderType: "market", size: ctx.position.size }];
    }
    return [];
  },
};
