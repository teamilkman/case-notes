import { AppError } from './types';

// 法定节假日数据来自 NateScarlet/holiday-cn（每日抓取国务院公告）。
// 浏览器只请求本站接口，由 Worker 直接按年读取 GitHub 原始地址并写入边缘缓存，
// 客户端不直连 GitHub，也不依赖第三方 CDN 或国内加速节点。
const REPO = 'NateScarlet/holiday-cn';
const source = (year: number) => `https://raw.githubusercontent.com/${REPO}/master/${year}.json`;
const MIN_YEAR = 1900, MAX_YEAR = 2200;
const HIT_TTL = 6 * 3600, MISS_TTL = 3600, TIMEOUT = 8000;

export interface HolidayDay { name: string; date: string; isOffDay: boolean; }
export interface HolidayYear { days: HolidayDay[]; published: boolean; updated_at: string; }
export interface HolidayCalendar { year: number; days: HolidayDay[]; published: boolean; updated_at: string; }

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
interface Deps { fetcher?: Fetcher; cache?: Cache | null; now?: Date; }

const cacheKey = (year: number) => new Request(`https://holiday-cn.invalid/years/${year}`);

// 只接受带节名、ISO 日期和布尔休息标记的条目；年度文件的日期可能覆盖相邻年份，
// 由调用方按需要的年份筛选（国务院文件按标题年份划分，12 月可能受下一年文件影响）。
function parseYear(text: string, year: number): HolidayDay[] | null {
  let raw: any;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || Number(raw.year) !== year || !Array.isArray(raw.days)) return null;
  const days: HolidayDay[] = [];
  for (const day of raw.days) {
    if (!day || typeof day.name !== 'string' || typeof day.isOffDay !== 'boolean') continue;
    const name = day.name.trim();
    if (!name || name.length > 40) continue;
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    const time = Date.parse(`${day.date}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day.date) continue;
    days.push({ name, date: day.date, isOffDay: day.isOffDay });
  }
  return days;
}

// null 表示暂时无法读取（网络、非 200 或响应异常）；空数组表示该年尚未发布数据。
async function fetchYear(year: number, fetcher: Fetcher): Promise<HolidayDay[] | null> {
  let response: Response;
  try {
    response = await fetcher(source(year), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch { return null; }
  if (response.status === 404) { try { await response.body?.cancel(); } catch {} return []; }
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return null; }
  let text: string;
  try { text = await response.text(); } catch { return null; }
  return parseYear(text, year);
}

export async function readHolidayYear(year: number, ctx?: ExecutionContext, deps: Deps = {}): Promise<HolidayYear> {
  const cache = deps.cache ?? (typeof caches === 'undefined' ? null : (caches as any).default as Cache | undefined) ?? null;
  const key = cacheKey(year);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return await hit.json() as HolidayYear;
    } catch {}
  }
  const days = await fetchYear(year, deps.fetcher ?? fetch);
  if (days === null) throw new AppError('SERVICE_UNAVAILABLE', '法定节假日数据暂时无法读取。',
    { year, source: `https://github.com/${REPO}` }, 503, true);
  const result: HolidayYear = { days, published: days.length > 0, updated_at: (deps.now ?? new Date()).toISOString() };
  if (cache) {
    const ttl = result.published ? HIT_TTL : MISS_TTL;
    const stored = new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    });
    const job = cache.put(key, stored);
    if (ctx) ctx.waitUntil(job); else await job;
  }
  return result;
}

// 返回该年份可见的全部节假日；同时读取下一年文件，补齐 12 月由下一年公告确定的调休。
export async function holidayCalendar(year: number, ctx?: ExecutionContext, deps: Deps = {}): Promise<HolidayCalendar> {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    return { year, days: [], published: false, updated_at: (deps.now ?? new Date()).toISOString() };
  }
  const own = await readHolidayYear(year, ctx, deps);
  const next = year < MAX_YEAR ? await readHolidayYear(year + 1, ctx, deps).catch(() => null) : null;
  const byDate = new Map<string, HolidayDay>();
  for (const list of [own.days, next?.days ?? []]) {
    for (const day of list) {
      if (!day.date.startsWith(`${year}-`) || byDate.has(day.date)) continue;
      byDate.set(day.date, day);
    }
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { year, days, published: days.length > 0, updated_at: own.updated_at };
}
