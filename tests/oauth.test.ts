import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrationSql } from './migrations';
import { sha256 } from '../src/types';

let mf:Miniflare,auth:D1Database;
const temp=mkdtempSync(resolve(tmpdir(),'case-notes-oauth-test-')),origin='http://localhost',target=origin+'/mcp';
const verifier='a'.repeat(43),challenge=Buffer.from(await sha256(verifier),'hex').toString('base64url');
const redirect='https://client.example/callback?existing=1';
let registrationIp=1;
const fetch=(path:string,options:any={})=>mf.dispatchFetch(origin+path,{redirect:'manual',...options});
const post=(path:string,body:Record<string,string>,headers:Record<string,string>={})=>fetch(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(body).toString()});
const register=async(extra:any={})=>{
  const r=await fetch('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':`192.0.2.${registrationIp++}`},body:JSON.stringify({client_name:'合成 MCP 客户端',redirect_uris:[redirect],...extra})});
  assert.equal(r.status,201,await r.clone().text());return await r.json() as any;
};
async function begin(client:any,extra:Record<string,string>={},webCookie=''){
  const params={client_id:client.client_id,redirect_uri:redirect,response_type:'code',resource:target,scope:'mcp',state:'test-state',code_challenge:challenge,code_challenge_method:'S256',...extra};
  const r=await fetch('/oauth/authorize?'+new URLSearchParams(params),{headers:webCookie?{Cookie:webCookie}:{}});
  const html=await r.text(),nonce=html.match(/name="request" value="([^"]+)"/)?.[1]??'',cookie=r.headers.get('set-cookie')?.split(';')[0]??'';
  return {r,html,nonce,cookie,params};
}
async function approve(client:any,webCookie=''){
  const flow=await begin(client,{},webCookie);assert.equal(flow.r.status,200,flow.html);
  const r=await post('/oauth/authorize',{request:flow.nonce,decision:'allow',password:'synthetic-password'},{Origin:origin,Cookie:[flow.cookie,webCookie].filter(Boolean).join('; ')});
  assert.equal(r.status,303,await r.clone().text());const url=new URL(r.headers.get('Location')!);
  assert.equal(url.searchParams.get('state'),'test-state');assert.equal(url.searchParams.get('existing'),'1');return {code:url.searchParams.get('code')!,flow};
}
const exchange=(client:any,code:string,extra:Record<string,string>={})=>post('/oauth/token',{client_id:client.client_id,grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirect,resource:target,...extra});
const refresh=(client:any,token:string,extra:Record<string,string>={})=>post('/oauth/token',{client_id:client.client_id,grant_type:'refresh_token',refresh_token:token,resource:target,...extra});
const rpc=(token:string,method='tools/list',params:any={})=>fetch('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
async function grant(){const client=await register(),{code}=await approve(client),r=await exchange(client,code);assert.equal(r.status,200,await r.clone().text());return {client,tokens:await r.json() as any};}
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({name:'oauth-tests',modules:true,scriptPath:resolve('dist/worker.js'),compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},resourcePersistencePath:temp,
    d1Databases:{DB:'business'},bindings:{WEB_PASSWORD:'synthetic-password'},
    assets:{directory:resolve('public'),binding:'ASSETS',run_worker_first:['/api/*','/mcp','/health','/oauth/*','/.well-known/*'],routerConfig:{has_user_worker:true}}}));
  auth=await mf.getD1Database('DB') as unknown as D1Database;
  for(const [db,folder] of [[auth,'migrations/business']] as const)
    for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort())await db.batch(migrationSql(resolve(folder,file)).map(sql=>db.prepare(sql)));
});
after(async()=>{await mf?.dispose();assert.equal(dirname(realpathSync(temp)),realpathSync(tmpdir()));assert.ok(basename(temp).startsWith('case-notes-oauth-test-'));rmSync(temp,{recursive:true});});

test('OAuth discovery and assets reach the Worker and advertise PKCE and public registration',async()=>{
  const denied=await fetch('/mcp',{method:'POST',body:'{}'});assert.equal(denied.status,401);
  assert.match(denied.headers.get('WWW-Authenticate')!,/resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/);
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']){
    const r=await fetch(path),data=await r.json() as any;assert.equal(r.status,200);assert.equal(data.resource,target);assert.deepEqual(data.authorization_servers,[origin]);
  }
  const data=await (await fetch('/.well-known/oauth-authorization-server')).json() as any;
  assert.deepEqual(data.code_challenge_methods_supported,['S256']);assert.equal(data.registration_endpoint,origin+'/oauth/register');
  assert.deepEqual(data.grant_types_supported,['authorization_code','refresh_token']);
  const preflight=await fetch('/oauth/token',{method:'OPTIONS',headers:{Origin:'https://client.example'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'*');
  assert.equal((await fetch('/oauth.js')).status,200);assert.equal((await fetch('/oauth.css')).status,200);
  const sw=readFileSync('public/sw.js','utf8');assert.ok(sw.includes("url.pathname.startsWith('/oauth/')")&&sw.includes("url.pathname.startsWith('/.well-known/')"));
  assert.equal((await mf.dispatchFetch('http://insecure.example/.well-known/oauth-authorization-server')).status,400);
});
test('registration rejects unsafe callbacks and metadata; consent escapes untrusted client names',async()=>{
  for(const data of [{redirect_uris:['http://evil.example/callback']},{redirect_uris:['https://a.test/callback#fragment']},{redirect_uris:['https://u:p@a.test/callback']},{grant_types:['client_credentials']},{token_endpoint_auth_method:'unsupported'}]){
    assert.equal((await fetch('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[redirect],...data})})).status,400);
  }
  const client=await register({client_name:'<script>evil()</script>',redirect_uris:[redirect,'http://127.0.0.1:1234/callback']});
  const flow=await begin(client);assert.equal(flow.r.status,200);assert.ok(flow.html.includes('&lt;script&gt;evil()&lt;/script&gt;'));assert.ok(!flow.html.includes('<script>evil()'));
  assert.match(flow.r.headers.get('Content-Security-Policy')!,/frame-ancestors 'none'/);assert.equal(flow.r.headers.get('Referrer-Policy'),'same-origin');
  assert.match(flow.r.headers.get('Content-Security-Policy')!,/form-action 'self' https:\/\/client.example/);
  const invalidRequests:Record<string,string>[]=[{redirect_uri:redirect+'extra'},{code_challenge_method:'plain'},{resource:'https://other.example/mcp'},{scope:'admin'},{resource:''}];
  for(const extra of invalidRequests){
    const invalid=await begin(client,extra);assert.equal(invalid.r.status,400);assert.equal(invalid.r.headers.get('Location'),null);
  }
});
test('consent needs browser binding, same origin and password or a valid web session; cancellation returns state',async()=>{
  const client=await register(),flow=await begin(client);
  assert.equal((await post('/oauth/authorize',{request:flow.nonce,decision:'allow',password:'synthetic-password'},{Origin:origin})).status,400);
  assert.equal((await post('/oauth/authorize',{request:flow.nonce,decision:'allow',password:'synthetic-password'},{Origin:'https://evil.example',Cookie:flow.cookie})).status,403);
  const wrong=await post('/oauth/authorize',{request:flow.nonce,decision:'allow',password:'wrong'},{Origin:origin,Cookie:flow.cookie});assert.equal(wrong.status,401);assert.match(await wrong.text(),/密码不正确/);
  const denied=await post('/oauth/authorize',{request:flow.nonce,decision:'deny'},{Origin:origin,Cookie:flow.cookie});assert.equal(denied.status,303);
  const url=new URL(denied.headers.get('Location')!);assert.equal(url.searchParams.get('error'),'access_denied');assert.equal(url.searchParams.get('state'),'test-state');assert.equal(url.searchParams.get('code'),null);
  assert.equal((await post('/oauth/authorize',{request:flow.nonce,decision:'deny'},{Origin:origin,Cookie:flow.cookie})).status,400);
  const login=await fetch('/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-password'})}),webCookie=login.headers.get('set-cookie')!.split(';')[0];
  const loggedIn=await begin(client,{},webCookie);assert.ok(!loggedIn.html.includes('name="password"'));await approve(client,webCookie);
  await fetch('/api/logout',{method:'POST',headers:{Origin:origin,Cookie:webCookie}});
  assert.ok((await begin(client,{},webCookie)).html.includes('name="password"'));
});
test('PKCE, client, callback and resource are bound; atomic redemption permits one winner and only hashed secrets persist',async()=>{
  const client=await register(),{code}=await approve(client),other=await register();
  for(const [c,extra] of [[client,{code_verifier:'b'.repeat(43)}],[other,{}],[client,{redirect_uri:redirect+'extra'}],[client,{resource:'https://other.example/mcp'}]] as const)assert.equal((await exchange(c,code,extra)).status,400);
  const responses=await Promise.all([exchange(client,code),exchange(client,code)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  const tokens=await responses.find(r=>r.status===200)!.json() as any;assert.equal(tokens.token_type,'Bearer');assert.equal(tokens.expires_in,3600);
  const rows=await auth.prepare('SELECT * FROM oauth_grants WHERE client_id=?').bind(client.client_id).all();const stored=JSON.stringify(rows.results);
  assert.ok(!stored.includes(tokens.access_token)&&!stored.includes(tokens.refresh_token)&&!stored.includes(code));assert.equal(rows.results[0].code_hash,null);
  const initialized=await rpc(tokens.access_token,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'oauth-test',version:'1'}});assert.equal(initialized.status,200);
  const listed=await rpc(tokens.access_token);assert.equal(listed.status,200);assert.equal((await listed.json() as any).result.tools.length,9);
  const searched=await rpc(tokens.access_token,'tools/call',{name:'search',arguments:{result_type:'cases'}});assert.equal((await searched.json() as any).result.structuredContent.ok,true);
  const rest=await fetch('/api/v1/search',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json'},body:JSON.stringify({query:'OAuth'})});
  assert.equal(rest.status,200);assert.equal((await rest.json() as any).ok,true); // one OAuth grant covers REST and MCP
  assert.equal((await fetch('/api/web/history',{headers:{Authorization:'Bearer '+tokens.access_token}})).status,403); // valid token, web-only route
  const otherHost=await mf.dispatchFetch('https://other.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token},body:'{}'});assert.equal(otherHost.status,401);
  assert.equal((await rpc('synthetic-api-token')).status,401); // the fixed AI token no longer exists
});
test('OAuth writes retain client identity and AI permissions in the common service',async()=>{
  const {client,tokens}=await grant();
  const r=await rpc(tokens.access_token,'tools/call',{name:'cases_create',arguments:{name:'OAuth 合成案',request_key:crypto.randomUUID()}}),data=await r.json() as any;
  assert.equal(data.result.structuredContent.ok,true);const business=await mf.getD1Database('DB');
  const row=await business.prepare('SELECT client_id,source FROM audit_changes WHERE case_id=?').bind(data.result.structuredContent.data.case_id).first();
  assert.equal(row!.client_id,client.client_id);assert.equal(row!.source,'ai');
});
test('refresh rotation rejects wrong clients without revocation and revokes the family on reuse, including concurrent refresh',async()=>{
  const {client,tokens}=await grant(),other=await register();assert.equal((await refresh(other,tokens.refresh_token)).status,400);assert.equal((await rpc(tokens.access_token)).status,200);
  const rotated=await refresh(client,tokens.refresh_token);assert.equal(rotated.status,200);const fresh=await rotated.json() as any;
  assert.notEqual(fresh.refresh_token,tokens.refresh_token);assert.equal((await rpc(tokens.access_token)).status,401);assert.equal((await rpc(fresh.access_token)).status,200);
  assert.equal((await refresh(client,tokens.refresh_token)).status,400);assert.equal((await rpc(fresh.access_token)).status,401);assert.equal((await refresh(client,fresh.refresh_token)).status,400);
  const concurrent=await grant(),results=await Promise.all([refresh(concurrent.client,concurrent.tokens.refresh_token),refresh(concurrent.client,concurrent.tokens.refresh_token)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);const winner=await results.find(r=>r.status===200)!.json() as any;assert.equal((await rpc(winner.access_token)).status,401);
});
test('expiry, revocation and idempotent migration preserve existing sessions and business data',async()=>{
  const {client,tokens}=await grant();
  await auth.prepare('UPDATE oauth_grants SET access_expires_at=0 WHERE access_hash=?').bind(await sha256(tokens.access_token)).run();assert.equal((await rpc(tokens.access_token)).status,401);
  const renewed=await refresh(client,tokens.refresh_token);assert.equal(renewed.status,200);const fresh=await renewed.json() as any;
  assert.equal((await post('/oauth/revoke',{client_id:client.client_id,token:fresh.access_token})).status,200);assert.equal((await rpc(fresh.access_token)).status,401);assert.equal((await refresh(client,fresh.refresh_token)).status,400);
  assert.equal((await post('/oauth/revoke',{client_id:client.client_id,token:'unknown'})).status,200);
  const expiredCode=await approve(client);await auth.prepare('UPDATE oauth_grants SET code_expires_at=0 WHERE code_hash=?').bind(await sha256(expiredCode.code)).run();assert.equal((await exchange(client,expiredCode.code)).status,400);
  const expired=await grant();await auth.prepare('UPDATE oauth_grants SET expires_at=0 WHERE refresh_hash=?').bind(await sha256(expired.tokens.refresh_token)).run();assert.equal((await refresh(expired.client,expired.tokens.refresh_token)).status,400);
  const before=(await auth.prepare('SELECT * FROM web_sessions').all()).results;
  await auth.batch(migrationSql('migrations/business/0005_auth_consolidation.sql').map(sql=>auth.prepare(sql)));
  assert.deepEqual((await auth.prepare('SELECT * FROM web_sessions').all()).results,before);
  const searched=await rpc((await grant()).tokens.access_token,'tools/call',{name:'search',arguments:{query:'OAuth 合成案'}});assert.equal((await searched.json() as any).result.structuredContent.data.items.length,1);
});
test('confidential clients authenticate with their registered method, never with an exposed stored secret',async()=>{
  for(const method of ['client_secret_post','client_secret_basic']){
    const client=await register({token_endpoint_auth_method:method}),{code}=await approve(client);
    const row=await auth.prepare('SELECT secret_hash FROM oauth_clients WHERE client_id=?').bind(client.client_id).first<any>();assert.equal(row.secret_hash,await sha256(client.client_secret));
    assert.equal((await exchange(client,code)).status,401);
    const body={grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirect,resource:target};
    const r=method==='client_secret_post'?await post('/oauth/token',{...body,client_id:client.client_id,client_secret:client.client_secret}):
      await post('/oauth/token',body,{Authorization:'Basic '+Buffer.from(client.client_id+':'+client.client_secret).toString('base64')});
    assert.equal(r.status,200,await r.clone().text());
  }
});
test('registration throttling and oversized or repeated parameters fail explicitly',async()=>{
  const headers={'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.55'},body=JSON.stringify({redirect_uris:[redirect]});
  for(let n=0;n<20;n++)assert.equal((await fetch('/oauth/register',{method:'POST',headers,body})).status,201);
  const throttled=await fetch('/oauth/register',{method:'POST',headers,body});assert.equal(throttled.status,429);assert.ok(Number(throttled.headers.get('Retry-After'))>0);
  const big=await fetch('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'x='+'a'.repeat(17_000)});assert.equal(big.status,400);
  const repeated=await fetch('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'client_id=a&client_id=b'});assert.equal(repeated.status,400);
});
