import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  assessSession,
  formatTaipei,
  isRegularHours,
  nextScheduledRuns,
  nextTradingDay,
  tradingDaysInclusive
} from '../lib/market.js';
import {
  closePosition,
  markToMarket,
  planExits,
  selectExitBars,
  sharesForOrder,
  shouldOpen
} from '../lib/portfolio.js';
import { analyzeCandidate } from '../lib/scoring.js';

const strongQuote = {
  symbol: 'TEST',
  price: 100,
  change: 6,
  changePct: 6,
  volume: 10e6,
  prev: 94
};
const strongNews = [{ title: 'Company beat expectations and upgrade to buy, record growth' }];

test('strong neutral setup is a buy with the existing size', () => {
  const result = analyzeCandidate({
    quote: strongQuote,
    newsList: strongNews,
    mood: 'neutral',
    extraNews: '',
    capital: 10000
  });
  assert.equal(result.scout.score, 88);
  assert.equal(result.news.score, 100);
  assert.equal(result.sentiment.score, 88);
  assert.equal(result.decision.avg, 92);
  assert.equal(result.decision.action, 'approve');
  assert.equal(result.call, 'buy');
  assert.equal(result.chart.entry, 100);
  assert.equal(result.chart.stop, 96.5);
  assert.equal(result.chart.target, 106.3);
  assert.equal(result.risk.realShares, 42);
  assert.equal(result.risk.pass, true);
  assert.equal(result.sentiment.reasons.some((reason) => reason.includes('你選擇') || reason.includes('你感覺')), false);
});

test('manual hype mood scores below a neutral read of the same tape', () => {
  const neutral = analyzeCandidate({ quote: strongQuote, newsList: strongNews, mood: 'neutral', capital: 10000 });
  const hype = analyzeCandidate({ quote: strongQuote, newsList: strongNews, mood: 'hype', capital: 10000 });
  assert.ok(hype.sentiment.score < neutral.sentiment.score);
  assert.ok(hype.sentiment.reasons.some((reason) => reason.includes('你感覺過熱')));
});

test('quiet tape and too-small capital are not buys', () => {
  const quiet = analyzeCandidate({
    quote: { symbol: 'QUIET', price: 50, change: 0.05, changePct: 0.1, volume: 1e5, prev: 49.95 },
    newsList: [],
    mood: 'neutral',
    capital: 10000
  });
  assert.equal(quiet.call, 'skip');
  assert.equal(quiet.decision.action, 'reject');

  const tiny = analyzeCandidate({
    quote: strongQuote,
    newsList: strongNews,
    mood: 'neutral',
    capital: 10
  });
  assert.equal(tiny.risk.pass, false);
  assert.equal(tiny.call, 'skip');
  assert.match(tiny.decision.text, /風險/);
});

test('calendar skips weekends and NYSE holidays, keeps early closes', () => {
  assert.equal(assessSession(new Date('2026-11-21T14:00:00Z')).code, 'weekend');
  assert.equal(assessSession(new Date('2026-11-26T15:00:00Z')).code, 'holiday');
  assert.equal(assessSession(new Date('2026-11-27T15:00:00Z')).code, 'session');
  assert.equal(nextTradingDay('2026-11-20'), '2026-11-23');
  assert.equal(nextTradingDay('2026-11-25'), '2026-11-27');
  assert.equal(nextTradingDay('2026-12-24'), '2026-12-28');
  assert.equal(nextTradingDay('2026-12-31'), '2027-01-04');
  assert.equal(tradingDaysInclusive('2026-11-16', '2026-11-20'), 5);
  assert.equal(tradingDaysInclusive('2026-11-16', '2026-11-30'), 10);
  assert.equal(isRegularHours(new Date('2026-11-27T16:00:00Z')), true);
  assert.equal(isRegularHours(new Date('2026-11-27T18:30:00Z')), false);
});

test('next run follows the fixed UTC slots and Taipei labels', () => {
  const monday = nextScheduledRuns(new Date('2026-11-23T15:00:00Z'), 3);
  assert.deepEqual(monday.map((run) => run.at), [
    '2026-11-23T15:30:00.000Z',
    '2026-11-23T19:30:00.000Z',
    '2026-11-23T21:15:00.000Z'
  ]);
  assert.deepEqual(monday.map((run) => run.label), ['開盤後', '收盤前', '收盤後']);
  assert.match(formatTaipei(monday[0].at), /23:30/);

  const afterFriday = nextScheduledRuns(new Date('2026-11-20T21:16:00Z'), 1);
  assert.equal(afterFriday[0].at, '2026-11-23T15:30:00.000Z');

  const summer = nextScheduledRuns(new Date('2026-07-06T15:00:00Z'), 1);
  assert.equal(summer[0].at, '2026-07-06T15:30:00.000Z');
});

function dailyBar(ymd, close, extra = {}) {
  const [year, month, day] = ymd.split('-').map(Number);
  return {
    time: Date.UTC(year, month - 1, day, 14, 30, 0),
    session: ymd,
    open: extra.open ?? close,
    high: extra.high ?? close,
    low: extra.low ?? close,
    close
  };
}

const position = {
  symbol: 'TEST',
  entry: 100,
  stop: 96.5,
  target: 106.3,
  shares: 42,
  entrySession: '2026-11-16',
  entryTime: '2026-11-16T13:00:00.000Z',
  score: 90,
  reasons: ['測試']
};

test('exits: stop, gap, same-bar conflict, and the 10-session time stop', () => {
  const stop = planExits(position, [
    dailyBar('2026-11-16', 100, { high: 101, low: 99 }),
    dailyBar('2026-11-17', 97, { open: 100, high: 101, low: 96 })
  ], { now: new Date('2026-11-17T21:00:00Z'), maxHold: 10 });
  assert.equal(stop.reason, 'stop');
  assert.equal(stop.exitPrice, 96.5);

  const gap = planExits(position, [
    dailyBar('2026-11-17', 89, { open: 90, high: 91, low: 88 })
  ], { now: new Date('2026-11-17T21:00:00Z'), maxHold: 10 });
  assert.equal(gap.reason, 'stop');
  assert.equal(gap.exitPrice, 90);

  const both = planExits(position, [
    dailyBar('2026-11-17', 100, { open: 100, high: 120, low: 90 })
  ], { now: new Date('2026-11-17T21:00:00Z'), maxHold: 10 });
  assert.equal(both.reason, 'stop');
  assert.equal(both.exitPrice, 96.5);

  const ignored = planExits({
    ...position,
    entryTime: '2026-11-16T18:00:00.000Z'
  }, [
    dailyBar('2026-11-16', 90, { open: 100, high: 100, low: 80 })
  ], { now: new Date('2026-11-16T21:00:00Z'), maxHold: 10 });
  assert.equal(ignored, null);

  const sessions = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30'];
  const flat = sessions.map((ymd) => dailyBar(ymd, 100, { high: 101, low: 99 }));
  const tooSoon = planExits(position, flat, { now: new Date('2026-11-30T15:30:00Z'), maxHold: 10 });
  assert.equal(tooSoon, null);
  const timed = planExits(position, flat, { now: new Date('2026-12-01T15:00:00Z'), maxHold: 10 });
  assert.equal(timed.reason, 'time');
  assert.equal(timed.exitSession, '2026-11-30');
  assert.equal(timed.exitPrice, 100);

  const trade = closePosition(position, timed);
  assert.equal(trade.exitReasonText, '持有到期');
  assert.equal(trade.pnl, 0);
});

test('intraday bars replace the daily bar of the same session', () => {
  const daily = [dailyBar('2026-11-16', 100, { high: 130, low: 70 })];
  const intra = [{
    time: Date.parse('2026-11-16T16:00:00Z'),
    session: '2026-11-16',
    open: 100,
    high: 101,
    low: 99,
    close: 100.4
  }];
  const merged = selectExitBars(daily, intra);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].high, 101);
});

test('sizing respects cash, slots, and duplicate symbols', () => {
  assert.equal(sharesForOrder({ entry: 100, riskShares: 42, cash: 10000 }), 42);
  assert.equal(sharesForOrder({ entry: 100, riskShares: 42, cash: 250 }), 2);
  assert.equal(sharesForOrder({ entry: 100, riskShares: 42, cash: 50 }), 0);
  assert.equal(shouldOpen({
    call: 'buy', decisionText: '批准執行', riskPass: true,
    alreadyOpen: false, closedToday: false, openCount: 1, maxPositions: 5, shares: 10
  }).ok, true);
  assert.equal(shouldOpen({
    call: 'reduce', decisionText: '縮小部位執行', riskPass: true,
    alreadyOpen: false, closedToday: false, openCount: 0, maxPositions: 5, shares: 10
  }).ok, false);
  assert.match(shouldOpen({
    call: 'buy', decisionText: '批准執行', riskPass: true,
    alreadyOpen: true, closedToday: false, openCount: 1, maxPositions: 5, shares: 10
  }).why, /已有持倉/);
});

test('mark to market keeps equity flat at the fill and books realized pnl', () => {
  const open = markToMarket({
    initialCapital: 10000,
    openPositions: [{ entry: 100, shares: 42, lastPrice: 100 }],
    closedTrades: []
  });
  assert.equal(open.cash, 5800);
  assert.equal(open.equity, 10000);

  const up = markToMarket({
    initialCapital: 10000,
    openPositions: [{ entry: 100, shares: 42, lastPrice: 110 }],
    closedTrades: []
  });
  assert.equal(up.equity, 10420);

  const closed = closePosition(position, {
    exitPrice: 106.3,
    reason: 'target',
    exitTime: '2026-11-17T20:00:00Z',
    exitSession: '2026-11-17',
    holdDays: 2
  });
  assert.equal(closed.pnl, 264.6);
  const after = markToMarket({
    initialCapital: 10000,
    openPositions: [],
    closedTrades: [closed]
  });
  assert.equal(after.cash, 10264.6);
  assert.equal(after.equity, 10264.6);
});

test('the page and workflow stay paper-only and on the agreed schedule', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /模擬交易，非投資建議/);
  assert.match(html, /lib\/scoring\.js/);
  assert.match(html, /data\/state\.json/);
  assert.match(html, /id="tabAuto"/);
  assert.match(html, /id="tabRoom"/);

  const yml = fs.readFileSync(new URL('../.github/workflows/auto-desk.yml', import.meta.url), 'utf8');
  assert.match(yml, /30 15 \* \* 1-5/);
  assert.match(yml, /30 19 \* \* 1-5/);
  assert.match(yml, /15 21 \* \* 1-5/);
  assert.match(yml, /contents:\s*write/);
  assert.match(yml, /\[skip ci\]/);
  assert.match(yml, /workflow_dispatch/);
  assert.doesNotMatch(yml, /^\s*push:/m);
  assert.doesNotMatch(yml, /broker|order|alpaca|ibkr/i);
});
