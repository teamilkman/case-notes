import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { schemas, outputSchemas, descriptions, instructions } from './schemas';
import { executeTool, toolNames } from './service';
import { failure, type Env, type Principal } from './types';

export async function handleMcp(request:Request,env:Env,p:Principal,ctx:ExecutionContext) {
  const server=new McpServer({name:'case-notes',version:'0.1.0'},{instructions});
  for(const name of toolNames)server.registerTool(name,{
    title:name,description:descriptions[name],inputSchema:schemas[name],outputSchema:outputSchemas[name],
    annotations:{readOnlyHint:!['cases_create','cases_update','lines_add','lines_update','lines_delete'].includes(name),
      destructiveHint:['cases_update','lines_update','lines_delete'].includes(name),idempotentHint:true,openWorldHint:false},
  },async(args:any)=>{
    let result;
    try{result=await executeTool(env,p,name,args);}catch(error){result=failure(error);}
    return {isError:!result.ok,structuredContent:result,content:[{type:'text' as const,text:JSON.stringify(result)}]};
  });
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:1_048_576});
  await server.connect(transport);
  const response=await transport.handleRequest(request);
  ctx.waitUntil(server.close());
  return response;
}
