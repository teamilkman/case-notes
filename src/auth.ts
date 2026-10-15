import { AppError, sha256, type Env, type Principal } from './types';
import { authenticateOAuth } from './oauth';
import {previousSessionCookie} from './legacy-identifiers';
const COOKIE='case_notes_session';
function cookies(request:Request){return request.headers.get('Cookie')?.split(';').map(x=>x.trim())??[];}
function cookieValue(request:Request,name:string){return cookies(request).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1);}
function cookieFlags(request:Request){return `; HttpOnly; SameSite=Strict; Path=/${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
async function equalSecret(a:string,b:string) {
  const [x,y]=await Promise.all([sha256(a),sha256(b)]);let diff=0;
  for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);return diff===0;
}
export async function authenticate(request:Request,env:Env):Promise<Principal> {
  const workspaceId=env.WORKSPACE_ID??'personal', auth=request.headers.get('Authorization');
  if(auth?.startsWith('Bearer ')) {
    // Programmatic access is OAuth only; the client identity comes from the grant.
    const principal=await authenticateOAuth(request,env,auth.slice(7));if(principal)return principal;
    throw new AppError('UNAUTHORIZED','AI 接口令牌无效或已过期，请重新授权。',null,401);
  }
  const current=cookieValue(request,COOKIE),cookie=current??cookieValue(request,previousSessionCookie);
  if(cookie){const session=await env.DB.prepare('SELECT * FROM web_sessions WHERE token_hash=? AND workspace_id=? AND expires_at>?')
    .bind(await sha256(cookie),workspaceId,new Date().toISOString()).first();
    if(session)return {workspaceId,clientId:'web',actorId:'owner',source:'web',webSession:{
      cacheScope:await sha256(`browser-cache-v1:${workspaceId}:${cookie}`),expiresAt:String(session.expires_at),
      ...(!current?{cookieUpgrade:[`${COOKIE}=${cookie}; Max-Age=${Math.max(0,Math.floor((Date.parse(String(session.expires_at))-Date.now())/1000))}${cookieFlags(request)}`,
        `${previousSessionCookie}=; Max-Age=0${cookieFlags(request)}`]}:{})}};}
  throw new AppError('UNAUTHORIZED','请先登录。',null,401);
}
export function checkOrigin(request:Request) {
  if(request.headers.get('Origin')!==new URL(request.url).origin)throw new AppError('PERMISSION_DENIED','网页写入必须来自本站。',null,403);
}
export async function login(request:Request,env:Env,body:any) {
  checkOrigin(request);
  if(!env.WEB_PASSWORD)throw new AppError('SERVICE_UNAVAILABLE','尚未设置网页登录密码。',null,503);
  const bucket=await limitAttempts(request,env,'',20),time=new Date().toISOString();
  if(typeof body?.password!=='string'||!await equalSecret(body.password,env.WEB_PASSWORD))throw new AppError('UNAUTHORIZED','密码不正确。',null,401);
  const token=crypto.randomUUID()+crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM web_sessions WHERE expires_at<?').bind(time),
    env.DB.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').bind(await sha256(token),env.WORKSPACE_ID??'personal',new Date(Date.now()+30*86400_000).toISOString(),time),
    env.DB.prepare('DELETE FROM login_attempts WHERE bucket=?').bind(bucket),
  ]);
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
export async function limitAttempts(request:Request,env:Env,namespace:string,limit:number) {
  const ip=request.headers.get('CF-Connecting-IP')??'local',bucket=await sha256(namespace+ip),clock=Date.now(),reset=clock+15*60_000;
  const attempts=await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_attempts WHERE bucket IN
      (SELECT bucket FROM login_attempts WHERE resets_at<? ORDER BY resets_at LIMIT 100)`).bind(clock),
    env.DB.prepare(`INSERT INTO login_attempts(bucket,attempts,resets_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN resets_at<? THEN 1 ELSE attempts+1 END,
      resets_at=CASE WHEN resets_at<? THEN ? ELSE resets_at END RETURNING attempts,resets_at`)
    .bind(bucket,reset,clock,clock,reset),
  ]);
  const count=attempts[1].results[0] as {attempts:number;resets_at:number};
  if(count.attempts>limit)throw new AppError('RATE_LIMITED','请求过多，请稍后再试。',{retry_after:Math.ceil((count.resets_at-clock)/1000)},429,true);
  return bucket;
}
export async function logout(request:Request,env:Env) {
  checkOrigin(request);
  const token=cookieValue(request,COOKIE)??cookieValue(request,previousSessionCookie);
  if(token)await env.DB.prepare('DELETE FROM web_sessions WHERE token_hash=?').bind(await sha256(token)).run();
  return [`${COOKIE}=; Max-Age=0${cookieFlags(request)}`,`${previousSessionCookie}=; Max-Age=0${cookieFlags(request)}`];
}
