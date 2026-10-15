import { authenticate, checkOrigin, limitAttempts, login } from './auth';
import { AppError, sha256, type Env, type Principal } from './types';

const SCOPE='mcp',BROWSER_COOKIE='case_notes_oauth_browser';
const ACCESS_SECONDS=3600,GRANT_MS=30*86400_000,CLIENT_MS=365*86400_000;
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type, Authorization'};
class OAuthError extends Error {
  constructor(public code:string,message:string,public status=400){super(message);}
}
function reject(code:string,message:string):never{throw new OAuthError(code,message);}
function json(value:unknown,status=200,extra:Record<string,string>={}){return Response.json(value,{status,headers:{...cors,...extra,
  'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff'}});}
function random(){const bytes=crypto.getRandomValues(new Uint8Array(32));return base64url(bytes);}
function base64url(bytes:Uint8Array){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function challenge(verifier:string){return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));}
function cookie(request:Request,name:string){return request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);}
function browserCookie(request:Request,token:string){return `${BROWSER_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=600${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
function resource(request:Request){return new URL('/mcp',request.url).href;}
export function oauthChallenge(request:Request){return `Bearer realm="case-notes", resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp',request.url).href}", scope="${SCOPE}"`;}
function text(value:unknown,max=2048){if(typeof value!=='string'||!value||value.length>max)reject('invalid_request','参数缺失或过长。');return value;}
function one(params:URLSearchParams,name:string){const values=params.getAll(name);if(values.length>1)reject('invalid_request','参数不能重复。');return values[0];}
function checkScope(value:string|undefined){if(value!==undefined&&value!==SCOPE)reject('invalid_scope','仅支持 mcp 权限。');}
function checkResource(value:unknown,request:Request){
  let parsed:URL;try{parsed=new URL(text(value));}catch{reject('invalid_target','必须指定本站 MCP resource。');}
  if(parsed.href!==resource(request))reject('invalid_target','令牌只能用于本站 MCP。');return parsed.href;
}
function validRedirect(value:unknown){
  const raw=text(value);let url:URL;try{url=new URL(raw);}catch{reject('invalid_redirect_uri','回调地址无效。');}
  if(url.username||url.password||url.hash||!['http:','https:'].includes(url.protocol)||
    (url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))reject('invalid_redirect_uri','回调地址必须使用 HTTPS 或本机回环地址。');
  return raw;
}
async function readBody(request:Request){
  const reader=request.body?.getReader();if(!reader)reject('invalid_request','缺少请求体。');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;
    if(size>16_384){await reader.cancel();reject('invalid_request','请求体超过 16 KiB。');}chunks.push(part.value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(all);
}
async function form(request:Request){
  if(request.headers.get('Content-Type')?.split(';')[0]!=='application/x-www-form-urlencoded')reject('invalid_request','请使用表单编码。');
  const params=new URLSearchParams(await readBody(request));for(const name of params.keys())one(params,name);return params;
}
interface Client {client_id:string;issuer:string;client_name:string;redirect_uris:string;auth_method:string;secret_hash:string|null;expires_at:number}
async function getClient(env:Env,id:string,request:Request){
  const client=await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id=? AND issuer=? AND expires_at>?')
    .bind(id,new URL(request.url).origin,Date.now()).first<Client>();
  if(!client)throw new OAuthError('invalid_client','客户端无效，请重新连接。',401);return client;
}
async function tokenClient(request:Request,env:Env,params:URLSearchParams){
  let id=one(params,'client_id'),secret=one(params,'client_secret'),method=secret===undefined?'none':'client_secret_post';
  const auth=request.headers.get('Authorization');
  if(auth){
    if(id||secret||!auth.startsWith('Basic '))throw new OAuthError('invalid_client','客户端认证方式无效。',401);
    try{const decoded=atob(auth.slice(6)),index=decoded.indexOf(':');if(index<0)throw new Error();
      id=decodeURIComponent(decoded.slice(0,index).replace(/\+/g,' '));secret=decodeURIComponent(decoded.slice(index+1).replace(/\+/g,' '));method='client_secret_basic';
    }catch{throw new OAuthError('invalid_client','客户端认证方式无效。',401);}
  }
  const client=await getClient(env,text(id),request);
  if(client.auth_method!==method||(method!=='none'&&(!secret||await sha256(secret)!==client.secret_hash)))throw new OAuthError('invalid_client','客户端认证失败。',401);
  return client;
}
async function cleanup(env:Env){const now=Date.now();await env.DB.batch([
  env.DB.prepare('DELETE FROM oauth_requests WHERE request_hash IN (SELECT request_hash FROM oauth_requests WHERE expires_at<? ORDER BY expires_at LIMIT 100)').bind(now),
  env.DB.prepare('DELETE FROM oauth_grants WHERE id IN (SELECT id FROM oauth_grants WHERE expires_at<? ORDER BY expires_at LIMIT 100)').bind(now),
  env.DB.prepare('DELETE FROM oauth_clients WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE expires_at<? ORDER BY expires_at LIMIT 100)').bind(now),
]);}
async function register(request:Request,env:Env){
  await limitAttempts(request,env,'oauth-register:',20);await cleanup(env);
  if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')reject('invalid_client_metadata','请使用 JSON。');
  let data:any;try{data=JSON.parse(await readBody(request));}catch{reject('invalid_client_metadata','JSON 无效。');}
  if(!data||typeof data!=='object'||Array.isArray(data))reject('invalid_client_metadata','客户端参数无效。');
  if(!Array.isArray(data.redirect_uris)||!data.redirect_uris.length||data.redirect_uris.length>10)reject('invalid_client_metadata','需要 1 至 10 个回调地址。');
  const redirects=[...new Set(data.redirect_uris.map(validRedirect))];
  const method=data.token_endpoint_auth_method??'none';
  if(!['none','client_secret_post','client_secret_basic'].includes(method)||
    (data.grant_types!==undefined&&(!Array.isArray(data.grant_types)||!data.grant_types.length||data.grant_types.some((x:unknown)=>!['authorization_code','refresh_token'].includes(String(x)))))||
    (data.response_types!==undefined&&(!Array.isArray(data.response_types)||data.response_types.length!==1||data.response_types[0]!=='code')))reject('invalid_client_metadata','不支持该认证或授权方式。');
  checkScope(data.scope);
  const name=data.client_name===undefined?'MCP 客户端':text(data.client_name,120),id=random(),secret=method==='none'?null:random(),now=Date.now();
  await env.DB.prepare('INSERT INTO oauth_clients VALUES(?,?,?,?,?,?,?,?)')
    .bind(id,new URL(request.url).origin,name,JSON.stringify(redirects),method,secret?await sha256(secret):null,now,now+CLIENT_MS).run();
  return json({client_id:id,client_id_issued_at:Math.floor(now/1000),client_name:name,redirect_uris:redirects,
    token_endpoint_auth_method:method,grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:SCOPE,
    ...(secret?{client_secret:secret,client_secret_expires_at:Math.floor((now+CLIENT_MS)/1000)}:{})},201);
}
interface Pending {request_hash:string;browser_hash:string;client_id:string;redirect_uri:string;resource:string;state:string|null;challenge:string;expires_at:number}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]!));}
function consent(request:Request,client:Client,pending:Pending,nonce:string,browser:string,loggedIn:boolean,error='',status=200){
  const callback=new URL(pending.redirect_uri),destination=callback.origin+callback.pathname;
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>案记 · 连接授权</title><link rel="icon" href="/web/logo.svg"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/oauth.css"></head><body><main class="oauth-layout"><section class="oauth-card" aria-labelledby="title"><div class="oauth-brand"><img src="/web/logo.svg" alt="">案记</div><h1 id="title">连接 案记</h1><p class="oauth-intro">以下客户端请求访问你的私人工作空间。</p><div class="oauth-client"><strong>${escapeHtml(client.client_name)}</strong><span>客户端名称由申请方提供，请核对回调地址。</span><span class="oauth-destination">${escapeHtml(destination)}</span></div><p class="oauth-permissions">授权后可读取案件、记录、待办与日程，并创建或修改案件及记录、删除记录。</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(nonce)}">${loggedIn?'<p class="oauth-session">已通过工作空间登录验证，请确认是否授权。</p>':'<label for="password">工作空间访问密码</label><div class="oauth-password"><input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="error"><button type="button" id="toggle-password" aria-label="显示密码" aria-pressed="false">显示</button></div>'}<p id="error" class="oauth-error" role="alert">${escapeHtml(error)}</p><div class="oauth-actions"><button type="submit" name="decision" value="deny" formnovalidate class="oauth-cancel">取消</button><button type="submit" name="decision" value="allow" class="oauth-allow">${loggedIn?'同意并连接':'登录并授权'}</button></div></form><p class="oauth-footer">本次授权仅用于 案记</p></section></main><script src="/oauth.js" defer></script></body></html>`,{status,headers:{
    'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff',
    // Chrome applies form-action to the final redirect as well as the same-origin POST.
    'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' ${callback.origin}; frame-ancestors 'none'`,
    'Set-Cookie':browserCookie(request,browser)}});
}
async function webSession(request:Request,env:Env){
  // An AI bearer must never stand in for the owner's browser login on the consent page.
  const headers=new Headers(request.headers);headers.delete('Authorization');
  try{const p=await authenticate(new Request(request.url,{headers}),env);return p.source==='web';}
  catch(error){if(error instanceof AppError&&error.status===401)return false;throw error;}
}
async function authorize(request:Request,env:Env){
  if(request.method==='GET'){
    await limitAttempts(request,env,'oauth-authorize:',60);await cleanup(env);
    const params=new URL(request.url).searchParams;for(const name of params.keys())one(params,name);
    const client=await getClient(env,text(one(params,'client_id')),request),redirect=text(one(params,'redirect_uri'));
    if(!JSON.parse(client.redirect_uris).includes(redirect))reject('invalid_request','回调地址与注册值不一致。');
    if(one(params,'response_type')!=='code')reject('unsupported_response_type','仅支持授权码。');
    checkScope(one(params,'scope'));const target=checkResource(one(params,'resource'),request),pkce=text(one(params,'code_challenge'),128);
    if(one(params,'code_challenge_method')!=='S256'||! /^[A-Za-z0-9_-]{43}$/.test(pkce))reject('invalid_request','需要 S256 PKCE。');
    const state=one(params,'state');if(state!==undefined&&state.length>2048)reject('invalid_request','state 过长。');
    const existing=cookie(request,BROWSER_COOKIE),browser=existing&&/^[A-Za-z0-9_-]{43}$/.test(existing)?existing:random(),nonce=random();
    const pending:Pending={request_hash:await sha256(nonce),browser_hash:await sha256(browser),client_id:client.client_id,redirect_uri:redirect,
      resource:target,state:state??null,challenge:pkce,expires_at:Date.now()+600_000};
    await env.DB.prepare('INSERT INTO oauth_requests VALUES(?,?,?,?,?,?,?,?)')
      .bind(pending.request_hash,pending.browser_hash,pending.client_id,pending.redirect_uri,pending.resource,pending.state,pending.challenge,pending.expires_at).run();
    return consent(request,client,pending,nonce,browser,await webSession(request,env));
  }
  checkOrigin(request);const params=await form(request),nonce=text(one(params,'request'),128),browser=cookie(request,BROWSER_COOKIE)??'';
  const pending=await env.DB.prepare('SELECT * FROM oauth_requests WHERE request_hash=? AND browser_hash=? AND expires_at>?')
    .bind(await sha256(nonce),await sha256(browser),Date.now()).first<Pending>();
  if(!pending)reject('invalid_request','授权页面已过期或已提交，请从客户端重新连接。');
  const client=await getClient(env,pending.client_id,request),decision=one(params,'decision');
  if(decision!=='allow'&&decision!=='deny')reject('invalid_request','请选择授权或取消。');
  let sessionCookie:string|undefined;
  if(decision==='allow'&&!await webSession(request,env)){
    try{sessionCookie=await login(request,env,{password:one(params,'password')});}
    catch(error){if(error instanceof AppError&&[401,429,503].includes(error.status))return consent(request,client,pending,nonce,browser,false,error.message,error.status);throw error;}
  }
  const code=random(),now=Date.now();
  const result=await env.DB.batch([
    ...(decision==='allow'?[env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,workspace_id,resource,redirect_uri,challenge,code_hash,code_expires_at,expires_at)
      SELECT ?,client_id,?,resource,redirect_uri,challenge,?,?,? FROM oauth_requests WHERE request_hash=? AND browser_hash=? AND expires_at>?`)
      .bind(random(),env.WORKSPACE_ID??'personal',await sha256(code),now+300_000,now+GRANT_MS,pending.request_hash,pending.browser_hash,now)]:[]),
    env.DB.prepare('DELETE FROM oauth_requests WHERE request_hash=? AND browser_hash=? AND expires_at>? RETURNING request_hash').bind(pending.request_hash,pending.browser_hash,now),
  ]);
  if(!result.at(-1)?.results.length)reject('invalid_request','授权已提交或已过期，请重新连接。');
  const redirect=new URL(pending.redirect_uri);redirect.searchParams.set(decision==='allow'?'code':'error',decision==='allow'?code:'access_denied');
  if(pending.state!==null)redirect.searchParams.set('state',pending.state);
  const headers=new Headers({'Location':redirect.href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});if(sessionCookie)headers.set('Set-Cookie',sessionCookie);
  return new Response(null,{status:303,headers});
}
async function token(request:Request,env:Env){
  await limitAttempts(request,env,'oauth-token:',120);
  const params=await form(request),client=await tokenClient(request,env,params),target=checkResource(one(params,'resource'),request);
  checkScope(one(params,'scope'));const type=one(params,'grant_type'),now=Date.now(),access=random(),refresh=random();
  const accessHash=await sha256(access),refreshHash=await sha256(refresh);let rows:D1Result[];
  if(type==='authorization_code'){
    const verifier=text(one(params,'code_verifier'),128);if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))reject('invalid_grant','PKCE verifier 无效。');
    rows=await env.DB.batch([env.DB.prepare(`UPDATE oauth_grants SET code_hash=NULL,access_hash=?,access_expires_at=?,refresh_hash=?
      WHERE code_hash=? AND client_id=? AND workspace_id=? AND resource=? AND redirect_uri=? AND challenge=? AND code_expires_at>? AND expires_at>? AND revoked=0 RETURNING id`)
      .bind(accessHash,now+ACCESS_SECONDS*1000,refreshHash,await sha256(text(one(params,'code'),128)),client.client_id,env.WORKSPACE_ID??'personal',target,
        text(one(params,'redirect_uri')),await challenge(verifier),now,now)]);
  }else if(type==='refresh_token'){
    const oldHash=await sha256(text(one(params,'refresh_token'),128));
    // Rotation and history are one transaction. A losing concurrent refresh is a replay and revokes the family.
    rows=await env.DB.batch([
      env.DB.prepare(`UPDATE oauth_grants SET access_hash=?,access_expires_at=?,refresh_hash=? WHERE refresh_hash=?
        AND client_id=? AND workspace_id=? AND resource=? AND expires_at>? AND revoked=0 RETURNING id`)
        .bind(accessHash,now+ACCESS_SECONDS*1000,refreshHash,oldHash,client.client_id,env.WORKSPACE_ID??'personal',target,now),
      env.DB.prepare('INSERT INTO oauth_used_refresh_tokens(token_hash,grant_id) SELECT ?,id FROM oauth_grants WHERE refresh_hash=?').bind(oldHash,refreshHash),
      env.DB.prepare(`UPDATE oauth_grants SET revoked=1 WHERE client_id=? AND workspace_id=? AND resource=? AND refresh_hash!=?
        AND id IN (SELECT grant_id FROM oauth_used_refresh_tokens WHERE token_hash=?)`).bind(client.client_id,env.WORKSPACE_ID??'personal',target,refreshHash,oldHash),
    ]);
  }else reject('unsupported_grant_type','仅支持授权码和刷新令牌。');
  if(!rows[0].results.length)reject('invalid_grant','授权码或刷新令牌无效、已使用或已过期，请重新授权。');
  return json({access_token:access,token_type:'Bearer',expires_in:ACCESS_SECONDS,refresh_token:refresh,scope:SCOPE});
}
async function revoke(request:Request,env:Env){
  await limitAttempts(request,env,'oauth-token:',120);const params=await form(request),client=await tokenClient(request,env,params),hash=await sha256(text(one(params,'token'),128));
  await env.DB.prepare(`UPDATE oauth_grants SET revoked=1 WHERE client_id=? AND workspace_id=? AND
    (access_hash=? OR refresh_hash=? OR id IN (SELECT grant_id FROM oauth_used_refresh_tokens WHERE token_hash=?))`)
    .bind(client.client_id,env.WORKSPACE_ID??'personal',hash,hash,hash).run();return json({});
}
export async function authenticateOAuth(request:Request,env:Env,bearer:string):Promise<Principal|null>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(bearer))return null;
  const row=await env.DB.prepare(`SELECT client_id FROM oauth_grants WHERE access_hash=? AND workspace_id=? AND resource=?
    AND access_expires_at>? AND expires_at>? AND revoked=0`)
    .bind(await sha256(bearer),env.WORKSPACE_ID??'personal',resource(request),Date.now(),Date.now()).first<{client_id:string}>();
  return row?{workspaceId:env.WORKSPACE_ID??'personal',clientId:row.client_id,actorId:'owner',source:'ai'}:null;
}
export async function handleOAuth(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname,origin=url.origin;
  const metadata=['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server'];
  if(!metadata.includes(path)&&!path.startsWith('/oauth/'))return null;
  try{
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))reject('invalid_request','OAuth 必须使用 HTTPS，本机开发地址除外。');
    if(request.method==='OPTIONS'&&path!=='/oauth/authorize')return new Response(null,{status:204,headers:cors});
    if(request.method==='GET'&&metadata.includes(path))return json(path==='/.well-known/oauth-authorization-server'?{
      issuer:origin,authorization_endpoint:origin+'/oauth/authorize',token_endpoint:origin+'/oauth/token',registration_endpoint:origin+'/oauth/register',
      revocation_endpoint:origin+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
      token_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'],code_challenge_methods_supported:['S256'],scopes_supported:[SCOPE],
    }:{resource:resource(request),authorization_servers:[origin],scopes_supported:[SCOPE],bearer_methods_supported:['header'],resource_name:'案记'});
    if(path==='/oauth/register'&&request.method==='POST')return await register(request,env);
    if(path==='/oauth/authorize'&&['GET','POST'].includes(request.method))return await authorize(request,env);
    if(path==='/oauth/token'&&request.method==='POST')return await token(request,env);
    if(path==='/oauth/revoke'&&request.method==='POST')return await revoke(request,env);
    return json({error:'invalid_request',error_description:'接口或 HTTP 方法不存在。'},404);
  }catch(error){
    if(error instanceof OAuthError)return json({error:error.code,error_description:error.message},error.status,
      error.code==='invalid_client'&&request.headers.get('Authorization')?.startsWith('Basic ')?{'WWW-Authenticate':'Basic realm="case-notes-oauth"'}:{});
    if(error instanceof AppError){const retry=(error.details as {retry_after?:number}|null)?.retry_after;
      return json({error:error.status===429?'temporarily_unavailable':'access_denied',error_description:error.message},error.status,retry?{'Retry-After':String(retry)}:{});}
    throw error;
  }
}
