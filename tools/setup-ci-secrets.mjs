import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const repo=process.env.CI_REPO??'teamilkman/case-notes';
const text=readFileSync('.dev.vars','utf8');
// Deployment identifiers are secrets too: only the runner needs to resolve them.
for(const key of ['WEB_PASSWORD','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','DEPLOYMENT_URL','DOMAIN','ZONE_ID','D1_DATABASE_ID']){
  const match=text.match(new RegExp('^'+key+'=(.*)$','m'));
  if(!match){if(['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'].includes(key))continue;throw new Error('Missing '+key);}
  const value=match[1].trim().replace(/^["']|["']$/g,'');
  const result=spawnSync('gh',['secret','set',key,'--repo',repo],{input:value,encoding:'utf8'});
  if(result.status!==0)throw new Error('Could not configure '+key);
  console.log('Configured GitHub Secret: '+key);
}
