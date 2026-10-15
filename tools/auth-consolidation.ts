import { createHash } from 'node:crypto';

export const authTables = [
  ['web_sessions','token_hash'], ['login_attempts','bucket'], ['oauth_clients','client_id'],
  ['oauth_requests','request_hash'], ['oauth_grants','id'], ['oauth_used_refresh_tokens','token_hash'],
] as const;
export type Statement = {sql:string;params?:unknown[]};
export type Database = {batch(statements:Statement[]):Promise<{results:Record<string,unknown>[]}[]>};
const query = async(db:Database,sql:string,params:unknown[]=[]) => (await db.batch([{sql,params}]))[0].results;
const fenceName = (table:string,action:string) => `auth_consolidation_${table}_${action.toLowerCase()}`;

export async function consolidateAuth(source:Database,target:Database,sourceId:string) {
  const previous=await query(target,'SELECT * FROM auth_consolidation WHERE source_id=?',[sourceId]);
  if(previous.length)return {alreadyCompleted:true,counts:JSON.parse(String(previous[0].row_counts)) as Record<string,number>};
  // Freeze every write atomically before reading. Requests already in a batch
  // finish before this batch; later rotations, revocations and cascades fail.
  await source.batch(authTables.flatMap(([table])=>['INSERT','UPDATE','DELETE'].map(action=>({
    sql:`CREATE TRIGGER IF NOT EXISTS ${fenceName(table,action)} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT,'Authentication database is being consolidated'); END`,
  }))));
  const snapshots: {table:string;columns:string[];rows:Record<string,unknown>[]}[]=[];
  for(const [table,key] of authTables){
    const columns=(await query(source,`PRAGMA table_info(${table})`)).map(row=>String(row.name));
    const rows:Record<string,unknown>[]=[];let cursor:unknown=null;
    for(;;){
      const page=await query(source,`SELECT * FROM ${table} ${cursor===null?'':`WHERE ${key}>?`} ORDER BY ${key} LIMIT 200`,cursor===null?[]:[cursor]);
      rows.push(...page);if(page.length<200)break;cursor=page.at(-1)![key];
    }
    const targetColumns=(await query(target,`PRAGMA table_info(${table})`)).map(row=>String(row.name));
    if(JSON.stringify(columns)!==JSON.stringify(targetColumns))throw new Error(`Authentication schema mismatch: ${table}`);
    snapshots.push({table,columns,rows});
  }
  const counts=Object.fromEntries(snapshots.map(s=>[s.table,s.rows.length]));
  const hash=createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
  const guard='auth_consolidation_guard';
  const statements:Statement[]=[{sql:`CREATE TABLE IF NOT EXISTS ${guard} (passed INTEGER CHECK(passed=1))`},
    {sql:`INSERT INTO ${guard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM auth_consolidation)
      AND ${authTables.map(([table])=>`NOT EXISTS(SELECT 1 FROM ${table})`).join(' AND ')} THEN 1 ELSE 0 END`}];
  for(const {table,columns,rows} of snapshots){
    // Bound JSON stays below D1's string and SQL size limits. Import and exact
    // value checks belong to one transaction with the durable completion mark.
    let chunk:Record<string,unknown>[]=[];let size=2;
    const flush=()=>{
      if(!chunk.length)return;
      const json=JSON.stringify(chunk);
      statements.push({sql:`INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.map(c=>`json_extract(value,'$.${c}')`).join(',')} FROM json_each(?)`,params:[json]});
      statements.push({sql:`INSERT INTO ${guard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) j
        WHERE NOT EXISTS(SELECT 1 FROM ${table} t WHERE ${columns.map(c=>`t.${c} IS json_extract(j.value,'$.${c}')`).join(' AND ')})) THEN 1 ELSE 0 END`,params:[json]});
      chunk=[];size=2;
    };
    for(const row of rows){const bytes=Buffer.byteLength(JSON.stringify(row))+1;
      if(bytes>64_000)throw new Error(`Authentication row exceeds consolidation limit: ${table}`);
      if(size+bytes>64_000)flush();chunk.push(row);size+=bytes;
    }flush();
    statements.push({sql:`INSERT INTO ${guard} SELECT CASE WHEN (SELECT COUNT(*) FROM ${table})=? THEN 1 ELSE 0 END`,params:[rows.length]});
  }
  statements.push({sql:`INSERT INTO ${guard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END`},
    {sql:'INSERT INTO auth_consolidation VALUES(?,?,?,?)',params:[sourceId,hash,JSON.stringify(counts),new Date().toISOString()]},
    {sql:`DROP TABLE ${guard}`});
  if(Buffer.byteLength(JSON.stringify(statements))>8_000_000)throw new Error('Authentication snapshot exceeds atomic consolidation limit');
  await target.batch(statements);
  return {alreadyCompleted:false,counts};
}
