// Memory owns reactive state and shared requests; optional persistence owns only
// disposable responses. Failed reads can retry, and stale completions cannot prime.
// Offline judgement happens after the cache: a stale replica is displayed with a
// loading state first; a successful network read completes it, while a network or
// offline-auth failure keeps the existing offline copy.
export function createReadCache(wrap=value=>value,maxEntries=128,persistence=null){
  const entries=new Map();
  function trim(protectedKey){while(entries.size>maxEntries){const candidate=[...entries].find(([key,entry])=>key!==protectedKey&&!entry.loading);if(!candidate)break;entries.delete(candidate[0]);}}
  const offlineError=error=>['NETWORK_UNAVAILABLE','OFFLINE_AUTH_REQUIRED'].includes(error?.code);
  const missingCopy=error=>Object.assign(new Error(error?.code==='OFFLINE_AUTH_REQUIRED'?'此内容尚未缓存，请登录后读取。':'网络不可用，此内容尚未缓存，请联网后重试。'),{code:error?.code,retryable:error?.retryable});
  return {
    entry(key){
      if(entries.has(key)){const value=entries.get(key);entries.delete(key);entries.set(key,value);return value;}
      const value=wrap({data:null,loaded:false,loading:false,error:'',pending:null,sequence:0,
        ensure(load){
          if(this.loaded)return Promise.resolve(this.data);
          if(this.pending)return this.pending;
          this.loading=true;this.error='';const sequence=++this.sequence;
          let token,fromPersistence=false;
          const read=persistence?async()=>{
            const stored=await persistence.read(key);token=stored?.token;fromPersistence=!!stored?.hit;
            if(sequence!==this.sequence)throw new DOMException('Aborted','AbortError');
            if(stored?.hit)return stored.data;
            const stale=stored?.stale;
            if(stale!==undefined){
              // Display the old cache first and keep the loading state for the
              // network attempt that judges offline afterwards.
              this.data=stale;this.loaded=true;
              try{return await load();}catch(error){
                if(error?.name==='AbortError'||sequence!==this.sequence)throw error;
                if(!offlineError(error)){
                  if(sequence===this.sequence){this.data=null;this.loaded=false;}
                  throw error;
                }
                const fallback=await persistence.read(key);
                if(sequence!==this.sequence)throw new DOMException('Aborted','AbortError');
                const data=fallback?.hit?fallback.data:(fallback?.stale??stale);
                if(data===undefined){
                  if(sequence===this.sequence){this.data=null;this.loaded=false;}
                  throw missingCopy(error);
                }
                fromPersistence=true;return data;
              }
            }
            try{return await load();}catch(error){
              if(error?.name==='AbortError'||!offlineError(error))throw error;
              const fallback=await persistence.read(key);
              if(sequence!==this.sequence)throw new DOMException('Aborted','AbortError');
              const data=fallback?.hit?fallback.data:fallback?.stale;
              if(data===undefined)throw missingCopy(error);
              fromPersistence=true;return data;
            }
          }:load;
          this.pending=Promise.resolve().then(read).then(async data=>{if(sequence===this.sequence){this.data=data;this.loaded=true;
            if(persistence&&!fromPersistence){
              try{
                const latest=await persistence.read(key);
                if(sequence!==this.sequence)return data;
                if(latest?.token)void persistence.write(key,data,latest.token);
                else if(token)void persistence.write(key,data,token);
              }catch{}
            }
          }return data;})
            .catch(error=>{if(sequence===this.sequence)this.error=error.message;throw error;})
            .finally(()=>{if(sequence===this.sequence){this.loading=false;this.pending=null;trim(key);}});
          return this.pending;
        },
        invalidate(persist=true){this.sequence++;this.loaded=false;this.loading=false;this.error='';this.pending=null;this.data=null;if(persist&&persistence)void persistence.invalidate(key);},
        prime(data){this.invalidate();this.data=data;this.loaded=true;const sequence=this.sequence;
          if(persistence)void persistence.read(key).then(stored=>{if(sequence===this.sequence&&stored?.token)return persistence.write(key,data,stored.token);});
        },
      });
      entries.set(key,value);
      trim(key);
      return value;
    },
    invalidate(persist=true){for(const value of entries.values())value.invalidate(false);if(persist&&persistence)void persistence.invalidate();},
  };
}

// Cancelling one view must not cancel a request shared with another view/prefetch.
export function withSignal(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new DOMException('Aborted','AbortError'));};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
