// APK assets use a separate path under the same HTTPS origin. Cookie and IDB
// ownership remain unchanged, and old root Service Workers cannot mix assets.
export function appLocation(path=''){
  const base=typeof location!=='undefined'&&location.pathname.startsWith('/__app__/')?'/__app__/':'/';
  return base+path.replace(/^\/+/, '');
}
