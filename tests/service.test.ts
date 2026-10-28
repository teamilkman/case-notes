import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { executeTool, completeTodo, saveNotes } from '../src/service';
import { webRead } from '../src/web-queries';
import { AppError, failure, type Env, type Principal } from '../src/types';
import { parseLine, PARSER_VERSION } from '../src/parser';
import { instructions, descriptions, outputSchemas, errorResponseSchema, type ToolName } from '../src/schemas';
import { migrationSql } from './migrations';

let mf:Miniflare,env:Env;
const temp=mkdtempSync(resolve(tmpdir(),'case-notes-test-'));
const ai:Principal={workspaceId:'personal',clientId:'test-ai',actorId:'owner',source:'ai'};
const web:Principal={...ai,clientId:'test-web',source:'web'};
const key=()=>crypto.randomUUID();
function meter(db:D1Database) {
  const entries:{sql:string;read:number;written:number}[]=[],original=new WeakMap<object,D1PreparedStatement>(),sqls=new WeakMap<object,string>();
  const record=(sql:string,r:any)=>{entries.push({sql,read:r.meta.rows_read,written:r.meta.rows_written});return r;};
  function wrap(sql:string,s:D1PreparedStatement):D1PreparedStatement {
    const proxy={bind:(...args:unknown[])=>wrap(sql,s.bind(...args)),
      all:async()=>record(sql,await s.all()),run:async()=>record(sql,await s.run()),
      first:async(column?:string)=>{const r=record(sql,await s.all());return column?r.results[0]?.[column]??null:r.results[0]??null;},
    } as D1PreparedStatement;
    original.set(proxy,s);sqls.set(proxy,sql);return proxy;
  }
  return {entries,db:{prepare:(sql:string)=>wrap(sql,db.prepare(sql)),
    batch:async(statements:D1PreparedStatement[])=>{
      const results=await db.batch(statements.map(s=>original.get(s)!));
      return results.map((r,n)=>record(sqls.get(statements[n])!,r));
    },
  } as D1Database};
}
const call=async(name:string,args:any,p=ai)=>{
  const result=await executeTool(env,p,name,args),checked=outputSchemas[name as ToolName].safeParse(result);
  assert.equal(checked.success,true,checked.success?name:JSON.stringify(checked.error.issues));
  return result;
};
async function create(name='测试案'){const r:any=await call('cases_create',{name,request_key:key()});return r.data.case_id;}
// Programmatic access is OAuth only: the tests mint a token from the web password.
async function oauthAccessToken(){
  const verifier='v'.repeat(43),redirect='https://client.example/callback';
  const challenge=Buffer.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))).toString('base64url');
  const registered=await mf.dispatchFetch('http://localhost/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_name:'service-test',redirect_uris:[redirect]})});
  const client=await registered.json() as any;
  assert.equal(registered.status,201,JSON.stringify(client));
  const query=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'mcp',
    resource:'http://localhost/mcp',code_challenge:challenge,code_challenge_method:'S256'});
  const consent=await mf.dispatchFetch('http://localhost/oauth/authorize?'+query.toString(),{redirect:'manual'});
  const page=await consent.text();
  const nonce=page.match(/name="request" value="([A-Za-z0-9_-]+)"/)?.[1],browser=consent.headers.get('set-cookie')?.split(';')[0];
  assert.ok(nonce&&browser,'consent page must expose the pending request');
  const approval=await mf.dispatchFetch('http://localhost/oauth/authorize',{method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:'http://localhost',Cookie:browser!},
    body:new URLSearchParams({request:nonce!,decision:'allow',password:'test-password'}).toString()});
  const code=new URL(approval.headers.get('location')!).searchParams.get('code');
  assert.ok(code,'authorization must issue a code');
  const exchanged=await mf.dispatchFetch('http://localhost/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',code:code!,redirect_uri:redirect,client_id:client.client_id,code_verifier:verifier,resource:'http://localhost/mcp',scope:'mcp'}).toString()});
  const tokens=await exchanged.json() as any;
  assert.ok(tokens.access_token,'token exchange must return an access token');
  return tokens.access_token as string;
}
async function lines(cid:string){const r:any=await call('cases_get',{case_ref:cid});return r.data;}
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({name:'case-notes-test',modules:true,scriptPath:resolve('dist/worker.js'),compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],
    telemetry:{enabled:false},resourcePersistencePath:temp,d1Databases:{DB:'test-business'},
    bindings:{WEB_PASSWORD:'test-password',WORKSPACE_ID:'personal'},
    assets:{directory:resolve('public'),binding:'ASSETS',run_worker_first:['/api/*','/mcp','/health','/oauth/*','/.well-known/*'],routerConfig:{has_user_worker:true}}}));
  const db=await mf.getD1Database('DB');
  for(const [database,folder] of [[db,'migrations/business']] as const)
    for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort())
      await database.batch(migrationSql(resolve(folder,file)).map(s=>database.prepare(s)));
  env={DB:db as unknown as D1Database,ASSETS:null as any,WEB_PASSWORD:'test-password'};
});
after(async()=>{await mf?.dispose();assert.equal(dirname(realpathSync(temp)),realpathSync(tmpdir()));assert.ok(basename(temp).startsWith('case-notes-test-'));rmSync(temp,{recursive:true});});

test('retiring import data requires current indices and preserves current lines, receipts and active cursors',async()=>{
  const isolated=new Miniflare(convertV4MiniflareOptions({name:'retirement-check',modules:true,scriptPath:resolve('dist/worker.js'),
    compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},
    resourcePersistencePath:resolve(temp,'retirement-check'),d1Databases:{DB:'retirement-check-db'}}));
  try{
    const db=await isolated.getD1Database('DB') as unknown as D1Database,isolatedEnv={...env,DB:db};
    for(const file of ['0001_initial.sql','0002_data_migrations.sql'])await db.batch(
      migrationSql(resolve('migrations/business',file)).map(s=>db.prepare(s)));
    await db.batch(migrationSql('migrations/business/0004_query_cost.sql').map(s=>db.prepare(s)));
    const created:any=await executeTool(isolatedEnv,ai,'cases_create',{name:'清理验证合成案',request_key:key()}),cid=created.data.case_id;
    await executeTool(isolatedEnv,ai,'lines_add',{case_ref:cid,text:'重复原文\n重复原文\n',request_key:key()});
    const time=new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO operations VALUES('import-test','personal','migration','import-test','synthetic','legacy_import','{}',?)").bind(time),
      db.prepare("INSERT INTO operations VALUES('upgrade-test','personal','parser-v2-migration','upgrade-test','synthetic','parser_v2_normalize_marker','{}',?)").bind(time),
      db.prepare("INSERT INTO audit_changes VALUES('import-audit','import-test','personal',?,NULL,'migration','migration','migration','legacy_import',NULL,'{}',?)").bind(cid,time),
      db.prepare("INSERT INTO write_guards VALUES('upgrade-test',1)"),
      db.prepare("INSERT INTO import_sources VALUES('synthetic.md','synthetic',?,?,'original synthetic document')").bind(cid,time),
      db.prepare("INSERT INTO data_migrations VALUES('parser-v2',?)").bind(time),
      db.prepare("UPDATE cases SET legacy_metadata='original synthetic metadata' WHERE id=?").bind(cid),
      db.prepare("UPDATE log_lines SET source_operation_id='import-test'"),
      db.prepare("INSERT INTO read_snapshots VALUES('old-tool','personal','test-ai','lines_search','synthetic','{}','9999-01-01T00:00:00Z')"),
      db.prepare("INSERT INTO read_snapshot_rows VALUES('old-tool',1,'{}')"),
    ]);
    const args={case_ref:cid,result_type:'lines',limit:1},first:any=await executeTool(isolatedEnv,ai,'search',args);
    const currentLines=(await db.prepare('SELECT * FROM log_lines ORDER BY id').all()).results;
    const currentCase:any=await db.prepare('SELECT * FROM cases WHERE id=?').bind(cid).first();delete currentCase.legacy_metadata;
    const receipts=(await db.prepare("SELECT * FROM operations WHERE action NOT IN ('legacy_import','parser_v2_normalize_marker') ORDER BY id").all()).results;
    const audit=(await db.prepare("SELECT * FROM audit_changes WHERE action NOT IN ('legacy_import','parser_v2_normalize_marker') ORDER BY id").all()).results;
    const sql=readFileSync('migrations/business/0003_retire_legacy_import.sql','utf8').split(';').map(s=>s.trim()).filter(Boolean);
    const retire=()=>db.batch(sql.map(s=>db.prepare(s)));
    await db.prepare('UPDATE line_index SET parser_version=1').run();
    await assert.rejects(retire());
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM import_sources').first<any>()).n,1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM operations WHERE action='legacy_import'").first<any>()).n,1);
    await db.prepare('UPDATE line_index SET parser_version=2').run();
    await retire();
    const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<any>()).results.map(r=>r.name);
    assert.ok(!tables.includes('import_sources')&&!tables.includes('data_migrations'));
    assert.deepEqual((await db.prepare('SELECT * FROM log_lines ORDER BY id').all()).results,currentLines);
    assert.deepEqual(await db.prepare('SELECT * FROM cases WHERE id=?').bind(cid).first(),currentCase);
    assert.deepEqual((await db.prepare('SELECT * FROM operations ORDER BY id').all()).results,receipts);
    assert.deepEqual((await db.prepare('SELECT * FROM audit_changes ORDER BY id').all()).results,audit);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM write_guards').first<any>()).n,0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM read_snapshot_rows WHERE snapshot_id='old-tool'").first<any>()).n,0);
    const next:any=await executeTool(isolatedEnv,ai,'search',{...args,cursor:first.data.next_cursor});
    assert.equal(next.data.matched_count,3);assert.equal(next.data.items[0].line.text,'重复原文');
    const original=(await executeTool(isolatedEnv,ai,'cases_get',{case_ref:cid}) as any).data;
    const saved=await saveNotes(isolatedEnv,web,{case_ref:cid,expected_document_revision:original.document_revision,
      lines:original.lines.map((l:any,n:number)=>({line_id:l.line_id,text:n===0?'更新后的合成原文':l.text})),request_key:key()});
    assert.equal(saved.data.changed,1);
  }finally{await isolated.dispose();}
});

test('browser keyset pages search unloaded notes and exclude other workspaces',async()=>{
  const ids=[];for(let n=0;n<5;n++)ids.push(await create('网页分页'+n));
  await call('lines_add',{case_ref:ids[4],text:'未载入正文中的独有关键词',request_key:key()});
  const first:any=await webRead(env,web,'cases',{group:'active',query:'网页分页',limit:2});
  assert.equal(first.data.items.length,2);assert.equal(first.data.matched_count,5);
  const next:any=await webRead(env,web,'cases',{group:'active',query:'网页分页',limit:2,cursor:first.data.next_cursor});
  assert.equal(new Set([...first.data.items,...next.data.items].map(c=>c.id)).size,4);
  const search:any=await webRead(env,web,'cases',{query:'独有关键词'});assert.equal(search.data.items[0].id,ids[4]);assert.match(search.data.items[0].match_text,/独有关键词/);
  await assert.rejects(webRead(env,web,'cases',{query:'不同过滤',limit:2,cursor:first.data.next_cursor}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  const other:any=await webRead(env,{...web,workspaceId:'other'},'cases',{});assert.equal(other.data.items.length,0);
  await assert.rejects(webRead(env,ai,'cases',{}),(e:AppError)=>e.code==='PERMISSION_DENIED');
});

test('unified search matches case metadata and full note lines without expanding a metadata hit into every line',async()=>{
  const created:any=await call('cases_create',{name:'检索案名独有词',cause:'检索案由独有词',court:'检索法院独有词',case_number:'检索案号独有词',aliases:['检索别名独有词'],request_key:key()});
  const cid=created.data.case_id;
  await call('lines_add',{case_ref:cid,text:'2026.10.11 09:30 全局正文独有词 第一条\n2026.10.12 全局正文独有词 第二条\n无关原文',request_key:key()});
  for(const query of ['检索案名独有词','检索案由独有词','检索法院独有词','检索案号独有词','检索别名独有词']){
    const found:any=await call('search',{query});assert.equal(found.data.matched_count,1);assert.equal(found.data.items[0].type,'case');assert.equal(found.data.items[0].case.id,cid);
  }
  const global:any=await call('search',{query:'全局正文独有词'});
  assert.equal(global.data.matched_count,3);assert.deepEqual(global.data.items.map((x:any)=>x.type),['case','line','line']);
  assert.deepEqual(global.data.items.filter((x:any)=>x.type==='line').map((x:any)=>x.line.text),['2026.10.11 09:30 全局正文独有词 第一条','2026.10.12 全局正文独有词 第二条']);
  const row=global.data.items[1];assert.equal(row.case.id,cid);assert.equal(row.line.case_id,cid);assert.ok(row.line.line_id);assert.equal(row.line.version,1);
  const cases:any=await call('search',{query:'全局正文独有词',result_type:'cases'});assert.equal(cases.data.matched_count,1);assert.equal(cases.data.items[0].type,'case');
  const list:any=await call('search',{limit:5});assert.ok(list.data.items.every((x:any)=>x.type==='case'));assert.equal(list.data.effective_filters.result_type,'cases');
});

test('unified search separates record dates from opened dates and applies scope, case kind and row kind filters',async()=>{
  const active:any=await call('cases_create',{name:'筛选统一检索在办',opened_date:'2026-01-02',request_key:key()});
  const archived:any=await call('cases_create',{name:'筛选统一检索归档',opened_date:'2026-02-02',request_key:key()});
  const affair:any=await call('cases_create',{name:'筛选统一检索事务',kind:'affair',opened_date:'2026-03-02',request_key:key()});
  for(const cid of [active.data.case_id,archived.data.case_id,affair.data.case_id])await call('lines_add',{case_ref:cid,text:'2026.10.11 筛选正文独有词\n- 📅 2026.10.12 09:00 筛选正文独有词\n无日期 筛选正文独有词',request_key:key()});
  await call('cases_update',{case_ref:archived.data.case_id,expected_metadata_version:1,fields:{status:'结案'},request_key:key()});
  const dated:any=await call('search',{from_date:'2026-10-12',to_date:'2026-10-12',kinds:['schedule'],scope:'active',kind:'case'});
  assert.equal(dated.data.items.filter((x:any)=>x.case.id===active.data.case_id).length,1);assert.ok(dated.data.items.every((x:any)=>x.type==='line'&&x.line.date==='2026-10-12'&&x.line.kind==='schedule'&&x.case.status==='在办'&&x.case.kind==='case'));
  const opened:any=await call('search',{query:'筛选统一检索',opened_from:'2026-02-01',opened_to:'2026-02-28',result_type:'cases'});
  assert.deepEqual(opened.data.items.map((x:any)=>x.case.id),[archived.data.case_id]);
  const scoped:any=await call('search',{query:'筛选正文独有词',scope:'affairs'});assert.equal(scoped.data.matched_count,4);assert.ok(scoped.data.items.every((x:any)=>x.case.id===affair.data.case_id));
  const rows:any=await call('search',{case_ref:'筛选统一检索在办',kinds:['record']});assert.equal(rows.data.items.length,2);assert.ok(rows.data.items.every((x:any)=>x.type==='line'));
  const constrained:any=await call('search',{query:'筛选统一检索',from_date:'2028-01-01',result_type:'cases'});assert.equal(constrained.data.matched_count,0);
  await assert.rejects(call('search',{opened_from:'2026-02-01',opened_to:'2026-01-01'}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(call('search',{from_date:'2026-10-12',to_date:'2026-10-11'}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(call('search',{kinds:Array(100).fill('record')}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(call('search',{case_ref:archived.data.case_id,scope:'active'}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
});

test('unified search keeps empty cases, escapes literal wildcards and isolates workspace and deleted lines',async()=>{
  const cid=await create('空案检索百分%下划_反斜\\标记');
  const literal:any=await call('search',{query:'百分%下划_反斜\\'});assert.equal(literal.data.matched_count,1);assert.equal(literal.data.items[0].case.id,cid);
  await call('lines_add',{case_ref:cid,text:'移除检索独有词\n保留检索独有词',request_key:key()});const doc=await lines(cid);
  await call('lines_delete',{case_ref:cid,line_id:doc.lines[0].line_id,expected_line_version:1,request_key:key()});
  const deleted:any=await call('search',{query:'移除检索独有词'});assert.equal(deleted.data.matched_count,0);
  const other:any=await call('search',{query:'保留检索独有词'},{...ai,workspaceId:'other'});assert.equal(other.data.matched_count,0);
  await assert.rejects(call('cases_search',{}),(e:AppError)=>e.code==='INVALID_ARGUMENT');await assert.rejects(call('lines_search',{query:'保留检索独有词'}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
});

test('mixed search pages preserve order and bindings and require a restart after body or metadata changes',async()=>{
  const cid=await create('混合分页独有词案');await call('lines_add',{case_ref:cid,text:'混合分页独有词 第一行\n混合分页独有词 第二行\n混合分页独有词 第三行',request_key:key()});
  const args={query:'混合分页独有词',limit:2};const first:any=await call('search',args);assert.equal(first.data.matched_count,4);assert.equal(first.data.has_more,true);
  const next:any=await call('search',{...args,cursor:first.data.next_cursor});assert.equal(next.data.has_more,false);assert.equal(next.data.items[0].line.text,'混合分页独有词 第二行');assert.equal(next.data.items[0].case.name,'混合分页独有词案');
  const combined=[...first.data.items,...next.data.items];assert.equal(new Set(combined.map((x:any)=>x.type==='case'?x.case.id:x.line.line_id)).size,4);
  await assert.rejects(call('search',{...args,result_type:'lines',cursor:first.data.next_cursor}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  const doc=await lines(cid);await call('lines_update',{case_ref:cid,line_id:doc.lines[1].line_id,expected_line_version:1,text:'后来改掉匹配文字',request_key:key()});
  await call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{name:'后来改掉案件名'},request_key:key()});
  await assert.rejects(call('search',{...args,cursor:first.data.next_cursor}),(e:AppError)=>e.code==='READ_CHANGED');
  const fresh:any=await call('search',args);assert.equal(fresh.data.matched_count,3);assert.equal(fresh.data.items[0].case.name,'后来改掉案件名');
});

test('large notes keep TODO and search reads bounded without creating unneeded snapshots',async()=>{
  const p={...ai,workspaceId:'query-cost'},browser={...web,workspaceId:p.workspaceId};
  const created:any=await call('cases_create',{name:'读取成本合成案',request_key:key()},p),cid=created.data.case_id;
  const text=Array.from({length:1200},(_,n)=>`2030.01.01 ${n%3===0?'成本匹配':'普通合成记录'} ${n}`);
  for(let n=0;n<text.length;n+=500)await call('lines_add',{case_ref:cid,text:text.slice(n,n+500).join('\n'),request_key:key()},p);
  await call('lines_add',{case_ref:cid,text:Array.from({length:6},(_,n)=>`- [ ] 合成待办 ${n} #截止2031.01.01`).join('\n'),request_key:key()},p);
  const m=meter(env.DB),measured={...env,DB:m.db};
  const todos:any=await webRead(measured,browser,'todos',{});assert.equal(todos.data.items.length,6);
  assert.ok(m.entries.reduce((n,r)=>n+r.read,0)<100,JSON.stringify(m.entries));
  m.entries.length=0;
  const aiTodos:any=await executeTool(measured,p,'todos_list',{});assert.equal(aiTodos.data.items.length,6);
  assert.ok(m.entries.reduce((n,r)=>n+r.read,0)<100);assert.equal(m.entries.reduce((n,r)=>n+r.written,0),0);
  m.entries.length=0;
  const stats:any=await webRead(measured,browser,'stats',{today:'2030-01-01'});assert.equal(stats.data.counts.todos,6);
  assert.ok(m.entries.filter(r=>r.sql.includes("i.kind='todo'")).reduce((n,r)=>n+r.read,0)<40);
  m.entries.length=0;
  const found:any=await executeTool(measured,p,'search',{case_ref:cid,query:'成本匹配',result_type:'lines',limit:500});
  assert.equal(found.data.items.length,400);assert.equal(found.data.snapshot_id,null);
  const reads=m.entries.reduce((n,r)=>n+r.read,0);assert.ok(reads<10_000,`search scanned ${reads} rows`);
  assert.equal(m.entries.reduce((n,r)=>n+r.written,0),0);
  for(let n=0;n<3;n++){
    m.entries.length=0;
    const first:any=await executeTool(measured,p,'search',{case_ref:cid,query:'成本匹配',result_type:'lines',limit:1});
    assert.equal(first.data.has_more,true);assert.equal(first.data.matched_count,400);
    assert.equal(m.entries.reduce((sum,r)=>sum+r.written,0),0);
    assert.ok(m.entries.reduce((sum,r)=>sum+r.read,0)<10_000);
  }
  m.entries.length=0;
  const cases:any=await webRead(measured,browser,'cases',{});
  assert.equal(cases.data.items[0].recent_activity,'2031-01-01');
  assert.ok(m.entries.reduce((n,r)=>n+r.read,0)<4_000);
});

test('read-only keyset pages reuse totals and reject tampering, changed bindings and expired or retired cursors',async()=>{
  const cid=await create('只读分页'+('长中文案名|'.repeat(28)));
  await call('lines_add',{case_ref:cid,text:'甲\n乙\n丙\n丁',request_key:key()});
  const args={case_ref:cid,result_type:'lines',limit:1},m=meter(env.DB),measured={...env,DB:m.db};
  const first:any=await executeTool(measured,ai,'search',args);
  assert.equal(first.data.snapshot_id,null);assert.equal(first.data.complete,true);
  assert.equal(first.data.matched_count,4);assert.equal(first.data.total,undefined);
  assert.ok(first.data.next_cursor.length<=4096);
  m.entries.length=0;
  const next:any=await executeTool(measured,ai,'search',{...args,cursor:first.data.next_cursor});
  assert.equal(next.data.matched_count,4);assert.equal(next.data.items[0].line.text,'乙');
  assert.deepEqual(next.data.effective_filters,first.data.effective_filters);
  assert.ok(m.entries.every(r=>!r.sql.includes('AS total')&&!r.sql.includes('read_snapshot')&&r.written===0));
  const changed=first.data.next_cursor.split('.');changed[0]=changed[0].slice(0,5)+(changed[0][5]==='A'?'B':'A')+changed[0].slice(6);
  for(const [cursor,p,tool,query] of [
    [changed.join('.'),ai,'search',args],
    [first.data.next_cursor,{...ai,clientId:'another'},'search',args],
    [first.data.next_cursor,web,'search',args],
    [first.data.next_cursor,ai,'todos_list',{case_ref:cid,limit:1}],
    [first.data.next_cursor,ai,'search',{...args,limit:2}],
  ] as const)await assert.rejects(executeTool(measured,p,tool,{...query,cursor}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  const old=btoa(JSON.stringify(['retired-snapshot',1]));
  await assert.rejects(executeTool(measured,ai,'search',{...args,cursor:old}),(e:AppError)=>e.code==='CURSOR_EXPIRED');
  const before=Date.now;Date.now=()=>before()+16*60_000;
  try{await assert.rejects(executeTool(measured,ai,'search',{...args,cursor:first.data.next_cursor}),(e:AppError)=>e.code==='CURSOR_EXPIRED');}
  finally{Date.now=before;}
  assert.ok(m.entries.every(r=>r.written===0));
});

test('full case pages preserve original UTF-8 text and identity without writes and reject metadata changes',async()=>{
  const cid=await create('大正文只读案'),other=await create('无关分页案');
  const text=Array.from({length:130},(_,n)=>n===50?'':`重复中文原文 ${n%2} ${'正文'.repeat(600)}`).join('\n');
  await call('lines_add',{case_ref:cid,text,request_key:key()});
  const expected=(await env.DB.prepare('SELECT id,version,raw_text FROM log_lines WHERE case_id=? AND deleted_at IS NULL ORDER BY sort_order,id').bind(cid).all<any>()).results;
  const m=meter(env.DB),measured={...env,DB:m.db};
  const first:any=await executeTool(measured,ai,'cases_get',{case_ref:cid});
  assert.equal(first.data.has_more,true);assert.ok(Buffer.byteLength(JSON.stringify(first.data))<170_000);
  await call('lines_add',{case_ref:other,text:'无关案件更新',request_key:key()});
  const rows=[...first.data.lines];let page=first;
  while(page.data.has_more){page=await executeTool(measured,ai,'cases_get',{case_ref:cid,cursor:page.data.next_cursor});rows.push(...page.data.lines);}
  assert.deepEqual(rows,expected.map(r=>({line_id:r.id,version:r.version,text:r.raw_text})));
  assert.equal(rows.map(r=>r.text).join('\n'),text);assert.equal(page.data.page_start+page.data.returned_count,130);
  const c=first.data.case;await call('cases_update',{case_ref:cid,expected_metadata_version:c.metadata_version,fields:{name:'修改后的大正文只读案'},request_key:key()});
  await assert.rejects(executeTool(measured,ai,'cases_get',{case_ref:cid,cursor:first.data.next_cursor}),(e:AppError)=>e.code==='READ_CHANGED');
  assert.ok(m.entries.every(r=>r.written===0&&!r.sql.includes('read_snapshot')));
});

test('AI TODO and schedule pages retain duplicate identities with zero writes and detect archival during paging',async()=>{
  const cid=await create('重复事项只读分页案');
  const todo='- [ ] 重复待办 #截止2031.01.01',schedule='- 📅 2031.01.01 09:00 重复日程';
  await call('lines_add',{case_ref:cid,text:[todo,todo,todo,schedule,schedule,schedule].join('\n'),request_key:key()});
  const doc=await lines(cid),m=meter(env.DB),measured={...env,DB:m.db};
  for(const [tool,text] of [['todos_list',todo],['schedules_list',schedule]]){
    const args={case_ref:cid,limit:1},rows:any[]=[];let cursor:string|undefined;
    do{
      const page:any=await executeTool(measured,ai,tool,{...args,...(cursor?{cursor}:{})});
      assert.equal(page.data.matched_count,3);assert.equal(page.data.snapshot_id,null);
      rows.push(...page.data.items);cursor=page.data.next_cursor??undefined;
    }while(cursor);
    assert.deepEqual(rows.map(r=>r.line_id),doc.lines.filter((r:any)=>r.text===text).map((r:any)=>r.line_id));
  }
  assert.ok(m.entries.every(r=>r.written===0&&!r.sql.includes('read_snapshot')));
  const args={case_ref:cid,scope:'active',limit:1},first:any=await call('todos_list',args);
  await call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{status:'结案'},request_key:key()});
  await assert.rejects(call('todos_list',{...args,cursor:first.data.next_cursor}),(e:AppError)=>e.code==='READ_CHANGED');
  const searchArgs={case_ref:cid,scope:'archived',result_type:'lines',limit:1},searched:any=await call('search',searchArgs);
  await call('cases_update',{case_ref:cid,expected_metadata_version:2,fields:{status:'在办'},request_key:key()});
  await assert.rejects(call('search',{...searchArgs,cursor:searched.data.next_cursor}),(e:AppError)=>e.code==='READ_CHANGED');
});

test('daily quota failures identify reset time and never request immediate retry',()=>{
  for(const kind of ['read','write']){
    const result=failure(new Error(`D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`));
    assert.equal(result.error.code,'DAILY_LIMIT_EXCEEDED');assert.equal(result.error.retryable,false);
    assert.equal(result.error.commit_state,'unknown');assert.match(result.error.next_action,/原 request_key/);
    assert.match((result.error.details as any).resets_at,/T00:00:00.000Z$/);
    assert.equal(errorResponseSchema.safeParse(result).success,true);
  }
  assert.equal(failure(new Error('ordinary network failure')).error.retryable,true);
});

test('live verification exercises REST and MCP on both hosts without snapshot writes and stops on daily quota',async()=>{
  for(const name of ['续页核验事务一','续页核验事务二'])await call('cases_create',{name,kind:'affair',request_key:key()});
  const source=readFileSync('tools/check-deployment.mjs','utf8'),searches:any[]=[],waits:number[]=[];
  const config={CLOUDFLARE_ACCOUNT_ID:'synthetic-account',CLOUDFLARE_API_TOKEN:'synthetic-deployment-token',
    WEB_PASSWORD:'test-password',DEPLOYMENT_URL:'https://synthetic-domain.test'};
  const before=(await env.DB.prepare('SELECT COUNT(*) AS n FROM read_snapshots').first<any>()).n;
  let quota=false,attempts=0;
  const fakeFetch=async(url:string,options:any={})=>{
    if(new URL(url).host==='api.cloudflare.com')return Response.json({success:true,result:{subdomain:'synthetic-worker'}});
    const body=options.body&&String(options.headers?.['Content-Type']??'').startsWith('application/json')?JSON.parse(String(options.body)):null;
    const authenticated=new URL(url).pathname==='/api/v1/search'&&options.headers?.Authorization;
    if(authenticated){attempts++;if(quota)return Response.json(failure(new Error("Your account has exceeded D1's free tier daily row read limit.")),{status:503});}
    const result=await mf.dispatchFetch(url,options);
    if(authenticated||body?.method==='tools/call'){
      const data=await result.clone().json() as any;
      searches.push(body?.method==='tools/call'?data.result?.structuredContent?.data:data.data);
    }
    return result;
  };
  const run=()=>runInNewContext(`(async()=>{${source}\n})()`,{fetch:fakeFetch,URL,URLSearchParams,crypto,Buffer,TextEncoder,process:{env:config},console:{log(){}},
    setTimeout:(fn:()=>void,ms:number)=>{waits.push(ms);fn();}});
  await run();assert.equal(searches.length,8);assert.ok(searches.every(s=>s.snapshot_id===null));
  assert.equal(searches.filter(s=>s.page_start===1).length,4);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM read_snapshots').first<any>()).n,before);
  assert.equal(waits.length,0);
  quota=true;attempts=0;await assert.rejects(run(),/daily quota exceeded/);
  assert.equal(attempts,1);assert.equal(waits.length,0);
});

test('browser schedules preserve future/history ordering and calendar counts include archives',async()=>{
  const cid=await create('网页日程排序案');
  await call('lines_add',{case_ref:cid,text:'- 📅 2026.10.09 09:00 历史早\n- 📅 2026.10.09 14:00 历史晚\n- 📅 2026.10.11 14:00 未来晚\n- 📅 2026.10.11 09:00 未来早',request_key:key()});
  const args={mode:'all',today:'2026-10-10',from_date:'2026-10-09',to_date:'2026-10-11',limit:2};
  const a:any=await webRead(env,web,'schedules',args),b:any=await webRead(env,web,'schedules',{...args,cursor:a.data.next_cursor});
  assert.deepEqual([...a.data.items,...b.data.items].filter(x=>x.case_id===cid).map(x=>x.event_time),['09:00','14:00','14:00','09:00']);
  await call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{status:'结案'},request_key:key()});
  const counts:any=await webRead(env,web,'calendar-counts',{});assert.ok(counts.data.items.find((x:any)=>x.date==='2026-10-11').count>=2);
  const month:any=await webRead(env,web,'schedules',{mode:'future',today:'0001-01-01',from_date:'2026-10-01',to_date:'2026-10-31'});assert.equal(month.data.items.filter((x:any)=>x.case_id===cid).length,4);
});

test('collapsed activity stats match both paged windows and exclude deleted, stale and out-of-scope lines',async()=>{
  const principal={...ai,workspaceId:'activity-stats'},browser={...web,workspaceId:principal.workspaceId};
  const make=async(name:string,kind='case')=>{
    const r:any=await call('cases_create',{name,kind,request_key:key()},principal);return r.data.case_id;
  };
  const active=await make('近期计数在办'),archived=await make('近期计数归档'),affair=await make('近期计数事务','affair');
  await call('lines_add',{case_ref:active,text:['2026.10.11 今天','2026.10.04 七天边界','2026.09.11 三十天边界','2026.09.10 窗口之前','2026.10.12 未来','没有日期','2026.10.10 删除记录','2026.10.09 失效索引'].join('\n'),request_key:key()},principal);
  const doc:any=(await call('cases_get',{case_ref:active},principal) as any).data;
  await call('lines_delete',{case_ref:active,line_id:doc.lines[6].line_id,expected_line_version:1,request_key:key()},principal);
  await env.DB.prepare('UPDATE line_index SET source_line_version=0 WHERE line_id=?').bind(doc.lines[7].line_id).run();
  await call('lines_add',{case_ref:archived,text:'2026.10.08 归档记录',request_key:key()},principal);
  await call('cases_update',{case_ref:archived,expected_metadata_version:1,fields:{status:'结案'},request_key:key()},principal);
  await call('lines_add',{case_ref:affair,text:'2026.10.07 事务记录',request_key:key()},principal);
  const stats:any=await webRead(env,browser,'stats',{today:'2026-10-11'});
  assert.equal(stats.data.counts.activity_7,4);assert.equal(stats.data.counts.activity_30,5);
  for(const days of [7,30]){
    const page:any=await webRead(env,browser,'activity',{today:'2026-10-11',days,limit:1});
    assert.equal(stats.data.counts['activity_'+days],page.data.matched_count);assert.equal(page.data.has_more,true);
  }
  const empty:any=await webRead(env,{...browser,workspaceId:'activity-empty'},'stats',{today:'2026-10-11'});
  assert.equal(empty.data.counts.activity_7,0);assert.equal(empty.data.counts.activity_30,0);
  await call('lines_add',{case_ref:active,text:'2026.10.11 新增完成记录',request_key:key()},principal);
  const updated:any=await webRead(env,browser,'stats',{today:'2026-10-11'});
  assert.equal(updated.data.counts.activity_7,5);assert.equal(updated.data.counts.activity_30,6);
});

test('editing one line leaves untouched rows, sparse order, versions and operation IDs unchanged',async()=>{
  const cid=await create('稀疏顺序案');await call('lines_add',{case_ref:cid,text:'第一行\n移除行\n第三行',request_key:key()});
  const original=await lines(cid);
  await call('lines_delete',{case_ref:cid,line_id:original.lines[1].line_id,expected_line_version:1,request_key:key()});
  const before=(await env.DB.prepare('SELECT * FROM log_lines WHERE case_id=? AND deleted_at IS NULL ORDER BY sort_order').bind(cid).all<any>()).results;
  const doc=await lines(cid),rows=doc.lines.map((l:any,n:number)=>({line_id:l.line_id,text:n===0?'修改第一行':l.text}));
  const args={case_ref:cid,expected_document_revision:doc.document_revision,lines:rows,request_key:key()};
  const saved:any=await saveNotes(env,web,args);assert.equal(saved.data.changed,1);assert.equal(saved.data.lines[0].text,undefined);
  assert.deepEqual(saved.data.case,(await lines(cid)).case);
  const after=(await env.DB.prepare('SELECT * FROM log_lines WHERE case_id=? AND deleted_at IS NULL ORDER BY sort_order').bind(cid).all<any>()).results;
  assert.deepEqual(after[1],before[1]);assert.equal(after[0].sort_order,before[0].sort_order);assert.equal(after[0].version,2);
  const audit=await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_changes WHERE operation_id=?').bind(saved.data.operation_id).first<any>();assert.equal(audit.n,1);
  const replay:any=await saveNotes(env,web,args);assert.equal(replay.data.replayed,true);assert.deepEqual(replay.data.lines,saved.data.lines);
  const indices=await env.DB.prepare('SELECT display_text,source_line_version FROM line_index WHERE line_id=?').bind(before[0].id).first<any>();assert.equal(indices.display_text,'修改第一行');assert.equal(indices.source_line_version,2);
});

test('note receipt contains committed recent activity and replays the same case metadata',async()=>{
  const cid=await create('保存回执元数据案');
  await call('lines_add',{case_ref:cid,text:'2026.10.01 原记录',request_key:key()});
  const doc=await lines(cid),args={case_ref:cid,expected_document_revision:doc.document_revision,lines:[{line_id:doc.lines[0].line_id,text:'2026.12.03 新记录'}],request_key:key()};
  const saved:any=await saveNotes(env,web,args);
  assert.equal(saved.data.case.recent_activity,'2026-12-03');assert.deepEqual(saved.data.case,(await lines(cid)).case);
  await call('lines_add',{case_ref:cid,text:'2027.01.01 后续记录',request_key:key()});
  const replay:any=await saveNotes(env,web,args);
  assert.equal(replay.data.replayed,true);assert.deepEqual(replay.data.case,saved.data.case);
});

test('large concurrent note saves return version conflicts without exceeding bind limits',async()=>{
  const cid=await create('大笔记竞争案');await call('lines_add',{case_ref:cid,text:Array.from({length:120},(_,n)=>'记录'+n).join('\n'),request_key:key()});
  const doc=await lines(cid);
  const result=await Promise.allSettled(['甲','乙'].map(text=>saveNotes(env,web,{case_ref:cid,expected_document_revision:doc.document_revision,lines:doc.lines.map((l:any,n:number)=>({line_id:l.line_id,text:n===0?text:l.text})),request_key:key()})));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const failure=result.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failure.reason.code,'VERSION_CONFLICT');
});

test('multi-line add preserves whitespace and makes one atomic audit/receipt',async()=>{
  const cid=await create('原文保存案'),text='  原文  \n\n- [ ] 调卷 #等待\n- 📅 2026.11.03 09:00 开庭\n';
  const added:any=await call('lines_add',{case_ref:cid,text,request_key:key()});assert.equal(added.data.added,5);
  const detail=await lines(cid);assert.equal(detail.lines.map((l:any)=>l.text).join('\n'),text);
  const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_changes WHERE operation_id=?').bind(added.data.operation_id).first<any>();assert.equal(count.n,5);
  const todos:any=await call('todos_list',{case_ref:cid});assert.equal(todos.data.items.length,1);
});
test('same-key retry and concurrent retry never duplicate, including different-tool conflict',async()=>{
  const cid=await create('重试案'),args={case_ref:cid,text:'相同文字',request_key:key()};
  const [a,b]=await Promise.all([call('lines_add',args),call('lines_add',args)]);
  assert.equal((a as any).data.operation_id,(b as any).data.operation_id);assert.equal((await lines(cid)).lines.length,1);
  await assert.rejects(call('lines_add',{...args,text:'另一内容'}),(e:AppError)=>e.code==='IDEMPOTENCY_CONFLICT');
  await call('lines_add',{...args,request_key:key()});assert.equal((await lines(cid)).lines.length,2);
});

test('same-key retries replay when the winner commits between receipt lookup and preflight checks',async()=>{
  for(const action of ['cases_create','cases_update','lines_update','lines_delete','lines_add','web_save_notes','web_complete_todo']){
    const cid=await create('回执竞争'+action);await call('lines_add',{case_ref:cid,text:'- [ ] 原事项',request_key:key()});
    const doc=await lines(cid),line=doc.lines[0],request_key=key();
    const args:any=action==='cases_create'?{name:'并发新建'+key(),request_key}:action==='cases_update'?{case_ref:cid,expected_metadata_version:1,fields:{status:'结案'},request_key}
      :action==='lines_add'?{case_ref:cid,before_line_id:line.line_id,expected_document_revision:doc.document_revision,text:'插入',request_key}
      :action==='web_save_notes'?{case_ref:cid,expected_document_revision:doc.document_revision,lines:[{line_id:line.line_id,text:'改文'}],request_key}
      :{case_ref:cid,line_id:line.line_id,expected_line_version:1,request_key,...(action==='lines_update'?{text:'改文'}:{})};
    let count=0,secondRead!:()=>void,winnerDone!:()=>void;
    const captured=new Promise<void>(resolve=>{secondRead=resolve;}),committed=new Promise<void>(resolve=>{winnerDone=resolve;});
    const delayed={prepare(sql:string){const prepared=env.DB.prepare(sql);if(!sql.startsWith('SELECT * FROM operations'))return prepared;
      return {bind(...params:any[]){const bound=prepared.bind(...params);return {async first(){const n=++count,result=await bound.first();
        if(n===1)await captured;if(n===2){secondRead();await committed;}return result;}};}};
    },batch:(statements:D1PreparedStatement[])=>env.DB.batch(statements)} as D1Database;
    const delayedEnv={...env,DB:delayed};
    const invoke=()=>action==='web_save_notes'?saveNotes(delayedEnv,web,args):action==='web_complete_todo'?completeTodo(delayedEnv,web,args):executeTool(delayedEnv,ai,action,args);
    const winner=invoke().finally(winnerDone),retry=invoke().finally(winnerDone);const [a,b]=await Promise.all([winner,retry]);
    assert.equal(a.data.operation_id,b.data.operation_id,action);assert.equal(Number(a.data.replayed)+Number(b.data.replayed),1,action);
    const receipt=await env.DB.prepare('SELECT COUNT(*) AS n FROM operations WHERE request_key=?').bind(request_key).first<any>();assert.equal(receipt.n,1);
  }
});

test('long literal search terms work across AI and web metadata, aliases, notes and read-only pages',async()=>{
  const long='中文长片段'.repeat(40)+' MiXeD%_\\',cid=await create('长片段搜索案');
  await call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{court:long,aliases:[long.slice(0,150)]},request_key:key()});
  await call('lines_add',{case_ref:cid,text:(long+' 第一条\n'+long+' 第二条'),request_key:key()});
  const query=long.replace('MiXeD','mixed');
  const first:any=await call('search',{query,limit:1});assert.equal(first.data.matched_count,3);
  const next:any=await call('search',{query,limit:1,cursor:first.data.next_cursor});assert.equal(next.data.items[0].line.text,long+' 第一条');
  const browser:any=await webRead(env,web,'cases',{query:query.slice(-100)});assert.equal(browser.data.items[0].id,cid);assert.equal(browser.data.items[0].match_text,long+' 第一条');
  const alias:any=await call('search',{query:long.slice(0,150),result_type:'cases'});assert.equal(alias.data.items[0].case.id,cid);
  const response=await mf.dispatchFetch('http://localhost/api/v1/search',{method:'POST',headers:{Authorization:'Bearer '+await oauthAccessToken(),'Content-Type':'application/json'},body:JSON.stringify({query})});
  assert.equal(response.status,200);assert.equal((await response.json() as any).ok,true);
});

test('undated TODO inclusion respects explicit true, false and range-dependent defaults',async()=>{
  const cid=await create('无期限筛选');await call('lines_add',{case_ref:cid,text:'- [ ] 无期限\n- [ ] 范围内 #截止2026.10.15\n- [ ] 范围外 #截止2026.10.20',request_key:key()});
  const count=async(args:any)=>(await call('todos_list',{case_ref:cid,...args})).data.matched_count;
  assert.equal(await count({}),3);assert.equal(await count({include_undated:true}),3);assert.equal(await count({include_undated:false}),2);
  const range={due_from:'2026-10-15',due_to:'2026-10-15'};
  assert.equal(await count(range),1);assert.equal(await count({...range,include_undated:true}),2);assert.equal(await count({...range,include_undated:false}),1);
});

test('5000-line saves keep every SQL string below D1 limits and commit index, audit and replay atomically',async()=>{
  const cid=await create('最大笔记分块'),original='中'.repeat(45),replacement='文'.repeat(45);let maxBytes=0;
  const bounded={prepare(sql:string){const prepared=env.DB.prepare(sql);return {bind(...params:any[]){for(const p of params)if(typeof p==='string'){
    const size=Buffer.byteLength(p);maxBytes=Math.max(maxBytes,size);assert.ok(size<2_000_000,'D1 string size exceeded');}
    return prepared.bind(...params);}};},batch:(statements:D1PreparedStatement[])=>{assert.ok(statements.length<50);return env.DB.batch(statements);}} as D1Database;
  const boundedEnv={...env,DB:bounded},args={case_ref:cid,expected_document_revision:1,lines:Array.from({length:5000},()=>({text:original})),request_key:key()};
  assert.ok(Buffer.byteLength(JSON.stringify(args))<1_048_576);
  const created=await saveNotes(boundedEnv,web,args);assert.equal(created.data.lines.length,5000);
  assert.equal((await saveNotes(boundedEnv,web,args)).data.operation_id,created.data.operation_id);
  const edit={case_ref:cid,expected_document_revision:created.data.document_revision,lines:created.data.lines.map((l:any)=>({line_id:l.line_id,text:replacement})),request_key:key()};
  assert.ok(Buffer.byteLength(JSON.stringify(edit))<1_048_576);
  const changed=await saveNotes(boundedEnv,web,edit);assert.equal(changed.data.changed,5000);
  assert.ok(maxBytes>1_000_000);
  const rows=await env.DB.prepare(`SELECT COUNT(*) AS n,SUM(l.version=2 AND l.raw_text=? AND i.source_line_version=l.version AND i.display_text=?) AS valid
    FROM log_lines l JOIN line_index i ON i.line_id=l.id WHERE l.case_id=? AND l.deleted_at IS NULL`).bind(replacement,replacement,cid).first<any>();
  assert.equal(rows.n,5000);assert.equal(rows.valid,5000);
  const audits=await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_changes WHERE operation_id=?').bind(changed.data.operation_id).first<any>();assert.equal(audits.n,5000);
  const failedKey=key(),failedArgs={...edit,expected_document_revision:changed.data.document_revision,request_key:failedKey,lines:edit.lines.map((l:any)=>({...l,text:original}))};
  const broken={...bounded,batch:(statements:D1PreparedStatement[])=>bounded.batch([...statements.slice(0,-2),
    env.DB.prepare('INSERT INTO write_guards(operation_id,passed) SELECT id,0 FROM operations WHERE request_key=?').bind(failedKey),...statements.slice(-2)])} as D1Database;
  await assert.rejects(saveNotes({...env,DB:broken},web,failedArgs),(e:AppError)=>e.code==='VERSION_CONFLICT');
  const intact=await env.DB.prepare('SELECT COUNT(*) AS n FROM log_lines WHERE case_id=? AND raw_text=? AND version=2').bind(cid,replacement).first<any>();assert.equal(intact.n,5000);
  const failed=await env.DB.prepare('SELECT COUNT(*) AS n FROM operations WHERE request_key=?').bind(failedKey).first<any>();assert.equal(failed.n,0);
  assert.equal((await env.DB.prepare('SELECT document_revision FROM cases WHERE id=?').bind(cid).first<any>()).document_revision,changed.data.document_revision);
  await assert.rejects(saveNotes(boundedEnv,web,{...edit,request_key:key()}),(e:AppError)=>e.code==='VERSION_CONFLICT');
  const uncommitted=await env.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE result_json='{}'").first<any>();assert.equal(uncommitted.n,0);
});
test('concurrent updates use CAS, only winner has a committed operation and index',async()=>{
  const cid=await create('竞争修改案');await call('lines_add',{case_ref:cid,text:'旧文',request_key:key()});
  const original=(await lines(cid)).lines[0];
  const results=await Promise.allSettled(['甲','乙'].map(text=>call('lines_update',{case_ref:cid,line_id:original.line_id,expected_line_version:1,text,request_key:key()})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const rejected=results.find(x=>x.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.code,'VERSION_CONFLICT');
  const row=(await lines(cid)).lines[0];assert.equal(row.version,2);
  const index=await env.DB.prepare('SELECT source_line_version,display_text FROM line_index WHERE line_id=?').bind(row.line_id).first<any>();assert.equal(index.source_line_version,2);assert.equal(index.display_text,row.text);
  const failed=await env.DB.prepare('SELECT COUNT(*) AS n FROM operations WHERE action=? AND result_json=?').bind('lines_update','{}').first<any>();assert.equal(failed.n,0);
});
test('concurrent appends both survive and each receipt has its committed revision',async()=>{
  const cid=await create('并发追加案');const results:any[]=await Promise.all(['甲','乙'].map(text=>call('lines_add',{case_ref:cid,text,request_key:key()})));
  assert.equal((await lines(cid)).lines.length,2);assert.deepEqual(results.map(r=>r.data.document_revision).sort(),[2,3]);
});
test('AI completes, removes and reclassifies TODOs with versions, replay and audit',async()=>{
  const cid=await create('AI待办处理案');
  await call('lines_add',{case_ref:cid,text:'- [ ] 调卷\n- [ ] 调卷\n- [ ] 取消事项\n- [ ] 改为普通备注',request_key:key()});
  const before=await lines(cid),target=before.lines[0];
  const args={case_ref:cid,line_id:target.line_id,expected_line_version:target.version,text:'- [x] 2026.10.11 09:30 已完成：调卷',request_key:key()};
  const completed:any=await call('lines_update',args),replayed:any=await call('lines_update',args);
  assert.equal(replayed.data.replayed,true);assert.equal(replayed.data.operation_id,completed.data.operation_id);
  assert.equal(completed.data.lines[0].line_id,target.line_id);assert.equal(completed.data.lines[0].version,2);
  assert.equal(completed.data.lines[0].parsed.kind,'completed');
  assert.equal((completed as any).meta.parser_version,PARSER_VERSION);
  const todos:any=await call('todos_list',{case_ref:cid});
  assert.deepEqual(todos.data.items.map((r:any)=>r.line_id),before.lines.slice(1).map((r:any)=>r.line_id));
  await assert.rejects(call('lines_update',{...args,request_key:key()}),(e:AppError)=>e.code==='VERSION_CONFLICT');
  const removal={case_ref:cid,line_id:before.lines[2].line_id,expected_line_version:1,request_key:key()};
  const removed:any=await call('lines_delete',removal);assert.equal(removed.data.removed,1);
  assert.equal((await call('lines_delete',removal) as any).data.replayed,true);
  await call('lines_update',{case_ref:cid,line_id:before.lines[3].line_id,expected_line_version:1,text:'普通备注',request_key:key()});
  const after=await lines(cid);
  assert.equal(after.document_revision,before.document_revision+3);assert.equal(after.lines.length,3);
  assert.equal((await call('todos_list',{case_ref:cid}) as any).data.items[0].line_id,before.lines[1].line_id);
  const audit=await env.DB.prepare('SELECT before_json,after_json,source FROM audit_changes WHERE operation_id=?').bind(completed.data.operation_id).first<any>();
  assert.equal(audit.source,'ai');assert.equal(JSON.parse(audit.before_json).text,'- [ ] 调卷');
  assert.equal(JSON.parse(audit.after_json).text,args.text);
  const deleted=await env.DB.prepare('SELECT deleted_at,version FROM log_lines WHERE id=?').bind(removal.line_id).first<any>();
  assert.ok(deleted.deleted_at);assert.equal(deleted.version,2);
  await call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{status:'结案'},request_key:key()});
  await assert.rejects(call('lines_update',{...args,expected_line_version:2,request_key:key()}),(e:AppError)=>e.code==='CASE_READ_ONLY');
});

test('concurrent AI completion and removal of the same TODO commit only once',async()=>{
  const cid=await create('AI待办并发案');await call('lines_add',{case_ref:cid,text:'- [ ] 调卷',request_key:key()});
  const target=(await lines(cid)).lines[0],base={case_ref:cid,line_id:target.line_id,expected_line_version:1};
  const result=await Promise.allSettled([
    call('lines_update',{...base,text:'- [x] 2026.10.11 09:30 已完成：调卷',request_key:key()}),
    call('lines_delete',{...base,request_key:key()}),
  ]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const loser=result.find(r=>r.status==='rejected') as PromiseRejectedResult;
  assert.ok(['VERSION_CONFLICT','LINE_NOT_FOUND'].includes(loser.reason.code));
  assert.equal((await call('todos_list',{case_ref:cid}) as any).data.items.length,0);
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_changes WHERE case_id=? AND action IN ('lines_update','lines_delete')").bind(cid).first<any>();
  assert.equal(count.n,1);
});

test('duplicate TODOs remain independent when completed through the webpage',async()=>{
  const cid=await create('待办权限案');await call('lines_add',{case_ref:cid,text:'- [ ] 调卷\n- [ ] 调卷',request_key:key()});
  const detail=await lines(cid),target=detail.lines[0];
  const args={case_ref:cid,line_id:target.line_id,expected_line_version:1,request_key:key()};
  const done:any=await completeTodo(env,web,args);await completeTodo(env,web,args);
  const todos:any=await call('todos_list',{case_ref:cid});assert.equal(todos.data.items.length,1);assert.equal(todos.data.items[0].line_id,detail.lines[1].line_id);
  const current=await lines(cid);assert.equal(current.lines.length,2);assert.ok(current.lines.at(-1).text.includes('已完成：调卷'));assert.equal(done.data.original_line_id,target.line_id);
});

test('independent TODO completion can run concurrently within one case',async()=>{
  const cid=await create('并行待办案');await call('lines_add',{case_ref:cid,text:'- [ ] 甲\n- [ ] 乙\n- [ ] 丙',request_key:key()});
  const doc=await lines(cid);
  const receipts:any[]=await Promise.all(doc.lines.map((l:any)=>completeTodo(env,web,{case_ref:cid,line_id:l.line_id,expected_line_version:l.version,request_key:key()})));
  assert.equal(new Set(receipts.map(r=>r.data.operation_id)).size,3);
  const after=await lines(cid);assert.equal(after.lines.length,3);assert.equal(after.document_revision,doc.document_revision+3);
  assert.ok(after.lines.every((l:any)=>l.text.startsWith('- [x]')));
});
test('metadata handles archive/restore, original lines unchanged, archived search is explicit',async()=>{
  const cid=await create('归档查询案');await call('lines_add',{case_ref:cid,text:'2026.10.10 法官电话123\n- 📅 2026.12.01 09:00 开庭',request_key:key()});
  await call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{status:'结案',aliases:['历史别名']},request_key:key()});
  assert.equal((await lines('历史别名')).case.status,'结案');
  const schedules:any=await call('schedules_list',{case_ref:cid});assert.equal(schedules.data.items.length,1);
  await assert.rejects(call('lines_add',{case_ref:cid,text:'不能写',request_key:key()}),(e:AppError)=>e.code==='CASE_READ_ONLY');
  const search:any=await call('search',{query:'法官电话123'});assert.ok(search.data.items.some((item:any)=>item.type==='line'&&item.line.case_id===cid));
  await call('cases_update',{case_ref:cid,expected_metadata_version:2,fields:{status:'在办'},request_key:key()});assert.equal((await lines(cid)).lines.length,2);
});

test('metadata receipt captures committed fields and recent activity, replays unchanged and never touches note rows',async()=>{
  const cid=await create('元数据回执合成案');await call('lines_add',{case_ref:cid,text:'原文\n\n重复\n重复',request_key:key()});
  const before=await lines(cid),args={case_ref:cid,expected_metadata_version:1,fields:{name:'修改名称',court:'合成法院',opened_date:'2026-11-02'},request_key:key()};
  const result:any=await call('cases_update',args),after=await lines(cid);
  assert.deepEqual(result.data.case,after.case);assert.equal(result.data.case.recent_activity,'2026-11-02');
  assert.deepEqual(after.lines,before.lines);assert.equal(after.document_revision,before.document_revision);
  await call('cases_update',{case_ref:cid,expected_metadata_version:2,fields:{court:null,status:'结案'},request_key:key()});
  const replay:any=await call('cases_update',args);assert.equal(replay.data.replayed,true);assert.deepEqual(replay.data.case,result.data.case);
  const stable=await lines(cid);await assert.rejects(call('cases_update',{...args,request_key:key()}),(e:AppError)=>e.code==='VERSION_CONFLICT');
  assert.deepEqual(await lines(cid),stable);
});
test('read-only pages reject later edits and other principals; workspace changes invalidate global lists',async()=>{
  const cid=await create('分页案');await call('lines_add',{case_ref:cid,text:'2026.10.10 第一行\n2026.10.10 第二行\n2026.10.10 第三行',request_key:key()});
  const first:any=await call('search',{case_ref:cid,limit:1});assert.equal(first.data.has_more,true);
  const detail=await lines(cid),second=detail.lines[1];await call('lines_update',{case_ref:cid,line_id:second.line_id,expected_line_version:1,text:'2026.10.10 修改后的第二行',request_key:key()});
  await assert.rejects(call('search',{case_ref:cid,limit:1,cursor:first.data.next_cursor}),(e:AppError)=>e.code==='READ_CHANGED');
  await assert.rejects(call('search',{case_ref:cid,limit:1,cursor:first.data.next_cursor},{...ai,clientId:'another'}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(call('search',{case_ref:cid,limit:1,cursor:first.data.next_cursor},{...ai,workspaceId:'another'}),(e:AppError)=>e.code==='CASE_NOT_FOUND');
  const globalArgs={result_type:'cases',limit:1},global:any=await call('search',globalArgs);
  await create('跨页新建案');
  await assert.rejects(call('search',{...globalArgs,cursor:global.data.next_cursor}),(e:AppError)=>e.code==='READ_CHANGED');
  for(const tool of ['todos_list','schedules_list']){
    const body=tool==='todos_list'?'- [ ] 第一条\n- [ ] 第二条':'- 📅 2030.01.01 第一条\n- 📅 2030.01.02 第二条';
    await call('lines_add',{case_ref:cid,text:body,request_key:key()});
    const args={case_ref:cid,limit:1},page:any=await call(tool,args);
    await call('lines_delete',{case_ref:cid,line_id:page.data.items[0].line_id,expected_line_version:1,request_key:key()});
    await assert.rejects(call(tool,{...args,cursor:page.data.next_cursor}),(e:AppError)=>e.code==='READ_CHANGED');
  }
});
test('insert shifts ordering safely, whole note save guards stale edits and retains IDs',async()=>{
  const cid=await create('笔记编辑案');await call('lines_add',{case_ref:cid,text:'首行\n尾行',request_key:key()});let detail=await lines(cid);
  await call('lines_add',{case_ref:cid,text:'插入一\n插入二',before_line_id:detail.lines[1].line_id,expected_document_revision:detail.document_revision,request_key:key()});
  detail=await lines(cid);assert.deepEqual(detail.lines.map((l:any)=>l.text),['首行','插入一','插入二','尾行']);
  const args={case_ref:cid,expected_document_revision:detail.document_revision,lines:detail.lines.map((l:any,n:number)=>({line_id:l.line_id,text:n===1?'改插入一':l.text})),request_key:key()};
  await saveNotes(env,web,args);const saved=await lines(cid);assert.equal(saved.lines[1].line_id,detail.lines[1].line_id);assert.equal(saved.lines[1].version,2);
  await assert.rejects(saveNotes(env,web,{...args,request_key:key()}),(e:AppError)=>e.code==='VERSION_CONFLICT');
  await assert.rejects(saveNotes(env,ai,{...args,request_key:key()}),(e:AppError)=>e.code==='PERMISSION_DENIED');
});
test('unknown tools, tenant access and unknown input fields fail closed',async()=>{
  const cid=await create('隔离案');await assert.rejects(call('__proto__',{}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(call('cases_get',{case_ref:cid},{...ai,workspaceId:'other'}),(e:AppError)=>e.code==='CASE_NOT_FOUND');
  await assert.rejects(call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{workspace_id:'other'},request_key:key()}),(e:AppError)=>e.code==='INVALID_ARGUMENT');
});
test('web login uses HttpOnly sessions, cross-origin writes rejected and logout revoked',async()=>{
  const denied=await mf.dispatchFetch('http://localhost/api/v1/search',{method:'POST',body:'{}'});assert.equal(denied.status,401,await denied.clone().text());
  const bad=await mf.dispatchFetch('http://localhost/api/login',{method:'POST',headers:{Origin:'http://evil.example','Content-Type':'application/json'},body:JSON.stringify({password:'test-password'})});assert.equal(bad.status,403);
  const logged=await mf.dispatchFetch('http://localhost/api/login',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({password:'test-password'})});assert.equal(logged.status,200);
  const set=logged.headers.get('set-cookie')!;assert.ok(set.includes('HttpOnly'));const cookie=set.split(';')[0];
  const readSession=async(c:string)=>(await (await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:c}})).json() as any).data;
  const session=await readSession(cookie);assert.equal(session.source,'web');assert.match(session.cache_scope,/^[a-f0-9]{64}$/);
  assert.ok(Date.parse(session.expires_at)>Date.now());assert.equal((await readSession(cookie)).cache_scope,session.cache_scope);
  assert.notEqual(session.cache_scope,cookie.split('=')[1]);
  assert.match(session.change_token,/^\d+:\d+:\d+:\d+$/);assert.equal((await readSession(cookie)).change_token,session.change_token);
  const another=await mf.dispatchFetch('http://localhost/api/login',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({password:'test-password'})});
  const anotherCookie=another.headers.get('set-cookie')!.split(';')[0];assert.notEqual((await readSession(anotherCookie)).cache_scope,session.cache_scope);
  assert.equal((await readSession(anotherCookie)).change_token,session.change_token);
  const legacy=await mf.dispatchFetch('http://localhost/api/session',{headers:{Authorization:'Bearer test-api-token'}});
  assert.equal(legacy.status,401); // the fixed AI token is gone; only OAuth authorises AI access
  assert.equal((await readSession(cookie)).change_token,session.change_token);
  await mf.dispatchFetch('http://localhost/api/logout',{method:'POST',headers:{Cookie:anotherCookie,Origin:'http://localhost'},body:'{}'});
  assert.equal((await mf.dispatchFetch('http://localhost/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:'http://localhost'},body:'{}'})).status,200);
  assert.equal((await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:cookie}})).status,401);
});
test('the session change token moves only on committed business writes',async()=>{
  const logged=await mf.dispatchFetch('http://localhost/api/login',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({password:'test-password'})});
  const cookie=logged.headers.get('set-cookie')!.split(';')[0];
  const token=async()=>((await (await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:cookie}})).json() as any).data.change_token as string);
  const before=await token();
  await call('search',{query:'令牌'});
  assert.equal(await token(),before);                                   // reads never move it
  const cid=await create('令牌合成案');
  const created=await token();assert.notEqual(created,before);          // creation moves the case count
  await call('lines_add',{case_ref:cid,text:'2026.10.11 令牌记录',request_key:key()});
  const added=await token();assert.notEqual(added,created);             // a note moves the document revision
  await call('cases_update',{case_ref:cid,expected_metadata_version:1,fields:{status:'结案'},request_key:key()});
  assert.notEqual(await token(),added);                                 // metadata moves its own version
});
test('real MCP discovery exposes nine tools including unified search, and tool failures are isError results',async()=>{
  const access=await oauthAccessToken();
  const mcp=async(method:string,params:any={})=>{
    const response=await mf.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method,params})});
    assert.equal(response.status,200,await response.clone().text());
    const result=await response.json() as any;
    if(method==='tools/call'){
      const checked=outputSchemas[params.name as ToolName].safeParse(result.result.structuredContent);
      assert.equal(checked.success,true,checked.success?params.name:JSON.stringify(checked.error.issues));
    }
    return result;
  };
  const initialized=await mcp('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'tests',version:'1'}});assert.equal(initialized.result.serverInfo.name,'case-notes');
  assert.equal(initialized.result.instructions,instructions);
  assert.doesNotMatch(initialized.result.instructions,/https?:\/\/|OpenAPI|docs\/usage\.md/);
  assert.doesNotMatch(initialized.result.instructions,/网页|看板|HTTP|SQL|周报|部署|同一事务/);
  for(const rule of ['原文与流程','记录语法','日期与标签','各行独立解析','request_key','commit_state'])assert.ok(initialized.result.instructions.includes(rule));
  const list=await mcp('tools/list');assert.equal(list.result.tools.length,9);assert.ok(!list.result.tools.some((t:any)=>/undo|archive|report/.test(t.name)));
  assert.ok(list.result.tools.some((t:any)=>t.name==='search'));assert.ok(!list.result.tools.some((t:any)=>['cases_search','lines_search'].includes(t.name)));
  const missing=await mcp('tools/call',{name:'cases_get',arguments:{case_ref:'不存在的测试案'}});assert.equal(missing.result.isError,true);assert.equal(missing.result.structuredContent.error.code,'CASE_NOT_FOUND');
  assert.ok(errorResponseSchema.safeParse(missing.result.structuredContent).success);
  const created=await mcp('tools/call',{name:'cases_create',arguments:{name:'MCP全文案',request_key:key()}}),cid=created.result.structuredContent.data.case_id;
  await mcp('tools/call',{name:'lines_add',arguments:{case_ref:cid,text:'原始全文\n\n---\n备注\n- [ ] 合成待办 #等待\n- 📅 2026.10.20 09:00 合成日程',request_key:key()}});
  const got=await mcp('tools/call',{name:'cases_get',arguments:{case_ref:cid}});assert.equal(got.result.structuredContent.data.lines.length,6);
  const searched=await mcp('tools/call',{name:'search',arguments:{query:'原始全文',cursor:''}});
  assert.equal(searched.result.isError,false);assert.ok(searched.result.structuredContent.data.items.some((item:any)=>item.type==='line'&&item.line.text==='原始全文'));
  assert.ok((await mcp('tools/call',{name:'todos_list',arguments:{case_ref:cid,cursor:''}})).result.structuredContent.data.items.length);
  assert.ok((await mcp('tools/call',{name:'schedules_list',arguments:{case_ref:cid,cursor:''}})).result.structuredContent.data.items.length);
  await mcp('tools/call',{name:'cases_update',arguments:{case_ref:cid,expected_metadata_version:1,fields:{aliases:['合成别名','合成别名']},request_key:key()}});
  const line=got.result.structuredContent.data.lines[0],edit={case_ref:cid,line_id:line.line_id,expected_line_version:line.version,text:'改写合成记录',request_key:key()};
  await mcp('tools/call',{name:'lines_update',arguments:edit});
  assert.equal((await mcp('tools/call',{name:'lines_update',arguments:edit})).result.structuredContent.data.replayed,true);
  const conflict=await mcp('tools/call',{name:'lines_update',arguments:{...edit,request_key:key()}});
  assert.equal(conflict.result.structuredContent.error.code,'VERSION_CONFLICT');
  await mcp('tools/call',{name:'lines_delete',arguments:{case_ref:cid,line_id:line.line_id,expected_line_version:2,request_key:key()}});
  const openapi=await (await mf.dispatchFetch('http://localhost/api/openapi.json')).json() as any;
  assert.equal(openapi.info.description,instructions);
  for(const tool of list.result.tools){
    assert.equal(tool.description,descriptions[tool.name as keyof typeof descriptions]);
    assert.equal(openapi.paths['/api/v1/'+tool.name].post.description,tool.description);
    assert.deepEqual(openapi.paths['/api/v1/'+tool.name].post.responses['200'].content['application/json'].schema,tool.outputSchema);
    assert.ok(tool.outputSchema.properties.data.anyOf.some((branch:any)=>branch.properties));
  }
  assert.equal((await mf.dispatchFetch('http://localhost/docs/usage.md')).status,404);
  assert.equal(Object.keys(openapi.paths).length,9);assert.ok(openapi.paths['/api/v1/search']);assert.equal(openapi.paths['/api/v1/cases_search'],undefined);
});
