#!/usr/bin/env node
/**
 * Headless paper desk. Scans, scores, and updates data/state.json.
 * Paper only: nothing here can place a real order.
 *
 *   node scripts/auto.mjs          # normal scheduled run
 *   node scripts/auto.mjs --seed   # build the book from the latest session
 *                                  # even if the cash market is closed
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessSession,
  entrySessionFor,
  formatTaipei,
  nextScheduledRuns,
  tradingDaysInclusive
} from '../lib/market.js';
import {
  closePosition,
  markToMarket,
  planExits,
  round2,
  selectExitBars,
  sharesForOrder,
  shouldOpen,
  summarizeStats
} from '../lib/portfolio.js';
import { analyzeCandidate, STRATEGY_NOTE, WATCHLIST } from '../lib/scoring.js';
import { fetchChart, fetchNews, fetchScreener, quoteFromDaily } from '../lib/yahoo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = process.env.STATE_FILE
  ? path.resolve(process.env.STATE_FILE)
  : path.join(ROOT, 'data', 'state.json');

const MAX_UNIVERSE = 40;
const CURVE_CAP = 400;
const CLOSED_CAP = 300;

function freshState() {
  const capital = Number(process.env.PAPER_CAPITAL || 10000);
  const maxPositions = Number(process.env.MAX_POSITIONS || 5);
  const maxHoldTradingDays = Number(process.env.MAX_HOLD_DAYS || 10);
  return {
    version: 1,
    disclaimer: '模擬交易，非投資建議',
    strategy: STRATEGY_NOTE,
    config: {
      paperCapital: capital,
      maxPositions,
      maxHoldTradingDays,
      currency: 'USD'
    },
    initialCapital: capital,
    cash: capital,
    equity: capital,
    marketSession: null,
    lastRun: null,
    nextRuns: [],
    openPositions: [],
    closedTrades: [],
    equityCurve: [],
    lastRanking: [],
    lastRankingAt: null,
    stats: {
      closedCount: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: null,
      realizedPnl: 0,
      equity: capital,
      cash: capital,
      totalReturn: 0
    }
  };
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return freshState();
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`data/state.json 無法解析，已停止以免覆蓋帳本（${err.message}）`);
  }
  if (!state || !Array.isArray(state.openPositions) || !Array.isArray(state.closedTrades)) {
    throw new Error('data/state.json 格式不正確，已停止以免覆蓋帳本。');
  }
  if (!state.config?.paperCapital) {
    const blank = freshState();
    state.config = blank.config;
    state.initialCapital = state.initialCapital ?? blank.initialCapital;
  }
  state.initialCapital = state.initialCapital ?? state.config.paperCapital;
  state.equityCurve = Array.isArray(state.equityCurve) ? state.equityCurve : [];
  state.lastRanking = Array.isArray(state.lastRanking) ? state.lastRanking : [];
  return state;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE_PATH);
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = { ok: true, value: await fn(items[index], index) };
      } catch (err) {
        out[index] = { ok: false, error: err };
      }
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function acceptQuote(quote) {
  if (!quote?.symbol) return false;
  if (quote.quoteType && quote.quoteType !== 'EQUITY') return false;
  if (quote.currency && quote.currency !== 'USD') return false;
  return /^[A-Z]{1,5}(-[A-Z])?$/.test(String(quote.symbol).toUpperCase());
}

function buildUniverse(gainers, actives) {
  const map = new Map();
  const add = (symbol, source) => {
    const sym = String(symbol || '').toUpperCase();
    if (!/^[A-Z]{1,5}(-[A-Z])?$/.test(sym)) return false;
    if (!map.has(sym)) {
      if (map.size >= MAX_UNIVERSE) return false;
      map.set(sym, new Set());
    }
    map.get(sym).add(source);
    return true;
  };
  for (const symbol of WATCHLIST) add(symbol, 'watch');
  for (const quote of gainers) {
    if (!acceptQuote(quote)) continue;
    add(quote.symbol, 'gainer');
  }
  for (const quote of actives) {
    if (!acceptQuote(quote)) continue;
    add(quote.symbol, 'active');
  }
  return [...map.entries()].map(([symbol, sources]) => ({ symbol, sources: [...sources] }));
}

async function probeSession() {
  const errors = [];
  for (const symbol of ['SPY', 'QQQ', 'AAPL']) {
    try {
      const daily = await fetchChart(symbol, '10d', '1d');
      const session = daily.bars.at(-1)?.session || null;
      if (session) {
        return { symbol, session, price: daily.meta?.regularMarketPrice ?? null };
      }
      errors.push(`${symbol} 沒有K線`);
    } catch (err) {
      errors.push(`${symbol} ${err.message}`);
    }
  }
  throw new Error(`無法確認美股行情：${errors.join('；')}`);
}

async function loadExitBars(symbol) {
  const daily = await fetchChart(symbol, '6mo', '1d');
  let intra = [];
  try {
    const parsed = await fetchChart(symbol, '1mo', '5m');
    intra = parsed.bars;
  } catch {
    try {
      const parsed = await fetchChart(symbol, '5d', '5m');
      intra = parsed.bars;
    } catch {
      intra = [];
    }
  }
  return { daily, bars: selectExitBars(daily.bars, intra) };
}

function uniqueReasons(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const reason of group || []) {
      if (!reason || seen.has(reason)) continue;
      seen.add(reason);
      out.push(reason);
    }
  }
  return out.slice(0, 8);
}

function applyMarks(state, sessionForDays) {
  for (const position of state.openPositions) {
    const latest = sessionForDays || position.entrySession;
    position.daysHeld = position.entrySession > latest
      ? 0
      : tradingDaysInclusive(position.entrySession, latest);
  }
  const marked = markToMarket(state);
  state.cash = marked.cash;
  state.equity = marked.equity;
  state.stats = summarizeStats(state, marked);
  state.strategy = STRATEGY_NOTE;
  state.disclaimer = '模擬交易，非投資建議';
  return marked;
}

function pushCurve(state, now, session) {
  state.equityCurve.push({
    t: now.toISOString(),
    taipei: formatTaipei(now),
    session: session || null,
    equity: state.equity,
    cash: state.cash
  });
  if (state.equityCurve.length > CURVE_CAP) {
    state.equityCurve.splice(0, state.equityCurve.length - CURVE_CAP);
  }
}

async function updateOpenPositions(state, now) {
  const closedNow = [];
  const kept = [];
  const maxHold = state.config.maxHoldTradingDays || 10;
  for (const position of state.openPositions) {
    try {
      const loaded = await loadExitBars(position.symbol);
      const lastBar = loaded.daily.bars.at(-1);
      const price = loaded.daily.meta?.regularMarketPrice;
      if (Number.isFinite(price)) position.lastPrice = price;
      else if (lastBar) position.lastPrice = lastBar.close;
      position.lastPriceTime = now.toISOString();
      const exit = planExits(position, loaded.bars, { now, maxHold });
      if (!exit) {
        kept.push(position);
        continue;
      }
      const trade = closePosition(position, exit);
      state.closedTrades.push(trade);
      closedNow.push(trade);
      console.log(`[auto] 平倉 ${trade.symbol} ${trade.exitReasonText} ${trade.pnl}`);
    } catch (err) {
      console.warn(`[auto] ${position.symbol} 檢查持倉失敗：${err.message}`);
      kept.push(position);
    }
  }
  state.openPositions = kept;
  if (state.closedTrades.length > CLOSED_CAP) {
    state.closedTrades.splice(0, state.closedTrades.length - CLOSED_CAP);
  }
  return closedNow;
}

async function scanAndRank(state, now, marketSession) {
  const scanErrors = [];
  let gainers = [];
  let actives = [];
  try {
    gainers = await fetchScreener('day_gainers', 15);
  } catch (err) {
    scanErrors.push(`漲幅榜：${err.message}`);
  }
  try {
    actives = await fetchScreener('most_actives', 10);
  } catch (err) {
    scanErrors.push(`成交榜：${err.message}`);
  }
  const universe = buildUniverse(gainers, actives);
  console.log(`[auto] 掃描 ${universe.length} 檔（漲幅 ${gainers.length}、活絡 ${actives.length}、觀察名單 ${WATCHLIST.length}）`);
  const analyzed = await mapPool(universe, 3, async (item) => {
    const daily = await fetchChart(item.symbol, '6mo', '1d');
    const quote = quoteFromDaily(item.symbol, daily);
    let newsList = [];
    try {
      newsList = await fetchNews(item.symbol);
    } catch {
      newsList = [];
    }
    const result = analyzeCandidate({
      quote,
      newsList,
      mood: 'neutral',
      extraNews: '',
      capital: state.config.paperCapital
    });
    return {
      symbol: item.symbol,
      sources: item.sources,
      name: daily.meta?.shortName || '',
      session: daily.bars.at(-1)?.session || null,
      quote,
      newsList,
      result
    };
  });

  const failures = [];
  const rows = [];
  for (let i = 0; i < universe.length; i += 1) {
    const item = analyzed[i];
    if (!item?.ok) {
      failures.push({ symbol: universe[i].symbol, error: item?.error?.message || '失敗' });
      continue;
    }
    rows.push(item.value);
  }

  rows.sort((a, b) => (
    b.result.compositeExact - a.result.compositeExact
    || b.result.sentiment.score - a.result.sentiment.score
    || b.result.scout.score - a.result.scout.score
    || a.symbol.localeCompare(b.symbol)
  ));

  const ranking = [];
  const opened = [];
  const held = new Set(state.openPositions.map((position) => position.symbol));
  for (const row of rows) {
    const { result } = row;
    const reasons = uniqueReasons(result.scout.reasons, result.news.reasons, result.sentiment.reasons);
    const cash = markToMarket(state).cash;
    const shares = sharesForOrder({
      entry: result.chart.entry,
      riskShares: result.risk.realShares,
      cash
    });
    const closedToday = state.closedTrades.some((trade) => (
      trade.symbol === row.symbol && trade.exitSession && trade.exitSession === marketSession
    ));
    let gate;
    if (marketSession && row.session && row.session !== marketSession) {
      gate = { ok: false, why: '行情日期不一致' };
    } else {
      gate = shouldOpen({
        call: result.call,
        decisionText: result.decision.text,
        riskPass: result.risk.pass,
        alreadyOpen: held.has(row.symbol),
        closedToday,
        openCount: state.openPositions.length,
        maxPositions: state.config.maxPositions,
        shares
      });
    }
    const record = {
      rank: ranking.length + 1,
      symbol: row.symbol,
      name: row.name,
      sources: row.sources,
      session: row.session,
      price: round2(row.quote.price),
      changePct: round2(row.quote.changePct),
      volume: row.quote.volume,
      scores: {
        scout: result.scout.score,
        news: result.news.score,
        sentiment: result.sentiment.score,
        composite: result.decision.avg
      },
      decision: result.call,
      action: result.decision.action,
      decisionText: result.decision.text,
      riskPass: result.risk.pass,
      suggestedShares: result.risk.realShares,
      entry: result.chart.entry,
      stop: result.chart.stop,
      target: result.chart.target,
      reasons,
      headlines: row.newsList.slice(0, 2).map((item) => item.title).filter(Boolean),
      outcome: gate.ok ? 'opened' : 'skipped',
      outcomeText: gate.why
    };
    if (gate.ok) {
      const position = {
        id: `P-${row.symbol}-${now.getTime()}-${ranking.length + 1}`,
        symbol: row.symbol,
        name: row.name,
        side: 'long',
        shares,
        entry: result.chart.entry,
        stop: result.chart.stop,
        target: result.chart.target,
        entryTime: now.toISOString(),
        entrySession: entrySessionFor(now, row.session || marketSession),
        notional: round2(shares * result.chart.entry),
        score: result.decision.avg,
        decisionText: result.decision.text,
        reasons,
        lastPrice: result.chart.entry,
        lastPriceTime: now.toISOString(),
        daysHeld: 0
      };
      state.openPositions.push(position);
      held.add(row.symbol);
      opened.push(position);
      record.shares = shares;
      console.log(`[auto] 開倉 ${position.symbol} ${shares} 股 @ ${position.entry} 停損 ${position.stop} 目標 ${position.target}`);
    }
    ranking.push(record);
  }

  state.lastRanking = ranking;
  state.lastRankingAt = now.toISOString();
  return { ranking, opened, failures, scanErrors, universe };
}

async function run(now, { seed }) {
  const state = loadState();
  const started = Date.now();
  const clock = assessSession(now);
  state.nextRuns = nextScheduledRuns(now, 3);

  let allowEntries = clock.action === 'run';
  let status = allowEntries ? 'ok' : 'skipped';
  let reason = clock.reason;
  let mode = 'auto';
  let probe = null;

  if (seed) {
    mode = 'seed';
    allowEntries = true;
    status = 'ok';
  }

  if (seed || allowEntries || state.openPositions.length) {
    try {
      probe = await probeSession();
    } catch (err) {
      if (seed || allowEntries) throw err;
      console.warn(`[auto] 休市檢查行情失敗：${err.message}`);
    }
  }

  if (!seed && clock.action === 'run') {
    if (probe.session !== clock.today) {
      allowEntries = false;
      status = 'skipped';
      reason = `今日（${clock.today}）行情尚未更新，最後交易日 ${probe.session}，不開新倉。`;
    }
  }

  const marketSession = probe?.session || state.marketSession || null;
  if (marketSession && (!state.marketSession || marketSession > state.marketSession)) {
    state.marketSession = marketSession;
  }

  const closedNow = state.openPositions.length ? await updateOpenPositions(state, now) : [];

  let scan = null;
  if (allowEntries) {
    scan = await scanAndRank(state, now, marketSession);
    if (seed) {
      const when = marketSession || clock.today;
      reason = `初始化：使用最近交易日 ${when} 的收盤資料建立模擬帳本。之後由排程在交易日自動續跑。`;
    } else if (!reason) {
      reason = `已更新 ${marketSession || clock.today} 的模擬帳本。`;
    }
    if (scan.scanErrors.length) {
      reason += ` 清單有缺：${scan.scanErrors.join(' ')}`;
    }
  }

  if (allowEntries && scan && scan.universe.length > 0 && scan.ranking.length === 0) {
    status = 'error';
    const sample = scan.failures[0] ? `${scan.failures[0].symbol} ${scan.failures[0].error}` : '';
    reason = `全部 ${scan.universe.length} 檔分析失敗。${sample}`;
  }

  applyMarks(state, state.marketSession);
  pushCurve(state, now, state.marketSession);
  state.lastRun = {
    at: now.toISOString(),
    taipei: formatTaipei(now),
    status,
    mode,
    reason,
    marketSession: state.marketSession,
    clock: clock.code,
    probed: probe?.symbol || null,
    durationMs: Date.now() - started,
    opened: (scan?.opened || []).map((position) => position.symbol),
    closed: closedNow.map((trade) => ({ symbol: trade.symbol, reason: trade.exitReason, pnl: trade.pnl })),
    scanned: scan ? scan.universe.length : 0,
    failed: (scan?.failures || []).slice(0, 8)
  };
  saveState(state);
  return state;
}

function printSummary(state) {
  const runInfo = state.lastRun;
  console.log('---');
  console.log(`[auto] ${runInfo.taipei} ${runInfo.status} ${runInfo.mode}`);
  console.log(`[auto] ${runInfo.reason}`);
  console.log(`[auto] 權益 ${state.equity} 現金 ${state.cash} 持倉 ${state.openPositions.length} 已平 ${state.closedTrades.length}`);
  const top = (state.lastRanking || []).slice(0, 8);
  for (const row of top) {
    console.log(`  #${row.rank} ${row.symbol} 綜合 ${row.scores.composite} ${row.decision} ${row.changePct}% ${row.outcomeText}`);
  }
  if (runInfo.opened?.length) console.log(`[auto] 本次開倉 ${runInfo.opened.join(', ')}`);
  else console.log('[auto] 本次沒有新開倉');
}

const seed = process.argv.includes('--seed');
run(new Date(), { seed }).then((state) => {
  printSummary(state);
  if (state.lastRun?.status === 'error') process.exitCode = 1;
}).catch((err) => {
  console.error('[auto] 失敗', err);
  try {
    const state = loadState();
    const now = new Date();
    state.nextRuns = nextScheduledRuns(now, 3);
    state.lastRun = {
      at: now.toISOString(),
      taipei: formatTaipei(now),
      status: 'error',
      mode: seed ? 'seed' : 'auto',
      reason: `執行失敗：${err.message}`,
      marketSession: state.marketSession || null
    };
    saveState(state);
  } catch (saveErr) {
    console.error('[auto] 無法寫入狀態', saveErr);
  }
  process.exitCode = 1;
});
