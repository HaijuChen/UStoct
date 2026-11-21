/**
 * Server-side Yahoo Finance reads. No key, no CORS proxy.
 * A browser User-Agent is required; the default client is rejected.
 */

import { nyDateString } from './market.js';
import { buildQuote, previousCloseFromBars } from './scoring.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function yahooGet(url, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(20000)
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(400 * (attempt + 1));
      return yahooGet(url, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Yahoo HTTP ${res.status} ${text.slice(0, 140)}`);
    }
    return await res.json();
  } catch (err) {
    const transient = err.name === 'TimeoutError' || err.name === 'AbortError' || /network|fetch failed|ECONN|ETIMEDOUT/i.test(err.message || '');
    if (transient && attempt < 2) {
      await sleep(400 * (attempt + 1));
      return yahooGet(url, attempt + 1);
    }
    throw err;
  }
}

export function parseChart(data) {
  const result = data?.chart?.result?.[0];
  if (!result) {
    const description = data?.chart?.error?.description || '沒有圖表資料';
    throw new Error(description);
  }
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = quote.close?.[i];
    if (!Number.isFinite(close)) continue;
    const time = timestamps[i] * 1000;
    bars.push({
      time,
      session: nyDateString(new Date(time)),
      open: Number.isFinite(quote.open?.[i]) ? quote.open[i] : null,
      high: quote.high?.[i],
      low: quote.low?.[i],
      close,
      volume: quote.volume?.[i] ?? 0
    });
  }
  return { meta: result.meta || {}, bars };
}

export async function fetchChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const data = await yahooGet(url);
  return parseChart(data);
}

export function quoteFromDaily(symbol, parsed) {
  const price = parsed.meta?.regularMarketPrice;
  if (!Number.isFinite(price)) throw new Error(`${symbol} 無報價`);
  const previousClose = previousCloseFromBars(parsed.bars, parsed.meta) || price;
  const volume = parsed.meta?.regularMarketVolume || parsed.bars.at(-1)?.volume || 0;
  return buildQuote({ symbol, price, previousClose, volume });
}

export async function fetchNews(symbol) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=6&quotesCount=0`;
  const data = await yahooGet(url);
  return (data.news || []).slice(0, 5).map((item) => ({
    title: item.title || '',
    link: item.link || ''
  })).filter((item) => item.title);
}

export async function fetchScreener(scrId, count) {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(scrId)}&count=${count}&formatted=false`;
  const data = await yahooGet(url);
  const quotes = data?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(quotes)) throw new Error(`${scrId} 沒有清單`);
  return quotes;
}
