import {test} from 'node:test';
import assert from 'node:assert/strict';
import {holidayCalendar, readHolidayYear} from '../src/holidays';
import {holidayDays, loadHolidayYear, peekHolidayYear} from '../public/holidays.js';

function edgeCache(){
  const rows=new Map<string,Response>();
  return {rows,
    async match(request:Request){return rows.get(request.url)?.clone();},
    async put(request:Request,response:Response){rows.set(request.url,response.clone());}} as any;
}
function localStore(){
  const data=new Map<string,string>();
  return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
}
function useStorage(store:ReturnType<typeof localStore>,run:()=>Promise<void>){
  const previous=(globalThis as any).localStorage;
  (globalThis as any).localStorage=store;
  return run().finally(()=>{
    if(previous===undefined)delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage=previous;
  });
}

test('holiday proxy merges the next year file for December and serves repeat reads from the edge cache',async()=>{
  const cache=edgeCache(),calls:string[]=[];
  const fetcher=async(url:string)=>{
    calls.push(url);
    assert.match(url,/^https:\/\/raw\.githubusercontent\.com\/NateScarlet\/holiday-cn\/master\/\d{4}\.json$/);
    const year=Number(/(\d{4})\.json$/.exec(url)?.[1]);
    const days=year===2026
      ?[{name:'国庆节',date:'2026-10-01',isOffDay:true},{name:'国庆节',date:'2026-10-01',isOffDay:true}]
      :[{name:'元旦',date:'2027-01-01',isOffDay:true},{name:'元旦',date:'2026-12-31',isOffDay:true}];
    return Response.json({year,days});
  };
  const result=await holidayCalendar(2026,undefined,{fetcher,cache,now:new Date('2026-10-29T00:00:00Z')});
  assert.deepEqual(result.days.map(day=>day.date),['2026-10-01','2026-12-31']);
  assert.equal(result.days[1].name,'元旦');assert.equal(result.published,true);
  assert.equal(cache.rows.size,2);assert.equal(calls.length,2);
  const cached=await holidayCalendar(2026,undefined,{fetcher,cache});
  assert.equal(calls.length,2);assert.deepEqual(cached.days,result.days);
});

test('an unpublished year is an empty result rather than an error and is cached briefly',async()=>{
  const cache=edgeCache();
  const result=await holidayCalendar(2035,undefined,{fetcher:async()=>new Response('Not Found',{status:404}),cache});
  assert.deepEqual(result.days,[]);assert.equal(result.published,false);
  const entry=await cache.match(new Request('https://holiday-cn.invalid/years/2035'));
  assert.match(entry.headers.get('Cache-Control')??'',/max-age=3600/);
});

test('unreachable nodes fail the read so the browser keeps its local copy',async()=>{
  await assert.rejects(readHolidayYear(2026,undefined,{cache:null,fetcher:async()=>{throw new Error('offline');}}),
    (error:any)=>error.code==='SERVICE_UNAVAILABLE'&&error.retryable===true);
});

test('payloads with a mismatched year or malformed entries never reach the calendar',async()=>{
  const mismatched=await readHolidayYear(2026,undefined,{cache:null,
    fetcher:async()=>Response.json({year:2025,days:[{name:'元旦',date:'2026-01-01',isOffDay:true}]})}).catch((error:any)=>error);
  assert.equal(mismatched.code,'SERVICE_UNAVAILABLE');
  const result=await readHolidayYear(2026,undefined,{cache:null,fetcher:async()=>Response.json({year:2026,days:[
    {name:' 元旦 ',date:'2026-01-01',isOffDay:true},
    {name:'',date:'2026-01-02',isOffDay:true},
    {name:'春节',date:'2026-2-17',isOffDay:true},
    {name:'清明',date:'2026-04-04',isOffDay:'yes'},
    {name:'劳动节',date:'2026-02-30',isOffDay:true},
  ]})});
  assert.deepEqual(result.days,[{name:'元旦',date:'2026-01-01',isOffDay:true}]);
});

test('holiday days are deduplicated and sorted for calendar colouring',()=>{
  const days=holidayDays([
    {date:'2026-10-02',name:'国庆节',isOffDay:true},
    {date:'2026-10-01',name:'国庆节',isOffDay:true},
    {date:'2026-10-01',name:'重复',isOffDay:false},
    {date:'2026-10-10',name:'上班',isOffDay:false},
    {date:'2026/10/11',name:'国庆节',isOffDay:true},
    {date:'2026-10-12',name:'',isOffDay:true},
  ]);
  assert.deepEqual(days.map(day=>`${day.date}${day.isOffDay?'休':'班'}`),['2026-10-01休','2026-10-02休','2026-10-10班']);
});

test('a year is fetched once, then reused offline from the local copy',async()=>{
  const store=localStore();
  await useStorage(store,async()=>{
    const first=await loadHolidayYear(2019,{fetcher:async()=>[{name:'国庆节',date:'2019-10-01',isOffDay:true}]});
    assert.deepEqual(first.map(day=>day.date),['2019-10-01']);
    assert.deepEqual(peekHolidayYear(2019).map(day=>day.date),['2019-10-01']);
    let calls=0;
    const again=await loadHolidayYear(2019,{fetcher:async()=>{calls++;return [];}});
    assert.equal(calls,0);assert.deepEqual(again.map(day=>day.date),['2019-10-01']);
    assert.ok(store.data.get('case-notes:holidays:v1:2019'));
  });
});

test('an expired local copy is refreshed online and still shown when the network fails',async()=>{
  const store=localStore();
  store.setItem('case-notes:holidays:v1:2018',JSON.stringify({savedAt:0,days:[{date:'2018-10-01',name:'国庆节',isOffDay:true}]}));
  await useStorage(store,async()=>{
    const refreshed=await loadHolidayYear(2018,{fetcher:async()=>[{name:'国庆节',date:'2018-10-01',isOffDay:true},{name:'国庆节',date:'2018-10-02',isOffDay:true}]});
    assert.equal(refreshed.length,2);
    const offline=await loadHolidayYear(2017,{fetcher:async()=>{throw new Error('offline');}});
    assert.deepEqual(offline,[]);
    store.setItem('case-notes:holidays:v1:2016',JSON.stringify({savedAt:0,days:[{date:'2016-01-01',name:'元旦',isOffDay:true}]}));
    const stale=await loadHolidayYear(2016,{fetcher:async()=>{throw new Error('offline');}});
    assert.deepEqual(stale.map(day=>day.date),['2016-01-01']);
  });
});
