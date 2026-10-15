import {readFile,writeFile} from 'node:fs/promises';

// Serve the pinned npm dependency from our own origin (including the app shell).
const source=await readFile(new URL('../node_modules/dexie/dist/dexie.mjs',import.meta.url),'utf8');
await writeFile(new URL('../public/web/vendor/dexie.mjs',import.meta.url),source.replace(/^\/\/# sourceMappingURL=.*$/m,''));
for(const [sourceName,targetName] of [['swiper.min.js','swiper.min.js'],['swiper.min.css','swiper.min.css']]){
  const content=await readFile(new URL('../node_modules/swiper/'+sourceName,import.meta.url),'utf8');
  await writeFile(new URL('../public/web/vendor/'+targetName,import.meta.url),content.replace(/^\/\/# sourceMappingURL=.*$/m,''));
}
