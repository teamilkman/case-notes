// Enforce HTTPS for the site: plain HTTP is redirected and browsers remember it
// with HSTS. Only these two zone settings are touched; unrelated settings stay.
const zone=process.env.ZONE_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!zone||!token)throw new Error('Missing HTTPS enforcement configuration');
const base=`/zones/${zone}/settings`,hsts={strict_transport_security:{enabled:true,max_age:15552000,include_subdomains:true,preload:false,nosniff:true}};
async function api(path,method='GET',body){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok||!data.success)throw new Error(`HTTPS enforcement ${method} denied: HTTP ${response.status}, codes ${(data.errors??[]).map(x=>x.code).join(',')}. CI token needs Zone Settings Edit for the deployment zone.`);
  return data.result;
}
const redirects=https=>https?.value==='on';
const hstsReady=header=>{const value=header?.value?.strict_transport_security;return value?.enabled===true&&Number(value.max_age)>=hsts.strict_transport_security.max_age&&value.include_subdomains===true&&value.preload===false;};
async function read(){const [https,header]=await Promise.all([api(base+'/always_use_https'),api(base+'/security_header')]);return {https,header};}
function verify(state){if(!redirects(state.https)||!hstsReady(state.header))throw new Error('HTTPS enforcement readback verification failed');}
if(process.argv.includes('--verify')){
  verify(await read());console.log('HTTPS enforcement readback verified.');
}else if(process.argv.includes('--check')){
  await read();console.log('HTTPS enforcement configuration accessible; existing settings preserved.');
}else{
  const current=await read();
  if(!redirects(current.https))await api(base+'/always_use_https','PATCH',{value:'on'});
  if(!hstsReady(current.header))await api(base+'/security_header','PATCH',{value:hsts});
  verify(await read());console.log('HTTPS enforcement verified: HTTP redirects to HTTPS and HSTS is enabled.');
}
