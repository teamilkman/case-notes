// 法定节假日（数据来源 NateScarlet/holiday-cn）：由本站 Worker 代理并做边缘缓存，
// 浏览器只访问同源接口；本机副本在接口失败或离线时继续使用已有年份。
const PREFIX = 'case-notes:holidays:v1:';
const FRESH = 7 * 24 * 3600 * 1000;   // 联网新鲜度；过期后联网刷新，失败仍用旧副本
const memory = new Map(), pending = new Map();

function storage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

// 逐条校验接口或本机副本，避免脏数据进入日历着色。
export function holidayDays(value) {
  const out = new Map();
  for (const day of Array.isArray(value) ? value : []) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    if (typeof day.isOffDay !== 'boolean') continue;
    const name = typeof day.name === 'string' ? day.name.trim() : '';
    if (!name || name.length > 40 || out.has(day.date)) continue;
    out.set(day.date, { date: day.date, name, isOffDay: day.isOffDay });
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function read(year, now = Date.now()) {
  try {
    const raw = storage()?.getItem(PREFIX + year);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || !Array.isArray(value.days)) return null;
    return { days: holidayDays(value.days), fresh: now - (Number(value.savedAt) || 0) < FRESH };
  } catch { return null; }
}

function write(year, days, savedAt) {
  const store = storage();
  if (!store) return;
  try { store.setItem(PREFIX + year, JSON.stringify({ savedAt, days })); } catch {}
}

async function fetchYear(year) {
  const response = await fetch('/api/holidays?year=' + year, { credentials: 'same-origin', cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!body?.ok) throw new Error(body?.error?.message || '法定节假日数据读取失败');
  return body.data?.days || [];
}

// 本机已有数据可同步取用，用于切换月份时先着色再联网补齐。
export function peekHolidayYear(year) {
  return memory.get(year) ?? read(year)?.days ?? [];
}

export function loadHolidayYear(year, { force = false, fetcher = fetchYear, now = Date.now() } = {}) {
  year = Number(year);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return Promise.resolve([]);
  if (!force && pending.has(year)) return pending.get(year);
  const cached = read(year, now);
  if (!force && cached?.fresh) {
    memory.set(year, cached.days);
    return Promise.resolve(cached.days);
  }
  const job = (async () => {
    try {
      const days = holidayDays(await fetcher(year));
      memory.set(year, days);
      write(year, days, now);
      return days;
    } catch {
      // 节假日只是日历装饰：网络或认证失败时退回本机副本，没有副本时不显示标记。
      const fallback = memory.get(year) ?? cached?.days ?? [];
      memory.set(year, fallback);
      return fallback;
    } finally { pending.delete(year); }
  })();
  pending.set(year, job);
  return job;
}
