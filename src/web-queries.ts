import { z } from 'zod';
import { caseJsonWithRecent, recentActivity, lineJson, contains, indexedLines, lineRelations } from './queries';
import { AppError, canonical, sha256, success, type Env, type Principal } from './types';
import { webCalendarDatesSchema } from './schemas';

const date=z.iso.date();
const paging={limit:z.number().int().min(1).max(100).default(20),cursor:z.string().max(4096).optional()};
const schemas={
  cases:z.object({...paging,group:z.enum(['active','archived','affairs']).default('active'),query:z.string().max(300).default('')}).strict(),
  schedules:z.object({...paging,mode:z.enum(['all','future','history']).default('all'),today:date,from_date:date.optional(),to_date:date.optional()}).strict(),
  todos:z.object(paging).strict(),
  activity:z.object({...paging,today:date,days:z.union([z.literal(7),z.literal(30)])}).strict(),
  stats:z.object({today:date}).strict(),
  'calendar-counts':z.object({}).strict(),
  'calendar-dates':webCalendarDatesSchema,
};
const stmt=(env:Env,sql:string,params:unknown[]=[])=>env.DB.prepare(sql).bind(...params);
const joined='FROM cases c JOIN log_lines l ON l.case_id=c.id JOIN line_index i ON i.line_id=l.id';
const todos=`${indexedLines('index_todos')} WHERE ${lineRelations}`;
const events=`${indexedLines('index_events')} WHERE ${lineRelations}`;
const records=`${indexedLines('index_record_date')} WHERE ${lineRelations}`;
const valid="c.workspace_id=? AND l.workspace_id=c.workspace_id AND l.deleted_at IS NULL AND i.source_line_version=l.version";
// Browser lists are live keyset pages. AI reads also validate versions across pages.
// A cursor is bound to its filters; it carries no SQL or user-controlled scope.
export async function webRead(env:Env,p:Principal,name:string,input:unknown){
  if(p.source!=='web')throw new AppError('PERMISSION_DENIED','此接口用于网页。',null,403);
  if(!Object.hasOwn(schemas,name))throw new AppError('INVALID_ARGUMENT','接口不存在。',null,404);
  const parsed=schemas[name as keyof typeof schemas].safeParse(input);
  if(!parsed.success)throw new AppError('INVALID_ARGUMENT','参数格式不正确。',parsed.error.issues);
  const a:any=parsed.data,params:unknown[]=[p.workspaceId];
  if(name==='stats'){
    const results=await env.DB.batch([
      stmt(env,`SELECT SUM(kind='case' AND status='在办') AS active,SUM(kind='case' AND status<>'在办') AS archived,SUM(kind='affair') AS affairs FROM cases WHERE workspace_id=?`,params),
      stmt(env,`SELECT COUNT(*) AS todos ${todos} AND ${valid} AND c.status='在办' AND i.kind='todo'`,params),
      stmt(env,`SELECT SUM(i.event_date>=?) AS future,SUM(substr(i.event_date,1,7)=substr(?,1,7)) AS month ${events} AND ${valid} AND c.kind='case' AND i.kind='schedule' AND i.event_date>=date(?,'start of month')`,[a.today,a.today,...params,a.today]),
      stmt(env,`SELECT SUM(i.record_date>=date(?,'-7 days')) AS activity_7,COUNT(*) AS activity_30 ${records} AND ${valid} AND i.record_date BETWEEN date(?,'-30 days') AND ?`,[a.today,...params,a.today,a.today]),
    ]);
    const counts:Record<string,unknown>=Object.assign({},...results.map(r=>r.results[0]));
    for(const k of Object.keys(counts))counts[k]=Number(counts[k]??0);
    return success({counts});
  }
  if(name==='calendar-counts'){
    const r=await stmt(env,`SELECT i.event_date AS date,COUNT(*) AS count ${events} AND ${valid} AND c.kind='case' AND i.kind='schedule' AND i.event_date IS NOT NULL GROUP BY i.event_date`,params).all();
    return success({items:r.results});
  }
  let from:string,where:string,key:string,row:string;
  if(name==='calendar-dates'){
    const range=[p.workspaceId,a.from_date,a.to_date];
    const candidates=[
      `SELECT i.line_id,i.record_date AS calendar_date,i.record_time AS calendar_time ${records} AND ${valid} AND i.record_date BETWEEN ? AND ? AND i.kind<>'schedule' AND (i.kind<>'todo' OR i.due_date IS NULL)`,
      `SELECT i.line_id,i.due_date,i.due_time ${todos} AND ${valid} AND i.kind='todo' AND i.due_date BETWEEN ? AND ?`,
      `SELECT i.line_id,i.event_date,i.event_time ${events} AND ${valid} AND i.kind='schedule' AND c.kind='affair' AND i.event_date BETWEEN ? AND ?`,
    ].join(' UNION ALL ');
    from=`FROM (${candidates}) d JOIN log_lines l ON l.id=d.line_id JOIN cases c ON c.id=l.case_id JOIN line_index i ON i.line_id=l.id`;
    params.splice(0,params.length,...range,...range,...range);where='1=1';
    row=`json_set(${lineJson},'$.case_kind',c.kind,'$.calendar_date',d.calendar_date,'$.calendar_time',d.calendar_time)`;
    key="d.calendar_date||'|'||COALESCE(d.calendar_time,'99:99')||'|'||l.id";
  }else if(name==='cases'){
    from='FROM cases c';where='c.workspace_id=?';
    where+=a.group==='affairs'?" AND c.kind='affair'":a.group==='archived'?" AND c.kind='case' AND c.status<>'在办'":" AND c.kind='case' AND c.status='在办'";
    if(a.query){where+=` AND (${['c.name','c.cause','c.case_number','c.court'].map(contains).join(' OR ')} OR EXISTS(SELECT 1 FROM case_aliases x WHERE x.case_id=c.id AND ${contains('x.alias')}) OR EXISTS(SELECT 1 FROM log_lines x WHERE x.case_id=c.id AND x.deleted_at IS NULL AND ${contains('x.raw_text')}))`;params.push(...Array(6).fill(a.query));}
    const recent="COALESCE(c.recent_activity,'')";
    key=`printf('%08d',99999999-CAST(replace(${recent},'-','') AS INTEGER))||'|'||c.id`;
    row=caseJsonWithRecent('c.recent_activity');
    if(a.query){row=`json_set(${row},'$.match_text',(SELECT x.raw_text FROM log_lines x WHERE x.case_id=c.id AND x.deleted_at IS NULL AND ${contains('x.raw_text')} ORDER BY x.sort_order LIMIT 1))`;}
  }else{
    from=joined;where=valid;row=`json_set(${lineJson},'$.case_kind',c.kind)`;
    if(name==='schedules'){
      from=indexedLines('index_events');where=`${lineRelations} AND ${valid}`;
      where+=" AND c.kind='case' AND i.kind='schedule' AND i.event_date IS NOT NULL";
      if(a.mode!=='all'){where+=` AND i.event_date${a.mode==='future'?'>=':'<'}?`;params.push(a.today);}
      if(a.from_date){where+=' AND i.event_date>=?';params.push(a.from_date);}
      if(a.to_date){where+=' AND i.event_date<=?';params.push(a.to_date);}
      const past=a.mode==='history'?'1':a.mode==='future'?'0':`i.event_date<'${a.today}'`;
      key=`CASE WHEN ${past} THEN '1' ELSE '0' END||'|'||printf('%08d',CASE WHEN ${past} THEN 99999999-CAST(replace(i.event_date,'-','') AS INTEGER) ELSE CAST(replace(i.event_date,'-','') AS INTEGER) END)||'|'||printf('%04d',CASE WHEN ${past} THEN 9999-CAST(replace(COALESCE(i.event_time,'00:00'),':','') AS INTEGER) ELSE CAST(replace(COALESCE(i.event_time,'99:99'),':','') AS INTEGER) END)||'|'||l.id`;
    }else if(name==='todos'){
      from=indexedLines('index_todos');where=`${lineRelations} AND ${valid}`;
      where+=" AND c.status='在办' AND i.kind='todo'";
      key="CASE i.todo_state WHEN '紧急' THEN '0' WHEN '等待' THEN '2' ELSE '1' END||'|'||COALESCE(i.due_date,'9999-99-99')||'|'||COALESCE(i.due_time,'99:99')||'|'||c.id||'|'||printf('%020d',l.sort_order)||'|'||l.id";
    }else{
      from=indexedLines('index_record_date');where=`${lineRelations} AND ${valid}`;
      where+=' AND i.record_date BETWEEN date(?,?) AND ?';params.push(a.today,`-${a.days} days`,a.today);
      key="printf('%08d',99999999-CAST(replace(i.record_date,'-','') AS INTEGER))||'|'||printf('%04d',9999-CAST(replace(COALESCE(i.record_time,'00:00'),':','') AS INTEGER))||'|'||l.id";
    }
  }
  const filters={...a};delete filters.cursor;
  const hash=await sha256(canonical({name,workspace:p.workspaceId,filters}));
  let after='';
  if(a.cursor){try{const v=JSON.parse(atob(a.cursor));if(v.hash!==hash||typeof v.key!=='string'||v.key.length>512)throw 0;after=v.key;}catch{throw new AppError('INVALID_ARGUMENT','分页条件已改变，请重新读取。');}}
  // The per-case MAX is a covering index lookup over active derived indices.
  const sql=name==='cases'
    ? `WITH candidate_cases AS MATERIALIZED (SELECT c.*,${recentActivity} AS recent_activity ${from} WHERE ${where})
       SELECT ${key} AS page_key,${row} AS row_json FROM candidate_cases c`
    : `SELECT ${key} AS page_key,${row} AS row_json ${from} WHERE ${where}`;
  const rowParams=name==='cases'&&a.query?[...params,a.query]:params;
  const results=await env.DB.batch([
    stmt(env,`SELECT COUNT(*) AS n ${from} WHERE ${where}`,params),
    stmt(env,`SELECT * FROM (${sql}) WHERE page_key>? ORDER BY page_key LIMIT ?`,[...rowParams,after,a.limit+1]),
  ]);
  const rows:any[]=results[1].results,hasMore=rows.length>a.limit,shown=rows.slice(0,a.limit);
  return success({items:shown.map(r=>JSON.parse(r.row_json)),matched_count:Number((results[0].results[0] as any).n),has_more:hasMore,
    next_cursor:hasMore?btoa(JSON.stringify({hash,key:shown[shown.length-1].page_key})):null});
}
