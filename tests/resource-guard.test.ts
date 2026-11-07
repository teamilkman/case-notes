import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GUARD_REF,openGuard,guardDescription,guardExpression,readGuardState,nextGuardState,isSpike,runResourceGuard,type GuardState} from '../src/resource-guard';
import {configureResourceGuard} from '../tools/configure-resource-guard';

const now=Date.parse('2026-11-07T16:00:00Z'),account='a'.repeat(32),zone='b'.repeat(32),host='synthetic.example';
const healthy={daily:10,recent:5,previous:120};
const spike={daily:10,recent:300,previous:5000};
const rule=(state:GuardState=openGuard)=>({id:'own',ref:GUARD_REF,action:'block',expression:guardExpression(host),enabled:state.reason!=='open',description:guardDescription(state),version:'1'});

test('automatic guard detects steady runaway traffic and relative spikes, not normal cold starts',()=>{
  assert.equal(isSpike({...healthy,recent:99,previous:0}),false);
  assert.equal(isSpike({...healthy,recent:100,previous:60}),true);
  assert.equal(isSpike(spike),true);
  assert.equal(isSpike({...healthy,recent:100,previous:600}),false);
});

test('automatic cooldowns restore only after expiry and rechecking, and repeated spikes back off to 30/60 minutes',()=>{
  const first=nextGuardState(openGuard,spike,now);assert.equal(first.until,now+900_000);
  assert.equal(nextGuardState(first,healthy,first.until-1),first);
  const reopened=nextGuardState(first,healthy,first.until);assert.equal(reopened.reason,'open');
  const second=nextGuardState(reopened,spike,first.until+1000);assert.equal(second.until,first.until+1000+1_800_000);
  const third=nextGuardState(second,spike,second.until);assert.equal(third.until,second.until+3_600_000);assert.equal(third.strikes,3);
  assert.equal(nextGuardState(third,healthy,third.until).reason,'open');
});

test('account budget preempts spike cooldown and restores after UTC midnight only with a fresh healthy reading',()=>{
  const cooling=nextGuardState(openGuard,spike,now),budget=nextGuardState(cooling,{...healthy,daily:80_000},now+1);
  assert.equal(budget.reason,'budget');assert.equal(new Date(budget.until).toISOString(),'2026-11-08T00:00:00.000Z');
  assert.equal(nextGuardState(budget,{...healthy,daily:80_001},now+300_000),budget); // no repeated WAF writes
  assert.equal(nextGuardState(budget,healthy,budget.until-1),budget);
  assert.equal(nextGuardState(budget,healthy,budget.until).reason,'open');
  assert.equal(nextGuardState(budget,spike,budget.until).reason,'spike');
  assert.throws(()=>nextGuardState(budget,{...healthy,daily:NaN},budget.until),/Invalid resource usage/);
});

test('guard refuses malformed state rather than silently resuming AI',()=>{
  assert.throws(()=>readGuardState({...rule(),enabled:true}),/Invalid resource guard state/);
  assert.throws(()=>readGuardState({...rule(),description:'unrecognized'}),/Invalid resource guard state/);
});

test('scheduled guard pauses and restores only its own edge rule without touching any business database',async()=>{
  let current=rule(),metrics={...spike};const writes:any[]=[];
  const other={...rule(),id:'other',ref:'unrelated',description:'unrelated'};
  const fake=async(url:any,init:any={})=>{
    const path=new URL(url).pathname;
    if(path.includes('/analytics/sql'))return Response.json({data:[JSON.parse(init.body).query.includes('TODAY()')?{value:metrics.daily}:{recent:metrics.recent,previous:metrics.previous}]});
    if(init.method==='PATCH'){const body=JSON.parse(init.body);writes.push(body);current={...current,...body,version:String(Number(current.version)+1)};}
    return Response.json({success:true,result:{id:'ruleset',rules:[current,other]}});
  };
  const env={RESOURCE_GUARD_TOKEN:'synthetic',GUARD_ACCOUNT_ID:account,GUARD_ZONE_ID:zone,GUARD_HOSTNAME:host};
  const paused=await runResourceGuard(env,now,fake as typeof fetch);assert.equal(paused.state.reason,'spike');assert.equal(current.enabled,true);assert.equal(writes.length,1);
  metrics={...healthy};await runResourceGuard(env,now+300_000,fake as typeof fetch);assert.equal(writes.length,1);
  await runResourceGuard(env,paused.state.until,fake as typeof fetch);assert.equal(current.enabled,false);assert.equal(writes.length,2);assert.equal(other.enabled,false);
  const before=current;metrics.daily=NaN;
  await assert.rejects(runResourceGuard(env,paused.state.until+300_000,fake as typeof fetch),/Invalid resource usage/);assert.equal(current,before);assert.equal(writes.length,2);
});

test('a stale scheduled response cannot resume a newer pause',async()=>{
  let reads=0,writes=0;
  const previous=rule({...openGuard,reason:'spike',until:now-1,strikes:1,last_pause:now-900_000});
  const fresh=rule({...openGuard,reason:'budget',until:now+3_600_000});fresh.version='2';
  const fake=async(url:any,init:any={})=>{
    if(new URL(url).pathname.includes('/analytics/sql'))return Response.json({data:[JSON.parse(init.body).query.includes('TODAY()')?{value:10}:{recent:0,previous:0}]});
    if(init.method==='PATCH')writes++;
    return Response.json({success:true,result:{id:'ruleset',rules:[++reads===1?previous:fresh]}});
  };
  const result=await runResourceGuard({RESOURCE_GUARD_TOKEN:'synthetic',GUARD_ACCOUNT_ID:account,GUARD_ZONE_ID:zone,GUARD_HOSTNAME:host},now,fake as typeof fetch);
  assert.equal(result.changed,false);assert.equal(writes,0);
});

test('CI configures native alerts idempotently, preserves cooldowns and unrelated policies, and verifies failures',async()=>{
  let ruleset:any=null,policies:any[]=[{id:'unrelated',name:'Unrelated alert'}],writes=0;
  const fake=async(url:any,init:any={})=>{
    const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):undefined;
    if(path.includes('/analytics/sql'))return Response.json({data:[{value:5}]});
    if(path.includes('/rulesets')){
      if(!ruleset&&init.method==='GET')return Response.json({success:false,errors:[{code:10003}]},{status:404});
      if(body){writes++;ruleset={id:'ruleset',rules:body.rules??ruleset.rules};}
      return Response.json({success:true,result:ruleset});
    }
    if(body){writes++;if(init.method==='PUT')policies=policies.map(p=>path.endsWith('/'+p.id)?{...body,id:p.id}:p);else policies.push({...body,id:String(policies.length)});}
    const result=path.endsWith('/policies')?policies:policies.find(p=>path.endsWith('/'+p.id));
    return Response.json({success:true,result:body&&init.method==='POST'?{id:policies.at(-1).id}:result});
  };
  const env={CLOUDFLARE_ACCOUNT_ID:account,ZONE_ID:zone,DOMAIN:host,CLOUDFLARE_API_TOKEN:'synthetic',RESOURCE_ALERT_EMAIL:'owner@example.test'};
  await configureResourceGuard(env,{fetcher:fake as typeof fetch});assert.equal(writes,4);assert.equal(policies.length,4);
  const paused=nextGuardState(openGuard,spike,now);Object.assign(ruleset.rules[0],rule(paused));
  const result=await configureResourceGuard(env,{fetcher:fake as typeof fetch});assert.equal(result.paused,true);assert.equal(writes,4);
  await configureResourceGuard(env,{fetcher:fake as typeof fetch,verifyOnly:true});assert.equal(writes,4);
  policies[1].enabled=false;await assert.rejects(configureResourceGuard(env,{fetcher:fake as typeof fetch,verifyOnly:true}),/Resource alert readback/);
  await configureResourceGuard(env,{fetcher:fake as typeof fetch});assert.equal(policies[1].enabled,true);assert.equal(writes,5);assert.equal(policies[0].name,'Unrelated alert');
});
