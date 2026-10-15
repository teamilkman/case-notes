import { caseJson, lineJson, contains, readQuery } from './queries';
import { AppError, type CaseRow, type Env, type Principal } from './types';

// One paged result stream; case rows never embed an unbounded array of notes.
export async function search(env:Env,p:Principal,a:Record<string,any>,selected?:CaseRow){
  if(a.opened_from&&a.opened_to&&a.opened_from>a.opened_to)
    throw new AppError('INVALID_ARGUMENT','收案起始日期不能晚于结束日期。');
  const hasLineFilters=Boolean(a.case_ref||a.from_date||a.to_date||a.kinds?.length);
  const resultType=a.result_type??(a.query?'all':hasLineFilters?'lines':'cases');
  const scope=a.scope??'all';
  if(!a.cursor&&selected&&!(scope==='all'||scope==='active'&&selected.status==='在办'||scope==='archived'&&selected.status!=='在办'||scope==='affairs'&&selected.kind==='affair'))
    throw new AppError('INVALID_ARGUMENT','指定案件与 scope 条件不相容。');
  const base=['c.workspace_id=?'],baseParams:unknown[]=[p.workspaceId];
  if(selected){base.push('c.id=?');baseParams.push(selected.id);}
  if(scope==='active')base.push("c.status='在办'");
  if(scope==='archived')base.push("c.status<>'在办'");
  if(scope==='affairs')base.push("c.kind='affair'");
  for(const field of ['kind','status'])if(a[field]){base.push(`c.${field}=?`);baseParams.push(a[field]);}
  if(a.opened_from){base.push('c.opened_date>=?');baseParams.push(a.opened_from);}
  if(a.opened_to){base.push('c.opened_date<=?');baseParams.push(a.opened_to);}

  const lineWhere=['l.workspace_id=c.workspace_id','l.deleted_at IS NULL','i.source_line_version=l.version'],lineParams:unknown[]=[];
  if(a.from_date){lineWhere.push('i.record_date>=?');lineParams.push(a.from_date);}
  if(a.to_date){lineWhere.push('i.record_date<=?');lineParams.push(a.to_date);}
  if(a.kinds?.length){lineWhere.push(`i.kind IN (${a.kinds.map(()=>'?').join(',')})`);lineParams.push(...a.kinds);}
  const joins='log_lines l JOIN line_index i ON i.line_id=l.id';
  const exists=(conditions:string[])=>`EXISTS(SELECT 1 FROM ${joins} WHERE l.case_id=c.id AND ${conditions.join(' AND ')})`;
  const order="CASE WHEN c.status='在办' THEN 0 ELSE 1 END AS status_order,c.name AS case_name,c.id AS case_id";
  const branches:string[]=[],counts:string[]=[],params:unknown[]=[];
  const matched=`WITH matched_cases AS MATERIALIZED (SELECT c.* FROM cases c WHERE ${base.join(' AND ')})`;
  if(resultType!=='lines'){
    const where=['1'],values:unknown[]=[];
    if(a.query){
      const metadata=`(${['c.name','c.case_number','c.court','c.cause'].map(contains).join(' OR ')} OR EXISTS(SELECT 1 FROM case_aliases x WHERE x.case_id=c.id AND ${contains('x.alias')}))`;
      where.push(`(${metadata} OR ${exists([...lineWhere,contains('l.raw_text')])})`);
      values.push(...Array(5).fill(a.query),...lineParams,a.query);
    }
    // A record filter must not be bypassed just because case metadata matched.
    if(a.from_date||a.to_date||a.kinds?.length){where.push(exists(lineWhere));values.push(...lineParams);}
    branches.push(`SELECT ${order},0 AS result_order,0 AS line_order,'' AS line_id FROM matched_cases c WHERE ${where.join(' AND ')}`);
    counts.push(`SELECT 1 FROM matched_cases c WHERE ${where.join(' AND ')}`);
    params.push(...values);
  }
  if(resultType!=='cases'){
    const where=[...lineWhere],values=[...lineParams];
    if(a.query){where.push(contains('l.raw_text'));values.push(a.query);}
    branches.push(`SELECT ${order},1 AS result_order,l.sort_order AS line_order,l.id AS line_id FROM matched_cases c JOIN log_lines l ON l.case_id=c.id JOIN line_index i ON i.line_id=l.id WHERE ${where.join(' AND ')}`);
    counts.push(`SELECT 1 FROM matched_cases c JOIN log_lines l ON l.case_id=c.id JOIN line_index i ON i.line_id=l.id WHERE ${where.join(' AND ')}`);
    params.push(...values);
  }
  const keys=['status_order','case_name','case_id','result_order','line_order','line_id'];
  return readQuery(env,p,'search',a,{sql:`${matched} SELECT * FROM (${branches.join(' UNION ALL ')})`,params:[...baseParams,...params],
    decorate:pageSql=>`WITH page AS MATERIALIZED (${pageSql}),case_details AS MATERIALIZED
      (SELECT c.*,${caseJson} AS case_json FROM cases c WHERE c.id IN (SELECT case_id FROM page))
      SELECT CASE WHEN p.result_order=0 THEN json_object('type','case','case',json(c.case_json))
        ELSE json_object('type','line','case',json(c.case_json),'line',json(${lineJson})) END AS row_json,
        ${keys.map(k=>`p.${k}`).join(',')} FROM page p JOIN case_details c ON c.id=p.case_id
        LEFT JOIN log_lines l ON l.id=p.line_id LEFT JOIN line_index i ON i.line_id=l.id ORDER BY ${keys.map(k=>`p.${k}`).join(',')}`,
    countSql:`${matched} SELECT COUNT(*) AS total FROM (${counts.join(' UNION ALL ')})`,countParams:[...baseParams,...params],
    keys,caseId:selected?.id,
    pageSize:a.limit??100,filters:{...a,result_type:resultType,scope}});
}
