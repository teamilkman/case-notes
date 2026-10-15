import './db-adapter.js';
import {pageDeck,MOBILE_QUERY} from './page-deck.js';
import {createNavigation} from './navigation.js';
import {appLocation} from './app-location.js';

const { createApp, reactive } = Vue;

// ---------- 模块级工具 ----------
const pad = n => String(n).padStart(2,'0');
const todayStr = () => { const d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); };
const wk = ds => '周'+'日一二三四五六'[new Date(ds+'T00:00:00').getDay()];
const findCase = (D,path) => { for(const arr of [D.案件,D.归档,D.事务]){ const c=arr.find(x=>x.path===path); if(c) return c; } return null; };
const badgeClass = st => st==='在办' ? 'b-in' : st==='结案' ? 'b-done' : 'b-other';
const statusClass = st => st==='在办' ? 'st-in' : st==='结案' ? 'st-done' : st==='结案未整卷' ? 'st-pend' : 'st-other';
const renderMd = text => {  // 记录区原文经 marked 渲染;行间插入空行使每行独立成段、--- 正确渲染为分隔线
  if(!text) return '';
  const md=text.split('\n').map(l=>l.trim()===''?'':l).join('\n\n');
  return DB.sanitize(marked.parse(md));
};
const escapeHtml = s => String(s==null?'':s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const escapeReg = s => String(s==null?'':s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const makeSnippet = (c, q) => {  // 案件 c 在搜索词 q 下的首个匹配片段(元数据优先,后扫记录);HTML 已 escape,关键词 <mark>
  q = String(q||'').trim();
  if(!q) return '';
  const lq = q.toLowerCase();
  const render = (label, text, ctxTail) => {
    if(!text) return null;
    const i = text.toLowerCase().indexOf(lq);
    if(i < 0) return null;
    const start = Math.max(0, i-15);
    const end = Math.min(text.length, i+q.length+25);
    const pre = start>0 ? '…' : '';
    const post = end<text.length ? '…' : '';
    const seg = escapeHtml(text.slice(start, end));
    const hl = seg.replace(new RegExp(escapeReg(escapeHtml(q)), 'gi'), m=>`<mark>${m}</mark>`);
    return `<span class="sn-field">${label}</span> ${pre}${hl}${post}`;
  };
  for(const [label,text] of [['名称',c.名称],['案由',c.案由],['案号',c.案号],['法院',c.法院]]){
    const r = render(label, text);
    if(r) return r;
  }
  for(const r of c.记录||[]){
    const label = '记录' + (r.日期 ? '·'+r.日期 : '');
    const out = render(label, r.文本);
    if(out) return out;
  }
  return '';
};
// ---------- 全局响应式状态 ----------
const state = reactive({
  D: DB.legacyView([],[]), connection:DB.connection, counts:{}, statsError:'', statsLoading:false, statsAt:0, change:0, error:'', loggingOut:false, view:'kanban', selCase:null, toast:null,
  scrolls:{},casesSearch:'',caseParent:null,pageOrder:['kanban','cases','calendar'],viewsReady:false,mobile:window.matchMedia?.(MOBILE_QUERY).matches||false,
  cal: (() => { const t=new Date(); return { y:t.getFullYear(), m:t.getMonth(), sel: todayStr() }; })(),
});
let _toastTimer = null;
function toast(msg, kind){ state.toast={msg,kind}; clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>{ state.toast=null; }, kind==='err' ? 6000 : 2600); }  // 错误提示留存久些,避免一闪而过看不清
const viewControllers=(Vue.shallowReactive||reactive)({});
const navigation=createNavigation(state,view=>viewControllers[view]);
function openCase(path){return navigation.openCase(path);}
function rememberCase(c){
  const item=DB.caseItem(c),d=state.D;
  for(const arr of [d.案件,d.归档,d.事务]){const i=arr.findIndex(x=>x.path===item.path);if(i>=0)arr.splice(i,1);}
  (item.状态==='事务'?d.事务:item.状态==='在办'?d.案件:d.归档).push(item);
  return item;
}
let statsJob=null,prefetchEpoch=-1,firstScreenReady=false;
function prepareViews(){
  if(state.viewsReady||state.loggingOut||!state.D)return;
  const swiper=document.querySelector('.view-pages')?.swiper;
  // A late first-screen receipt must not mount neighbours in an active drag.
  if(swiper?.touchEventsData.isTouched||swiper?.animating){setTimeout(prepareViews,100);return;}
  state.viewsReady=true;
}
function prefetchCalendar(y,m){
  if(!firstScreenReady||state.loggingOut||!state.D||!DB.calendar(y,m).loaded)return;
  const loads=[];
  for(const offset of [-1,1,-2,2,-3,3]){
    const date=new Date(y,m+offset,1),year=date.getFullYear(),month=date.getMonth();
    if(!DB.calendar(year,month).error)loads.push(DB.readCalendar(year,month));
  }
  // Read neighbours directly so a background completion cannot expand the range.
  Promise.allSettled(loads);
}
function loadStats(){
  if(statsJob)return statsJob;
  state.statsLoading=true;state.statsError='';const change=state.change;
  statsJob=DB.web('stats',{today:todayStr()}).then(result=>{if(change===state.change){state.counts=result.counts;state.statsAt=Date.now();}})
    .catch(e=>{if(change===state.change)state.statsError=e.message;}).finally(()=>{state.statsLoading=false;statsJob=null;if(change!==state.change)loadStats();});
  return statsJob;
}
function changed(savedDoc){DB.invalidateReads(savedDoc);state.change++;state.statsAt=0;loadStats();}
function afterFirstScreen(loads){
  Promise.allSettled([...loads,loadStats()]).then(()=>{
    if(prefetchEpoch===state.change)return;prefetchEpoch=state.change;const change=state.change;
    setTimeout(()=>{
      if(change!==state.change||state.loggingOut||!state.D)return;
      firstScreenReady=true;prepareViews();prefetchCalendar(state.cal.y,state.cal.m);
      const now=new Date();
      Promise.allSettled(['active','archived','affairs'].map(group=>DB.feed('cases',{group,query:''}).ensure()).concat(
        DB.readCalendar(now.getFullYear(),now.getMonth()).then(()=>prefetchCalendar(now.getFullYear(),now.getMonth()))));
    },200);
  });
}
const scrollSelector='.cards,.cases-list,.case-content,.md-editor,.md-preview,.cal-agenda';
function saveViewScroll(view){const root=document.querySelector(view==='kanban'?'.board-wrap':view==='cases'?'.cases-wrap':'.cal-wrap');if(root)state.scrolls[view]={windowY:window.scrollY,top:root.scrollTop,panes:[...root.querySelectorAll(scrollSelector)].map(el=>({top:el.scrollTop,left:el.scrollLeft}))};}
function restoreViewScroll(view){const saved=state.scrolls[view],root=document.querySelector(view==='kanban'?'.board-wrap':view==='cases'?'.cases-wrap':'.cal-wrap');if(saved&&root){root.scrollTop=saved.top||0;[...root.querySelectorAll(scrollSelector)].forEach((el,n)=>{el.scrollTop=saved.panes[n]?.top||0;el.scrollLeft=saved.panes[n]?.left||0;});}window.scrollTo(0,saved?.windowY||0);}

// ---------- Hash 路由:刷新保持当前视图/案件/日历位置 ----------
function parseHash(){
  const h=location.hash.replace(/^#\/?/,'');
  const parts=h.split('/').filter(Boolean);
  const view=parts[0]||'kanban';
  if(view==='calendar'){
    const ym=parts[1]||'';
    if(/^\d{4}-\d{2}$/.test(ym)){
      const [y,m]=ym.split('-').map(Number);
      if(y>=1000&&y<=9999&&m>=1&&m<=12){state.cal.y=y;state.cal.m=m-1;}
    }
    const sel=parts[2]||'';
    const prefix=`${state.cal.y}-${pad(state.cal.m+1)}-`;
    const valid=sel.startsWith(prefix)&&/^\d{4}-\d{2}-\d{2}$/.test(sel)&&Number(sel.slice(8))>=1&&Number(sel.slice(8))<=new Date(state.cal.y,state.cal.m+1,0).getDate();
    state.cal.sel=valid?sel:todayStr().startsWith(prefix)?todayStr():prefix+'01';
    state.view='calendar';
  }else if(view==='cases'){
    state.view='cases';
    const path=parts[1]?decodeURIComponent(parts[1]):null;
    if(path!==state.selCase)state.caseParent=null;
    state.selCase=path;
  }else{
    state.view='kanban';
  }
}
function updateHash(){
  const s=state;
  let h='#/'+s.view;
  if(s.view==='cases'){
    if(s.selCase) h+='/'+encodeURIComponent(s.selCase);
  }else if(s.view==='calendar'){
    h+='/'+s.cal.y+'-'+pad(s.cal.m+1);
    if(s.cal.sel) h+='/'+s.cal.sel;
  }
  if(location.hash!==h)window.history.replaceState(null,'',h);
}
function updateTitle(){if(typeof document!=='undefined')document.title='案记 · '+({kanban:'看板',cases:'案件',calendar:'日历'}[state.view]||'看板');}
window.addEventListener('hashchange', parseHash);
parseHash();
window.CaseNotesNavigation={back:()=>navigation.back()};
window.addEventListener('case-notes:reconnected',()=>{state.change++;state.statsAt=0;loadStats();viewControllers[state.view]?.refresh();});

const app = createApp({
  template:'#app-tpl',
  computed:{
    D(){ return this.$state.D; },
    futureCount(){return this.$state.counts.future??'-';},
    monthCount(){return this.$state.counts.month??'-';},
    swipeLocked(){const view=viewControllers[this.$state.view];return !!(viewControllers.cases?.saving||view?.editing||view?.dlg||view?.monthPickerOpen);},
  },
  methods:{
    loadStats,
    reconnect:()=>{if(DB.connection.authRequired){location.assign(appLocation('login.html')+location.hash);return;}return DB.reconnect();},
    navigate:view=>navigation.openView(view),
    swiped:view=>navigation.swiped(view),
    pageSettled:()=>navigation.settled(),
    async logout(){
      if(this.$state.loggingOut)return;
      this.$state.loggingOut=true;
      try{
        await DB.logout();
        this.$state.D=null;this.$state.selCase=null;this.$state.counts={};this.$state.scrolls={};this.$state.casesSearch='';
        location.replace(appLocation('login.html'));
      }
      catch(e){toast('退出未完成，请重试：'+e.message,'err');}
      finally{this.$state.loggingOut=false;}
    },
  },
  watch:{
    '$state.view'(view,previous){saveViewScroll(previous);updateHash();updateTitle();this.$nextTick(()=>restoreViewScroll(view));},
    '$state.selCase'(){ updateHash(); },
    '$state.cal.y'(){ updateHash(); },
    '$state.cal.m'(){ updateHash(); },
    '$state.cal.sel'(){ updateHash(); },
  },
  mounted(){
    updateTitle();
    loadStats();
    this.mobileMedia=window.matchMedia(MOBILE_QUERY);
    this.mobileChanged=()=>{state.mobile=this.mobileMedia.matches;};
    this.mobileMedia.addEventListener('change',this.mobileChanged);
  },
  beforeUnmount(){this.mobileMedia?.removeEventListener('change',this.mobileChanged);},
});
app.component('page-deck',pageDeck);
app.config.globalProperties.$state = state;
app.config.globalProperties.todayStr = todayStr;
app.config.globalProperties.wk = wk;
app.config.globalProperties.badgeClass = badgeClass;
app.config.globalProperties.statusClass = statusClass;
app.config.globalProperties.openCase = openCase;

app.component('ui-icon', {
  props:['name'],
  computed:{path(){return {
    board:'M3 3h18v18H3z M9 3v18 M15 3v18',folder:'M3 7V5h6l2 2h10v13H3z',calendar:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16',
    search:'M15.5 15.5L21 21 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',check:'M5 12l4 4L19 6',clock:'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    logout:'M10 4H4v16h6 M14 8l4 4-4 4 M8 12h10',chevron:'M9 5l7 7-7 7',back:'M15 5l-7 7 7 7',edit:'M14 5l5 5 M4 20l5-1L20 8l-4-4L5 15z',
    file:'M14 3H5v18h14V8z M14 3v5h5 M8 12h8 M8 16h6',lock:'M6 10h12v11H6z M8 10V7a4 4 0 0 1 8 0v3',close:'M6 6l12 12 M18 6L6 18',alert:'M12 8v5 M12 17h.01 M12 3L2 21h20z'
  }[this.name]||'';}},
  template:'<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path :d="path"></path></svg>',
});

app.component('status-badge', {
  props:['st'],
  template:'<span class="badge" :class="badgeClass(st)">{{ st }}</span>',
});

app.component('cases-search-input', {  // 案件搜索框:供看板案件列 + 案件视图共用,绑 state.casesSearch;框内防抖 250ms,拼字期间只更新框面不提交
  props:['modelValue'],
  emits:['update:modelValue'],
  data(){ return {draft:this.modelValue||'', composing:false, timer:null, suppressEnd:false}; },
  watch:{
    modelValue(next){ if(!this.composing&&(next||'')!==this.draft) this.draft=next||''; },
  },
  unmounted(){ if(this.timer)clearTimeout(this.timer); },
  methods:{
    queue(){ if(this.draft===this.modelValue){ if(this.timer){ clearTimeout(this.timer); this.timer=null; } return; } if(this.timer)clearTimeout(this.timer); this.timer=setTimeout(()=>{ this.timer=null; this.commit(); },250); },
    commit(){ if(this.timer){ clearTimeout(this.timer); this.timer=null; } if(this.draft!==this.modelValue) this.$emit('update:modelValue', this.draft); },
    onInput(event){ if(this.suppressEnd) this.suppressEnd=false; this.draft=event.target.value; if(this.composing||event.isComposing){ if(event.isComposing&&this.timer){ clearTimeout(this.timer); this.timer=null; } return; } this.queue(); },
    onSearch(event){ if(this.suppressEnd) this.suppressEnd=false; this.draft=event.target.value; if(this.composing||event.isComposing) return; this.commit(); },
    onCompositionStart(){ this.composing=true; this.suppressEnd=false; if(this.timer){ clearTimeout(this.timer); this.timer=null; } },
    onCompositionEnd(event){ if(this.suppressEnd){ this.suppressEnd=false; this.composing=false; if(this.timer){ clearTimeout(this.timer); this.timer=null; } this.draft=this.modelValue||''; return; } this.composing=false; this.draft=event.target.value; this.queue(); },
    clear(){ const wasComposing=this.composing; if(this.timer){ clearTimeout(this.timer); this.timer=null; } this.composing=false; if(wasComposing) this.suppressEnd=true; this.draft=''; if(''!==this.modelValue) this.$emit('update:modelValue', ''); this.$nextTick(()=>{ const el=this.$el.querySelector('input.search'); if(el) el.focus(); }); },
  },
  template:'<div class="cs-wrap">'
    +'<ui-icon name="search"></ui-icon><input class="search" type="search" aria-label="搜索案件和笔记内容" :value="draft" @input="onInput" @search="onSearch" @compositionstart="onCompositionStart" @compositionend="onCompositionEnd" placeholder="搜索案件或笔记内容…">'
    +'<button v-if="draft" type="button" class="cs-clear" aria-label="清除搜索" @click="clear">×</button>'
    +'</div>',
});

app.component('toast-box', {template:'#toast-tpl'});
app.component('loading-skeleton',{
  props:{kind:{default:'card'},rows:{default:4},label:{default:'正在加载…'}},
  template:`<div class="skeleton-stack" :class="'sk-kind-'+kind" role="status"><span class="sr-only">{{ label }}</span><div v-for="n in rows" :key="n" class="sk-card" aria-hidden="true"><div class="skeleton sk-line"></div><div class="skeleton sk-line sk-short"></div><div v-if="kind!=='case'" class="skeleton sk-line sk-mid"></div></div></div>`,
});
app.component('page-tail',{
  props:['feed','label'],
  template:`<div class="page-tail" aria-live="polite"><span v-if="feed.loading&&feed.items.length" class="page-tail-loading"><span class="loading-dot" aria-hidden="true"></span><span>继续加载中…</span></span><button v-else-if="feed.error" @click="feed.load()">{{ feed.error }} · 重试</button><button v-else-if="!feed.loading&&feed.hasMore" @click="feed.load()">继续加载{{ label||'' }}</button><span v-else-if="!feed.loading&&feed.items.length">已显示全部 {{ feed.total }} 项</span></div>`,
  methods:{fillVisible(){this.$nextTick(()=>{if(this.$el.closest('[inert]'))return;const root=this.$el.closest('.cards,.cases-list,.cal-wrap'),rect=this.$el.getBoundingClientRect(),bounds=root?.getBoundingClientRect();if(rect.width&&bounds&&rect.top<=bounds.bottom+80&&rect.bottom>=bounds.top&&!this.feed.loading&&!this.feed.error&&this.feed.hasMore)this.feed.load();});}},
  watch:{'feed.loading'(loading){if(!loading)this.fillVisible();}},
  mounted(){if(!('IntersectionObserver' in window))return;const root=this.$el.closest('.cards,.cases-list,.cal-wrap');this.observer=new IntersectionObserver(entries=>{if(!this.$el.closest('[inert]')&&entries.some(e=>e.isIntersecting)&&!this.feed.error)this.feed.load();},{root,rootMargin:'0px 0px 80px 0px'});this.observer.observe(this.$el);},
  unmounted(){this.observer?.disconnect();},
});

app.component('cases-view', {
  props:{active:{default:true}},
  template:'#cases-tpl',
  data(){ return {feed:DB.feed('cases',{group:'active',query:''}),seenChange:this.$state.change,docChange:-1, group:'在办', editing:false,editPane:'write', editText:'', saving:false, mdText:'', mdLoading:true, mdErr:false, mdSeq:0, dlg:false, dlgPos:0, dlgDate:'', dlgTime:'', dlgText:'', dbDoc:null, dbEditor:null, editError:'',closingCase:null }; },
  computed:{
    D(){ return this.$state.D; },
    selCase(){ return this.$state.selCase; },
    groups(){ return ['在办','归档','事务']; },
    sel(){  // 正文未读完前,标题/元信息先用列表项渲染,避免点击后只剩无标题的骨架
      const path=this.$state.selCase; if(!path)return this.closingCase;
      return findCase(this.$state.D,path)||this.filteredCases.find(c=>c.path===path)||null;
    },
    rendered(){ return renderMd(this.mdText); },  // 详情:记录区原文渲染
    editRendered(){ return renderMd(this.editText); },  // 编辑器:raw 实时预览
    filteredCases(){return this.feed.items.map(DB.caseItem);},
    backLabel(){return this.$state.caseParent==='kanban'?'返回看板':this.$state.caseParent==='calendar'?'返回日历':'返回列表';},
  },
  watch:{
    active(value){if(value)this.refresh();},
    selCase(){this.mdSeq++;this.editing=false;if(this.selCase||!this.closingCase){this.closingCase=null;this.loadMd();}},
    group(){this.loadList();},
    dlg(open){this.$nextTick(()=>{if(open)this.$refs.dialogDate?.focus();else this.$refs.editor?.focus({preventScroll:true});});},
    '$state.casesSearch'(){this.loadList();},
  },
  mounted(){viewControllers.cases=this;afterFirstScreen([this.loadList(),this.loadMd()]);},
  activated(){this.refresh();},
  deactivated(){this.closingCase=null;},
  unmounted(){this.mdSeq++;},
  methods:{
    refresh(){viewControllers.cases=this;if(this.seenChange!==this.$state.change){this.seenChange=this.$state.change;this.loadList();if(!this.editing&&!this.saving)this.loadMd(true);}},
    dialogKey(event){
      if(event.key==='Escape'&&!this.saving){event.preventDefault();this.dlg=false;return;}
      if(event.key!=='Tab')return;
      const targets=[...event.currentTarget.querySelectorAll('button:not(:disabled),input,textarea')];
      const first=targets[0],last=targets.at(-1);
      if(event.shiftKey&&event.target===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&event.target===last){event.preventDefault();first?.focus();}
    },
    beforeNoteInput(event){
      if(this.saving||!this.dbEditor)return;
      this.dbEditor.edit={start:event.target.selectionStart,end:event.target.selectionEnd,inputType:event.inputType||''};
    },
    noteInput(event){if(!this.saving)this.updateEdit(event.target.value);},
    updateEdit(next,range=null){
      this.editText=next;
      if(!this.editing||!this.dbEditor)return;
      if(range)this.dbEditor.edit=range;
      // Apply each DOM input synchronously, including IME intermediate values.
      // A Vue watcher can batch inputs and pair new text with a later range.
      try{DB.changeEdit(this.dbEditor,next);}catch(e){this.editError=e.message;toast(e.message,'err');}
    },
    groupFeed(group){return DB.feed('cases',{group:group==='归档'?'archived':group==='事务'?'affairs':'active',query:this.$state.casesSearch.trim()});},
    groupCases(group){return this.groupFeed(group).items.map(DB.caseItem);},
    loadList(){this.feed=this.groupFeed(this.group);return this.feed.ensure();},
    count(g){return this.$state.counts[g==='归档'?'archived':g==='事务'?'affairs':'active']??'-';},
    snippetFor(c){ return makeSnippet(c, this.$state.casesSearch.trim()); },
    selectCase(path){if(!this.saving)openCase(path);},
    async loadMd(background=false){
      const path=this.$state.selCase;
      if(!path){ this.mdText=''; this.mdLoading=false; this.mdErr=false; return; }
      const seq=++this.mdSeq,change=this.$state.change;  // 切案和提交写入都会作废旧响应。

      if(!background){this.mdText='';this.dbDoc=null;}
      this.mdLoading=true; this.mdErr=false;
      try{
        const doc=await DB.readCase(path);  // 复用完整文档缓存；实际写入后按需失效
        if(seq!==this.mdSeq||change!==this.$state.change) return;
        if(this.editing||this.saving)return;rememberCase(doc.case);this.dbDoc=doc;this.mdText=doc.text;this.docChange=this.$state.change;
      }catch(e){
        if(seq===this.mdSeq&&change===this.$state.change&&!background){this.mdText='';this.mdErr=true;}
      }finally{
        if(seq===this.mdSeq) this.mdLoading=false;
      }
    },
    async enterEdit(){
      const path=this.$state.selCase; if(!path) return;
      if(this.mdLoading)return;
      if(!this.dbDoc||this.dbDoc.ref!==path)await this.loadMd();
      if(!this.dbDoc || this.mdErr) return;
      this.dbEditor=DB.beginEdit(this.dbDoc); this.editError='';
      this.editText=DB.restoreDraft(this.dbEditor);
      this.editPane='write';
      this.editing=true;
    },
    async saveEdit(){
      if(this.saving)return;
      const path=this.$state.selCase;
      this.saving=true;
      try{
        if(this.editError) throw new Error(this.editError);
        DB.changeEdit(this.dbEditor,this.editText);
        const editor=this.dbEditor,doc=this.dbDoc,text=this.editText,submittedRows=editor.rows.map(l=>({...l}));
        if(text===this.dbDoc.text){DB.discardDraft(path);this.editing=false;toast('笔记未改动','ok');return;}
        const receipt=await DB.save(editor);
        const savedDoc={...doc,case:receipt.case||{...doc.case,name:receipt.case_name,document_revision:receipt.document_revision,metadata_version:receipt.metadata_version},revision:receipt.document_revision,text,lines:receipt.lines.map((l,i)=>({...l,text:submittedRows[i].text}))};
        if(this.$state.selCase===path){
          this.dbDoc=savedDoc;rememberCase(savedDoc.case);
          this.mdText=text;this.editing=false;
        }
        toast('笔记已保存','ok');changed(savedDoc);this.seenChange=this.$state.change;if(this.$state.selCase===path)this.docChange=this.$state.change;DB.rememberDoc(savedDoc);
      }catch(e){if(['VERSION_CONFLICT','CASE_READ_ONLY'].includes(e.code)){DB.invalidateCase(path);this.docChange=-1;}toast(e.message,'err');}
      finally{this.saving=false;}
    },
    cancelEdit(){if(this.saving)return;DB.discardDraft(this.$state.selCase);this.editing=false;if(this.docChange!==this.$state.change)this.loadMd();},
    leaveEdit(){if(this.saving)return;this.editing=false;this.editPane='write';if(this.docChange!==this.$state.change)this.loadMd();},
    backToList(){if(!this.saving)navigation.back();},
    detailSwiped(page){if(page==='list'&&this.selCase&&this.$state.view==='cases')navigation.back();},
    prepareBack(){this.closingCase=this.sel;},
    detailSettled(){if(!this.selCase)this.closingCase=null;},
    openDlg(){
      if(this.saving)return;
      const ta=this.$refs.editor;
      this.dlgPos = ta ? ta.selectionStart : this.editText.length;  // 先记下光标位置,弹窗会夺焦
      this.dlgDate = todayStr();  // 默认今天,用户可改为将来的开庭日
      this.dlgTime=''; this.dlgText='';
      this.dlg=true;
    },
    dlgOk(){  // 日程 → 插入到光标所在行的下一行
      if(this.saving)return;
      const body=this.dlgText.trim();
      if(!body){ toast('请输入正文','err'); return; }
      if(!this.dlgDate){ toast('请选择日期','err'); return; }
      let line = '- 📅 ' + this.dlgDate.replace(/-/g,'.');
      if(this.dlgTime) line += ' ' + this.dlgTime;
      line += ' ' + body;
      this.insertNextLine(line);
      this.dlg=false;
    },
    insertTodo(){  // 待办 → 行首复选框循环:无 ↔ 空复选框(- [ ]);- [x] 不参与循环
      if(this.saving)return;
      const ta=this.$refs.editor;
      const p = ta ? ta.selectionStart : this.editText.length;
      const t=this.editText;
      const ls = p===0?0:t.lastIndexOf('\n', p-1)+1;
      const line = t.slice(ls);
      if(/^- \[x\] ?/.test(line)) return;   // 工具栏不将已有完成记录重新标为待办
      const m = line.match(/^- \[ \] ?/);   // 仅匹配空复选框
      let newText, caret;
      if(m){
        newText = t.slice(0,ls) + line.slice(m[0].length);   // 移除 → 无
        caret = ls;
      } else {
        newText = t.slice(0,ls) + '- [ ] ' + line;           // 添加 → 空复选框
        caret = ls + 6;
      }
      this.updateEdit(newText,{start:ls,end:ls+(m?m[0].length:0),inputType:'insertReplacementText'});
      this.$nextTick(()=>{ const e=this.$refs.editor; e.focus(); e.setSelectionRange(caret, caret); });
    },
    insertNextLine(line){  // 在光标所在行的下一行插入一行记录;当前行为空时直接占用该行
      if(this.saving)return;
      const t=this.editText;
      const p=this.dlgPos;
      const ls = p===0?0:t.lastIndexOf('\n', p-1)+1;
      let le = t.indexOf('\n', p); if(le===-1) le=t.length;
      const cur = t.slice(ls, le);
      const before = t.slice(0, le);
      const tail = t.slice(le);             // 以 \n 开头,或空
      const nl = cur==='' ? '' : '\n';      // 当前行非空才补分隔换行
      this.updateEdit(before + nl + line + tail,{start:le,end:le,inputType:'insertText'});
      const caret = before.length + nl.length + line.length;
      this.$nextTick(()=>{ const e=this.$refs.editor; e.focus(); e.setSelectionRange(caret, caret); });
    },
  },
});

app.component('kanban-view', {
  props:{active:{default:true}},
  template:'#kanban-tpl',
  data(){ return {caseFeed:DB.feed('cases',{group:'active',query:''}),scheduleFeed:DB.feed('schedules',{mode:'future',today:todayStr()}),todoFeed:DB.feed('todos'),activityFeed:DB.feed('activity',{today:todayStr(),days:7}),seenChange:this.$state.change, sel:{}, submitting:false, doneDays:7, hearingTab:'未来', doneOpen:false, mCol:'todo' }; },
  computed:{
    boardColumns(){return this.$state.mobile?['todo','hearing']:['todo','hearing','cases'];},
    D(){ return this.$state.D; },
    selCount(){ return Object.values(this.sel).filter(Boolean).length; },
    today(){ return todayStr(); },
    todos(){return this.todoFeed.items.map(DB.todoItem);},
    done(){return this.activityFeed.items.map(DB.activityItem);},
    activityCount(){return (this.doneOpen&&this.activityFeed.args.days===this.doneDays?this.activityFeed.total:null)??this.$state.counts['activity_'+this.doneDays];},
    hearings(){return this.scheduleFeed.items.map(DB.eventItem);},
    filtered(){return this.caseFeed.items.map(DB.caseItem);},
  },
  watch:{
    active(value){if(value)this.refresh();},
    '$state.mobile'(mobile){if(mobile&&this.mCol==='cases')this.mCol='hearing';if(!mobile)this.loadCases();},
    hearingTab(){this.loadSchedules();},
    doneOpen(value){if(value)return this.loadActivity();},
    doneDays(){if(this.doneOpen)this.loadActivity();},
    '$state.casesSearch'(){this.loadCases();},
  },
  mounted(){viewControllers.kanban=this;afterFirstScreen([this.loadCases(),this.loadSchedules(),this.loadTodos()]);},
  activated(){this.refresh();},
  methods:{
    refresh(){if(this.seenChange!==this.$state.change&&!this.submitting){this.seenChange=this.$state.change;afterFirstScreen([this.loadCases(),this.loadSchedules(),this.loadTodos()]);if(this.doneOpen)this.loadActivity();}},
    async loadTodos(){
      const feed=this.todoFeed,change=this.$state.change;
      const selected=new Map(feed.items.filter(t=>this.sel[t.line_id]).map(t=>[t.line_id,t.version]));
      await feed.ensure();
      if(change!==this.$state.change||feed.error)return;
      const current=new Map(feed.items.map(t=>[t.line_id,t.version]));
      for(const id of Object.keys(this.sel))if(!current.has(id)||(selected.has(id)&&current.get(id)!==selected.get(id)))delete this.sel[id];
    },
    loadCases(){if(this.$state.mobile)return Promise.resolve();this.caseFeed=DB.feed('cases',{group:'active',query:this.$state.casesSearch.trim()});return this.caseFeed.ensure();},
    loadSchedules(){this.scheduleFeed=DB.feed('schedules',{mode:this.hearingTab==='历史'?'history':this.hearingTab==='未来'?'future':'all',today:todayStr()});return this.scheduleFeed.ensure();},
    loadActivity(){this.activityFeed=DB.feed('activity',{today:todayStr(),days:this.doneDays});return this.activityFeed.ensure();},
    switchCol(c){if(this.boardColumns.includes(c))this.mCol=c;},
    snippetFor(c){ return makeSnippet(c, this.$state.casesSearch.trim()); },
    countdown(dt){ // 距离开庭天数:今天/明天/昨天/N 天后/N 天前
      const n=Math.round((new Date(dt+'T00:00:00')-new Date(todayStr()+'T00:00:00'))/86400000);
      if(n===0)return '今天';
      if(n===1)return '明天';
      if(n===2)return '后天';
      if(n===-1)return '昨天';
      return n>0 ? n+' 天后' : -n+' 天前';
    },
    cdClass(dt){ // 倒计时配色:3 天内紧迫高亮,已过灰显
      const n=Math.round((new Date(dt+'T00:00:00')-new Date(todayStr()+'T00:00:00'))/86400000);
      return n<0 ? 'cd past' : (n<=3 ? 'cd soon' : 'cd');
    },
    ddlInfo(t){ // 待办截止倒计时:已逾期红、3 天内警示、其余常规
      const n=Math.round((new Date(t.截止+'T00:00:00')-new Date(todayStr()+'T00:00:00'))/86400000);
      if(n<0) return {cls:'cd over', label:'已逾期'+(-n)+'天'};
      if(n===0) return {cls:'cd soon', label:'今天到期'};
      if(n===1) return {cls:'cd soon', label:'明天到期'};
      if(n===2) return {cls:'cd soon', label:'后天到期'};
      if(n<=3) return {cls:'cd soon', label:n+' 天后到期'};
      return {cls:'cd', label:n+' 天后'};
    },
    toggleSel(t){ // 点击卡片任意处勾选/取消(案件名链接与复选框自身已 stopPropagation)
      if(this.submitting) return;
      const k=t.line_id;
      this.sel[k]=!this.sel[k];
    },
    async submitTodos(){
      const keys=Object.keys(this.sel).filter(k=>this.sel[k]);
      if(!keys.length) return;
      this.submitting=true;
      // A page requested before completion must not reinsert a removed TODO.
      this.todoFeed.controller?.abort();this.todoFeed.generation++;this.todoFeed.loading=false;this.todoFeed.pending=null;
      let ok=0,conflict=false;const completed=new Set(),total=this.todoFeed.total;const fails=[];
      const queue=[...keys];
      await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{let k;
      while((k=queue.shift())!==undefined){
        const todo=this.todos.find(t=>t.line_id===k);
        if(!todo) continue; const 文本=todo.文本;
        try{
          await DB.complete(todo);
          this.todoFeed.items=this.todoFeed.items.filter(t=>t.line_id!==k);
          this.todoFeed.total=Math.max(0,(this.todoFeed.total??1)-1);this.sel[k]=false;
          completed.add(k);
          ok++;
        }catch(e){if(['VERSION_CONFLICT','CASE_READ_ONLY'].includes(e.code))conflict=true;fails.push(文本+'：'+e.message);}
      }}));
      this.todoFeed.items=this.todoFeed.items.filter(t=>!completed.has(t.line_id));
      if(total!==null)this.todoFeed.total=Math.max(0,total-ok);
      this.submitting=false;
      if(ok||conflict){changed();if(!conflict)DB.keepFeed(this.todoFeed);this.refresh();}
      toast(fails.length?`已完成 ${ok} 项，${fails.length} 项失败：${fails[0]}`:`已完成 ${ok} 项待办`, fails.length?'err':'ok');
    },
  },
});

app.component('calendar-view', {
  props:{active:{default:true}},
  template:'#cal-tpl',
  data(){return {heatExpand:false,heatGran:'month',monthPickerOpen:false,pickerYear:this.$state.cal.y,calendarEntry:DB.calendar(this.$state.cal.y,this.$state.cal.m),calendarSeq:0,seenChange:this.$state.change,lastDateCounts:null,pendingMonth:null};},
  computed:{
    D(){ return this.$state.D; },
    today(){ return todayStr(); },
    cal(){ return this.$state.cal; },
    calendarLoading(){return !this.calendarEntry.loaded&&!this.calendarEntry.error;},
    calendarUnavailable(){return !this.calendarEntry.loaded;},
    calendarError(){return this.calendarEntry.error;},
    dateCounts(){return this.calendarEntry.data?.dateCounts||this.lastDateCounts||{};},
    heatReady(){return this.calendarEntry.loaded||this.lastDateCounts!==null;},  // 加载新月份时沿用已读取的全局计数，包括真实空结果。
    calTitle(){ const {y,m}=this.$state.cal; return y+'年'+(m+1)+'月'; },
    monthSummary(){
      let hearings=0,days=0;
      for(const events of this.byDate.values()){hearings+=events.length;days++;}
      return {hearings,days};
    },
    nextHearing(){
      return [...this.byDate.entries()].filter(([date])=>date>this.cal.sel).sort(([a],[b])=>a.localeCompare(b))[0]||null;
    },
    grid(){
      const {y,m}=this.$state.cal;
      const lead=(new Date(y,m,1).getDay()+6)%7;          // 周一开头
      const days=new Date(y,m+1,0).getDate();
      const cells=Array(lead).fill(null);
      for(let d=1;d<=days;d++) cells.push({date:`${y}-${pad(m+1)}-${pad(d)}`, day:d});
      while(cells.length%7) cells.push(null);
      return cells;
    },
    byDate(){
      const d=this.D, m=new Map();
      if(d&&!this.calendarUnavailable) for(const e of (this.calendarEntry.data?.items||[]).map(DB.eventItem)){ const k=e.日期; if(!m.has(k)) m.set(k,[]); m.get(k).push(e); }
      for(const arr of m.values()) arr.sort((a,b)=>(a.时间||'99:99').localeCompare(b.时间||'99:99'));
      return m;
    },
    dayHearings(){ return this.byDate.get(this.$state.cal.sel)||[]; },
    detailTitle(){
      const s=this.$state.cal.sel; if(!s) return '';
      const [y,m,d]=s.split('-').map(Number);
      return `${y}年${m}月${d}日 · 周${'日一二三四五六'[new Date(y,m-1,d).getDay()]}`;
    },
    heatWeeks(){ return this.yearHeat(this.$state.cal.y); },
    heatMonths(){ return this.yearMonths(this.heatWeeks); },
    curYearMonthData(){ return this.yearMonthHeat(this.$state.cal.y); },
    heatAllYears(){  // 全部年份的周视图(最近在上),供「展开全部」查看
      const years=new Set();
      for(const date of Object.keys(this.dateCounts))years.add(parseInt(date.slice(0,4)));
      return [...years].sort((a,b)=>b-a).map(y=>{ const h=this.yearHeat(y); return {...h, months:this.yearMonths(h)}; });
    },
    allYearsMonthData(){  // 全部年份的月视图(最近在上)
      const years=new Set();
      for(const date of Object.keys(this.dateCounts))years.add(parseInt(date.slice(0,4)));
      return [...years].sort((a,b)=>b-a).map(y=>this.yearMonthHeat(y));
    },
  },
  mounted(){viewControllers.calendar=this;afterFirstScreen([this.loadCalendar()]);},
  activated(){this.refresh();},
  deactivated(){this.leave();},
  watch:{active(value){if(value)this.refresh();else this.leave();},'$state.cal.y'(){this.loadCalendar();},'$state.cal.m'(){this.loadCalendar();},'$state.cal.sel'(){this.$nextTick(()=>{const agenda=this.$el.querySelector('.cal-agenda');if(agenda)agenda.scrollTop=0;});}},
  methods:{
    refresh(){viewControllers.calendar=this;if(this.seenChange!==this.$state.change){this.seenChange=this.$state.change;this.loadCalendar();}},
    leave(){this.monthPickerOpen=false;if(this.pendingMonth)this.monthSwiped('next');},
    loadCalendar(force=false){
      const {y,m}=this.$state.cal;this.calendarEntry=DB.calendar(y,m);
      const entry=this.calendarEntry;
      if(force)this.calendarEntry.invalidate();
      if(this.calendarEntry.error&&!force)return Promise.resolve();
      const sequence=++this.calendarSeq,change=this.$state.change,read=DB.readCalendar(y,m);
      return read.then(data=>{
        if(this.calendarEntry!==entry||!entry.loaded||this.calendarSeq!==sequence||change!==this.$state.change)return;
        if(data?.dateCounts)this.lastDateCounts=data.dateCounts;
        prefetchCalendar(y,m);
      }).catch(()=>{});
    },
    cellHearings(cell){ return this.byDate.get(cell.date)||[]; },
    monthGrid(page){
      if(page==='current')return this.grid;
      const target=this.pendingMonth;
      const date=target?new Date(target.y,target.m,1):new Date(this.cal.y,this.cal.m+(page==='next'?1:-1),1),y=date.getFullYear(),m=date.getMonth();
      const cells=Array((date.getDay()+6)%7).fill(null);
      for(let day=1;day<=new Date(y,m+1,0).getDate();day++)cells.push({date:`${y}-${pad(m+1)}-${pad(day)}`,day});
      while(cells.length%7)cells.push(null);return cells;
    },
    monthEvents(cell,page){
      if(page==='current')return this.cellHearings(cell);
      const [year,month]=cell.date.split('-').map(Number),entry=DB.calendar(year,month-1);
      if(!entry.loaded)return [];
      this.previewMonths??=new Map();const key=year+'-'+month;
      let preview=this.previewMonths.get(key);
      if(!preview||preview.data!==entry.data){
        const byDate=new Map();
        for(const e of (entry.data?.items||[]).map(DB.eventItem)){if(!byDate.has(e.日期))byDate.set(e.日期,[]);byDate.get(e.日期).push(e);}
        preview={data:entry.data,byDate};this.previewMonths.set(key,preview);
        if(this.previewMonths.size>3)this.previewMonths.delete(this.previewMonths.keys().next().value);
      }
      return preview.byDate.get(cell.date)||[];
    },
    monthReady(page){
      const cell=this.monthGrid(page).find(Boolean);if(!cell)return false;
      const [year,month]=cell.date.split('-').map(Number);return DB.calendar(year,month-1).loaded;
    },
    monthSwiped(page){
      if(this.pendingMonth){const target=this.pendingMonth;this.pendingMonth=null;this.$state.cal.y=target.y;this.$state.cal.m=target.m;this.$state.cal.sel=target.sel;}
      else this.applyMonthNav(page==='next'?1:-1);
    },
    navigateMonth(y,m,sel){
      if(this.pendingMonth||this.$refs?.monthPages?.isMoving())return;
      const c=this.$state.cal,delta=(y-c.y)*12+m-c.m;
      if(this.$state.mobile&&delta&&this.$refs.monthPages){this.pendingMonth={y,m,sel};return this.$refs.monthPages.step(delta>0?1:-1);}
      c.y=y;c.m=m;c.sel=sel;
    },
    select(date){ this.$state.cal.sel=date; },
    dayLabel(cell){
      return `${cell.date} ${wk(cell.date)}${cell.date===this.today?'，今天':''}，${this.calendarUnavailable?'日程尚未加载':this.cellHearings(cell).length+'场开庭'}`;
    },
    changeMonth(value){
      if(!/^\d{4}-\d{2}$/.test(value))return;
      const [y,m]=value.split('-').map(Number);
      if(y<1000||y>9999||m<1||m>12)return;
      this.navigateMonth(y,m-1,value+'-01');
    },
    toggleMonthPicker(){
      if(this.monthPickerOpen)return this.closeMonthPicker();
      this.pickerYear=this.cal.y;this.monthPickerOpen=true;
      this.$nextTick(()=>this.$refs.monthPicker?.querySelector(`[data-month="${this.cal.m}"]`)?.focus());
    },
    closeMonthPicker(){this.monthPickerOpen=false;this.$nextTick(()=>this.$refs.monthTrigger?.focus({preventScroll:true}));},
    setPickerYear(event){
      const value=event.target.value.trim(),year=Number(value);
      if(/^\d{4}$/.test(value)&&year>=1000&&year<=9999)this.pickerYear=year;
      event.target.value=String(this.pickerYear);
    },
    pickMonth(month){
      if(this.$refs.pickerYearInput)this.setPickerYear({target:this.$refs.pickerYearInput});
      this.changeMonth(`${this.pickerYear}-${pad(month+1)}`);this.closeMonthPicker();
    },
    stepPickerYear(delta){
      if(this.$refs.pickerYearInput)this.setPickerYear({target:this.$refs.pickerYearInput});
      this.pickerYear=Math.max(1000,Math.min(9999,this.pickerYear+delta));
    },
    monthPickerKey(event){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.closeMonthPicker();return;}
      if(event.key!=='Tab')return;
      const controls=[...this.$refs.monthPicker.querySelectorAll('button:not(:disabled),input')],first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&event.target===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&event.target===last){event.preventDefault();first?.focus();}
    },
    pickerMonthKey(event,month){
      const offsets={ArrowLeft:-1,ArrowRight:1,ArrowUp:-3,ArrowDown:3};
      let target;
      if(event.key in offsets)target=Math.max(0,Math.min(11,month+offsets[event.key]));
      else if(event.key==='Home')target=0;
      else if(event.key==='End')target=11;
      else return;
      event.preventDefault();this.$refs.monthPicker.querySelector(`[data-month="${target}"]`)?.focus();
    },
    dayKey(event,date){
      const offsets={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
      const d=new Date(date+'T00:00:00');
      if(event.key in offsets)d.setDate(d.getDate()+offsets[event.key]);
      else if(event.key==='Home')d.setDate(d.getDate()-(d.getDay()+6)%7);
      else if(event.key==='End')d.setDate(d.getDate()+6-(d.getDay()+6)%7);
      else if(event.key==='PageUp'||event.key==='PageDown'){
        const day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+(event.key==='PageUp'?-1:1));
        d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));
      }else return;
      if(d.getFullYear()<1000||d.getFullYear()>9999)return;
      event.preventDefault();
      const target=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      this.$state.cal.y=d.getFullYear();this.$state.cal.m=d.getMonth();this.select(target);
      this.$nextTick(()=>this.$el.querySelector(`[data-date="${target}"]`)?.focus());
    },
    doOpenCase(date,path){ this.select(date); openCase(path); },
    yearHeat(y){  // 单年开庭周视图热力图(周一开头),含每级色阶
      const byDate=this.dateCounts;
      const first=new Date(y,0,1), last=new Date(y,11,31);
      const start=new Date(first); start.setDate(first.getDate()-((first.getDay()+6)%7));
      const end=new Date(last); end.setDate(last.getDate()+(6-((last.getDay()+6)%7)));
      const nWeeks=Math.floor((end-start)/86400000/7)+1;
      const weeks=[]; let maxc=0;
      for(let w=0;w<nWeeks;w++){
        let n=0, firstDate=null;
        for(let r=0;r<7;r++){
          const d=new Date(start); d.setDate(start.getDate()+w*7+r);
          if(d.getFullYear()===y){
            const iso=`${y}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
            const count=byDate[iso]||0;
            if(count){n+=count;if(!firstDate)firstDate=iso;}
          }
        }
        maxc=Math.max(maxc,n);
        weeks.push({n, firstDate});
      }
      const lvl=n=> n===0?0 : maxc<=1?1 : Math.min(4,1+Math.round((n-1)*3/(maxc-1)));
      weeks.forEach(w=>w.lvl=lvl(w.n));
      return { year:y, start, weeks };
    },
    yearMonths(h){  // 某年热力条的月份标签列区间
      const {start, year:y}=h, labels=[];
      for(let m=0;m<12;m++){
        const fm=new Date(y,m,1), lm=new Date(y,m+1,0);
        const c1=Math.floor((fm-start)/86400000/7);
        const c2=Math.floor((lm-start)/86400000/7);
        labels.push({m, c1, c2, span:Math.max(1,c2-c1+1)});
      }
      return labels;
    },
    yearMonthHeat(y){  // 单年开庭月视图热力图:12 个月色块
      const byDate=this.dateCounts;
      let maxc=0;
      const months=[];
      for(let m=0;m<12;m++){
        let n=0, firstDate=null;
        for(let d=1;d<=new Date(y,m+1,0).getDate();d++){
          const iso=`${y}-${pad(m+1)}-${pad(d)}`;
          const count=byDate[iso]||0;
          if(count){n+=count;if(!firstDate)firstDate=iso;}
        }
        maxc=Math.max(maxc,n);
        months.push({m, n, firstDate});
      }
      const lvl=n=> n===0?0 : maxc<=1?1 : Math.min(4,1+Math.round((n-1)*3/(maxc-1)));
      months.forEach(mb=>mb.lvl=lvl(mb.n));
      return { year:y, months };
    },
    weekTitle(wk,i,h){
      if(!this.heatReady)return this.calendarError?'日程尚未加载':'开庭日程加载中';
      const {start}=(h||this.heatWeeks);
      const d=new Date(start); d.setDate(start.getDate()+i*7);
      const d2=new Date(d); d2.setDate(d.getDate()+6);
      const f=x=>`${x.getMonth()+1}月${x.getDate()}日`;
      return `${f(d)} ~ ${f(d2)} · ${wk.n}场开庭`;
    },
    jumpToWeek(h,wk,i){
      const {start, year:y}=h;
      const d0=new Date(start); d0.setDate(start.getDate()+i*7);
      let tgt=null;
      for(let r=0;r<7;r++){ const d=new Date(d0); d.setDate(d0.getDate()+r); if(d.getFullYear()===y){ tgt=d; break; } }
      const m=wk.firstDate?Number(wk.firstDate.slice(5,7))-1:tgt?tgt.getMonth():0;
      this.$state.cal.y=y; this.$state.cal.m=m;
      this.$state.cal.sel=wk.firstDate ? wk.firstDate : `${y}-${pad(m+1)}-01`;
    },
    monthTitle(mb,y){return !this.heatReady?`${y}年${mb.m+1}月 · 日程尚未加载`:`${y}年${mb.m+1}月 · ${mb.n}场开庭`;},
    jumpToMonth(y,mb){
      this.navigateMonth(y,mb.m,mb.firstDate ? mb.firstDate : `${y}-${pad(mb.m+1)}-01`);
    },
    nav(delta){
      const date=new Date(this.cal.y,this.cal.m+delta,1);if(date.getFullYear()<1000||date.getFullYear()>9999)return;
      this.navigateMonth(date.getFullYear(),date.getMonth(),`${date.getFullYear()}-${pad(date.getMonth()+1)}-01`);
    },
    applyMonthNav(delta){
      const c=this.$state.cal; let m=c.m+delta, y=c.y;
      if(m<0){m=11;y--;} if(m>11){m=0;y++;}
      if(y<1000||y>9999)return;
      c.y=y; c.m=m; c.sel=`${y}-${pad(m+1)}-01`;
    },
    goToday(){
      const t=new Date();
      this.navigateMonth(t.getFullYear(),t.getMonth(),todayStr());
    },
  },
});

app.mount('#app');
