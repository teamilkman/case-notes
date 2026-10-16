const CACHE='case-notes-shell-v26-permanent';
// Cache only this public, versioned shell. Private API responses stay in Dexie.
const SHELL=['/','/theme.css','/web/logo.svg','/legacy-app.js','/legacy.css','/page-deck.js','/navigation.js','/db-adapter.js','/storage-upgrade.js','/session-access.js','/app-location.js','/paging.js','/read-cache.js','/persistent-cache.js','/editor.js','/register-sw.js','/web/vendor/dexie.mjs','/web/vendor/vue.global.prod.js','/web/vendor/marked.min.js','/web/vendor/swiper.min.js','/web/vendor/swiper.min.css','/login.html','/login.css','/login.js'];
const OPTIONAL=['/favicon.ico','/manifest.webmanifest','/web/apple-touch-icon.png','/web/icon-192.png','/web/icon-maskable-512.png'];
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll(SHELL.map(path=>new Request(path,{cache:'reload'})));
    await Promise.allSettled(OPTIONAL.map(path=>cache.add(path)));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE&&(key.startsWith('case-notes-shell-')||key.startsWith('ai-log-shell-'))).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/oauth/')||url.pathname.startsWith('/.well-known/')||url.pathname==='/mcp'||url.pathname==='/health')return;
  const path=url.pathname==='/index.html'?'/':url.pathname;
  if(!SHELL.includes(path)&&!OPTIONAL.includes(path))return;
  // Query strings must not prevent offline cold starts or mix shell versions.
  event.respondWith((async()=>{
    const cached=await (await caches.open(CACHE)).match(path);
    return cached||fetch(event.request);
  })());
});
