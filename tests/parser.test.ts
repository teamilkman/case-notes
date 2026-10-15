import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine,splitLines } from '../src/parser';
// The editor is the same module served to browsers, not a mirrored implementation.
const { editLines } = await import('../public/editor.js');

test('split preserves empty lines, leading/trailing whitespace and final newline',()=>{
  assert.deepEqual(splitLines('  备注  \r\n\r\n---\r\n'),['  备注  ','','---','']);
});
test('only lexical tail tags become deadlines/status; raw-like hashes remain text',()=>{
  const p=parseLine('- [ ] 提交材料：#截止2026.10.25 17:00 #等待 #紧急');
  assert.equal(p.todo_state,'紧急');assert.equal(p.due_date,'2026-10-25');assert.equal(p.due_time,'17:00');assert.equal(p.display_text,'提交材料');
  assert.equal(parseLine('- [ ] 关注#紧急').todo_state,'一般');
  assert.equal(parseLine('- [ ] #紧急 中间内容 #未知').todo_state,'一般');
});
test('invalid calendar dates or times stay text with diagnostics, no fake events',()=>{
  for(const text of ['- 📅 2026.02.30 09:00 开庭','- 📅 2026.10.10 25:00 开庭']){
    const p=parseLine(text);assert.equal(p.event_date,null);assert.equal(p.parse_status,'warning');
  }
  assert.equal(parseLine('- 📅 2028.02.29 开庭').event_date,'2028-02-29');
  assert.equal(parseLine('- [ ] 截止 #截止2026.02.30').due_date,null);
});
test('removed markers stay ordinary text without TODO labels or photo semantics',()=>{
  for(const marker of ['⭐','☐','📷'])for(const prefix of ['', '- ', '* ']){
    const text=`${marker} 2026.10.11 09:30 备注 #紧急 #截止2026.10.20`;
    const p=parseLine(prefix+text);
    assert.equal(p.kind,'record');assert.equal(p.marker,null);assert.equal(p.display_text,text);
    assert.equal(p.todo_state,null);assert.equal(p.due_date,null);assert.equal(p.due_time,null);
    assert.equal(p.record_date,'2026-10-11');assert.equal(p.record_time,'09:30');
  }
  assert.equal(parseLine('- [ ] ⭐ 待办 #紧急').todo_state,'紧急');
  assert.equal(parseLine('- 📅 2026.10.20 📷 会议').event_date,'2026-10-20');
});
test('historical dates and completion markers remain compatible',()=>{
  assert.equal(parseLine('- [X] 2026.10.10 已完成：调卷').kind,'completed');
  assert.equal(parseLine('2026.10.10 收到通知，2026.11.03 开庭').recent_date,'2026-11-03');
});
test('textarea deletion of the first duplicate line preserves the second identity',()=>{
  const rows=[{line_id:'first',text:'同文'},{line_id:'second',text:'同文'},{line_id:'third',text:'末尾'}];
  const before=rows.map(r=>r.text).join('\n');
  const result=editLines(rows,before,'同文\n末尾',{start:0,end:3,inputType:'deleteContentBackward'});
  assert.deepEqual(result,[rows[1],rows[2]]);
});
test('textarea line replacement retains ID and a new blank line is independent',()=>{
  const rows=[{line_id:'a',text:'原文'},{line_id:'b',text:'末尾'}];
  const changed=editLines(rows,'原文\n末尾','新文\n末尾',{start:0,end:2,inputType:'insertText'});
  assert.equal(changed[0].line_id,'a');assert.equal(changed[0].text,'新文');
  const inserted=editLines(rows,'原文\n末尾','原文\n\n末尾',{start:3,end:3,inputType:'insertLineBreak'});
  assert.equal(inserted[0].line_id,'a');assert.equal(inserted.at(-1)!.line_id,'b');assert.equal(inserted.length,3);
});

test('IME and autocorrect replacements inside a line tolerate a browser selection mismatch',()=>{
  const rows=[{line_id:'a',text:'同文'},{line_id:'b',text:'ni'},{line_id:'c',text:'同文'}];
  const result=editLines(rows,'同文\nni\n同文','同文\n你\n同文',{start:5,end:5,inputType:'insertCompositionText'});
  assert.deepEqual(result,[rows[0],{line_id:'b',text:'你'},rows[2]]);
  assert.throws(()=>editLines(rows,'同文\nni\n同文','ni\n同文',{start:5,end:5,inputType:'insertCompositionText'}),/无法确认/);
});

test('editing at offset zero preserves leading blank rows and repeated line identities',()=>{
  const rows=[{line_id:'blank',text:''},{line_id:'a',text:'同文'},{line_id:'b',text:'同文'}];
  assert.deepEqual(editLines(rows,'\n同文\n同文','备注\n同文\n同文',{start:0,end:0,inputType:'insertText'}),
    [{line_id:'blank',text:'备注'},rows[1],rows[2]]);
  assert.deepEqual(editLines(rows,'\n同文\n同文','新行\n\n同文\n同文',{start:0,end:0,inputType:'insertText'}),
    [{text:'新行'},...rows]);
  assert.deepEqual(editLines(rows,'\n同文\n同文','同文\n同文',{start:0,end:1,inputType:'deleteContentForward'}),rows.slice(1));
});
