# Sample reports

Real backtest runs produced by AgentBench, committed as verifiable evidence. Each
folder holds a `scorecard.json`, a `trades.jsonl` ledger, an `equity.csv` and a
self-contained `scorecard.html`. Every run is on real Bitget candles (public
data, no keys) with a fixed seed, so you can reproduce any of these byte for byte:

```bash
npm run build
node dist/cli.js run --agent examples/<agent>.ts --symbol <SYM> --tf 4h --seed 42 --out /tmp/check
diff /tmp/check/scorecard.json reports/<agent>-<SYM>-4h/scorecard.json
```

## Results matrix (seed 42, 4h, ~929 bars each)

| Agent | Symbol | Return | Trades | Win rate | Sharpe |
|-------|--------|-------:|-------:|---------:|-------:|
| sma-crossover | BTCUSDT | -2.14% | 18 | 28% | -2.45 |
| rsi-meanrev | BTCUSDT | -1.00% | 14 | 79% | -0.94 |
| sma-crossover | ETHUSDT | -0.12% | 19 | 16% | -3.44 |
| rsi-meanrev | ETHUSDT | -0.06% | 14 | 71% | -1.38 |
| sma-crossover | SOLUSDT | -0.00% | 20 | 25% | -2.53 |
| rsi-meanrev | SOLUSDT | -0.00% | 15 | 73% | -0.82 |

The point is not that these toy strategies make money (they do not, over this
window). The point is that AgentBench measures them honestly and consistently.
The mean-reversion agent shows a higher win rate than the crossover agent across
all three symbols, and the harness surfaces that without anyone trading a cent.

Open any `scorecard.html` in a browser to see the equity curve, metrics and trade
ledger for that run.
