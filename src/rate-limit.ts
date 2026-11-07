import { AppError, type Env, type Principal } from './types';

async function check(limiter:RateLimit,key:string) {
  if(!(await limiter.limit({key})).success)
    throw new AppError('RATE_LIMITED','请求过多，请稍后再试。',{retry_after:60},429,true);
}

// Run before parsing bodies or accessing D1. One bucket covers every dynamic
// route on both domains; rotating paths and credentials cannot reset it.
export async function limitRequest(request:Request,env:Env) {
  const path=new URL(request.url).pathname;
  if(!path.startsWith('/api/')&&!path.startsWith('/oauth/')&&!path.startsWith('/.well-known/')&&path!=='/mcp'&&path!=='/health')return;
  const key=`case-notes:ip:${request.headers.get('CF-Connecting-IP')??'local'}`;
  await check(env.API_RATE_LIMITER,key);
  if(path.startsWith('/oauth/')||path==='/api/login')await check(env.AUTH_RATE_LIMITER,key);
}

// A grant's client identity survives token rotation and changes of source IP.
// MCP and REST share this bucket, while web preloading has its own allowance.
export async function limitPrincipal(env:Env,p:Principal) {
  if(p.source==='ai')await check(env.AI_RATE_LIMITER,JSON.stringify(['case-notes:client',p.workspaceId,p.clientId]));
}
