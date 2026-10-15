export const PARSER_VERSION = 2;
export interface ParsedLine {
  kind: string; marker: string | null; display_text: string;
  record_date: string | null; record_time: string | null; recent_date: string | null;
  todo_state: string | null; due_date: string | null; due_time: string | null;
  event_date: string | null; event_time: string | null;
  parse_status: 'ok' | 'warning'; diagnostics: string[];
}
const datePattern = /(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/;
export function validDate(y: string | number, m: string | number, d: string | number) {
  const [year, month, day] = [Number(y), Number(m), Number(d)];
  const dt = new Date(Date.UTC(year, month-1, day));
  return year >= 1000 && dt.getUTCFullYear() === year && dt.getUTCMonth() === month-1 && dt.getUTCDate() === day;
}
export function isoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return !!m && validDate(m[1],m[2],m[3]);
}
function dateMatch(m: RegExpMatchArray | null) {
  if (!m || !validDate(m[1],m[2],m[3])) return null;
  const date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  const validTime = !m[4] || Number(m[4]) < 24 && Number(m[5]) < 60;
  return { date, time: m[4] && validTime ? `${m[4].padStart(2,'0')}:${m[5]}` : null, validTime };
}
export function splitLines(text: string) { return text.replace(/\r\n?/g,'\n').split('\n'); }
export function parseLine(raw: string): ParsedLine {
  let content = raw.trim().replace(/^[-*]\s+/,'');
  const p: ParsedLine = { kind: 'record', marker: null, display_text: content,
    record_date: null, record_time: null, recent_date: null, todo_state: null,
    due_date: null, due_time: null, event_date: null, event_time: null,
    parse_status: 'ok', diagnostics: [] };
  const found = dateMatch(content.match(datePattern));
  p.record_date = found?.date ?? null; p.record_time = found?.time ?? null;
  const dates = [...raw.matchAll(new RegExp(datePattern.source,'g'))].map(dateMatch)
    .filter((x): x is NonNullable<typeof x> => !!x).map(x=>x.date).sort();
  p.recent_date = dates.at(-1) ?? null;
  if (!content) p.kind = 'blank';
  else if (/^#{1,6}\s/.test(content)) p.kind = 'heading';
  else if (/^-{3,}/.test(raw.trim())) p.kind = 'divider';
  else if (/^\[[xX]\]/.test(content)) { p.kind = 'completed'; p.marker = '[x]'; content = content.slice(3).trim(); }
  else if (/^\[ \]/.test(content)) { p.kind = 'todo'; p.marker = '[ ]'; content = content.slice(3).trim(); }
  else if (content.startsWith('📅')) {
    p.marker = '📅'; content = content.slice(p.marker.length).trim();
    p.kind = 'schedule';
  }
  p.display_text = content;
  if (p.kind === 'todo') {
    p.todo_state = '一般'; let stripped = false, gotState = false;
    while (true) {
      const state = /(?<![0-9A-Za-z㐀-鿿])#(紧急|等待)$/.exec(content);
      if (state) { if (!gotState) { p.todo_state = state[1]; gotState = true; }
        content = content.slice(0,state.index).trimEnd(); stripped = true; continue; }
      const deadline = /(?<![0-9A-Za-z㐀-鿿])#截(?:止)?\s*(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(content);
      if (deadline) {
        const parsed = dateMatch(deadline);
        if (!parsed || !parsed.validTime) { p.diagnostics.push('截止日期或时间无效，标签保留在原文中。'); break; }
        if (!p.due_date) { p.due_date = parsed.date; p.due_time = parsed.time; }
        content = content.slice(0,deadline.index).trimEnd(); stripped = true; continue;
      }
      break;
    }
    p.display_text = stripped ? content.replace(/[：:]+$/,'') : content;
  }
  if (p.kind === 'schedule') {
    const match = content.match(datePattern), parsed = dateMatch(match);
    if (!parsed || !parsed.validTime) p.diagnostics.push('日程日期或时间无效，原文已保存但不会显示为有效日程。');
    else { p.event_date = parsed.date; p.event_time = parsed.time;
      p.display_text = content.replace(datePattern,'').trim(); }
  }
  if (found && !found.validTime && p.kind !== 'schedule') p.diagnostics.push('行内时间无效，保留日期和原文。');
  if (p.diagnostics.length) p.parse_status = 'warning';
  return p;
}
