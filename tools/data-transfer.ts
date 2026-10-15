import { createHash } from 'node:crypto';
import { authTables, type Database, type Statement } from './auth-consolidation';

export const transferTables=[
  'cases','case_aliases','operations','log_lines','line_index','write_guards',
  'audit_changes','read_snapshots','read_snapshot_rows',
  ...authTables.map(([name])=>name),'auth_consolidation',
];
const rows=async(db:Database,sql:string,params:unknown[]=[]) => (await db.batch([{sql,params}]))[0].results;

export async function verifyCopiedFacts(source:Database,target:Database){
  for(const table of transferTables.slice(0,9)){
    const sql=`SELECT * FROM ${table} ORDER BY rowid`;
    if(JSON.stringify(await rows(source,sql))!==JSON.stringify(await rows(target,sql)))throw new Error(`Transferred facts differ: ${table}`);
  }
}

export async function transferDatabase(source:Database,target:Database,sourceId:string,sourceWorker:string){
  if((await rows(target,'SELECT source_id FROM resource_transfers WHERE source_id=?',[sourceId])).length)return {alreadyCompleted:true};
  const tables=(await rows(source,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='d1_migrations' ORDER BY name")).map(r=>String(r.name));
  if(JSON.stringify(tables)!==JSON.stringify([...transferTables].sort()))throw new Error('Unexpected source schema; refusing to omit any source table');
  const columns:Record<string,string[]>={};
  for(const table of transferTables){
    const a=await rows(source,`PRAGMA table_info(${table})`),b=await rows(target,`PRAGMA table_info(${table})`);
    if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`Schema mismatch: ${table}`);
    columns[table]=a.map(r=>String(r.name));
  }
  // All source writes, including auth rotation and cascades, are stopped in
  // one transaction. Existing reads can continue while the new Worker starts.
  await source.batch(transferTables.flatMap(table=>['INSERT','UPDATE','DELETE'].map(action=>({sql:
    `CREATE TRIGGER IF NOT EXISTS case_notes_transfer_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
     BEGIN SELECT RAISE(ABORT,'Database transfer in progress'); END`,
  }))));
  const snapshots:Record<string,unknown[]>={};
  for(const table of transferTables){
    const records:Record<string,unknown>[]=[];let cursor:number|null=null;
    for(;;){const page=await rows(source,`SELECT rowid AS transfer_rowid,* FROM ${table} ${cursor===null?'':'WHERE rowid>?'} ORDER BY rowid LIMIT 200`,cursor===null?[]:[cursor]);
      for(const record of page){cursor=Number(record.transfer_rowid);delete record.transfer_rowid;records.push(record);}
      if(page.length<200)break;
    }snapshots[table]=records;
  }
  const counts=Object.fromEntries(transferTables.map(t=>[t,snapshots[t].length]));
  const hash=createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
  const guard='resource_transfer_guard';
  const statements:Statement[]=[{sql:`CREATE TABLE IF NOT EXISTS ${guard}(passed INTEGER CHECK(passed=1))`},
    {sql:`INSERT INTO ${guard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM resource_transfers)
      AND ${transferTables.map(t=>`NOT EXISTS(SELECT 1 FROM ${t})`).join(' AND ')} THEN 1 ELSE 0 END`}];
  for(const table of transferTables){const fields=columns[table];let chunk:unknown[]=[],size=2;
    const flush=()=>{if(!chunk.length)return;const json=JSON.stringify(chunk);
      statements.push({sql:`INSERT INTO ${table} (${fields.join(',')}) SELECT ${fields.map(c=>`json_extract(value,'$.${c}')`).join(',')} FROM json_each(?)`,params:[json]},
        {sql:`INSERT INTO ${guard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM ${table} t WHERE ${fields.map(c=>`t.${c} IS json_extract(j.value,'$.${c}')`).join(' AND ')})) THEN 1 ELSE 0 END`,params:[json]});
      chunk=[];size=2;};
    for(const record of snapshots[table]){const bytes=Buffer.byteLength(JSON.stringify(record))+1;
      if(bytes>1_900_000)throw new Error('Source row exceeds safe D1 transfer size');
      if(size+bytes>128_000)flush();chunk.push(record);size+=bytes;
    }flush();
    statements.push({sql:`INSERT INTO ${guard} SELECT CASE WHEN (SELECT COUNT(*) FROM ${table})=? THEN 1 ELSE 0 END`,params:[counts[table]]});
  }
  statements.push({sql:`INSERT INTO ${guard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END`},
    {sql:'INSERT INTO resource_transfers(source_id,source_worker,snapshot_hash,row_counts,completed_at) VALUES(?,?,?,?,?)',params:[sourceId,sourceWorker,hash,JSON.stringify(counts),new Date().toISOString()]},
    {sql:`DROP TABLE ${guard}`});
  if(Buffer.byteLength(JSON.stringify(statements))>8_000_000)throw new Error('Snapshot exceeds atomic transfer size');
  await target.batch(statements);
  return {alreadyCompleted:false,counts};
}

export async function retireTransfer(api:(path:string,method?:string,body?:unknown)=>Promise<any>,db:Database,
  config:{name:string;routes:{pattern:string}[]},targetId:string,sourceId:string,mark:Record<string,unknown>|undefined){
  if(!mark||!mark.source_worker||mark.source_worker===config.name)throw new Error('No verified source transfer');
  if(mark.retired_at)return;
  const settings=await api(`/workers/scripts/${config.name}/settings`),bindings=settings.bindings.filter((b:any)=>b.type==='d1');
  if(bindings.length!==1||bindings[0].id!==targetId)throw new Error('New Worker binding is not confirmed');
  const domains=await api('/workers/domains');
  if(config.routes.some(route=>!domains.some((d:any)=>d.hostname===route.pattern&&d.service===config.name&&d.enabled)))throw new Error('New domain ownership is not confirmed');
  const workers=await api('/workers/scripts');
  if(workers.some((w:any)=>w.id===mark.source_worker)){
    const old=await api(`/workers/scripts/${mark.source_worker}/settings`),oldBindings=old.bindings.filter((b:any)=>b.type==='d1');
    if(oldBindings.length!==1||oldBindings[0].id!==sourceId)throw new Error('Source Worker name has been reused; refusing to delete it');
    await api(`/workers/scripts/${mark.source_worker}`,'DELETE');
  }
  const databases=await api('/d1/database?per_page=100');
  if(databases.some((d:any)=>d.uuid===sourceId))await api(`/d1/database/${sourceId}`,'DELETE');
  const remaining=await api('/d1/database?per_page=100');
  if(remaining.some((d:any)=>d.uuid===sourceId))throw new Error('Source database still exists');
  await db.batch([{sql:'UPDATE resource_transfers SET retired_at=? WHERE source_id=?',params:[new Date().toISOString(),sourceId]}]);
}
