import {migrateSessionStorage,clearSessionStorage,removePreviousReadCache} from './storage-upgrade.js';
import {editLines} from './editor.js';
import {createPager} from './paging.js';
import {createReadCache,withSignal} from './read-cache.js';
import {createPersistentCache} from './persistent-cache.js';
import {createSessionAccess} from './session-access.js';
import {appLocation} from './app-location.js';

// D1 is authoritative; browser replicas are session-scoped and disposable.
async function request(path,args,method='POST',signal) {
  let response;
  try { response=await fetch(path,{method,signal,credentials:'same-origin',cache:'no-store',headers:method==='POST'?{'Content-Type':'application/json'}:{},body:method==='POST'?JSON.stringify(args):undefined}); }
  catch(error) {if(error.name==='AbortError')throw error;connection.offline=true;const e=new Error('网络不可用，请联网后重试；未保存笔记请保留。');e.code='NETWORK_UNAVAILABLE';e.retryable=true;throw e; }
  let j;
  try{j=await response.json();}catch{const e=new Error('响应中断，请重试；系统会核对原请求是否已保存。');e.retryable=true;throw e;}
  if(!j.ok){
    let localOnly=false;
    if(response.status===401&&path!=='/api/session'){
      const owner=await persistent?.resumeOffline();
      if(owner){connection.offline=true;connection.authRequired=true;localOnly=true;}
      else {try{await clearPrivate();}finally{location.replace(appLocation('login.html'));}}
    }
    const e=new Error(localOnly?'需要重新登录才能同步，现有本地副本仍可离线查看。':j.error?.message||'请求失败');e.code=localOnly?'OFFLINE_AUTH_REQUIRED':j.error?.code;e.status=response.status;e.retryable=j.error?.retryable;e.commitState=j.error?.commit_state;throw e;
  }
  return j.data;
}
const api=(name,args={})=>request('/api/v1/'+name,args);
async function all(name,args={}) {
  let page=await api(name,args);const first=page,rows=[...(page.items||page.lines||[])];
  while(page.has_more){page=await api(name,{...args,cursor:page.next_cursor});rows.push(...(page.items||page.lines||[]));}
  return {...first,items:rows,lines:rows};
}
function pending(action,ref,base){
  migrateSessionStorage();
  const key='case-notes:pending:'+action+':'+ref,signature=JSON.stringify(base);let old;
  try{old=JSON.parse(sessionStorage.getItem(key));}catch{}
  const original=old?.args&&Object.fromEntries(Object.entries(old.args).filter(([k])=>k!=='request_key'));
  const args=JSON.stringify(original)===signature?old.args:{...base,request_key:crypto.randomUUID()};
  sessionStorage.setItem(key,JSON.stringify({args}));
  return {args,clear:()=>sessionStorage.removeItem(key)};
}
async function clearPrivate(){privateClosed=true;sessionAccess?.close();invalidateReads();feeds.clear();clearSessionStorage();if(persistent)try{await persistent.clear();}catch{throw new Error('浏览器未能清理本地缓存，请重试退出。');}}
const dotted=value=>value?.replaceAll('-','.')||null;
export function legacyView(cases,rows){
  const D={案件:[],归档:[],事务:[],待办:[],日程:[],全部日程:[],按日期:{},_meta:{generated:new Date().toISOString()}};
  const map=new Map();
  for(const c of cases){
    const item={path:c.id,名称:c.name,状态:c.kind==='affair'?'事务':c.status,案由:c.cause,案号:c.case_number,法院:c.court,创建:dotted(c.opened_date),最近活动:dotted(c.recent_activity),记录:c.match_text?[{文本:c.match_text}]:[]};
    map.set(c.id,item);(c.kind==='affair'?D.事务:c.status==='在办'?D.案件:D.归档).push(item);
  }
  for(const r of [...rows].sort((a,b)=>a.sort_order-b.sort_order)){
    const c=map.get(r.case_id);if(!c)continue;
    let text=r.text.trim().replace(/^[-*]\s+/,'');
    if(r.marker)text=text.slice(r.marker.length).trim();
    const record={行:r.sort_order,日期:r.date,时间:r.time,标记:r.marker,文本:text};
    if(r.text.trim())c.记录.push(record);
    if(r.date){(D.按日期[r.date]??=[]).push({案件:c.名称,标记:r.marker,文本:text});}
    if(r.kind==='todo'&&r.case_status==='在办')D.待办.push({案件:c.名称,文本:r.display_text,行:r.sort_order,状态:r.todo_state,截止:r.due_date,截止时间:r.due_time,line_id:r.line_id,case_id:r.case_id,version:r.version});
    if(r.kind==='schedule'&&r.event_date&&c.状态!=='事务'){
      const event={案件:c.名称,日期:r.event_date,时间:r.event_time,文本:r.display_text.replace(/^\d{4}\.\d{1,2}\.\d{1,2}(?:\s+\d{1,2}:\d{2})?\s*/,''),状态:c.状态,path:c.path,案由:c.案由};
      D.全部日程.push(event);if(c.状态==='在办')D.日程.push(event);
    }
  }
  D.全部日程.sort((a,b)=>a.日期.localeCompare(b.日期)||(a.时间||'99:99').localeCompare(b.时间||'99:99'));
  D.日程.sort((a,b)=>a.日期.localeCompare(b.日期)||(a.时间||'99:99').localeCompare(b.时间||'99:99'));
  return D;
}
const wrap=value=>typeof window!=='undefined'&&window.Vue?window.Vue.reactive(value):value;
const connection=wrap({offline:typeof navigator!=='undefined'&&navigator.onLine===false,authRequired:false,reconnecting:false,error:'',syncing:typeof window!=='undefined'});
const persistent=typeof window!=='undefined'?createPersistentCache({isOffline:()=>connection.offline}):null;
const reads=createReadCache(wrap,128,persistent),feeds=new Map();let readEpoch=0,privateClosed=false;
const sessionAccess=persistent?createSessionAccess({persistence:persistent,state:connection,
  verify:async()=>{const session=await request('/api/session',null,'GET');migrateSessionStorage();await removePreviousReadCache();
    // Best effort: the browser decides whether to protect this origin from eviction.
    if(navigator.storage?.persist)void navigator.storage.persist().catch(()=>{});
    return session;},
  onVerified:()=>{invalidateReads(undefined,false);window.dispatchEvent(new Event('case-notes:reconnected'));},
  onUnauthorized:async()=>{try{await clearPrivate();}finally{location.replace(appLocation('login.html'));}},
}):null;
const ensureSession=()=>sessionAccess?sessionAccess.ensure():Promise.resolve();
async function reconnect(){
  if(privateClosed||connection.reconnecting)return;
  connection.reconnecting=true;connection.error='';
  try{await sessionAccess?.ensure(true);}catch(error){connection.error=error.message;}
  finally{connection.reconnecting=false;}
}
// Foreground resume revalidates once per focus with a short guard so rapid app
// switches do not queue requests; verification shares the session, only an
// actual workspace change refreshes the current views.
let resumeAt=0;
function resume(){
  if(privateClosed||connection.reconnecting)return;
  const now=Date.now();if(now-resumeAt<5000)return;resumeAt=now;
  void reconnect();
}
async function ensureOnline(){
  if(!persistent)return;
  if(connection.offline){const e=new Error('离线时只可查看本地缓存，请联网后再保存或完成待办。');e.code='OFFLINE_READ_ONLY';throw e;}
  await ensureSession();
  if(connection.offline)throw new Error('离线时只可查看本地缓存，请联网后再操作。');
}
// Cold start adopts the on-disk session before the first read so stale replicas
// can display at once instead of waiting for a network timeout; the same queue
// orders this ahead of later reads. Verification still runs once per page load
// in the background (shared with reads), and only an actual workspace change
// refreshes the current views.
if(persistent)void persistent.resumeOffline().catch(()=>{});
void (async()=>{
  if(!persistent||typeof window==='undefined')return;
  try{
    const before=(await persistent.read('__cold_probe__'))?.token;
    await ensureSession();
    connection.syncing=false;
    const after=(await persistent.read('__cold_probe__'))?.token;
    const changed=!before||!after||before.scope!==after.scope||before.epoch!==after.epoch||(before.change??null)!==(after.change??null);
    if(before&&after&&changed){
      invalidateReads(undefined,false);
      window.dispatchEvent(new Event('case-notes:reconnected'));
    }
  }catch{connection.syncing=false;}
})();
if(typeof window!=='undefined'){
  window.addEventListener('offline',()=>{connection.offline=true;});
  window.addEventListener('online',reconnect);
  window.addEventListener('focus',resume);
}
const cacheKey=(name,args)=>name+':'+JSON.stringify(Object.fromEntries(Object.entries(args).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b))));
// Cache first, offline judgement after: the persistent stale replica is displayed
// with a loading state before the session verification and network read run.
// A successful network read completes the entry; a network or offline-auth failure
// keeps the existing offline copy.
const web=(name,args={},signal)=>withSignal(reads.entry(cacheKey(name,args)).ensure(async()=>{await ensureSession();return request('/api/web/'+name,args);}),signal);
// Local-only peek of the same cached page: lists display it at once with a
// loading state, the network load that follows completes it or keeps it offline.
async function peekPage(name,args={}){
  if(!persistent)return null;
  try{
    const stored=await persistent.read(cacheKey(name,args));
    return stored?.hit?stored.data:(stored?.stale??null);
  }catch{return null;}
}
function pager(name){return createPager((args,signal)=>web(name,{limit:20,...args},signal),undefined,(args)=>peekPage(name,{limit:20,...args}));}
export function feed(name,args={}){
  const key=cacheKey(name,args);if(feeds.has(key))return feeds.get(key);
  const base=pager(name);
  const value=wrap({...base,name,args,epoch:readEpoch,refreshJob:null,
    ensure(){
      if(this.epoch!==readEpoch){
        const count=this.items.length,refreshed=pager(this.name);refreshed.args=this.args;
        this.controller?.abort();const generation=++this.generation;
        this.epoch=readEpoch;this.loading=true;this.error='';
        const next=()=>{const job=refreshed.load();this.controller=refreshed.controller;return job;};
        // Revalidate only the extent already browsed, keeping later selections
        // and scroll height until a complete current result can replace it.
        this.refreshJob=(async()=>{
          await next();
          while(generation===this.generation&&!refreshed.error&&refreshed.hasMore&&refreshed.items.length<count)await next();
          if(generation!==this.generation)return;
          if(refreshed.error){this.error=refreshed.error;this.epoch=-1;return;}
          for(const field of ['items','total','cursor','hasMore','loadedAt'])this[field]=refreshed[field];
        })().finally(()=>{if(generation===this.generation){this.loading=false;this.pending=null;this.refreshJob=null;}});
        this.pending=this.refreshJob;
        return this.refreshJob;
      }
      return this.refreshJob||this.pending||(!this.loadedAt&&!this.error?this.load():Promise.resolve());
    },
    load(){if(this.epoch!==readEpoch)return this.ensure();return this.refreshJob||base.load.call(this);},
  });
  feeds.set(key,value);if(feeds.size>64){for(const [old,f]of feeds){if(old!==key&&!f.loading){feeds.delete(old);break;}}}
  return value;
}
export function invalidateReads(savedDoc,persist=true){
  readEpoch++;reads.invalidate(persist);
  for(const value of feeds.values()){
    value.controller?.abort();value.generation++;value.loading=false;value.pending=null;value.refreshJob=null;
    if(savedDoc&&value.name==='cases'&&value.loadedAt){
      // Keep this browsing result stable even when recent activity changes its
      // sort position or a text match disappears. New queries read current data.
      const item=value.items.find(c=>c.id===savedDoc.ref);
      const group=c=>c.kind==='affair'?'affairs':c.status==='在办'?'active':'archived';
      const from=savedDoc.previousCase&&group(savedDoc.previousCase),to=group(savedDoc.case);
      if(from&&from!==to&&(value.args.group===from||value.args.group===to)){
        if(item&&value.args.group===from){value.items.splice(value.items.indexOf(item),1);if(value.total!==null)value.total=Math.max(0,value.total-1);}
        continue; // Changed membership must revalidate both groups on demand.
      }
      if(item){
        Object.assign(item,savedDoc.case);
        if(value.args.query)item.match_text=savedDoc.lines.find(l=>l.text.toLowerCase().includes(value.args.query.toLowerCase()))?.text||null;
      }
      keepFeed(value);
    }
  }
}
function keepFeed(value){value.epoch=readEpoch;value.loadedAt=Date.now();}
function rememberDoc(doc){reads.entry('case:'+doc.ref).prime(doc);}
function invalidateCase(ref){reads.entry('case:'+ref).invalidate();}
function calendar(y,m){return reads.entry('calendar:'+y+'-'+m);}
async function readCalendar(y,m){
  return calendar(y,m).ensure(async()=>{
    await ensureSession();
    const pad=n=>String(n).padStart(2,'0');
    const args={mode:'future',today:'0001-01-01',from_date:y+'-'+pad(m+1)+'-01',to_date:y+'-'+pad(m+1)+'-'+pad(new Date(y,m+1,0).getDate()),limit:100};
    const [counts,first]=await Promise.all([web('calendar-counts',{}),web('schedules',args)]);
    let page=first;const items=[...page.items];
    while(page.has_more){page=await web('schedules',{...args,cursor:page.next_cursor});items.push(...page.items);}
    return {items,dateCounts:Object.fromEntries(counts.items.map(x=>[x.date,x.count]))};
  });
}
function caseItem(c){const d=legacyView([c],[]);return [...d.案件,...d.归档,...d.事务][0];}
function todoItem(r){return {案件:r.case_name,文本:r.display_text,行:r.sort_order,状态:r.todo_state,截止:r.due_date,截止时间:r.due_time,line_id:r.line_id,case_id:r.case_id,version:r.version};}
function eventItem(r){return {line_id:r.line_id,案件:r.case_name,日期:r.event_date,时间:r.event_time,文本:r.display_text.replace(/^\d{4}\.\d{1,2}\.\d{1,2}(?:\s+\d{1,2}:\d{2})?\s*/,''),状态:r.case_status,path:r.case_id};}
function activityItem(r){return {line_id:r.line_id,path:r.case_id,案件:r.case_name,状态:r.case_kind==='affair'?'事务':r.case_status,标记:r.marker,日期:r.date,时间:r.time,文本:r.display_text.replace(/^\d{4}\.\d{2}\.\d{2}(\s+\d{2}:\d{2})?\s*/,'')};}
async function readCase(ref){
  return reads.entry('case:'+ref).ensure(async()=>{await ensureSession();const result=await all('cases_get',{case_ref:ref});return {ref,case:result.case,revision:result.document_revision,lines:result.lines,text:result.lines.map(l=>l.text).join('\n')};});
}
export function beginEdit(doc){return {ref:doc.ref,revision:doc.revision,rows:doc.lines.map(l=>({line_id:l.line_id,text:l.text})),text:doc.text,edit:null,draftUnversioned:false,draftNotice:'',metadata:undefined};}
function storeDraft(editor){sessionStorage.setItem('case-notes:draft:'+editor.ref,JSON.stringify({format:1,revision:editor.revision,rows:editor.rows,unversioned:editor.draftUnversioned,...(editor.metadata?{metadata:editor.metadata}:{})}));}
export function changeMetadata(editor,metadata){editor.metadata=metadata;storeDraft(editor);}
export function changeEdit(editor,next){
  migrateSessionStorage();
  let range=editor.edit;editor.edit=null;
  if(editor.text===next)return;
  if(!range||range.inputType.startsWith('history')){
    let start=0;while(start<editor.text.length&&start<next.length&&editor.text[start]===next[start])start++;
    let end=editor.text.length,tail=next.length;while(end>start&&tail>start&&editor.text[end-1]===next[tail-1]){end--;tail--;}
    range={start,end,inputType:'insertReplacementText'};
  }
  const rows=editor.rows.length?editor.rows:[{text:''}];
  try{editor.rows=editLines(rows,editor.text,next,range);editor.text=next;}
  catch(error){
    // Keep the editor aligned with the visible draft after a genuine failure;
    // subsequent typing must not repeatedly compare against outdated text.
    editor.text=next;editor.rows=next.split('\n').map(text=>({text}));editor.draftUnversioned=true;
    storeDraft(editor);
    throw error;
  }
  storeDraft(editor);
}
export function restoreDraft(editor){
  migrateSessionStorage();
  const stored=sessionStorage.getItem('case-notes:draft:'+editor.ref);if(stored===null)return editor.text;
  let draft;try{draft=JSON.parse(stored);}catch{}
  const versioned=draft?.format===1&&Number.isInteger(draft.revision)&&draft.revision>0
    &&Array.isArray(draft.rows)&&draft.rows.every(l=>l&&typeof l.text==='string'&&(l.line_id===undefined||typeof l.line_id==='string'));
  const text=versioned?draft.rows.map(l=>l.text).join('\n'):stored;
  if((text!==editor.text||versioned&&draft.metadata)&&confirm('发现此案件未保存的草稿，是否恢复？')){
    const currentRevision=editor.revision;
    if(versioned){
      editor.revision=draft.revision;editor.rows=draft.rows.map(l=>({...l}));editor.text=text;editor.edit=null;
      editor.draftUnversioned=!!draft.unversioned;
      editor.metadata=draft.metadata;
    }else{
      // Old plain-text drafts have no trustworthy base. Keep them available to
      // copy, but never silently give them the current server revision.
      editor.draftUnversioned=true;changeEdit(editor,text);
    }
    if(editor.draftUnversioned||editor.revision!==currentRevision)
      editor.draftNotice='草稿与当前服务器版本不同。请复制草稿，取消编辑后核对最新正文再修改；保存时会核对原版本，不能覆盖服务器更新。';
    return editor.text;
  }
  return editor.text;
}
function discardDraft(ref){sessionStorage.removeItem('case-notes:draft:'+ref);}
export async function save(editor){
  await ensureOnline();
  if(editor.draftUnversioned){const e=new Error('旧草稿缺少基准版本。请复制草稿，取消编辑后核对最新正文再修改。');e.code='DRAFT_CONFLICT';throw e;}
  const job=pending('save',editor.ref,{case_ref:editor.ref,expected_document_revision:editor.revision,lines:editor.rows,...(editor.metadata?{metadata:editor.metadata}:{})});
  try {const receipt=await request('/api/web/save-notes',job.args);job.clear();sessionStorage.removeItem('case-notes:draft:'+editor.ref);return receipt;}
  catch(e){if(!e.retryable&&e.commitState!=='unknown')job.clear();throw e;}
}
export function pendingCreate(){
  migrateSessionStorage();
  try{return JSON.parse(sessionStorage.getItem('case-notes:pending:create:new'))?.args||null;}catch{return null;}
}
export function pendingMetadata(ref){
  migrateSessionStorage();
  try{return JSON.parse(sessionStorage.getItem('case-notes:pending:metadata:'+ref))?.args||null;}catch{return null;}
}
export async function updateCase(ref,version,fields){
  await ensureOnline();
  const original=pendingMetadata(ref);
  const base=original?Object.fromEntries(Object.entries(original).filter(([k])=>k!=='request_key')):{case_ref:ref,expected_metadata_version:version,fields};
  const job=pending('metadata',ref,base);
  try{const receipt=await api('cases_update',job.args);job.clear();return receipt;}
  catch(e){if(!e.retryable&&e.commitState!=='unknown')job.clear();throw e;}
}
export async function createCase(fields){
  await ensureOnline();
  const original=pendingCreate();
  const base=original?Object.fromEntries(Object.entries(original).filter(([k])=>k!=='request_key')):fields;
  const job=pending('create','new',base);
  try{const receipt=await api('cases_create',job.args);job.clear();return receipt;}
  catch(e){if(!e.retryable&&e.commitState!=='unknown')job.clear();throw e;}
}
export async function complete(todo){
  await ensureOnline();
  const job=pending('todo',todo.line_id,{case_ref:todo.case_id,line_id:todo.line_id,expected_line_version:todo.version});
  try{const receipt=await request('/api/web/complete-todo',job.args);job.clear();return receipt;}
  catch(e){if(!e.retryable&&e.commitState!=='unknown')job.clear();throw e;}
}
export async function logout(){
  await request('/api/logout',{});
  await clearPrivate();
}
function sanitize(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const allowed=new Set('P BR HR H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE STRONG EM DEL S A TABLE THEAD TBODY TR TH TD IMG INPUT SPAN DIV'.split(' '));
  for(const el of [...doc.body.querySelectorAll('*')]){
    if(!allowed.has(el.tagName)){el.remove();continue;}
    for(const attr of [...el.attributes]){
      if(!['href','src','alt','title','class','type','checked','disabled','start','colspan','rowspan'].includes(attr.name))el.removeAttribute(attr.name);
      else if(['href','src'].includes(attr.name)&&! /^(?:https?:|mailto:|tel:|\/|#)/i.test(attr.value))el.removeAttribute(attr.name);
    }
    if(el.tagName==='INPUT'){el.type='checkbox';el.disabled=true;}
  }
  return doc.body.innerHTML;
}
if(typeof window!=='undefined')window.DB={connection,reconnect,resume,web,pager,peek:peekPage,feed,calendar,readCalendar,invalidateReads,keepFeed,rememberDoc,invalidateCase,caseItem,todoItem,eventItem,activityItem,legacyView,readCase,beginEdit,changeEdit,changeMetadata,save,createCase,pendingCreate,updateCase,pendingMetadata,complete,logout,sanitize,clearPrivate,restoreDraft,discardDraft};
