import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignOrder } from '../src/ordering';

test('sparse ordering handles arbitrary moves, insertions and exhausted gaps without changing row identities',()=>{
  let seed=17;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let iteration=0;iteration<200;iteration++){
    const rows=Array.from({length:20},(_,n)=>({id:'row_'+n,sort_order:n+1,before:{sort_order:n+1}}));
    for(let n=rows.length-1;n>0;n--){const j=Math.floor(random()*(n+1));[rows[n],rows[j]]=[rows[j],rows[n]];}
    rows.splice(Math.floor(random()*rows.length),0,{id:'new',sort_order:0,before:undefined as any});
    const ids=rows.map(r=>r.id);assignOrder(rows);
    assert.deepEqual(rows.map(r=>r.id),ids);assert.ok(rows.every((r,n)=>Number.isSafeInteger(r.sort_order)&&r.sort_order>0&&(n===0||r.sort_order>rows[n-1].sort_order)));
  }
});
