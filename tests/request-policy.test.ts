import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequestPolicy} from '../public/request-policy.js';

test('Retry-After shares cooldown across requests and cannot be cleared by late success',()=>{
  let clock=0;const p=createRequestPolicy({now:()=>clock});
  p.limit(new Response('',{headers:{'Retry-After':'90'}}));p.success();
  assert.throws(()=>p.check(),(e:any)=>e.retryAfter===90&&e.commitState==='not_committed');
  clock=89_999;assert.equal(p.retryAfter(),1);clock=90_000;p.check();
  p.limit(new Response('',{headers:{'Retry-After':new Date(clock+120_000).toUTCString()}}));assert.equal(p.retryAfter(),120);
});

test('three consecutive transport failures open a circuit and only explicit later actions can retry',()=>{
  let clock=0;const p=createRequestPolicy({now:()=>clock});
  p.failure();assert.equal(p.retryAfter(),1);clock+=1000;p.check();
  p.failure();assert.equal(p.retryAfter(),2);clock+=2000;p.check();
  p.failure();assert.equal(p.retryAfter(),60);clock+=60_000;p.check();p.success();p.failure();assert.equal(p.retryAfter(),1);
});

function loginHarness(fetcher:typeof fetch){
  let clock=0,submit:any;const waits:number[]=[],attrs=new Map(),label={textContent:''};
  const elements:any={pwd:{value:'synthetic-password',type:'password',setAttribute:(k:string,v:string)=>attrs.set(k,v),removeAttribute:(k:string)=>attrs.delete(k),focus(){},select(){},addEventListener(){}},btn:{disabled:false,setAttribute(){},removeAttribute(){},querySelector:()=>label},err:{textContent:''},'login-form':{addEventListener:(_n:string,fn:any)=>{submit=fn;}},'toggle-password':{addEventListener(){}}};
  const policy=createRequestPolicy({now:()=>clock});
  runInNewContext(readFileSync('public/login.js','utf8').replace(/^import.*$/gm,''),{requestPolicy:policy,appLocation:()=> '/',fetch:fetcher,document:{getElementById:(id:string)=>elements[id]},location:{hash:'',replace(){}},Math:Object.assign(Object.create(Math),{random:()=>0}),setTimeout:(fn:any,ms:number)=>{waits.push(ms);clock+=ms;fn();}});
  return {submit:()=>submit({preventDefault(){}}),waits,elements,attrs,policy};
}

test('login makes at most three network attempts with backoff, then blocks immediate resubmission',async()=>{
  let calls=0;const h=loginHarness(async()=>{calls++;throw new Error('synthetic offline');});
  await h.submit();assert.equal(calls,3);assert.deepEqual(h.waits,[1000,2000]);assert.equal(h.elements.btn.disabled,false);
  await h.submit();assert.equal(calls,3);assert.match(h.elements.err.textContent,/60 秒/);
});

test('login never automatically retries authentication denial, unsupported methods, throttling, or server errors',async()=>{
  for(const status of [401,403,405,429,503]){
    let calls=0;const h=loginHarness(async()=>{calls++;return Response.json({ok:false,error:{message:'synthetic rejection'}},{status,headers:{'Retry-After':'120'}});});
    await h.submit();assert.equal(calls,1);assert.equal(h.waits.length,0);
    if(status===429){await h.submit();assert.equal(calls,1);assert.match(h.elements.err.textContent,/120 秒/);}
    if(status===401)assert.equal(h.attrs.get('aria-invalid'),'true');
  }
});
