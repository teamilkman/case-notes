import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readdirSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,dirname,resolve } from 'node:path';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { executeTool,saveNotes } from '../src/service';
import { webRead } from '../src/web-queries';
import { parseLine,PARSER_VERSION } from '../src/parser';
import { readReceipt } from '../src/receipts';
import { login } from '../src/auth';
import type { Env,Principal } from '../src/types';
import { migrationSql as sql } from './migrations';

const temp=mkdtempSync(resolve(tmpdir(),'case-notes-query-cost-'));
let mf:Miniflare,env:Env;
const ai:Principal={workspaceId:'cost',clientId:'synthetic-ai',actorId:'owner',source:'ai'},web:Principal={...ai,source:'web'};
const key=()=>crypto.randomUUID();
async function apply(db:D1Database,folder:string){for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort())await db.batch(sql(resolve(folder,file)).map(s=>db.prepare(s)));}
function metered(db:D1Database){
  const entries:{read:number;written:number;sql:string}[]=[],original=new WeakMap<object,D1PreparedStatement>(),sqls=new WeakMap<object,string>();
  const record=(sql:string,r:any)=>{entries.push({sql,read:r.meta.rows_read,written:r.meta.rows_written});return r;};
  const wrap=(sql:string,s:D1PreparedStatement):D1PreparedStatement=>{
    const proxy={bind:(...args:unknown[])=>wrap(sql,s.bind(...args)),all:async()=>record(sql,await s.all()),run:async()=>record(sql,await s.run()),
      first:async(column?:string)=>{const r=record(sql,await s.all());return column?r.results[0]?.[column]??null:r.results[0]??null;}} as D1PreparedStatement;
    original.set(proxy,s);sqls.set(proxy,sql);return proxy;
  };
  return {entries,db:{prepare:(sql:string)=>wrap(sql,db.prepare(sql)),batch:async(statements:D1PreparedStatement[])=>{
    const results=await db.batch(statements.map(s=>original.get(s)!));return results.map((r,n)=>record(sqls.get(statements[n])!,r));}} as D1Database};
}
async function measure(name:string,fn:(e:Env)=>Promise<any>){
  const m=metered(env.DB),result=await fn({...env,DB:m.db});
  const read=m.entries.reduce((s,r)=>s+r.read,0),written=m.entries.reduce((s,r)=>s+r.written,0);
  console.log(`${name}: rows_read=${read}, rows_written=${written}`);return {result,read,written,entries:m.entries};
}
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({name:'query-cost',modules:true,scriptPath:resolve('dist/worker.js'),
    compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},resourcePersistencePath:temp,
    d1Databases:{DB:'cost-business',OLD:'cost-upgrade'}}));
  env={DB:await mf.getD1Database('DB') as unknown as D1Database,WEB_PASSWORD:'synthetic-password'} as Env;
  await apply(env.DB,'migrations/business');
  await env.DB.prepare(`INSERT INTO cases(id,workspace_id,name,kind,status,created_at,updated_at,opened_date)
    SELECT 'case_cost_'||key,'cost','合成案'||printf('%04d',key),'case','在办','2026-01-01','2026-01-01','2026-01-01' FROM json_each(?)`)
    .bind(JSON.stringify(Array(100).fill(0))).run();
  for(let start=0;start<10000;start+=500){
    const rows=Array.from({length:500},(_,k)=>{
      const n=start+k,local=n%100,text=local===0?'- [ ] 合成待办 #截止2026.10.12':local===1?'- 📅 2026.10.11 09:00 合成日程':local%10===0?'2026.10.11 最近合成记录 匹配':'2020.01.01 合成历史记录'+(local%2?' 匹配':'');
      return {id:'line_cost_'+n,cid:'case_cost_'+Math.floor(n/100),order:(local+1)*1024,text,parsed:parseLine(text)};
    });
    const json=JSON.stringify(rows);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO log_lines SELECT json_extract(value,'$.id'),'cost',json_extract(value,'$.cid'),json_extract(value,'$.order'),json_extract(value,'$.text'),1,'2026-01-01','2026-01-01',NULL,'synthetic-seed' FROM json_each(?)`).bind(json),
      env.DB.prepare(`INSERT INTO line_index SELECT json_extract(value,'$.id'),1,?,json_extract(value,'$.parsed.kind'),json_extract(value,'$.parsed.marker'),json_extract(value,'$.parsed.display_text'),json_extract(value,'$.parsed.record_date'),json_extract(value,'$.parsed.record_time'),json_extract(value,'$.parsed.recent_date'),json_extract(value,'$.parsed.todo_state'),json_extract(value,'$.parsed.due_date'),json_extract(value,'$.parsed.due_time'),json_extract(value,'$.parsed.event_date'),json_extract(value,'$.parsed.event_time'),json_extract(value,'$.parsed.parse_status'),json_extract(value,'$.parsed.diagnostics'),json_extract(value,'$.cid') FROM json_each(?)`).bind(PARSER_VERSION,json),
    ]);
  }
});
after(async()=>{await mf?.dispose();assert.equal(dirname(realpathSync(temp)),realpathSync(tmpdir()));assert.ok(basename(temp).startsWith('case-notes-query-cost-'));rmSync(temp,{recursive:true});});

test('10,000 historical lines do not amplify case pages, recent windows or single-line append audits',async()=>{
  const first=await measure('cases first',e=>webRead(e,web,'cases',{}));assert.ok(first.read<1000);assert.equal(first.written,0);
  const next=await measure('cases next',e=>webRead(e,web,'cases',{cursor:first.result.data.next_cursor}));assert.ok(next.read<1000);
  const stats=await measure('stats',e=>webRead(e,web,'stats',{today:'2026-10-11'}));assert.ok(stats.read<5000);assert.equal(stats.result.data.counts.activity_7,1000);
  const recent=await measure('recent',e=>webRead(e,web,'activity',{today:'2026-10-11',days:7}));assert.ok(recent.read<10000);assert.equal(recent.result.data.matched_count,1000);
  const args={query:'匹配',result_type:'lines',limit:20};
  const search=await measure('search first',e=>executeTool(e,ai,'search',args));assert.ok(search.read<40000);assert.equal(search.result.data.matched_count,5800);
  const searchNext=await measure('search next',e=>executeTool(e,ai,'search',{...args,cursor:search.result.data.next_cursor}));assert.ok(searchNext.read<25000);assert.equal(searchNext.written,0);
  const missing=await measure('search missing',e=>executeTool(e,ai,'search',{query:'不存在'}));assert.ok(missing.read<45000);assert.equal(missing.result.data.matched_count,0);
  const add=await measure('append one',e=>executeTool(e,ai,'lines_add',{case_ref:'case_cost_0',text:'2026.10.11 新记录',request_key:key()}));assert.ok(add.read<50);assert.ok(add.written<30);
  const audit:any=await env.DB.prepare('SELECT after_json FROM audit_changes WHERE operation_id=?').bind(add.result.data.operation_id).first();
  assert.equal(JSON.parse(audit.after_json).line_id,add.result.data.lines[0].line_id);
});

test('5,000-line structural saves preserve untouched rows and compact immutable receipts',async()=>{
  const p={...ai,workspaceId:'ordering'},browser={...web,workspaceId:p.workspaceId};
  const created:any=await executeTool(env,p,'cases_create',{name:'合成大笔记',request_key:key()}),cid=created.data.case_id;
  const initial:any=await saveNotes(env,browser,{case_ref:cid,expected_document_revision:1,lines:Array.from({length:4999},()=>({text:'重复原文'})),request_key:key()});
  const before=(await env.DB.prepare('SELECT * FROM log_lines WHERE case_id=? ORDER BY sort_order').bind(cid).all<any>()).results;
  const args={case_ref:cid,expected_document_revision:initial.data.document_revision,lines:[...initial.data.lines.map((l:any)=>({line_id:l.line_id,text:'重复原文'})),{text:'新增原文'}],request_key:key()};
  const append=await measure('4999-line web append',e=>saveNotes(e,browser,args));assert.ok(append.written<30);assert.ok(append.read<5100);assert.equal(append.result.data.changed,1);
  const after=(await env.DB.prepare('SELECT * FROM log_lines WHERE case_id=? ORDER BY sort_order').bind(cid).all<any>()).results;
  assert.deepEqual(after.slice(0,4999),before);
  const stored:any=await env.DB.prepare('SELECT result_json FROM operations WHERE id=?').bind(append.result.data.operation_id).first();
  assert.ok(Buffer.byteLength(stored.result_json)<Buffer.byteLength(JSON.stringify(append.result))*0.65);
  assert.deepEqual(await readReceipt(stored.result_json),append.result);
  console.log(`5000-line receipt: stored=${Buffer.byteLength(stored.result_json)}, expanded=${Buffer.byteLength(JSON.stringify(append.result))}`);
  const eraseArgs={case_ref:cid,expected_document_revision:append.result.data.document_revision,lines:append.result.data.lines.slice(1).map((l:any,n:number)=>({line_id:l.line_id,text:n===4998?'新增原文':'重复原文'})),request_key:key()};
  const removed=await measure('5000-line web delete',e=>saveNotes(e,browser,eraseArgs));assert.ok(removed.written<30);assert.equal(removed.result.data.changed,1);
  const remaining=(await env.DB.prepare('SELECT * FROM log_lines WHERE case_id=? AND deleted_at IS NULL ORDER BY sort_order').bind(cid).all<any>()).results;
  assert.deepEqual(remaining,after.slice(1));
  assert.equal(await env.DB.prepare('SELECT line_id FROM line_index WHERE line_id=?').bind(before[0].id).first(),null);
  const replay:any=await saveNotes(env,browser,args);assert.deepEqual(replay,{...append.result,data:{...append.result.data,replayed:true}});
  const tombstone:any=await env.DB.prepare('SELECT raw_text,version,deleted_at FROM log_lines WHERE id=?').bind(before[0].id).first();
  assert.equal(tombstone.raw_text,'重复原文');assert.equal(tombstone.version,2);assert.ok(tombstone.deleted_at);
});

test('crowded insertion and reordering only move required rows and retain their versions',async()=>{
  const created:any=await executeTool(env,ai,'cases_create',{name:'局部排序合成案',request_key:key()}),cid=created.data.case_id;
  const added:any=await executeTool(env,ai,'lines_add',{case_ref:cid,text:'重复\n\n重复\n末尾',request_key:key()});
  await env.DB.prepare(`UPDATE log_lines SET sort_order=CASE sort_order WHEN 1024 THEN 1 WHEN 2048 THEN 2 WHEN 3072 THEN 3 ELSE sort_order END WHERE case_id=?`).bind(cid).run();
  const tail:any=await env.DB.prepare('SELECT * FROM log_lines WHERE id=?').bind(added.data.lines[3].line_id).first();
  const inserted=await measure('crowded insert',e=>executeTool(e,ai,'lines_add',{case_ref:cid,before_line_id:added.data.lines[0].line_id,expected_document_revision:2,text:'新首行',request_key:key()}));
  assert.ok(inserted.written<60);assert.deepEqual(await env.DB.prepare('SELECT * FROM log_lines WHERE id=?').bind(tail.id).first(),tail);
  let rows=(await env.DB.prepare('SELECT id AS line_id,raw_text AS text,version FROM log_lines WHERE case_id=? ORDER BY sort_order').bind(cid).all<any>()).results;
  assert.deepEqual(rows.map(r=>r.text),['新首行','重复','','重复','末尾']);assert.ok(rows.every(r=>r.version===1));
  const reordered=[rows.at(-1)!,...rows.slice(0,-1)];
  const saved:any=await saveNotes(env,web,{case_ref:cid,expected_document_revision:inserted.result.data.document_revision,lines:reordered,request_key:key()});
  rows=(await env.DB.prepare('SELECT id AS line_id,raw_text AS text,version FROM log_lines WHERE case_id=? ORDER BY sort_order').bind(cid).all<any>()).results;
  assert.deepEqual(rows,reordered);assert.ok(saved.data.lines.every((r:any)=>r.version===1));
  const movedAudit:any=await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_changes WHERE operation_id=? AND before_json IS NOT NULL').bind(saved.data.operation_id).first();assert.equal(movedAudit.n,1);
});

test('query migration backfills existing data once and repeatable maintenance preserves facts and receipts',async()=>{
  const db=await mf.getD1Database('OLD') as unknown as D1Database;
  for(const file of ['0001_initial.sql','0002_data_migrations.sql','0003_retire_legacy_import.sql'])await db.batch(sql('migrations/business/'+file).map(s=>db.prepare(s)));
  await db.prepare(`INSERT INTO cases(id,workspace_id,name,kind,status,created_at,updated_at,opened_date) VALUES('case_upgrade','cost','升级合成案','case','在办','2026','2026','2026-01-01')`).run();
  for(let n=0;n<10000;n+=500){
    const rows=Array.from({length:500},(_,k)=>({id:'line_upgrade_'+(n+k),order:(n+k+1)*1024,deleted:n+k>=100?'2026-10-11':null}));
    await db.batch([
      db.prepare(`INSERT INTO log_lines SELECT json_extract(value,'$.id'),'cost','case_upgrade',json_extract(value,'$.order'),'- [ ] 重复合成待办',CASE WHEN json_extract(value,'$.deleted') IS NULL THEN 1 ELSE 2 END,'2026','2026',json_extract(value,'$.deleted'),'seed' FROM json_each(?)`).bind(JSON.stringify(rows)),
      db.prepare(`INSERT INTO line_index SELECT json_extract(value,'$.id'),1,?,'todo','[ ]','重复合成待办',NULL,NULL,NULL,'一般',NULL,NULL,NULL,NULL,'ok','[]' FROM json_each(?)`).bind(PARSER_VERSION,JSON.stringify(rows)),
    ]);
  }
  await db.prepare(`INSERT INTO operations VALUES('op_old','cost','synthetic-ai','old-key','old-hash','lines_add',?,'2026')`).bind(JSON.stringify({ok:true,data:{lines:[{line_id:'line_upgrade_0',version:1,text:'- [ ] 重复合成待办'}]}})).run();
  await db.prepare(`INSERT INTO audit_changes VALUES('audit_old','op_old','cost','case_upgrade','line_upgrade_0','owner','synthetic-ai','ai','lines_add',NULL,'{}','2026')`).run();
  await db.prepare("UPDATE log_lines SET raw_text='- [ ] 重复合成待办 #截止2026.10.12' WHERE id='line_upgrade_0'").run();
  await db.prepare("UPDATE line_index SET recent_date='2026-10-12',record_date='2026-10-12',due_date='2026-10-12' WHERE line_id='line_upgrade_0'").run();
  await db.prepare("UPDATE log_lines SET raw_text='- [ ] 重复合成待办 #截止2050.01.01' WHERE id='line_upgrade_100'").run();
  await db.prepare("UPDATE line_index SET recent_date='2050-01-01',record_date='2050-01-01',due_date='2050-01-01' WHERE line_id='line_upgrade_100'").run();
  const oldRecent:any=await db.prepare('SELECT MAX(i.recent_date) AS recent FROM log_lines l JOIN line_index i ON i.line_id=l.id WHERE l.deleted_at IS NULL').first();
  const facts=(await db.prepare('SELECT * FROM log_lines ORDER BY id').all()).results,receipts=(await db.prepare('SELECT * FROM operations').all()).results,audits=(await db.prepare('SELECT * FROM audit_changes').all()).results;
  const migration=sql('migrations/business/0004_query_cost.sql');await db.batch(migration.map(s=>db.prepare(s)));
  await db.batch(migration.slice(1).map(s=>db.prepare(s)));
  assert.deepEqual((await db.prepare('SELECT * FROM log_lines ORDER BY id').all()).results,facts);
  assert.deepEqual((await db.prepare('SELECT * FROM operations').all()).results,receipts);assert.deepEqual((await db.prepare('SELECT * FROM audit_changes').all()).results,audits);
  const indices:any=await db.prepare("SELECT COUNT(*) AS n,SUM(case_id='case_upgrade' AND source_line_version=1) AS valid FROM line_index").first();assert.deepEqual(indices,{n:100,valid:100});
  const m=metered(db),todos:any=await webRead({...env,DB:m.db},web,'todos',{});assert.equal(todos.data.matched_count,100);assert.ok(m.entries.reduce((s,r)=>s+r.read,0)<1000);
  const detail:any=await executeTool({...env,DB:db},ai,'cases_get',{case_ref:'case_upgrade'});assert.equal(detail.data.case.recent_activity,oldRecent.recent);
  const oldReplay:any=await readReceipt((receipts[0] as any).result_json);assert.equal(oldReplay.data.lines[0].line_id,'line_upgrade_0');
  // The old Worker can still write during CI's migration/deploy interval.
  await db.prepare("INSERT INTO log_lines VALUES('line_transition','cost','case_upgrade',10241024,'2027.01.01 过渡记录',1,'2026','2026',NULL,'seed')").run();
  await db.prepare("INSERT INTO line_index(line_id,source_line_version,parser_version,kind,display_text,recent_date,parse_status,diagnostics) VALUES('line_transition',1,?,'record','2027.01.01 过渡记录','2027-01-01','ok','[]')").bind(PARSER_VERSION).run();
  assert.equal((await db.prepare("SELECT case_id FROM line_index WHERE line_id='line_transition'").first<any>())?.case_id,'case_upgrade');
  await db.prepare("UPDATE log_lines SET deleted_at='2026' WHERE id='line_transition'").run();
  assert.equal(await db.prepare("SELECT line_id FROM line_index WHERE line_id='line_transition'").first(),null);
});

test('login cleanup is bounded, indexed and cannot reset an unexpired rate limit',async()=>{
  const clock=Date.now();await env.DB.prepare(`INSERT INTO login_attempts SELECT 'expired-'||key,20,? FROM json_each(?)`).bind(clock-1,JSON.stringify(Array(150).fill(0))).run();
  const request=new Request('http://localhost/api/login',{method:'POST',headers:{Origin:'http://localhost','CF-Connecting-IP':'synthetic-1'}});
  await assert.rejects(login(request,env,{password:'wrong'}));
  const left:any=await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE bucket LIKE 'expired-%'").first();assert.equal(left.n,50);
  await assert.rejects(login(request,env,{password:'wrong'}));
  const empty:any=await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE resets_at<?').bind(clock).first();assert.equal(empty.n,0);
  for(let n=2;n<20;n++)await assert.rejects(login(request,env,{password:'wrong'}));
  await assert.rejects(login(request,env,{password:'synthetic-password'}),(e:any)=>e.code==='RATE_LIMITED');
  const plan=await env.DB.prepare('EXPLAIN QUERY PLAN SELECT bucket FROM login_attempts WHERE resets_at<? ORDER BY resets_at LIMIT 100').bind(clock).all<any>();
  assert.ok(plan.results.some(r=>r.detail.includes('attempts_expiry')));
});

test('future and monthly schedule stats skip old years while retaining past days in this month',async()=>{
  const p={...ai,workspaceId:'schedule-cost'},browser={...web,workspaceId:p.workspaceId};
  const c:any=await executeTool(env,p,'cases_create',{name:'日程统计合成案',request_key:key()}),cid=c.data.case_id;
  for(let n=0;n<2;n++)await executeTool(env,p,'lines_add',{case_ref:cid,text:Array(500).fill('- 📅 2020.01.01 09:00 历史安排').join('\n'),request_key:key()});
  await executeTool(env,p,'lines_add',{case_ref:cid,text:'- 📅 2026.10.05 月内已过安排\n- 📅 2026.10.11 今天安排\n- 📅 2026.11.01 未来安排',request_key:key()});
  await executeTool(env,p,'cases_update',{case_ref:cid,expected_metadata_version:1,fields:{status:'结案'},request_key:key()});
  const stats=await measure('schedule stats',e=>webRead(e,browser,'stats',{today:'2026-10-11'}));
  assert.equal(stats.result.data.counts.month,2);assert.equal(stats.result.data.counts.future,2);
  const scheduleReads=stats.entries.filter(r=>r.sql.includes("i.kind='schedule'")).reduce((s,r)=>s+r.read,0);assert.ok(scheduleReads<400);
});
