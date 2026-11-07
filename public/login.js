import {appLocation} from './app-location.js';
import {requestPolicy} from './request-policy.js';
  async function login(ev){
    if(ev && ev.preventDefault) ev.preventDefault();  // 关键:async 的 return 恒为 Promise,无法用 return false 阻止原生提交,必须 preventDefault
    const pwd=document.getElementById('pwd').value, btn=document.getElementById('btn'), err=document.getElementById('err'),label=btn.querySelector('.login-submit-label');
    if(btn.disabled)return false;
    err.textContent='';document.getElementById('pwd').removeAttribute('aria-invalid');btn.disabled=true;btn.setAttribute('aria-busy','true');label.textContent='正在进入…';
    // Only transient network failures retry, at most three attempts with backoff.
    for(let t=0;t<3;t++){
      try{
        requestPolicy?.check();
        const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});
        if(r.status===429){requestPolicy?.limit(r);err.textContent=requestPolicy?.error().message||'请求过多，请稍后重试';break;}
        const j=await r.json();
        if(r.ok && j.ok){requestPolicy?.success();location.replace(appLocation()+location.hash);return false;}
        if(r.status>=500)requestPolicy?.failure();
        err.textContent=j.error?.message||'登录失败，请重试';
        if(r.status===401)document.getElementById('pwd').setAttribute('aria-invalid','true');
        btn.disabled=false;btn.removeAttribute('aria-busy');label.textContent='进入工作空间';
        document.getElementById('pwd').focus();document.getElementById('pwd').select();
        return false;
      }catch(e){
        if(e.code==='CLIENT_BACKOFF'){err.textContent=e.message;break;}
        requestPolicy?.failure();
        if(t<2)await new Promise(r=>setTimeout(r,Math.max(requestPolicy?.retryAfter()*1000||0,1000*2**t)+Math.floor(Math.random()*250)));
      }
    }
    if(!err.textContent)err.textContent='网络错误，请稍后重试';
    btn.disabled=false;btn.removeAttribute('aria-busy');label.textContent='进入工作空间';
    document.getElementById('pwd').focus();document.getElementById('pwd').select();
    return false;
  }

document.getElementById("login-form").addEventListener("submit",login);

const passwordField=document.getElementById('pwd'),visibilityButton=document.getElementById('toggle-password');
visibilityButton.addEventListener('click',()=>{const visible=passwordField.type==='password';passwordField.type=visible?'text':'password';visibilityButton.textContent=visible?'隐藏':'显示';visibilityButton.setAttribute('aria-label',visible?'隐藏密码':'显示密码');visibilityButton.setAttribute('aria-pressed',String(visible));});
passwordField.addEventListener('input',()=>{passwordField.removeAttribute('aria-invalid');document.getElementById('err').textContent='';});
