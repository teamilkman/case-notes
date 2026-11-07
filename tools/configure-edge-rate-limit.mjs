// Free WAF supports only path matching, one rule, and 10-second windows.
// Update only our stable ref; never replace a zone's entire ruleset.
const zone=process.env.ZONE_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!zone||!token)throw new Error('Missing edge rate-limit configuration');
const base=`/zones/${zone}/rulesets`,phase='http_ratelimit',ref='case_notes_site_rate_limit';
const desired={ref,description:'Case Notes site request protection',expression:'true',action:'block',enabled:true,
  ratelimit:{characteristics:['cf.colo.id','ip.src'],period:10,requests_per_period:100,mitigation_timeout:10,requests_to_origin:false}};
async function api(path,method='GET',body){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(response.status===404&&method==='GET'&&data.errors?.some(error=>error.code===10003))return null;
  if(!response.ok||!data.success)throw new Error(`Edge rate-limit ${method} denied: HTTP ${response.status}, codes ${(data.errors??[]).map(x=>x.code).join(',')}. CI token needs Zone WAF Edit for the deployment zone.`);
  return data.result;
}
function matches(rule){
  return rule?.ref===ref&&rule.enabled===true&&rule.expression===desired.expression&&rule.action===desired.action&&
    ['period','requests_per_period','mitigation_timeout','requests_to_origin'].every(key=>rule.ratelimit?.[key]===desired.ratelimit[key])&&
    JSON.stringify([...(rule.ratelimit?.characteristics??[])].sort())===JSON.stringify([...desired.ratelimit.characteristics].sort());
}
const endpoint=`${base}/phases/${phase}/entrypoint`;
let ruleset=await api(endpoint);
const owned=ruleset?.rules?.filter(rule=>rule.ref===ref)??[];
if(owned.length>1)throw new Error('Duplicate project edge rate-limit rules; refusing ambiguous update');
if(!owned.length&&ruleset?.rules?.length)throw new Error('The Free WAF rule slot is occupied; refusing to overwrite unrelated rules');
if(process.argv.includes('--verify')){
  if(!matches(owned[0]))throw new Error('Edge rate-limit readback verification failed');
  console.log('Edge site protection readback verified.');
}else if(process.argv.includes('--check')){
  console.log('Edge rate-limit configuration accessible; existing rules preserved.');
}else{
  if(!ruleset){
    await api(base,'POST',{name:'Case Notes request protection',kind:'zone',phase,rules:[desired]});
  }else if(!owned.length){
    await api(`${base}/${ruleset.id}/rules`,'POST',desired);
  }else if(!matches(owned[0])){
    await api(`${base}/${ruleset.id}/rules/${owned[0].id}`,'PATCH',desired);
  }
  ruleset=await api(endpoint);
  if(!matches(ruleset?.rules?.find(rule=>rule.ref===ref)))throw new Error('Edge rate-limit readback verification failed');
  console.log('Edge site protection verified: 100 requests / 10 seconds per IP, blocked for 10 seconds.');
}
