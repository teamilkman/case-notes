import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migrateSessionStorage,clearSessionStorage} from '../public/storage-upgrade.js';
function storage(){const data:Record<string,string>={};return {get length(){return Object.keys(data).length;},key:(i:number)=>Object.keys(data)[i]??null,
  getItem:(k:string)=>data[k]??null,setItem:(k:string,v:string)=>{data[k]=v;},removeItem:(k:string)=>{delete data[k];}};}
test('historical draft identities, base revisions and uncertain request keys migrate verbatim and only once',()=>{
  const s=storage(),draft=JSON.stringify({format:1,revision:7,rows:[{line_id:'stable',text:'重复\n原文'}]}),pending=JSON.stringify({args:{request_key:'same-request',expected_document_revision:7}});
  s.setItem('ailog:draft:case',draft);s.setItem('ailog:pending:save:case',pending);s.setItem('unrelated','kept');
  migrateSessionStorage(s);migrateSessionStorage(s);
  assert.equal(s.getItem('case-notes:draft:case'),draft);assert.equal(s.getItem('case-notes:pending:save:case'),pending);assert.equal(s.getItem('ailog:draft:case'),null);
  clearSessionStorage(s);assert.equal(s.getItem('case-notes:draft:case'),null);assert.equal(s.getItem('unrelated'),'kept');
});
test('conflicting copies and failed storage writes cannot remove the historical draft',()=>{
  const s=storage();s.setItem('ailog:draft:case','old');s.setItem('case-notes:draft:case','new');migrateSessionStorage(s);
  assert.equal(s.getItem('ailog:draft:case'),'old');assert.equal(s.getItem('case-notes:draft:case'),'new');
  s.setItem('ailog:pending:save:case','uncertain');migrateSessionStorage({...s,setItem:()=>{throw new Error('quota');}});
  assert.equal(s.getItem('ailog:pending:save:case'),'uncertain');
});
