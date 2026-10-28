import { z } from 'zod';
import { authenticate, checkOrigin, login, logout } from './auth';
import { schemas, outputSchemas, errorResponseSchema, descriptions, instructions, webNotesSchema } from './schemas';
import { completeTodo, executeTool, resolveCase, saveNotes, toolNames } from './service';
import { changeToken } from './queries';
import { AppError, failure, success, type Env } from './types';
import { webRead } from './web-queries';
import { handleOAuth, oauthChallenge } from './oauth';

function json(data:unknown,status=200,extra:Record<string,string>={}) {
  return Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...extra}});
}
async function body(request:Request) {
  const reader=request.body?.getReader();if(!reader)throw new AppError('INVALID_ARGUMENT','缺少 JSON 请求体。');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
    if(size>1_048_576){await reader.cancel();throw new AppError('INVALID_ARGUMENT','请求体超过 1 MiB。',null,413);}chunks.push(part.value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(all));}catch{throw new AppError('INVALID_ARGUMENT','请求体不是有效 JSON。');}
}
const webTodo=z.object({case_ref:z.string().min(1),line_id:z.string().min(1),expected_line_version:z.number().int().positive(),request_key:z.string().min(8).max(128)}).strict();
function validated(schema:z.ZodType,value:unknown){const result=schema.safeParse(value);if(!result.success)throw new AppError('INVALID_ARGUMENT','参数格式不正确。',result.error.issues);return result.data as any;}
const makeOpenapi=()=>{
  const errorResponse={description:'业务错误，按 error.next_action 处理',content:{'application/json':{schema:z.toJSONSchema(errorResponseSchema,{target:'draft-7',io:'output'})}}};
  return {openapi:'3.1.0',info:{title:'案记 API',version:'0.1.0',description:instructions},
  security:[{bearerAuth:[]}],components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'}}},
  paths:Object.fromEntries(toolNames.map(name=>[`/api/v1/${name}`,{post:{operationId:name,description:descriptions[name],
    requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(schemas[name])}}},
    responses:{'200':{description:'业务结果',content:{'application/json':{schema:z.toJSONSchema(outputSchemas[name],{target:'draft-7',io:'output'})}}},
      '409':{...errorResponse,description:'版本或请求键冲突'},'401':{...errorResponse,description:'需要认证'},default:errorResponse}}}]))};
};
let openapi:ReturnType<typeof makeOpenapi>|undefined;

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
    const url=new URL(request.url),path=url.pathname;
    try {
      const oauth=await handleOAuth(request,env);if(oauth)return oauth;
      if(path==='/health')return json({ok:true,version:'0.1.0'});
      if(path==='/api/openapi.json')return json(openapi??=makeOpenapi());
      if(path==='/api/login'&&request.method==='POST')return json(success({logged_in:true}),200,{'Set-Cookie':await login(request,env,await body(request))});
      if(path==='/api/logout'&&request.method==='POST'){
        const response=json(success({logged_in:false}));for(const cookie of await logout(request,env))response.headers.append('Set-Cookie',cookie);return response;
      }
      if(path.startsWith('/api/')||path==='/mcp') {
        const p=await authenticate(request,env);
        if(p.source==='web'&&request.method!=='GET')checkOrigin(request);
        if(path==='/mcp') {
          if(p.source!=='ai')throw new AppError('PERMISSION_DENIED','MCP 请通过 OAuth 授权或使用独立 AI 接口令牌。',null,403);
          if(request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)throw new AppError('PERMISSION_DENIED','MCP 不接受跨站浏览器调用。',null,403);
          const {handleMcp}=await import('./mcp');
          return handleMcp(request,env,p,ctx);
        }
        if(path==='/api/session'&&request.method==='GET'){
          const response=json(success({workspace:p.workspaceId,source:p.source,
            ...(p.webSession?{cache_scope:p.webSession.cacheScope,expires_at:p.webSession.expiresAt,
              change_token:await changeToken(env,p.workspaceId)}:{})}));
          for(const cookie of p.webSession?.cookieUpgrade??[])response.headers.append('Set-Cookie',cookie);return response;
        }
        if(path.startsWith('/api/v1/')&&request.method==='POST')return json(await executeTool(env,p,path.slice('/api/v1/'.length),await body(request)));
        if(path==='/api/web/complete-todo'&&request.method==='POST')return json(await completeTodo(env,p,validated(webTodo,await body(request))));
        if(path==='/api/web/save-notes'&&request.method==='POST')return json(await saveNotes(env,p,validated(webNotesSchema,await body(request))));
        if(path.startsWith('/api/web/')&&request.method==='POST')return json(await webRead(env,p,path.slice('/api/web/'.length),await body(request)));
        if(path==='/api/web/history'&&request.method==='GET') {
          if(p.source!=='web')throw new AppError('PERMISSION_DENIED','操作历史通过网页查看。',null,403);
          const c=await resolveCase(env,p,url.searchParams.get('case_ref')??'');
          const history=await env.DB.prepare('SELECT action,source,before_json,after_json,created_at,line_id FROM audit_changes WHERE workspace_id=? AND case_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(p.workspaceId,c.id).all();
          return json(success({items:history.results}));
        }
        throw new AppError('INVALID_ARGUMENT','接口或 HTTP 方法不存在。',null,404);
      }
      const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);
      headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');
      // The original Vue full build compiles its existing templates in the browser.
      headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      return new Response(response.body,{status:response.status,headers});
    } catch(error) {
      const result=failure(error),status=error instanceof AppError?error.status:503;
      return json(result,status,status===401?{'WWW-Authenticate':path==='/mcp'?oauthChallenge(request):'Bearer realm="case-notes"'}:{});
    }
  },
} satisfies ExportedHandler<Env>;
