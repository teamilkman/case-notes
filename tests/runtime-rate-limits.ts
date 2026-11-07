import {readFileSync} from 'node:fs';

const configured=JSON.parse(readFileSync('wrangler.template.jsonc','utf8')).ratelimits as {name:string;namespace_id:string;simple:{limit:number;period:60}}[];
// Existing business suites exercise many unrelated flows on one synthetic IP.
// Rate-limit tests below use their own small, real Miniflare counters.
export const testRateLimits=Object.fromEntries(configured.map(({name,namespace_id,simple})=>[name,{namespace_id,simple:{...simple,limit:100_000}}]));
const allow={limit:async()=>({success:true})};
export const allowedRateLimits={API_RATE_LIMITER:allow,AI_RATE_LIMITER:allow,AUTH_RATE_LIMITER:allow};
