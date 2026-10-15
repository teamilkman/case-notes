// Preserve line identity from the textarea edit range, including duplicate text.
export function editLines(rows, previous, next, edit) {
  if(previous===next)return rows.map(x=>({...x}));
  let {start,end,inputType}=edit;
  const delta=next.length-previous.length;
  if(start===end&&inputType.startsWith('delete')&&delta<0){
    if(/Backward/.test(inputType))start+=delta;else end-=delta;
  }
  const validRange=()=>Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>=start&&end<=previous.length;
  let insertedLength=next.length-(previous.length-(end-start));
  const matches=()=>insertedLength>=0&&next.slice(0,start)===previous.slice(0,start)&&next.slice(start+insertedLength)===previous.slice(end);
  if(validRange()&&!matches()){
    // IME replacement/autocorrect can affect more than the reported selection.
    // A change within one line cannot confuse duplicate line identities. Never
    // infer a structural edit from text when its reported range does not match.
    let head=0;while(head<previous.length&&head<next.length&&previous[head]===next[head])head++;
    let tail=previous.length,nextTail=next.length;
    while(tail>head&&nextTail>head&&previous[tail-1]===next[nextTail-1]){tail--;nextTail--;}
    if(!previous.slice(head,tail).includes('\n')&&!next.slice(head,nextTail).includes('\n')){
      start=head;end=tail;insertedLength=nextTail-head;
    }
  }
  if(!validRange()||!matches())
    throw new Error('无法确认本次编辑的行位置，草稿已保留；请复制草稿后重新打开笔记。');
  const startLine=previous.slice(0,start).split('\n').length-1;
  const endLine=previous.slice(0,end).split('\n').length-1;
  const startOffset=start-(start===0?0:previous.lastIndexOf('\n',start-1)+1);
  const endOffset=end-(end===0?0:previous.lastIndexOf('\n',end-1)+1);
  const combined=rows[startLine].text.slice(0,startOffset)+next.slice(start,start+insertedLength)+rows[endLine].text.slice(endOffset);
  const changed=combined.split('\n').map(text=>({text}));
  if(startLine===endLine){
    if(startOffset===0&&endOffset===0&&changed.length>1&&changed.at(-1).text===rows[startLine].text)
      changed.at(-1).line_id=rows[startLine].line_id;
    else changed[0].line_id=rows[startLine].line_id;
  }
  else {
    if(startOffset>0)changed[0].line_id=rows[startLine].line_id;
    if(endOffset===0||endOffset<rows[endLine].text.length){
      const last=changed.at(-1);if(!last.line_id)last.line_id=rows[endLine].line_id;
    }
    if(changed.length>1&&!changed[0].line_id&&startOffset===0&&endOffset>0)changed[0].line_id=rows[startLine].line_id;
  }
  return [...rows.slice(0,startLine).map(x=>({...x})),...changed,...rows.slice(endLine+1).map(x=>({...x}))];
}
