import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {createPersistentCache,type PersistentCache} from '../public/persistent-cache.js';
import {createReadCache,withSignal} from '../public/read-cache.js';
import {createSessionAccess} from '../public/session-access.js';
import Dexie from '../public/web/vendor/dexie.mjs';
import {createPager} from '../public/paging.js';

const session=(scope='session-a',expires=Date.now()+86400_000)=>({cache_scope:scope,expires_at:new Date(expires).toISOString()});
const options=()=>({name:'test-'+crypto.randomUUID(),dependencies:{indexedDB,IDBKeyRange}});
const networkError=()=>Object.assign(new Error('offline'),{code:'NETWORK_UNAVAILABLE'});
async function put(store:PersistentCache,key:string,data:any){const row=await store.read(key);assert.ok(row);await store.write(key,data,row.token);}

test('an isolated historical replica seeded without a token still displays content offline',async t=>{
  // Mirrors the Android offline fixture: a raw v3 database whose control row
  // carries no change token and an already expired session, plus one case copy.
  const config=options(),db=new Dexie(config.name,config.dependencies);
  db.version(1).stores({responses:'key,savedAt,retainUntil',control:'id'});
  db.version(2).stores({responses:'key,savedAt',control:'id'});await db.open();
  const doc={ref:'android-qa',revision:3,case:{id:'android-qa',name:'合成离线案件',kind:'case',status:'在办'},
    lines:[{line_id:'synthetic-line',text:'合成离线记录'}],text:'合成离线记录'};
  const bytes=new TextEncoder().encode(JSON.stringify(doc)).length,captured=Date.now()-8*86400000;
  await db.table('control').put({id:'active',scope:'synthetic-android-offline',expiresAt:Date.now()-86400000,epoch:1,bytes});
  await db.table('responses').put({key:'case:android-qa',data:doc,bytes,savedAt:captured,expiresAt:captured+300000});
  db.close();
  const state={offline:true};const store=createPersistentCache({...config,isOffline:()=>state.offline});t.after(()=>store.close());
  const access=createSessionAccess({persistence:store,state,verify:async()=>{throw networkError();}});
  await access.ensure();assert.equal(state.offline,true);
  const entry=createReadCache(undefined,128,store).entry('case:android-qa');
  assert.deepEqual(await entry.ensure(async()=>assert.fail('offline copy was not reused')),doc);
});

test('the shipped v2 cache migrates offline without deleting its source or reintroducing data after logout',async t=>{
  const config=options(),legacyName='legacy-'+crypto.randomUUID(),old=new Dexie(legacyName,config.dependencies);
  old.version(1).stores({responses:'key,savedAt,expiresAt',control:'id'});await old.open();
  const data={revision:9,lines:[{line_id:'one',text:'重复'},{line_id:'blank',text:''},{line_id:'two',text:'重复'}]};
  const bytes=new TextEncoder().encode(JSON.stringify(data)).length;
  await old.table('responses').put({key:'case:c',data,bytes,savedAt:1,expiresAt:2});
  await old.table('control').put({id:'active',scope:'old-owner',epoch:7,bytes});
  const store=createPersistentCache({...config,legacyName,isOffline:()=>true});t.after(()=>{old.close();store.close();});
  assert.equal((await store.resumeOffline())?.cache_scope,'old-owner');
  assert.deepEqual((await store.read('case:c'))?.data,data);assert.equal((await store.read('case:c'))?.token.epoch,7);
  assert.deepEqual((await old.table('responses').get('case:c')).data,data);
  await store.invalidate('case:c');await store.resumeOffline();assert.equal((await store.read('case:c'))?.hit,false);
  await store.clear();assert.equal(await old.table('responses').count(),0);assert.equal((await old.table('control').get('active')).scope,null);
  const reopened=createPersistentCache({...config,legacyName,isOffline:()=>true});t.after(()=>reopened.close());
  assert.equal(await reopened.resumeOffline(),null);
});

test('migration cannot replace an existing target identity or carry old copies into a new cloud session',async t=>{
  const config=options(),legacyName='legacy-'+crypto.randomUUID(),old=new Dexie(legacyName,config.dependencies);
  old.version(1).stores({responses:'key,savedAt,expiresAt',control:'id'});await old.open();
  await old.table('control').put({id:'active',scope:'old',epoch:3,bytes:5});await old.table('responses').put({key:'q',data:'old',bytes:5,savedAt:1,expiresAt:2});
  const store=createPersistentCache({...config,legacyName});t.after(()=>{old.close();store.close();});
  await store.activate({...session('new'),change_token:'v1'});assert.equal((await store.read('q'))?.hit,false);
  await put(store,'q','new');await store.resumeOffline();assert.equal((await store.read('q'))?.data,'new');
  assert.equal((await old.table('responses').get('q')).data,'old');
});

test('offline copies remain accessible after cloud session expiry and repeated validation attempts',async t=>{
  let clock=1000,offline=false;const config={...options(),now:()=>clock,isOffline:()=>offline};
  const first=createPersistentCache(config);t.after(()=>first.close());await first.activate(session('a',5000));await put(first,'note',{revision:2});first.close();
  const restored=createPersistentCache(config);t.after(()=>restored.close());clock=1500;
  assert.equal(await restored.read('note'),null); // no session authorization yet
  const state={offline:false};let validations=0;const access=createSessionAccess({verify:async()=>{validations++;throw networkError();},persistence:restored,state,now:()=>clock});
  offline=true;await access.ensure();assert.equal(state.offline,true);
  assert.deepEqual((await restored.read('note'))?.data,{revision:2});
  await restored.write('new','forbidden',(await restored.read('new'))?.token);assert.equal((await restored.read('new'))?.hit,false);
  clock=4000;assert.equal((await restored.read('note'))?.hit,true);
  clock=5000;assert.equal((await restored.resumeOffline())?.cache_scope,'a');assert.equal((await restored.read('note'))?.hit,true);
  clock=100000;await access.ensure();assert.equal(validations,1);assert.deepEqual((await restored.read('note'))?.data,{revision:2});
});

test('cloud authentication rejection preserves expired local copies and stays offline until an explicit login',async t=>{
  let clock=1000;const state={offline:false,authRequired:false};const store=createPersistentCache({...options(),now:()=>clock,isOffline:()=>state.offline});
  t.after(()=>store.close());await store.activate(session('a',2000));await put(store,'q','local');clock=3000;
  let attempts=0,cleared=0;
  const access=createSessionAccess({persistence:store,state,now:()=>clock,verify:async()=>{attempts++;throw Object.assign(new Error('login required'),{status:401});},onUnauthorized:()=>{cleared++;}});
  await access.ensure();assert.equal(state.offline,true);assert.equal(state.authRequired,true);assert.equal(cleared,0);
  assert.equal((await store.read('q'))?.data,'local');await access.ensure();assert.equal(attempts,1);
  await access.ensure(true);assert.equal(attempts,2);assert.equal((await store.read('q'))?.data,'local');
  await store.clear();assert.equal(await store.resumeOffline(),null);
});

test('authentication rejection without any local owner still requires login and cannot hydrate private data',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());let closed=0;
  const access=createSessionAccess({persistence:store,state:{offline:false},verify:async()=>{throw Object.assign(new Error('login required'),{status:401});},onUnauthorized:()=>{closed++;}});
  await assert.rejects(access.ensure(),/没有已验证/);assert.equal(closed,1);
});

test('network fallback preserves stale copies without extending online freshness; server errors cannot fall back',async t=>{
  let clock=1000;const state={offline:false};const store=createPersistentCache({...options(),now:()=>clock,isOffline:()=>state.offline});
  t.after(()=>store.close());await store.activate(session('a',5000));await put(store,'q','local');clock=1200;
  const entry=createReadCache(undefined,128,store).entry('q');
  await assert.rejects(entry.ensure(async()=>{throw Object.assign(new Error('server failure'),{code:'DAILY_LIMIT_EXCEEDED'});}));
  assert.equal(await entry.ensure(async()=>{state.offline=true;throw networkError();}),'local');
  await store.flush();clock=2000;assert.equal((await store.read('q'))?.hit,true);
  state.offline=false;assert.equal((await store.read('q'))?.hit,false);
});

test('removing time-based retention preserves existing expired copies, session identity and generation on upgrade',async t=>{
  const config=options(),old=new Dexie(config.name,config.dependencies);
  old.version(1).stores({responses:'key,savedAt,retainUntil',control:'id'});
  await old.open();const expiry=Date.now()+30*86400_000;
  await old.table('control').put({id:'active',scope:'a',expiresAt:expiry,epoch:8,bytes:5});
  await old.table('responses').put({key:'q',data:'old',bytes:5,savedAt:1,expiresAt:2,retainUntil:3});old.close();
  const upgraded=createPersistentCache({...config,isOffline:()=>true});t.after(()=>upgraded.close());
  assert.equal((await upgraded.resumeOffline())?.cache_scope,'a');
  assert.equal((await upgraded.read('q'))?.data,'old');assert.equal((await upgraded.read('q'))?.token.epoch,8);
  await upgraded.invalidate('q');assert.equal((await upgraded.read('q'))?.hit,false);
});

test('offline authorization refuses unverified storage, revoked sessions, switched tabs and storage failure markers',async t=>{
  const config=options(),a=createPersistentCache(config),b=createPersistentCache(config);t.after(()=>{a.close();b.close();});
  assert.equal(await a.resumeOffline(),null);await a.activate(session('a'));await put(a,'q','private');
  await b.activate(session('b'));assert.equal(await a.resumeOffline(),null);
  await b.clear();assert.equal(await b.resumeOffline(),null);
  const state={offline:false};let reads=0;
  const access=createSessionAccess({persistence:b,state,verify:async()=>{throw Object.assign(new Error('unauthorized'),{code:'UNAUTHENTICATED'});}});
  b.resumeOffline=async()=>{reads++;return session();};
  await assert.rejects(access.ensure(),/unauthorized/);assert.equal(reads,0);assert.equal(state.offline,false);
});

test('reconnection shares validation, refreshes only after verification and fences a late verification after logout',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());await store.activate(session());
  const state={offline:true};let calls=0,refreshes=0,finish:any;
  const access=createSessionAccess({persistence:store,state,verify:()=>{calls++;return new Promise(resolve=>{finish=resolve;});},onVerified:()=>refreshes++});
  const first=access.ensure(true);assert.equal(first,access.ensure(true));assert.equal(refreshes,0);
  finish({...session(),source:'web'});await first;assert.equal(state.offline,false);assert.equal(calls,1);assert.equal(refreshes,1);
  const late=access.ensure(true);access.close();await store.clear();finish({...session(),source:'web'});
  await assert.rejects(late,/会话已结束/);assert.equal(await store.resumeOffline(),null);assert.equal(refreshes,1);
});

test('fresh page hydrates JSON replicas with original blanks, duplicates, identities and empty pages',async t=>{
  const config=options(),first=createPersistentCache(config);t.after(()=>first.close());await first.activate({...session(),change_token:'v1'});
  const payload={ref:'c',revision:7,lines:[{line_id:'a',text:'重复'},{line_id:'b',text:'重复'},{line_id:'blank',text:''}]};
  await put(first,'case:c',payload);await put(first,'empty',{items:[],has_more:false});
  first.close();const second=createPersistentCache(config);t.after(()=>second.close());await second.activate({...session(),change_token:'v1'});
  const cache=createReadCache(undefined,128,second);let loads=0;
  assert.deepEqual(await cache.entry('case:c').ensure(async()=>{loads++;return null;}),payload);
  assert.deepEqual(await cache.entry('empty').ensure(async()=>{loads++;return null;}),{items:[],has_more:false});
  assert.equal(loads,0);
});

test('a replica without a verified token is never reused online and reloads from the server',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());await store.activate(session());
  await put(store,'q','original');
  assert.equal((await store.read('q'))?.hit,false);
  let calls=0;
  assert.equal(await createReadCache(undefined,128,store).entry('q').ensure(async()=>{calls++;return 'fresh';}),'fresh');
  await store.flush();assert.equal(calls,1);
  assert.equal((await store.read('q'))?.hit,false); // an unverifiable replica is never served as current
});

test('session expiry blocks replicas and a different session clears all previous responses',async t=>{
  let clock=1000;const config={...options(),now:()=>clock};const a=createPersistentCache(config),b=createPersistentCache(config);
  t.after(()=>{a.close();b.close();});await a.activate(session('a',1200));await put(a,'private','secret');
  const old=(await a.read('private'))!;clock=1200;assert.equal(await a.read('private'),null);
  await b.activate(session('b',5000));assert.equal((await b.read('private'))?.hit,false);
  await a.write('private','old response',old.token);assert.equal((await b.read('private'))?.hit,false);
});

test('transaction generations reject a late read from another tab after a write invalidation',async t=>{
  const config=options(),a=createPersistentCache(config),b=createPersistentCache(config);t.after(()=>{a.close();b.close();});
  await a.activate({...session(),change_token:'v1'});await b.activate({...session(),change_token:'v1'});await put(a,'query','old');await put(a,'case:c','old note');
  const late=(await a.read('query'))!;await b.invalidate();await put(b,'case:c','saved note');
  await a.write('query','late query',late.token);await a.write('case:c','late note',late.token);
  assert.equal((await b.read('query'))?.hit,false);assert.equal((await b.read('case:c'))?.data,'saved note');
});

test('per-case conflict invalidation keeps unrelated queries but fences pending writes',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());await store.activate({...session(),change_token:'v1'});
  await put(store,'list','kept');await put(store,'case:c','conflict');const late=(await store.read('case:c'))!;
  await store.invalidate('case:c');await store.write('case:c','stale',late.token);
  assert.equal((await store.read('case:c'))?.hit,false);assert.equal((await store.read('list'))?.data,'kept');
});

test('logout fences queued writes, purges replicas and allows a clean subsequent login',async t=>{
  const config=options(),a=createPersistentCache(config),b=createPersistentCache(config);t.after(()=>{a.close();b.close();});
  await a.activate(session());await b.activate(session());await put(a,'q','private');const late=(await b.read('q'))!;
  await a.clear();await b.write('q','late private',late.token);assert.equal(await b.read('q'),null);
  await a.activate(session('next'));assert.equal((await a.read('q'))?.hit,false);
});

test('capacity evicts oldest responses, accounts for overwrites and skips oversized entries',async t=>{
  let clock=1000;const store=createPersistentCache({...options(),now:()=>clock,maxEntries:2,maxBytes:20,maxEntryBytes:12});
  t.after(()=>store.close());await store.activate({...session('a',10000),change_token:'v1'});
  await put(store,'a','12345678');clock++;await put(store,'b','12345678');clock++;await put(store,'c','x');
  assert.equal((await store.read('a'))?.hit,false);assert.equal((await store.read('b'))?.hit,true);
  clock++;await put(store,'b','y');clock++;await put(store,'d','12345678');
  assert.equal((await store.read('c'))?.hit,false);assert.equal((await store.read('b'))?.data,'y');
  await put(store,'too-large','1234567890123');assert.equal((await store.read('too-large'))?.hit,false);
  assert.equal((await store.read('d'))?.data,'12345678');
});

test('shared network requests and primed receipts remain correct while persistence is active',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());await store.activate({...session(),change_token:'v1'});
  const cache=createReadCache(undefined,128,store),entry=cache.entry('case:c');let finish:any,started:any,calls=0;
  const ready=new Promise(resolve=>{started=resolve;});
  const load=()=>{calls++;started();return new Promise(resolve=>{finish=resolve;});};
  const request=entry.ensure(load),controller=new AbortController(),cancelled=withSignal(entry.ensure(load),controller.signal);
  controller.abort();await assert.rejects(cancelled,(e:any)=>e.name==='AbortError');await ready;assert.equal(calls,1);
  cache.invalidate();entry.prime({revision:2});finish({revision:1});await request;
  // Priming schedules a read and then a write without delaying the save feedback.
  await store.flush();await store.flush();
  assert.deepEqual(entry.data,{revision:2});assert.deepEqual((await store.read('case:c'))?.data,{revision:2});
});

test('storage failures fall back to shared network reads and do not turn a receipt into an error',async t=>{
  const broken={open(){throw new Error('storage denied');}} as unknown as IDBFactory;
  const store=createPersistentCache({...options(),dependencies:{indexedDB:broken,IDBKeyRange}});t.after(()=>store.close());
  await store.activate(session());const entry=createReadCache(undefined,128,store).entry('q');let calls=0;
  assert.deepEqual(await entry.ensure(async()=>{calls++;return {items:[]};}),{items:[]});
  assert.deepEqual(await entry.ensure(async()=>assert.fail('memory miss')),{items:[]});assert.equal(calls,1);
  await store.invalidate();assert.equal(await store.read('q'),null);
});

test('UTF-8 byte budget bounds retained replicas independently of entry count',async t=>{
  let clock=1000;const store=createPersistentCache({...options(),now:()=>clock,maxEntries:100,maxBytes:17});
  t.after(()=>store.close());await store.activate({...session('a',10000),change_token:'v1'});
  await put(store,'a','中文');clock++;await put(store,'b','中文');clock++;await put(store,'c','中文');
  assert.equal((await store.read('a'))?.hit,false);assert.equal((await store.read('b'))?.hit,true);assert.equal((await store.read('c'))?.hit,true);
  clock++;await put(store,'fresh','中文');   // 24 bytes: the oldest copy is evicted
  assert.equal((await store.read('b'))?.hit,false);assert.equal((await store.read('c'))?.hit,true);assert.equal((await store.read('fresh'))?.hit,true);
  clock++;await put(store,'d','中文');       // evicts the next oldest, never the newest
  assert.equal((await store.read('c'))?.hit,false);assert.equal((await store.read('fresh'))?.hit,true);assert.equal((await store.read('d'))?.hit,true);
});

test('storage failure marker forces cleanup on recovery rather than reusing a potentially stale replica',async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map<string,string>();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,
    setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete (globalThis as any).localStorage;});
  const config=options(),good=createPersistentCache(config);t.after(()=>good.close());await good.activate(session());await put(good,'q','old');
  const late=(await good.read('q'))!;
  const broken=createPersistentCache({...config,dependencies:{indexedDB:{open(){throw new Error('denied');}} as any,IDBKeyRange}});
  t.after(()=>broken.close());await broken.activate(session());assert.equal(values.size,1);
  const recovered=createPersistentCache(config);t.after(()=>recovered.close());assert.equal(await recovered.resumeOffline(),null);await recovered.activate(session());
  assert.equal(values.size,0);assert.equal((await recovered.read('q'))?.hit,false);
  await good.write('q','late stale',late.token);assert.equal((await recovered.read('q'))?.hit,false);
});

test('a verified workspace token keeps replicas current across page loads',async t=>{
  let clock=1000;const config={...options(),now:()=>clock};
  const first=createPersistentCache(config);t.after(()=>first.close());
  await first.activate({...session('a',300000),change_token:'2:1:1:1'});await put(first,'q','current');
  clock=100000; // a later page load while the session is still valid
  const second=createPersistentCache(config);t.after(()=>second.close());
  await second.activate({...session('a',300000),change_token:'2:1:1:1'});
  let loads=0;
  assert.equal(await createReadCache(undefined,128,second).entry('q').ensure(async()=>{loads++;return 'network';}),'current');
  assert.equal(loads,0);
});

test('a changed workspace token revalidates replicas while keeping them readable offline',async t=>{
  let clock=1000,offline=false;const config={...options(),now:()=>clock,isOffline:()=>offline};
  const store=createPersistentCache(config);t.after(()=>store.close());
  await store.activate({...session('a',300000),change_token:'2:1:1:1'});await put(store,'q','stale');
  clock=2000;await store.activate({...session('a',300000),change_token:'2:2:2:1'});
  assert.equal((await store.read('q'))?.hit,false);          // the server proved the copy changed
  offline=true;assert.equal((await store.read('q'))?.data,'stale'); // and it is still kept for offline reading
  offline=false;
  let loads=0;const cache=createReadCache(undefined,128,store);
  assert.equal(await cache.entry('q').ensure(async()=>{loads++;return 'fresh';}),'fresh');
  assert.equal(loads,1);await store.flush();assert.equal((await store.read('q'))?.hit,true);
});

test('a verified token change fences a late write made under the previous token',async t=>{
  const config=options(),a=createPersistentCache(config),b=createPersistentCache(config);t.after(()=>{a.close();b.close();});
  await a.activate({...session('a'),change_token:'v1'});await b.activate({...session('a'),change_token:'v1'});
  const late=(await a.read('q'))!;
  await b.activate({...session('a'),change_token:'v2'});
  await a.write('q','late',late.token);
  assert.equal((await b.read('q'))?.hit,false);
  assert.equal((await a.read('q'))?.hit,false); // the fenced write stored nothing
});

test('online foreground verification invalidates memory only when the workspace changes and removes completed cached TODOs',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());let token='v1',refreshes=0,loads=0;
  await store.activate({...session(),change_token:token});
  await put(store,'todos',{items:[{id:'completed-on-other-device'}],matched_count:1,has_more:false,next_cursor:null});
  const state={offline:false},access=createSessionAccess({persistence:store,state,
    verify:async()=>({...session(),source:'web',change_token:token}),onVerified:()=>{refreshes++;cache.invalidate(false);}});
  const cache=createReadCache(undefined,128,store,()=>access.ensure());
  const read=()=>cache.entry('todos').ensure(async()=>{loads++;return {items:[],matched_count:0,has_more:false,next_cursor:null};});
  await access.ensure();await read();assert.equal(loads,0);assert.equal(refreshes,0);
  token='v2';await access.ensure(true);assert.equal(refreshes,1);assert.equal(state.offline,false);
  const pager=createPager(read,undefined,async()=>{const r=await store.read('todos');return r?.hit?r.data:r?.stale;});
  await pager.reset();assert.deepEqual(pager.items,[]);assert.equal(loads,1);
  await access.ensure(true);await read();assert.equal(refreshes,1);assert.equal(loads,1);
});

test('a cache hit is rechecked after session validation before it can finish as current',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());await store.activate({...session(),change_token:'v1'});await put(store,'q','old');
  let verified=false,loads=0;
  const entry=createReadCache(undefined,128,store,async()=>{await store.activate({...session(),change_token:'v2'});verified=true;}).entry('q');
  assert.equal(await entry.ensure(async()=>{assert.equal(verified,true);loads++;return 'fresh';}),'fresh');
  assert.equal(loads,1);await store.flush();assert.equal((await store.read('q'))?.data,'fresh');
});

test('manual revalidation keeps offline copies, fences old responses and refreshes even with an unchanged workspace token',async t=>{
  const state={offline:false},store=createPersistentCache({...options(),isOffline:()=>state.offline});t.after(()=>store.close());
  await store.activate({...session(),change_token:'v1'});await put(store,'q','old');const old=(await store.read('q'))!;
  await store.revalidate();assert.equal((await store.read('q'))?.hit,false);assert.equal((await store.read('q'))?.stale,'old');
  await store.write('q','late',old.token);state.offline=true;assert.equal((await store.read('q'))?.data,'old');state.offline=false;
  const cache=createReadCache(undefined,128,store);
  assert.equal(await cache.entry('q').ensure(async()=>{throw networkError();}),'old');
  assert.equal((await store.read('q'))?.hit,false);cache.invalidate(false);
  assert.equal(await cache.entry('q').ensure(async()=>'fresh'),'fresh');await store.flush();assert.equal((await store.read('q'))?.hit,true);
});

test('a late network result cannot borrow a newer persistence token to mark old data fresh',async t=>{
  const config=options(),a=createPersistentCache(config),b=createPersistentCache(config);t.after(()=>{a.close();b.close();});
  await a.activate({...session(),change_token:'v1'});await b.activate({...session(),change_token:'v1'});let finish:any;
  const job=createReadCache(undefined,128,a).entry('q').ensure(()=>new Promise(resolve=>{finish=resolve;}));
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  await b.activate({...session(),change_token:'v2'});finish('late-v1');await job;await a.flush();
  assert.equal((await b.read('q'))?.hit,false);assert.equal((await b.read('q'))?.stale,undefined);
});

test('a session response without a workspace token cannot preserve an old proof of freshness',async t=>{
  const store=createPersistentCache(options());t.after(()=>store.close());await store.activate({...session(),change_token:'v1'});await put(store,'q','old');
  await store.activate(session());assert.equal((await store.read('q'))?.hit,false);assert.equal((await store.read('q'))?.stale,'old');
});
