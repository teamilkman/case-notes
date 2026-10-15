import { readFileSync } from 'node:fs';
// Migrations include single-statement trigger bodies. Keep BEGIN ... END as
// one prepared statement so each migration can still run in an atomic batch.
export function migrationSql(path:string):string[] {
  const statements:string[]=[];let trigger='';
  for(const part of readFileSync(path,'utf8').split(';').map(s=>s.trim()).filter(Boolean)){
    if(trigger||/^CREATE TRIGGER\b/i.test(part)){
      trigger+=`${trigger?';\n':''}${part}`;
      if(/\bEND$/i.test(part)){statements.push(trigger);trigger='';}
    }else statements.push(part);
  }
  if(trigger)throw new Error('Incomplete migration trigger');return statements;
}
