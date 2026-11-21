/**
 * Pure paper-book math: size, open gates, and stop / target / time exits.
 * Long only. No broker, no orders.
 */

import { isSessionComplete, tradingDaysInclusive } from './market.js';

export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function sharesForOrder({ entry, riskShares, cash }) {
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  if (!Number.isFinite(riskShares) || riskShares < 1) return 0;
  let shares = Math.min(Math.floor(riskShares), Math.floor(cash / entry));
  while (shares > 0 && round2(shares * entry) > cash + 1e-9) shares -= 1;
  return Math.max(0, shares);
}

export function shouldOpen({ call, decisionText, riskPass, alreadyOpen, closedToday, openCount, maxPositions, shares }) {
  if (call !== 'buy') {
    return {
      ok: false,
      why: call === 'reduce' ? '只建議縮小，自動不進場' : (decisionText || '未達買進門檻')
    };
  }
  if (!riskPass) return { ok: false, why: '風險檢查未過' };
  if (alreadyOpen) return { ok: false, why: '已有持倉' };
  if (closedToday) return { ok: false, why: '今日已平過，不再進場' };
  if (openCount >= maxPositions) return { ok: false, why: '持倉已滿' };
  if (shares < 1) return { ok: false, why: '現金不足一手' };
  return { ok: true, why: '已開倉' };
}

export function selectExitBars(daily, intra) {
  const clean = (bars) => (bars || []).filter((bar) => Number.isFinite(bar.low) && Number.isFinite(bar.high) && Number.isFinite(bar.close));
  const intraBars = clean(intra);
  const intraSessions = new Set(intraBars.map((bar) => bar.session));
  const out = [];
  for (const bar of clean(daily)) {
    if (intraSessions.has(bar.session)) continue;
    out.push(bar);
  }
  out.push(...intraBars);
  out.sort((a, b) => a.time - b.time);
  return out;
}

function hitStopOrTarget(bar, position) {
  const stop = position.stop;
  const target = position.target;
  const open = Number.isFinite(bar.open) ? bar.open : null;
  const stopped = bar.low <= stop;
  const targeted = bar.high >= target;
  if (open != null && open <= stop) return { exitPrice: round2(open), reason: 'stop' };
  if (open != null && open >= target) return { exitPrice: round2(open), reason: 'target' };
  if (stopped && targeted) return { exitPrice: round2(stop), reason: 'stop' };
  if (stopped) return { exitPrice: round2(stop), reason: 'stop' };
  if (targeted) return { exitPrice: round2(target), reason: 'target' };
  return null;
}

function exitRecord(position, hit, bar, holdDays) {
  return {
    exitPrice: hit.exitPrice,
    reason: hit.reason,
    exitTime: new Date(bar.time).toISOString(),
    exitSession: bar.session,
    holdDays
  };
}

/**
 * Walk bars after the fill. Same-bar stop and target: stop wins.
 * A gap through the stop fills at the open. Time exit is the 10th
 * trading day's close, and only after that session is finished.
 */
export function planExits(position, bars, opts = {}) {
  const maxHold = opts.maxHold ?? 10;
  const now = opts.now ?? new Date();
  const entryMs = Date.parse(position.entryTime);
  const relevant = (bars || [])
    .filter((bar) => bar.session >= position.entrySession && bar.time >= entryMs)
    .sort((a, b) => a.time - b.time);

  const sessions = [];
  for (const bar of relevant) {
    let group = sessions[sessions.length - 1];
    if (!group || group.session !== bar.session) {
      group = { session: bar.session, bars: [] };
      sessions.push(group);
    }
    group.bars.push(bar);
  }

  for (const group of sessions) {
    const dayIndex = tradingDaysInclusive(position.entrySession, group.session);
    if (dayIndex < 1) continue;
    if (dayIndex > maxHold) {
      const bar = group.bars[0];
      const price = Number.isFinite(bar.open) ? bar.open : bar.close;
      return exitRecord(position, { exitPrice: round2(price), reason: 'time' }, bar, maxHold);
    }
    for (const bar of group.bars) {
      const hit = hitStopOrTarget(bar, position);
      if (hit) return exitRecord(position, hit, bar, dayIndex);
    }
    if (dayIndex >= maxHold && isSessionComplete(group.session, now)) {
      const bar = group.bars[group.bars.length - 1];
      return exitRecord(position, { exitPrice: round2(bar.close), reason: 'time' }, bar, dayIndex);
    }
  }
  return null;
}

export function closePosition(position, exit) {
  const pnl = round2((exit.exitPrice - position.entry) * position.shares);
  const pnlPct = position.entry ? round2(((exit.exitPrice - position.entry) / position.entry) * 100) : 0;
  const reasonText = exit.reason === 'stop' ? '觸及停損' : (exit.reason === 'target' ? '觸及目標' : '持有到期');
  return {
    id: position.id,
    symbol: position.symbol,
    side: 'long',
    shares: position.shares,
    entry: position.entry,
    exit: exit.exitPrice,
    stop: position.stop,
    target: position.target,
    entryTime: position.entryTime,
    exitTime: exit.exitTime,
    entrySession: position.entrySession,
    exitSession: exit.exitSession,
    exitReason: exit.reason,
    exitReasonText: reasonText,
    pnl,
    pnlPct,
    score: position.score ?? null,
    holdTradingDays: exit.holdDays ?? null,
    reasons: position.reasons || []
  };
}

export function markToMarket(state) {
  const initial = Number(state.initialCapital) || 0;
  const openCost = (state.openPositions || []).reduce((sum, position) => sum + position.entry * position.shares, 0);
  const realized = (state.closedTrades || []).reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  const cash = round2(initial - openCost + realized);
  const marketValue = (state.openPositions || []).reduce((sum, position) => {
    const price = position.lastPrice ?? position.entry;
    return sum + price * position.shares;
  }, 0);
  return {
    cash,
    equity: round2(cash + marketValue),
    marketValue: round2(marketValue),
    realized: round2(realized)
  };
}

export function summarizeStats(state, marked) {
  const closed = state.closedTrades || [];
  const wins = closed.filter((trade) => trade.pnl > 0).length;
  const losses = closed.filter((trade) => trade.pnl < 0).length;
  const breakeven = closed.length - wins - losses;
  const capital = Number(state.initialCapital) || 0;
  return {
    closedCount: closed.length,
    wins,
    losses,
    breakeven,
    winRate: closed.length ? wins / closed.length : null,
    realizedPnl: marked.realized,
    equity: marked.equity,
    cash: marked.cash,
    totalReturn: capital ? (marked.equity - capital) / capital : 0
  };
}
