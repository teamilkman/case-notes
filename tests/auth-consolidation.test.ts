import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { consolidateAuth, authTables, type Database } from '../tools/auth-consolidation';
import { migrationSql } from './migrations';
import { sha256 } from '../src/types';
import { executeTool } from '../src/service';

const adapter=(db:D1Database):Database=>({batch:async(statements)=>db.batch(statements.map(s=>db.prepare(s.sql).bind(...(s.params??[]))))});
async function fixture(run:(source:D1Database,target:D1Database,mf:Miniflare)=>Promise<void>){
  const dir=mkdtempSync(resolve(tmpdir(),'case-notes-auth-merge-'));
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:resolve('dist/worker.js'),compatibilityDate:'2026-10-01',
    compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},resourcePersistencePath:dir,
    d1Databases:{SOURCE:'legacy-auth',DB:'consolidated'},bindings:{WEB_PASSWORD:'synthetic-password'}}));
  try{
    const source=await mf.getD1Database('SOURCE') as unknown as D1Database,target=await mf.getD1Database('DB') as unknown as D1Database;
    for(const [db,folder] of [[source,'migrations/auth'],[target,'migrations/business']] as const)
      for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort())await db.batch(migrationSql(resolve(folder,file)).map(sql=>db.prepare(sql)));
    await run(source,target,mf);
  }finally{await mf.dispose();assert.ok(dir.startsWith(resolve(tmpdir(),'case-notes-auth-merge-')));rmSync(dir,{recursive:true});}
}
async function seed(source:D1Database){
  const now=Date.now(),expiry=now+86400_000;
  await source.batch([
    source.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').bind(await sha256('synthetic-cookie'),'personal',new Date(expiry).toISOString(),new Date(now).toISOString()),
    source.prepare("INSERT INTO login_attempts SELECT 'bucket-'||printf('%04d',key),key,? FROM json_each(?)").bind(now,JSON.stringify(Array(205).fill(0))),
    source.prepare('INSERT INTO oauth_clients VALUES(?,?,?,?,?,?,?,?)').bind('synthetic-client','http://localhost','合成客户端','["https://client.example/callback"]','none',null,now,expiry),
    source.prepare('INSERT INTO oauth_requests VALUES(?,?,?,?,?,?,?,?)').bind('synthetic-request','synthetic-browser','synthetic-client','https://client.example/callback','http://localhost/mcp',null,'synthetic-challenge',expiry),
    source.prepare(`INSERT INTO oauth_grants(id,client_id,workspace_id,resource,redirect_uri,challenge,code_expires_at,access_hash,access_expires_at,refresh_hash,expires_at)
      VALUES(?,?,?,?,?,?,0,?,?,?,?)`).bind('synthetic-grant','synthetic-client','personal','http://localhost/mcp','https://client.example/callback','synthetic-challenge',await sha256('A'.repeat(43)),expiry,await sha256('R'.repeat(43)),expiry),
    source.prepare('INSERT INTO oauth_used_refresh_tokens VALUES(?,?)').bind(await sha256('U'.repeat(43)),'synthetic-grant'),
  ]);
}

test('auth consolidation preserves exact records, business identities, revisions, audits and receipts; retries do not reintroduce stale auth',async()=>fixture(async(source,target,mf)=>{
  await seed(source);
  const env={DB:target,ASSETS:null as any},principal={workspaceId:'personal',clientId:'synthetic',actorId:'owner',source:'ai' as const};
  const created:any=await executeTool(env,principal,'cases_create',{name:'合并保留合成案',request_key:'synthetic-create'});
  await executeTool(env,principal,'lines_add',{case_ref:created.data.case_id,text:'重复原文\n\n重复原文',request_key:'synthetic-lines'});
  const businessTables=['cases','log_lines','line_index','operations','audit_changes'];
  const before=await target.batch(businessTables.map(t=>target.prepare(`SELECT * FROM ${t} ORDER BY rowid`)));
  const merged=await consolidateAuth(adapter(source),adapter(target),'synthetic-source');assert.equal(merged.counts.login_attempts,205);
  for(const [table,key] of authTables)assert.deepEqual((await target.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()).results,(await source.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()).results);
  const after=await target.batch(businessTables.map(t=>target.prepare(`SELECT * FROM ${t} ORDER BY rowid`)));
  assert.deepEqual(after.map(r=>r.results),before.map(r=>r.results));
  assert.equal((await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:'case_notes_session=synthetic-cookie'}})).status,200);
  const rpc=(token:string)=>mf.dispatchFetch('http://localhost/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal((await rpc('A'.repeat(43))).status,200);
  const refresh=()=>mf.dispatchFetch('http://localhost/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'synthetic-client',grant_type:'refresh_token',refresh_token:'R'.repeat(43),resource:'http://localhost/mcp'})});
  const rotated=await refresh();assert.equal(rotated.status,200);const tokens=await rotated.json() as any;
  assert.equal((await refresh()).status,400);assert.equal((await rpc(tokens.access_token)).status,401);
  await target.prepare('DELETE FROM web_sessions').run();
  assert.equal((await consolidateAuth(adapter(source),adapter(target),'synthetic-source')).alreadyCompleted,true);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM web_sessions').first<any>()).n,0);
  assert.equal((await target.prepare('SELECT revoked FROM oauth_grants').first<any>()).revoked,1);
  await target.batch(migrationSql('migrations/business/0005_auth_consolidation.sql').map(s=>target.prepare(s)));
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM auth_consolidation').first<any>()).n,1);
}));

test('historical web session upgrades the cookie without renewing identity, expiry or cache scope and logs out through the new name',async()=>fixture(async(source,target,mf)=>{
  await seed(source);await consolidateAuth(adapter(source),adapter(target),'synthetic-source');
  const old=await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:'ai_log_session=synthetic-cookie'}});
  assert.equal(old.status,200);const oldBody=await old.json() as any;
  const issued=old.headers.get('set-cookie')!;assert.match(issued,/case_notes_session=synthetic-cookie/);assert.match(issued,/ai_log_session=; Max-Age=0/);
  const current=await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:'case_notes_session=synthetic-cookie'}});
  assert.deepEqual((await current.json() as any).data,oldBody.data);assert.equal(current.headers.get('set-cookie'),null);
  assert.equal((await mf.dispatchFetch('http://localhost/api/logout',{method:'POST',headers:{Origin:'http://localhost',Cookie:'case_notes_session=synthetic-cookie'}})).status,200);
  assert.equal((await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:'ai_log_session=synthetic-cookie'}})).status,401);
}));

test('source fence rejects concurrent auth changes atomically and preserves all source values',async()=>fixture(async(source,target)=>{
  await seed(source);const before=(await source.prepare('SELECT * FROM web_sessions').all()).results;
  const observing:Database={batch:async(statements)=>{
    const result=await adapter(source).batch(statements);
    if(statements.some(s=>s.sql.startsWith('CREATE TRIGGER'))){
      await assert.rejects(source.batch([source.prepare("UPDATE oauth_grants SET revoked=1"),source.prepare('DELETE FROM web_sessions')]),/consolidated/);
      await assert.rejects(source.prepare("INSERT INTO login_attempts VALUES('concurrent',1,0)").run(),/consolidated/);
    }return result;
  }};
  await consolidateAuth(observing,adapter(target),'synthetic-source');
  assert.deepEqual((await source.prepare('SELECT * FROM web_sessions').all()).results,before);
  assert.equal((await source.prepare('SELECT revoked FROM oauth_grants').first<any>()).revoked,0);
}));

test('target conflict and a failed transactional copy leave no completion marker or partial imported records; retry succeeds',async()=>fixture(async(source,target)=>{
  await seed(source);
  await target.prepare("INSERT INTO web_sessions VALUES('existing','personal','9999-01-01','synthetic')").run();
  await assert.rejects(consolidateAuth(adapter(source),adapter(target),'synthetic-source'));
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first<any>()).n,0);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM auth_consolidation').first<any>()).n,0);
  await target.prepare('DELETE FROM web_sessions').run();
  const broken:Database={batch:async(statements)=>adapter(target).batch(statements.some(s=>s.sql.startsWith('INSERT INTO oauth_grants'))
    ? [...statements,{sql:"INSERT INTO oauth_grants(id) VALUES('invalid')"}]:statements)};
  await assert.rejects(consolidateAuth(adapter(source),broken,'synthetic-source'));
  for(const [table] of authTables)assert.equal((await target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<any>()).n,0);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM auth_consolidation').first<any>()).n,0);
  assert.equal((await consolidateAuth(adapter(source),adapter(target),'synthetic-source')).alreadyCompleted,false);
}));
