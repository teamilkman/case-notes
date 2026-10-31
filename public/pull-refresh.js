// Own only a deliberate downward, one-finger gesture begun at the scroll top.
// Horizontal navigation, forms, multi-touch and cancelled contacts keep their owners.
export function atScrollTop(target,root){
  const doc=root.ownerDocument;
  if((doc.scrollingElement?.scrollTop||0)>0)return false;
  for(let node=target;node&&node!==root.parentElement;node=node.parentElement){
    if(node.scrollTop>0&&node.scrollHeight>node.clientHeight+1)return false;
  }
  return true;
}
export function createPullRefresh({canStart,refresh,onChange=()=>{},onError=()=>{},threshold=64}){
  let origin=null,owned=false,distance=0,refreshing=false,closed=false,job=null;
  const emit=()=>{if(!closed)onChange({distance,ready:distance>=threshold,refreshing});};
  const cancel=()=>{origin=null;owned=false;distance=0;emit();};
  return {
    start(event){
      if(closed||refreshing)return;
      cancel();
      if(event.touches.length!==1||!canStart(event))return;
      const point=event.touches[0];origin={x:point.clientX,y:point.clientY};
    },
    move(event){
      if(!origin||refreshing)return;
      if(event.touches.length!==1)return cancel();
      const point=event.touches[0],dx=Math.abs(point.clientX-origin.x),dy=point.clientY-origin.y;
      if(!owned){
        if(dy<0||dx>10&&dx>dy)return cancel();
        if(dy<10||dy<dx*1.25)return;
        if(!canStart(event))return cancel();
        owned=true;
      }
      if(event.cancelable)event.preventDefault();event.stopPropagation();
      distance=Math.min(96,Math.max(0,dy*.5));emit();
    },
    end(event){
      if(!origin||refreshing)return job;
      const run=owned&&distance>=threshold&&event.touches.length===0&&canStart(event);
      if(owned){if(event.cancelable)event.preventDefault();event.stopPropagation();}
      cancel();if(!run)return;
      refreshing=true;emit();
      job=Promise.resolve().then(refresh).catch(onError).finally(()=>{refreshing=false;job=null;emit();});
      return job;
    },
    cancel,
    dispose(){closed=true;origin=null;owned=false;},
  };
}
