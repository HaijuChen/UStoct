/**
 * Shared desk scoring. The phone UI and the headless paper engine both call
 * analyzeCandidate(), so a "buy" means the same thing in both places.
 * Auto runs pass mood "neutral" and no extra news text.
 */

export const STRATEGY_NOTE =
  '停損 3.5%，目標為風險的 1.8 倍，單筆最大虧損為資金的 1.5%。自動路徑把社群情緒視為中性。';

export const WATCHLIST = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'BRK-B',
  'JPM', 'LLY', 'V', 'UNH', 'XOM', 'MA', 'COST', 'HD', 'JNJ', 'PG', 'NFLX'
];

export function buildQuote({ symbol, price, previousClose, volume }) {
  const prev = Number.isFinite(previousClose) && previousClose > 0 ? previousClose : price;
  const change = price - prev;
  const changePct = prev ? (change / prev) * 100 : 0;
  return {
    symbol,
    price,
    change,
    changePct,
    volume: volume || 0,
    prev
  };
}

export function previousCloseFromBars(bars, meta) {
  const closes = (bars || []).filter((bar) => Number.isFinite(bar.close));
  if (closes.length >= 2) return closes[closes.length - 2].close;
  const fallback = meta?.chartPreviousClose ?? meta?.previousClose;
  return Number.isFinite(fallback) ? fallback : null;
}

export function analyzeNewsPolarity(text) {
  const t = (text || '').toLowerCase();
  let bull = 0;
  let bear = 0;
  const bullWords = ['beat', '優於', '超預期', '升評', 'upgrade', '突破', '新高', '利多', '成長', '強勁', 'record', 'surge', 'soars', 'rally', 'bullish', 'positive', 'strong', 'growth', 'outperform', 'raise', 'buy'];
  const bearWords = ['miss', '低於', '降評', 'downgrade', '調查', '訴訟', '裁員', '虧損', '利空', '疲弱', 'delay', 'falls', 'drop', 'plunge', 'bearish', 'negative', 'weak', 'cut', 'sell', 'lawsuit', 'probe'];
  bullWords.forEach((word) => { if (t.includes(word)) bull += 1; });
  bearWords.forEach((word) => { if (t.includes(word)) bear += 1; });
  return { bull, bear, net: bull - bear };
}

export function judgeScout(q) {
  let score = 50;
  const reasons = [];
  if (Math.abs(q.changePct) >= 5) { score += 20; reasons.push('單日波動 ≥5%'); }
  else if (Math.abs(q.changePct) >= 3) { score += 12; reasons.push('單日波動 ≥3%'); }
  else if (Math.abs(q.changePct) >= 1.5) { score += 5; reasons.push('有一定波動'); }
  else { score -= 10; reasons.push('波動較小'); }
  if (q.changePct > 0) { score += 8; reasons.push('今日上漲'); }
  else { score -= 5; reasons.push('今日下跌'); }
  if (q.volume > 5e6) { score += 10; reasons.push('成交量較大'); }
  else if (q.volume > 1e6) { score += 5; reasons.push('成交量尚可'); }
  score = Math.max(0, Math.min(100, score));
  const text = score >= 70 ? '機會分數較高' : (score >= 45 ? '中等機會' : '機會較弱');
  return { score, text, reasons };
}

export function judgeNews(text, newsList) {
  const combined = (text || '') + ' ' + (newsList || []).map((item) => item.title).join(' ');
  if (!combined.trim()) return { score: 50, text: '無新聞，中性', reasons: [], items: [] };
  const pol = analyzeNewsPolarity(combined);
  let score = 50 + pol.net * 12;
  score = Math.max(0, Math.min(100, score));
  const reasons = [];
  if (pol.bull) reasons.push('利多關鍵字 ×' + pol.bull);
  if (pol.bear) reasons.push('利空關鍵字 ×' + pol.bear);
  const txt = score >= 65 ? '新聞偏利多' : (score >= 40 ? '新聞中性' : '新聞偏利空');
  return { score, text: txt, reasons, items: newsList || [], polarity: pol };
}

/**
 * 市場情緒：新聞極性、價格動能、成交量、手動社群感覺（自動路徑請傳 neutral）。
 * 大漲但新聞撐不住，或手動選了過熱，會扣分。
 */
export function judgeSentiment(mood, q, newsResult) {
  const reasons = [];
  let priceScore = 50;

  if (q.changePct >= 5) { priceScore = 88; reasons.push('強勢上漲 ≥5%'); }
  else if (q.changePct >= 3) { priceScore = 78; reasons.push('明顯上漲 ≥3%'); }
  else if (q.changePct >= 1.5) { priceScore = 68; reasons.push('溫和上漲'); }
  else if (q.changePct >= 0.3) { priceScore = 58; reasons.push('小幅上漲'); }
  else if (q.changePct > -0.3) { priceScore = 50; reasons.push('幾乎平盤'); }
  else if (q.changePct > -1.5) { priceScore = 42; reasons.push('小幅下跌'); }
  else if (q.changePct > -3) { priceScore = 32; reasons.push('明顯下跌'); }
  else if (q.changePct > -5) { priceScore = 22; reasons.push('大幅下跌'); }
  else { priceScore = 12; reasons.push('重挫 ≤-5%'); }

  let newsScore = 50;
  if (newsResult && newsResult.polarity) {
    const net = newsResult.polarity.net;
    newsScore = Math.max(0, Math.min(100, 50 + net * 14));
    if (net > 0) reasons.push('新聞淨利多 +' + net);
    else if (net < 0) reasons.push('新聞淨利空 ' + net);
    else reasons.push('新聞極性中性');
  } else {
    reasons.push('無足夠新聞參考');
  }

  let volBoost = 0;
  if (q.volume > 8e6) { volBoost = 8; reasons.push('成交量明顯放大'); }
  else if (q.volume > 3e6) { volBoost = 4; reasons.push('成交量偏高'); }

  let moodAdj = 0;
  if (mood === 'bullish') { moodAdj = 6; reasons.push('你選擇理性偏多'); }
  else if (mood === 'hype') { moodAdj = -12; reasons.push('你感覺過熱'); }
  else if (mood === 'bearish') { moodAdj = -8; reasons.push('你選擇偏空'); }

  let hypePenalty = 0;
  if (q.changePct >= 4 && mood === 'hype') {
    hypePenalty = -15;
    reasons.push('⚠ 大漲 + 過熱 → 追高風險');
  } else if (q.changePct >= 5 && newsScore < 55) {
    hypePenalty = -8;
    reasons.push('⚠ 大漲但新聞支撐不足');
  }

  let score = priceScore * 0.38 + newsScore * 0.42 + 50 * 0.10 + moodAdj + volBoost + hypePenalty;
  score = Math.round(Math.max(5, Math.min(95, score)));

  let text;
  if (score >= 75) text = '情緒偏多且有支撐';
  else if (score >= 62) text = '情緒偏樂觀';
  else if (score >= 48) text = '情緒中性偏觀望';
  else if (score >= 35) text = '情緒偏保守 / 謹慎';
  else text = '情緒偏空或過熱警戒';

  return { score, text, reasons, priceScore, newsScore };
}

export function judgeChart(q) {
  const entry = q.price;
  const stop = +(entry * 0.965).toFixed(2);
  const risk = entry - stop;
  const target = +(entry + risk * 1.8).toFixed(2);
  return { entry: +entry.toFixed(2), stop, target, rr: 1.8 };
}

export function judgeRisk(chart, realCap) {
  const perShare = chart.entry - chart.stop;
  const realMaxLoss = realCap * 0.015;
  const realShares = perShare > 0 ? Math.max(0, Math.floor(realMaxLoss / perShare)) : 0;
  const realNotional = +(realShares * chart.entry).toFixed(0);
  const pass = realShares >= 1 || realNotional >= 5;
  return { realShares, realNotional, maxLossReal: +realMaxLoss.toFixed(2), pass };
}

export function judgeDecision(scout, news, sent, risk) {
  const avg = (scout.score + news.score + sent.score) / 3;
  let action;
  let text;
  if (!risk.pass) { action = 'reject'; text = '拒絕：風險部位不合理'; }
  else if (avg >= 68 && scout.score >= 55 && sent.score >= 50) { action = 'approve'; text = '批准執行'; }
  else if (avg >= 52) { action = 'reduce'; text = '縮小部位執行'; }
  else { action = 'reject'; text = '拒絕：綜合分數偏低'; }
  return { action, text, avg: +avg.toFixed(0) };
}

export function analyzeCandidate({ quote, newsList = [], mood = 'neutral', extraNews = '', capital = 100 }) {
  const scout = judgeScout(quote);
  const news = judgeNews(extraNews, newsList);
  const sentiment = judgeSentiment(mood, quote, news);
  const chart = judgeChart(quote);
  const risk = judgeRisk(chart, capital);
  const decision = judgeDecision(scout, news, sentiment, risk);
  const call = decision.action === 'approve' ? 'buy' : (decision.action === 'reduce' ? 'reduce' : 'skip');
  const compositeExact = (scout.score + news.score + sentiment.score) / 3;
  return { scout, news, sentiment, chart, risk, decision, call, compositeExact };
}
