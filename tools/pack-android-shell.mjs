import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const extensions=new Set(['.html','.js','.mjs','.css','.svg','.png','.ico','.webmanifest']);
export async function packAndroidShell({source=resolve(project,'public'),output=resolve(project,'android/app/build/generated/shellAssets/shell')}={}){
  const files=[];
  async function collect(dir,prefix=''){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.isDirectory())await collect(resolve(dir,entry.name),prefix+entry.name+'/');
      else if(entry.isFile()&&extensions.has(extname(entry.name)))files.push(prefix+entry.name);
    }
  }
  await collect(source);files.sort();const available=new Set(files);
  for(const required of ['index.html','login.html','legacy-app.js','web/vendor/dexie.mjs','web/vendor/swiper.min.js']){
    if(!available.has(required))throw new Error('Missing bundled shell resource: '+required);
  }
  // Only static links change; API routes and all business logic stay shared.
  const localUrl=url=>{
    const [path]=url.split(/[?#]/);const name=path==='/'?'index.html':path.slice(1);
    return available.has(name)?'/__app__/'+url.slice(1):url;
  };
  for(const file of files){
    let content=await readFile(resolve(source,file));
    if(extname(file)==='.html')content=Buffer.from(content.toString().replace(/\b(src|href)=(['"])(\/[^'"]*)\2/g,(_all,key,quote,url)=>key+'='+quote+localUrl(url)+quote));
    const target=resolve(output,file);await mkdir(dirname(target),{recursive:true});await writeFile(target,content);
  }
  // Native interception serves only files in this build, even after an incremental build.
  await writeFile(resolve(output,'shell-files.json'),JSON.stringify(files));
  return files;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  await import('./vendor-dexie.mjs');
  const files=await packAndroidShell();console.log(`Bundled ${files.length} public shell resources for Android.`);
}
