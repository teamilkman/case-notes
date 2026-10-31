// Local copies remain usable when the network or cloud authentication is unavailable.
// The stored scope identifies their owner; it never authorizes a server request.
export function createSessionAccess({verify,persistence,state,now=Date.now,onVerified=()=>{},onUnauthorized=()=>{}}){
  let pending=null,expiry=0,localReady=false,closed=false,verified=null;
  return {
    ensure(force=false){
      if(closed)return Promise.reject(new Error('会话已结束，请重新登录。'));
      if(pending)return pending;
      if(!force&&((state.offline&&localReady)||expiry>now()))return Promise.resolve();
      pending=(async()=>{
        try{
          const session=await verify();
          if(closed)throw new Error('会话已结束，请重新登录。');
          if(session.source!=='web'||!session.cache_scope||!(Date.parse(session.expires_at)>now()))throw new Error('请重新登录以启用本地缓存。');
          const activation=await persistence.activate(session);
          if(closed)throw new Error('会话已结束，请重新登录。');
          expiry=Date.parse(session.expires_at);localReady=true;const wasOffline=state.offline;state.offline=false;state.authRequired=false;
          const changed=activation?.changed||(verified&&(verified.scope!==session.cache_scope||verified.change!==(session.change_token??null)));
          verified={scope:session.cache_scope,change:session.change_token??null};
          if(wasOffline||changed)onVerified();
        }catch(error){
          if(closed||(error.code!=='NETWORK_UNAVAILABLE'&&error.status!==401))throw error;
          const session=await persistence.resumeOffline();
          if(closed)throw error;
          if(!session){if(error.status===401)await onUnauthorized();state.offline=true;throw new Error('没有已验证的本地副本，请联网登录并读取需要离线查看的内容。');}
          state.offline=true;state.authRequired=error.status===401;expiry=Date.parse(session.expires_at);localReady=true;
        }
      })().finally(()=>{pending=null;});
      return pending;
    },
    close(){closed=true;expiry=0;localReady=false;},
  };
}
