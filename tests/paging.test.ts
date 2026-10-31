import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPager} from '../public/paging.js';

test('page loader ignores stale filter responses and avoids duplicate in-flight requests',async()=>{
  const pending:any[]=[];
  const feed=createPager((args:any)=>new Promise(resolve=>pending.push({args,resolve})));
  const old=feed.reset({query:'old'});feed.load();assert.equal(pending.length,1);
  const fresh=feed.reset({query:'new'});assert.equal(pending.length,2);
  pending[1].resolve({items:[{id:'new'}],matched_count:1,has_more:false,next_cursor:null});await fresh;
  pending[0].resolve({items:[{id:'old'}],matched_count:1,has_more:false,next_cursor:null});await old;
  assert.deepEqual(feed.items,[{id:'new'}]);assert.equal(feed.loading,false);
});

test('failed next page retains cursor and retries without losing or duplicating rows',async()=>{
  let n=0;const seen:any[]=[];
  const feed=createPager(async(args:any)=>{seen.push(args);n++;if(n===2)throw new Error('offline');return n===1?{items:[{id:'a'}],matched_count:2,has_more:true,next_cursor:'next'}:{items:[{id:'a'},{id:'b'}],matched_count:2,has_more:false,next_cursor:null};});
  await feed.reset({query:'same'});await feed.load();assert.equal(feed.cursor,'next');assert.equal(feed.items.length,1);assert.equal(feed.error,'offline');
  await feed.load();assert.deepEqual(feed.items.map(x=>x.id),['a','b']);assert.deepEqual(seen[1],seen[2]);assert.equal(feed.hasMore,false);
});

test('a cached first page is a preview: fresh rows replace it and its cursor never skips the server first page',async()=>{
  const calls:any[]=[];let finish:any;
  const pager=createPager(args=>{calls.push(args);return calls.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({items:[{id:'tail'}],matched_count:2,has_more:false,next_cursor:null});},undefined,
    async()=>({items:[{id:'completed-on-desktop'},{id:'keep',version:1}],matched_count:3,has_more:true,next_cursor:'old-cursor'}));
  const loading=pager.reset({group:'todo'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(pager.items.map(x=>x.id),['completed-on-desktop','keep']);assert.equal(pager.loading,true);
  assert.equal(calls[0].cursor,undefined);
  finish({items:[{id:'keep',version:2}],matched_count:2,has_more:true,next_cursor:'fresh-cursor'});await loading;
  assert.deepEqual(pager.items,[{id:'keep',version:2}]);
  await pager.load();assert.equal(calls[1].cursor,'fresh-cursor');assert.deepEqual(pager.items.map(x=>x.id),['keep','tail']);
});

test('a failed first-page refresh keeps its cached rows and can retry to a genuinely empty result',async()=>{
  let fail=true;const calls:any[]=[];
  const pager=createPager(async args=>{calls.push(args);if(fail)throw Error('offline');return {items:[],matched_count:0,has_more:false,next_cursor:null};},undefined,
    async()=>({items:[{id:'completed'}],matched_count:1,has_more:false,next_cursor:'stale-cursor'}));
  await pager.reset();assert.equal(pager.items.length,1);assert.equal(pager.error,'offline');
  fail=false;await pager.load();assert.deepEqual(pager.items,[]);assert.equal(pager.total,0);assert.equal(pager.error,'');
  assert.ok(calls.every(a=>a.cursor===undefined));
});
