const form=document.querySelector('form');
const toggle=document.getElementById('toggle-password'),password=document.getElementById('password');
toggle?.addEventListener('click',()=>{
  const show=password.type==='password';password.type=show?'text':'password';
  toggle.textContent=show?'隐藏':'显示';toggle.setAttribute('aria-label',show?'隐藏密码':'显示密码');toggle.setAttribute('aria-pressed',String(show));
});
form?.addEventListener('submit',event=>{
  const button=event.submitter;if(!button)return;
  // Preserve the selected decision when controls are disabled for submission.
  const decision=document.createElement('input');decision.type='hidden';decision.name='decision';decision.value=button.value;form.append(decision);
  form.querySelectorAll('button').forEach(control=>{control.disabled=true;});
  button.setAttribute('aria-busy','true');button.textContent=button.value==='deny'?'正在取消…':'正在连接…';
});
window.addEventListener('pageshow',()=>{form?.querySelectorAll('button').forEach(button=>{button.disabled=false;button.removeAttribute('aria-busy');});
  form?.querySelectorAll('input[name="decision"]').forEach(input=>input.remove());
  form?.querySelectorAll('button[type="submit"]').forEach(button=>{button.textContent=button.value==='deny'?'取消':password?'登录并授权':'同意并连接';});
});
