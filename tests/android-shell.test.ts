import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,posix} from 'node:path';
import {packAndroidShell} from '../tools/pack-android-shell.mjs';
import {appLocation} from '../public/app-location.js';

test('APK packages a complete local dependency graph without replacing private API routes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'case-notes-shell-'));
  try{
    const files=await packAndroidShell({output:root}),available=new Set(files);
    for(const file of files){
      assert.ok(!file.endsWith('.d.ts')&&!file.endsWith('.d.mts')&&!file.startsWith('api/'));
      if(!/\.(html|js|mjs)$/.test(file))continue;
      const content=await readFile(join(root,file),'utf8');
      if(file.endsWith('.html')){
        for(const match of content.matchAll(/\b(?:src|href)=["'](\/[^"']*)["']/g)){
          assert.ok(match[1].startsWith('/__app__/'),`${file}: ${match[1]}`);
          const path=match[1].split(/[?#]/)[0].slice('/__app__/'.length)||'index.html';assert.ok(available.has(path),path);
        }
      }else{
        for(const match of content.matchAll(/\bimport\s+(?:.*?\s+from\s+)?['"](\.[^'"]+)['"]/g)){
          const path=posix.normalize(posix.join(posix.dirname(file),match[1]));assert.ok(available.has(path),`${file}: ${path}`);
        }
      }
    }
    const db=await readFile(join(root,'db-adapter.js'),'utf8');assert.ok(db.includes("request('/api/session'"));assert.ok(db.includes("request('/api/web/save-notes'"));
    assert.deepEqual(JSON.parse(await readFile(join(root,'shell-files.json'),'utf8')),files);
  }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir(),'case-notes-shell-')));await rm(root,{recursive:true});}
});

test('login and logout keep APK documents on their local path and preserve the HTTPS origin',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
  try{
    Object.defineProperty(globalThis,'location',{configurable:true,value:{pathname:'/__app__/index.html'}});
    assert.equal(appLocation(),'/__app__/');assert.equal(appLocation('login.html'),'/__app__/login.html');
    Object.defineProperty(globalThis,'location',{configurable:true,value:{pathname:'/'}});
    assert.equal(appLocation(),'/');assert.equal(appLocation('login.html'),'/login.html');
  }finally{if(previous)Object.defineProperty(globalThis,'location',previous);else delete (globalThis as any).location;}
});
