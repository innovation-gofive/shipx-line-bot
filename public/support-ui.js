'use strict';
const supportLink = new URLSearchParams(location.search);
const supportState = { data:null, busy:false, status:supportLink.has('case')?'all':'pending', query:'', page:1,
  caseId:/^[1-9]\d*$/.test(supportLink.get('case') || '')?Number(supportLink.get('case')):null };
const supportLabels = { open:'รอรับเรื่อง',in_progress:'กำลังตรวจสอบ',resolved:'ตอบแล้ว / ปิดเรื่อง' };
const supportReasons = { unsupported:'ยังไม่เข้าใจคำถาม',upstream_error:'ตรวจข้อมูลจาก ShipX ไม่สำเร็จ',configuration_required:'ต้องตรวจการตั้งค่า',stock_unavailable:'ตรวจยอดสต๊อกไม่ได้',ambiguous:'ยังระบุรายการเดียวไม่ได้',search_limit:'ค้นหาเกินขอบเขต' };
const expiryLabel = value => new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}).format(value);
function tokenWarningText(status) {
  if (!status) return '';
  if (status.warning === 'expiring') return `Token ของ ShipX จะหมดอายุ ${expiryLabel(status.expiresAt)} น. (เวลาไทย) กรุณาเตรียม Token ใหม่`;
  return { expired:'Token ของ ShipX หมดอายุแล้ว กรุณาบันทึก Token ใหม่เพื่อให้บอทตรวจข้อมูลต่อได้',unreadable:'อ่าน Token ของ ShipX ที่บันทึกไว้ไม่ได้ กรุณาตรวจหน้าการเชื่อมต่อ',missing:'ยังไม่ได้ตั้งค่าการเชื่อมต่อ ShipX กรุณาบันทึก Token หรือกำหนด API Key' }[status.warning] || '';
}
function renderAdminAttention() {
  const target=document.getElementById('admin-attention'); if(!target)return;
  const pending=state.data?.stats.supportPending || 0, token=state.settings?.shipxTokenStatus, warning=state.demo&&token?.warning==='missing'?'':tokenWarningText(token);
  const notify=state.settings?.adminAlerts;
  target.innerHTML=`${warning?`<div class="attention-banner ${token.warning==='expired'||token.warning==='unreadable'?'urgent':''}" role="status"><div><strong>🔑 ดูแลการเชื่อมต่อ ShipX</strong><p>${esc(warning)}</p></div><button class="btn" data-attention-nav="settings">อัปเดต Token</button></div>`:''}
    ${pending&&state.page!=='unanswered'?`<div class="attention-banner support-attention" role="status"><div><strong>💬 มี ${pending} คำถามรอทีมดูแล</strong><p>รับเรื่องและติดตามคำถามที่ Shiny ยังตอบไม่ได้</p></div><button class="btn primary" data-attention-nav="unanswered">เปิดคิวคำถาม</button></div>`:''}
    ${notify?.enabled&&!notify.ready?'<div class="attention-banner urgent"><div><strong>แจ้งเตือน LINE ของทีม Admin ยังไม่พร้อม</strong><p>ตรวจว่าบอทยังอยู่ในกลุ่ม และกลุ่มนี้ไม่ได้ผูกบริษัทลูกค้า</p></div><button class="btn" data-attention-nav="settings">ตรวจการตั้งค่า</button></div>':''}`;
  target.querySelectorAll('[data-attention-nav]').forEach(button=>button.addEventListener('click',()=>openAdminPage(button.dataset.attentionNav)));
  const badge=document.getElementById('support-nav-count');if(badge){badge.textContent=pending;badge.hidden=!pending;}
}
function openAdminPage(page) {
  state.page=page;
  if(page==='unanswered')supportState.data=null;
  render();
}
function adminAlertsForm() {
  const value=state.settings?.adminAlerts || {}, groups=state.data.groups.filter(g=>g.bot_present&&!g.company_id);
  return `<section class="panel"><div class="panel-title"><div><h2>แจ้งเตือนทีม Admin ทาง LINE</h2><p>คำถามที่ต้องให้คนช่วยดู และ Token ใกล้หมดอายุ</p></div><span class="tag ${value.ready?'ok':'wait'}">${value.ready?'พร้อมแจ้งเตือน':'ยังไม่เปิดใช้งาน'}</span></div><div class="settings-body">
    <form id="admin-alerts-form"><label class="check-field"><input name="enabled" type="checkbox" ${value.enabled?'checked':''}><span>เปิดแจ้งเตือนไปกลุ่มทีม Admin<small>ส่งคำถาม กลุ่มลูกค้า บริษัท และลิงก์เปิดรับเรื่อง</small></span></label>
    <div class="field"><label for="admin-alert-group">กลุ่ม LINE ของทีม Admin</label><select id="admin-alert-group" name="groupId"><option value="">เลือกกลุ่มทีม Admin</option>${groups.map(g=>`<option value="${esc(g.id)}" ${value.groupId===g.id?'selected':''}>${esc(g.name || g.id)}</option>`).join('')}</select></div>
    <p class="notice">เชิญ Shiny เข้ากลุ่มทีม Admin ก่อน โดยไม่ผูกกลุ่มนี้กับบริษัทลูกค้า เลือกเฉพาะกลุ่มทีมงานที่มีสิทธิ์ดูข้อมูลลูกค้า เปิดใช้งานแล้วระบบจะเริ่มแจ้งเรื่องใหม่และเรื่องที่รอแจ้งเตือนอยู่</p>
    <button type="submit" class="btn primary section-space">บันทึกกลุ่มรับแจ้งเตือน</button><div id="admin-alert-result" role="status"></div></form>
    <p class="hint section-space">Token: เตือนก่อนหมดอายุ 24 ชั่วโมง และเมื่อหมดอายุ • อ่านวันหมดอายุจาก JWT โดยไม่แสดงค่า Token</p></div></section>`;
}
function supportPage() {
  const data=supportState.data;
  return `<section class="support-intro"><div><div class="eyebrow">SHINY / HUMAN SUPPORT</div><h2>ให้ทีมดูแลรับช่วงต่อ</h2><p>ตอบลูกค้าในกลุ่ม LINE เดิม แล้วบันทึกความคืบหน้าที่นี่ การบันทึกหน้านี้ไม่ส่งข้อความเข้ากลุ่มลูกค้า</p></div><span class="support-total">${data?.counts.pending ?? state.data.stats.supportPending ?? 0}<small>คำถามรอดูแล</small></span></section>
    <section class="panel"><div class="panel-title"><div><h2>คำถามที่บอทยังตอบไม่ได้</h2><p>เก็บคำถามจริง พร้อมบริษัท กลุ่ม สาเหตุ และสถานะรับเรื่อง</p></div><button class="btn" id="support-reload">โหลดคิวใหม่</button></div>
    <div class="support-filters">${['pending','open','in_progress','resolved','all'].map(key=>`<button class="btn ${key===supportState.status?'primary':''}" data-support-status="${key}">${({pending:'รอดูแล',all:'ทั้งหมด',...supportLabels})[key]}${data&&['open','in_progress','resolved'].includes(key)?` (${data.counts[key]})`:''}</button>`).join('')}</div>
    <form id="support-search" class="search-row"><input name="query" aria-label="ค้นหาคำถาม กลุ่ม หรือบริษัท" maxlength="120" placeholder="ค้นหาคำถาม กลุ่ม หรือบริษัท" value="${esc(supportState.query)}"><button class="btn" type="submit">ค้นหา</button>${supportState.caseId?'<button class="btn" id="support-clear-case" type="button">ดูเรื่องทั้งหมด</button>':''}</form>
    ${data?`<div class="support-list">${data.rows.length?data.rows.map(supportCaseCard).join(''):'<div class="empty">ไม่มีคำถามในตัวกรองนี้ค่ะ</div>'}</div><div class="panel-footer"><span>${data.total} เรื่อง · หน้า ${data.page} / ${Math.max(1,Math.ceil(data.total/data.pageSize))}</span><div class="support-pager"><button class="btn small" data-support-page="${data.page-1}" ${data.page<=1?'disabled':''}>ก่อนหน้า</button><button class="btn small" data-support-page="${data.page+1}" ${data.page*data.pageSize>=data.total?'disabled':''}>ถัดไป</button></div></div>`:'<div class="empty" role="status">กำลังโหลดคำถาม…</div>'}</section>`;
}
function supportCaseCard(item) {
  const changed=item.mapping_revision!==item.current_revision||item.company_id!==item.current_company_id;
  const alertLabel={pending:'รอแจ้งทีม Admin',sent:'แจ้งทีม Admin แล้ว',failed:'ส่งแจ้งเตือนไม่สำเร็จ',cancelled:'ยกเลิกแจ้งเตือน'}[item.alert_state] || (item.source==='history'?'ประวัติก่อนอัปเดต':'ยังไม่ได้แจ้ง LINE');
  return `<article class="support-case" data-case="${item.id}"><div class="support-case-head"><div><strong>SH-${String(item.id).padStart(6,'0')}</strong><small>${time(item.created_at,true)} น.</small></div><span class="tag ${item.status==='resolved'?'ok':'wait'}">${supportLabels[item.status]}</span></div>
    <div class="support-company">${esc(item.company_name)} <span>· ${esc(item.group_name)}</span></div><div class="mono">${esc(item.group_id)} · ${esc(item.actor || 'ไม่ระบุผู้ใช้')}</div>
    <blockquote class="customer-question">${esc(item.question)}</blockquote><div class="support-reason"><span>${esc(supportReasons[item.reason] || item.reason)}</span><small>${alertLabel}</small></div>
    ${changed?'<p class="notice">ข้อมูลนี้อ้างอิงบริษัทเมื่อรับคำถาม การผูกกลุ่มมีการเปลี่ยนแปลงหรือเป็นประวัติเก่า กรุณาตรวจกลุ่มให้ถูกต้องก่อนตอบ</p>':''}
    ${item.detail?`<details class="support-detail"><summary>ข้อมูลตรวจสอบ</summary><code>${esc(item.detail)}</code></details>`:''}
    <label class="field support-note"><span>บันทึกภายในทีม</span><textarea aria-label="บันทึกเรื่อง SH-${String(item.id).padStart(6,'0')}" data-case-note="${item.id}" maxlength="2000" rows="2" placeholder="เช่น ตรวจสอบข้อมูลแล้ว และตอบลูกค้าใน LINE เรียบร้อย">${esc(item.note)}</textarea></label>
    <div class="support-case-actions">${item.status!=='in_progress'&&item.status!=='resolved'?`<button class="btn" data-case-update="${item.id}" data-status="in_progress">รับเรื่อง</button>`:''}<button class="btn" data-case-update="${item.id}" data-status="${item.status}">บันทึกโน้ต</button>${item.status==='resolved'?`<button class="btn" data-case-update="${item.id}" data-status="open">เปิดเรื่องอีกครั้ง</button>`:`<button class="btn green" data-case-update="${item.id}" data-status="resolved">ตอบแล้ว / ปิดเรื่อง</button>`}</div>
    ${item.updated_by?`<small class="muted">อัปเดตโดย ${esc(item.updated_by)} · ${time(item.updated_at,true)} น.</small>`:''}</article>`;
}
async function loadSupport() {
  if(supportState.busy)return;supportState.busy=true;
  try {
    const query=new URLSearchParams({status:supportState.status,query:supportState.query,page:supportState.page});
    if(supportState.caseId)query.set('caseId',supportState.caseId);
    supportState.data=await api('/api/admin/support?'+query);state.data.stats.supportPending=supportState.data.counts.pending;
    if(state.page==='unanswered')render();else renderAdminAttention();
  } catch(error){toast(error.message);}finally{supportState.busy=false;}
}
function bindSupport() {
  renderAdminAttention();
  if(state.page==='unanswered'&&!supportState.data&&!supportState.busy)loadSupport();
  document.getElementById('support-reload')?.addEventListener('click',loadSupport);
  document.getElementById('support-clear-case')?.addEventListener('click',()=>{supportState.caseId=null;supportState.page=1;loadSupport();});
  document.querySelectorAll('[data-support-status]').forEach(button=>button.addEventListener('click',()=>{supportState.status=button.dataset.supportStatus;supportState.page=1;supportState.caseId=null;loadSupport();}));
  document.querySelectorAll('[data-support-page]').forEach(button=>button.addEventListener('click',()=>{supportState.page=Number(button.dataset.supportPage);loadSupport();}));
  document.getElementById('support-search')?.addEventListener('submit',event=>{event.preventDefault();supportState.query=event.currentTarget.elements.query.value;supportState.page=1;loadSupport();});
  document.querySelectorAll('[data-case-update]').forEach(button=>button.addEventListener('click',async()=>{
    const id=Number(button.dataset.caseUpdate),item=supportState.data.rows.find(row=>row.id===id),note=document.querySelector(`[data-case-note="${id}"]`).value;
    button.disabled=true;
    try{await api('/api/admin/support/'+id,{method:'PUT',body:JSON.stringify({status:button.dataset.status,note,version:item.version})});await loadSupport();toast('บันทึกการรับเรื่องแล้ว');}
    catch(error){toast(error.message);button.disabled=false;}
  }));
  document.getElementById('admin-alerts-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;
    try{const result=await api('/api/admin/admin-alerts',{method:'PUT',body:JSON.stringify({enabled:form.elements.enabled.checked,groupId:form.elements.groupId.value})});state.settings.adminAlerts=result.settings;render();toast('บันทึกกลุ่มทีม Admin แล้ว');}
    catch(error){document.getElementById('admin-alert-result').textContent=error.message;button.disabled=false;}
  });
}
let adminAttentionBusy=false;
async function pollAdminAttention() {
  if(!state.user||!state.data||document.hidden||adminAttentionBusy)return;adminAttentionBusy=true;
  try{const result=await api('/api/admin/attention');state.data.stats.supportPending=result.counts.pending;state.settings.shipxTokenStatus=result.tokenStatus;state.settings.adminAlerts=result.adminAlerts;renderAdminAttention();}
  catch{/* The next poll or refresh can recover without interrupting a note being typed. */}finally{adminAttentionBusy=false;}
}
setInterval(pollAdminAttention,30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollAdminAttention();});
