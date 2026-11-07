import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {GUARD_REF,openGuard,guardExpression,guardDescription,readGuardState,dailyUsageQuery,spikeAlertQuery,type GuardRuleset} from '../src/resource-guard';

export async function configureResourceGuard(env:NodeJS.ProcessEnv,{fetcher=fetch,verifyOnly=false}={}) {
  const account=env.CLOUDFLARE_ACCOUNT_ID,zone=env.ZONE_ID,host=env.DOMAIN,token=env.CLOUDFLARE_API_TOKEN,email=env.RESOURCE_ALERT_EMAIL;
  if(!account||!zone||!host||!token||!email||!/^([a-f0-9]{32})$/.test(account)||!/^([a-f0-9]{32})$/.test(zone)||!/^[a-z0-9.-]+$/i.test(host)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Missing resource protection configuration');
  async function api(path:string,body?:unknown,method=body?'POST':'GET'):Promise<any>{
    const r=await fetcher('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15_000)});
    const data=await r.json() as any;
    if(method==='GET'&&r.status===404&&data.errors?.some((x:any)=>x.code===10003))return null;
    if(!r.ok||data.success===false||data.errors?.length)throw new Error(`Resource protection ${method} failed: HTTP ${r.status}, codes ${(data.errors??[]).map((x:any)=>x.code).join(',')}`);
    return data.result??data;
  }
  const base=`/zones/${zone}/rulesets`,phase='http_request_firewall_custom',endpoint=`${base}/phases/${phase}/entrypoint`;
  let ruleset:GuardRuleset|null=await api(endpoint);
  const own=ruleset?.rules.filter(x=>x.ref===GUARD_REF)??[];
  if(own.length>1)throw new Error('Ambiguous automatic resource guard');
  if(own.length)readGuardState(own[0]);
  const expression=guardExpression(host);
  if(!verifyOnly){
    if(!ruleset)await api(base,{name:'Case Notes automatic protection',kind:'zone',phase,rules:[{ref:GUARD_REF,description:guardDescription(openGuard),expression,action:'block',enabled:false}]});
    else if(!own.length)await api(`${base}/${ruleset.id}/rules`,{ref:GUARD_REF,description:guardDescription(openGuard),expression,action:'block',enabled:false});
    else if(own[0].expression!==expression||own[0].action!=='block')await api(`${base}/${ruleset.id}/rules/${own[0].id}`,{expression,action:'block'},'PATCH');
  }
  ruleset=await api(endpoint);const actual=ruleset?.rules.find(x=>x.ref===GUARD_REF);
  if(!actual||actual.expression!==expression||actual.action!=='block')throw new Error('Automatic guard readback failed');
  readGuardState(actual); // do not clear or reset an active automatic cooldown

  const definitions=[
    {name:'Case Notes daily requests warning',query:dailyUsageQuery(account),threshold:'50000',interval:'24h'},
    {name:'Case Notes daily requests critical',query:dailyUsageQuery(account),threshold:'80000',interval:'24h'},
    {name:'Case Notes request spike',query:spikeAlertQuery(account),threshold:'300',interval:'1h'},
  ];
  const path=`/accounts/${account}/alerting/v3/policies`,policies=await api(path);
  for(const definition of definitions){
    const desired={name:definition.name,description:'Case Notes automatic resource protection; sampled metrics, not a hard quota.',alert_type:'custom_analytics',enabled:true,alert_interval:definition.interval,
      mechanisms:{email:[{id:email}]},filters:{source:['sql_api'],selectors:[definition.query],alert_trigger_preferences:['threshold'],alert_trigger_preferences_value:[definition.threshold],alert_trigger_preferences_operator:['>='],alert_trigger_preferences_short_window:['5m'],execution_interval:['5m']}};
    const matches=policies.filter((x:any)=>x.name===definition.name);
    if(matches.length>1||matches.some((x:any)=>x.alert_type!=='custom_analytics'))throw new Error('Ambiguous resource alert policy');
    const aligned=(value:any)=>value?.enabled===true&&value.alert_type===desired.alert_type&&value.alert_interval===desired.alert_interval&&
      Object.entries(desired.filters).every(([key,v])=>JSON.stringify(value.filters?.[key])===JSON.stringify(v))&&JSON.stringify(value.mechanisms?.email)===JSON.stringify(desired.mechanisms.email)&&!value.mechanisms?.webhooks?.length&&!value.mechanisms?.pagerduty?.length;
    let id=matches[0]?.id;
    if(!verifyOnly){
      const preview=await api(`/accounts/${account}/analytics/sql?account_tag=${account}`,{query:definition.query});
      if(preview.data?.length!==1||!Number.isFinite(Number(preview.data[0].value)))throw new Error('Resource alert query validation failed');
      if(!id)id=(await api(path,desired)).id;
      else if(!aligned(matches[0]))await api(`${path}/${id}`,desired,'PUT');
    }
    if(!id||!aligned(await api(`${path}/${id}`)))throw new Error('Resource alert readback failed');
  }
  return {paused:actual.enabled,alerts:definitions.length};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const result=await configureResourceGuard(process.env,{verifyOnly:process.argv.includes('--verify')});
  console.log(`Automatic resource protection verified: ${result.alerts} native alerts; AI ${result.paused?'cooling down':'open'}.`);
}
