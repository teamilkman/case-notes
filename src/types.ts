import { PARSER_VERSION } from './parser';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WEB_PASSWORD?: string;
  WORKSPACE_ID?: string;
}
export interface Principal {
  workspaceId: string;
  clientId: string;
  actorId: string;
  source: 'ai' | 'web';
  webSession?: {cacheScope:string;expiresAt:string;cookieUpgrade?:string[]};
}
export interface CaseRow {
  id: string; workspace_id: string; name: string;
  kind: 'case' | 'affair'; status: '在办' | '结案' | '结案未整卷' | '解除委托';
  cause: string | null; case_number: string | null; court: string | null;
  opened_date: string | null; metadata_version: number; document_revision: number;
  created_at: string; updated_at: string;
}
export interface LineRow {
  id: string; workspace_id: string; case_id: string; sort_order: number;
  raw_text: string; version: number; created_at: string; updated_at: string;
  deleted_at: string | null; source_operation_id: string;
}
export class AppError extends Error {
  constructor(public code: string, message: string, public details: unknown = null,
    public status = 400, public retryable = false, public commitState = 'not_committed') {
    super(message);
  }
}
export function localClock(now = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`, timezone: 'Asia/Shanghai' };
}
export function meta() { return { ...localClock(), api_version: '1', parser_version: PARSER_VERSION }; }
export function success(data: unknown) { return { ok: true as const, data, error: null, meta: meta() }; }
export function failure(error: unknown) {
  const quota=error instanceof Error && /exceeded.*(?:daily row (?:read|write) limit|daily (?:read|write) limit)/i.test(error.message);
  const reset=new Date();reset.setUTCHours(24,0,0,0);
  const e = error instanceof AppError ? error : quota ? new AppError('DAILY_LIMIT_EXCEEDED',
    '今日数据访问额度已用尽，请等待重置后继续。', {resets_at:reset.toISOString()},503,false,'unknown') : new AppError('SERVICE_UNAVAILABLE',
    '服务暂时不可用，请保留原请求键重试。', null, 503, true, 'unknown');
  return { ok: false as const, data: null, error: { code: e.code, message: e.message,
    details: e.details, retryable: e.retryable, commit_state: e.commitState,
    next_action: e.code === 'VERSION_CONFLICT' ? '重新读取并核对当前文字，明确更正后用新键提交。'
        : e.code === 'READ_CHANGED' || e.code === 'CURSOR_EXPIRED' ? '丢弃已收集的页，清除 cursor，按原查询条件从第一页重新读取；不要拼接新旧页。'
      : e.code === 'DAILY_LIMIT_EXCEEDED' ? '停止即时重试，待 details.resets_at 后再读取；写入用原 request_key 和原参数核对回执。'
      : e.code === 'CASE_AMBIGUOUS' ? '选择明确的案件 ID 后再调用。'
      : e.retryable ? '保留原 request_key 与原参数，按退避提示重试。' : e.message }, meta: meta() };
}
export async function sha256(text: string) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(result)].map(b => b.toString(16).padStart(2,'0')).join('');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
