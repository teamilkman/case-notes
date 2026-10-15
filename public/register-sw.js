
// Start promptly: a short mobile visit must still install the offline shell.
if('serviceWorker' in navigator&&!location.pathname.startsWith('/__app__/')){
  const register=()=>navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});
  register();
  window.addEventListener('online',register);
}
