import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
test('domain-free deployment config is generated in a clean CI checkout before the Worker exists',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'case-notes-stage-'));
  try{
    writeFileSync(resolve(root,'wrangler.jsonc'),JSON.stringify({name:'case-notes',main:'src/worker.ts',routes:[{pattern:'synthetic.example'}],assets:{directory:'public'},d1_databases:[{database_id:'synthetic-id'}]}));
    const result=spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('tools/rename-resources.ts'),'--stage-config'],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const staged=JSON.parse(readFileSync(resolve(root,'.wrangler/staged-worker.json'),'utf8'));
    assert.deepEqual(staged.routes,[]);assert.equal(staged.main,resolve(root,'src/worker.ts'));assert.equal(staged.assets.directory,resolve(root,'public'));assert.equal(staged.d1_databases[0].database_id,'synthetic-id');
  }finally{assert.ok(root.startsWith(resolve(tmpdir(),'case-notes-stage-')));rmSync(root,{recursive:true});}
});
test('the deployment address and identifiers are rendered from the environment, never committed',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'case-notes-render-'));
  try{
    const template=readFileSync('wrangler.template.jsonc','utf8');
    assert.ok(!/https?:\/\/|\.(com|fr|net|org)\b/.test(template),'the committed template must carry no deployment address');
    writeFileSync(resolve(root,'wrangler.template.jsonc'),template);
    const env={...process.env,DOMAIN:'synthetic.example',ZONE_ID:'synthetic-zone',D1_DATABASE_ID:'synthetic-db',REQUIRE_DEPLOYMENT_CONFIG:'1'};
    const rendered=spawnSync(process.execPath,[resolve('tools/render-wrangler.mjs')],{cwd:root,env,encoding:'utf8'});
    assert.equal(rendered.status,0,rendered.stderr);
    const config=JSON.parse(readFileSync(resolve(root,'wrangler.jsonc'),'utf8'));
    assert.equal(config.routes[0].pattern,'synthetic.example');assert.equal(config.routes[0].zone_id,'synthetic-zone');
    assert.equal(config.d1_databases[0].database_id,'synthetic-db');assert.equal(config.account_id,undefined);
    const incomplete=spawnSync(process.execPath,[resolve('tools/render-wrangler.mjs')],{cwd:root,env:{...env,DOMAIN:''},encoding:'utf8'});
    assert.notEqual(incomplete.status,0);assert.match(incomplete.stderr,/Missing deployment configuration/);
  }finally{assert.ok(root.startsWith(resolve(tmpdir(),'case-notes-render-')));rmSync(root,{recursive:true});}
});
test('domain handover uses the Wrangler origin endpoint only for the verified source',async()=>{
  const source=readFileSync('tools/bind-domain.mjs','utf8').replace("import {readFileSync} from 'node:fs';",'');
  const config={name:'case-notes',d1_databases:[{database_id:'synthetic-target'}]},mutations:any[]=[];
  const hostname='synthetic.example',zone='synthetic-zone',account='synthetic-account';
  let moved=false,verified=true;
  const fetch=async(url:string,options:any={})=>{
    const method=options.method??'GET',path=new URL(url).pathname;
    let result:any;
    if(method==='GET')result=[{hostname,service:moved?'case-notes':'synthetic-source',enabled:true,zone_id:zone}];
    else if(path.endsWith('/query'))result=[{results:verified?[{source_worker:'synthetic-source'}]:[]}];
    else{mutations.push({path,method,body:JSON.parse(options.body)});moved=true;result={};}
    return {ok:true,json:async()=>({success:true,result})};
  };
  const env={CLOUDFLARE_API_TOKEN:'synthetic',CLOUDFLARE_ACCOUNT_ID:account,ZONE_ID:zone,DOMAIN:hostname};
  const run=(overrides:any={})=>runInNewContext(`(async()=>{${source}\n})()`,{fetch,readFileSync:()=>JSON.stringify(config),process:{env:{...env,...overrides}},console:{log(){}}});
  await run();assert.equal(mutations.length,1);
  assert.equal(mutations[0].path,`/client/v4/accounts/${account}/workers/scripts/case-notes/domains/records`);
  assert.equal(mutations[0].body.override_existing_origin,true);assert.equal(mutations[0].body.override_existing_dns_record,false);assert.equal(mutations[0].body.origins[0].hostname,hostname);
  moved=false;verified=false;await assert.rejects(run(),/unverified source Worker/);assert.equal(mutations.length,1);
  await assert.rejects(run({ZONE_ID:''}),/Missing Cloudflare deployment configuration/);
});
