import Dexie from './web/vendor/dexie.mjs';

// Disposable JSON response replicas, never a second business database. A single
// active authenticated session owns this database. Transactions compare the
// persisted generation so another tab cannot resurrect invalidated responses.
// Freshness is verified against the server's workspace change token: a replica
// saved under the current token is current, anything else is a miss kept on disk
// for offline reading. No timer can serve an unverified replica.
export function createPersistentCache({name='case-notes-reads-v3',isOffline=()=>false,maxEntries=256,
  maxBytes=16*1024*1024,maxEntryBytes=2*1024*1024,now=Date.now,dependencies,
  legacyName=name==='case-notes-reads-v3'?'case-notes-reads-v2':null}={}){
  const db=new Dexie(name,dependencies);
  db.version(1).stores({responses:'key,savedAt,retainUntil',control:'id'});
  // Reuse controls online reads, never deletion of the only offline copy.
  // Keep existing rows when removing the old retention index.
  db.version(2).stores({responses:'key,savedAt',control:'id'});
  let scope=null,expiresAt=0,disabled=false,queue=Promise.resolve();
  const dirtyKey='case-notes:cache-dirty:'+name;
  const dirty=()=>{try{return localStorage.getItem(dirtyKey)==='1';}catch{return false;}};
  const markDirty=value=>{try{if(value)localStorage.setItem(dirtyKey,'1');else localStorage.removeItem(dirtyKey);}catch{}};
  const enqueue=job=>{const pending=queue.then(job);queue=pending.catch(()=>{});return pending;};
  const transaction=job=>db.transaction('rw',db.responses,db.control,job);
  const matches=state=>state?.scope===scope&&scope&&(isOffline()||now()<expiresAt);
  // Reuse online requires the replica to carry the verified current token; a
  // replica from another generation, or none at all, is a miss that stays on
  // disk for offline reading instead of being deleted.
  const fresh=(state,row)=>isOffline()||(!!state.changeToken&&row.change===state.changeToken&&(row.refreshEpoch??0)===(state.refreshEpoch??0));
  const safe=(job,maintenance=false)=>enqueue(async()=>{if(disabled&&!maintenance)return null;try{return await job();}catch{disabled=true;markDirty(true);return null;}});
  async function remove(row,state){await db.responses.delete(row.key);state.bytes-=row.bytes;}
  async function legacyExists(){
    const factory=dependencies?.indexedDB||Dexie.dependencies.indexedDB;
    if(!legacyName||!factory)return false;
    return new Promise(resolve=>{
      const request=factory.open(legacyName);
      request.onupgradeneeded=()=>request.transaction.abort(); // do not create a source cache
      request.onerror=event=>{event.preventDefault();resolve(false);};
      request.onblocked=()=>resolve(false);
      request.onsuccess=()=>{request.result.close();resolve(true);};
    });
  }
  function legacyStore(){const old=new Dexie(legacyName,dependencies);old.version(1).stores({responses:'key,savedAt,expiresAt',control:'id'});return old;}
  async function importLegacy(){
    if(!legacyName||await db.control.get('active')||dirty())return;
    let snapshot=null;
    if(await legacyExists()){
      let sourceDirty=false;try{sourceDirty=localStorage.getItem('case-notes:cache-dirty:'+legacyName)==='1';}catch{}
      if(!sourceDirty){const old=legacyStore();try{
        snapshot=await old.transaction('r',old.responses,old.control,async()=>({state:await old.control.get('active'),rows:await old.responses.toArray()}));
      }finally{old.close();}}
    }
    const rows=[];let bytes=0;
    if(snapshot?.state?.scope)for(const row of snapshot.rows.sort((a,b)=>b.savedAt-a.savedAt)){
      const size=new TextEncoder().encode(JSON.stringify(row.data)).length;
      if(size>maxEntryBytes||size>maxBytes||rows.length>=maxEntries||bytes+size>maxBytes)continue;
      rows.push({...row,bytes:size});bytes+=size;
    }
    await transaction(async()=>{
      if(await db.control.get('active'))return; // another window or logout already owns this cache
      await db.responses.clear();if(rows.length)await db.responses.bulkPut(rows);
      await db.control.put({id:'active',scope:snapshot?.state?.scope||null,expiresAt:snapshot?.state?.expiresAt??0,
        epoch:snapshot?.state?.epoch||0,bytes,legacyChecked:true,changeToken:null});
    });
  }
  return {
    activate(session){
      scope=session.cache_scope;expiresAt=Date.parse(session.expires_at);
      return safe(async()=>{await importLegacy();return transaction(async()=>{
        const previous=await db.control.get('active');
        if(!scope||!Number.isFinite(expiresAt)||expiresAt<=now()){scope=null;return;}
        const changeToken=session.change_token??null;
        if(previous?.scope!==scope||dirty()){
          await db.responses.clear();
          await db.control.put({id:'active',scope,expiresAt,epoch:(previous?.epoch||0)+1,bytes:0,changeToken});
          markDirty(false);
          return {changed:!!previous?.scope};
        }else{
          // Verified against the server: an unchanged token keeps replicas
          // usable, a newer one fences them for revalidation while keeping them
          // for offline reading, and a token on either side alone is adopted.
          const changed=(previous.changeToken??null)!==changeToken;
          await db.control.put({...previous,expiresAt,changeToken,epoch:changed?(previous.epoch||0)+1:(previous.epoch||0)});
          return {changed};
        }
      });},true);
    },
    resumeOffline(){
      return safe(async()=>{await importLegacy();return transaction(async()=>{
        const state=await db.control.get('active');
        if(dirty()||!state?.scope||(scope&&scope!==state.scope)||!Number.isFinite(state.expiresAt))return null;
        scope=state.scope;expiresAt=state.expiresAt;
        return {cache_scope:scope,expires_at:new Date(expiresAt).toISOString()};
      });});
    },
    read(key){
      return safe(()=>transaction(async()=>{
        const state=await db.control.get('active');if(!matches(state))return null;
        const token={scope,epoch:state.epoch,change:state.changeToken??null};
        const row=await db.responses.get(key);
        if(row&&fresh(state,row))return {hit:true,data:row.data,token};
        // A stale replica stays on disk for offline reading. Return it as stale
        // so the caller can display the old cache with a loading state first and
        // judge offline only after the network attempt finishes.
        if(row)return {hit:false,token,stale:row.data};
        return {hit:false,token};
      }));
    },
    write(key,data,token){
      // Snapshot before enqueueing: Vue proxies and later edits must not reach IDB.
      let copy,bytes;try{const json=JSON.stringify(data);bytes=new TextEncoder().encode(json).length;copy=JSON.parse(json);}catch{return Promise.resolve();}
      if(!token||bytes>maxEntryBytes||bytes>maxBytes)return Promise.resolve();
      return safe(()=>transaction(async()=>{
        const state=await db.control.get('active');
        if(isOffline()||!matches(state)||token.scope!==state.scope||token.epoch!==state.epoch
          ||(token.change??null)!==(state.changeToken??null))return;
        const old=await db.responses.get(key);if(old)await remove(old,state);
        const savedAt=now();
        await db.responses.put({key,data:copy,bytes,savedAt,change:state.changeToken??null,refreshEpoch:state.refreshEpoch??0});state.bytes+=bytes;
        let count=await db.responses.count();
        while(count>maxEntries||state.bytes>maxBytes){const row=await db.responses.orderBy('savedAt').first();if(!row)break;await remove(row,state);count--;}
        await db.control.put(state);
      }));
    },
    revalidate(){
      return safe(()=>transaction(async()=>{
        const state=await db.control.get('active');if(!matches(state)||isOffline())return;
        await db.control.put({...state,epoch:(state.epoch||0)+1,refreshEpoch:(state.refreshEpoch||0)+1});
      }),true);
    },
    invalidate(key){
      return safe(()=>transaction(async()=>{
        const state=await db.control.get('active');if(!matches(state))return;
        state.epoch++;
        if(key===undefined){await db.responses.clear();state.bytes=0;}
        else {const row=await db.responses.get(key);if(row)await remove(row,state);}
        await db.control.put(state);
      }),true);
    },
    clear(){
      scope=null;expiresAt=0;
      // Cleanup is awaited even after storage failure; do not silently claim that
      // private replicas were removed when the browser rejected the transaction.
      if(!(dependencies?.indexedDB||Dexie.dependencies.indexedDB))return Promise.resolve();
      return enqueue(async()=>{try{await transaction(async()=>{
        const state=await db.control.get('active');await db.responses.clear();
        await db.control.put({id:'active',scope:null,epoch:(state?.epoch||0)+1,bytes:0,changeToken:null});
      });
        if(await legacyExists()){const old=legacyStore();try{await old.transaction('rw',old.responses,old.control,async()=>{
          const state=await old.control.get('active');await old.responses.clear();await old.control.put({id:'active',scope:null,epoch:(state?.epoch||0)+1,bytes:0,changeToken:null});
        });}finally{old.close();}}
        markDirty(false);
      }catch(error){markDirty(true);throw error;}});
    },
    async flush(){await queue;},
    close(){db.close();},
  };
}
