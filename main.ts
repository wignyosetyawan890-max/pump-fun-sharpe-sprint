// LiquidFirst — Pump.fun Sharpe Sprint entry (main.ts, Node 22).
//
// One strategy program: it buys a coin once, the first time its real SOL
// reserve crosses 2 SOL, then sells on a +20% take-profit, a -4% stop, or
// after 1,500 slots. See strategy.ts for the measured edge and the rules.
// The hello, batch and orders flow is the kit's agent-fun/replay/v2 wire;
// the vendor shim owns it, this file only wires the strategy to it.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
