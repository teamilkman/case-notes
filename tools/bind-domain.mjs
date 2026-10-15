// Verify the current binding; create it only when the hostname has no DNS conflict.
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const zone=process.env.ZONE_ID;
const hostname=process.env.DOMAIN;
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token||!account||!zone||!hostname)throw new Error('Missing Cloudflare deployment configuration');
if(process.env.CLOUDFLARE_ACCOUNT_ID!==account)throw new Error('Missing or unexpected Cloudflare credentials');
async function api(path,method='GET',body){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok||!data.success)throw new Error(`Cloudflare ${method} ${path} denied: HTTP ${response.status}, codes ${(data.errors??[]).map(x=>x.code).join(',')}`);
  return data.result;
}
const domainsPath=`/accounts/${account}/workers/domains`;
const existing=(await api(domainsPath)).find(x=>x.hostname===hostname);
if(existing){
  if(!existing.enabled||existing.zone_id!==zone)throw new Error('Unexpected domain state');
  if(existing.service!==config.name){
    const result=await api(`/accounts/${account}/d1/database/${config.d1_databases[0].database_id}/query`,'POST',{
      sql:'SELECT source_worker FROM resource_transfers WHERE source_worker=?',params:[existing.service],
    });
    if(result[0].results.length!==1)throw new Error('Hostname is bound to an unverified source Worker; refusing to replace it');
    // Use the same origin handover endpoint as Wrangler. The public attach
    // endpoint rejects a hostname already owned by another Worker (100116).
    await api(`/accounts/${account}/workers/scripts/${config.name}/domains/records`,'PUT',{
      override_scope:false,override_existing_origin:true,override_existing_dns_record:false,
      origins:[{hostname,zone_id:zone,enabled:true}],
    });
    if(!(await api(domainsPath)).some(d=>d.hostname===hostname&&d.service===config.name&&d.enabled))throw new Error('Domain transfer was not confirmed');
  }
  console.log('Custom domain already bound to case-notes.');
}else{
  const dnsPath=`/zones/${zone}/dns_records`;
  const records=await api(`${dnsPath}?name=${hostname}`);
  const addressRecords=records.filter(x=>['A','AAAA','CNAME'].includes(x.type));
  if(addressRecords.length)throw new Error('Hostname has conflicting DNS records; resolve the conflict before binding the Worker');
  await api(domainsPath,'PUT',{hostname,service:'case-notes',zone_id:zone,enabled:true});
  const bound=(await api(domainsPath)).find(x=>x.hostname===hostname&&x.service==='case-notes'&&x.enabled);
  if(!bound)throw new Error('Custom domain binding was not confirmed');
  console.log('Custom domain bound to case-notes.');
}
