// CI smoke checks only; never log authentication headers or case content.
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!account||!token||!process.env.API_TOKEN||!process.env.WEB_PASSWORD)throw new Error('Missing deployment credentials');
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,{headers:{Authorization:`Bearer ${token}`}});
const result=await response.json();
if(!response.ok||!result.success||!result.result?.subdomain)throw new Error('Cannot resolve workers.dev subdomain');
const workerUrl=`https://case-notes.${result.result.subdomain}.workers.dev`;
const urls=[...new Set([workerUrl,...(process.env.DEPLOYMENT_URL?[new URL(process.env.DEPLOYMENT_URL).origin]:[])])];
const searchArgs={result_type:'cases',scope:'affairs',limit:1};
function checkQuota(result){
  if(result.error?.code==='DAILY_LIMIT_EXCEEDED'){
    const error=new Error('D1 daily quota exceeded; retry deployment verification after the reported reset');
    error.quota=true;throw error;
  }
}
function checkRead(result){
  checkQuota(result??{});
  if(!result?.ok||result.data?.snapshot_id!==null||result.data?.complete!==true)throw new Error('Read-only page verification failed');
}
for(const url of urls){
let success=false;
for(let attempt=0;attempt<6;attempt++){
  try{
    const health=await fetch(url+'/health');
    if(!health.ok)throw new Error('Health check failed');
    const mcpDenied=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    if(mcpDenied.status!==401||!mcpDenied.headers.get('WWW-Authenticate')?.includes(`resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`))throw new Error('MCP OAuth discovery challenge unavailable');
    const protectedResource=await fetch(url+'/.well-known/oauth-protected-resource/mcp'),resourceMetadata=await protectedResource.json();
    if(!protectedResource.ok||resourceMetadata.resource!==url+'/mcp'||resourceMetadata.authorization_servers?.[0]!==url)throw new Error('MCP protected resource metadata invalid');
    const oauth=await fetch(url+'/.well-known/oauth-authorization-server'),oauthMetadata=await oauth.json();
    if(!oauth.ok||oauthMetadata.issuer!==url||oauthMetadata.registration_endpoint!==url+'/oauth/register'||oauthMetadata.token_endpoint!==url+'/oauth/token'||!oauthMetadata.code_challenge_methods_supported?.includes('S256'))throw new Error('MCP OAuth authorization metadata invalid');
    const retiredGuide=await fetch(url+'/docs/usage.md');
    if(retiredGuide.status!==404)throw new Error('Retired standalone guide is still served');
    const api=await fetch(url+'/api/openapi.json');
    const schema=await api.json();if(!api.ok)throw new Error('Generated OpenAPI unavailable');
    const init=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${process.env.API_TOKEN}`,'MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:'deployment-initialize',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'deployment-check',version:'1'}}})});
    const initialized=await init.json(),rules=initialized.result?.instructions;
    if(!init.ok||typeof rules!=='string'||rules!==schema.info?.description||/https?:\/\/|OpenAPI|网页|看板|HTTP|SQL|周报|部署|同一事务/.test(rules)||!['原文与流程','记录语法','日期与标签','各行独立解析','request_key','commit_state'].every(rule=>rules.includes(rule)))throw new Error('MCP and OpenAPI do not expose the focused data conventions');
    const unauth=await fetch(url+'/api/v1/search',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    if(unauth.status!==401)throw new Error('Unauthenticated request was not denied');
    const auth=await fetch(url+'/api/v1/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.API_TOKEN}`},body:JSON.stringify(searchArgs)});
    const data=await auth.json();checkQuota(data);if(!auth.ok||!data.ok||data.meta?.parser_version!==2||data.data.items.some(item=>item.type!=='case'||!item.case?.id))throw new Error('Authenticated database read failed');
    checkRead(data);
    if(data.data.has_more){
      const next=await fetch(url+'/api/v1/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.API_TOKEN}`},body:JSON.stringify({...searchArgs,cursor:data.data.next_cursor})});
      const continued=await next.json();checkRead(continued);
      if(!next.ok||continued.data.page_start!==data.data.returned_count)throw new Error('REST continuation failed');
    }
    const rpc=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${process.env.API_TOKEN}`,'MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:'deployment-tools',method:'tools/list',params:{}})});
    const tools=await rpc.json();if(!rpc.ok||tools.result?.tools?.length!==9||!tools.result.tools.some(tool=>tool.name==='search')||tools.result.tools.some(tool=>['cases_search','lines_search'].includes(tool.name)))throw new Error('MCP tool discovery failed');
    for(const tool of tools.result.tools){
      const operation=schema.paths?.['/api/v1/'+tool.name]?.post;
      if(!operation||operation.description!==tool.description||JSON.stringify(operation.responses?.['200']?.content?.['application/json']?.schema)!==JSON.stringify(tool.outputSchema)||!tool.outputSchema?.properties?.data?.anyOf?.some(branch=>branch.properties))throw new Error('MCP and OpenAPI output schemas differ: '+tool.name);
    }
    const searchRpc=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${process.env.API_TOKEN}`,'MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:'deployment-search',method:'tools/call',params:{name:'search',arguments:searchArgs}})});
    const searched=await searchRpc.json();checkQuota(searched.result?.structuredContent??{});if(!searchRpc.ok||searched.result?.isError||!searched.result?.structuredContent?.ok)throw new Error('MCP search call failed');
    const mcpPage=searched.result.structuredContent;checkRead(mcpPage);
    if(mcpPage.data.has_more){
      const next=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${process.env.API_TOKEN}`,'MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:'deployment-search-next',method:'tools/call',params:{name:'search',arguments:{...searchArgs,cursor:mcpPage.data.next_cursor}}})});
      const continued=await next.json();checkRead(continued.result?.structuredContent);
      if(!next.ok||continued.result?.isError||continued.result.structuredContent.data.page_start!==mcpPage.data.returned_count)throw new Error('MCP continuation failed');
    }
    const login=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({password:process.env.WEB_PASSWORD})});
    if(!login.ok)checkQuota(await login.json());
    const cookie=login.headers.get('set-cookie')?.split(';')[0];
    if(!login.ok||!cookie)throw new Error('Web login failed');
    for(const [name,args] of [['stats',{today:new Date().toISOString().slice(0,10)}],['cases',{limit:20}],['schedules',{today:new Date().toISOString().slice(0,10),limit:20}],['todos',{limit:20}],['calendar-counts',{}]]){
      const page=await fetch(url+'/api/web/'+name,{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'application/json'},body:JSON.stringify(args)});
      const data=await page.json();checkQuota(data);if(!page.ok||!data.ok||(name!=='stats'&&data.data.items.length>20&&name!=='calendar-counts'))throw new Error('Web database page failed: '+name);
      if(data.data.has_more){const next=await fetch(url+'/api/web/'+name,{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'application/json'},body:JSON.stringify({...args,cursor:data.data.next_cursor})});const continued=await next.json();checkQuota(continued);if(!next.ok||!continued.ok)throw new Error('Web continuation failed: '+name);}
    }
    const logout=await fetch(url+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'application/json'},body:'{}'});
    if(!logout.ok)checkQuota(await logout.json());
    if(!logout.ok)throw new Error('Web logout failed');
    success=true;break;
  }catch(e){if(e.quota||attempt===5)throw e;await new Promise(resolve=>setTimeout(resolve,10000));}
}
if(!success)throw new Error('Deployment check failed');
console.log(`Live service verified: ${url}`);
if(process.env.GITHUB_STEP_SUMMARY){const {appendFile}=await import('node:fs/promises');await appendFile(process.env.GITHUB_STEP_SUMMARY,`Deployed and verified: [案记](${url})\n`);}
}
