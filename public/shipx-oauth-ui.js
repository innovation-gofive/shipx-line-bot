'use strict';
const oauthMessages={
  invalid_client:'GoFive ไม่ยอมรับ Client ID/Client Secret กรุณาตรวจข้อมูลแอปกับผู้ดูแล',
  unauthorized_client:'Client นี้ยังไม่ได้รับสิทธิ์ใช้วิธีขอ Token ที่เลือก',
  invalid_grant:'ข้อมูลล็อกอินใช้ไม่ได้ หรือบัญชีต้องดำเนินการเพิ่มเติม ระบบหยุดลองซ้ำแล้ว',
  invalid_scope:'Client ยังไม่มีสิทธิ์ Scope ที่ระบุ กรุณาตรวจสิทธิ์ API และ offline_access',
  unsupported_grant_type:'Client หรือเซิร์ฟเวอร์ยังไม่รองรับวิธีขอ Token นี้',
  access_denied:'GoFive ปฏิเสธการเชื่อมต่อ กรุณาตรวจสิทธิ์บัญชีบริการ',
  oauth_storage_unreadable:'อ่านข้อมูลล็อกอินที่เข้ารหัสไว้ไม่ได้ กรุณาตรวจไฟล์คีย์ในพื้นที่เก็บข้อมูลเดิม',
  oauth_discovery_invalid:'ข้อมูลผู้ให้บริการไม่ตรงกับ GoFive ที่กำหนดไว้ จึงยังไม่ส่งข้อมูลล็อกอิน',
  oauth_grant_not_supported:'ผู้ให้บริการยังไม่รองรับ Grant หรือวิธียืนยัน Client ที่เลือก',
  oauth_discovery_connection:'ติดต่อบริการตั้งค่า GoFive ไม่สำเร็จ ระบบจะลองใหม่',
  oauth_token_connection:'ติดต่อบริการ Token ไม่สำเร็จ ระบบจะลองใหม่',
  oauth_token_invalid:'ข้อมูล Token ที่ได้รับยังยืนยันรูปแบบไม่ได้ กรุณาตรวจการเชื่อมต่อ',
};
function oauthMessage(code){return oauthMessages[code] || (code?'ขอ Token ไม่สำเร็จ กรุณาตรวจการตั้งค่า GoFive และ Audit Log':'');}
function oauthStatusContent(status){
  const labels={paused:'พักการเชื่อมต่อ',configured:'รอเชื่อมต่อ',ready:'ต่ออายุอัตโนมัติพร้อมใช้งาน',retry_pending:'กำลังรอลองเชื่อมต่อใหม่',action_required:'รอผู้ดูแลตรวจการตั้งค่า'};
  return `<div class="oauth-status-head"><span class="tag ${status.state==='ready'?'ok':status.state==='action_required'?'bad':'wait'}">${labels[status.state] || 'ยังไม่ได้ตั้งค่า'}</span></div>
    ${status.lastError?`<p class="${status.state==='action_required'?'error':'notice'}">${esc(oauthMessage(status.lastError))}</p>`:''}
    ${status.lastSuccess?`<div class="setting-row"><span>เชื่อมต่อสำเร็จล่าสุด</span><span>${expiryLabel(status.lastSuccess)} น.</span></div>`:''}
    ${status.expiresAt?`<div class="setting-row"><span>Access Token หมดอายุ</span><span>${expiryLabel(status.expiresAt)} น.</span></div>`:''}
    ${status.refreshAt?`<div class="setting-row"><span>เริ่มต่ออายุรอบถัดไป</span><span>${expiryLabel(status.refreshAt)} น.</span></div>`:''}
    ${status.configured?`<div class="setting-row"><span>วิธีต่ออายุ</span><span>${status.grantType==='client_credentials'?'ขอ Token ใหม่ด้วย Client ID / Secret':status.refreshAvailable?'ใช้ Refresh Token':'ล็อกอินบัญชีบริการเพื่อขอ Token ใหม่'}</span></div>`:''}
    ${status.nextAttempt?`<small class="muted">ลองเชื่อมต่ออีกครั้ง ${expiryLabel(status.nextAttempt)} น. (เวลาไทย)</small>`:''}`;
}
function shipxOAuthForm(){
  const value=state.settings?.shipxOAuthStatus || {enabled:false,revision:0,clientId:'',username:'',scope:'ship-x.api',grantType:'client_credentials',authMethod:'client_secret_post',state:'paused'};
  const disabled=state.demo?'disabled':'';
  return `<section class="panel oauth-panel"><div class="panel-title"><div><h2>ต่ออายุ Token ของ ShipX อัตโนมัติ</h2><p>เชื่อม GoFive ครั้งเดียว แล้วให้ Shiny ดูแลการต่ออายุ</p></div>${icon('refresh',22)}</div><div class="settings-body">
    <div id="shipx-oauth-status" aria-live="polite">${oauthStatusContent(value)}</div>
    <form id="shipx-oauth-form" autocomplete="off" data-revision="${value.revision}">
      <label class="check-field"><input type="checkbox" name="enabled" ${value.enabled?'checked':''} ${disabled}><span>เปิดต่ออายุ Token อัตโนมัติ<small>ระบบจะเริ่มเชื่อมต่อหลังบันทึก และขอ Token ใหม่ก่อนหมดอายุ</small></span></label>
      <div class="field"><label for="oauth-grant-type">วิธีขอ Token</label><select id="oauth-grant-type" name="grantType" ${disabled}><option value="client_credentials" ${value.grantType==='client_credentials'?'selected':''}>Client ID / Secret (สำหรับบริการอัตโนมัติ)</option><option value="password" ${value.grantType==='password'?'selected':''}>ชื่อผู้ใช้ / รหัสผ่าน และ Refresh Token</option></select></div>
      <div class="field"><label for="oauth-client-id">Client ID ของแอป GoFive</label><input id="oauth-client-id" name="clientId" maxlength="512" required value="${esc(value.clientId)}" ${disabled}><small class="muted">ใช้ค่าที่ GoFive ลงทะเบียนให้แอปนี้ ซึ่งอาจต่างจากชื่อผู้ใช้ล็อกอิน</small></div>
      <div class="field"><label for="oauth-client-secret">Client Secret</label><input id="oauth-client-secret" name="clientSecret" type="password" maxlength="4000" autocomplete="new-password" placeholder="${value.hasClientSecret?'บันทึกไว้แล้ว เว้นว่างเพื่อใช้ค่าเดิม':'Client Secret ที่ GoFive ออกให้แอป'}" ${disabled}></div>
      ${value.hasClientSecret?`<label class="check-field" id="oauth-clear-secret-field" ${value.grantType==='client_credentials'?'hidden':''}><input type="checkbox" name="clearClientSecret" ${disabled}><span>ล้าง Client Secret ที่บันทึกไว้</span></label>`:''}
      <div id="oauth-password-fields" ${value.grantType==='client_credentials'?'hidden':''}>
      <div class="field"><label for="oauth-username">ชื่อผู้ใช้บัญชีบริการ</label><input id="oauth-username" name="username" maxlength="320" autocomplete="off" value="${esc(value.username)}" ${disabled}></div>
      <div class="field"><label for="oauth-password">รหัสผ่านบัญชีบริการ</label><input id="oauth-password" name="password" type="password" maxlength="2000" autocomplete="new-password" placeholder="${value.hasPassword?'บันทึกไว้แล้ว เว้นว่างเพื่อใช้ค่าเดิม':'รหัสผ่านสำหรับล็อกอิน GoFive'}" ${disabled}></div></div>
      <div class="field"><label for="oauth-scope">Scope ที่แอปได้รับสิทธิ์</label><input id="oauth-scope" name="scope" maxlength="1000" required value="${esc(value.scope)}" ${disabled}></div>
      <div class="field"><label for="oauth-auth-method">วิธียืนยัน Client</label><select id="oauth-auth-method" name="authMethod" ${disabled}><option value="client_secret_post" ${value.authMethod==='client_secret_post'?'selected':''}>ส่ง Client Secret ในฟอร์ม</option><option value="client_secret_basic" ${value.authMethod==='client_secret_basic'?'selected':''}>HTTP Basic</option></select></div>
      <p class="notice">ผู้ให้บริการ: https://login.gofive.co.th<br>Client Secret และ Token เก็บแบบเข้ารหัส ไม่แสดงค่ากลับมา วิธี Client ID / Secret ใช้ขอ Token ใหม่ได้โดยไม่ต้องกรอกชื่อผู้ใช้และรหัสผ่าน</p>
      <div class="oauth-actions"><button class="btn primary" type="submit" ${disabled}>บันทึกการต่ออายุอัตโนมัติ</button><button class="btn green" id="test-shipx-oauth" type="button" ${!value.enabled||state.demo?'disabled':''}>เชื่อมต่อและทดสอบ Token</button>${value.enabled?`<button class="btn" type="button" id="pause-shipx-oauth" ${disabled}>พักโหมดอัตโนมัติ</button>`:''}</div>
      <div id="shipx-oauth-result" role="status"></div>
    </form><small class="muted">ข้อมูลล็อกอินไม่ถูกต้องจะหยุดลองซ้ำและแจ้ง Admin ส่วนปัญหาเครือข่ายจะเว้นช่วงแล้วลองใหม่</small>
    </div></section>`;
}
function renderOAuthStatus(){const target=document.getElementById('shipx-oauth-status');if(target&&state.settings?.shipxOAuthStatus)target.innerHTML=oauthStatusContent(state.settings.shipxOAuthStatus);}
function bindOAuth(){
  const form=document.getElementById('shipx-oauth-form');
  if(form){
    const changeGrant=()=>{
      const password=form.elements.grantType.value==='password',status=state.settings.shipxOAuthStatus;
      document.getElementById('oauth-password-fields').hidden=!password;
      form.elements.username.disabled=!password||state.demo;form.elements.password.disabled=!password||state.demo;
      form.elements.username.required=password;form.elements.password.required=password&&!status?.hasPassword;
      form.elements.clientSecret.required=!password&&!status?.hasClientSecret;
      const clear=document.getElementById('oauth-clear-secret-field');if(clear){clear.hidden=!password;if(!password)form.elements.clearClientSecret.checked=false;}
    };
    changeGrant();
    form.elements.grantType.addEventListener('change',()=>{
      const password=form.elements.grantType.value==='password',scope=form.elements.scope;
      if(password&&scope.value==='ship-x.api')scope.value='openid profile ship-x.api GOFIVE.API offline_access';
      else if(!password&&scope.value==='openid profile ship-x.api GOFIVE.API offline_access')scope.value='ship-x.api';
      changeGrant();
    });
  }
  document.getElementById('shipx-oauth-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,fields=form.elements,button=form.querySelector('[type=submit]');button.disabled=true;
    const body={enabled:fields.enabled.checked,revision:Number(form.dataset.revision),grantType:fields.grantType.value,clientId:fields.clientId.value,username:fields.username.value,
      password:fields.password.value,clientSecret:fields.clientSecret.value,scope:fields.scope.value,authMethod:fields.authMethod.value,clearClientSecret:fields.clearClientSecret?.checked||false};
    try{await api('/api/admin/shipx/oauth',{method:'PUT',body:JSON.stringify(body)});fields.password.value='';fields.clientSecret.value='';await refresh();toast('บันทึกโหมดต่ออายุอัตโนมัติแล้ว');}
    catch(error){document.getElementById('shipx-oauth-result').textContent=error.message;button.disabled=false;}
  });
  document.getElementById('test-shipx-oauth')?.addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{const result=await api('/api/admin/shipx/oauth/test',{method:'POST',body:'{}'});await refresh();toast(result.ok?'เชื่อมต่อ GoFive และรับ Token สำเร็จ':oauthMessage(result.status.lastError));}
    catch(error){toast(error.message);button.disabled=false;}
  });
  document.getElementById('pause-shipx-oauth')?.addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{await api('/api/admin/shipx/oauth/pause',{method:'POST',body:'{}'});await refresh();toast('พักโหมดอัตโนมัติแล้ว ใช้การตั้งค่า Token แบบเดิม');}
    catch(error){toast(error.message);button.disabled=false;}
  });
}
