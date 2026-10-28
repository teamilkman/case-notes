import { schemas, type ToolName } from './schemas';
import { parseLine, splitLines, PARSER_VERSION, type ParsedLine } from './parser';
import { caseJson, lineJson, readQuery, indexedLines, lineRelations } from './queries';
import { search } from './search';
import { assignOrder } from './ordering';
import { readReceipt, storeReceipt } from './receipts';
import { AppError, canonical, localClock, sha256, success, type CaseRow, type Env, type LineRow, type Principal } from './types';

export const toolNames = Object.keys(schemas) as ToolName[];
const writeNames = new Set(['cases_create','cases_update','lines_add','lines_update','lines_delete']);
type Args = Record<string,any>;
const now = () => new Date().toISOString();
const stmt = (db: D1Database, sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export async function resolveCase(env: Env, p: Principal, ref: string): Promise<CaseRow> {
  if(ref.startsWith('case_')){
    const direct=await stmt(env.DB,'SELECT * FROM cases WHERE id=? AND workspace_id=?',[ref,p.workspaceId]).first<CaseRow>();
    if(direct)return direct;
  }
  const result = await stmt(env.DB,`SELECT DISTINCT c.* FROM cases c LEFT JOIN case_aliases a ON a.case_id=c.id
    WHERE c.workspace_id=? AND (c.id=? OR c.name=? OR a.alias=?)`,[p.workspaceId,ref,ref,ref]).all<CaseRow>();
  if (!result.results.length) throw new AppError('CASE_NOT_FOUND','未找到该案件，请确认名称或查找案件。',null,404);
  if (result.results.length>1) throw new AppError('CASE_AMBIGUOUS','名称命中多个案件，请选择明确 ID。',
    result.results.map(c=>({id:c.id,name:c.name,status:c.status,court:c.court,case_number:c.case_number})),409);
  return result.results[0];
}
function writable(c: CaseRow) { if(c.status!=='在办') throw new AppError('CASE_READ_ONLY','归档笔记只读；需要办理时通过元数据状态修改。',null,403); }
function sameVersion(actual: number, expected: number, details: unknown) {
  if(actual!==expected) throw new AppError('VERSION_CONFLICT','内容已被修改，请核对当前版本。',details,409);
}
async function getLine(env: Env,p: Principal,c: CaseRow,lineId: string) {
  const l = await stmt(env.DB,'SELECT * FROM log_lines WHERE id=? AND case_id=? AND workspace_id=? AND deleted_at IS NULL',[lineId,c.id,p.workspaceId]).first<LineRow>();
  if(!l) throw new AppError('LINE_NOT_FOUND','原行不存在或已被移除，请重新读取案件。',null,404);
  return l;
}
function ensureText(text: string) { if(new TextEncoder().encode(text).length>16_384) throw new AppError('INVALID_ARGUMENT','单行不能超过 16 KiB。'); }
type IndexEntry = {id:string;text:string;version:number;parsed:ParsedLine};
// Leave room below D1's 2 MB string limit; all chunks stay in the same batch.
function jsonChunks(entries:unknown[],maxBytes=1_500_000) {
  const chunks:string[]=[],encoder=new TextEncoder();let parts:string[]=[],bytes=2;
  for(const entry of entries){
    const value=JSON.stringify(entry),size=encoder.encode(value).length;
    if(size+2>maxBytes)throw new AppError('INVALID_ARGUMENT','单项写入数据过大。');
    if(parts.length&&bytes+size+1>maxBytes){chunks.push(`[${parts.join(',')}]`);parts=[];bytes=2;}
    bytes+=size+Number(parts.length>0);parts.push(value);
  }
  if(parts.length)chunks.push(`[${parts.join(',')}]`);
  return chunks;
}
function indexQuery(entries: IndexEntry[]) {
  return {sql:`INSERT INTO line_index(line_id,source_line_version,parser_version,kind,marker,display_text,
    record_date,record_time,recent_date,todo_state,due_date,due_time,event_date,event_time,parse_status,diagnostics,case_id)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.version'),?,
      json_extract(value,'$.parsed.kind'),json_extract(value,'$.parsed.marker'),json_extract(value,'$.parsed.display_text'),
      json_extract(value,'$.parsed.record_date'),json_extract(value,'$.parsed.record_time'),json_extract(value,'$.parsed.recent_date'),
      json_extract(value,'$.parsed.todo_state'),json_extract(value,'$.parsed.due_date'),json_extract(value,'$.parsed.due_time'),
      json_extract(value,'$.parsed.event_date'),json_extract(value,'$.parsed.event_time'),json_extract(value,'$.parsed.parse_status'),
      json_extract(value,'$.parsed.diagnostics'),(SELECT case_id FROM log_lines WHERE id=json_extract(value,'$.id')) FROM json_each(?) WHERE 1
    ON CONFLICT(line_id) DO UPDATE SET source_line_version=excluded.source_line_version,parser_version=excluded.parser_version,
      kind=excluded.kind,marker=excluded.marker,display_text=excluded.display_text,record_date=excluded.record_date,
      record_time=excluded.record_time,recent_date=excluded.recent_date,todo_state=excluded.todo_state,
      due_date=excluded.due_date,due_time=excluded.due_time,event_date=excluded.event_date,event_time=excluded.event_time,
      parse_status=excluded.parse_status,diagnostics=excluded.diagnostics,case_id=excluded.case_id`,params:[PARSER_VERSION,JSON.stringify(entries.map(e=>({id:e.id,version:e.version,parsed:e.parsed})))]};
}
function indexStatement(db:D1Database,entries:IndexEntry[]) {
  const q=indexQuery(entries);return stmt(db,q.sql,q.params);
}
function indexStatements(db:D1Database,entries:IndexEntry[]) {
  const q=indexQuery([]);
  return jsonChunks(entries.map(e=>({id:e.id,version:e.version,parsed:e.parsed})))
    .map(chunk=>stmt(db,q.sql,[PARSER_VERSION,chunk]));
}
function scopeFilter(args: Args, defaultScope: string) {
  const scope=args.scope ?? (args.case_ref?'all':defaultScope);
  return {scope,sql:scope==='active'?"c.status='在办'":scope==='archived'?"c.status<>'在办'":scope==='affairs'?"c.kind='affair'":'1'};
}
async function query(env: Env,p: Principal,tool: ToolName,a: Args) {
  const where=['c.workspace_id=?']; const params: unknown[]=[p.workspaceId];
  let caseId:string|undefined;
  if(a.from_date && a.to_date && a.from_date>a.to_date || a.due_from && a.due_to && a.due_from>a.due_to)
    throw new AppError('INVALID_ARGUMENT','起始日期不能晚于结束日期。');
  if(tool==='cases_get') {
    const c=await resolveCase(env,p,a.case_ref);
    return readQuery(env,p,tool,a,{sql:`SELECT json_object('line_id',l.id,'version',l.version,'text',l.raw_text) AS row_json,l.sort_order AS line_order,l.id AS line_id
      FROM log_lines l WHERE l.case_id=? AND l.workspace_id=? AND l.deleted_at IS NULL`,params:[c.id,p.workspaceId],
      countSql:'SELECT COUNT(*) AS total FROM log_lines WHERE case_id=? AND workspace_id=? AND deleted_at IS NULL',
      headerSql:`SELECT json_object('case',${caseJson},'document_revision',c.document_revision) AS payload FROM cases c WHERE c.id=? AND c.workspace_id=?`,
      headerParams:[c.id,p.workspaceId],keys:['line_order','line_id'],caseId:c.id,pageSize:1000,full:true});
  }
  if(tool==='search')return search(env,p,a,a.case_ref?await resolveCase(env,p,a.case_ref):undefined);
  if(a.case_ref) { const c=await resolveCase(env,p,a.case_ref); caseId=c.id;where.push('c.id=?');params.push(c.id);
    if(!a.cursor && a.scope && !(a.scope==='all'||a.scope==='active' && c.status==='在办'||a.scope==='archived' && c.status!=='在办'||a.scope==='affairs' && c.kind==='affair'))
      throw new AppError('INVALID_ARGUMENT','指定案件与 scope 条件不相容。'); }
  const sf=scopeFilter(a,'active'); where.push(sf.sql,'l.deleted_at IS NULL','i.source_line_version=l.version');
  if(tool==='schedules_list'&&!a.case_ref&&!a.scope) where.push("c.kind='case'");
  if(tool==='todos_list') {
    where.push("i.kind='todo'");
    if(a.todo_state){where.push('i.todo_state=?');params.push(a.todo_state);}
    const dates:string[]=[];
    if(a.due_from){dates.push('i.due_date>=?');params.push(a.due_from);}
    if(a.due_to){dates.push('i.due_date<=?');params.push(a.due_to);}
    if(dates.length) where.push(`(${dates.join(' AND ')}${a.include_undated?' OR i.due_date IS NULL':''})`);
    else if(a.include_undated===false) where.push('i.due_date IS NOT NULL');
  }
  if(tool==='schedules_list') {
    where.push("i.kind='schedule'",'i.event_date IS NOT NULL');
    if(a.from_date){where.push('i.event_date>=?');params.push(a.from_date);}
    if(a.to_date){where.push('i.event_date<=?');params.push(a.to_date);}
  }
  const keys=tool==='todos_list'?['priority','date_key','time_key','case_id','line_order','line_id']:['date_key','time_key','case_id','line_order','line_id'];
  const sort=tool==='todos_list'?"CASE i.todo_state WHEN '紧急' THEN 0 WHEN '等待' THEN 2 ELSE 1 END AS priority,COALESCE(i.due_date,'9999-99-99') AS date_key,COALESCE(i.due_time,'99:99') AS time_key"
    :"i.event_date AS date_key,COALESCE(i.event_time,'99:99') AS time_key";
  const from=indexedLines(tool==='todos_list'?'index_todos':'index_events');
  const conditions=`${lineRelations} AND ${where.join(' AND ')}`;
  return readQuery(env,p,tool,a,{sql:`SELECT ${lineJson} AS row_json,${sort},c.id AS case_id,l.sort_order AS line_order,l.id AS line_id ${from} WHERE ${conditions}`,
    countSql:`SELECT COUNT(*) AS total ${from} WHERE ${conditions}`,params,keys,caseId,pageSize:a.limit??100,filters:{...a,scope:sf.scope}});
}
interface Tx {
  operationId:string; hash:string; key:string; action:string; time:string;
  statements:D1PreparedStatement[];
}
async function startTx(env:Env,p:Principal,action:string,a:Args):Promise<Tx|{replay:any}> {
  const hash=await sha256(canonical({action,args:a}));
  const replay=await committedReplay(env,p,a.request_key,hash);
  if(replay)return {replay};
  const tx:Tx={operationId:id('op'),hash,key:a.request_key,action,time:now(),statements:[]};
  tx.statements.push(stmt(env.DB,`INSERT INTO operations(id,workspace_id,client_id,request_key,request_hash,action,result_json,committed_at) VALUES(?,?,?,?,?,?,?,?)`,
    [tx.operationId,p.workspaceId,p.clientId,tx.key,hash,action,'{}',tx.time])); return tx;
}
async function committedReplay(env:Env,p:Principal,key:string,hash:string) {
  const existing=await stmt(env.DB,'SELECT * FROM operations WHERE workspace_id=? AND client_id=? AND request_key=?',[p.workspaceId,p.clientId,key])
    .first<{id:string;request_hash:string;result_json:string}>();
  if(existing) {
    if(existing.request_hash!==hash) throw new AppError('IDEMPOTENCY_CONFLICT','此请求键已用于不同内容。',{operation_id:existing.id},409);
    const result=await readReceipt(existing.result_json);result.data.replayed=true; return result;
  }
  return null;
}
async function withCommittedReplay(env:Env,p:Principal,action:string,a:Args,perform:()=>Promise<any>) {
  try{return await perform();}
  catch(error){
    // A same-key winner may commit after the initial receipt lookup, before a
    // precondition read. Receipt lookup therefore covers preflight failures too.
    const replay=await committedReplay(env,p,a.request_key,await sha256(canonical({action,args:a})));
    if(replay)return replay;
    throw error;
  }
}
function guard(env:Env,tx:Tx,condition:string,params:unknown[]) {
  tx.statements.push(stmt(env.DB,`INSERT INTO write_guards(operation_id,passed) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`,[tx.operationId,...params]));
}
function audit(env:Env,p:Principal,tx:Tx,cid:string,lineId:string|null,before:unknown,after:unknown,action=tx.action) {
  tx.statements.push(stmt(env.DB,`INSERT INTO audit_changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id('audit'),tx.operationId,p.workspaceId,cid,lineId,p.actorId,p.clientId,p.source,action,
      before===null?null:JSON.stringify(before),after===null?null:JSON.stringify(after),tx.time]));
}
function auditNewLines(env:Env,p:Principal,tx:Tx,cid:string,entries:IndexEntry[]) {
  tx.statements.push(stmt(env.DB,`INSERT INTO audit_changes(id,operation_id,workspace_id,case_id,line_id,actor_id,client_id,source,action,before_json,after_json,created_at)
    SELECT 'audit_'||l.id,?,?,?,l.id,?,?,?,'lines_add',NULL,
      json_object('line_id',l.id,'text',l.raw_text,'version',l.version,'sort_order',l.sort_order),?
    FROM json_each(?) j JOIN log_lines l ON l.id=j.value WHERE l.source_operation_id=? AND l.case_id=? AND l.version=1`,
    [tx.operationId,p.workspaceId,cid,p.actorId,p.clientId,p.source,tx.time,JSON.stringify(entries.map(e=>e.id)),tx.operationId,cid]));
}
function bump(env:Env,tx:Tx,cid:string) { tx.statements.push(stmt(env.DB,'UPDATE cases SET document_revision=document_revision+1,updated_at=? WHERE id=?',[tx.time,cid])); }
async function stageMetadata(env:Env,p:Principal,tx:Tx,c:CaseRow,fields:Args,expected:number,document?:{revision:number;writable:boolean}){
  sameVersion(c.metadata_version,expected,c);
  guard(env,tx,`(SELECT COUNT(*) FROM cases WHERE id=? AND workspace_id=? AND metadata_version=?${document?` AND document_revision=?${document.writable?" AND status='在办'":''}`:''})=1`,[c.id,p.workspaceId,expected,...(document?[document.revision]:[])]);
  const keys=Object.keys(fields).filter(k=>k!=='aliases');
  tx.statements.push(stmt(env.DB,`UPDATE cases SET ${keys.map(k=>`${k}=?`).concat('metadata_version=metadata_version+1','updated_at=?').join(',')} WHERE id=?`,[...keys.map(k=>fields[k]),tx.time,c.id]));
  if(fields.aliases!==undefined){tx.statements.push(stmt(env.DB,'DELETE FROM case_aliases WHERE case_id=?',[c.id]));
    if(fields.aliases.length)tx.statements.push(stmt(env.DB,'INSERT INTO case_aliases(case_id,alias) SELECT ?,value FROM json_each(?)',[c.id,JSON.stringify([...new Set(fields.aliases)])]));}
  const aliases=await stmt(env.DB,'SELECT alias FROM case_aliases WHERE case_id=?',[c.id]).all<{alias:string}>();
  audit(env,p,tx,c.id,null,{...c,aliases:aliases.results.map(x=>x.alias)},{...c,...fields,metadata_version:c.metadata_version+1});
}
function auditDiffs(env:Env,p:Principal,tx:Tx,cid:string,diffs:unknown[]) {
  for(const chunk of jsonChunks(diffs))tx.statements.push(stmt(env.DB,`INSERT INTO audit_changes SELECT 'audit_'||json_extract(value,'$.line_id')||'_'||?,?,?,?,json_extract(value,'$.line_id'),?,?,?,?,
    json_extract(value,'$.before'),json_extract(value,'$.after'),? FROM json_each(?)`,[tx.operationId,tx.operationId,p.workspaceId,cid,p.actorId,p.clientId,p.source,tx.action,tx.time,chunk]));
}
function stageMoves(env:Env,tx:Tx,moves:{id:string;sort_order:number}[],old:{sort_order:number}[]) {
  if(!moves.length)return;
  let base=0;for(const row of [...old,...moves])base=Math.min(base,row.sort_order);
  base-=moves.length+1;
  if(!Number.isSafeInteger(base))throw new AppError('SERVICE_UNAVAILABLE','行排序范围不足。',null,503);
  for(const chunk of jsonChunks(moves.map((e,n)=>({id:e.id,temporary:base+n}))))tx.statements.push(stmt(env.DB,`UPDATE log_lines SET sort_order=json_extract(j.value,'$.temporary')
    FROM json_each(?) j WHERE log_lines.id=json_extract(j.value,'$.id')`,[chunk]));
}
async function addEntries(env:Env,p:Principal,tx:Tx,cid:string,entries:any[],beforeOrder?:number) {
  if(beforeOrder!==undefined) {
    const previous=await stmt(env.DB,'SELECT MAX(sort_order) AS n FROM log_lines WHERE case_id=? AND deleted_at IS NULL AND sort_order<?',[cid,beforeOrder]).first<{n:number|null}>();
    const lower=previous?.n??0,step=Math.floor((beforeOrder-lower)/(entries.length+1));
    if(step>0)entries.forEach((e,n)=>e.sort_order=lower+(n+1)*step);
    else{
      const suffix=(await stmt(env.DB,'SELECT * FROM log_lines WHERE case_id=? AND deleted_at IS NULL AND sort_order>=? ORDER BY sort_order',[cid,beforeOrder]).all<LineRow>()).results;
      const ordered=[...entries,...suffix.map(before=>({id:before.id,sort_order:before.sort_order,before}))];
      assignOrder(ordered,lower);
      const moved=ordered.filter(e=>e.before&&e.sort_order!==e.before.sort_order);
      stageMoves(env,tx,moved,suffix);
      for(const chunk of jsonChunks(moved.map(e=>({id:e.id,order:e.sort_order}))))tx.statements.push(stmt(env.DB,`UPDATE log_lines SET sort_order=json_extract(j.value,'$.order') FROM json_each(?) j WHERE log_lines.id=json_extract(j.value,'$.id')`,[chunk]));
      auditDiffs(env,p,tx,cid,moved.map(e=>({line_id:e.id,before:{sort_order:e.before.sort_order,version:e.before.version},after:{sort_order:e.sort_order,version:e.before.version}})));
    }
  }
  tx.statements.push(stmt(env.DB,`WITH base AS MATERIALIZED (SELECT COALESCE(MAX(sort_order),0) AS n FROM log_lines WHERE case_id=? AND deleted_at IS NULL)
    INSERT INTO log_lines(id,workspace_id,case_id,sort_order,raw_text,version,created_at,updated_at,deleted_at,source_operation_id)
    SELECT json_extract(value,'$.id'),?,?,${beforeOrder===undefined?'base.n+(CAST(key AS INTEGER)+1)*1024':"json_extract(value,'$.sort_order')"},
      json_extract(value,'$.text'),1,?,?,NULL,? FROM json_each(?),base`,
    beforeOrder===undefined?[cid,p.workspaceId,cid,tx.time,tx.time,tx.operationId,JSON.stringify(entries.map(e=>({id:e.id,text:e.text})))]
      :[cid,p.workspaceId,cid,tx.time,tx.time,tx.operationId,JSON.stringify(entries.map(e=>({id:e.id,text:e.text,sort_order:e.sort_order})))]));
  tx.statements.push(...indexStatements(env.DB,entries)); auditNewLines(env,p,tx,cid,entries);
}
async function finish(env:Env,p:Principal,tx:Tx,cid:string,data:Args) {
  const includeCase=tx.action==='web_save_notes'||tx.action==='cases_update';
  const receipt=success({operation_id:tx.operationId,request_key:tx.key,case_id:cid,replayed:false,...data});
  const stored=await storeReceipt(receipt);
  tx.statements.push(stmt(env.DB,`UPDATE operations SET result_json=json_set(?,
    '$.data.case_name',(SELECT name FROM cases WHERE id=?),
    '$.data.metadata_version',(SELECT metadata_version FROM cases WHERE id=?),
    '$.data.document_revision',(SELECT document_revision FROM cases WHERE id=?)${includeCase?`,
    '$.data.case',json((SELECT ${caseJson} FROM cases c WHERE c.id=?))`:''}) WHERE id=?`,[stored,cid,cid,cid,...(includeCase?[cid]:[]),tx.operationId]));
  tx.statements.push(stmt(env.DB,'DELETE FROM write_guards WHERE operation_id=?',[tx.operationId]));
  tx.statements.push(stmt(env.DB,'SELECT result_json FROM operations WHERE id=?',[tx.operationId]));
  try {
    const committed=await env.DB.batch(tx.statements);
    return await readReceipt((committed[committed.length-1].results[0] as any).result_json);
  }
  catch(error) {
    const replay=await committedReplay(env,p,tx.key,tx.hash);
    if(replay)return replay;
    if(/guard_valid|CHECK constraint/.test(String(error))) {
      const current=await stmt(env.DB,'SELECT * FROM cases WHERE id=? AND workspace_id=?',[cid,p.workspaceId]).first<CaseRow>();
      if(current?.status!=='在办'&&current&&tx.action.startsWith('lines')) throw new AppError('CASE_READ_ONLY','案件已归档，原文未修改。',current,403);
      const lineIds=data.lines?.map((l:any)=>l.line_id)??[];
      const lines=lineIds.length?await stmt(env.DB,`SELECT id AS line_id,version,raw_text AS text FROM log_lines WHERE case_id=? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`,[cid,JSON.stringify(lineIds)]).all():null;
      throw new AppError('VERSION_CONFLICT','保存期间内容/案件状态发生变化，本次未提交。',{case:current,lines:lines?.results??[]},409);
    }
    throw error;
  }
}
async function write(env:Env,p:Principal,tool:ToolName,a:Args) {
  const attempt=await startTx(env,p,tool,a); if('replay'in attempt)return attempt.replay;
  const tx=attempt,db=env.DB;
  if(tool==='cases_create') {
    const duplicate=await stmt(db,'SELECT id,name,status FROM cases WHERE workspace_id=? AND name=?',[p.workspaceId,a.name]).all();
    if(duplicate.results.length&&!a.allow_duplicate)throw new AppError('CASE_AMBIGUOUS','已有同名案件；明确另建时使用 allow_duplicate。',duplicate.results,409);
    const cid=id('case');
    if(!a.allow_duplicate)guard(env,tx,'(SELECT COUNT(*) FROM cases WHERE workspace_id=? AND name=?)=0',[p.workspaceId,a.name]);
    tx.statements.push(stmt(db,`INSERT INTO cases(id,workspace_id,name,kind,status,cause,case_number,court,opened_date,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[cid,p.workspaceId,a.name,a.kind??'case',a.status??'在办',a.cause??null,a.case_number??null,a.court??null,a.opened_date===undefined?localClock().date:a.opened_date,tx.time,tx.time]));
    if(a.aliases?.length)tx.statements.push(stmt(db,'INSERT INTO case_aliases(case_id,alias) SELECT ?,value FROM json_each(?)',[cid,JSON.stringify([...new Set(a.aliases)])]));
    audit(env,p,tx,cid,null,null,a);return finish(env,p,tx,cid,{added:1});
  }
  const c=await resolveCase(env,p,a.case_ref);
  if(tool==='cases_update') {
    await stageMetadata(env,p,tx,c,a.fields,a.expected_metadata_version);
    return finish(env,p,tx,c.id,{changed:1,fields:a.fields});
  }
  writable(c);
  const active='(SELECT COUNT(*) FROM cases WHERE id=? AND workspace_id=? AND status=?)=1';
  if(tool==='lines_add') {
    const lines=splitLines(a.text);if(lines.length>500)throw new AppError('INVALID_ARGUMENT','一次加行最多 500 行，请分段提交。');lines.forEach(ensureText);
    let beforeOrder:number|undefined;
    if(a.before_line_id){if(!a.expected_document_revision)throw new AppError('INVALID_ARGUMENT','指定位置插入需 expected_document_revision。');
      sameVersion(c.document_revision,a.expected_document_revision,c);beforeOrder=(await getLine(env,p,c,a.before_line_id)).sort_order;
      guard(env,tx,`${active} AND (SELECT document_revision FROM cases WHERE id=?)=?`,[c.id,p.workspaceId,'在办',c.id,a.expected_document_revision]);}
    else guard(env,tx,active,[c.id,p.workspaceId,'在办']);
    const entries=lines.map(text=>({id:id('line'),text,version:1,parsed:parseLine(text)}));
    await addEntries(env,p,tx,c.id,entries,beforeOrder);bump(env,tx,c.id);
    return finish(env,p,tx,c.id,{added:entries.length,lines:entries.map(e=>({line_id:e.id,version:1,text:e.text,parsed:e.parsed}))});
  }
  const l=await getLine(env,p,c,a.line_id);sameVersion(l.version,a.expected_line_version,{line_id:l.id,version:l.version,text:l.raw_text,document_revision:c.document_revision});
  guard(env,tx,`${active} AND (SELECT COUNT(*) FROM log_lines WHERE id=? AND case_id=? AND version=? AND deleted_at IS NULL)=1`,[c.id,p.workspaceId,'在办',l.id,c.id,a.expected_line_version]);
  if(tool==='lines_update') {
    ensureText(a.text);const parsed=parseLine(a.text);
    tx.statements.push(stmt(db,'UPDATE log_lines SET raw_text=?,version=version+1,updated_at=?,source_operation_id=? WHERE id=?',[a.text,tx.time,tx.operationId,l.id]));
    tx.statements.push(indexStatement(db,[{id:l.id,text:a.text,version:l.version+1,parsed}]));
    audit(env,p,tx,c.id,l.id,{text:l.raw_text,version:l.version},{text:a.text,version:l.version+1});bump(env,tx,c.id);
    return finish(env,p,tx,c.id,{changed:1,lines:[{line_id:l.id,version:l.version+1,text:a.text,parsed}]});
  }
  tx.statements.push(stmt(db,'UPDATE log_lines SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?',[tx.time,tx.time,l.id]));
  audit(env,p,tx,c.id,l.id,{text:l.raw_text,version:l.version},null);bump(env,tx,c.id);
  return finish(env,p,tx,c.id,{removed:1,lines:[{line_id:l.id,version:l.version+1,deleted:true}]});
}
export async function executeTool(env:Env,p:Principal,name:string,input:unknown) {
  if(!Object.hasOwn(schemas,name))throw new AppError('INVALID_ARGUMENT','未知工具。',null,404);
  const tool=name as ToolName, parsed=schemas[tool].safeParse(input);
  if(!parsed.success)throw new AppError('INVALID_ARGUMENT','参数格式不正确。',parsed.error.issues.map(x=>({path:x.path,message:x.message})));
  return writeNames.has(tool)?withCommittedReplay(env,p,tool,parsed.data,()=>write(env,p,tool,parsed.data)):query(env,p,tool,parsed.data);
}
export async function completeTodo(env:Env,p:Principal,a:Args) {
  if(p.source!=='web')throw new AppError('PERMISSION_DENIED','此接口用于网页勾选提交；AI 完成待办请用 lines_update。',null,403);
  return withCommittedReplay(env,p,'web_complete_todo',a,()=>completeTodoAttempt(env,p,a));
}
async function completeTodoAttempt(env:Env,p:Principal,a:Args) {
  const attempt=await startTx(env,p,'web_complete_todo',a);if('replay'in attempt)return attempt.replay;
  const tx=attempt,c=await resolveCase(env,p,a.case_ref);writable(c);
  const l=await getLine(env,p,c,a.line_id),parsed=parseLine(l.raw_text);
  sameVersion(l.version,a.expected_line_version,{line_id:l.id,version:l.version,text:l.raw_text});
  if(parsed.kind!=='todo')throw new AppError('INVALID_ARGUMENT','目标行已不是待办。');
  guard(env,tx,'(SELECT COUNT(*) FROM cases WHERE id=? AND status=?)=1 AND (SELECT COUNT(*) FROM log_lines WHERE id=? AND case_id=? AND version=? AND deleted_at IS NULL)=1',[c.id,'在办',l.id,c.id,l.version]);
  tx.statements.push(stmt(env.DB,'UPDATE log_lines SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?',[tx.time,tx.time,l.id]));
  audit(env,p,tx,c.id,l.id,{text:l.raw_text,version:l.version},null);
  const clock=localClock(),text=`- [x] ${clock.date.replaceAll('-','.')} ${clock.time.slice(0,5)} 已完成：${parsed.display_text}`;
  const entry={id:id('line'),text,version:1,parsed:parseLine(text)};await addEntries(env,p,tx,c.id,[entry]);bump(env,tx,c.id);
  return finish(env,p,tx,c.id,{removed:1,added:1,original_line_id:l.id,completed_line_id:entry.id,lines:[{line_id:entry.id,text,version:1,parsed:entry.parsed}]});
}
export async function saveNotes(env:Env,p:Principal,a:Args) {
  if(p.source!=='web')throw new AppError('PERMISSION_DENIED','整段保存仅用于网页。',null,403);
  return withCommittedReplay(env,p,'web_save_notes',a,()=>saveNotesAttempt(env,p,a));
}
async function saveNotesAttempt(env:Env,p:Principal,a:Args) {
  const attempt=await startTx(env,p,'web_save_notes',a);if('replay'in attempt)return attempt.replay;
  const tx=attempt,c=await resolveCase(env,p,a.case_ref);sameVersion(c.document_revision,a.expected_document_revision,c);
  const old=(await stmt(env.DB,'SELECT * FROM log_lines WHERE case_id=? AND deleted_at IS NULL ORDER BY sort_order',[c.id]).all<LineRow>()).results;
  const byId=new Map(old.map(l=>[l.id,l])); const seen=new Set<string>();
  const entries=a.lines.map((l:any,n:number)=>{
    ensureText(l.text);if(/[\r\n]/.test(l.text))throw new AppError('INVALID_ARGUMENT','保存清单每项只能是一行。');
    if(l.line_id&&(!byId.has(l.line_id)||seen.has(l.line_id)))throw new AppError('INVALID_ARGUMENT','保存清单包含未知或重复行 ID。');
    const before=l.line_id?byId.get(l.line_id):undefined;const lid=l.line_id??id('line');seen.add(lid);
    return {id:lid,text:l.text,sort_order:before?.sort_order??0,version:before?before.version+Number(before.raw_text!==l.text):1,
      parsed:!before||before.raw_text!==l.text?parseLine(l.text):undefined,before};
  });
  assignOrder(entries);
  const removed=old.filter(l=>!seen.has(l.id));
  const changed=entries.filter((e:any)=>!e.before||e.before.raw_text!==e.text);
  const moved=entries.filter((e:any)=>e.before&&e.sort_order!==e.before.sort_order);
  const bodyChanged=!!(removed.length||changed.length||moved.length);
  if(bodyChanged||!a.metadata)writable(c);
  if(a.metadata)await stageMetadata(env,p,tx,c,a.metadata.fields,a.metadata.expected_metadata_version,{revision:a.expected_document_revision,writable:bodyChanged});
  else guard(env,tx,"(SELECT COUNT(*) FROM cases WHERE id=? AND workspace_id=? AND document_revision=? AND status='在办')=1",[c.id,p.workspaceId,a.expected_document_revision]);
  for(const chunk of jsonChunks(removed.map(l=>l.id)))tx.statements.push(stmt(env.DB,'UPDATE log_lines SET deleted_at=?,updated_at=?,version=version+1 WHERE id IN (SELECT value FROM json_each(?))',[tx.time,tx.time,chunk]));
  stageMoves(env,tx,moved,old);
  const written=entries.filter((e:any)=>!e.before||e.before.raw_text!==e.text||e.before.sort_order!==e.sort_order);
  for(const chunk of jsonChunks(written.map((e:any)=>({id:e.id,text:e.text,version:e.version,sort_order:e.sort_order}))))tx.statements.push(stmt(env.DB,`INSERT INTO log_lines(id,workspace_id,case_id,sort_order,raw_text,version,created_at,updated_at,deleted_at,source_operation_id)
    SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.sort_order'),json_extract(value,'$.text'),json_extract(value,'$.version'),?,?,NULL,?
    FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order,raw_text=excluded.raw_text,version=excluded.version,
      updated_at=excluded.updated_at,source_operation_id=excluded.source_operation_id`,[p.workspaceId,c.id,tx.time,tx.time,tx.operationId,chunk]));
  tx.statements.push(...indexStatements(env.DB,changed));
  // Bulk audit keeps a whole-note save within D1's request query budget.
  const diffs:any[]=removed.map(l=>({line_id:l.id,before:l,after:null}));
  for(const e of entries)if(!e.before||e.before.raw_text!==e.text||e.before.sort_order!==e.sort_order)
    diffs.push({line_id:e.id,before:e.before??null,after:{text:e.text,version:e.version,sort_order:e.sort_order}});
  auditDiffs(env,p,tx,c.id,diffs);
  if(bodyChanged||!a.metadata)bump(env,tx,c.id);
  return finish(env,p,tx,c.id,{changed:diffs.length,lines:entries.map((e:any)=>({line_id:e.id,version:e.version}))});
}
