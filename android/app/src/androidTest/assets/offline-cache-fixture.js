// Seed a historical snapshot directly in isolated emulator storage. No network
// writes and no module import from WebView's injected-script execution context.
window.__seeded=false;
const fixtureOpen=indexedDB.open('case-notes-reads-v3',20);
fixtureOpen.onupgradeneeded=()=>{
  const db=fixtureOpen.result;
  if(!db.objectStoreNames.contains('responses')){
    const responses=db.createObjectStore('responses',{keyPath:'key'});responses.createIndex('savedAt','savedAt');
  }
  if(!db.objectStoreNames.contains('control'))db.createObjectStore('control',{keyPath:'id'});
};
fixtureOpen.onerror=()=>{window.__seedError=String(fixtureOpen.error);};
fixtureOpen.onsuccess=()=>{
  const db=fixtureOpen.result;
  try{
    const doc={ref:'android-qa',revision:3,case:{id:'android-qa',name:'合成离线案件',kind:'case',status:'在办'},lines:[{line_id:'synthetic-line',text:'合成离线记录'}],text:'合成离线记录'};
    const captured=Date.now()-8*86400000,bytes=new TextEncoder().encode(JSON.stringify(doc)).length;
    const transaction=db.transaction(['control','responses'],'readwrite');
    transaction.objectStore('control').put({id:'active',scope:'synthetic-android-offline',expiresAt:Date.now()-86400000,epoch:1,bytes});
    transaction.objectStore('responses').put({key:'case:android-qa',data:doc,bytes,savedAt:captured,expiresAt:captured+300000});
    transaction.oncomplete=()=>{db.close();window.__seeded=true;};
    transaction.onabort=transaction.onerror=()=>{db.close();window.__seedError=String(transaction.error);};
  }catch(error){db.close();window.__seedError=String(error);}
};
