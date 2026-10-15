type OrderedEntry={sort_order:number;before?:{sort_order:number}};
// Keep the longest increasing sequence of existing positions. Allocate new or
// moved rows between those anchors; expand only a crowded local interval.
export function assignOrder(entries:OrderedEntry[],lower=0) {
  const tails:number[]=[],previous:number[]=[],anchors=new Set<number>();
  for(let n=0;n<entries.length;n++){
    const order=entries[n].before?.sort_order;if(order===undefined||order<=lower)continue;
    let lo=0,hi=tails.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(entries[tails[mid]].before!.sort_order<order)lo=mid+1;else hi=mid;}
    previous[n]=lo?tails[lo-1]:-1;tails[lo]=n;
  }
  for(let n=tails.at(-1)??-1;n>=0;n=previous[n])anchors.add(n);
  let start=0;
  while(start<entries.length){
    if(anchors.has(start)){entries[start].sort_order=entries[start].before!.sort_order;lower=entries[start].sort_order;start++;continue;}
    let end=start;while(end<entries.length&&!anchors.has(end))end++;
    let upper=end<entries.length?entries[end].before!.sort_order:null;
    while(upper!==null&&upper-lower<=end-start){
      anchors.delete(end);end++;while(end<entries.length&&!anchors.has(end))end++;
      upper=end<entries.length?entries[end].before!.sort_order:null;
    }
    const step=upper===null?1024:Math.floor((upper-lower)/(end-start+1));
    for(let n=start;n<end;n++){
      const order=lower+(n-start+1)*step;
      if(!Number.isSafeInteger(order))throw new Error('Line ordering exceeds safe integer range');
      entries[n].sort_order=order;
    }
    if(end===entries.length)break;
    start=end;
  }
}
