import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function shell(failEssential=false){
  const handlers:Record<string,(event:any)=>void>={},rows=new Map<string,Response>();
  const deleted:string[]=[];let skipped=0,claimed=0,network=0;
  const cache={
    async addAll(requests:Request[]){
      if(failEssential)throw new Error('interrupted install');
      for(const request of requests){const path=new URL(request.url).pathname;assert.ok(existsSync('public'+(path==='/'?'/index.html':path)),path);rows.set(path,new Response(path));}
    },
    async add(){throw new Error('optional icon unavailable');},
    async match(path:string){return rows.get(path)?.clone();},
  };
  runInNewContext(readFileSync('public/sw.js','utf8'),{
    self:{location:{origin:'https://synthetic.example'},addEventListener:(name:string,handler:any)=>{handlers[name]=handler;},skipWaiting:async()=>{skipped++;},clients:{claim:async()=>{claimed++;}}},
    caches:{open:async()=>cache,keys:async()=>['case-notes-shell-old','unrelated-cache'],delete:async(key:string)=>{deleted.push(key);}},
    Request:class extends Request{constructor(path:string,options:any){super('https://synthetic.example'+path,options);}},URL,
    fetch:async()=>{network++;throw new Error('offline');},
  });
  const lifecycle=(name:string)=>{let pending:Promise<any>|undefined;handlers[name]({waitUntil:(job:Promise<any>)=>{pending=job;}});return pending;};
  const read=(url:string,method='GET')=>{let pending:Promise<Response>|undefined;handlers.fetch({request:new Request(url,{method}),respondWith:(job:Promise<Response>)=>{pending=job;}});return pending;};
  return {lifecycle,read,deleted,get skipped(){return skipped;},get claimed(){return claimed;},get network(){return network;}};
}

test('offline shell cold starts ignore navigation query strings and optional icon failures',async()=>{
  const sw=shell();await sw.lifecycle('install');assert.equal(sw.skipped,1);
  await sw.lifecycle('activate');assert.equal(sw.claimed,1);assert.deepEqual(sw.deleted,['case-notes-shell-old']);
  for(const path of ['/?mobile=1','/index.html?launch=1','/legacy-app.js?v=1','/session-access.js']){
    const response=await sw.read('https://synthetic.example'+path);assert.ok(response?.ok,path);
  }
  assert.equal(sw.network,0);
});

test('incomplete essential shells cannot activate; private or unrelated requests never enter shell storage',async()=>{
  const failed=shell(true);await assert.rejects(failed.lifecycle('install')!,/interrupted/);assert.equal(failed.skipped,0);
  const sw=shell();await sw.lifecycle('install');
  for(const path of ['/api/session','/api/web/stats','/oauth/authorize','/mcp','/health','/unknown'])assert.equal(sw.read('https://synthetic.example'+path),undefined,path);
  assert.equal(sw.read('https://other.example/'),undefined);
  assert.equal(sw.read('https://synthetic.example/api/web/save-notes','POST'),undefined);
});
