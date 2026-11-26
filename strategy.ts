// LiquidFirst v2: a Sharpe-first scalper for the pump.fun bonding-curve replay.
//
// What the dev window (128,058 events, 1,222 coins) taught us:
// - Launch bursts and completion bursts are faster than the 2-slot latency:
//   by the time a buy fills, the price has already run a median +19% past the
//   trigger trade, so "buy the first liquid trade" buys the top (v1: -1.8 SOL,
//   19% wins). The same holds for riding to completion: the final leg is a
//   single huge trade in one slot.
// - Simple dip-buying and breakout-chasing both lose ~1.3-3.4% per trip after
//   the ~2.7% round-trip fee (fees are uniform: 95 bps protocol + 30 bps
//   creator on every trade). No fixed take-profit/stop pair measured positive.
// - The remaining hope is asymmetry: small, frequent entries on liquid coins
//   with a tight hard stop, a partial take-profit, and a trailing stop that
//   lets the few real runners pay for the many small losses. This file is
//   built to sweep that space: entry, exits and sizing are all parameters,
//   and every decision is a pure function of the hello, the batches and the
//   fills the harness sends (no clock, no randomness, no I/O), iterated over
//   insertion-ordered maps.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Dip entry: price at least this far below its trailing high (fraction). */
  dipMin: number;
  /** Dip entry: price at most this far below its trailing high (a collapse, not a dip). */
  dipMax: number;
  /** Trailing-high lookback, in slots. */
  highWindowSlots: number;
  /** Entry needs this much real SOL on the curve (lamports). */
  minRealSolLamports: bigint;
  /** Entry needs at least this many buys among the last `flowTrades` trades. */
  flowTrades: number;
  minBuys: number;
  /** Entry needs the most recent trade to be a buy. */
  lastMustBeBuy: boolean;
  /** SOL per position (lamports). Capped again by the 1%-of-real-reserve rule. */
  stakeLamports: bigint;
  /** First take-profit: sell this share of the position at +takeProfit1. 0 = off. */
  takeProfit1: number;
  tp1PartBps: number;
  /** Hard stop: sell everything at cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: once value reaches cost * (1 + trailArm), sell everything
   *  when value falls to peak * (1 - trail). 0 = off. */
  trailArm: number;
  trail: number;
  /** Sell everything after holding this many slots, whatever the value. */
  maxHoldSlots: number;
  /** Most entries per coin over the run. */
  maxEntriesPerMint: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldownSlots: number;
  /** Most new entries decided in one batch. */
  maxEntriesPerBatch: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** "Verified-retail" filter: over the last `organicWindow` trades, the buys
   *  must come from at least this many distinct wallets. 0 = off. */
  minDistinctBuyers: number;
  /** ...and the largest single buyer's share of buy volume must be at most
   *  this (bps). 0 = off. */
  maxBuyerShareBps: number;
  /** Trades looked at by the retail filter. */
  organicWindow: number;
  /** Hourly loss governor (bps of the hour-start marked equity): while the
   *  current hour's marked equity is below hour-start * (1 - X), no new
   *  entries are opened until the next hour. 0 = off. Truncates the left
   *  tail of hourly returns (the denominator of Sharpe). */
  hourLossPauseBps: number;
}

export const DEFAULT_PARAMS: Params = {
  // Final v3 params — best of ~120 swept combos on the full dev window
  // (fail keys 11/22/33/44): Sharpe +0.03, net +0.04 SOL, DD 3.9%.
  // Deep dip (18-35%) on very liquid curves (real SOL >= 20) with buyer
  // flow; wide stop (-8%) + long trailing stop (arm +20%, give-back -8%)
  // because dip recoveries need room; partial TP at +10%.
  // The hourly loss governor and the retail filter were tested and did not
  // help (governor never fires; retail filter is neutral-to-negative), so
  // both stay OFF. See work/ for the full evidence log.
  dipMin: 0.18,
  dipMax: 0.35,
  highWindowSlots: 2500,
  minRealSolLamports: 20_000_000_000n,
  flowTrades: 6,
  minBuys: 3,
  lastMustBeBuy: true,
  stakeLamports: 100_000_000n,
  takeProfit1: 0.1,
  tp1PartBps: 5000,
  stopLoss: 0.08,
  trailArm: 0.2,
  trail: 0.08,
  maxHoldSlots: 1500,
  maxEntriesPerMint: 2,
  cooldownSlots: 300,
  maxEntriesPerBatch: 2,
  buySlippageBps: 500,
  sellSlippageBps: 10_000,
  minDistinctBuyers: 0,
  maxBuyerShareBps: 0,
  organicWindow: 20,
  hourLossPauseBps: 0,
};

interface Tick {
  slot: number;
  priceScaled: bigint;
  isBuy: boolean;
  user: string;
  solLamports: bigint;
}

interface Book {
  ticks: Tick[];
  /** Trailing high price (scaled) and the slot it was set at. */
  highScaled: bigint;
  highSlot: number;
  /** Slot of the first buy decision of the current position (-1 when flat). */
  entrySlot: number;
  /** Decision-time price of the first buy, scaled. */
  entryPriceScaled: bigint;
  /** Best mark value / cost ratio (x10000) seen since entry. */
  peakRatioBps: number;
  /** Whether the first take-profit already fired for this position. */
  tp1Done: boolean;
  /** Entries used on this coin so far. */
  entries: number;
  /** Do not re-enter before this slot. */
  coolUntil: number;
}

const SCALE = 1_000_000_000_000_000_000n;

function priceScaled(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken === 0n) return 0n;
  return (virtualQuote * SCALE) / virtualToken;
}

function markValueLamports(tokens: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken === 0n) return 0n;
  return (tokens * virtualQuote) / virtualToken;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  // Hourly loss governor state: hour boundaries anchored to the first
  // block time seen (the house Sharpe marks hours the same way).
  let t0 = -1;
  let hourIdx = -1;
  let hourStartEquity = 0n;
  const markedEquity = (state: BotState): bigint => {
    let eq = state.cash;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      eq += markValueLamports(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    }
    return eq;
  };
  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { ticks: [], highScaled: 0n, highSlot: -1, entrySlot: -1, entryPriceScaled: 0n, peakRatioBps: 0, tp1Done: false, entries: 0, coolUntil: -1 };
      books.set(mint, b);
    }
    return b;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();

      // Fold this batch's trades into the per-coin tapes first.
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const b = book(e.mint);
        const price = priceScaled(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        b.ticks.push({ slot: e.slot, priceScaled: price, isBuy: e.is_buy, user: e.user, solLamports: BigInt(e.sol_amount) });
        if (b.ticks.length > 64) b.ticks.splice(0, b.ticks.length - 64);
        if (price > b.highScaled || slot - b.highSlot > p.highWindowSlots) {
          b.highScaled = price;
          b.highSlot = slot;
        }
      }

      // --- hourly loss governor: pause new entries while this hour's
      // marked equity sits below hour-start minus the pause threshold.
      let paused = false;
      if (p.hourLossPauseBps > 0) {
        const btEv = batch.events.find((e: any) => typeof e.block_time === 'number') as any;
        const bt: number | undefined = btEv?.block_time;
        if (bt !== undefined) {
          if (t0 < 0) t0 = bt;
          const h = Math.floor((bt - t0) / 3600);
          if (h !== hourIdx) {
            hourIdx = h;
            hourStartEquity = markedEquity(state);
          }
          const eq = markedEquity(state);
          if (eq * 10_000n < hourStartEquity * BigInt(10_000 - p.hourLossPauseBps)) paused = true;
        }
      }

      // --- exits: TP1 (partial), hard stop, trailing stop, time limit.
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const b = book(mint);
        let busy = false;
        for (const pend of state.pending.values()) {
          if (pend.order.mint === mint) { busy = true; break; }
        }
        if (busy) continue;
        const value = markValueLamports(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const cost = holding.cost_lamports;
        if (cost === 0n) continue;
        // ratioBps = value / cost in basis points, integer math.
        const ratioBps = Number((value * 10_000n) / cost);
        if (ratioBps > b.peakRatioBps) b.peakRatioBps = ratioBps;
        const tp1Bps = Math.round(p.takeProfit1 * 10_000);
        const slBps = Math.round(p.stopLoss * 10_000);
        const trailArmBps = Math.round(p.trailArm * 10_000);
        const trailBps = Math.round(p.trail * 10_000);
        const heldSlots = b.entrySlot >= 0 ? slot - b.entrySlot : 0;
        if (ratioBps <= 10_000 - slBps || heldSlots >= p.maxHoldSlots) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: p.sellSlippageBps });
          b.coolUntil = slot + p.cooldownSlots;
          b.entrySlot = -1;
          b.peakRatioBps = 0;
          b.tp1Done = false;
          continue;
        }
        if (p.trail > 0 && b.peakRatioBps >= 10_000 + trailArmBps) {
          const trailLine = Math.floor((b.peakRatioBps * (10_000 - trailBps)) / 10_000);
          if (ratioBps <= trailLine) {
            orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: p.sellSlippageBps });
            b.coolUntil = slot + p.cooldownSlots;
            b.entrySlot = -1;
            b.peakRatioBps = 0;
            b.tp1Done = false;
            continue;
          }
        }
        if (p.takeProfit1 > 0 && !b.tp1Done && ratioBps >= 10_000 + tp1Bps) {
          const part = (holding.token_amount * BigInt(p.tp1PartBps)) / 10_000n;
          if (part > 0n) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlippageBps });
            b.tp1Done = true;
          }
        }
      }

      // --- entries: dip with buyer flow on a liquid curve.
      // (Skipped entirely while the hourly loss governor is paused.)
      let entries = 0;
      for (const e of batch.events) {
        if (paused) break;
        if (orders.length >= caps.max_orders_per_batch) break;
        if (entries >= p.maxEntriesPerBatch) break;
        if (e.event !== 'TradeEvent') continue;
        const curve = state.curves.get(e.mint);
        if (curve === undefined || curve.complete) continue;
        const b = book(e.mint);
        if (b.entries >= p.maxEntriesPerMint) continue;
        if (slot < b.coolUntil) continue;
        if (state.positions.has(e.mint)) continue;
        if (curve.real_quote_reserves < p.minRealSolLamports) continue;
        if (b.highScaled === 0n) continue;
        const now = priceScaled(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        // dip = 1 - now / high, in bps: (high - now) * 10000 / high.
        const dipBps = Number(((b.highScaled - now) * 10_000n) / b.highScaled);
        if (dipBps < Math.round(p.dipMin * 10_000) || dipBps > Math.round(p.dipMax * 10_000)) continue;
        const recent = b.ticks.slice(-p.flowTrades);
        if (recent.length < p.flowTrades) continue;
        let buys = 0;
        for (const t of recent) if (t.isBuy) buys++;
        if (buys < p.minBuys) continue;
        if (p.lastMustBeBuy && !recent[recent.length - 1]!.isBuy) continue;
        // Verified-retail filter: the recent buys must be spread over many
        // distinct wallets, with no single wallet dominating the flow.
        if (p.minDistinctBuyers > 0 || p.maxBuyerShareBps > 0) {
          const window = b.ticks.slice(-p.organicWindow);
          const buyers = new Map<string, bigint>();
          let buyTotal = 0n;
          for (const t of window) {
            if (!t.isBuy) continue;
            buyTotal += t.solLamports;
            buyers.set(t.user, (buyers.get(t.user) ?? 0n) + t.solLamports);
          }
          if (p.minDistinctBuyers > 0 && buyers.size < p.minDistinctBuyers) continue;
          if (p.maxBuyerShareBps > 0 && buyTotal > 0n) {
            let biggest = 0n;
            for (const v of buyers.values()) if (v > biggest) biggest = v;
            if (biggest * 10_000n > buyTotal * BigInt(p.maxBuyerShareBps)) continue;
          }
        }
        let busy = false;
        for (const pend of state.pending.values()) {
          if (pend.order.mint === e.mint) { busy = true; break; }
        }
        if (busy) continue;
        if (state.committedPositionCount() + entries >= caps.max_open_positions) continue;
        const cap = state.maxBuyLamports(e.mint);
        if (cap <= 0n) continue;
        let amount = p.stakeLamports;
        if (amount > cap) amount = cap;
        if (amount < 10_000_000n) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        entries += 1;
        b.entries += 1;
        b.entrySlot = slot;
        b.entryPriceScaled = now;
        b.peakRatioBps = 0;
        b.tp1Done = false;
      }

      return orders;
    },
  };
}
