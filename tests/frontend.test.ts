import {test} from 'node:test';
import assert from 'node:assert/strict';
import {legacyView,save,complete,feed,invalidateReads,beginEdit,changeEdit,restoreDraft,logout} from '../public/db-adapter.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseLine} from '../src/parser';
import {createReadCache} from '../public/read-cache.js';
import {createNavigation} from '../public/navigation.js';
import {pageDeck,MOBILE_QUERY} from '../public/page-deck.js';
import {appLocation} from '../public/app-location.js';

test('original UI gets saved line order, independent duplicate TODO IDs and archive calendar',()=>{
  const cases=[{id:'c',name:'示例案件',kind:'case',status:'在办'}, {id:'a',name:'归档示例',kind:'case',status:'结案'}, {id:'f',name:'事务示例',kind:'affair',status:'在办'}];
  const row=(cid:string,lid:string,order:number,text:string)=>{const p=parseLine(text);return {case_id:cid,case_status:cases.find(c=>c.id===cid)!.status,line_id:lid,version:1,sort_order:order,text,...p,date:p.record_date,time:p.record_time};};
  const rows=[row('c','two',2,'- [ ] 相同待办 #等待'),row('c','one',1,'- [ ] 相同待办 #等待'),row('a','ev',1,'- 📅 2026.10.15 09:00 归档日程'),row('f','fev',1,'- 📅 2026.10.16 09:00 事务日程')];
  const D=legacyView(cases,rows);
  assert.deepEqual(D.待办.map((x:any)=>x.line_id),['one','two']);
  assert.equal(D.待办[0].状态,'等待');assert.equal(D.待办[0].文本,'相同待办');
  assert.equal(D.案件[0].记录[0].文本,'相同待办 #等待');
  assert.equal(D.事务[0].状态,'事务');assert.equal(D.全部日程.length,1);assert.equal(D.日程.length,0);
  assert.equal(D.全部日程[0].path,'a');assert.equal(D.全部日程[0].文本,'归档日程');
});

test('a truncated save response retains the same request key and draft for replay',async()=>{
  const fetchBefore=globalThis.fetch,storageBefore=globalThis.sessionStorage;
  const store=new Map<string,string>();
  globalThis.sessionStorage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}} as any;
  const sent:any[]=[];
  globalThis.fetch=async(_path:any,options:any)=>{sent.push(JSON.parse(options.body));return sent.length===1?new Response('{',{status:200}):Response.json({ok:true,data:{document_revision:2,replayed:true}});};
  try{
    store.set('case-notes:draft:c','新笔记');
    const editor=beginEdit({ref:'c',revision:1,text:'新笔记',lines:[{line_id:'l',text:'新笔记'}]});
    await assert.rejects(save(editor),(e:any)=>e.retryable===true);assert.equal(store.get('case-notes:draft:c'),'新笔记');
    const replay=await save(editor);assert.equal(replay.replayed,true);assert.equal(sent[0].request_key,sent[1].request_key);assert.equal(store.has('case-notes:draft:c'),false);
  }finally{globalThis.fetch=fetchBefore;globalThis.sessionStorage=storageBefore;}
});

function storage(){
  const data:Record<string,string>={};
  return Object.assign(data,{getItem:(k:string)=>typeof data[k]==='string'?data[k]:null,
    setItem:(k:string,v:string)=>{data[k]=v;},removeItem:(k:string)=>{delete data[k];}}) as unknown as Storage;
}
test('daily quota failure keeps an uncertain save key and versioned draft for replay after reload',async()=>{
  const previous={storage:globalThis.sessionStorage,confirm:globalThis.confirm,fetch:globalThis.fetch};
  globalThis.sessionStorage=storage();globalThis.confirm=()=>true;const sent:any[]=[];
  globalThis.fetch=async(_path,options)=>{sent.push(JSON.parse(String(options?.body)));return sent.length===1
    ?Response.json({ok:false,error:{code:'DAILY_LIMIT_EXCEEDED',message:'等待额度重置',retryable:false,commit_state:'unknown'}},{status:503})
    :Response.json({ok:true,data:{replayed:true}});};
  try{
    const editor=beginEdit(documentFor(1));changeEdit(editor,'草稿第一行\n第二行');
    await assert.rejects(save(editor),(e:any)=>e.code==='DAILY_LIMIT_EXCEEDED'&&e.retryable===false&&e.commitState==='unknown');
    assert.equal(sent.length,1);assert.notEqual(sessionStorage.getItem('case-notes:pending:save:draft-case'),null);
    assert.notEqual(sessionStorage.getItem('case-notes:draft:draft-case'),null);
    const restored=beginEdit(documentFor(3,'服务器后续修改'));restoreDraft(restored);
    assert.equal((await save(restored)).replayed,true);assert.deepEqual(sent[1],sent[0]);
    assert.equal(sessionStorage.getItem('case-notes:pending:save:draft-case'),null);
    assert.equal(sessionStorage.getItem('case-notes:draft:draft-case'),null);
  }finally{globalThis.sessionStorage=previous.storage;globalThis.confirm=previous.confirm;globalThis.fetch=previous.fetch;}
});

test('daily quota failure keeps an uncertain todo completion key until its receipt is acknowledged',async()=>{
  const previous={storage:globalThis.sessionStorage,fetch:globalThis.fetch};
  globalThis.sessionStorage=storage();const sent:any[]=[];
  globalThis.fetch=async(_path,options)=>{sent.push(JSON.parse(String(options?.body)));return sent.length===1
    ?Response.json({ok:false,error:{code:'DAILY_LIMIT_EXCEEDED',message:'等待额度重置',retryable:false,commit_state:'unknown'}},{status:503})
    :Response.json({ok:true,data:{replayed:true}});};
  try{
    const todo={case_id:'todo-case',line_id:'todo-line',version:1};
    await assert.rejects(complete(todo),(e:any)=>e.retryable===false&&e.commitState==='unknown');
    assert.equal(sent.length,1);assert.notEqual(sessionStorage.getItem('case-notes:pending:todo:todo-line'),null);
    assert.equal((await complete(todo)).replayed,true);assert.deepEqual(sent[1],sent[0]);
    assert.equal(sessionStorage.getItem('case-notes:pending:todo:todo-line'),null);
  }finally{globalThis.sessionStorage=previous.storage;globalThis.fetch=previous.fetch;}
});

const documentFor=(revision:number,second='第二行')=>({ref:'draft-case',revision,text:'第一行\n'+second,
  lines:[{line_id:'first',text:'第一行'},{line_id:'second',text:second}]});

test('restoring a draft preserves its old revision and line identities instead of rebasing onto server changes',async()=>{
  const previous={storage:globalThis.sessionStorage,confirm:globalThis.confirm,fetch:globalThis.fetch};
  globalThis.sessionStorage=storage();globalThis.confirm=()=>true;
  try{
    const editor=beginEdit(documentFor(1));changeEdit(editor,'草稿第一行\n第二行');
    const restored=beginEdit(documentFor(2,'服务器更新第二行'));
    assert.equal(restoreDraft(restored),'草稿第一行\n第二行');assert.equal(restored.revision,1);
    assert.deepEqual(restored.rows.map(l=>l.line_id),['first','second']);assert.match(restored.draftNotice,/服务器版本不同/);
    globalThis.fetch=async(_path,options)=>{const args=JSON.parse(String(options?.body));assert.equal(args.expected_document_revision,1);
      return Response.json({ok:false,error:{code:'VERSION_CONFLICT',message:'版本冲突',retryable:false}},{status:409});};
    await assert.rejects(save(restored),(e:any)=>e.code==='VERSION_CONFLICT');
    assert.notEqual(sessionStorage.getItem('case-notes:draft:draft-case'),null);
  }finally{globalThis.sessionStorage=previous.storage;globalThis.confirm=previous.confirm;globalThis.fetch=previous.fetch;}
});

test('draft reload retains an uncertain save request for replay after a later server edit',async()=>{
  const previous={storage:globalThis.sessionStorage,confirm:globalThis.confirm,fetch:globalThis.fetch};
  globalThis.sessionStorage=storage();globalThis.confirm=()=>true;const sent:any[]=[];
  globalThis.fetch=async(_path,options)=>{sent.push(JSON.parse(String(options?.body)));return sent.length===1?new Response('{'):Response.json({ok:true,data:{replayed:true}});};
  try{
    const editor=beginEdit(documentFor(1));changeEdit(editor,'草稿第一行\n第二行');
    await assert.rejects(save(editor));
    const restored=beginEdit(documentFor(3,'服务器后续修改'));restoreDraft(restored);
    assert.equal((await save(restored)).replayed,true);assert.deepEqual(sent[1],sent[0]);
    assert.equal(sessionStorage.getItem('case-notes:draft:draft-case'),null);
  }finally{globalThis.sessionStorage=previous.storage;globalThis.confirm=previous.confirm;globalThis.fetch=previous.fetch;}
});

test('plain legacy drafts and edits with unknown identities stay copyable but cannot acquire a new base revision',async()=>{
  const previous={storage:globalThis.sessionStorage,confirm:globalThis.confirm};globalThis.sessionStorage=storage();globalThis.confirm=()=>true;
  try{
    sessionStorage.setItem('case-notes:draft:draft-case','旧草稿');
    const editor=beginEdit(documentFor(2));assert.equal(restoreDraft(editor),'旧草稿');
    changeEdit(editor,'继续编辑旧草稿');await assert.rejects(save(editor),(e:any)=>e.code==='DRAFT_CONFLICT');
    const reloaded=beginEdit(documentFor(3));assert.equal(restoreDraft(reloaded),'继续编辑旧草稿');
    await assert.rejects(save(reloaded),(e:any)=>e.code==='DRAFT_CONFLICT');
    const invalid=beginEdit(documentFor(1));invalid.edit={start:999,end:999,inputType:'insertText'};
    assert.throws(()=>changeEdit(invalid,'无法定位的新内容'));
    assert.equal(invalid.text,'无法定位的新内容');assert.equal(invalid.draftUnversioned,true);
    changeEdit(invalid,'无法定位的新内容，继续编辑');
    const recover=beginEdit(documentFor(2));assert.equal(restoreDraft(recover),'无法定位的新内容，继续编辑');
    await assert.rejects(save(recover),(e:any)=>e.code==='DRAFT_CONFLICT');
  }finally{globalThis.sessionStorage=previous.storage;globalThis.confirm=previous.confirm;}
});

test('logout clears private drafts only after an acknowledged session revocation',async()=>{
  const previous={storage:globalThis.sessionStorage,fetch:globalThis.fetch};globalThis.sessionStorage=storage();
  try{
    sessionStorage.setItem('case-notes:draft:c','草稿');
    for(const fail of [async()=>{throw new Error('offline');},async()=>Response.json({ok:false,error:{message:'失败'}},{status:503}),async()=>new Response('{')]){
      globalThis.fetch=fail;await assert.rejects(logout());assert.equal(sessionStorage.getItem('case-notes:draft:c'),'草稿');
    }
    globalThis.fetch=async()=>Response.json({ok:true,data:{logged_in:false}});await logout();
    assert.equal(sessionStorage.getItem('case-notes:draft:c'),null);
  }finally{globalThis.sessionStorage=previous.storage;globalThis.fetch=previous.fetch;}
});

function uiHarness(){
  const components:Record<string,any>={},app:any={config:{globalProperties:{}},component:(name:string,def:any)=>{components[name]=def;},mount:()=>{}};
  let root:any;
  const context:any={Vue:{reactive:(v:any)=>v,createApp:(v:any)=>{root=v;return app;}},DB:{legacyView:()=>({案件:[],归档:[],事务:[]}),
    caseItem:(c:any)=>({path:c.id,名称:c.name,状态:c.status}),changeEdit:()=>{},invalidateReads:()=>{},rememberDoc:()=>{},web:async()=>({counts:{}})},
    location:{hash:'#/kanban'},document:{querySelector:()=>null},window:{addEventListener:()=>{}},setTimeout:()=>{},clearTimeout:()=>{},Date,Map,Set,pageDeck,MOBILE_QUERY,createNavigation,appLocation};
  vm.runInNewContext(readFileSync('public/legacy-app.js','utf8').replace(/^import .*;\r?\n/gm,''),context);
  return {components,context,root,state:app.config.globalProperties.$state};
}

const flushUi=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

test('case back returns to its explicit source, then the dashboard, without replaying month or browser history',()=>{
  for(const parent of ['kanban','calendar','cases']){
    const state:any={view:parent,selCase:null,caseParent:null,cal:{y:2026,m:9,sel:'2026-10-12'},scrolls:{calendar:{top:480}}};
    const nav=createNavigation(state,()=>null);nav.openCase('synthetic-case');
    assert.equal(state.view,'cases');assert.equal(state.caseParent,parent);
    assert.equal(nav.back(),true);assert.equal(state.view,parent);assert.equal(state.selCase,null);
    assert.equal(state.cal.sel,'2026-10-12');assert.equal(state.scrolls.calendar.top,480);
    nav.settled();assert.deepEqual(state.pageOrder,['kanban','cases','calendar']);
    if(parent!=='kanban'){assert.equal(nav.back(),true);assert.equal(state.view,'kanban');}
    assert.equal(nav.back(),false); // Only the app root may ask Android to confirm exit.
  }
});

test('back closes overlays before leaving edit, retains the versioned draft, and consumes back during save',()=>{
  const previous={storage:globalThis.sessionStorage,confirm:globalThis.confirm};globalThis.sessionStorage=storage();globalThis.confirm=()=>true;
  try{
    const ui=uiHarness(),editor=beginEdit(documentFor(1));changeEdit(editor,'未保存的触控草稿\n第二行');
    const state:any={view:'cases',selCase:'draft-case',caseParent:'cases',change:0};
    const view:any={...ui.components['cases-view'].methods,$state:state,dlg:true,editing:true,saving:false,docChange:0};
    const nav=createNavigation(state,()=>view);
    assert.equal(nav.back(),true);assert.equal(view.dlg,false);assert.equal(view.editing,true);
    view.saving=true;assert.equal(nav.back(),true);assert.equal(view.editing,true);assert.equal(nav.openView('kanban'),false);
    view.saving=false;assert.equal(nav.back(),true);assert.equal(view.editing,false);assert.equal(state.selCase,'draft-case');
    assert.equal(restoreDraft(beginEdit(documentFor(1))),'未保存的触控草稿\n第二行');
    assert.equal(nav.back(),true);assert.equal(state.selCase,null);assert.equal(state.view,'cases');
    state.view='calendar';view.monthPickerOpen=true;view.closeMonthPicker=()=>{view.monthPickerOpen=false;};
    assert.equal(nav.back(),true);assert.equal(state.view,'calendar');assert.equal(view.monthPickerOpen,false);
  }finally{globalThis.sessionStorage=previous.storage;globalThis.confirm=previous.confirm;}
});

test('a detail swipe returns to the source calendar and reorders pages only after the transition',()=>{
  const state:any={view:'calendar',selCase:null,caseParent:null},nav=createNavigation(state,()=>null);
  nav.openCase('case');assert.deepEqual(state.pageOrder,['calendar','cases','kanban']);
  nav.swiped('calendar');assert.equal(state.view,'calendar');assert.equal(state.selCase,null);
  assert.deepEqual(state.pageOrder,['calendar','cases','kanban']);
  nav.settled();assert.deepEqual(state.pageOrder,['kanban','cases','calendar']);
});

test('closing the detail carousel cannot perform a second parent back after the route already returned',()=>{
  const ui=uiHarness(),view:any={...ui.components['cases-view'].methods,$state:ui.state,selCase:'case'};
  ui.state.view='cases';ui.state.selCase='case';ui.state.caseParent='calendar';
  view.detailSwiped('list');assert.equal(ui.state.view,'calendar');assert.equal(ui.state.selCase,null);
  view.selCase=null;view.detailSwiped('list');assert.equal(ui.state.view,'calendar');
});

test('carousel state synchronization does not restart a running slide or let a direction lock block explicit navigation',async()=>{
  const calls:number[]=[];
  const view:any={...pageDeck.methods,items:['home','detail'],index:1,shown:[0],blockNext:true,
    $nextTick:async()=>{},engine:{activeIndex:1,allowSlideNext:false,allowSlidePrev:true,slideTo(i:number){assert.equal(this.allowSlideNext,true);calls.push(i);this.activeIndex=i;}}};
  await view.go(1);assert.deepEqual(calls,[]);
  view.engine.activeIndex=0;await view.go(1);assert.deepEqual(calls,[1]);assert.equal(view.engine.allowSlideNext,false);
  view.engine.touchEventsData={isTouched:true,isMoved:true,pointerId:99,touchId:42};view.motion={matches:true};
  view.cancelDrag();assert.equal(view.engine.touchEventsData.pointerId,null);assert.equal(view.engine.touchEventsData.touchId,null);
  assert.equal(view.engine.touchEventsData.isTouched,false);assert.deepEqual(view.shown,[1]);
});

test('rendering the same carousel keys cannot cancel a requested month transition',()=>{
  let synchronized=0;const view={sync:()=>synchronized++};
  pageDeck.watch.items.call(view,['prev','current','next'],['prev','current','next']);assert.equal(synchronized,0);
  pageDeck.watch.items.call(view,['calendar','cases','kanban'],['kanban','cases','calendar']);assert.equal(synchronized,1);
});

test('a cancelled overlapping contact cannot roll back a month already animating',()=>{
  let resets=0;
  const view:any={...pageDeck.methods,reset:true,index:1,shown:[1],engine:{animating:true,touchEventsData:{isTouched:false,pointerId:7,touchId:7}},move:()=>resets++};
  view.cancelDrag({type:'pointercancel'});assert.equal(resets,0);
  view.guardTouches({touches:[{},{}]});view.guardPointer({pointerType:'touch',isPrimary:false});assert.equal(resets,0);
  view.engine.animating=false;view.engine.touchEventsData.isTouched=true;
  view.cancelDrag({type:'pointercancel'});assert.equal(resets,1);assert.equal(view.engine.touchEventsData.isTouched,false);
  assert.equal(view.engine.touchEventsData.pointerId,null);assert.equal(view.engine.touchEventsData.touchId,null);
});

test('child gesture ownership survives capture-to-bubble microtasks and clears after dispatch',async()=>{
  const attributes=new Set<string>();let inert=false;
  const region={closest:()=>inert?{}:null,getBoundingClientRect:()=>({left:11,right:379,top:130,bottom:443,width:368,height:313})};
  const view:any={...pageDeck.methods,engine:{},$el:{querySelectorAll:()=>[region],
    toggleAttribute:(key:string,enabled:boolean)=>enabled?attributes.add(key):attributes.delete(key),removeAttribute:(key:string)=>attributes.delete(key)}};
  const contact={pointerType:'touch',isPrimary:true,clientX:15,clientY:200};
  view.guardPointer(contact);assert.equal(attributes.has('data-contact-owned'),true);
  await Promise.resolve();assert.equal(attributes.has('data-contact-owned'),true);
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(attributes.has('data-contact-owned'),false);
  inert=true;view.guardPointer(contact);assert.equal(attributes.has('data-contact-owned'),false);
  inert=false;view.guardPointer({...contact,clientY:500});assert.equal(attributes.has('data-contact-owned'),false);
});

test('month buttons cannot replace the destination of an active swipe',()=>{
  const ui=uiHarness(),methods=ui.components['calendar-view'].methods;
  ui.state.cal={y:2026,m:7,sel:'2026-08-31'};ui.state.mobile=true;
  const deck:any={...pageDeck.methods,engine:{animating:true,touchEventsData:{isTouched:false}}};let steps=0;
  const view:any={...methods,$state:ui.state,cal:ui.state.cal,pendingMonth:null,$refs:{monthPages:{isMoving:()=>deck.isMoving(),step:()=>steps++}}};
  view.navigateMonth(2026,6,'2026-07-01');assert.equal(view.pendingMonth,null);assert.equal(steps,0);
  view.monthSwiped('next');assert.equal(ui.state.cal.m,8);
  deck.engine.animating=false;view.navigateMonth(2026,7,'2026-08-01');assert.equal(steps,1);
  view.monthSwiped('prev');assert.equal(ui.state.cal.m,7);assert.equal(ui.state.cal.sel,'2026-08-01');assert.equal(view.pendingMonth,null);
});

test('enabling reduced motion finishes the existing month destination without leaving it busy',()=>{
  let finished=0;
  const view:any={...pageDeck.methods,reset:true,motion:{matches:true},engine:{animating:true,params:{speed:260},transitionEnd(){finished++;this.animating=false;}}};
  view.updateMotion();assert.equal(finished,1);assert.equal(view.engine.params.speed,0);assert.equal(view.isMoving(),false);
  view.updateMotion();assert.equal(finished,1);
});

test('prepared panes do not request reactive mounting work while the finger moves',()=>{
  const pane:any={...pageDeck.methods,lazy:true,preload:true,items:['kanban','cases','calendar'],shown:[0]};
  const mounted=pane.shown;pane.show(1);pane.show(2);assert.equal(pane.shown,mounted);
  pane.preload=false;pane.show(1);assert.deepEqual(pane.shown,[0,1]);
  const months:any={...pageDeck.methods,lazy:false,items:['prev','current','next'],shown:[1]};
  const prepared=months.shown;months.show(0);assert.equal(months.shown,prepared);
});

test('neighbour preparation waits for first-screen reads and an idle gesture before mounting',async()=>{
  const ui=uiHarness(),timers:Function[]=[],swiper={touchEventsData:{isTouched:true},animating:false};
  ui.context.document={querySelector:()=>({swiper})};ui.context.setTimeout=(callback:Function)=>{timers.push(callback);};
  ui.context.DB.calendar=()=>({loaded:false});ui.context.DB.feed=()=>({ensure:async()=>{}});ui.context.DB.readCalendar=async()=>{};
  let resolve!:()=>void;const receipt=new Promise<void>(r=>{resolve=r;});
  ui.context.afterFirstScreen([receipt]);await flushUi();assert.equal(timers.length,0);assert.equal(ui.state.viewsReady,false);
  resolve();await flushUi();timers.shift()!();assert.equal(ui.state.viewsReady,false);
  swiper.touchEventsData.isTouched=false;swiper.animating=true;timers.shift()!();assert.equal(ui.state.viewsReady,false);
  swiper.animating=false;timers.shift()!();assert.equal(ui.state.viewsReady,true);
});

test('retained views refresh stale reads only when selected again, without focus refresh or draft replacement',()=>{
  const ui=uiHarness();
  for(const name of ['kanban','cases','calendar']){
    const component=ui.components[name+'-view'],calls:string[]=[];
    const view:any={...component.methods,$state:{change:2},seenChange:1,submitting:false,selCount:0,doneOpen:false,editing:false,saving:false,
      loadCases:()=>{calls.push('cases');return Promise.resolve();},loadSchedules:()=>{calls.push('schedules');return Promise.resolve();},
      loadTodos:()=>{calls.push('todos');return Promise.resolve();},loadList:()=>calls.push('list'),loadMd:()=>calls.push('document'),loadCalendar:()=>calls.push('calendar')};
    component.watch.active.call(view,false);assert.deepEqual(calls,[]);
    component.watch.active.call(view,true);assert.ok(calls.length);const count=calls.length;
    component.watch.active.call(view,true);assert.equal(calls.length,count);
    if(name==='cases'){view.$state.change++;view.editing=true;component.watch.active.call(view,true);assert.equal(calls.filter(x=>x==='document').length,1);}
  }
});

test('textarea inputs synchronously track IME replacements, no-op compositionend and toolbar edits',()=>{
  const oldStorage=globalThis.sessionStorage;globalThis.sessionStorage=storage();
  try{
    const ui=uiHarness(),component=ui.components['cases-view'];ui.context.DB.changeEdit=changeEdit;
    const rows=[{line_id:'first',text:'同文'},{line_id:'second',text:'同文'},{line_id:'last',text:''}];
    const editor=beginEdit({ref:'ime',revision:7,lines:rows,text:'同文\n同文\n'});
    const target={selectionStart:3,selectionEnd:5,value:editor.text};
    const view:any={...component.methods,editing:true,saving:false,dbEditor:editor,editText:editor.text,editError:'',
      $refs:{editor:target},$nextTick:()=>{}};
    const input=(start:number,end:number,value:string,inputType='insertCompositionText')=>{
      Object.assign(target,{selectionStart:start,selectionEnd:end});view.beforeNoteInput({target,inputType});
      target.value=value;view.noteInput({target,inputType});
      assert.equal(editor.text,value);assert.equal(view.editText,value);assert.equal(view.editError,'');
    };
    // Multiple inputs in one tick must use each input's own range. A watcher
    // would see only the last value/range and compare it against the old text.
    input(3,5,'同文\nni\n');input(5,5,'同文\n你\n');input(4,4,'同文\n你好\n');
    view.noteInput({target,inputType:''});assert.equal(editor.edit,null);
    assert.deepEqual(editor.rows.map(l=>l.line_id),['first','second','last']);
    target.selectionStart=3;view.insertTodo();
    assert.equal(editor.text,'同文\n- [ ] 你好\n');assert.equal(editor.rows[1].line_id,'second');
    view.insertTodo();assert.equal(editor.text,'同文\n你好\n');
    // An exact structural selection remains authoritative for duplicate rows.
    input(0,3,'你好\n','deleteContentForward');assert.deepEqual(editor.rows.map(l=>l.line_id),['second','last']);
    assert.equal(JSON.parse(sessionStorage.getItem('case-notes:draft:ime')!).revision,7);
  }finally{globalThis.sessionStorage=oldStorage;}
});

test('insertTodo restores the caret and the editing viewport',()=>{
  const ui=uiHarness(),methods=ui.components['cases-view'].methods;
  const target:any={selectionStart:2,selectionEnd:2,scrollTop:250,focusCalls:0,range:null,
    focus(){this.focusCalls++;},setSelectionRange(start:number,end:number){this.range=[start,end];}};
  const view:any={...methods,editing:true,saving:false,$state:{mobile:true},dbEditor:{edit:null},editText:'甲\n乙',$refs:{editor:target},$nextTick:(fn:()=>void)=>fn()};
  methods.insertTodo.call(view);
  assert.equal(view.editText,'甲\n- [ ] 乙');
  assert.deepEqual(target.range,[8,8]);     // 光标落在目标行复选框之后
  assert.equal(target.focusCalls,0);        // 手机端不主动抢焦点,避免输入法收起又弹回
  assert.equal(target.scrollTop,250);       // 重写 value 后还原编辑时的视口
  target.selectionStart=8;methods.insertTodo.call(view);
  assert.equal(view.editText,'甲\n乙');
  assert.deepEqual(target.range,[2,2]);     // 取消待办后光标回到该行行首
});

test('toolbar touch toggles on the first contact, restores the viewport, and never doubles it',()=>{
  const ui=uiHarness(),methods=ui.components['cases-view'].methods;
  const target:any={selectionStart:2,selectionEnd:2,scrollTop:250,focusCalls:0,range:null,
    focus(){this.focusCalls++;},setSelectionRange(start:number,end:number){this.range=[start,end];}};
  const view:any={...methods,editing:true,saving:false,$state:{mobile:true},dbEditor:{edit:null},editText:'甲\n乙',$refs:{editor:target},$nextTick:(fn:()=>void)=>fn()};
  const event=(x:number,y:number)=>({changedTouches:[{clientX:x,clientY:y}],target:{closest:()=>({getAttribute:()=>'todo'})}});
  methods.toolbarTouchStart.call(view,event(10,10));  // 记下触摸起点与当时的视口
  target.scrollTop=0;                                  // 模拟重写 value 把滚动位置归零
  methods.toolbarTouchEnd.call(view,event(11,11));     // 触摸按 touchstart 目标派发,首次接触即切换
  assert.equal(view.editText,'甲\n- [ ] 乙');
  assert.equal(target.scrollTop,250);                  // 还原触摸开始时的视口
  methods.toolbarClick.call(view,'todo');              // 紧随的合成 click 不重复执行
  assert.equal(view.editText,'甲\n- [ ] 乙');
  const moved:any={...view,editText:'甲\n- [ ] 乙'};
  target.scrollTop=100;
  methods.toolbarTouchStart.call(moved,event(10,10));
  methods.toolbarTouchEnd.call(moved,event(10,80));    // 从工具栏起手纵向滚动:不触发
  assert.equal(moved.editText,'甲\n- [ ] 乙');
});

test('cases-search-input debounces latin input, filters IME composition and keeps explicit clear',()=>{
  const ui=uiHarness(),component=ui.components['cases-search-input'];
  // Component methods close over the vm harness global, so fake timers there (not in this realm).
  const realSetTimeout=ui.context.setTimeout,realClearTimeout=ui.context.clearTimeout;
  let now=0,seq=1;const timers=new Map<number,{fn:()=>void,at:number}>();
  ui.context.setTimeout=(fn:()=>void,ms:number)=>{const id=seq++;timers.set(id,{fn,at:now+ms});return id as any;};
  ui.context.clearTimeout=(id:number)=>{timers.delete(id);};
  const advance=(ms:number)=>{now+=ms;const due=[...timers.entries()].filter(([,t])=>t.at<=now).sort((a,b)=>a[1].at-b[1].at);for(const [id,t] of due){timers.delete(id);t.fn();}};
  try{
    const emitted:string[]=[];
    const view:any={modelValue:'',...component.data.call({modelValue:''}),
      $emit:(_event:string,value:string)=>{emitted.push(value);view.modelValue=value;component.watch.modelValue.call(view,value);},
      $el:{querySelector:()=>null},$nextTick:(fn:()=>void)=>fn()};
    Object.assign(view,component.methods);
    const input=(value:string,isComposing=false)=>view.onInput({target:{value},isComposing});
    // Latin input debounces to a single trailing commit.
    input('a');input('ab');assert.equal(emitted.length,0);assert.equal(timers.size,1);
    advance(250);assert.deepEqual(emitted,['ab']);assert.equal(timers.size,0);
    // Echo of the committed value schedules nothing.
    input('ab');assert.equal(timers.size,0);assert.equal(emitted.length,1);
    // IME composition updates the box without committing; compositionend debounces.
    view.onCompositionStart();assert.equal(timers.size,0);
    view.onInput({target:{value:'ab+ni'},isComposing:true});assert.equal(view.draft,'ab+ni');assert.equal(emitted.length,1);
    advance(500);assert.equal(emitted.length,1);assert.equal(timers.size,0);
    view.onCompositionEnd({target:{value:'ab+你'}});assert.equal(emitted.length,1);assert.equal(timers.size,1);
    advance(200);assert.equal(emitted.length,1);advance(100);assert.deepEqual(emitted,['ab','ab+你']);
    // Rapid successive compositions coalesce into one commit.
    view.onCompositionStart();view.onCompositionEnd({target:{value:'ab+你好'}});
    view.onCompositionStart();view.onCompositionEnd({target:{value:'ab+你好啊'}});
    advance(250);assert.deepEqual(emitted,['ab','ab+你','ab+你好啊']);
    // An isComposing input without compositionstart still cancels a pending latin timer.
    input('ab+你好啊x');advance(100);assert.equal(timers.size,1);
    view.onInput({target:{value:'ab+你好啊x-pin'},isComposing:true});assert.equal(timers.size,0);
    advance(500);assert.deepEqual(emitted,['ab','ab+你','ab+你好啊']);
    view.onCompositionStart();view.onCompositionEnd({target:{value:'ab+你好啊x'}});advance(250);
    assert.deepEqual(emitted,['ab','ab+你','ab+你好啊','ab+你好啊x']);
    // Explicit clear during composition suppresses the trailing stale compositionend.
    view.onCompositionStart();view.onInput({target:{value:'ab+你好啊x-pin'},isComposing:true});
    view.clear();assert.deepEqual(emitted.at(-1),'');assert.equal(view.draft,'');
    const count=emitted.length;
    view.onCompositionEnd({target:{value:'stale-buffer'}});assert.equal(emitted.length,count);assert.equal(view.draft,'');
    // Typing after clear cancels suppression: new intent wins.
    view.onCompositionStart();view.onInput({target:{value:'pin'},isComposing:true});
    view.clear();view.onInput({target:{value:'new'}});view.onCompositionEnd({target:{value:'new文'}});
    advance(250);assert.deepEqual(emitted.at(-1),'new文');
    // Native search event commits immediately; search during composition stays silent.
    input('q');assert.equal(timers.size,1);view.onSearch({target:{value:'q'}});assert.deepEqual(emitted.at(-1),'q');assert.equal(timers.size,0);
    view.onCompositionStart();view.onSearch({target:{value:'q-pin'},isComposing:true} as any);assert.deepEqual(emitted.at(-1),'q');
    view.onCompositionEnd({target:{value:'q'}});advance(250);
    // External updates sync when idle but never disturb an active composition.
    view.modelValue='ext';component.watch.modelValue.call(view,'ext');assert.equal(view.draft,'ext');
    view.onCompositionStart();component.watch.modelValue.call(view,'other');assert.equal(view.draft,'ext');
    view.onCompositionEnd({target:{value:'ext+自'}});advance(250);assert.deepEqual(emitted.at(-1),'ext+自');
    // Unmount drops a pending timer so no late commit fires.
    input('ext+自x');assert.equal(timers.size,1);component.unmounted.call(view);assert.equal(timers.size,0);
    // Parent views load synchronously on committed search (no second debounce layer).
    for(const [name,load] of [['cases-view','loadList'],['kanban-view','loadCases']] as const){
      const parent=ui.components[name];let calls=0;
      parent.watch['$state.casesSearch'].call({[load]:()=>calls++});
      assert.equal(calls,1);
    }
  }finally{ui.context.setTimeout=realSetTimeout;ui.context.clearTimeout=realClearTimeout;}
});

test('no-change input consumes its range so a subsequent programmatic edit cannot inherit it',()=>{
  const oldStorage=globalThis.sessionStorage;globalThis.sessionStorage=storage();
  try{
    const editor=beginEdit(documentFor(1));editor.edit={start:6,end:6,inputType:'insertCompositionText'};
    changeEdit(editor,editor.text);assert.equal(editor.edit,null);
    changeEdit(editor,'- [ ] 第一行\n第二行');assert.deepEqual(editor.rows.map(l=>l.line_id),['first','second']);
  }finally{globalThis.sessionStorage=oldStorage;}
});
test('calendar keyboard navigation clamps month-end dates, crosses years and keeps focus on the selected day',()=>{
  const ui=uiHarness(),methods=ui.components['calendar-view'].methods,focused:string[]=[];
  const view:any={$state:ui.state,$el:{querySelector:(selector:string)=>({focus:()=>focused.push(selector)})},$nextTick:(fn:()=>void)=>fn(),...methods};
  let prevented=0;
  const key=(key:string,date:string)=>view.dayKey({key,preventDefault:()=>prevented++},date);
  key('PageDown','2024-01-31');assert.equal(ui.state.cal.sel,'2024-02-29');
  key('PageDown','2025-01-31');assert.equal(ui.state.cal.sel,'2025-02-28');
  key('ArrowRight','2026-12-31');assert.equal(ui.state.cal.sel,'2027-01-01');assert.equal(ui.state.cal.y,2027);assert.equal(ui.state.cal.m,0);
  key('ArrowUp','2027-01-01');assert.equal(ui.state.cal.sel,'2026-12-25');
  key('Home','2026-12-25');assert.equal(ui.state.cal.sel,'2026-12-21');
  key('End','2026-12-21');assert.equal(ui.state.cal.sel,'2026-12-27');
  key('Tab','2026-12-27');assert.equal(prevented,6);assert.equal(focused.length,6);assert.equal(focused.at(-1),'[data-date="2026-12-27"]');
  view.changeMonth('2027-02');assert.equal(ui.state.cal.sel,'2027-02-01');
  view.changeMonth('2027-13');view.changeMonth('');assert.equal(ui.state.cal.sel,'2027-02-01');
  view.jumpToWeek({start:new Date(2026,2,30),year:2026},{firstDate:'2026-04-02'},0);
  assert.equal(ui.state.cal.m,3);assert.equal(ui.state.cal.sel,'2026-04-02');
});

test('month picker previews years without changing the calendar and commits a validated month with focus restored',()=>{
  const ui=uiHarness(),component=ui.components['calendar-view'],focused:string[]=[];
  ui.state.cal={y:2026,m:9,sel:'2026-10-12'};
  const view:any={$state:ui.state,cal:ui.state.cal,monthPickerOpen:false,pickerYear:2026,
    $refs:{monthTrigger:{focus:()=>focused.push('trigger')},monthPicker:{querySelector:(selector:string)=>({focus:()=>focused.push(selector)})}},
    $nextTick:(fn:()=>void)=>fn(),...component.methods};
  view.toggleMonthPicker();assert.equal(view.monthPickerOpen,true);assert.equal(focused.at(-1),'[data-month="9"]');
  view.setPickerYear({target:{value:'2024'}});assert.equal(view.pickerYear,2024);assert.equal(ui.state.cal.sel,'2026-10-12');
  for(const value of ['999','10000','20ab','']){const target={value};view.setPickerYear({target});assert.equal(target.value,'2024');}
  let prevented=0;view.pickerMonthKey({key:'ArrowDown',preventDefault:()=>prevented++},9);assert.equal(focused.at(-1),'[data-month="11"]');
  view.pickMonth(1);assert.equal(ui.state.cal.sel,'2024-02-01');assert.equal(view.monthPickerOpen,false);assert.equal(focused.at(-1),'trigger');
  view.toggleMonthPicker();view.monthPickerKey({key:'Escape',preventDefault:()=>prevented++,stopPropagation:()=>{}});
  assert.equal(view.monthPickerOpen,false);assert.equal(ui.state.cal.sel,'2024-02-01');assert.equal(prevented,2);
  view.$refs.pickerYearInput={value:'2026'};view.stepPickerYear(1);assert.equal(view.pickerYear,2027);
  view.$refs.pickerYearInput.value='2028';view.pickMonth(1);assert.equal(ui.state.cal.sel,'2028-02-01');
  view.$refs.pickerYearInput.value='9999';view.stepPickerYear(1);assert.equal(view.pickerYear,9999);
  view.$refs.pickerYearInput.value='1000';view.stepPickerYear(-1);assert.equal(view.pickerYear,1000);
});

test('calendar month links normalize missing, invalid and out-of-month selections',()=>{
  const ui=uiHarness();
  for(const hash of ['#/calendar/2024-02','#/calendar/2024-02/2024-02-30','#/calendar/2024-02/2024-03-01']){
    ui.context.location.hash=hash;vm.runInNewContext('parseHash()',ui.context);assert.equal(ui.state.cal.sel,'2024-02-01');
  }
  ui.context.location.hash='#/calendar/2024-02/2024-02-29';vm.runInNewContext('parseHash()',ui.context);assert.equal(ui.state.cal.sel,'2024-02-29');
});

function calendarHarness(){
  // Like Vue, wrap assigned data so the stored value has a different identity
  // from the raw value returned by the first in-flight read.
  const wrap=(value:any)=>new Proxy(value,{set(target,key,data){target[key]=key==='data'&&data?new Proxy(data,{}):data;return true;}});
  const ui=uiHarness(),cache=createReadCache(wrap),requests:string[]=[],timers:(()=>void)[]=[];
  const pending=new Map<string,{resolve:(data:any)=>void,reject:(error:Error)=>void}>();
  ui.context.setTimeout=(fn:()=>void)=>{timers.push(fn);};
  ui.context.DB.calendar=(y:number,m:number)=>cache.entry(`${y}-${m}`);
  ui.context.DB.readCalendar=async(y:number,m:number)=>{await Promise.resolve();return cache.entry(`${y}-${m}`).ensure(()=>{
    const key=`${y}-${m}`;requests.push(key);
    return new Promise((resolve,reject)=>{pending.set(key,{resolve,reject});});
  });};
  ui.context.DB.feed=()=>({ensure:async()=>{}});
  const component=ui.components['calendar-view'];
  const view:any={$state:ui.state,...component.data.call({$state:ui.state})};Object.assign(view,component.methods);
  const finish=(key:string)=>pending.get(key)!.resolve({items:[],dateCounts:{[key]:1}});
  return {...ui,cache,requests,timers,pending,component,view,finish};
}

test('calendar prefetch waits for the month and first screen, loads only six neighbours across years and shares visible reads',async()=>{
  const ui=calendarHarness(),{y,m}=ui.state.cal,key=`${y}-${m}`;
  let finishStats:(data:any)=>void=()=>{};
  ui.context.DB.web=()=>new Promise(resolve=>{finishStats=resolve;});
  ui.component.mounted.call(ui.view);await flushUi();
  assert.deepEqual(ui.requests,[key]);assert.equal(ui.timers.length,0);
  ui.finish(key);await flushUi();assert.deepEqual(ui.requests,[key]);assert.equal(ui.timers.length,0);
  finishStats({counts:{}});await flushUi();
  assert.equal(ui.timers.length,1);ui.timers.shift()!();await flushUi();
  const neighbours=[-1,1,-2,2,-3,3].map(offset=>{const d=new Date(y,m+offset,1);return `${d.getFullYear()}-${d.getMonth()}`;});
  assert.deepEqual(ui.requests,[key,...neighbours]);
  const next=new Date(y,m+1,1);ui.state.cal.y=next.getFullYear();ui.state.cal.m=next.getMonth();
  const visible=ui.view.loadCalendar();await flushUi();assert.equal(ui.requests.length,7);
  for(const month of neighbours)ui.finish(month);
  await visible;await flushUi();
  const edge=new Date(y,m+4,1),edgeKey=`${edge.getFullYear()}-${edge.getMonth()}`;
  assert.deepEqual(ui.requests,[key,...neighbours,edgeKey]);
  ui.finish(edgeKey);await flushUi();assert.equal(ui.requests.length,8);
  await ui.view.loadCalendar();ui.component.activated.call(ui.view);await flushUi();
  assert.equal(ui.requests.length,8);
});

test('calendar prefetch failure retains explicit retry and old responses cannot replace the selected month or start more prefetch',async()=>{
  const ui=calendarHarness(),{y,m}=ui.state.cal,key=`${y}-${m}`;
  ui.component.mounted.call(ui.view);await flushUi();ui.finish(key);await flushUi();
  ui.timers.shift()!();await flushUi();
  const failed=new Date(y,m+1,1),failedKey=`${failed.getFullYear()}-${failed.getMonth()}`;
  ui.pending.get(failedKey)!.reject(new Error('offline'));await flushUi();
  ui.state.cal.y=failed.getFullYear();ui.state.cal.m=failed.getMonth();
  await ui.view.loadCalendar();assert.equal(ui.view.calendarEntry.error,'offline');assert.equal(ui.requests.length,7);
  const retry=ui.view.loadCalendar(true);await flushUi();assert.equal(ui.requests.length,8);
  ui.finish(failedKey);await retry;await flushUi();assert.equal(ui.view.calendarEntry.loaded,true);
  const far=new Date(y,m+12,1),farKey=`${far.getFullYear()}-${far.getMonth()}`;
  ui.state.cal.y=far.getFullYear();ui.state.cal.m=far.getMonth();const old=ui.view.loadCalendar();await flushUi();
  ui.state.cal.y=y;ui.state.cal.m=m;await ui.view.loadCalendar();await flushUi();
  const count=ui.requests.length,counts=ui.view.lastDateCounts;
  ui.finish(farKey);await old;await flushUi();
  assert.equal(ui.requests.length,count);assert.equal(ui.view.lastDateCounts,counts);assert.equal(ui.view.calendarEntry,ui.cache.entry(key));
});
test('collapsed recent activity shows both stats counts without reading records and opens the selected cached window',async()=>{
  const fetchBefore=globalThis.fetch;invalidateReads();
  const {components,context,root,state}=uiHarness(),requests:any[]=[];
  context.DB.feed=feed;
  globalThis.fetch=async(path:any,options:any)=>{
    const args=JSON.parse(options.body);requests.push({path,args});
    return Response.json({ok:true,data:{items:[{line_id:'activity-count'}],matched_count:args.days===30?25:3,has_more:false,next_cursor:null}});
  };
  context.DB.web=async()=>({counts:{activity_7:3,activity_30:25}});
  try{
    const component=components['kanban-view'];
    const view:any={$state:state,...component.data.call({$state:state})};Object.assign(view,component.methods);
    await root.methods.loadStats();
    assert.equal(component.computed.activityCount.call(view),3);assert.equal(requests.length,0);
    view.doneDays=30;component.watch.doneDays.call(view);
    assert.equal(component.computed.activityCount.call(view),25);assert.equal(requests.length,0);
    view.doneOpen=true;await component.watch.doneOpen.call(view,true);
    assert.equal(requests.length,1);assert.equal(requests[0].args.days,30);assert.equal(view.activityFeed.items.length,1);
    view.doneOpen=false;view.doneDays=7;component.watch.doneDays.call(view);
    assert.equal(component.computed.activityCount.call(view),3);assert.equal(requests.length,1);
    view.doneOpen=true;await component.watch.doneOpen.call(view,true);
    assert.equal(requests.length,2);assert.equal(requests[1].args.days,7);
    await component.watch.doneOpen.call(view,true);assert.equal(requests.length,2);
    view.doneOpen=false;state.counts={activity_7:4,activity_30:26};
    assert.equal(component.computed.activityCount.call(view),4);
  }finally{globalThis.fetch=fetchBefore;invalidateReads();}
});

test('all editor actions are guarded while a receipt is pending, and the submitted text becomes the saved preview',async()=>{
  const {components,context}=uiHarness();let release:(r:any)=>void=()=>{};
  context.DB.save=()=>new Promise(resolve=>{release=resolve;});
  const view:any={$state:{selCase:'c',change:0},editError:'',dbDoc:{ref:'c',case:{id:'c',name:'案',status:'在办'},text:'旧文'},
    dbEditor:{rows:[{line_id:'l',text:'新文'}]},editText:'新文',editing:true,saving:false,$refs:{},$nextTick:()=>{}};
  const methods=components['cases-view'].methods,pending=methods.saveEdit.call(view);
  for(const action of ['insertTodo','openDlg','dlgOk','insertNextLine','cancelEdit','backToList'])methods[action].call(view,'新日程');
  assert.equal(view.editText,'新文');assert.equal(view.editing,true);assert.equal(view.$state.selCase,'c');
  release({case:{id:'c',name:'案',status:'在办'},document_revision:2,lines:[{line_id:'l',version:2}]});await pending;
  assert.equal(view.mdText,'新文');assert.equal(view.editing,false);
});
test('failed logout stays on the current page with a retryable UI state',async()=>{
  const {root,context}=uiHarness();context.DB.logout=async()=>{throw new Error('offline');};
  const view:any={$state:{loggingOut:false}};await root.methods.logout.call(view);
  assert.equal(context.location.href,undefined);assert.equal(view.$state.loggingOut,false);
});
test('acknowledged logout removes rendered private state before replacing the page',async()=>{
  const {root,context}=uiHarness();let destination='';context.location.replace=(url:string)=>{destination=url;};context.DB.logout=async()=>{};
  const view:any={$state:{loggingOut:false,D:{private:true},selCase:'c',counts:{todos:1},scrolls:{cases:{}},casesSearch:'私有关键词'}};
  await root.methods.logout.call(view);assert.equal(destination,'/login.html');assert.equal(view.$state.D,null);assert.equal(view.$state.selCase,null);
  assert.equal(Object.keys(view.$state.counts).length,0);assert.equal(Object.keys(view.$state.scrolls).length,0);assert.equal(view.$state.casesSearch,'');
});

test('note save keeps case pages, row identity, cursor and search snippet while invalidating schedules',async()=>{
  const fetchBefore=globalThis.fetch,sent:any[]=[];
  invalidateReads();
  globalThis.fetch=async(path:any,options:any)=>{
    const args=JSON.parse(options.body);sent.push({path,args});
    const items=path.endsWith('/cases')?(args.cursor?[{id:'save-second',name:'第二案',recent_activity:'2026-10-01'}]:[{id:'save-first',name:'第一案',recent_activity:'2026-10-01'}]):[{line_id:'event'}];
    return Response.json({ok:true,data:{items,matched_count:3,has_more:true,next_cursor:args.cursor?'page-3':'page-2'}});
  };
  try{
    const list=feed('cases',{group:'active',query:'保存定位回归'}),schedule=feed('schedules',{mode:'all',today:'2026-10-11'});
    await list.ensure();await list.load();await schedule.ensure();
    const rows=list.items,first=rows[0],selected=rows[1],cursor=list.cursor,count=sent.length;
    invalidateReads({ref:selected.id,case:{id:selected.id,name:'第二案',recent_activity:'2026-10-12',document_revision:2},lines:[{text:'2026.10.12 保存定位回归 最新内容'}]});
    await list.ensure();
    assert.equal(sent.length,count);assert.equal(list.items,rows);assert.equal(list.items[0],first);assert.equal(list.items[1],selected);
    assert.equal(list.cursor,cursor);assert.equal(list.total,3);assert.equal(list.hasMore,true);
    assert.equal(selected.recent_activity,'2026-10-12');assert.match(selected.match_text,/最新内容/);
    await schedule.ensure();assert.equal(sent.length,count+1);
    await list.load();assert.equal(sent.at(-1).args.cursor,cursor);assert.equal(list.items.length,2);
  }finally{globalThis.fetch=fetchBefore;invalidateReads();}
});

test('a case next-page response from before save cannot overwrite the updated row or clear loaded pages',async()=>{
  const fetchBefore=globalThis.fetch;let release:(value:Response)=>void=()=>{};
  invalidateReads();
  globalThis.fetch=async(_path:any,options:any)=>{
    const args=JSON.parse(options.body);
    if(args.cursor)return new Promise(resolve=>{release=resolve;});
    return Response.json({ok:true,data:{items:[{id:'save-race',document_revision:1}],matched_count:2,has_more:true,next_cursor:'next'}});
  };
  try{
    const list=feed('cases',{group:'active',query:'保存竞态回归'});await list.ensure();const rows=list.items;
    const pending=list.load();await Promise.resolve();
    invalidateReads({ref:'save-race',case:{id:'save-race',document_revision:2},lines:[]});
    release(Response.json({ok:true,data:{items:[{id:'save-race',document_revision:1},{id:'stale'}],matched_count:2,has_more:false,next_cursor:null}}));
    await pending;await list.ensure();
    assert.equal(list.items,rows);assert.deepEqual(list.items.map((c:any)=>c.id),['save-race']);
    assert.equal(rows[0].document_revision,2);assert.equal(list.cursor,'next');assert.equal(list.loading,false);
  }finally{globalThis.fetch=fetchBefore;invalidateReads();}
});

test('returning to a selected board reloads all affected panels and removes deleted or changed selections',async()=>{
  const ui=uiHarness(),component=ui.components['kanban-view'],calls:string[]=[];
  const todoFeed={items:[{line_id:'removed',version:1},{line_id:'changed',version:1},{line_id:'kept',version:2}],error:'',
    ensure:async()=>{calls.push('todos');todoFeed.items=[{line_id:'changed',version:2},{line_id:'kept',version:2},{line_id:'added',version:1}];}};
  const view:any={...component.methods,$state:ui.state,seenChange:0,submitting:false,selCount:3,doneOpen:true,todoFeed,
    sel:{removed:true,changed:true,kept:true},loadCases:async()=>{calls.push('cases');},loadSchedules:async()=>{calls.push('schedules');},loadActivity:async()=>{calls.push('activity');}};
  ui.state.change=1;component.watch.active.call(view,true);await flushUi();
  assert.deepEqual(calls,['cases','schedules','todos','activity']);assert.deepEqual(view.sel,{kept:true});
  component.watch.active.call(view,true);assert.equal(calls.length,4);
});

test('invalidated lists reread the browsed extent even when continuation fires before view refresh',async()=>{
  const previous=globalThis.fetch;invalidateReads();let updated=false;const cursors:(string|null)[]=[];
  globalThis.fetch=async(_path:any,options:any)=>{
    const args=JSON.parse(options.body);cursors.push(args.cursor??null);
    return Response.json({ok:true,data:{items:args.cursor?[{line_id:'second-page',version:updated?2:1}]:[{line_id:updated?'added':'removed',version:1}],
      matched_count:3,has_more:!args.cursor,next_cursor:args.cursor?null:'next'}});
  };
  try{
    const list=feed('todos');await list.ensure();await list.load();updated=true;
    invalidateReads({ref:'c',case:{id:'c'},lines:[]});await list.load();
    assert.deepEqual(cursors,[null,'next',null,'next']);assert.deepEqual(list.items,[{line_id:'added',version:1},{line_id:'second-page',version:2}]);
    await list.ensure();assert.equal(cursors.length,4);
  }finally{globalThis.fetch=previous;invalidateReads();}
});

test('a late case read cannot claim the revision of a newer write',async()=>{
  const ui=uiHarness();let release:(doc:any)=>void=()=>{};ui.context.DB.readCase=()=>new Promise(resolve=>{release=resolve;});
  ui.state.selCase='c';
  const view:any={...ui.components['cases-view'].methods,$state:ui.state,mdSeq:0,mdText:'当前正文',dbDoc:{revision:2},docChange:0,editing:false,saving:false};
  const pending=view.loadMd(true);ui.state.change++;release({case:{id:'c',status:'在办'},revision:1,text:'旧正文'});await pending;
  assert.equal(view.mdText,'当前正文');assert.equal(view.dbDoc.revision,2);assert.equal(view.docChange,0);assert.equal(view.mdLoading,false);
});

test('a statistics failure from before a write does not replace the fresh loading state',async()=>{
  const ui=uiHarness();let fail:(error:Error)=>void=()=>{},finish:(result:any)=>void=()=>{};let reads=0;
  ui.context.DB.web=()=>++reads===1?new Promise((_r,reject)=>{fail=reject;}):new Promise(resolve=>{finish=resolve;});
  const pending=ui.context.loadStats();ui.context.changed();fail(new Error('旧请求失败'));await pending;await flushUi();
  assert.equal(ui.state.statsError,'');assert.equal(ui.state.statsLoading,true);assert.equal(reads,2);
  finish({counts:{todos:0}});await flushUi();assert.equal(ui.state.counts.todos,0);assert.equal(ui.state.statsLoading,false);
});

test('calendar write invalidation fences a late month response while async session validation still updates counts',async()=>{
  const ui=calendarHarness(),{y,m}=ui.state.cal,key=`${y}-${m}`;
  const old=ui.view.loadCalendar();await flushUi();const releaseOld=ui.pending.get(key)!.resolve;
  ui.cache.invalidate();ui.state.change++;const fresh=ui.view.loadCalendar();await flushUi();
  ui.finish(key);await fresh;const counts=ui.view.lastDateCounts;assert.equal(counts[key],1);
  releaseOld({items:[],dateCounts:{stale:9}});await old;assert.equal(ui.view.lastDateCounts,counts);assert.equal(ui.view.calendarEntry.data.dateCounts[key],1);
});

test('completion fences an earlier page read and conflict refreshes stale selections without losing successful receipts',async()=>{
  for(const conflict of [false,true]){
    const ui=uiHarness(),component=ui.components['kanban-view'];let aborted=false,refreshes=0,kept=0;
    const todoFeed={items:[{line_id:'done',version:1},{line_id:'conflict',version:1}],total:2,generation:4,loading:true,pending:Promise.resolve(),controller:{abort:()=>{aborted=true;}}};
    ui.context.DB.complete=async(t:any)=>{assert.equal(aborted,true);if(conflict&&t.line_id==='conflict'){const e:any=new Error('版本冲突');e.code='VERSION_CONFLICT';throw e;}};
    ui.context.DB.keepFeed=()=>kept++;
    const view:any={...component.methods,$state:ui.state,todoFeed,sel:{done:true,conflict:true},submitting:false,
      get todos(){return todoFeed.items.map(t=>({...t,文本:t.line_id}));},refresh:()=>{assert.equal(view.submitting,false);refreshes++;}};
    await view.submitTodos();assert.equal(todoFeed.generation,5);assert.equal(todoFeed.loading,false);assert.equal(todoFeed.pending,null);
    assert.deepEqual(todoFeed.items.map(t=>t.line_id),conflict?['conflict']:[]);assert.equal(kept,conflict?0:1);assert.equal(refreshes,1);
  }
});

test('concurrent refresh consumers share every page and an invalidated refresh cannot clear the new job',async()=>{
  const previous=globalThis.fetch;invalidateReads();let initial=true;const pending:{args:any;resolve:(r:Response)=>void}[]=[];
  globalThis.fetch=async(_path:any,options:any)=>{
    const args=JSON.parse(options.body);
    if(!initial)return new Promise(resolve=>pending.push({args,resolve}));
    return Response.json({ok:true,data:{items:[{line_id:args.cursor?'b':'a'}],matched_count:2,has_more:!args.cursor,next_cursor:args.cursor?null:'next'}});
  };
  const response=(line_id:string,next_cursor:string|null)=>Response.json({ok:true,data:{items:[{line_id}],matched_count:2,has_more:!!next_cursor,next_cursor}});
  try{
    const list=feed('todos');await list.ensure();await list.load();const rows=list.items;initial=false;invalidateReads();
    const old=list.ensure();assert.equal(old,list.ensure());await flushUi();assert.equal(pending.length,1);
    pending[0].resolve(response('old-first','next'));await flushUi();assert.equal(pending.length,2);assert.equal(list.items,rows);
    invalidateReads();const fresh=list.ensure();await flushUi();assert.equal(pending.length,3);
    pending[1].resolve(response('old-second',null));await old;assert.equal(list.refreshJob,fresh);
    pending[2].resolve(response('fresh',null));await fresh;
    assert.deepEqual(list.items,[{line_id:'fresh'}]);assert.equal(list.refreshJob,null);
  }finally{globalThis.fetch=previous;invalidateReads();}
});

test('a page arriving during a completion batch cannot restore a previously acknowledged TODO or its count',async()=>{
  const ui=uiHarness(),component=ui.components['kanban-view'];let finish:(r:any)=>void=()=>{};
  const todoFeed={items:[{line_id:'a',version:1},{line_id:'b',version:1}],total:2,generation:0,loading:false,pending:null};
  ui.context.DB.complete=(todo:any)=>todo.line_id==='a'?Promise.resolve({}):new Promise(resolve=>{finish=resolve;});
  ui.context.DB.keepFeed=()=>{};
  const view:any={...component.methods,$state:ui.state,todoFeed,sel:{a:true,b:true},submitting:false,
    get todos(){return todoFeed.items.map(t=>({...t,文本:t.line_id}));},refresh:()=>{}};
  const batch=view.submitTodos();await flushUi();assert.deepEqual(todoFeed.items.map(t=>t.line_id),['b']);
  todoFeed.items.unshift({line_id:'a',version:1});todoFeed.total=2;finish({});await batch;
  assert.deepEqual(todoFeed.items,[]);assert.equal(todoFeed.total,0);
});

test('failed refresh retains the browsed rows and retry replaces them only after all needed pages arrive',async()=>{
  const previous=globalThis.fetch;invalidateReads();let refresh=false,fail=true;const cursors:(string|null)[]=[];
  globalThis.fetch=async(_path:any,options:any)=>{
    const args=JSON.parse(options.body);cursors.push(args.cursor??null);
    if(refresh&&fail&&args.cursor)throw new Error('offline');
    return Response.json({ok:true,data:{items:[{line_id:args.cursor?'b':'a',version:refresh?2:1}],matched_count:2,has_more:!args.cursor,next_cursor:args.cursor?null:'next'}});
  };
  try{
    const list=feed('todos');await list.ensure();await list.load();const rows=list.items,cursor=list.cursor;refresh=true;invalidateReads();
    await list.ensure();assert.ok(list.error);assert.equal(list.items,rows);assert.equal(list.cursor,cursor);assert.equal(list.loading,false);
    fail=false;await list.load();assert.equal(list.error,'');assert.deepEqual(list.items.map((t:any)=>t.version),[2,2]);assert.deepEqual(cursors,[null,'next',null,'next','next']);
  }finally{globalThis.fetch=previous;invalidateReads();}
});
