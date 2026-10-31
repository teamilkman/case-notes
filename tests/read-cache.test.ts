import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReadCache,withSignal} from '../public/read-cache.js';

test('prefetch and visible view share one read, then switches reuse completed data',async()=>{
  const cache=createReadCache(),entry=cache.entry('month');let reads=0,finish:any;
  const load=()=>{reads++;return new Promise(resolve=>{finish=resolve;});};
  const background=entry.ensure(load),visible=cache.entry('month').ensure(load);
  await Promise.resolve();assert.equal(reads,1);assert.equal(entry.loading,true);
  finish({items:['schedule']});await Promise.all([background,visible]);
  assert.equal(entry.loading,false);assert.equal(entry.loaded,true);
  assert.deepEqual(await entry.ensure(load),{items:['schedule']});assert.equal(reads,1);
});

test('invalidation rejects stale cache population while a fresh read is underway',async()=>{
  const cache=createReadCache(),entry=cache.entry('case');let oldFinish:any,newFinish:any;
  const old=entry.ensure(()=>new Promise(resolve=>{oldFinish=resolve;}));await Promise.resolve();
  cache.invalidate();const fresh=entry.ensure(()=>new Promise(resolve=>{newFinish=resolve;}));await Promise.resolve();
  oldFinish('stale');await old;assert.equal(entry.loaded,false);assert.equal(entry.loading,true);
  newFinish('fresh');await fresh;assert.equal(entry.data,'fresh');assert.equal(entry.loading,false);
});

test('aborting one subscriber leaves the shared request available to another',async()=>{
  const entry=createReadCache().entry('list'),controller=new AbortController();let finish:any;
  const request=entry.ensure(()=>new Promise(resolve=>{finish=resolve;}));
  const cancelled=withSignal(request,controller.signal),visible=withSignal(request);controller.abort();
  await assert.rejects(cancelled,(e:any)=>e.name==='AbortError');finish('ok');assert.equal(await visible,'ok');assert.equal(entry.loaded,true);
});

test('failed prefetch remains a real error and explicit retry can populate empty results',async()=>{
  const entry=createReadCache().entry('month');
  await assert.rejects(entry.ensure(async()=>{throw new Error('offline');}));assert.equal(entry.error,'offline');assert.equal(entry.loaded,false);assert.equal(entry.loading,false);
  const data=await entry.ensure(async()=>({items:[]}));assert.deepEqual(data,{items:[]});assert.equal(entry.loaded,true);assert.equal(entry.error,'');
});

test('a committed note can prime the cache without a stale pending read replacing it',async()=>{
  const entry=createReadCache().entry('note');let finish:any;
  const pending=entry.ensure(()=>new Promise(resolve=>{finish=resolve;}));await Promise.resolve();
  entry.prime({revision:2});finish({revision:1});await pending;
  assert.deepEqual(entry.data,{revision:2});assert.deepEqual(await entry.ensure(async()=>({revision:0})),{revision:2});
});

test('bounded memory evicts old completed queries without evicting active prefetch',async()=>{
  const cache=createReadCache(undefined,2);let finish:any;
  const first=cache.entry('active'),pending=first.ensure(()=>new Promise(resolve=>{finish=resolve;}));await Promise.resolve();
  const old=cache.entry('old');await old.ensure(async()=>1);await cache.entry('new').ensure(async()=>2);
  assert.equal(cache.entry('active'),first);assert.notEqual(cache.entry('old'),old);
  finish(3);await pending;assert.equal(first.data,3);
});

test('a second consumer waits for a refreshing stale copy instead of completing with the preview',async()=>{
  const persistence:any={read:async()=>({hit:false,stale:{items:['old']},token:{scope:'a',epoch:1}}),write:async()=>{}};
  const entry=createReadCache(undefined,128,persistence).entry('todos');let finish:any,loads=0;
  const first=entry.ensure(()=>{loads++;return new Promise(resolve=>{finish=resolve;});});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(entry.data,{items:['old']});assert.equal(entry.loading,true);
  const second=entry.ensure(async()=>assert.fail('a second read was started'));assert.equal(first,second);
  let completed=false;void second.then(()=>{completed=true;});await Promise.resolve();assert.equal(completed,false);
  finish({items:[]});assert.deepEqual(await second,{items:[]});assert.equal(loads,1);
});
