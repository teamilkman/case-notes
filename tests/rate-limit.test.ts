import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {resolve} from 'node:path';
import worker from '../src/worker';
import {limitPrincipal} from '../src/rate-limit';
import {allowedRateLimits} from './runtime-rate-limits';
import {AppError,type Env,type Principal} from '../src/types';

const context={waitUntil:()=>{}} as unknown as ExecutionContext;
function fixture(overrides:Partial<Env>={}) {
  let databaseCalls=0;
  const env={...allowedRateLimits,DB:{prepare:()=>{databaseCalls++;throw new Error('Unexpected D1 access');}},ASSETS:{fetch:async()=>new Response('asset')},...overrides} as Env;
  return {env,read:()=>databaseCalls,fetch:(path:string,init?:RequestInit)=>worker.fetch(new Request('https://synthetic.example'+path,init),env,context)};
}

test('IP throttling rejects reads and writes before authentication, body parsing, or any D1 access',async()=>{
  const keys:string[]=[],f=fixture({API_RATE_LIMITER:{limit:async({key})=>{keys.push(key);return {success:false};}}});
  for(const path of ['/api/session','/api/web/save-notes','/api/v1/lines_add','/mcp']){
    const r=await f.fetch(path,{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.1'},body:'invalid json'});
    assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');
    const value=await r.json() as any;assert.equal(value.error.code,'RATE_LIMITED');assert.equal(value.error.details.retry_after,60);
    assert.equal(value.error.commit_state,'not_committed');assert.equal(value.error.retryable,true);assert.match(value.error.next_action,/停止即时重试/);
  }
  assert.equal(f.read(),0);assert.equal(new Set(keys).size,1);
});

test('OAuth throttling preserves OAuth errors and CORS; public assets and unsupported MCP methods use no counters or database',async()=>{
  let calls=0;
  const f=fixture({API_RATE_LIMITER:{limit:async()=>{calls++;return {success:true};}},AUTH_RATE_LIMITER:{limit:async()=>({success:false})}});
  for(const path of ['/oauth/token','/oauth/register','/oauth/authorize','/api/login']){
    const r=await f.fetch(path,{method:'POST',body:'invalid'});assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');
    const value=await r.json() as any;
    if(path.startsWith('/oauth/')){assert.equal(value.error,'temporarily_unavailable');assert.equal(r.headers.get('Access-Control-Allow-Origin'),'*');}
    else assert.equal(value.error.code,'RATE_LIMITED');
  }
  assert.equal(f.read(),0);const before=calls;
  for(const method of ['GET','DELETE','OPTIONS','PUT']){
    const r=await f.fetch('/mcp',{method});assert.equal(r.status,405);assert.equal(r.headers.get('Allow'),'POST');
  }
  assert.equal((await f.fetch('/theme.css')).status,200);assert.equal(calls,before);assert.equal(f.read(),0);
});

test('AI limits share a stable client bucket across transports and token rotations without consuming web allowance',async()=>{
  const keys:string[]=[],f=fixture({AI_RATE_LIMITER:{limit:async({key})=>{keys.push(key);return {success:keys.filter(k=>k===key).length<=2};}}});
  const p:Principal={workspaceId:'synthetic',clientId:'client-a',actorId:'owner',source:'ai'};
  await limitPrincipal(f.env,p);await limitPrincipal(f.env,{...p});
  await assert.rejects(limitPrincipal(f.env,p),(error:unknown)=>error instanceof AppError&&error.code==='RATE_LIMITED'&&error.commitState==='not_committed');
  await limitPrincipal(f.env,{...p,source:'web'});assert.equal(keys.length,3);
  await limitPrincipal(f.env,{...p,clientId:'client-b'});assert.notEqual(keys[0],keys[3]);
});

test('real isolated Miniflare rate-limit counters share dynamic paths, separate source IPs, and leave assets usable',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:resolve('dist/worker.js'),compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},
    ratelimits:{API_RATE_LIMITER:{namespace_id:'1',simple:{limit:2,period:60}},AI_RATE_LIMITER:{namespace_id:'2',simple:{limit:2,period:60}},AUTH_RATE_LIMITER:{namespace_id:'3',simple:{limit:2,period:60}}},
    assets:{directory:resolve('public'),binding:'ASSETS',run_worker_first:['/api/*','/health','/mcp'],routerConfig:{has_user_worker:true}}}));
  const read=(path:string,ip='192.0.2.1')=>mf.dispatchFetch('https://synthetic.example'+path,{headers:{'CF-Connecting-IP':ip}});
  try{
    assert.equal((await read('/health')).status,200);
    assert.equal((await read('/api/openapi.json')).status,200);
    assert.equal((await read('/api/session')).status,429); // no D1 binding: authentication must not run
    assert.equal((await read('/health','192.0.2.2')).status,200);
    assert.equal((await read('/theme.css')).status,200);
    assert.equal((await read('/mcp')).status,405);
  }finally{await mf.dispose();}
});
