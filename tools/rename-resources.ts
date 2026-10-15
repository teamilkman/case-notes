import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {transferDatabase,retireTransfer,verifyCopiedFacts} from './data-transfer';
import type {Database,Statement} from './auth-consolidation';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
// Immutable identity of the source database, retained as migration history.
const sourceId='4fb9320d-5b95-47b8-8790-3025b872c40f',targetId=config.d1_databases[0].database_id;
const base=`https://api.cloudflare.com/client/v4/accounts/${config.account_id}`;
async function api(path:string,method='GET',body?:unknown){
  if(!process.env.CLOUDFLARE_API_TOKEN)throw new Error('Missing Cloudflare deployment credential');
  const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60_000)});
  const d=await r.json() as any;if(!r.ok||!d.success)throw new Error(`Cloudflare operation failed: HTTP ${r.status}, codes ${(d.errors??[]).map((e:any)=>e.code).join(',')}`);return d.result;
}
const database=(id:string):Database=>({batch:async(batch:Statement[])=>{
  const result=await api(`/d1/database/${id}/query`,'POST',{batch});
  if(!Array.isArray(result)||result.length!==batch.length||result.some(r=>r.success!==true))throw new Error('Incomplete D1 batch');return result;
}});
async function main(){
  if(sourceId===targetId)throw new Error('Database transfer requires different identities');
  const db=database(targetId);
  const [state]=await db.batch([{sql:'SELECT * FROM resource_transfers WHERE source_id=?',params:[sourceId]}]);
  const mark=state.results[0];
  if(process.argv.includes('--verify')){
    if(!mark)throw new Error('No verified transfer');
    if(!mark.retired_at)await verifyCopiedFacts(database(sourceId),db);
    console.log('Transferred business facts verified before domain cutover.');return;
  }
  if(process.argv.includes('--retire')){
    await retireTransfer(api,db,config,targetId,sourceId,mark);
    console.log('Verified source Worker and database retired.');return;
  }
  if(mark){console.log('Resource transfer already completed; no source access or reimport.');return;}
  const domains=await api('/workers/domains');
  const existing=domains.find((d:any)=>d.hostname===config.routes[0].pattern);
  if(!existing||existing.service===config.name)throw new Error('Cannot identify the source Worker before cutover');
  const settings=await api(`/workers/scripts/${existing.service}/settings`);
  if(!settings.bindings.some((b:any)=>b.type==='d1'&&b.id===sourceId))throw new Error('Source domain does not use the expected database');
  console.log(JSON.stringify(await transferDatabase(database(sourceId),db,sourceId,existing.service)));
}
if(process.argv.includes('--stage-config')){
  mkdirSync(resolve('.wrangler'),{recursive:true});
  const staged={...config,routes:[],main:resolve(config.main),assets:{...config.assets,directory:resolve(config.assets.directory)}};
  writeFileSync(resolve('.wrangler/staged-worker.json'),JSON.stringify(staged));
}else main().catch(error=>{
  if(/^Cloudflare operation failed: HTTP \d+, codes [\d,]*$/.test(error.message))console.error(error.message);
  console.error('Resource transfer failed; source data is preserved. Retry CI after diagnosis.');process.exitCode=1;
});
