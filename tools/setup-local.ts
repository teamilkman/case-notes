import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const secrets=resolve(root,'.dev.vars');
if(!existsSync(secrets)) {
  writeFileSync(secrets,`WEB_PASSWORD="${randomBytes(18).toString('base64url')}"\nAPI_TOKEN="${randomBytes(32).toString('base64url')}"\n`);
  process.stdout.write('已生成本地登录密码与 AI 令牌，保存在 Git 忽略的 .dev.vars。\n');
}
for(const database of ['case-notes']) {
  const result=spawnSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'d1','migrations','apply',database,'--local'],{cwd:root,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  if(result.status!==0)process.exit(result.status??1);
}
