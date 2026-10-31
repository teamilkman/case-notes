import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPullRefresh,atScrollTop} from '../public/pull-refresh.js';

function harness(){
  let allowed=true,calls=0,finish:any;const states:any[]=[];
  const gesture=createPullRefresh({canStart:()=>allowed,refresh:()=>{calls++;return new Promise(resolve=>{finish=resolve;});},onChange:value=>states.push(value)});
  const event=(x=0,y=0,count=1)=>({touches:Array.from({length:count},()=>({clientX:x,clientY:y})),cancelable:true,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},prevented:false,stopped:false});
  return {gesture,event,states,allow:(value:boolean)=>{allowed=value;},calls:()=>calls,finish:()=>finish?.()};
}
test('a deliberate downward pull refreshes once on release and stays busy until visible reads finish',async()=>{
  const h=harness();h.gesture.start(h.event());const move=h.event(2,140);h.gesture.move(move);
  assert.equal(move.prevented,true);assert.equal(h.states.at(-1).ready,true);assert.equal(h.calls(),0);
  const job=h.gesture.end(h.event(2,140,0));await Promise.resolve();assert.equal(h.calls(),1);assert.equal(h.states.at(-1).refreshing,true);
  h.gesture.start(h.event());h.gesture.move(h.event(0,160));h.gesture.end(h.event(0,160,0));assert.equal(h.calls(),1);
  h.finish();await job;assert.equal(h.states.at(-1).refreshing,false);assert.equal(h.states.at(-1).distance,0);
});
test('horizontal, upward, short, multi-touch, cancelled and unavailable pulls do not refresh',async()=>{
  for(const mode of ['horizontal','up','short','multi','cancel','unavailable']){
    const h=harness();h.gesture.start(h.event());
    if(mode==='horizontal')h.gesture.move(h.event(150,20));
    else if(mode==='up')h.gesture.move(h.event(0,-150));
    else if(mode==='short')h.gesture.move(h.event(0,40));
    else {h.gesture.move(h.event(0,150));if(mode==='multi')h.gesture.move(h.event(0,150,2));if(mode==='cancel')h.gesture.cancel();if(mode==='unavailable')h.allow(false);}
    await h.gesture.end(h.event(0,150,0));assert.equal(h.calls(),0,mode);
  }
});
test('a pull cannot begin halfway down a nested list or the page',()=>{
  const root:any={ownerDocument:{scrollingElement:{scrollTop:0}},parentElement:null,scrollTop:0};
  const list:any={parentElement:root,scrollTop:20,scrollHeight:500,clientHeight:200};
  assert.equal(atScrollTop(list,root),false);list.scrollTop=0;assert.equal(atScrollTop(list,root),true);
  root.ownerDocument.scrollingElement.scrollTop=10;assert.equal(atScrollTop(list,root),false);
});
