/**
 * US cash-session calendar (NYSE full closes) and the fixed UTC schedule.
 * Early-close days stay tradable. Years outside this table are not treated as
 * holidays; the engine then trusts whether Yahoo actually printed a new bar.
 * Source: NYSE Group holiday calendar for 2026–2028.
 */

export const TAIPEI_TZ = 'Asia/Taipei';
export const NY_TZ = 'America/New_York';

export const SCHEDULE = [
  { hour: 15, minute: 30, id: 'open', label: '開盤後' },
  { hour: 19, minute: 30, id: 'preclose', label: '收盤前' },
  { hour: 21, minute: 15, id: 'after', label: '收盤後' }
];

const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25'
]);

const EARLY_CLOSE = new Set([
  '2026-11-27', '2026-12-24',
  '2027-11-26',
  '2028-07-03', '2028-11-24'
]);

export function nyDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function nyWeekday(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'short'
  }).format(date);
}

export function nyMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  let hour = Number(parts.find((part) => part.type === 'hour').value);
  const minute = Number(parts.find((part) => part.type === 'minute').value);
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

export function formatTaipei(date) {
  const value = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(value);
}

function ymdToDate(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 17, 0, 0));
}

export function addYmd(ymd, days) {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function isHolidayYmd(ymd) {
  return HOLIDAYS.has(ymd);
}

export function isEarlyCloseYmd(ymd) {
  return EARLY_CLOSE.has(ymd);
}

export function isTradingYmd(ymd) {
  const weekday = nyWeekday(ymdToDate(ymd));
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !HOLIDAYS.has(ymd);
}

export function isTradingDay(date = new Date()) {
  return isTradingYmd(nyDateString(date));
}

export function sessionCloseMinutes(ymd) {
  return EARLY_CLOSE.has(ymd) ? 13 * 60 : 16 * 60;
}

export function isRegularHours(date = new Date()) {
  if (!isTradingDay(date)) return false;
  const ymd = nyDateString(date);
  const mins = nyMinutes(date);
  return mins >= 9 * 60 + 30 && mins < sessionCloseMinutes(ymd);
}

export function isSessionComplete(sessionYmd, now = new Date()) {
  const today = nyDateString(now);
  if (sessionYmd < today) return true;
  if (sessionYmd > today) return false;
  return nyMinutes(now) >= sessionCloseMinutes(sessionYmd);
}

export function nextTradingDay(ymd) {
  let cursor = ymd;
  for (let i = 0; i < 14; i += 1) {
    cursor = addYmd(cursor, 1);
    if (isTradingYmd(cursor)) return cursor;
  }
  return cursor;
}

export function tradingDaysInclusive(startYmd, endYmd) {
  if (!startYmd || !endYmd || endYmd < startYmd) return 0;
  let count = 0;
  let cursor = startYmd;
  for (let i = 0; i < 45 && cursor <= endYmd; i += 1) {
    if (isTradingYmd(cursor)) count += 1;
    if (cursor === endYmd) break;
    cursor = addYmd(cursor, 1);
  }
  return count;
}

export function entrySessionFor(now, priceSession) {
  if (isTradingDay(now) && isRegularHours(now)) return nyDateString(now);
  return nextTradingDay(priceSession);
}

export function assessSession(now = new Date()) {
  const today = nyDateString(now);
  const weekday = nyWeekday(now);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return {
      action: 'skip',
      code: 'weekend',
      today,
      reason: '美股週末休市，不開新倉。仍會檢查既有持倉的停損、目標與到期。'
    };
  }
  if (HOLIDAYS.has(today)) {
    return {
      action: 'skip',
      code: 'holiday',
      today,
      reason: `美股假日休市（${today}），不開新倉。仍會檢查既有持倉的停損、目標與到期。`
    };
  }
  return { action: 'run', code: 'session', today, reason: '' };
}

export function nextScheduledRuns(now = new Date(), count = 3) {
  const runs = [];
  const startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let dayOffset = 0; dayOffset < 14 && runs.length < count; dayOffset += 1) {
    const day = new Date(startUtc + dayOffset * 86400000);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const slot of SCHEDULE) {
      const when = new Date(Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        slot.hour,
        slot.minute,
        0
      ));
      if (when.getTime() <= now.getTime()) continue;
      runs.push({
        at: when.toISOString(),
        taipei: formatTaipei(when),
        label: slot.label,
        id: slot.id
      });
      if (runs.length >= count) break;
    }
  }
  return runs;
}
