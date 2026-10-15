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
