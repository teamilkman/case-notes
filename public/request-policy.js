// No polling or automatic business-write retries. A late success cannot erase
// another request's Retry-After, and circuit-open requests never reach fetch.
export function createRequestPolicy({now=Date.now}={}){
  let failures=0,blockedUntil=0;
  const retryAfter=()=>Math.max(0,Math.ceil((blockedUntil-now())/1000));
  const error=()=>Object.assign(new Error(`请求暂缓，请在 ${retryAfter()} 秒后重试。`),{code:'CLIENT_BACKOFF',status:429,retryable:true,commitState:'not_committed',retryAfter:retryAfter()});
  return {
    retryAfter,error,
    check(){if(retryAfter())throw error();},
    limit(response,seconds){
      const raw=response.headers?.get?.('Retry-After');
      let wait=raw===null||raw===undefined?Number(seconds):/^\d+(?:\.\d+)?$/.test(raw)?Number(raw):(Date.parse(raw)-now())/1000;
      if(!Number.isFinite(wait)||wait<=0)wait=60;
      blockedUntil=Math.max(blockedUntil,now()+Math.min(86400,Math.ceil(wait))*1000);
    },
    failure(){failures++;blockedUntil=Math.max(blockedUntil,now()+(failures>=3?60_000:1000*2**(failures-1)));},
    success(){failures=0;},
  };
}
export const requestPolicy=typeof window==='undefined'?null:createRequestPolicy();
