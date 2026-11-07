export const GUARD_REF='case_notes_ai_resource_guard';
export interface GuardState {v:1;reason:'open'|'spike'|'budget';until:number;strikes:number;last_pause:number}
export interface GuardMetrics {daily:number;recent:number;previous:number}
export interface GuardRule {id:string;ref:string;expression:string;action:string;enabled:boolean;description:string;version?:string}
export interface GuardRuleset {id:string;rules:GuardRule[]}
export const openGuard:GuardState={v:1,reason:'open',until:0,strikes:0,last_pause:0};
export const guardExpression=(host:string)=>`http.host eq "${host}" and (http.request.uri.path eq "/mcp" or (starts_with(http.request.uri.path, "/api/v1/") and any(http.request.headers["authorization"][*] ne "")))`;
export const guardDescription=(state:GuardState)=>'Case Notes automatic resource guard '+JSON.stringify(state);
export function readGuardState(rule:GuardRule):GuardState {
  const match=rule.description?.match(/^Case Notes automatic resource guard (\{.*\})$/);
  let s:any;try{s=JSON.parse(match?.[1]??'');}catch{throw new Error('Invalid resource guard state');}
  if(s.v!==1||!['open','spike','budget'].includes(s.reason)||![s.until,s.strikes,s.last_pause].every(x=>Number.isSafeInteger(x)&&x>=0)||s.strikes>3||rule.enabled!==(s.reason!=='open'))throw new Error('Invalid resource guard state');
  return s;
}
export const isSpike=(m:GuardMetrics)=>m.recent>=300||(m.recent>=100&&m.recent>=10*Math.max(1,m.previous/6));
export function nextGuardState(current:GuardState,m:GuardMetrics,now:number):GuardState {
  if(![m.daily,m.recent,m.previous].every(x=>Number.isFinite(x)&&x>=0))throw new Error('Invalid resource usage metrics');
  if(m.daily>=80_000){
    const until=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate()+1);
    return current.reason==='budget'&&current.until===until?current:{v:1,reason:'budget',until,strikes:current.strikes,last_pause:now};
  }
  if(current.reason!=='open'&&now<current.until)return current;
  if(isSpike(m)){
    const strikes=now-current.last_pause<3_600_000?Math.min(3,current.strikes+1):1;
    return {v:1,reason:'spike',until:now+900_000*2**(strikes-1),strikes,last_pause:now};
  }
  return current.reason==='open'?current:{...current,reason:'open',until:0};
}
export const dailyUsageQuery=(account:string)=>`SELECT COUNT(*) AS value FROM events.workersInvocations WHERE accountTag = '${account}' AND timestamp >= TODAY()`;
export const recentUsageQuery=(account:string)=>`SELECT countIf(timestamp >= NOW() - INTERVAL '5' MINUTE) AS recent, countIf(timestamp < NOW() - INTERVAL '5' MINUTE) AS previous FROM events.workersInvocations WHERE accountTag = '${account}' AND scriptName = 'case-notes' AND timestamp >= NOW() - INTERVAL '35' MINUTE`;
export const spikeAlertQuery=(account:string)=>`SELECT COUNT(*) AS value FROM events.workersInvocations WHERE accountTag = '${account}' AND scriptName = 'case-notes' AND timestamp >= NOW() - INTERVAL '5' MINUTE`;

export interface ResourceGuardEnv {RESOURCE_GUARD_TOKEN?:string;GUARD_ACCOUNT_ID?:string;GUARD_ZONE_ID?:string;GUARD_HOSTNAME?:string}
export async function runResourceGuard(env:ResourceGuardEnv,now=Date.now(),fetcher:typeof fetch=fetch) {
  const {RESOURCE_GUARD_TOKEN:token,GUARD_ACCOUNT_ID:account,GUARD_ZONE_ID:zone,GUARD_HOSTNAME:host}=env;
  if(!token||!account||!zone||!host||!/^([a-f0-9]{32})$/.test(account)||!/^([a-f0-9]{32})$/.test(zone)||!/^[a-z0-9.-]+$/i.test(host))throw new Error('Resource guard configuration unavailable');
  async function api(path:string,body?:unknown,method=body?'POST':'GET'):Promise<any>{
    const r=await fetcher('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15_000)});
    if(!r.ok)throw new Error(`Resource guard provider HTTP ${r.status}`);
    const data=await r.json() as any;if(data.success===false||data.errors?.length)throw new Error('Resource guard provider rejected request');return data.result??data;
  }
  const endpoint=`/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const ruleset:GuardRuleset=await api(endpoint),owned=ruleset.rules.filter(x=>x.ref===GUARD_REF);
  if(owned.length!==1||owned[0].action!=='block'||owned[0].expression!==guardExpression(host))throw new Error('Resource guard edge rule unavailable');
  const rule=owned[0],current=readGuardState(rule);
  const [daily,recent]=await Promise.all([api(`/accounts/${account}/analytics/sql?account_tag=${account}`,{query:dailyUsageQuery(account)}),api(`/accounts/${account}/analytics/sql?account_tag=${account}`,{query:recentUsageQuery(account)})]);
  const values=[daily.data?.[0]?.value,recent.data?.[0]?.recent,recent.data?.[0]?.previous];
  if(!values.every(x=>typeof x==='number'||(typeof x==='string'&&/^\d+(?:\.\d+)?$/.test(x))))throw new Error('Invalid resource usage metrics');
  const metrics={daily:Number(values[0]),recent:Number(values[1]),previous:Number(values[2])};
  const next=nextGuardState(current,metrics,now);
  if(JSON.stringify(next)===JSON.stringify(current))return {state:current,metrics,changed:false};
  // A deployment or another scheduled run may have changed the switch meanwhile.
  const latest:GuardRuleset=await api(endpoint),fresh=latest.rules.find(x=>x.ref===GUARD_REF);
  if(!fresh||fresh.id!==rule.id||fresh.version!==rule.version||fresh.description!==rule.description||fresh.enabled!==rule.enabled)return {state:current,metrics,changed:false};
  await api(`/zones/${zone}/rulesets/${ruleset.id}/rules/${rule.id}`,{enabled:next.reason!=='open',description:guardDescription(next)},'PATCH');
  const verified:GuardRuleset=await api(endpoint),actual=verified.rules.find(x=>x.ref===GUARD_REF);
  if(!actual||actual.expression!==guardExpression(host)||actual.action!=='block'||JSON.stringify(readGuardState(actual))!==JSON.stringify(next))throw new Error('Resource guard transition verification failed');
  return {state:next,metrics,changed:true};
}
