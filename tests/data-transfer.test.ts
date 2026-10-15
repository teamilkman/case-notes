import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationSql} from './migrations';
import {transferDatabase,transferTables,retireTransfer,verifyCopiedFacts} from '../tools/data-transfer';
import type {Database} from '../tools/auth-consolidation';
import {executeTool} from '../src/service';
const adapter=(db:D1Database):Database=>({batch:async(s)=>db.batch(s.map(q=>db.prepare(q.sql).bind(...(q.params??[]))))});
async function fixture(run:(source:D1Database,target:D1Database)=>Promise<void>){
  const dir=mkdtempSync(resolve(tmpdir(),'case-notes-transfer-'));
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'',telemetry:{enabled:false},resourcePersistencePath:dir,d1Databases:{SOURCE:'source',TARGET:'target'}}));
  try{const source=await mf.getD1Database('SOURCE') as unknown as D1Database,target=await mf.getD1Database('TARGET') as unknown as D1Database;
    for(const db of [source,target])for(const file of readdirSync('migrations/business').filter(f=>f.endsWith('.sql')).sort()){
      if(db===source&&file.startsWith('0006'))continue;
      await db.batch(migrationSql(resolve('migrations/business',file)).map(sql=>db.prepare(sql)));
    }await run(source,target);
  }finally{await mf.dispose();assert.ok(dir.startsWith(resolve(tmpdir(),'case-notes-transfer-')));rmSync(dir,{recursive:true});}
}
async function seed(db:D1Database){
  const p={workspaceId:'personal',actorId:'owner',clientId:'synthetic',source:'ai' as const},env={DB:db,ASSETS:null as any};
  const result:any=await executeTool(env,p,'cases_create',{name:'迁移合成案',request_key:'synthetic-create'});
  await executeTool(env,p,'lines_add',{case_ref:result.data.case_id,text:Array.from({length:205},(_,i)=>i%3===0?'':i%3===1?'重复原文':'- [ ] 合成待办 #等待').join('\n'),request_key:'synthetic-lines'});
  await db.prepare("INSERT INTO operations VALUES('large','personal','synthetic','large','synthetic','synthetic',?,'2026-01-01')").bind(JSON.stringify({payload:'大'.repeat(70_000)})).run();
  await db.prepare("INSERT INTO web_sessions VALUES('synthetic','personal','9999-01-01','2026-01-01')").run();
}
test('complete database transfer preserves facts, indices, versions, sessions, large receipts and audit, then ignores stale source on repeat',async()=>fixture(async(source,target)=>{
  await seed(source);const before=await source.batch(transferTables.map(t=>source.prepare(`SELECT * FROM ${t} ORDER BY rowid`)));
  const result=await transferDatabase(adapter(source),adapter(target),'synthetic-id','previous-worker');assert.equal(result.alreadyCompleted,false);
  const after=await target.batch(transferTables.map(t=>target.prepare(`SELECT * FROM ${t} ORDER BY rowid`)));assert.deepEqual(after.map(r=>r.results),before.map(r=>r.results));
  await verifyCopiedFacts(adapter(source),adapter(target));
  await target.prepare('UPDATE cases SET document_revision=document_revision+1').run();
  await assert.rejects(verifyCopiedFacts(adapter(source),adapter(target)),/facts differ/);
  await target.prepare('UPDATE cases SET document_revision=document_revision-1').run();
  await assert.rejects(source.prepare("UPDATE web_sessions SET expires_at='2026-01-01'").run(),/transfer in progress/);
  await assert.rejects(source.prepare('DELETE FROM log_lines').run(),/transfer in progress/);
  await target.prepare('DELETE FROM web_sessions').run();
  assert.equal((await transferDatabase({batch:async()=>assert.fail('stale source accessed')},adapter(target),'synthetic-id','previous-worker')).alreadyCompleted,true);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM web_sessions').first<any>()).n,0);
}));
test('transfer refuses occupied targets and rolls back all facts and completion on a late batch failure, allowing safe retry',async()=>fixture(async(source,target)=>{
  await seed(source);await target.prepare("INSERT INTO web_sessions VALUES('occupied','personal','9999-01-01','synthetic')").run();
  await assert.rejects(transferDatabase(adapter(source),adapter(target),'synthetic-id','previous-worker'));
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM cases').first<any>()).n,0);
  await target.prepare('DELETE FROM web_sessions').run();
  const faulty:Database={batch:async(q)=>adapter(target).batch(q.some(s=>s.sql.startsWith('INSERT INTO resource_transfers'))?[...q,{sql:"INSERT INTO cases(id) VALUES('invalid')"}]:q)};
  await assert.rejects(transferDatabase(adapter(source),faulty,'synthetic-id','previous-worker'));
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM resource_transfers').first<any>()).n,0);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM log_lines').first<any>()).n,0);
  assert.equal((await transferDatabase(adapter(source),adapter(target),'synthetic-id','previous-worker')).alreadyCompleted,false);
}));
test('unexpected source tables are rejected before the source is fenced',async()=>fixture(async(source,target)=>{
  await seed(source);await source.prepare('CREATE TABLE unexpected(id TEXT)').run();
  await assert.rejects(transferDatabase(adapter(source),adapter(target),'synthetic-id','previous-worker'),/Unexpected source schema/);
  await source.prepare('DELETE FROM web_sessions').run();
}));
test('resource retirement refuses a reused source Worker name even after the new domain and binding are valid',async()=>{
  const deleted:string[]=[];
  const api=async(path:string,method?:string)=>{
    if(method==='DELETE'){deleted.push(path);return {};}
    if(path==='/workers/domains')return [{hostname:'synthetic.example',service:'new',enabled:true}];
    if(path==='/workers/scripts')return [{id:'previous'}];
    return {bindings:[{type:'d1',id:path.includes('/new/')?'target':'unrelated'}]};
  };
  await assert.rejects(retireTransfer(api,{batch:async()=>assert.fail('completion stored')},{name:'new',routes:[{pattern:'synthetic.example'}]},'target','source',{source_worker:'previous'}),/reused/);
  assert.deepEqual(deleted,[]);
});
test('completed resource retirement never revisits a source name that another project may now own',async()=>{
  await retireTransfer(async()=>assert.fail('retired resource accessed'),{batch:async()=>assert.fail('retired receipt updated')},
    {name:'new',routes:[]},'target','source',{source_worker:'previous',retired_at:'2026-01-01'});
});
