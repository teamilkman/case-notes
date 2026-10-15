// These names identify historical storage only. Active writes use case-notes.
const previousPrefix='ailog:',prefix='case-notes:';
const keys=storage=>typeof storage.key==='function'?Array.from({length:storage.length},(_,i)=>storage.key(i)).filter(Boolean):Object.keys(storage);
export function migrateSessionStorage(storage=globalThis.sessionStorage){
  if(!storage)return;
  for(const key of keys(storage))if(key.startsWith(previousPrefix)){
    const value=storage.getItem(key),target=prefix+key.slice(previousPrefix.length);
    if(value===null)continue;
    try{
      const existing=storage.getItem(target);
      if(existing!==null&&existing!==value)continue; // preserve both conflicting copies
      storage.setItem(target,value);storage.removeItem(key);
    }catch{} // A failed copy never deletes the source draft or request key.
  }
}
export function clearSessionStorage(storage=globalThis.sessionStorage){
  if(storage)for(const key of keys(storage))if(key.startsWith(prefix)||key.startsWith(previousPrefix))storage.removeItem(key);
}
export function removePreviousReadCache(database=globalThis.indexedDB){
  if(!database)return Promise.resolve();
  return new Promise(resolve=>{
    try{const request=database.deleteDatabase('ai-log-reads-v1');
      request.onsuccess=request.onerror=request.onblocked=()=>resolve();
    }catch{resolve();}
  });
}
