# LiquidFirst v3 — Pump.fun Sharpe Sprint

A deterministic paper-trading bot for the make.fun bounty
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/wignyosetyawan890-max/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/wignyosetyawan890-max/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

> This entry was built and evaluated in-session; see `strategy.ts` for the
> measured evidence behind every parameter.

## Strategy

One `main.ts` program (Node 22, zero dependencies) paper-trading 10 SOL on a
6-hour pump.fun replay. It only buys **deep pullbacks on liquid curves**
and lets winners run on a trailing stop:

- **Entry:** price dipped 18–35% below its trailing high (2,500 slots),
  real SOL reserve ≥ 20 SOL, buyer flow (≥3 buys in the last 6 trades,
  last trade a buy). Stake 0.1 SOL per entry, max 2 entries per mint,
  max 2 entries per batch, max 5 open positions.
- **Exits:** partial take-profit of 50% at +10%, hard stop at −8%,
  trailing stop armed at +20% with 8% give-back, max hold 1,500 slots.
- **Deterministic:** no clock, no randomness, no I/O. Any randomness is
  seeded only from `state.hello.seed` (none is used).

## Why these numbers (measured on the frozen dev window, not guessed)

- Launch bursts and completion bursts are faster than the 2-slot order
  latency: median entry slippage vs the trigger price is +19%, so the bot
  never chases launches or completions.
- Every simple price trigger (dip, breakout, flow) is slightly negative
  after the ~2.7% round-trip fee wall; only the deep-dip + high-liquidity
  + trailing-stop combination is (barely) positive.
- Local evaluation (house-rule hourly Sharpe, full 24h dev window,
  4 seeded failed-tx draws): **net +0.026 to +0.171 SOL, hourly Sharpe
  +0.021 to +0.095, max drawdown 3.5–3.9%, 75–77 round trips over 65
  coins, win rate 36–39%**. Positive on all four draws, but the edge is
  small and the final 6h window is unseen data — a local score is not a
  prediction of final rank.
- Tested and rejected: shallow dips, breakout chasing, launch sniping,
  ride-to-completion (completers finish inside the same burst),
  creator-buy triggers, smart-wallet following (no out-of-sample
  persistence), retail/organic filters, hourly loss governor.

## Layout

- `main.ts` — thin wiring: `runBot(createStrategy())`.
- `strategy.ts` — the strategy (self-written in-session).
- `vendor/makefun-bot.ts` — the kit SDK, vendored unchanged.

## License

MIT — see `LICENSE`.
