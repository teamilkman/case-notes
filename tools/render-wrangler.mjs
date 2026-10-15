// Renders wrangler.jsonc from wrangler.template.jsonc so the deployed address, zone and
// database identifier never live in the repository. Values come from the environment, or
// from the local .dev.vars file that is never committed. The output is git-ignored.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';

const keys=['DOMAIN','ZONE_ID','D1_DATABASE_ID'];
const values={};
if(existsSync('.dev.vars')){
  for(const line of readFileSync('.dev.vars','utf8').split(/\r?\n/)){
    const match=line.match(/^([A-Z0-9_]+)=(.*)$/);
    if(match)values[match[1]]=match[2].trim().replace(/^["']|["']$/g,'');
  }
}
for(const key of keys)if(process.env[key])values[key]=process.env[key];
const missing=keys.filter(key=>!values[key]);
// Deployment must be complete; a local build only needs a parseable configuration.
if(missing.length&&process.env.REQUIRE_DEPLOYMENT_CONFIG==='1')
  throw new Error('Missing deployment configuration: '+missing.join(', '));
const fallback={DOMAIN:'example.invalid',ZONE_ID:'local-zone',D1_DATABASE_ID:'local-database'};
const rendered=readFileSync('wrangler.template.jsonc','utf8').replace(/\$\{([A-Z0-9_]+)\}/g,(_all,name)=>{
  const value=values[name]??fallback[name];
  if(!value)throw new Error('Missing value for '+name);
  return value;
});
writeFileSync('wrangler.jsonc',rendered);
console.log(`Rendered wrangler.jsonc (${missing.length?'local placeholders':'deployment values'}).`);
