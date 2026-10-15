import { AppError, canonical, sha256, success, type Env, type Principal } from './types';
import { PARSER_VERSION } from './parser';

// Column expressions come from our SQL, never from request parameters. SQLite's
// lower() preserves LIKE's ASCII case folding without its 50-byte pattern limit.
export function contains(column: string) { return `instr(lower(${column}),lower(?))>0`; }
export const recentActivity = "COALESCE((SELECT MAX(recent_date) FROM line_index WHERE case_id=c.id),c.opened_date)";
export function caseJsonWithRecent(recent: string) { return `json_object('id',c.id,'name',c.name,'kind',c.kind,'status',c.status,
  'cause',c.cause,'case_number',c.case_number,'court',c.court,'opened_date',c.opened_date,
  'metadata_version',c.metadata_version,'document_revision',c.document_revision,
  'aliases',json(COALESCE((SELECT json_group_array(alias) FROM case_aliases WHERE case_id=c.id),'[]')),
  'recent_activity',${recent})`; }
export const caseJson = caseJsonWithRecent(recentActivity);
// Fix the driving table explicitly: D1 otherwise scans the whole workspace
// before filtering a handful of TODOs or schedules through their type index.
export function indexedLines(index: 'index_todos' | 'index_events' | 'index_record_date') {
  return `FROM line_index i INDEXED BY ${index} CROSS JOIN log_lines l CROSS JOIN cases c`;
}
export const lineRelations = 'l.id=i.line_id AND c.id=l.case_id';
export const lineJson = `json_object('line_id',l.id,'version',l.version,'text',l.raw_text,'sort_order',l.sort_order,'marker',i.marker,
  'case_id',c.id,'case_name',c.name,'case_status',c.status,'kind',i.kind,
  'date',i.record_date,'time',i.record_time,'display_text',i.display_text,
  'todo_state',i.todo_state,'due_date',i.due_date,'due_time',i.due_time,
  'event_date',i.event_date,'event_time',i.event_time,'diagnostics',json(i.diagnostics))`;
interface ReadQuery {
  sql: string; params: unknown[]; headerSql?: string; headerParams?: unknown[];
  keys: string[]; pageSize: number; full?: boolean; filters?: Record<string,unknown>; countSql?: string; countParams?: unknown[];
  caseId?: string;
  decorate?: (pageSql:string)=>string;
}
function stmt(db: D1Database, sql: string, params: unknown[] = []) { return db.prepare(sql).bind(...params); }
const encoder = new TextEncoder();
type ReadCursor = { format:1; hash:string; version:string; expires:number; total:number; offset:number; pageSize:number; key:(string|number)[] };
function base64(bytes:Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
function unbase64(value:string) { return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)); }
async function signingKey(env:Env) {
  const secret=env.WEB_PASSWORD??env.API_TOKEN;
  if(!secret)throw new AppError('SERVICE_UNAVAILABLE','读取游标配置不可用。',null,503);
  return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
async function cursorEncode(env:Env,cursor:ReadCursor) {
  const payload=base64(encoder.encode(JSON.stringify(cursor)));
  const signature=await crypto.subtle.sign('HMAC',await signingKey(env),encoder.encode(payload));
  return payload+'.'+base64(new Uint8Array(signature));
}
async function cursorDecode(env:Env,value:string,hash:string,keyCount:number,maxPageSize:number):Promise<ReadCursor> {
  let cursor:ReadCursor;
  try {
    const parts=value.split('.');
    if(parts.length===1){
      const old=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unbase64(value)));
      if(Array.isArray(old)&&old.length===2&&typeof old[0]==='string'&&Number.isInteger(old[1]))
        throw new AppError('CURSOR_EXPIRED','旧读取游标已停用，请从第一页重新读取。',null,410);
      throw 0;
    }
    if(parts.length!==2||!await crypto.subtle.verify('HMAC',await signingKey(env),unbase64(parts[1]),encoder.encode(parts[0])))throw 0;
    cursor=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unbase64(parts[0])));
    if(cursor.format!==1||cursor.hash!==hash||typeof cursor.version!=='string'
      ||!Number.isSafeInteger(cursor.expires)||!Number.isSafeInteger(cursor.total)||cursor.total<0
      ||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>cursor.total
      ||!Number.isSafeInteger(cursor.pageSize)||cursor.pageSize<1||cursor.pageSize>maxPageSize
      ||!Array.isArray(cursor.key)||cursor.key.length!==keyCount
      ||cursor.key.some(k=>typeof k!=='string'&&!(typeof k==='number'&&Number.isFinite(k))))throw 0;
  }catch(error){
    if(error instanceof AppError)throw error;
    throw new AppError('INVALID_ARGUMENT','分页游标无效或与当前客户端、工具、查询条件不匹配。');
  }
  if(cursor.expires<=Date.now())throw new AppError('CURSOR_EXPIRED','读取游标已过期，请从第一页重新读取。',null,410);
  return cursor;
}
// A browser replica proves its freshness against this workspace token instead of
// a timer. Case counters move on every committed note or metadata change, case
// creation and deletion move the count, and a parser upgrade moves the version,
// so one aggregate over the small cases table covers every cached web view
// without scanning notes or adding writes.
export async function changeToken(env: Env, workspaceId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT CAST(COUNT(*) AS TEXT)||':'||COALESCE(SUM(document_revision),0)||':'||COALESCE(SUM(metadata_version),0) AS version FROM cases WHERE workspace_id=?`)
    .bind(workspaceId).first() as {version?:string}|null;
  return `${PARSER_VERSION}:${row?.version??'0:0:0'}`;
}
export async function readQuery(env: Env, p: Principal, tool: string, args: Record<string,unknown>, q: ReadQuery) {
  const queryArgs = {...args}; delete queryArgs.cursor;
  const hash = await sha256(canonical({args:queryArgs,tool,workspace:p.workspaceId,client:p.clientId,source:p.source,case:q.caseId??null,parser:PARSER_VERSION}));
  const cursor=args.cursor?await cursorDecode(env,String(args.cursor),hash,q.keys.length,q.pageSize):null;
  const pageSize=cursor?.pageSize??q.pageSize;
  const offset=cursor?.offset??0,expires=cursor?.expires??Date.now()+15*60_000;
  const db = env.DB;
  const filters:Record<string,unknown>={...(q.filters??queryArgs)};delete filters.cursor;
  // Existing case counters increase on every committed metadata/body change.
  // Their aggregate detects workspace changes without adding writes or scanning notes.
  // Batch reads are transactional: version, metadata, count and page share one state.
  const statements=[
    stmt(db,`SELECT CAST(COUNT(*) AS TEXT)||':'||COALESCE(SUM(document_revision),0)||':'||COALESCE(SUM(metadata_version),0) AS version
      FROM cases WHERE workspace_id=?${q.caseId?' AND id=?':''}`,[p.workspaceId,...(q.caseId?[q.caseId]:[])]),
    stmt(db,q.headerSql??'SELECT ? AS payload',q.headerParams??[JSON.stringify({effective_filters:filters})]),
  ];
  if(!cursor)statements.push(stmt(db,q.countSql??`SELECT COUNT(*) AS total FROM (${q.sql})`,q.countParams??q.params));
  const pageSql=`SELECT ${q.decorate?'*':`row_json,${q.keys.join(',')}`} FROM (${q.sql})${cursor?` WHERE (${q.keys.join(',')})>(${q.keys.map(()=>'?').join(',')})`:''}
    ORDER BY ${q.keys.join(',')} LIMIT ?`;
  statements.push(stmt(db,q.decorate?q.decorate(pageSql):pageSql,[...q.params,...(cursor?.key??[]),pageSize+1]));
  const results=await db.batch(statements);
  const version=String((results[0].results[0] as any).version);
  if(cursor&&version!==cursor.version)throw new AppError('READ_CHANGED','读取期间相关数据已变化，请丢弃已收集的页并从第一页重新读取。',null,409);
  if(!results[1].results.length)throw new AppError('CASE_NOT_FOUND','案件已不存在，请重新查询。',null,404);
  const header=JSON.parse((results[1].results[0] as any).payload);
  const total=cursor?.total??Number((results[2].results[0] as any).total);
  const candidates=results[results.length-1].results as any[],selected:any[]=[];
  let bytes=encoder.encode(JSON.stringify(header)).length;
  for(const row of candidates.slice(0,pageSize)){
    const size=encoder.encode(row.row_json).length;
    if(q.full&&selected.length&&bytes+size>160_000)break;
    selected.push(row);bytes+=size;
  }
  const rows=selected.map(x=>JSON.parse(x.row_json));
  if(!rows.length&&offset<total)throw new AppError('READ_CHANGED','读取结果已变化，请从第一页重新读取。',null,409);
  const hasMore = offset + rows.length < total;
  const next=hasMore?await cursorEncode(env,{format:1,hash,version,expires,total,offset:offset+rows.length,
    pageSize:q.full?Math.min(pageSize,rows.length):pageSize,key:q.keys.map(k=>selected[selected.length-1][k])}):null;
  const data: any = { ...header, matched_count:total, returned_count:rows.length,
    has_more:hasMore, next_cursor:next,snapshot_id:null, page_start:offset, complete:true };
  if (tool === 'cases_get') { data.lines = rows; data.total_lines = total; }
  else data.items = rows;
  return success(data);
}
